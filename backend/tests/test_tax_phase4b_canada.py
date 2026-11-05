"""
tests/test_tax_phase4b_canada.py
--------------------------------
ZB-TAX-ARCH-001 Phase 4b: Canada through a specialist provider. T06 here is
**plumbing only**.

The rates and the "HST replaces GST" behaviour are fake-provider fixtures
that exercise routing, components, place of supply, nexus and blocking. They
are not legal answers. T06 counts as passed for the gate only in 4d, run
against a provider sandbox with golden expected values from the tax lead.

There is no native Canada pack: Canadian tax is decided by the provider, and
everything around it is ours (activations, registrations, connection,
contradiction checks, fail-closed).
"""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from app.modules.tax.connection_service import ProviderConnectionService
from app.modules.tax.determination_service import TaxDeterminationService
from app.modules.tax.engines import registered_rule_packs
from app.modules.tax.enums import (
    AddressRole,
    EntityTaxRegime,
    JurisdictionLevel,
    OutboxOperation,
    ProviderEnvironment,
    SupplyCategory,
    TaxOperatingMode,
    TaxQuoteStatus,
    TransactionClass,
)
from app.modules.tax.issuance_gate import GovernedIssuanceGate
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.policy_service import MarketAvailabilityService, TaxCodeSetService
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_issuance import beat_for_tests
from app.modules.tax.provider_models import TaxProviderOutbox
from app.modules.tax.registry_models import TaxAuthority, TaxComponent, TaxJurisdiction, TaxTypeDefinition
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_customer, make_organization
from tests.fixtures.tax_fake_provider import register_fake_provider
from tests.test_tax_phase3a_governed import GATES, TAX_DATE, _user, draft, product

PROVINCES = {"ON": ("Ontario", "HST"), "BC": ("British Columbia", "PST"), "QC": ("Quebec", "QST")}
SERVICES = (TransactionClass.B2B_SERVICES, TransactionClass.B2C_SERVICES)
#: Plumbing rates: fake-provider fixtures, NOT legal values.
PLUMBING_RATES = {("CA", "GST"): Decimal("5"), ("CA-ON", "HST"): Decimal("13"),
                  ("CA-BC", "PST"): Decimal("7"), ("CA-QC", "QST"): Decimal("9.975")}


def _canada_rules(world):
    """The fake's plumbing behaviour: HST replaces GST in an HST province, and
    a Quebec buyer gets QST from the provider even when we hold no QST
    registration (the case our nexus check must catch)."""
    from app.modules.tax.engines import ComponentResult

    def hook(request, result):
        has_hst = any(a.tax_type and a.tax_type.code == "HST" for a in request.activations)
        if has_hst:
            result.components = [c for c in result.components
                                 if not any(a.id == c.activation_id and a.tax_type.code == "GST" for a in request.activations)]
        billing = ((request.facts.get("buyer") or {}).get("addresses") or {}).get("BILLING") or {}
        if billing.get("subdivision_code") == "QC" and not any(a.tax_type.code == "QST" for a in request.activations):
            qc = world["jurisdictions"]["CA-QC"]
            result.components.append(ComponentResult(component_code="FAKE:QST", rate_percent=PLUMBING_RATES[("CA-QC", "QST")],
                                                     rate_source="PROVIDER", jurisdiction_id=qc.id,
                                                     tax_type_id=world["tax_types"]["QST"].id))
        return result
    return hook


