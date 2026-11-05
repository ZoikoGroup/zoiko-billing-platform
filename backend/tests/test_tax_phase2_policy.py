"""tests/test_tax_phase2_policy.py
--------------------------------
ZB-TAX-ARCH-001 Phase 2: policy, activation and tax context (SQLite, service
level). Postgres-only guarantees (triggers, erasure flag, concurrent version
bumps) are in test_tax_phase2_pg.py.

Handoff QA references: T08 (unverified tax ID is not B2B evidence), T12 (no
activation via toggle, plan or currency; no tenant activation of a market the
platform hasn't made available), T13 (no tenant tax data without a JIT grant —
also tests/privacy/test_tax_phase2_access.py), T14 (expiring/expired evidence
raises review items), plus maker-checker at both levels, use-time effective
state, the context builder and its fingerprint, and cross-tenant isolation.
"""
import importlib.util
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import BillingCustomer, InvoiceStatus, Product, Quotation, QuoteStatus
from app.modules.super_admin.models import AttentionItem
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService, normalize_tax_id
from app.modules.tax.classification_service import (
    ClassificationService,
    bump_classification_version,
    current_classification_version,
)
from app.modules.tax.context_builder import TaxContextBuilder, build_tax_context
from app.modules.tax.enums import (
    AddressConfidence,
    AddressRole,
    EntityTaxRegime,
    GateStatus,
    MarketGate,
    PlatformVersionStatus,
    ReviewItemKind,
    ReviewItemStatus,
    SupplyCategory,
    TaxContextStatus,
    TaxOperatingMode,
    TenantApprovalStatus,
    TransactionClass,
    VerificationStatus,
)
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.models import (
    CustomerTaxAddress,
    CustomerTaxId,
    EntityTaxActivation,
    EntityTaxLegalBasis,
    EntityTaxRegistration,
    ProductTaxClassification,
    TaxRecordFrozenError,
    TaxReviewItem,
)
from app.modules.tax.policy_service import MarketAvailabilityService, TaxCodeSetService, active_code_set
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition
from app.modules.tax.registry_service import MakerCheckerError, RegistryImmutabilityError, RegistryStateError
from app.modules.tax.review_service import TaxReviewService
from app.modules.tax.tenant_tax_service import TENANT_CONFIG_LABEL, TenantTaxService, view_activation
from tests.conftest import make_customer, make_invoice, make_invoice_item, make_organization, make_quotation, make_quotation_item

GATES_PASSED = {g.name: {"status": "PASSED", "evidence_ref": f"EV-{g.name}"} for g in MarketGate}
B2B = TransactionClass.B2B_SERVICES
NATIVE = TaxOperatingMode.NATIVE_RULEPACK_APPROVED
TAX_DATE = date(2026, 6, 1)


# ── fixtures ────────────────────────────────────────────────────────────

def _user(db, email, role, org_id=None, platform_role=None):
    u = User(email=email, hashed_password="x", role=role, organization_id=org_id, platform_role=platform_role,
             first_name="T", last_name=email.split("@")[0], is_active=True, is_verified=True)
    db.add(u)
    db.flush()
    return u


@pytest.fixture()
def w(db_session):
    db = db_session
    org = make_organization(db, code="P2A", name="Phase Two A")
    other = make_organization(db, code="P2B", name="Phase Two B")
    entity = LegalEntityService(db).ensure_default_entity(org.id)
    entity.country_code = "GB"
    other_entity = LegalEntityService(db).ensure_default_entity(other.id)
    gb = TaxJurisdiction(code="GB", name="United Kingdom", level="country", country_code="GB", timezone="Europe/London")
    vat = TaxTypeDefinition(code="VAT", name="Value added tax")
    db.add_all([gb, vat])
    db.flush()
    world = {
        "db": db, "org": org, "other": other, "entity": entity, "other_entity": other_entity, "gb": gb, "vat": vat,
        "proposer": _user(db, "maker@p2a.example", UserRole.BILLING_ADMIN, org.id),
        "approver": _user(db, "checker@p2a.example", UserRole.FINANCE_APPROVER, org.id),
        "other_user": _user(db, "maker@p2b.example", UserRole.BILLING_ADMIN, other.id),
        "reviewer": _user(db, "rev@tax.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_REVIEWER),
        "publisher": _user(db, "pub@tax.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER),
    }
    db.commit()
    return world


def publish_availability(w, mode=NATIVE, cls=B2B, permitted=False, gates=GATES_PASSED):
    svc = MarketAvailabilityService(w["db"])
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                    transaction_class=cls, mode=mode, tenant_config_permitted=permitted, gates=gates)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.status == PlatformVersionStatus.VALIDATED, row.validation_errors
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="market review complete")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    w["db"].commit()
    return row


def registration(w, valid_from=date(2020, 1, 1), valid_to=None, org="org", entity="entity"):
    return TenantTaxService(w["db"]).create_registration(
        w[org].id, w["proposer"].id, seller_entity_id=w[entity].id, jurisdiction_id=w["gb"].id,
        tax_type_id=w["vat"].id, registration_number="GB123456789", valid_from=valid_from, valid_to=valid_to)


