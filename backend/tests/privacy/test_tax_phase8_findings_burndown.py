"""ZB-TAX-ARCH-001 Phase 8 findings burn-down.

1. The public reference-rates API names the team ("Zoiko Tax Review"), never a
   person; the privileged source-revision view keeps the reviewer.
2. One banding rule (aggregate_privacy) for every platform surface that shows
   money: fewer than 3 organizations affected -> magnitude bands, counts exact.
   Duplicates, anomaly alerts and remediation carry no platform amounts at all.
"""
import json
import re
from datetime import date
from decimal import Decimal

from app.modules.billing.models import InvoiceStatus
from app.modules.super_admin.models import AttentionItem
from app.modules.tax import aggregate_privacy as ap
from app.modules.tax import registry_router, retro_service
from app.modules.tax.anomaly_service import AnomalyService
from app.modules.tax.registry_schemas import RateLookupResponse
from app.modules.tax.registry_service import PUBLIC_REVIEWER, privileged_source_view, public_source_summary
from app.modules.tax.report_service import TaxFindingsReportService
from tests.conftest import make_customer, make_invoice, make_organization
from tests.test_tax_phase1_registry import _publish, people, registry  # noqa: F401  (fixtures)

MONEY = re.compile(r"\d+\.\d{2}\b|[£$€]|\b(GBP|USD|EUR|AUD|CAD|NZD|INR)\b")


# ── 1. no person in the public reference-rates API ──────────────────────

def test_public_reference_rates_name_the_team_never_a_person(db_session, registry, people):  # noqa: F811
    from app.modules.auth.models import User, UserRole

    org = make_organization(db_session, code="P8BPUB")
    tenant = User(email="t@p8b.example", hashed_password="x", role=UserRole.BILLING_ADMIN, organization_id=org.id,
                  first_name="T", last_name="U")
    db_session.add(tenant)
    _publish(registry, people)
    db_session.flush()
    rates = registry_router.lookup_rates(jurisdiction_id=registry["gb"].id, tax_code=None, as_of=date(2026, 1, 1),
                                         known_at=None, db=db_session, _user=tenant)
    blob = json.dumps(RateLookupResponse.model_validate(rates).model_dump(mode="json"))
    assert PUBLIC_REVIEWER in blob
    for person in (people["maker"], people["checker"]):
        for identifier in (person.email, person.first_name, person.last_name, f"{person.first_name} {person.last_name}"):
            assert identifier not in blob, identifier
    for field in ("reviewer_user_id", "user_id", "email"):
        assert f'"{field}"' not in blob
    source = registry["source"]
    assert public_source_summary(source)["reviewed_by"] == PUBLIC_REVIEWER
    privileged = privileged_source_view(source)                        # the console still knows who reviewed it
    assert privileged["reviewer_user_id"] == source.reviewer.id
    assert privileged["reviewed_by"] == f"{source.reviewer.first_name} {source.reviewer.last_name}"


def test_an_unreviewed_source_claims_no_reviewer(registry):  # noqa: F811
    source = registry["source"]
    source.reviewed_at = None
    assert public_source_summary(source)["reviewed_by"] is None


# ── 2. one banding rule ─────────────────────────────────────────────────

def test_the_shared_banding_rule():
    assert [ap.band(v) for v in ("999.99", "1000", "9999", "10000", "99999", "100000", "-50")] == [
        "< 1k", "1k–10k", "1k–10k", "10k–100k", "10k–100k", "> 100k", "< 1k"]
    assert (ap.small(0), ap.small(2), ap.small(3)) == (True, True, False)
    assert ap.amounts_note(2).startswith("banded") and ap.amounts_note(3) == "exact"
    assert ap.band_rows(2, [{"currency": "GBP", "x": "5", "n": 1}], ("x",)) == [{"currency": "GBP", "x": "< 1k", "n": 1}]
    assert ap.band_rows(3, [{"currency": "GBP", "x": "5"}], ("x",)) == [{"currency": "GBP", "x": "5"}]
    assert ap.band_net("-12") == "< 1k (under)" and ap.band_net("2000") == "1k–10k (over)" and ap.band_net(0) == "< 1k (none)"