def build_canada(db, code="P4BCA"):
    org = make_organization(db, code=code, name="Phase 4b Canada Org")
    w = {"db": db, "org": org,
         "maker": _user(db, f"maker@{code.lower()}.example", UserRole.BILLING_ADMIN, org.id),
         "checker": _user(db, f"checker@{code.lower()}.example", UserRole.FINANCE_APPROVER, org.id),
         "reviewer": _user(db, f"rev@{code.lower()}.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_REVIEWER),
         "publisher": _user(db, f"pub@{code.lower()}.example", UserRole.SUPER_ADMIN,
                            platform_role=PlatformRole.TAX_PUBLISHER)}
    entity = LegalEntityService(db).ensure_default_entity(org.id)
    entity.country_code, entity.subdivision_code = "CA", "ON"
    entity.tax_regime = EntityTaxRegime.GOVERNED
    w["entity"] = entity

    ca = TaxJurisdiction(code="CA", name="Canada", level=JurisdictionLevel.COUNTRY, country_code="CA")
    db.add(ca)
    db.flush()
    jurisdictions = {"CA": ca}
    for sub, (name, _) in PROVINCES.items():
        j = TaxJurisdiction(code=f"CA-{sub}", name=name, level=JurisdictionLevel.STATE_PROVINCE, country_code="CA",
                            subdivision_code=sub, parent_id=ca.id)
        db.add(j)
        jurisdictions[j.code] = j
    db.flush()
    tax_types = {}
    for t in ("GST", "HST", "PST", "QST"):
        tax_types[t] = TaxTypeDefinition(code=t, name=t)
        db.add(tax_types[t])
    authority = TaxAuthority(code="CA-CRA-FX", name="Fixture CRA", jurisdiction_id=ca.id)
    db.add(authority)
    db.flush()
    markets = [("CA", "GST")] + [(f"CA-{sub}", t) for sub, (_, t) in PROVINCES.items()]
    for jcode, t in markets:
        db.add(TaxComponent(code=f"{jcode}-{t}-FX", name=f"{jcode} {t} (fixture)", jurisdiction_id=jurisdictions[jcode].id,
                            tax_type_id=tax_types[t].id, authority_id=authority.id))
    db.flush()
    w["jurisdictions"], w["tax_types"] = jurisdictions, tax_types

    avail = MarketAvailabilityService(db)
    for jcode, t in markets:
        for cls in SERVICES:
            row = avail.draft(actor_id=w["reviewer"].id, jurisdiction_id=jurisdictions[jcode].id,
                              tax_type_id=tax_types[t].id, transaction_class=cls,
                              mode=TaxOperatingMode.PROVIDER_APPROVED, gates=GATES)
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
    fake.rates = {k: v for k, v in PLUMBING_RATES.items()}
    fake.unresolved_buyer_as_consumer = True               # the provider treats unevidenced buyers as consumers
    fake.result_hook = _canada_rules(w)
    w["provider"] = fake
    connections = ProviderConnectionService(db)
    conn = connections.propose(org.id, w["maker"].id, seller_entity_id=entity.id, provider_name="fake-provider",
                               environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.COMMIT)
    connections.set_credentials(org.id, w["maker"].id, conn.id, "canada-sandbox-credential-7777")
    connections.decide(org.id, w["checker"].id, conn.id, approve=True)
    w["connection"] = conn

    tenant = TenantTaxService(db)
    registered = [("CA", "GST", "123456789RT0001"), ("CA-ON", "HST", "123456789RT0001"),
                  ("CA-BC", "PST", "PST-1234-5678")]              # no QST registration
    for jcode, t, number in registered:
        reg = tenant.create_registration(org.id, w["maker"].id, seller_entity_id=entity.id,
                                         jurisdiction_id=jurisdictions[jcode].id, tax_type_id=tax_types[t].id,
                                         registration_number=number, valid_from=date(2020, 1, 1))
        for cls in SERVICES:
            act = tenant.propose_activation(org.id, w["maker"].id, seller_entity_id=entity.id,
                                            jurisdiction_id=jurisdictions[jcode].id, tax_type_id=tax_types[t].id,
                                            transaction_class=cls, mode=TaxOperatingMode.PROVIDER_APPROVED,
                                            effective_from=date(2025, 1, 1), registration_id=reg.id,
                                            provider_connection_id=conn.id)
            tenant.decide_activation(org.id, w["checker"].id, act.id, approve=True)
    w["svc"] = product(w, "SVC-CA", "SVC")
    for sub in ("ON", "BC", "QC", None):
        w[f"buyer_{sub or 'NOPROV'}"] = buyer(w, sub)
    beat_for_tests(db)
    db.commit()
    return w


def buyer(w, province):
    c = make_customer(w["db"], w["org"].id, code=f"CA-{province or 'X'}", email=f"{province or 'x'}@ca.example")
    BuyerEvidenceService(w["db"]).record_address(w["org"].id, w["maker"].id, c.id, role=AddressRole.BILLING,
                                                 country_code="CA", subdivision_code=province, postal_code="M5V 2T6",
                                                 city="Somewhere", line1="1 Fixture Street")
    return c


@pytest.fixture()
def w(db_session):
    return build_canada(db_session)


def quote_for(w, province, price=100):
    inv = draft(w, [(w["svc"], price, 1, False)], customer=w[f"buyer_{province}"], currency="CAD")
    return inv, TaxDeterminationService(w["db"]).create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)