def propose(w, mode=NATIVE, cls=B2B, reg=None, effective_from=date(2026, 1, 1), **kw):
    if reg is None and "legal_basis_id" not in kw:
        reg = registration(w)
    return TenantTaxService(w["db"]).propose_activation(
        w["org"].id, w["proposer"].id, seller_entity_id=w["entity"].id, jurisdiction_id=w["gb"].id,
        tax_type_id=w["vat"].id, transaction_class=cls, mode=mode, effective_from=effective_from,
        registration_id=reg.id if reg is not None else None, **kw)


def approve(w, activation):
    return TenantTaxService(w["db"]).decide_activation(w["org"].id, w["approver"].id, activation.id, approve=True)


def publish_codes(w, codes=(("SVC-GEN", SupplyCategory.SERVICES), ("GOODS-GEN", SupplyCategory.GOODS))):
    svc = TaxCodeSetService(w["db"])
    row = svc.draft(actor_id=w["reviewer"].id)
    for code, cat in codes:
        svc.upsert_code(actor_id=w["reviewer"].id, version_id=row.id, code=code, name=code.title(), supply_category=cat)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="taxonomy v1")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    w["db"].commit()
    return row


def product(w, code="P1", org="org"):
    p = Product(organization_id=w[org].id, name=f"Product {code}", code=code)
    w["db"].add(p)
    w["db"].flush()
    return p


def classify(w, prod, code="SVC-GEN"):
    tax_code = next(c for c in active_code_set(w["db"]).codes if c.code == code)
    svc = ClassificationService(w["db"])
    row = svc.propose(w["org"].id, w["proposer"].id, product_id=prod.id, tax_code_id=tax_code.id)
    return svc.decide(w["org"].id, w["approver"].id, row.id, approve=True)


# ── Platform market availability (§05, §13.2) ───────────────────────────

def test_calculating_mode_requires_every_launch_gate(w):
    svc = MarketAvailabilityService(w["db"])
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                    transaction_class=B2B, mode=NATIVE)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.status == PlatformVersionStatus.VALIDATION_FAILED
    assert any("GOLDEN_TESTS_SIGNED_OFF" in e for e in row.validation_errors)

    gates = dict(GATES_PASSED)
    gates[MarketGate.GOLDEN_TESTS_SIGNED_OFF.name] = {"status": "NOT_APPLICABLE", "notes": "n/a"}
    gates[MarketGate.PROVIDER_CONTRACTS_AND_RECOVERY.name] = {"status": "NOT_APPLICABLE", "notes": ""}
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"gates": gates})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    joined = " ".join(row.validation_errors)
    assert "GOLDEN_TESTS_SIGNED_OFF PASSED" in joined                 # mandatory gate cannot be waived
    assert "NOT_APPLICABLE without a note" in joined


def test_reference_only_availability_needs_no_gates(w):
    row = publish_availability(w, mode=TaxOperatingMode.REFERENCE_ONLY, gates={})
    assert row.status == PlatformVersionStatus.ACTIVE


def test_availability_maker_cannot_approve_or_publish(w):
    svc = MarketAvailabilityService(w["db"])
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                    transaction_class=B2B, mode=NATIVE, gates=GATES_PASSED)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="r")
    with pytest.raises(MakerCheckerError):
        svc.approve(actor_id=w["reviewer"].id, version_id=row.id)
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    with pytest.raises(MakerCheckerError):
        svc.publish(actor_id=w["reviewer"].id, version_id=row.id)


def test_availability_content_frozen_once_submitted_and_versions_supersede(w):
    first = publish_availability(w)
    second = publish_availability(w, mode=TaxOperatingMode.SUSPENDED, gates={})
    assert first.status == PlatformVersionStatus.SUPERSEDED and first.superseded_at is not None
    assert second.predecessor_id == first.id and second.status == PlatformVersionStatus.ACTIVE
    with pytest.raises(RegistryStateError):
        MarketAvailabilityService(w["db"]).amend(actor_id=w["reviewer"].id, version_id=second.id,
                                                 changes={"mode": NATIVE})
    second.mode = NATIVE
    with pytest.raises(RegistryImmutabilityError):
        w["db"].flush()


def test_tenant_config_permission_defaults_off_and_never_on_a_suspended_market(w):
    row = publish_availability(w, mode=TaxOperatingMode.REFERENCE_ONLY, gates={})
    assert row.tenant_config_permitted is False
    svc = MarketAvailabilityService(w["db"])
    bad = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                    transaction_class=B2B, mode=TaxOperatingMode.SUSPENDED, tenant_config_permitted=True,
                    gates=GATES_PASSED)
    svc.validate(actor_id=w["reviewer"].id, version_id=bad.id)
    assert any("SUSPENDED" in e for e in bad.validation_errors)


# ── Tax-code taxonomy ────────────────────────────────────────────────────