def test_retroactive_analysis_uses_the_shared_rule_unchanged():
    assert retro_service.band is ap.band and retro_service.SMALL_POPULATION == ap.SMALL_POPULATION == 3
    aggregates = {"organizations_affected": 2, "per_currency": {"GBP": {"net": "-12", "over": "0", "under": "12",
                                                                        "documents": 1}}}
    banded = retro_service.platform_view(aggregates)
    assert banded["per_currency"]["GBP"] == {"net": "< 1k (under)", "over": "< 1k", "under": "< 1k", "documents": 1}
    assert banded["amounts"] == "banded (fewer than 3 organizations)"
    exact = retro_service.platform_view({**aggregates, "organizations_affected": 3})
    assert exact["per_currency"]["GBP"]["net"] == "-12" and exact["amounts"] == "exact"


def _legacy_invoice(db, n):
    org = make_organization(db, code=f"P8BO{n}", name=f"Banding Org {n}")
    customer = make_customer(db, org.id, code=f"P8BC{n}", email=f"c{n}@p8b.example")
    inv = make_invoice(db, org.id, customer.id, status=InvoiceStatus.SENT, invoice_number=f"P8B-{n}")
    inv.discount_percentage, inv.tax_amount, inv.currency = Decimal("10"), Decimal("20.00"), "GBP"
    db.commit()
    return org


def test_platform_overcollection_is_banded_below_three_organizations(db_session):
    _legacy_invoice(db_session, 1)
    _legacy_invoice(db_session, 2)
    two = TaxFindingsReportService(db_session).platform_overcollection()
    assert two["organizations_affected"] == 2 and two["invoice_count"] == 2                     # counts exact
    gbp = two["totals_by_currency"][0]
    assert gbp["invoice_count"] == 2 and gbp["tax_amount"] == "< 1k" and gbp["estimated_overcollected_tax"] == "< 1k"
    assert two["amounts"] == "banded (fewer than 3 organizations)"
    _legacy_invoice(db_session, 3)
    three = TaxFindingsReportService(db_session).platform_overcollection()
    assert three["amounts"] == "exact"
    assert Decimal(str(three["totals_by_currency"][0]["tax_amount"])) == Decimal("60.00")


def test_tenant_overcollection_report_is_never_banded(db_session):
    org = _legacy_invoice(db_session, 1)
    tenant = TaxFindingsReportService(db_session).tenant_overcollection(org.id)
    assert "amounts" not in tenant
    assert Decimal(str(tenant["totals_by_currency"][0]["tax_amount"])) == Decimal("20.00")


def test_platform_duplicates_are_counts_only(db_session):
    dup = TaxFindingsReportService(db_session).platform_duplicates()
    assert set(dup) == {"organizations_affected", "invoices_affected", "duplicate_rows", "note"}
    assert all(isinstance(dup[k], int) for k in ("organizations_affected", "invoices_affected", "duplicate_rows"))


def test_anomaly_alert_text_carries_no_amounts(db_session, monkeypatch):
    svc = AnomalyService(db_session)
    monkeypatch.setattr(svc, "check_snapshots", lambda since: {"checked": 5, "found": 1, "review_items": 1})
    monkeypatch.setattr(svc, "check_provider_drift", lambda since: {"checked": 5, "found": 1, "review_items": 1})
    monkeypatch.setattr(svc, "check_credits", lambda since: {"checked": 5, "found": 1, "review_items": 1})
    rows = {"current": {"GB": [(Decimal("0"), frozenset({"0"}))] * 6 + [(Decimal("20"), frozenset({"20"}))] * 6},
            "baseline": {"GB": [(Decimal("20"), frozenset({"20"}))] * 40}}
    calls = iter(["current", "baseline"])
    monkeypatch.setattr(svc, "_market_rows", lambda start, end: rows[next(calls)])
    result = svc.run()
    assert len(result["fired"]) == 5                                     # every alert kind fires
    alerts = db_session.query(AttentionItem).filter(AttentionItem.source_key.like("tax:tax.anomaly.%")).all()
    assert len(alerts) == 5
    for alert in alerts:
        assert not MONEY.search(f"{alert.title} {alert.description}"), alert.description


def test_remediation_has_no_platform_surface():
    from app.main import app

    paths = list(app.openapi()["paths"])            # app.routes hides included routers on newer FastAPI
    assert any("remediation" in p for p in paths)   # the tenant surface exists ...
    platform = [p for p in paths if "/super-admin/" in p]
    assert platform and not [p for p in platform if "remediation" in p]   # ... and has no platform twin
