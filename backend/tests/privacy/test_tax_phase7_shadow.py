"""ZB-TAX-ARCH-001 Phase 7 PR 1: shadow compare (handoff §10.1 step 06)."""
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException, ForbiddenException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import BillingAuditLog, InvoiceStatus
from app.modules.tax import shadow_service
from app.modules.tax.enums import EntityTaxRegime
from app.modules.tax.models import TaxRecordFrozenError
from app.modules.tax.policy_service import RulePackService
from app.modules.tax.quote_models import TaxQuote
from app.modules.tax.shadow_models import TaxShadowComparison
from app.modules.tax.shadow_service import (
    ShadowCompareService, ShadowEnrolmentService, ShadowSelectionService, exit_signal,
)
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world, buyer, draft, product

T = "/api/v1/tax/shadow"
P = "/api/v1/super-admin/tax-registry/shadow"
SECRET = "Shadow Secret Holdings"


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P7S")
    w["org"].organization_name = SECRET
    w["entity"].tax_regime = EntityTaxRegime.LEGACY_MANUAL               # shadowing is for legacy entities
    w["admin"] = _tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin@p7s.example")
    w["customer"] = buyer(w, verified=False, code="P7SB")                  # unresolved buyer: consumer treatment
    pack = RulePackService(db_session).register(actor_id=w["reviewer"].id, code="GB-VAT-DOMESTIC-SERVICES")
    db_session.commit()
    w["pack"] = pack                                                     # a DRAFT pack: allowed for shadows
    w["selection"] = ShadowSelectionService(db_session).choose(w["publisher"].id, pack.id, exit_min_invoices=2,
                                                               exit_min_days=1, reason="UK shadow")
    svc = ShadowEnrolmentService(db_session)
    enrolment = svc.propose(w["org"].id, w["admin"].id, w["entity"].id, "rehearse governed tax")
    w["enrolment"] = svc.decide(w["org"].id, w["checker"].id, enrolment.id, approve=True)
    return w


def legacy_invoice(w, *, price="100", rate="20", tax=None, discount_pct="0", number=None, product=None):
    """An issued LEGACY_MANUAL invoice with the tax the old flow charged."""
    inv = draft(w, [(product or w["svc_product"], price, 1, False)], discount_pct=discount_pct, number=number)
    item = inv.items[0]
    item.tax_percentage = Decimal(rate)
    item.tax_amount = Decimal(tax if tax is not None else str(Decimal(price) * Decimal(rate) / 100))
    inv.tax_amount = item.tax_amount
    inv.subtotal = Decimal(price)
    inv.status = InvoiceStatus.SENT
    inv.issue_date = date.today()
    w["db"].commit()
    return inv


def compare(w):
    ShadowCompareService(w["db"]).run()
    return {c.invoice_id: c for c in w["db"].query(TaxShadowComparison)}


# ── enrolment: opt-in, two people, legacy only ─────────────────────────

def test_enrolment_is_two_person_audited_and_for_legacy_entities_only(db_session, w):
    svc = ShadowEnrolmentService(db_session)
    with pytest.raises(BadRequestException, match="already shadowing"):
        svc.propose(w["org"].id, w["admin"].id, w["entity"].id, "again")
    svc.end(w["org"].id, w["admin"].id, w["enrolment"].id)
    again = svc.propose(w["org"].id, w["admin"].id, w["entity"].id, "second period")
    with pytest.raises(ForbiddenException, match="different user"):
        svc.decide(w["org"].id, w["admin"].id, again.id, approve=True)
    events = {a.new_values.get("shadow") for a in db_session.query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "TaxShadowEnrolment")}
    assert {"proposed", "approved", "ended"} <= events
    w["entity"].tax_regime = EntityTaxRegime.GOVERNED
    db_session.commit()
    svc.withdraw(w["org"].id, w["admin"].id, again.id)
    with pytest.raises(BadRequestException, match="LEGACY_MANUAL"):
        svc.propose(w["org"].id, w["admin"].id, w["entity"].id, "governed")


# ── comparisons ─────────────────────────────────────────────────────────