def test_tax_code_set_is_versioned_and_frozen_after_submission(w):
    v1 = publish_codes(w)
    svc = TaxCodeSetService(w["db"])
    v2 = svc.draft(actor_id=w["reviewer"].id)
    assert {c.code for c in v2.codes} == {"SVC-GEN", "GOODS-GEN"}           # copied from the active set
    svc.upsert_code(actor_id=w["reviewer"].id, version_id=v2.id, code="DIG-GEN", name="Digital",
                    supply_category=SupplyCategory.DIGITAL)
    svc.validate(actor_id=w["reviewer"].id, version_id=v2.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=v2.id, reason="add digital")
    with pytest.raises(RegistryStateError):
        svc.upsert_code(actor_id=w["reviewer"].id, version_id=v2.id, code="X", name="X",
                        supply_category=SupplyCategory.GOODS)
    svc.approve(actor_id=w["publisher"].id, version_id=v2.id)
    svc.publish(actor_id=w["publisher"].id, version_id=v2.id)
    assert v1.status == PlatformVersionStatus.SUPERSEDED and active_code_set(w["db"]).id == v2.id


# ── T12: tenant activation only within platform availability ────────────

def test_t12_tenant_cannot_activate_a_market_the_platform_has_not_made_available(w):
    act = propose(w)
    with pytest.raises(BadRequestException, match="not made this market available"):
        approve(w, act)
    publish_availability(w, mode=TaxOperatingMode.REFERENCE_ONLY, gates={})
    with pytest.raises(BadRequestException, match="available as REFERENCE_ONLY"):
        approve(w, act)
    publish_availability(w, mode=NATIVE)
    approved = approve(w, act)
    assert approved.status == TenantApprovalStatus.APPROVED and approved.availability_version_id is not None


def test_t12_reference_only_and_suspended_are_not_activatable_modes(w):
    for mode in (TaxOperatingMode.REFERENCE_ONLY, TaxOperatingMode.SUSPENDED, TaxOperatingMode.UNSUPPORTED):
        with pytest.raises(BadRequestException, match="not an activatable mode"):
            propose(w, mode=mode)


def test_t12_no_activation_through_settings_toggle_currency_or_country(w):
    org, entity, db = w["org"], w["entity"], w["db"]
    org.currency = "GBP"
    org.country = "United Kingdom"
    db.commit()
    with pytest.raises(BadRequestException, match="cannot be enabled from settings"):
        LegalEntityService(db).update_entity(entity.id, org.id, w["proposer"].id, tax_regime=EntityTaxRegime.GOVERNED)
    assert db.query(EntityTaxActivation).count() == 0
    assert entity.tax_regime == EntityTaxRegime.LEGACY_MANUAL


def test_governed_regime_needs_an_activation_backed_by_a_published_pack(w):
    # Phase 3b: an approved, effective native-pack activation is not enough
    # while no published rule pack covers the market (drafts never qualify).
    svc = TenantTaxService(w["db"])
    report = svc.regime_eligibility(w["org"].id, w["entity"].id, TAX_DATE)
    assert report["would_qualify"] is False and report["unmet_conditions"]
    publish_availability(w)
    approve(w, propose(w))
    report = svc.regime_eligibility(w["org"].id, w["entity"].id, TAX_DATE)
    assert report["would_qualify"] is False and report["governed_available"] is True
    assert any("backed by a published rule pack" in u for u in report["unmet_conditions"])
    with pytest.raises(BadRequestException, match="does not qualify"):
        svc.request_regime(w["org"].id, w["proposer"].id, w["entity"].id, EntityTaxRegime.GOVERNED)
    assert w["entity"].tax_regime == EntityTaxRegime.LEGACY_MANUAL


def test_tenant_config_mode_fails_closed(w):
    kw = dict(tenant_rate_percent=Decimal("20"), tenant_source_citation="Value Added Tax Act 1994 s.2",
              tenant_source_url="https://www.legislation.gov.uk/ukpga/1994/23/section/2")
    act = propose(w, mode=TaxOperatingMode.TENANT_CONFIG_APPROVED, **kw)
    with pytest.raises(BadRequestException, match="not made this market available"):
        approve(w, act)                                                # no availability record at all
    publish_availability(w, mode=TaxOperatingMode.REFERENCE_ONLY, gates={})
    with pytest.raises(BadRequestException, match="does not permit tenant-configured"):
        approve(w, act)                                                # record exists, flag false
    publish_availability(w, mode=TaxOperatingMode.REFERENCE_ONLY, permitted=True,
                         gates={MarketGate.LEGAL_AUTHORITY_AND_USAGE_RIGHTS.name: {"status": "PASSED", "evidence_ref": "EV"}})
    approved = approve(w, act)
    assert view_activation(approved)["verification_label"] == TENANT_CONFIG_LABEL
    with pytest.raises(BadRequestException, match="own legal source"):
        propose(w, mode=TaxOperatingMode.TENANT_CONFIG_APPROVED, tenant_rate_percent=Decimal("20"))
    with pytest.raises(BadRequestException, match="only allowed for TENANT_CONFIG_APPROVED"):
        propose(w, tenant_rate_percent=Decimal("20"))


