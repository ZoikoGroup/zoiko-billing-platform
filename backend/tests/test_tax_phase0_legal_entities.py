"""tests/test_tax_phase0_legal_entities.py
------------------------------------------
ZB-TAX-ARCH-001 Phase 0: taxonomy, seller legal entities, invoice tax
context (seller_entity_id + tax_date) and tax-rate precision.

Handoff QA references: T01 (taxonomy groundwork), T12 (no activation via UI
toggle), T13 (no default super-admin access), §02/§07 (entity-owned
obligations), §07 (decimal fixed-point precision).
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.core.dependencies import get_organization_id
from app.core.exceptions import AlreadyExistsException, BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import BillingAuditLog, Invoice, InvoiceStatus, TaxRate
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.tax.enums import (
    CALCULATING_MODES,
    ZERO_AMOUNT_OUTCOMES,
    EntityTaxRegime,
    TaxOperatingMode,
    TaxOutcome,
    is_determined,
)
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.models import SellerLegalEntity
from tests.conftest import make_customer, make_invoice, make_organization, make_tax_rate


def _org(db, code="TAXORG", **profile):
    org = make_organization(db, code=code, name=f"{code} Inc")
    for k, v in profile.items():
        setattr(org, k, v)
    db.flush()
    return org


# ── Taxonomy (§04, §08.2) ────────────────────────────────────────────────

def test_not_determined_is_not_a_legal_outcome():
    assert not is_determined(TaxOutcome.NOT_DETERMINED)
    assert TaxOutcome.NOT_DETERMINED not in ZERO_AMOUNT_OUTCOMES
    for outcome in TaxOutcome:
        if outcome != TaxOutcome.NOT_DETERMINED:
            assert is_determined(outcome)


def test_zero_amount_outcomes_are_distinct_legal_treatments():
    assert ZERO_AMOUNT_OUTCOMES == {
        TaxOutcome.ZERO_RATED, TaxOutcome.EXEMPT, TaxOutcome.REVERSE_CHARGE,
        TaxOutcome.OUT_OF_SCOPE, TaxOutcome.NON_TAXABLE_BY_RULE,
    }


def test_reference_only_and_suspended_modes_never_calculate():
    for mode in (TaxOperatingMode.REFERENCE_ONLY, TaxOperatingMode.UNSUPPORTED, TaxOperatingMode.SUSPENDED):
        assert mode not in CALCULATING_MODES


# ── Default entity bootstrap ─────────────────────────────────────────────

def test_default_entity_is_built_from_org_profile(db_session):
    org = _org(
        db_session, legal_name="Acme UK Ltd", country="United Kingdom",
        tax_no=" GB123456789 ", timezone="Europe/London", city="London",
    )
    entity = LegalEntityService(db_session).ensure_default_entity(org.id)

    assert entity.is_default and entity.is_active
    assert entity.entity_code == "PRIMARY"
    assert entity.legal_name == "Acme UK Ltd"
    assert entity.country_code == "GB"           # country name normalized to ISO
    assert entity.primary_tax_id == "GB123456789"
    assert entity.primary_tax_id_type == "VAT Registration Number"
    assert entity.timezone == "Europe/London"
    assert entity.tax_regime == EntityTaxRegime.LEGACY_MANUAL
    assert entity.is_merchant_of_record is True


def test_unrecognized_country_is_left_unknown_not_guessed(db_session):
    org = _org(db_session, country="Narnia")
    entity = LegalEntityService(db_session).ensure_default_entity(org.id)
    assert entity.country_code is None


def test_ensure_default_entity_is_idempotent(db_session):
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    first = svc.ensure_default_entity(org.id)
    second = svc.ensure_default_entity(org.id)
    assert first.id == second.id
    assert db_session.query(SellerLegalEntity).filter_by(organization_id=org.id).count() == 1


def test_database_rejects_a_second_default_entity(db_session):
    from sqlalchemy.exc import IntegrityError

    org = _org(db_session)
    LegalEntityService(db_session).ensure_default_entity(org.id)
    db_session.add(SellerLegalEntity(organization_id=org.id, entity_code="DUP", legal_name="Dup", is_default=True))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


# ── Entity management guardrails ─────────────────────────────────────────

def test_create_second_entity_and_switch_default(db_session):
    org = _org(db_session, country="GB")
    svc = LegalEntityService(db_session)
    ca = svc.create_entity(org.id, 1, entity_code="ca-ops", legal_name="Acme Canada Inc", country_code="Canada", subdivision_code="on")
    assert ca.entity_code == "CA-OPS" and ca.country_code == "CA" and ca.subdivision_code == "ON"
    assert not ca.is_default

    svc.set_default(ca.id, org.id, 1)
    defaults = db_session.query(SellerLegalEntity).filter_by(organization_id=org.id, is_default=True).all()
    assert [e.id for e in defaults] == [ca.id]


def test_duplicate_entity_code_rejected(db_session):
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    svc.create_entity(org.id, 1, entity_code="EU", legal_name="Acme EU")
    with pytest.raises(AlreadyExistsException):
        svc.create_entity(org.id, 1, entity_code="eu", legal_name="Other")


def test_invalid_country_rejected_on_write(db_session):
    org = _org(db_session)
    with pytest.raises(BadRequestException):
        LegalEntityService(db_session).create_entity(org.id, 1, entity_code="X", legal_name="X", country_code="Narnia")


def test_governed_regime_cannot_be_enabled_by_toggle(db_session):
    """T12: activation cannot come from a settings toggle."""
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    entity = svc.ensure_default_entity(org.id)
    db_session.commit()
    with pytest.raises(BadRequestException, match="governed tax regime"):
        svc.update_entity(entity.id, org.id, 1, tax_regime="governed")
    with pytest.raises(BadRequestException, match="governed tax regime"):
        svc.create_entity(org.id, 1, entity_code="G", legal_name="G", tax_regime=EntityTaxRegime.GOVERNED)
    db_session.refresh(entity)
    assert entity.tax_regime == EntityTaxRegime.LEGACY_MANUAL


def test_country_locked_once_entity_has_issued_invoices(db_session):
    org = _org(db_session, country="GB")
    svc = LegalEntityService(db_session)
    entity = svc.ensure_default_entity(org.id)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT)
    inv.seller_entity_id = entity.id
    db_session.commit()

    with pytest.raises(BadRequestException, match="re-attribute historical tax obligations"):
        svc.update_entity(entity.id, org.id, 1, country_code="FR")
    # Non-jurisdictional fields remain editable.
    updated = svc.update_entity(entity.id, org.id, 1, display_name="Acme (UK)")
    assert updated.display_name == "Acme (UK)" and updated.country_code == "GB"
    assert updated.version == 2


def test_country_editable_while_only_drafts_exist(db_session):
    org = _org(db_session, country="GB")
    svc = LegalEntityService(db_session)
    entity = svc.ensure_default_entity(org.id)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT)
    inv.seller_entity_id = entity.id
    db_session.commit()
    assert svc.update_entity(entity.id, org.id, 1, country_code="IE").country_code == "IE"


def test_optimistic_concurrency_on_update(db_session):
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    entity = svc.ensure_default_entity(org.id)
    db_session.commit()
    with pytest.raises(BadRequestException, match="modified by someone else"):
        svc.update_entity(entity.id, org.id, 1, expected_version=99, display_name="x")


def test_default_entity_cannot_be_deactivated(db_session):
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    entity = svc.ensure_default_entity(org.id)
    db_session.commit()
    with pytest.raises(BadRequestException):
        svc.deactivate(entity.id, org.id, 1)


def test_entity_changes_are_audited(db_session):
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    created = svc.create_entity(org.id, 1, entity_code="AU", legal_name="Acme AU", country_code="AU")
    svc.update_entity(created.id, org.id, 1, display_name="Acme Australia")
    rows = db_session.query(BillingAuditLog).filter(
        BillingAuditLog.organization_id == org.id, BillingAuditLog.entity_type == "SellerLegalEntity",
    ).all()
    assert len(rows) >= 3  # bootstrap default + create + update


# ── Tenant isolation (§12.1, T13) ────────────────────────────────────────

def test_other_tenants_entity_is_indistinguishable_from_missing(db_session):
    org_a = _org(db_session, code="ORGA")
    org_b = _org(db_session, code="ORGB")
    svc = LegalEntityService(db_session)
    a_entity = svc.ensure_default_entity(org_a.id)
    svc.ensure_default_entity(org_b.id)
    db_session.commit()

    with pytest.raises(NotFoundException):
        svc.get_entity(a_entity.id, org_b.id)
    with pytest.raises(NotFoundException):
        svc.resolve_issuing_entity(org_b.id, a_entity.id)
    with pytest.raises(NotFoundException):
        svc.update_entity(a_entity.id, org_b.id, 1, display_name="hijack")
    assert [e.organization_id for e in svc.list_entities(org_b.id)] == [org_b.id]


def test_every_tax_route_requires_a_tenant_scoped_identity():
    """T13: each tax-domain route resolves the tenant via get_organization_id,
    which refuses super-admin tokens."""
    from app.modules.tax.router import router

    for route in router.routes:
        flat = []

        def walk(dependant):
            for d in dependant.dependencies:
                flat.append(d.call)
                walk(d)
        walk(route.dependant)
        assert get_organization_id in flat, f"{route.path} is not tenant-scoped"


def test_super_admin_token_is_refused_tenant_scope():
    super_admin = User(email="sa@x.example", hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None)
    with pytest.raises(ForbiddenException):
        get_organization_id(super_admin)


# ── Invoice tax context ──────────────────────────────────────────────────

def _create_invoice(db, org, customer, **extra):
    return InvoiceService(db).create_invoice(
        organization_id=org.id, created_by=1, customer_id=customer.id, invoice_number=None,
        issue_date=date.today(), due_date=date.today() + timedelta(days=30), currency="USD",
        _skip_recalculate=True, **extra,
    )


def test_new_invoice_defaults_to_org_default_entity(db_session):
    org = _org(db_session, country="GB")
    cust = make_customer(db_session, org.id)
    inv = _create_invoice(db_session, org, cust)
    default = LegalEntityService(db_session).get_default_entity(org.id)
    assert inv.seller_entity_id == default.id
    assert inv.tax_date is None  # not fixed until issuance


def test_new_invoice_can_name_another_owned_entity(db_session):
    org = _org(db_session)
    cust = make_customer(db_session, org.id)
    other = LegalEntityService(db_session).create_entity(org.id, 1, entity_code="CA", legal_name="Acme CA", country_code="CA")
    inv = _create_invoice(db_session, org, cust, seller_entity_id=other.id)
    assert inv.seller_entity_id == other.id


def test_invoice_cannot_use_another_tenants_entity(db_session):
    org_a = _org(db_session, code="ORGA")
    org_b = _org(db_session, code="ORGB")
    foreign = LegalEntityService(db_session).ensure_default_entity(org_a.id)
    db_session.commit()
    cust_b = make_customer(db_session, org_b.id, code="CB")
    with pytest.raises(NotFoundException):
        _create_invoice(db_session, org_b, cust_b, seller_entity_id=foreign.id)


def test_invoice_cannot_use_inactive_entity(db_session):
    org = _org(db_session)
    svc = LegalEntityService(db_session)
    other = svc.create_entity(org.id, 1, entity_code="OLD", legal_name="Old Co")
    svc.deactivate(other.id, org.id, 1)
    cust = make_customer(db_session, org.id)
    with pytest.raises(BadRequestException, match="inactive"):
        _create_invoice(db_session, org, cust, seller_entity_id=other.id)


def test_idempotent_replay_unaffected_by_entity_resolution(db_session):
    org = _org(db_session)
    cust = make_customer(db_session, org.id)
    first = _create_invoice(db_session, org, cust, idempotency_key="k-1", notes="n")
    replay = _create_invoice(db_session, org, cust, idempotency_key="k-1", notes="n")
    assert replay.id == first.id


def test_finalize_stamps_entity_and_tax_date_for_legacy_drafts(db_session):
    """Drafts created outside create_invoice (recurring billing, assistant,
    pre-Phase-0 rows) still issue with a seller entity and a tax point."""
    org = _org(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT)
    assert inv.seller_entity_id is None and inv.tax_date is None

    result = InvoiceService(db_session).finalize_invoice(inv.id, org.id, updated_by=1)
    assert result.status == InvoiceStatus.SENT
    assert result.seller_entity_id == LegalEntityService(db_session).get_default_entity(org.id).id
    assert result.tax_date == result.issue_date


def test_finalize_preserves_an_explicit_tax_date(db_session):
    org = _org(db_session)
    cust = make_customer(db_session, org.id)
    explicit = date.today() - timedelta(days=3)
    inv = _create_invoice(db_session, org, cust, tax_date=explicit)
    result = InvoiceService(db_session).finalize_invoice(inv.id, org.id, updated_by=1)
    assert result.tax_date == explicit


def test_draft_can_be_moved_to_another_owned_entity(db_session):
    org = _org(db_session)
    cust = make_customer(db_session, org.id)
    inv = _create_invoice(db_session, org, cust)
    other = LegalEntityService(db_session).create_entity(org.id, 1, entity_code="AU", legal_name="Acme AU")
    updated = InvoiceService(db_session).update_invoice(inv.id, org.id, 1, seller_entity_id=other.id)
    assert updated.seller_entity_id == other.id


# ── Precision (§07) ──────────────────────────────────────────────────────

def test_rate_precision_holds_real_world_rates(db_session):
    org = _org(db_session)
    rate = make_tax_rate(db_session, org.id, "NYC-COMBINED", rate="8.875")
    db_session.commit()
    db_session.expire_all()
    stored = db_session.query(TaxRate).filter_by(id=rate.id).one().rate
    assert stored == Decimal("8.875")


def test_invoice_item_tax_percentage_holds_three_decimals(db_session):
    from tests.conftest import make_invoice_item

    org = _org(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT)
    item = make_invoice_item(db_session, org.id, inv.id, tax_percentage="8.875")
    db_session.commit()
    db_session.expire_all()
    from app.modules.billing.models import InvoiceItem
    assert db_session.query(InvoiceItem).filter_by(id=item.id).one().tax_percentage == Decimal("8.875")