def components(q):
    return sorted((c.component_code, c.rate_percent, c.tax_amount) for line in q.lines for c in line.components)


# ── T06 (plumbing): GST vs HST vs PST vs QST, by place of supply ────────

def test_t06_plumbing_ontario_is_one_hst_component(w):
    inv, q = quote_for(w, "ON")
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    (comp,) = [c for line in q.lines for c in line.components]
    assert comp.jurisdiction_id == w["jurisdictions"]["CA-ON"].id and comp.rate_percent == Decimal("13")
    assert q.tax_amount == Decimal("13.00") and q.supply_address["subdivision_code"] == "ON"


def test_t06_plumbing_british_columbia_is_gst_plus_pst(w):
    inv, q = quote_for(w, "BC")
    assert q.status == TaxQuoteStatus.QUOTED
    jurisdictions = sorted(c.jurisdiction_id for line in q.lines for c in line.components)
    assert jurisdictions == sorted([w["jurisdictions"]["CA"].id, w["jurisdictions"]["CA-BC"].id])
    assert q.tax_amount == Decimal("12.00")


def test_t06_plumbing_qst_without_a_qst_registration_is_review_required(w):
    inv, q = quote_for(w, "QC")
    assert q.status == TaxQuoteStatus.REVIEW_REQUIRED and q.refusal_code == "PROVIDER_CONTRADICTS_CONTEXT"
    assert "no recorded registration" in q.refusal_reason and q.tax_amount is None


def test_province_is_required_a_postal_code_alone_never_resolves(w):
    inv, q = quote_for(w, "NOPROV")
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.refusal_code == "REQUIRED_FACTS_MISSING"
    assert any(i["code"] == "BUYER_SUBDIVISION_MISSING" for i in q.issues)


def test_canada_issues_through_the_connection_with_its_registrations(w):
    inv, q = quote_for(w, "ON")
    svc = InvoiceService(w["db"])
    svc.governed_gate = GovernedIssuanceGate(w["db"])
    assert svc.finalize_invoice(inv.id, w["org"].id, w["maker"].id).status == InvoiceStatus.SENT
    payload = w["provider"].payloads[0]
    assert payload["currency"] == "CAD" and payload["buyer"]["address"]["subdivision_code"] == "ON"
    assert {(r["jurisdiction_code"], r["tax_type"]) for r in payload["seller"]["registered_jurisdictions"]} == \
        {("CA", "GST"), ("CA-ON", "HST"), ("CA-BC", "PST")}
    row = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    assert row.provider_connection_id == w["connection"].id


def test_there_is_no_native_canada_pack(w):
    markets = {m["jurisdiction_code"] for p in registered_rule_packs().values() for m in p.markets()}
    assert not any(code.startswith("CA") for code in markets)


def test_suspending_the_connection_freezes_canada(w):
    ProviderConnectionService(w["db"]).revoke_credentials(w["org"].id, w["maker"].id, w["connection"].id, "contract ended")
    inv, q = quote_for(w, "ON")
    assert q.status != TaxQuoteStatus.QUOTED and q.tax_amount is None