def test_registration_rule_and_structured_legal_basis(w):
    publish_availability(w)
    lapsed = registration(w, valid_from=date(2020, 1, 1), valid_to=date(2025, 1, 1))
    with pytest.raises(BadRequestException, match="not valid on 2026-01-01"):
        approve(w, propose(w, reg=lapsed))

    svc = TenantTaxService(w["db"])
    basis = svc.propose_legal_basis(w["org"].id, w["proposer"].id, seller_entity_id=w["entity"].id,
                                    jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                                    legal_basis="Non-established taxable person scheme", evidence_ref="DMS-123",
                                    valid_from=date(2025, 1, 1))
    pending = propose(w, legal_basis_id=basis.id)
    with pytest.raises(BadRequestException, match="legal basis .* is PROPOSED"):
        approve(w, pending)
    with pytest.raises(ForbiddenException):
        svc.decide_legal_basis(w["org"].id, w["proposer"].id, basis.id, approve=True)
    svc.decide_legal_basis(w["org"].id, w["approver"].id, basis.id, approve=True)
    assert approve(w, pending).status == TenantApprovalStatus.APPROVED

    with pytest.raises(BadRequestException, match="exactly one"):
        svc.propose_activation(w["org"].id, w["proposer"].id, seller_entity_id=w["entity"].id,
                               jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id, transaction_class=B2B,
                               mode=NATIVE, effective_from=date(2026, 1, 1))


def test_tenant_maker_cannot_approve_own_activation(w):
    publish_availability(w)
    act = propose(w)
    with pytest.raises(ForbiddenException):
        TenantTaxService(w["db"]).decide_activation(w["org"].id, w["proposer"].id, act.id, approve=True)
    with pytest.raises(ForbiddenException):
        TenantTaxService(w["db"]).decide_activation(w["org"].id, w["proposer"].id, act.id, approve=False)


def test_new_activation_supersedes_the_previous_one(w):
    publish_availability(w)
    first = approve(w, propose(w))
    second = approve(w, propose(w, effective_from=date(2026, 7, 1)))
    assert first.status == TenantApprovalStatus.SUPERSEDED and second.predecessor_id == first.id


# ── Effective state at use time (change B) ──────────────────────────────

def test_platform_suspension_takes_effect_immediately(w):
    publish_availability(w)
    act = approve(w, propose(w))
    svc = TenantTaxService(w["db"])
    assert svc.effective_state(act, TAX_DATE)["effective"] is True
    publish_availability(w, mode=TaxOperatingMode.SUSPENDED, gates={})
    state = svc.effective_state(act, TAX_DATE)
    assert state["effective"] is False and any("SUSPENDED" in r for r in state["reasons"])
    assert act.status == TenantApprovalStatus.APPROVED                 # nothing rewritten; computed at use


def test_expired_registration_takes_effect_without_the_t14_job(w):
    publish_availability(w)
    reg = registration(w)
    act = approve(w, propose(w, reg=reg))
    TenantTaxService(w["db"]).update_registration(w["org"].id, w["proposer"].id, reg.id, valid_to=date(2026, 3, 1))
    state = TenantTaxService(w["db"]).effective_state(act, TAX_DATE)
    assert state["effective"] is False and any("not valid on 2026-06-01" in r for r in state["reasons"])
    assert w["db"].query(TaxReviewItem).count() == 0


# ── Product classification ──────────────────────────────────────────────

def test_classification_workflow_versions_and_stale_quotes(w):
    publish_codes(w)
    db, org = w["db"], w["org"]
    prod = product(w)
    customer = make_customer(db, org.id)
    open_quote = make_quotation(db, org.id, customer.id, status=QuoteStatus.SENT, quote_number="Q-1")
    accepted = make_quotation(db, org.id, customer.id, status=QuoteStatus.ACCEPTED, quote_number="Q-2")
    for q in (open_quote, accepted):
        make_quotation_item(db, org.id, q.id).product_id = prod.id
    draft = make_invoice(db, org.id, customer.id, status=InvoiceStatus.DRAFT, invoice_number="INV-D")
    make_invoice_item(db, org.id, draft.id).product_id = prod.id
    db.commit()

    preview = ClassificationService(db).impact_preview(org.id, [prod.id])
    assert [q["id"] for q in preview["open_quotes"]] == [open_quote.id]
    assert [i["id"] for i in preview["draft_invoices"]] == [draft.id]

    first = classify(w, prod)
    assert first.classification_version == 1 and current_classification_version(db, org.id) == 1
    assert open_quote.tax_context_status == TaxContextStatus.STALE
    assert accepted.tax_context_status is None
    second = classify(w, prod, code="GOODS-GEN")
    assert second.classification_version == 2 and second.predecessor_id == first.id
    assert first.status == TenantApprovalStatus.SUPERSEDED


def test_classification_maker_checker_and_published_codes_only(w):
    publish_codes(w)
    prod = product(w)
    svc = ClassificationService(w["db"])
    code = active_code_set(w["db"]).codes[0]
    row = svc.propose(w["org"].id, w["proposer"].id, product_id=prod.id, tax_code_id=code.id)
    with pytest.raises(ForbiddenException):
        svc.decide(w["org"].id, w["proposer"].id, row.id, approve=True)
    draft = TaxCodeSetService(w["db"]).draft(actor_id=w["reviewer"].id)
    with pytest.raises(BadRequestException, match="published tax-code set"):
        svc.propose(w["org"].id, w["proposer"].id, product_id=prod.id, tax_code_id=draft.codes[0].id)


def test_classification_versions_are_distinct_and_monotonic(w):
    seen = [bump_classification_version(w["db"], w["org"].id) for _ in range(5)]
    assert seen == [1, 2, 3, 4, 5]
    assert bump_classification_version(w["db"], w["other"].id) == 1          # per organization


# ── Buyer evidence ──────────────────────────────────────────────────────