def test_a_matching_invoice_and_nothing_real_changes(db_session, w):
    inv = legacy_invoice(w)
    quotes_before = db_session.query(TaxQuote).count()
    row = compare(w)[inv.id]
    assert row.outcome == "MATCH" and row.shadow_tax == Decimal("20.00") and row.tax_difference == 0
    assert row.pack_code == "GB-VAT-DOMESTIC-SERVICES" and row.rule_pack_version_id == w["pack"].id
    line = row.lines["lines"][0]
    assert line["legacy_rate"] == "20" and Decimal(line["shadow_rate"]) == 20 and line["components"]
    db_session.refresh(inv)
    assert inv.tax_amount == Decimal("20") and inv.tax_quote_id is None and inv.status == InvoiceStatus.SENT
    assert w["entity"].tax_regime == EntityTaxRegime.LEGACY_MANUAL
    assert db_session.query(TaxQuote).count() == quotes_before                      # no quote written


@pytest.mark.parametrize("kwargs,cause", [
    ({"rate": "5"}, "RATE_DIFFERENT"),
    ({"rate": "0", "tax": "0"}, "TAX_MISSING_ON_LEGACY"),
    ({"discount_pct": "10"}, "DISCOUNT_AFTER_TAX"),                                 # legacy taxed before discount
    ({"rate": "20", "tax": "25"}, "UNEXPLAINED"),
])
def test_differences_are_classified_by_cause(db_session, w, kwargs, cause):
    inv = legacy_invoice(w, **kwargs)
    row = compare(w)[inv.id]
    assert row.outcome == "DIFFERENT" and row.cause == cause, (row.cause, row.reason)
    assert row.tax_difference == row.shadow_tax - row.legacy_tax


def test_an_invoice_the_governed_engine_would_have_blocked(db_session, w):
    unclassified = product(w, "NEW1", "SVC")
    from app.modules.tax.models import ProductTaxClassification

    db_session.query(ProductTaxClassification).filter(ProductTaxClassification.product_id == unclassified.id).delete()
    db_session.commit()
    inv = legacy_invoice(w, product=unclassified)
    row = compare(w)[inv.id]
    assert row.outcome == "NOT_DETERMINED" and row.cause and row.reason


def test_a_failure_is_recorded_never_raised_and_the_batch_continues(db_session, w, monkeypatch):
    first, second = legacy_invoice(w, number="INV-A"), legacy_invoice(w, number="INV-B")
    real = shadow_service.compute_comparison

    def flaky(db, enrolment, invoice, selections):
        if invoice.id == first.id:
            raise RuntimeError("boom")
        return real(db, enrolment, invoice, selections)

    monkeypatch.setattr(shadow_service, "compute_comparison", flaky)
    rows = compare(w)
    assert rows[first.id].outcome == "ERROR" and "issuing was not affected" in rows[first.id].reason
    assert rows[second.id].outcome == "MATCH"


def test_idempotent_only_invoices_issued_while_shadowing_and_write_once(db_session, w):
    inv = legacy_invoice(w)
    early = legacy_invoice(w, number="INV-EARLY")
    early.issue_date = date.today() - timedelta(days=10)                        # before shadowing started
    db_session.commit()
    rows = compare(w)
    compare(w)
    assert db_session.query(TaxShadowComparison).filter(TaxShadowComparison.invoice_id == inv.id).count() == 1
    assert early.id not in rows
    row = rows[inv.id]
    row.outcome = "MATCH" if row.outcome != "MATCH" else "DIFFERENT"
    with pytest.raises(TaxRecordFrozenError):
        db_session.flush()
    db_session.rollback()


def test_summary_and_the_advisory_exit_signal(db_session, w):
    w["enrolment"].approved_at = w["enrolment"].approved_at - timedelta(days=2)
    db_session.commit()
    legacy_invoice(w, number="INV-1")
    legacy_invoice(w, number="INV-2", rate="5")
    compare(w)
    signal = exit_signal(db_session, w["enrolment"])
    assert signal["ready"] is True and signal["advisory"] is True and "advice only" in signal["message"]
    assert w["entity"].tax_regime == EntityTaxRegime.LEGACY_MANUAL               # never switched
    legacy_invoice(w, number="INV-3", tax="25")                                  # unexplained
    compare(w)
    assert exit_signal(db_session, w["enrolment"])["ready"] is False
    s = shadow_service.summary(db_session, w["org"].id)
    assert s["compared"] == 3 and s["by_outcome"]["MATCH"] == 1 and s["differences_by_cause"]["UNEXPLAINED"] == 1


