"""
tests/test_tax_phase4c_us.py
----------------------------
ZB-TAX-ARCH-001 Phase 4c: US sales tax through a provider, with resolved
addresses (T07) and exemption certificates (T14). **Plumbing only**.

The districts, rates and resolutions are fake-resolver and fake-provider
fixtures that exercise routing, district coverage, blocking and evidence.
They are not legal answers. T07 and T14 count as passed for the gate only in
4d, against a provider sandbox and a procured resolver with golden expected
values from the tax lead.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import BillingAuditLog, InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.tax.address_resolver import ADDRESS_RESOLVERS, ResolutionPrecision, resolve_address
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from app.modules.tax.connection_service import ProviderConnectionService
from app.modules.tax.determination_service import TaxDeterminationService
from app.modules.tax.engines import ComponentResult
from app.modules.tax.enums import (
    AddressRole,
    EntityTaxRegime,
    JurisdictionLevel,
    ProviderEnvironment,
    ReviewItemKind,
    SupplyCategory,
    TaxOperatingMode,
    TaxOutcome,
    TaxQuoteStatus,
    TransactionClass,
)
from app.modules.tax.issuance_gate import GovernedIssuanceGate
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.models import TaxAddressResolution, TaxRecordFrozenError, TaxReviewItem
from app.modules.tax.policy_service import MarketAvailabilityService, TaxCodeSetService
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_issuance import beat_for_tests, customer_pseudonym
from app.modules.tax.registry_models import TaxAuthority, TaxComponent, TaxJurisdiction, TaxTypeDefinition
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_customer, make_organization
from tests.fixtures.tax_fake_provider import register_fake_provider
from tests.fixtures.tax_fake_resolver import register_fake_resolver
from tests.test_tax_phase3a_governed import GATES, TAX_DATE, _user, draft, product

SERVICES = (TransactionClass.B2B_SERVICES, TransactionClass.B2C_SERVICES)
STATE, COUNTY, D1, D2 = "US-CA", "US-CA-LA", "US-CA-LA-D1", "US-CA-LA-D2"
#: Plumbing rates: fake-provider fixtures, NOT legal values.
STATE_RATE = Decimal("6")
DISTRICT_RATES = {D1: Decimal("1"), D2: Decimal("2.25")}
ZIP = "90012"
PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


def _district_rules(world):
    """The fake's plumbing behaviour: a district component on top of the
    state's, chosen from the buyer's resolved districts."""
    def hook(request, result):
        billing = ((request.facts.get("buyer") or {}).get("addresses") or {}).get("BILLING") or {}
        codes = ((billing.get("resolution") or {}).get("jurisdiction_codes")) or []
        for code in codes:
            if code in DISTRICT_RATES:
                result.components.append(ComponentResult(
                    component_code=f"FAKE:{code}", rate_percent=DISTRICT_RATES[code], rate_source="PROVIDER",
                    jurisdiction_id=world["jurisdictions"][code].id, tax_type_id=world["extra_type"].id
                    if world.get("wrong_type") else world["tax_types"]["SALES"].id))
        return world["after"](request, result) if world.get("after") else result
    return hook


def build_us(db, code="P4CUS"):
    org = make_organization(db, code=code, name="Phase 4c US Org")
    w = {"db": db, "org": org,
         "maker": _user(db, f"maker@{code.lower()}.example", UserRole.BILLING_ADMIN, org.id),
         "checker": _user(db, f"checker@{code.lower()}.example", UserRole.FINANCE_APPROVER, org.id),
         "reviewer": _user(db, f"rev@{code.lower()}.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_REVIEWER),
         "publisher": _user(db, f"pub@{code.lower()}.example", UserRole.SUPER_ADMIN,
                            platform_role=PlatformRole.TAX_PUBLISHER)}
    entity = LegalEntityService(db).ensure_default_entity(org.id)
    entity.country_code, entity.subdivision_code = "US", "CA"
    entity.tax_regime = EntityTaxRegime.GOVERNED
    w["entity"] = entity

    us = TaxJurisdiction(code="US", name="United States", level=JurisdictionLevel.COUNTRY, country_code="US")
    db.add(us)
    db.flush()
    state = TaxJurisdiction(code=STATE, name="California", level=JurisdictionLevel.STATE_PROVINCE, country_code="US",
                            subdivision_code="CA", parent_id=us.id)
    db.add(state)
    db.flush()
    county = TaxJurisdiction(code=COUNTY, name="Los Angeles County (fixture)", level=JurisdictionLevel.COUNTY,
                             country_code="US", subdivision_code="CA", parent_id=state.id)
    db.add(county)
    db.flush()
    jurisdictions = {"US": us, STATE: state, COUNTY: county}
    for d in (D1, D2):
        j = TaxJurisdiction(code=d, name=f"District {d[-2:]} (fixture)", level=JurisdictionLevel.DISTRICT,
                            country_code="US", subdivision_code="CA", parent_id=county.id)
        db.add(j)
        jurisdictions[d] = j
    tax_types = {"SALES": TaxTypeDefinition(code="SALES", name="Sales tax")}
    w["extra_type"] = TaxTypeDefinition(code="EXCISE-FX", name="Excise (fixture)")
    db.add_all([*tax_types.values(), w["extra_type"]])
    db.flush()
    authority = TaxAuthority(code="US-CA-CDTFA-FX", name="Fixture CDTFA", jurisdiction_id=state.id)
    db.add(authority)
    db.flush()
    db.add(TaxComponent(code="US-CA-SALES-FX", name="California sales (fixture)", jurisdiction_id=state.id,
                        tax_type_id=tax_types["SALES"].id, authority_id=authority.id))
    db.flush()
    w["jurisdictions"], w["tax_types"] = jurisdictions, tax_types

    avail = MarketAvailabilityService(db)
    for cls in SERVICES:
        row = avail.draft(actor_id=w["reviewer"].id, jurisdiction_id=state.id, tax_type_id=tax_types["SALES"].id,
                          transaction_class=cls, mode=TaxOperatingMode.PROVIDER_APPROVED, gates=GATES)
        avail.validate(actor_id=w["reviewer"].id, version_id=row.id)
        avail.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="fixture")
        avail.approve(actor_id=w["publisher"].id, version_id=row.id)
        avail.publish(actor_id=w["publisher"].id, version_id=row.id)
    codes = TaxCodeSetService(db)
    cs = codes.draft(actor_id=w["reviewer"].id)
    codes.upsert_code(actor_id=w["reviewer"].id, version_id=cs.id, code="SVC", name="Services",
                      supply_category=SupplyCategory.SERVICES)
    codes.validate(actor_id=w["reviewer"].id, version_id=cs.id)
    codes.submit(actor_id=w["reviewer"].id, version_id=cs.id, reason="fixture")
    codes.approve(actor_id=w["publisher"].id, version_id=cs.id)
    codes.publish(actor_id=w["publisher"].id, version_id=cs.id)
    db.commit()

    fake = register_fake_provider()
    fake.rates = {(STATE, "SALES"): STATE_RATE}
    fake.unresolved_buyer_as_consumer = True
    fake.result_hook = _district_rules(w)
    w["provider"] = fake
    connections = ProviderConnectionService(db)
    conn = connections.propose(org.id, w["maker"].id, seller_entity_id=entity.id, provider_name="fake-provider",
                               environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.COMMIT)
    connections.set_credentials(org.id, w["maker"].id, conn.id, "us-sandbox-credential-4242")
    connections.decide(org.id, w["checker"].id, conn.id, approve=True)
    w["connection"] = conn

    tenant = TenantTaxService(db)
    reg = tenant.create_registration(org.id, w["maker"].id, seller_entity_id=entity.id, jurisdiction_id=state.id,
                                     tax_type_id=tax_types["SALES"].id, registration_number="SR-FX-1234",
                                     valid_from=date(2020, 1, 1))
    for cls in SERVICES:
        act = tenant.propose_activation(org.id, w["maker"].id, seller_entity_id=entity.id, jurisdiction_id=state.id,
                                        tax_type_id=tax_types["SALES"].id, transaction_class=cls,
                                        mode=TaxOperatingMode.PROVIDER_APPROVED, effective_from=date(2025, 1, 1),
                                        registration_id=reg.id, provider_connection_id=conn.id)
        tenant.decide_activation(org.id, w["checker"].id, act.id, approve=True)
    w["svc"] = product(w, "SVC-US", "SVC")
    resolver = register_fake_resolver()
    resolver.add("100 First St", ("US", STATE, COUNTY, D1))
    resolver.add("900 Ninth St", ("US", STATE, COUNTY, D2))
    resolver.add("5 Split Rd", ("US", STATE, COUNTY, D1), candidates=2)
    resolver.add("7 Centroid Ave", ("US", STATE, COUNTY, D2), precision=ResolutionPrecision.ZIP_CENTROID)
    w["resolver"] = resolver
    beat_for_tests(db)
    db.commit()
    return w


def buyer(w, line1, resolve=True):
    db = w["db"]
    c = make_customer(db, w["org"].id, code=f"US-{len(w.setdefault('buyers', []))}",
                      email=f"b{len(w['buyers'])}@us.example")
    w["buyers"].append(c)
    a = BuyerEvidenceService(db).record_address(w["org"].id, w["maker"].id, c.id, role=AddressRole.BILLING,
                                                country_code="US", subdivision_code="CA", postal_code=ZIP,
                                                city="Los Angeles", line1=line1)
    if resolve and line1:
        resolve_address(db, w["org"].id, w["maker"].id, a.id)
    return c, a


@pytest.fixture()
def w(db_session):
    world = build_us(db_session)
    yield world
    ADDRESS_RESOLVERS.clear()


def quote_for(w, customer, price=100):
    inv = draft(w, [(w["svc"], price, 1, False)], customer=customer, currency="USD")
    return inv, TaxDeterminationService(w["db"]).create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)


def certificate(w, customer, *, expires_at=None, evidence=True, tax_type=True):
    svc = BuyerEvidenceService(w["db"])
    cert = svc.add_certificate(w["org"].id, w["maker"].id, customer.id, certificate_number="RESALE-FX-1",
                               jurisdiction_id=w["jurisdictions"][STATE].id, scope_description="Resale",
                               valid_from=date(2025, 1, 1), evidence_ref="cabinet 3",
                               tax_type_id=w["tax_types"]["SALES"].id if tax_type else None,
                               expires_at=expires_at, reason_code="RESALE")
    if evidence:
        svc.attach_certificate_evidence(w["org"].id, w["maker"].id, cert.id, content=PDF + str(cert.id).encode(),
                                        media_type="application/pdf")
    return cert


def exempt(request, result):
    result.components = []
    result.provider_line_tax = Decimal("0")
    result.reason_code = "EXEMPT"
    return result


# ── T07 (plumbing): the street address decides the district ─────────────

def test_t07_plumbing_same_zip_different_district_is_different_tax(w):
    c1, _ = buyer(w, "100 First St")
    c2, _ = buyer(w, "900 Ninth St")
    _, q1 = quote_for(w, c1)
    _, q2 = quote_for(w, c2)
    assert q1.status == TaxQuoteStatus.QUOTED, (q1.refusal_code, q1.refusal_reason, q1.issues)
    assert q2.status == TaxQuoteStatus.QUOTED, (q2.refusal_code, q2.refusal_reason)
    assert q1.supply_address["postal_code"] == q2.supply_address["postal_code"] == ZIP
    assert q1.tax_amount == Decimal("7.00") and q2.tax_amount == Decimal("8.25")
    districts = {c.jurisdiction_id for line in q1.lines for c in line.components}
    assert w["jurisdictions"][D1].id in districts and w["jurisdictions"][D2].id not in districts


def test_t07_zip_alone_never_resolves(w):
    c, a = buyer(w, None, resolve=False)
    with pytest.raises(BadRequestException, match="street line"):
        resolve_address(w["db"], w["org"].id, w["maker"].id, a.id)
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.tax_amount is None
    assert any(i["code"] == "BUYER_STREET_ADDRESS_MISSING" for i in q.issues)


def test_t07_unresolved_address_blocks(w):
    c, _ = buyer(w, "100 First St", resolve=False)
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.tax_amount is None
    assert any(i["code"] == "ADDRESS_NOT_RESOLVED" for i in q.issues)


@pytest.mark.parametrize("line1", ["5 Split Rd", "7 Centroid Ave", "1 Nowhere Ln"])
def test_t07_ambiguous_or_imprecise_or_unknown_address_blocks(w, line1):
    c, _ = buyer(w, line1)
    resolution = w["db"].query(TaxAddressResolution).order_by(TaxAddressResolution.id.desc()).first()
    assert resolution.status in ("AMBIGUOUS", "NOT_FOUND") and resolution.jurisdiction_codes == []
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.tax_amount is None
    assert any(i["code"] == "ADDRESS_AMBIGUOUS" for i in q.issues)


def test_t07_resolution_is_recorded_audited_and_write_once(w):
    c, a = buyer(w, "100 First St")
    r = w["db"].query(TaxAddressResolution).filter(TaxAddressResolution.address_id == a.id).one()
    assert (r.status, r.precision, r.resolver_name, r.source) == ("RESOLVED", "ROOFTOP", "fake-resolver", "fake-2026.11")
    assert r.jurisdiction_codes == ["US", STATE, COUNTY, D1] and r.resolved_by == w["maker"].id
    assert w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxAddressResolution",
                                                 BillingAuditLog.entity_id == r.id).count() == 1
    r.jurisdiction_codes = ["US", STATE, COUNTY, D2]
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()
    w["db"].rollback()


def test_t07_a_changed_address_needs_a_new_resolution(w):
    c, _ = buyer(w, "100 First St")
    BuyerEvidenceService(w["db"]).record_address(w["org"].id, w["maker"].id, c.id, role=AddressRole.BILLING,
                                                 country_code="US", subdivision_code="CA", postal_code=ZIP,
                                                 city="Los Angeles", line1="900 Ninth St")
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE
    assert any(i["code"] == "ADDRESS_NOT_RESOLVED" for i in q.issues)


def test_resolved_district_missing_from_registry_blocks(w):
    w["resolver"].add("3 Unknown Way", ("US", STATE, COUNTY, "US-CA-LA-D9"))
    c, _ = buyer(w, "3 Unknown Way")
    _, q = quote_for(w, c)
    assert q.status != TaxQuoteStatus.QUOTED and q.tax_amount is None
    assert any(i["code"] == "JURISDICTION_NOT_IN_REGISTRY" for i in q.issues)


def test_state_registration_covers_its_districts_but_not_another_tax_type(w):
    c, _ = buyer(w, "100 First St")
    w["wrong_type"] = True
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.REVIEW_REQUIRED and q.refusal_code == "PROVIDER_CONTRADICTS_CONTEXT"
    assert "no recorded registration" in q.refusal_reason


# ── T14 (plumbing): certificates are evidence, never an automatic 0% ────

def test_t14_valid_certificate_with_evidence_is_claimed_and_exempt(w, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "test-pseudonym-key", raising=False)
    c, _ = buyer(w, "100 First St")
    cert = certificate(w, c)
    w["after"] = exempt
    inv, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    assert q.tax_amount == Decimal("0.00") and q.lines[0].outcome == TaxOutcome.EXEMPT
    assert q.exemption_claims == [{"certificate_id": cert.id, "jurisdiction_id": w["jurisdictions"][STATE].id,
                                   "tax_type_id": w["tax_types"]["SALES"].id, "reason_code": "RESALE"}]
    svc = InvoiceService(w["db"])
    svc.governed_gate = GovernedIssuanceGate(w["db"])
    assert svc.finalize_invoice(inv.id, w["org"].id, w["maker"].id).status == InvoiceStatus.SENT
    payload_buyer = w["provider"].payloads[0]["buyer"]
    assert payload_buyer["exemptions"] == [{"jurisdiction_code": STATE, "tax_type": "SALES", "reason_code": "RESALE"}]
    assert payload_buyer["customer_ref"] == customer_pseudonym(w["org"].id, c.id)
    assert payload_buyer["customer_ref"].startswith("zc_") and "RESALE-FX-1" not in str(payload_buyer)
    assert c.email not in str(payload_buyer)
    assert set(payload_buyer) == {"address", "customer_ref", "exemptions"}


def test_t14_expired_certificate_blocks_and_raises_a_review_item(w):
    c, _ = buyer(w, "100 First St")
    cert = certificate(w, c, expires_at=date(2026, 5, 1))
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.refusal_code == "EXEMPTION_CERTIFICATE_INVALID"
    assert q.tax_amount is None and "expired" in q.refusal_reason
    item = w["db"].query(TaxReviewItem).filter(TaxReviewItem.subject_type == "CustomerExemptionCertificate",
                                               TaxReviewItem.subject_id == cert.id).one()
    assert item.kind == ReviewItemKind.CERTIFICATE_EXPIRED and item.organization_id == w["org"].id


def test_t14_certificate_without_evidence_is_not_claimed(w):
    c, _ = buyer(w, "100 First St")
    certificate(w, c, evidence=False)
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and "no evidence document" in q.refusal_reason


def test_t14_provider_exemption_without_a_certificate_is_review_required(w):
    c, _ = buyer(w, "100 First St")
    w["after"] = exempt
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.REVIEW_REQUIRED and "no valid exemption certificate" in q.refusal_reason
    assert q.tax_amount is None


def test_t14_a_certificate_for_another_state_is_ignored(w):
    other = TaxJurisdiction(code="US-NV", name="Nevada", level=JurisdictionLevel.STATE_PROVINCE, country_code="US",
                            subdivision_code="NV", parent_id=w["jurisdictions"]["US"].id)
    w["db"].add(other)
    w["db"].commit()
    c, _ = buyer(w, "100 First St")
    BuyerEvidenceService(w["db"]).add_certificate(w["org"].id, w["maker"].id, c.id, certificate_number="NV-1",
                                                  jurisdiction_id=other.id, scope_description="Resale",
                                                  valid_from=date(2025, 1, 1), evidence_ref="x",
                                                  expires_at=date(2026, 1, 1))
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.QUOTED and q.exemption_claims is None and q.tax_amount == Decimal("7.00")


def test_customer_pseudonym_is_stable_keyed_and_absent_without_a_key(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "", raising=False)
    assert customer_pseudonym(1, 2) is None
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "k1", raising=False)
    a = customer_pseudonym(1, 2)
    assert a == customer_pseudonym(1, 2) and a != customer_pseudonym(1, 3) and a != customer_pseudonym(2, 2)
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "k2", raising=False)
    assert customer_pseudonym(1, 2) != a