def test_tax_id_raw_value_is_kept_and_only_whitespace_and_case_normalized(w):
    customer = make_customer(w["db"], w["org"].id)
    row = BuyerEvidenceService(w["db"]).add_tax_id(w["org"].id, w["proposer"].id, customer.id,
                                                   value=" gb 123-456.789 ", id_type="VAT")
    assert row.value_raw == " gb 123-456.789 "
    assert row.value_normalized == normalize_tax_id(" gb 123-456.789 ") == "GB123-456.789"
    assert row.verification_status == VerificationStatus.UNVERIFIED


def test_verification_needs_method_and_response(w):
    customer = make_customer(w["db"], w["org"].id)
    svc = BuyerEvidenceService(w["db"])
    row = svc.add_tax_id(w["org"].id, w["proposer"].id, customer.id, value="GB123")
    with pytest.raises(BadRequestException):
        svc.record_verification(w["org"].id, w["proposer"].id, row.id, status=VerificationStatus.VERIFIED,
                                method="VIES", response={})
    svc.record_verification(w["org"].id, w["proposer"].id, row.id, status=VerificationStatus.VERIFIED,
                            method="HMRC check VAT number", response={"valid": True, "ref": "R1"})
    assert row.verification_status == VerificationStatus.VERIFIED


def test_addresses_are_append_only(w):
    customer = make_customer(w["db"], w["org"].id)
    svc = BuyerEvidenceService(w["db"])
    first = svc.record_address(w["org"].id, w["proposer"].id, customer.id, role=AddressRole.BILLING, country_code="gb")
    second = svc.record_address(w["org"].id, w["proposer"].id, customer.id, role=AddressRole.BILLING,
                                country_code="FR", postal_code="75001")
    assert first.superseded_at is not None and second.superseded_at is None and first.country_code == "GB"
    with pytest.raises(BadRequestException):
        svc.record_address(w["org"].id, w["proposer"].id, customer.id, role=AddressRole.BILLING,
                           country_code="GB", confidence=AddressConfidence.DERIVED)
    with pytest.raises(BadRequestException):
        svc.record_address(w["org"].id, w["proposer"].id, customer.id, role=AddressRole.BILLING,
                           country_code="United Kingdom")


def test_frozen_key_fields_and_no_deletes_through_the_orm(w):
    reg = registration(w)
    reg.registration_number = "CHANGED"
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()
    w["db"].rollback()
    reg = w["db"].get(EntityTaxRegistration, reg.id)
    reg.valid_to = date(2030, 1, 1)                                    # recording the end is allowed
    w["db"].flush()
    w["db"].delete(reg)
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()


def test_approved_activation_key_fields_are_frozen(w):
    publish_availability(w)
    act = approve(w, propose(w))
    act.mode = TaxOperatingMode.PROVIDER_APPROVED
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()


def test_customers_holding_tax_evidence_cannot_be_hard_deleted(w):
    from app.modules.billing.services.customer_service import CustomerService

    customer = make_customer(w["db"], w["org"].id, code="KEEP")
    bare = make_customer(w["db"], w["org"].id, code="BARE", email="bare@example.com")
    BuyerEvidenceService(w["db"]).add_tax_id(w["org"].id, w["proposer"].id, customer.id, value="GB1")
    with pytest.raises(BadRequestException, match="hold recorded tax evidence"):
        CustomerService(w["db"]).bulk_delete_customers(w["org"].id, [customer.id, bare.id])
    assert CustomerService(w["db"]).bulk_delete_customers(w["org"].id, [bare.id]) == 1