# ── platform choice ─────────────────────────────────────────────────────

def test_the_platform_chooses_one_pack_per_code_with_mfa_and_audit(db_session, client_for, w):
    other = ShadowSelectionService(db_session).choose(w["publisher"].id, w["pack"].id, exit_min_invoices=10,
                                                      exit_min_days=14, reason="new threshold")
    db_session.refresh(w["selection"])
    assert w["selection"].active is False and other.active is True
    assert shadow_service.exit_threshold(db_session) == {"min_invoices": 10, "min_days": 14}
    client = client_for(w["publisher"])
    body = {"rule_pack_version_id": w["pack"].id, "exit_min_invoices": 5, "exit_min_days": 7, "reason": "x"}
    assert client.post(f"{P}/selections", json=body).json()["error"] == "TAX_REGISTRY_STEP_UP_REQUIRED"
    assert client_for(w["reviewer"]).post(f"{P}/selections", json=body).status_code == 403   # tax lead only
    with pytest.raises(BadRequestException, match="exit threshold"):
        ShadowSelectionService(db_session).choose(w["publisher"].id, w["pack"].id, exit_min_invoices=0,
                                                  exit_min_days=1, reason="x")


# ── HTTP and T13 ────────────────────────────────────────────────────────

def test_tenant_screens_drill_down_and_csv_platform_aggregate_only(db_session, client_for, w):
    inv = legacy_invoice(w, number="INV-SECRET-77", rate="5")
    compare(w)
    tenant = client_for(w["checker"])
    summary = tenant.get(f"{T}/summary").json()
    assert summary["compared"] == 1 and summary["differences_by_cause"] == {"RATE_DIFFERENT": 1}
    listed = tenant.get(f"{T}/comparisons", params={"cause": "rate_different"}).json()["items"]
    assert listed[0]["invoice_number"] == "INV-SECRET-77" and "lines" not in listed[0]
    detail = tenant.get(f"{T}/comparisons/{listed[0]['id']}").json()
    assert detail["lines"]["lines"][0]["legacy_rate"] == "5"
    csv = client_for(w["admin"]).get(f"{T}/comparisons", params={"format": "csv"})
    assert csv.headers["content-type"].startswith("text/csv") and "INV-SECRET-77" in csv.text
    enrolments = tenant.get(f"{T}/enrolments").json()["items"]
    assert enrolments[0]["state"] == "ACTIVE" and enrolments[0]["exit_signal"]["advisory"] is True

    staff = client_for(make_super_admin(db_session, "tp@p7s.example", PlatformRole.TAX_PUBLISHER))
    assert staff.get(f"{T}/summary").status_code == 403                           # T13
    aggregate = staff.get(f"{P}/aggregate")
    assert aggregate.status_code == 200 and aggregate.json()["compared"] == 1
    assert "INV-SECRET-77" not in aggregate.text and SECRET not in aggregate.text
    assert "organization" not in aggregate.text and str(inv.id) not in aggregate.json().get("by_outcome", {})

    other = make_organization(db_session, code="P7SX", name="Other")
    stranger = client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "a@p7sx.example"))
    assert stranger.get(f"{T}/comparisons/{listed[0]['id']}").status_code == 404
    assert stranger.get(f"{T}/summary").json()["compared"] == 0


def test_enrolment_routes_roles(db_session, client_for, w):
    ShadowEnrolmentService(db_session).end(w["org"].id, w["admin"].id, w["enrolment"].id)
    body = {"seller_entity_id": w["entity"].id, "reason": "again"}
    assert client_for(w["maker"]).post(f"{T}/enrolments", json=body).status_code == 403     # billing admin
    created = client_for(w["admin"]).post(f"{T}/enrolments", json=body)
    assert created.status_code == 201 and created.json()["state"] == "PROPOSED"
    eid = created.json()["id"]
    assert client_for(w["admin"]).post(f"{T}/enrolments/{eid}/approve", json={}).status_code == 403
    approved = client_for(w["checker"]).post(f"{T}/enrolments/{eid}/approve", json={})
    assert approved.status_code == 200 and approved.json()["state"] == "ACTIVE"
