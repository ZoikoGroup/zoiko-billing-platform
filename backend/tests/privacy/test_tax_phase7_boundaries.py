"""ZB-TAX-ARCH-001 Phase 7 PR 2: boundary cases (handoff §10.1 step 06).

A rate change at midnight in the jurisdiction's time zone, tax dates either
side of it, a credit note across the change, and multi-entity documents."""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.models import InvoiceStatus
from app.modules.tax.engines import registered_rule_packs
from app.modules.tax.enums import EntityTaxRegime
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.models import SellerLegalEntity
from app.modules.tax.registry_models import TaxAuthority, TaxComponent, TaxJurisdiction, TaxTypeDefinition
from app.modules.tax.registry_service import legal_date_at
from app.modules.tax.regression.runner import run_case
from tests.test_tax_phase3a_governed import TAX_DATE, build_world, buyer, draft, finalize, quote, registry_rate

GB_CASE = {"id": "B", "pack": "GB-VAT-DOMESTIC-SERVICES", "seller_country": "GB", "buyer_country": "GB",
           "business": True, "currency": "GBP", "transaction_class": "B2B_SERVICES", "lines": [{"net": "100.00"}]}
AU_CASE = {**GB_CASE, "pack": "AU-GST-DOMESTIC-SERVICES", "seller_country": "AU", "buyer_country": "AU",
           "currency": "AUD"}


def _market(db, code, tz, tax_type, component_code):
    j = TaxJurisdiction(code=code, name=code, level="country", country_code=code, timezone=tz)
    t = TaxTypeDefinition(code=tax_type, name=tax_type)
    db.add_all([j, t])
    db.flush()
    a = TaxAuthority(code=f"{code}-AUTH", name="Authority", jurisdiction_id=j.id)
    db.add(a)
    db.flush()
    c = TaxComponent(code=component_code, name=component_code, jurisdiction_id=j.id, tax_type_id=t.id, authority_id=a.id)
    db.add(c)
    db.flush()
    return j, c


@pytest.fixture()
def rate_change(db_session):
    """GB 20% until 30 June 2026, 21% from 1 July 2026 (both in London's calendar); AU 10% to 21%."""
    _, gb = _market(db_session, "GB", "Europe/London", "VAT", "GB-VAT")
    registry_rate(db_session, gb, "20", date(2011, 1, 4), valid_to=date(2026, 7, 1))
    registry_rate(db_session, gb, "21", date(2026, 7, 1))
    _, au = _market(db_session, "AU", "Australia/Sydney", "GST", "AU-GST")
    registry_rate(db_session, au, "10", date(2000, 7, 1), valid_to=date(2026, 7, 1))
    registry_rate(db_session, au, "12", date(2026, 7, 1))
    db_session.commit()


def _tax_at(db, case, instant: datetime, tz: str):
    tax_date = legal_date_at(instant, tz)
    result = run_case(db, {**case, "tax_date": tax_date.isoformat()}, registered_rule_packs()[case["pack"]])
    return tax_date, result["lines"][0]["rate"], result["tax"]


def test_the_change_happens_at_local_midnight_not_utc_midnight(db_session, rate_change):
    # London is on BST (UTC+1) on 30 June: local midnight is 23:00 UTC.
    assert _tax_at(db_session, GB_CASE, datetime(2026, 6, 30, 22, 59, tzinfo=timezone.utc), "Europe/London") \
        == (date(2026, 6, 30), "20", "20.00")
    assert _tax_at(db_session, GB_CASE, datetime(2026, 6, 30, 23, 0, tzinfo=timezone.utc), "Europe/London") \
        == (date(2026, 7, 1), "21", "21.00")
    # Sydney is UTC+10 in July: 14:00 UTC on 30 June is already 1 July there.
    assert _tax_at(db_session, AU_CASE, datetime(2026, 6, 30, 13, 59, tzinfo=timezone.utc), "Australia/Sydney")[1] == "10"
    assert _tax_at(db_session, AU_CASE, datetime(2026, 6, 30, 14, 0, tzinfo=timezone.utc), "Australia/Sydney")[1] == "12"
    # At UTC midnight Sydney is long past the change, London not yet.
    utc_midnight = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)
    assert _tax_at(db_session, AU_CASE, utc_midnight, "Australia/Sydney")[1] == "12"
    assert _tax_at(db_session, GB_CASE, utc_midnight, "Europe/London")[1] == "21"