def test_erasure_purge_removes_tenant_tax_evidence(w):
    from app.modules.super_admin.organization_purge_service import OrganizationPurgeService

    publish_availability(w)
    approve(w, propose(w))
    customer = make_customer(w["db"], w["org"].id)
    BuyerEvidenceService(w["db"]).add_tax_id(w["org"].id, w["proposer"].id, customer.id, value="GB1")
    admin = _user(w["db"], "purger@tax.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.PLATFORM_ADMINISTRATOR)
    result = OrganizationPurgeService(w["db"]).purge(w["org"], actor=admin, reason="erasure")
    w["db"].commit()
    assert result.per_table.get("entity_tax_activations") and result.per_table.get("customer_tax_ids")
    assert w["db"].query(CustomerTaxId).count() == 0
    assert w["db"].query(TaxJurisdiction).count() == 1                  # platform reference untouched


# ── Tax Context Builder ─────────────────────────────────────────────────

def _complete_invoice(w):
    """A draft invoice for which every Phase 2 fact is present."""
    db, org = w["db"], w["org"]
    publish_codes(w)
    publish_availability(w)
    approve(w, propose(w))
    prod = product(w)
    classify(w, prod)
    customer = make_customer(db, org.id)
    ev = BuyerEvidenceService(db)
    ev.record_address(org.id, w["proposer"].id, customer.id, role=AddressRole.BILLING, country_code="GB",
                      subdivision_code="ENG", postal_code="SW1A 1AA")
    tax_id = ev.add_tax_id(org.id, w["proposer"].id, customer.id, value="GB123456789", id_type="VAT")
    ev.record_verification(org.id, w["proposer"].id, tax_id.id, status=VerificationStatus.VERIFIED,
                           method="HMRC check VAT number", response={"valid": True})
    invoice = make_invoice(db, org.id, customer.id, status=InvoiceStatus.DRAFT, invoice_number="INV-CTX")
    invoice.tax_date = TAX_DATE
    invoice.seller_entity_id = w["entity"].id
    invoice.currency = "GBP"
    item = make_invoice_item(db, org.id, invoice.id)
    item.product_id = prod.id
    db.commit()
    return invoice, customer, tax_id, prod


def test_context_builder_is_complete_when_every_fact_is_present(w):
    invoice, *_ = _complete_invoice(w)
    ctx = build_tax_context(w["db"], w["org"].id, "invoice", invoice.id)
    assert ctx["issues"] == [] and ctx["complete"] is True
    assert ctx["facts"]["buyer"]["business_status"] == "BUSINESS"
    assert [a["effective"] for a in ctx["facts"]["activations"]] == [True]
    assert len(ctx["context_fingerprint"]) == 64


def test_context_builder_reports_each_missing_fact(w):
    db, org = w["db"], w["org"]
    customer = make_customer(db, org.id)
    customer.customer_type = "BUSINESS"                               # tenant flag alone is not evidence
    BuyerEvidenceService(db).add_tax_id(org.id, w["proposer"].id, customer.id, value="GB999")
    invoice = make_invoice(db, org.id, customer.id, status=InvoiceStatus.DRAFT, invoice_number="INV-GAPS")
    invoice.tax_date = None
    invoice.seller_entity_id = None
    plain = make_invoice_item(db, org.id, invoice.id, line_number=1)
    unclassified = make_invoice_item(db, org.id, invoice.id, line_number=2)
    unclassified.product_id = product(w).id
    unclassified.is_tax_inclusive = True
    plain.is_tax_inclusive = False
    db.commit()

    codes = {i["code"]: i["kind"] for i in build_tax_context(db, org.id, "invoice", invoice.id)["issues"]}
    assert codes == {
        "TAX_DATE_MISSING": "MISSING",
        "SELLER_ENTITY_MISSING": "MISSING",
        "PRICING_MODE_MIXED": "AMBIGUOUS",
        "LINE_PRODUCT_MISSING": "MISSING",
        "PRODUCT_CLASSIFICATION_MISSING": "MISSING",
        "BUYER_COUNTRY_MISSING": "MISSING",
        "TAX_ID_UNVERIFIED": "UNVERIFIED",
        "BUYER_STATUS_UNRESOLVED": "AMBIGUOUS",                      # T08
    }


def test_context_builder_reports_expiry_and_activation_problems(w):
    invoice, customer, tax_id, _ = _complete_invoice(w)
    db, org = w["db"], w["org"]
    tax_id.expires_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    BuyerEvidenceService(db).add_certificate(org.id, w["proposer"].id, customer.id, certificate_number="EX-1",
                                             jurisdiction_id=w["gb"].id, scope_description="Charity relief",
                                             valid_from=date(2025, 1, 1), expires_at=date(2026, 5, 1),
                                             evidence_ref="DMS-9")
    publish_availability(w, mode=TaxOperatingMode.SUSPENDED, gates={})
    db.commit()
    codes = {i["code"] for i in build_tax_context(db, org.id, "invoice", invoice.id)["issues"]}
    assert {"TAX_ID_VERIFICATION_EXPIRED", "BUYER_STATUS_UNRESOLVED", "EXEMPTION_CERTIFICATE_EXPIRED"} <= codes
    assert "ACTIVATION_NOT_EFFECTIVE" in codes


def test_context_builder_reads_only(w):
    invoice, *_ = _complete_invoice(w)
    db = w["db"]
    from app.modules.billing.models import BillingAuditLog

    before = (db.query(BillingAuditLog).count(), db.query(BillingCustomer).count())
    build_tax_context(db, w["org"].id, "invoice", invoice.id)
    assert not db.new and not db.dirty and not db.deleted
    assert (db.query(BillingAuditLog).count(), db.query(BillingCustomer).count()) == before


def test_quote_context_works_and_reports_its_missing_tax_date(w):
    db, org = w["db"], w["org"]
    customer = make_customer(db, org.id)
    quote = make_quotation(db, org.id, customer.id, quote_number="Q-CTX")
    quote.seller_entity_id = w["entity"].id
    make_quotation_item(db, org.id, quote.id)
    db.commit()
    ctx = build_tax_context(db, org.id, "quote", quote.id)
    assert ctx["document"]["type"] == "quote"
    assert "TAX_DATE_MISSING" in {i["code"] for i in ctx["issues"]}


# ── Context fingerprint (change C) ──────────────────────────────────────

def test_fingerprint_is_deterministic_and_changes_with_every_input(w):
    invoice, customer, tax_id, prod = _complete_invoice(w)
    db, org = w["db"], w["org"]

    def fp():
        db.commit()
        return TaxContextBuilder(db).build(org.id, "invoice", invoice.id,
                                           now=datetime(2026, 6, 2, tzinfo=timezone.utc)).context_fingerprint

    seen = {fp()}
    assert fp() in seen                                                # deterministic

    def changed(label, mutate):
        mutate()
        value = fp()
        assert value not in seen, f"fingerprint did not change for: {label}"
        seen.add(value)

    reg = db.query(EntityTaxRegistration).first()
    ev = BuyerEvidenceService(db)
    changed("tax date", lambda: setattr(invoice, "tax_date", date(2026, 6, 2)))
    changed("currency", lambda: setattr(invoice, "currency", "EUR"))
    changed("seller entity", lambda: setattr(w["entity"], "subdivision_code", "ENG"))
    changed("registration validity", lambda: TenantTaxService(db).update_registration(
        org.id, w["proposer"].id, reg.id, valid_to=date(2030, 1, 1)))
    changed("platform availability", lambda: publish_availability(w, mode=NATIVE))
    changed("buyer address", lambda: ev.record_address(org.id, w["proposer"].id, customer.id,
                                                       role=AddressRole.BILLING, country_code="GB",
                                                       subdivision_code="SCT"))
    changed("tax id verification", lambda: ev.record_verification(
        org.id, w["proposer"].id, tax_id.id, status=VerificationStatus.VERIFIED, method="HMRC",
        response={"valid": True, "ref": "R2"}, verified_at=datetime(2026, 6, 1, tzinfo=timezone.utc)))
    changed("exemption certificate", lambda: ev.add_certificate(
        org.id, w["proposer"].id, customer.id, certificate_number="C1", jurisdiction_id=w["gb"].id,
        scope_description="s", valid_from=date(2026, 1, 1), evidence_ref="e"))
    # Goods are supplied at the ship-to (Phase 4c), so record one first.
    changed("shipping address", lambda: ev.record_address(org.id, w["proposer"].id, customer.id,
                                                          role=AddressRole.SHIPPING, country_code="GB",
                                                          subdivision_code="SCT"))
    changed("classification version", lambda: classify(w, prod, code="GOODS-GEN"))
    changed("activation", lambda: approve(w, propose(w, effective_from=date(2026, 2, 1))))
    from app.modules.billing.models import InvoiceItem
    line = db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id).first()
    changed("pricing mode", lambda: setattr(line, "is_tax_inclusive", True))


