"""ZB-TAX-ARCH-001 Phase 7 PR 3: live anomaly monitoring (handoff §10.1 step 08)."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.config import settings
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import CreditNoteType, InvoiceStatus
from app.modules.billing.services.credit_note_service import CreditNoteService
from app.modules.super_admin.models import AttentionItem
from app.modules.tax.anomaly_models import TaxAnomalyRun
from app.modules.tax.anomaly_service import AnomalyService
from app.modules.tax.enums import OutboxOperation, ReviewItemKind
from app.modules.tax.models import TaxReviewItem
from app.modules.tax.provider_models import TaxProviderOutbox
from tests.conftest import make_customer, make_invoice
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world, buyer, draft, finalize, quote
from tests.test_tax_phase4a2 import _issued

SECRET_ORG = "Anomaly Secret Holdings"


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P7A")
    w["org"].organization_name = SECRET_ORG
    db_session.commit()
    return w


def issued(w, number, price="100"):
    customer = buyer(w, verified=False, code=f"C{number}")
    inv = draft(w, [(w["svc_product"], price, 1, False)], customer=customer, number=number)
    quote(w, inv)
    finalize(w, inv)
    w["db"].refresh(inv)
    inv.issue_date = date.today()
    w["db"].commit()
    return inv


def items(db, kind):
    return db.query(TaxReviewItem).filter(TaxReviewItem.kind == kind).all()


# ── per invoice ─────────────────────────────────────────────────────────

def test_a_governed_invoice_that_drifted_from_its_snapshot_is_flagged_once_and_not_changed(db_session, w):
    clean = issued(w, "ANOM-OK")
    tampered = issued(w, "ANOM-BAD")
    db_session.execute(text("UPDATE invoices SET tax_amount = 19.99 WHERE id = :id"), {"id": tampered.id})
    db_session.execute(text("UPDATE invoice_items SET tax_amount = 19.99 WHERE invoice_id = :id"), {"id": tampered.id})
    db_session.commit()
    db_session.expire_all()                                     # a real run uses a fresh session
    result = AnomalyService(db_session).run()
    assert result["snapshot"]["checked"] >= 2 and result["snapshot"]["found"] == 1
    found = items(db_session, ReviewItemKind.TAX_SNAPSHOT_MISMATCH)
    assert [i.subject_id for i in found] == [tampered.id] and found[0].organization_id == w["org"].id
    assert "tax_amount 19.99 ≠ snapshot 20.00" in found[0].detail and "line 1 tax" in found[0].detail
    assert found[0].owner_role == "org_admin"
    db_session.refresh(tampered)
    assert tampered.tax_amount == Decimal("19.99")                               # never changed back
    AnomalyService(db_session).run()
    assert len(items(db_session, ReviewItemKind.TAX_SNAPSHOT_MISMATCH)) == 1       # deduplicated while open
    assert clean.id not in [i.subject_id for i in found]


def test_provider_totals_that_differ_from_ours_are_flagged(db_session, w):
    inv, q = _issued(w)
    row = db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.invoice_id == inv.id,
                                                     TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    assert AnomalyService(db_session).run()["provider_drift"]["found"] == 0
    row.remote_snapshot = {**(row.remote_snapshot or {}), "total_tax": str(Decimal(q.tax_amount) + Decimal("1.00"))}
    db_session.commit()
    assert AnomalyService(db_session).run()["provider_drift"]["found"] == 1
    drift = [i for i in items(db_session, ReviewItemKind.PROVIDER_DRIFT) if i.subject_id == row.id]
    assert drift and "Nothing was changed" in drift[0].detail


def test_credit_notes_exceeding_the_original_are_flagged(db_session, w):
    customer = make_customer(db_session, w["org"].id, code="P7ACR", email="cr@buyer.example")
    legacy = make_invoice(db_session, w["org"].id, customer.id, status=InvoiceStatus.SENT, invoice_number="ANOM-CR")
    legacy.total_amount = Decimal("100.00")
    db_session.commit()
    svc = CreditNoteService(db_session)
    for amount in ("60.00", "60.00"):
        svc.create_credit_note(w["org"].id, w["maker"].id, customer_id=customer.id, credit_note_number="auto",
                               credit_note_type=CreditNoteType.PARTIAL_CREDIT, total_amount=Decimal(amount),
                               issue_date=date.today(), subtotal=Decimal(amount), discount_amount=Decimal("0"),
                               tax_amount=Decimal("0"), invoice_id=legacy.id, currency=legacy.currency)
    result = AnomalyService(db_session).run()
    assert result["credits"]["found"] == 1
    found = items(db_session, ReviewItemKind.CREDIT_EXCEEDS_ORIGINAL)
    assert found[0].subject_id == legacy.id and "120.00 against an invoice total of 100.00" in found[0].detail
    assert found[0].owner_role == "finance_approver"


# ── per market (aggregate) ──────────────────────────────────────────────

def test_market_shares_come_from_real_governed_invoices(db_session, w):
    issued(w, "M-1")
    markets = AnomalyService(db_session).check_markets(date.today())
    assert markets["GB"]["invoices"] == 1 and markets["GB"]["rate_mix"] == {"20": 1}
    assert markets["GB"]["zero_tax_share"] == 0.0


def test_zero_tax_and_rate_mix_shifts_fire_with_enough_volume(db_session, monkeypatch):
    svc = AnomalyService(db_session)
    rows = {
        # current window: half the invoices at zero tax and a new 5% rate
        "current": {"GB": [(Decimal("0"), frozenset({"0"}))] * 6 + [(Decimal("20"), frozenset({"20"}))] * 6,
                    "AU": [(Decimal("10"), frozenset({"10"}))] * 3},
        "baseline": {"GB": [(Decimal("20"), frozenset({"20"}))] * 40, "AU": [(Decimal("10"), frozenset({"10"}))] * 40},
    }
    calls = iter(["current", "baseline"])
    monkeypatch.setattr(svc, "_market_rows", lambda start, end: rows[next(calls)])
    markets = svc.check_markets(date.today())
    assert markets["GB"]["zero_tax_alert"] is True and markets["GB"]["zero_tax_share"] == 0.5
    assert markets["GB"]["rate_mix_alert"] is True and markets["GB"]["max_rate_mix_shift"] == 0.5
    assert markets["AU"]["zero_tax_alert"] is False and markets["AU"]["rate_mix_alert"] is False   # 3 < 10 invoices
    calls2 = iter(["current", "baseline"])
    monkeypatch.setattr(settings, "TAX_ANOMALY_ZERO_TAX_SHIFT", 0.6)                       # configurable
    svc2 = AnomalyService(db_session)
    monkeypatch.setattr(svc2, "_market_rows", lambda start, end: rows[next(calls2)])
    assert svc2.check_markets(date.today())["GB"]["zero_tax_alert"] is False


# ── platform alerts and runs ────────────────────────────────────────────

def test_findings_become_aggregate_alerts_and_a_run_record_without_identifiers(db_session, w):
    bad = issued(w, "ANOM-SECRET-1")
    db_session.execute(text("UPDATE invoices SET tax_amount = 1.00 WHERE id = :id"), {"id": bad.id})
    db_session.commit()
    db_session.expire_all()
    result = AnomalyService(db_session).run()
    assert "tax.anomaly.snapshot" in result["fired"]
    alert = db_session.query(AttentionItem).filter(AttentionItem.source_key == "tax:tax.anomaly.snapshot").one()
    text_ = f"{alert.title} {alert.description}"
    assert "ANOM-SECRET-1" not in text_ and SECRET_ORG not in text_ and alert.organization_id is None
    run = db_session.query(TaxAnomalyRun).order_by(TaxAnomalyRun.id.desc()).first()
    assert run.counts["snapshot"]["found"] == 1 and "GB" in run.markets
    assert "ANOM-SECRET-1" not in str(run.counts) + str(run.markets) and SECRET_ORG not in str(run.markets)
    from app.modules.tax.models import TaxReviewItem as Item

    db_session.query(Item).filter(Item.kind == ReviewItemKind.TAX_SNAPSHOT_MISMATCH).delete()
    db_session.execute(text("UPDATE invoices SET tax_amount = 20.00 WHERE id = :id"), {"id": bad.id})
    db_session.commit()
    db_session.expire_all()
    assert "tax.anomaly.snapshot" in AnomalyService(db_session).run()["cleared"]


def test_the_runs_endpoint_is_aggregate_and_platform_only(db_session, client_for, w):
    issued(w, "ANOM-EP-1")
    AnomalyService(db_session).run()
    staff = client_for(make_super_admin(db_session, "tr@p7a.example", PlatformRole.TAX_REVIEWER))
    body = staff.get("/api/v1/super-admin/tax-registry/anomalies")
    assert body.status_code == 200 and body.json()["items"] and "thresholds" in body.json()
    assert "ANOM-EP-1" not in body.text and SECRET_ORG not in body.text
    tenant = client_for(_tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin@p7a.example"))
    assert tenant.get("/api/v1/super-admin/tax-registry/anomalies").status_code == 403
    review = tenant.get("/api/v1/tax/review-items").json()
    assert isinstance(review["items"], list)                                     # tenant findings live here


def test_the_job_is_scheduled_daily_and_can_be_switched_off(monkeypatch):
    from app.core.scheduler import get_job_definitions
    from app.modules.tax.anomaly_service import run_tax_anomaly_job

    jobs = {d[2]: d for d in get_job_definitions()}
    assert jobs["tax_anomaly_job"][0] == "app.modules.tax.anomaly_service:run_tax_anomaly_job"
    assert jobs["tax_anomaly_job"][1] == 1440
    monkeypatch.setattr(settings, "TAX_ANOMALY_ENABLED", False)
    assert run_tax_anomaly_job() == {"skipped": "TAX_ANOMALY_ENABLED is off"}