@pytest.mark.parametrize("tax_date,rate", [(date(2026, 6, 30), "20"), (date(2026, 7, 1), "21"),
                                           (date(2011, 1, 3), None), (date(2011, 1, 4), "20")])
def test_tax_dates_either_side_of_a_change(db_session, rate_change, tax_date, rate):
    result = run_case(db_session, {**GB_CASE, "tax_date": tax_date.isoformat()},
                      registered_rule_packs()["GB-VAT-DOMESTIC-SERVICES"])
    assert result["lines"][0]["rate"] == rate
    if rate is None:                                                            # before any rate: never 0%
        assert result["lines"][0]["outcome"] == "NOT_DETERMINED" and result["tax"] is None


# ── a credit note across the change, and multi-entity documents ──────────

@pytest.fixture()
def w(db_session):
    return build_world(db_session, org_code="P7B")


def test_a_credit_note_after_a_rate_change_reverses_the_original_rate(db_session, w):
    from app.modules.tax.governed_credit_service import GovernedCreditService

    customer = buyer(w, verified=False, code="P7BC")
    inv = draft(w, [(w["svc_product"], "100", 1, False)], customer=customer)
    quote(w, inv)
    finalize(w, inv)
    db_session.refresh(inv)
    assert inv.status == InvoiceStatus.SENT and inv.tax_amount == Decimal("20.00")
    registry_rate(db_session, w["component"], "25", date(2026, 1, 1))           # a new rate in force afterwards
    db_session.commit()
    lines = [{"invoice_item_id": i.id, "fraction": "1"} for i in inv.items]
    preview = GovernedCreditService(db_session).preview(w["org"].id, inv.id, lines=lines)
    assert preview["tax_amount"] == Decimal("20.00")                              # the snapshot, not 25%
    assert preview["lines"][0]["components"][0]["rate_percent"] == Decimal("20")
    note = GovernedCreditService(db_session).create(w["org"].id, w["maker"].id, inv.id, lines=lines)
    assert note.tax_amount == Decimal("20.00")


def test_each_entity_of_a_multi_entity_org_keeps_its_own_regime_and_market(db_session, w):
    second = SellerLegalEntity(organization_id=w["org"].id, entity_code="AU", legal_name="AU arm", country_code="AU",
                               timezone="Australia/Sydney", is_default=False, is_active=True)
    db_session.add(second)
    db_session.commit()
    assert second.tax_regime == EntityTaxRegime.LEGACY_MANUAL
    customer = buyer(w, verified=False, code="P7BM")
    gb_invoice = draft(w, [(w["svc_product"], "100", 1, False)], customer=customer, number="GB-1")
    au_invoice = draft(w, [(w["svc_product"], "100", 1, False)], customer=customer, number="AU-1")
    au_invoice.seller_entity_id = second.id
    db_session.commit()
    assert quote(w, gb_invoice).tax_amount == Decimal("20.00")                  # the governed GB entity
    with pytest.raises(BadRequestException, match="GOVERNED seller entity"):
        quote(w, au_invoice)                                                    # the legacy AU entity: no governed quote
    assert LegalEntityService(db_session).resolve_issuing_entity(w["org"].id, second.id).id == second.id


def test_a_gb_entity_billing_an_overseas_buyer_is_not_determined(db_session, w):
    from app.modules.billing.models import BillingCustomer  # noqa: F401
    from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
    from app.modules.tax.enums import AddressRole
    from tests.conftest import make_customer

    overseas = make_customer(db_session, w["org"].id, code="P7BFR", email="fr@buyer.example")
    BuyerEvidenceService(db_session).record_address(w["org"].id, w["maker"].id, overseas.id, role=AddressRole.BILLING,
                                                    country_code="FR")
    inv = draft(w, [(w["svc_product"], "100", 1, False)], customer=overseas, number="EXPORT-1")
    q = quote(w, inv)
    assert q.status.name in ("NEEDS_EVIDENCE", "UNSUPPORTED") and q.tax_amount is None   # never 0%
    assert inv.tax_date == TAX_DATE