# ── T14: review sweep ───────────────────────────────────────────────────

def test_t14_sweep_flags_expiring_and_expired_evidence_privately(w):
    db, org = w["db"], w["org"]
    now = datetime(2026, 6, 1, tzinfo=timezone.utc)
    reg = registration(w, valid_to=date(2026, 6, 20))
    customer = make_customer(db, org.id)
    ev = BuyerEvidenceService(db)
    cert = ev.add_certificate(org.id, w["proposer"].id, customer.id, certificate_number="X", jurisdiction_id=w["gb"].id,
                              scope_description="s", valid_from=date(2025, 1, 1), expires_at=date(2026, 5, 1),
                              evidence_ref="e")
    tid = ev.add_tax_id(org.id, w["proposer"].id, customer.id, value="GB1")
    ev.record_verification(org.id, w["proposer"].id, tid.id, status=VerificationStatus.VERIFIED, method="m",
                           response={"ok": True}, expires_at=datetime(2026, 5, 31, tzinfo=timezone.utc))
    review = TaxReviewService(db)
    assert review.sweep(now=now, window_days=30) == 3
    assert review.sweep(now=now, window_days=30) == 0                  # deduplicated
    kinds = {i.kind for i in review.list_items(org.id)}
    assert kinds == {ReviewItemKind.REGISTRATION_EXPIRING, ReviewItemKind.CERTIFICATE_EXPIRED,
                     ReviewItemKind.TAX_ID_VERIFICATION_EXPIRED}
    assert db.query(AttentionItem).count() == 0                         # nothing on the platform plane

    later = datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert review.sweep(now=later, window_days=30) == 1                # expiring -> expired
    items = {i.kind: i.status for i in db.query(TaxReviewItem).filter(
        TaxReviewItem.subject_type == "EntityTaxRegistration", TaxReviewItem.subject_id == reg.id)}
    assert items == {ReviewItemKind.REGISTRATION_EXPIRING: ReviewItemStatus.RESOLVED,
                     ReviewItemKind.REGISTRATION_EXPIRED: ReviewItemStatus.OPEN}
    assert cert.id and all(i.organization_id == org.id for i in db.query(TaxReviewItem))


def test_t14_job_is_registered_with_the_scheduler():
    from app.core.scheduler import get_job_definitions

    jobs = {d[2]: d for d in get_job_definitions()}
    assert jobs["tax_review_sweep_job"][0] == "app.modules.tax.tasks:run_tax_review_sweep_job"


# ── Cross-tenant isolation (every tenant table) ─────────────────────────

def test_other_tenants_records_are_indistinguishable_from_missing(w):
    db = w["db"]
    publish_availability(w)
    publish_codes(w)
    reg = registration(w)
    act = propose(w, reg=reg)
    basis = TenantTaxService(db).propose_legal_basis(
        w["org"].id, w["proposer"].id, seller_entity_id=w["entity"].id, jurisdiction_id=w["gb"].id,
        tax_type_id=w["vat"].id, legal_basis="b", evidence_ref="e", valid_from=date(2025, 1, 1))
    prod = product(w)
    cls = ClassificationService(db).propose(w["org"].id, w["proposer"].id, product_id=prod.id,
                                            tax_code_id=active_code_set(db).codes[0].id)
    customer = make_customer(db, w["org"].id)
    ev = BuyerEvidenceService(db)
    tid = ev.add_tax_id(w["org"].id, w["proposer"].id, customer.id, value="GB1")
    cert = ev.add_certificate(w["org"].id, w["proposer"].id, customer.id, certificate_number="X",
                              jurisdiction_id=w["gb"].id, scope_description="s", valid_from=date(2025, 1, 1),
                              expires_at=date(2025, 6, 1), evidence_ref="e")
    TaxReviewService(db).sweep(now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    item = db.query(TaxReviewItem).first()
    invoice = make_invoice(db, w["org"].id, customer.id, status=InvoiceStatus.DRAFT, invoice_number="INV-X")
    db.commit()

    other, user = w["other"].id, w["other_user"].id
    tenant = TenantTaxService(db)
    attempts = [
        lambda: tenant.update_registration(other, user, reg.id, notes="x"),
        lambda: tenant.decide_activation(other, user, act.id, approve=True),
        lambda: tenant.decide_legal_basis(other, user, basis.id, approve=True),
        lambda: tenant.regime_eligibility(other, w["entity"].id),
        lambda: ClassificationService(db).decide(other, user, cls.id, approve=True),
        lambda: ClassificationService(db).impact_preview(other, [prod.id]),
        lambda: ev.evidence(other, customer.id),
        lambda: ev.record_verification(other, user, tid.id, status=VerificationStatus.INVALID, method="m", response={"x": 1}),
        lambda: ev.revoke_certificate(other, user, cert.id),
        lambda: TaxReviewService(db).resolve(other, user, item.id),
        lambda: build_tax_context(db, other, "invoice", invoice.id),
        lambda: tenant.create_registration(other, user, seller_entity_id=w["entity"].id, jurisdiction_id=w["gb"].id,
                                           tax_type_id=w["vat"].id, registration_number="X", valid_from=date(2025, 1, 1)),
    ]
    for attempt in attempts:
        with pytest.raises(NotFoundException):
            attempt()
    assert tenant.list_registrations(other) == [] and tenant.list_activations(other) == []
    assert ClassificationService(db).list_classifications(other) == []
    assert TaxReviewService(db).list_items(other, None) == []


# ── Migration backfill (frozen code in c5e2d8a4b7f1) ────────────────────

def _load_migration():
    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "c5e2d8a4b7f1_tax_phase2_policy_activation_context.py"
    spec = importlib.util.spec_from_file_location("phase2_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backfill_keeps_raw_values_and_only_unambiguous_countries(w):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    db, org = w["db"], w["org"]
    uk = make_customer(db, org.id, code="UK")
    uk.billing_country, uk.shipping_country = "United Kingdom", "Narnia"
    uk.tax_id, uk.tax_id_type, uk.vat_number = " gb 123 456 ", "VAT Registration Number", "GB123456"
    uk.gst_number = "   "
    quote = make_quotation(db, org.id, uk.id, quote_number="Q-BF")
    db.commit()
    assert quote.seller_entity_id is None

    migration = _load_migration()
    connection = db.connection()
    with Operations.context(MigrationContext.configure(connection)):
        migration._backfill()
        migration._backfill()                                         # idempotent
    db.expire_all()

    addresses = db.query(CustomerTaxAddress).filter(CustomerTaxAddress.customer_id == uk.id).all()
    assert [(a.role, a.country_code, a.confidence, a.source_field) for a in addresses] == [
        (AddressRole.BILLING, "GB", AddressConfidence.DERIVED, "billing_country")]
    ids = db.query(CustomerTaxId).filter(CustomerTaxId.customer_id == uk.id).all()
    assert [(t.value_raw, t.value_normalized, t.source_field, t.id_type, t.verification_status) for t in ids] == [
        (" gb 123 456 ", "GB123456", "tax_id", "VAT Registration Number", VerificationStatus.UNVERIFIED)]
    assert uk.billing_country == "United Kingdom" and uk.tax_id == " gb 123 456 "   # legacy fields untouched
    assert db.get(Quotation, quote.id).seller_entity_id == w["entity"].id


def test_purge_never_walks_into_platform_reference_tables(w):
    """Regression: the purge BFS followed users -> registry SET NULL edges and
    UNIONed tax_source_artifacts' text key with integer keys, which Postgres
    rejects (CI caught it; SQLite does not type-check UNIONs)."""
    from app.database import Base
    from app.modules.super_admin.organization_purge_service import OrganizationPurgeService
    from app.modules.tax import policy_models, registry_models

    for module, declared in ((registry_models, registry_models.REGISTRY_TABLES),
                             (policy_models, policy_models.POLICY_TABLES)):
        defined = {obj.__tablename__ for obj in vars(module).values()
                   if isinstance(obj, type) and issubclass(obj, Base) and obj is not Base
                   and obj.__module__ == module.__name__}
        assert defined == set(declared), module.__name__

    publish_availability(w)
    approve(w, propose(w))
    collected = OrganizationPurgeService(w["db"])._collect(w["org"].id)
    platform = set(registry_models.REGISTRY_TABLES) | set(policy_models.POLICY_TABLES)
    assert not platform & set(collected)
    assert {"entity_tax_activations", "entity_tax_registrations"} <= set(collected)
