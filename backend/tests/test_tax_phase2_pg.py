"""tests/test_tax_phase2_pg.py
----------------------------
ZB-TAX-ARCH-001 Phase 2 guarantees only PostgreSQL provides: guard triggers on
platform policy versions and tax codes, frozen key fields on tenant tax
records, DELETE allowed only inside the erasure purge (transaction-scoped
flag zoiko.tax_erasure), and serialized classification-version bumps under
concurrent approvals.

Same contract as test_tax_phase1_registry_pg.py: runs only with
TAX_PG_TEST_URL (a migrated PostgreSQL database); skipped with a reason when
unset, an error when TAX_PG_TESTS_REQUIRED is set, never SQLite. Each test
runs in one outer transaction that is rolled back, except the concurrency
test, which needs real commits and cleans up after itself.
"""
import os
import threading
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 2 tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.auth.models import PlatformRole, User, UserRole  # noqa: E402
from app.modules.organizations.models import Organization  # noqa: E402
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService  # noqa: E402
from app.modules.tax.classification_service import bump_classification_version  # noqa: E402
from app.modules.tax.enums import (  # noqa: E402
    MarketGate,
    SupplyCategory,
    TaxOperatingMode,
    TransactionClass,
)
from app.modules.tax.legal_entity_service import LegalEntityService  # noqa: E402
from app.modules.tax.models import TaxClassificationCounter  # noqa: E402
from app.modules.tax.policy_service import MarketAvailabilityService, TaxCodeSetService  # noqa: E402
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition  # noqa: E402
from app.modules.tax.tenant_tax_service import TenantTaxService  # noqa: E402

GATES = {g.name: {"status": "PASSED", "evidence_ref": f"EV-{g.name}"} for g in MarketGate}


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


@pytest.fixture()
def pg(engine):
    connection = engine.connect()
    outer = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        outer.rollback()
        connection.close()


def _rejects(session, sql, params=None):
    with pytest.raises(IntegrityError):
        with session.begin_nested():
            session.execute(text(sql), params or {})


def _accepts(session, sql, params=None):
    with session.begin_nested():
        session.execute(text(sql), params or {})


def _user(pg, tag, role, org_id=None, platform_role=None):
    u = User(email=f"p2pg-{tag}-{id(pg)}@example.test", hashed_password="x", role=role, organization_id=org_id,
             platform_role=platform_role, first_name="Pg", last_name=tag, is_active=True, is_verified=True)
    pg.add(u)
    pg.flush()
    return u


@pytest.fixture()
def world(pg):
    org = Organization(organization_name="P2 PG Org", organization_code=f"P2PG{id(pg) % 100000}")
    pg.add(org)
    pg.flush()
    entity = LegalEntityService(pg).ensure_default_entity(org.id)
    j = TaxJurisdiction(code="ZZ-P2", name="P2 test land", level="country", country_code="ZZ", timezone="UTC")
    t = TaxTypeDefinition(code="ZZP2", name="P2 test tax")
    pg.add_all([j, t])
    pg.flush()
    return {
        "org": org, "entity": entity, "j": j, "t": t,
        "maker": _user(pg, "maker", UserRole.BILLING_ADMIN, org.id),
        "checker": _user(pg, "checker", UserRole.FINANCE_APPROVER, org.id),
        "reviewer": _user(pg, "rev", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_REVIEWER),
        "publisher": _user(pg, "pub", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER),
    }


def _availability(pg, w, mode=TaxOperatingMode.NATIVE_RULEPACK_APPROVED, publish=True):
    svc = MarketAvailabilityService(pg)
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["j"].id, tax_type_id=w["t"].id,
                    transaction_class=TransactionClass.B2B_SERVICES, mode=mode, gates=GATES)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="pg")
    if publish:
        svc.approve(actor_id=w["publisher"].id, version_id=row.id)
        svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    return row


def _activation(pg, w):
    svc = TenantTaxService(pg)
    reg = svc.create_registration(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id,
                                  jurisdiction_id=w["j"].id, tax_type_id=w["t"].id, registration_number="PG-REG",
                                  valid_from=date(2020, 1, 1))
    act = svc.propose_activation(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id,
                                 jurisdiction_id=w["j"].id, tax_type_id=w["t"].id,
                                 transaction_class=TransactionClass.B2B_SERVICES,
                                 mode=TaxOperatingMode.NATIVE_RULEPACK_APPROVED, effective_from=date(2026, 1, 1),
                                 registration_id=reg.id)
    return reg, act


# ── installed objects ───────────────────────────────────────────────────

def test_phase2_guard_triggers_are_installed(pg):
    names = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    expected = {"trg_tax_market_availability_versions_guard", "trg_tax_code_set_versions_guard",
                "trg_tax_codes_guard", "trg_entity_tax_registrations_guard", "trg_entity_tax_legal_bases_guard",
                "trg_entity_tax_activations_guard", "trg_product_tax_classifications_guard",
                "trg_customer_tax_addresses_guard", "trg_customer_tax_ids_guard",
                "trg_customer_exemption_certificates_guard"}
    assert expected <= names


# ── platform policy versions ────────────────────────────────────────────

def test_submitted_availability_content_is_frozen_in_the_database(pg, world):
    row = _availability(pg, world, publish=False)
    _rejects(pg, "UPDATE tax_market_availability_versions SET mode = 'PROVIDER_APPROVED' WHERE id = :id", {"id": row.id})
    _rejects(pg, "UPDATE tax_market_availability_versions SET tenant_config_permitted = true WHERE id = :id", {"id": row.id})
    _rejects(pg, "DELETE FROM tax_market_availability_versions WHERE id = :id", {"id": row.id})


def test_active_availability_can_only_be_superseded(pg, world):
    row = _availability(pg, world)
    _rejects(pg, "UPDATE tax_market_availability_versions SET status = 'REJECTED' WHERE id = :id", {"id": row.id})
    _rejects(pg, "UPDATE tax_market_availability_versions SET status = 'SUPERSEDED' WHERE id = :id", {"id": row.id})
    _accepts(pg, "UPDATE tax_market_availability_versions SET status = 'SUPERSEDED', superseded_at = now() "
                 "WHERE id = :id", {"id": row.id})
    _rejects(pg, "UPDATE tax_market_availability_versions SET status = 'ACTIVE', superseded_at = NULL "
                 "WHERE id = :id", {"id": row.id})


def test_only_one_active_availability_per_market(pg, world):
    _availability(pg, world)
    second = _availability(pg, world, publish=False)
    _rejects(pg, "UPDATE tax_market_availability_versions SET status = 'ACTIVE' WHERE id = :id", {"id": second.id})


def test_codes_of_a_submitted_set_are_frozen(pg, world):
    svc = TaxCodeSetService(pg)
    draft = svc.draft(actor_id=world["reviewer"].id, code="ZZ-PG")
    svc.upsert_code(actor_id=world["reviewer"].id, version_id=draft.id, code="A", name="A",
                    supply_category=SupplyCategory.SERVICES)
    svc.validate(actor_id=world["reviewer"].id, version_id=draft.id)
    svc.submit(actor_id=world["reviewer"].id, version_id=draft.id, reason="pg")
    _rejects(pg, "INSERT INTO tax_codes (code_set_version_id, code, name, supply_category, registry_product_scope) "
                 "VALUES (:v, 'B', 'B', 'SERVICES', 'GENERAL')", {"v": draft.id})
    _rejects(pg, "UPDATE tax_codes SET name = 'changed' WHERE code_set_version_id = :v", {"v": draft.id})
    _rejects(pg, "DELETE FROM tax_codes WHERE code_set_version_id = :v", {"v": draft.id})


# ── tenant tax records ──────────────────────────────────────────────────

def test_registration_key_fields_frozen_but_end_date_recordable(pg, world):
    reg, _ = _activation(pg, world)
    _rejects(pg, "UPDATE entity_tax_registrations SET registration_number = 'X' WHERE id = :id", {"id": reg.id})
    _rejects(pg, "UPDATE entity_tax_registrations SET valid_from = DATE '2000-01-01' WHERE id = :id", {"id": reg.id})
    _accepts(pg, "UPDATE entity_tax_registrations SET valid_to = DATE '2030-01-01', status = 'DEREGISTERED' "
                 "WHERE id = :id", {"id": reg.id})


def test_activation_key_fields_frozen_once_decided(pg, world):
    _availability(pg, world)
    _, act = _activation(pg, world)
    _accepts(pg, "UPDATE entity_tax_activations SET effective_to = DATE '2027-01-01' WHERE id = :id", {"id": act.id})
    TenantTaxService(pg).decide_activation(world["org"].id, world["checker"].id, act.id, approve=True)
    _rejects(pg, "UPDATE entity_tax_activations SET mode = 'PROVIDER_APPROVED' WHERE id = :id", {"id": act.id})
    _rejects(pg, "UPDATE entity_tax_activations SET approved_by = NULL WHERE id = :id", {"id": act.id})
    _accepts(pg, "UPDATE entity_tax_activations SET status = 'SUPERSEDED', superseded_at = now() WHERE id = :id",
             {"id": act.id})


def test_tax_id_raw_value_frozen_but_verification_recordable(pg, world):
    from tests.conftest import make_customer

    customer = make_customer(pg, world["org"].id, code="PGC")
    tid = BuyerEvidenceService(pg).add_tax_id(world["org"].id, world["maker"].id, customer.id, value=" zz 1 ")
    _rejects(pg, "UPDATE customer_tax_ids SET value_raw = 'ZZ1' WHERE id = :id", {"id": tid.id})
    _accepts(pg, "UPDATE customer_tax_ids SET verification_status = 'VERIFIED', verification_method = 'x' "
                 "WHERE id = :id", {"id": tid.id})


def test_tenant_tax_evidence_is_deleted_only_under_the_erasure_flag(pg, world):
    reg, act = _activation(pg, world)
    _rejects(pg, "DELETE FROM entity_tax_activations WHERE id = :id", {"id": act.id})
    _rejects(pg, "DELETE FROM entity_tax_registrations WHERE id = :id", {"id": reg.id})
    with pg.begin_nested():
        pg.execute(text("SET LOCAL zoiko.tax_erasure = 'on'"))
        pg.execute(text("DELETE FROM entity_tax_activations WHERE id = :id"), {"id": act.id})
        pg.execute(text("DELETE FROM entity_tax_registrations WHERE id = :id"), {"id": reg.id})


def test_erasure_purge_deletes_tenant_tax_records_on_postgres(pg, world):
    from tests.conftest import make_customer

    from app.modules.super_admin.organization_purge_service import OrganizationPurgeService

    _availability(pg, world)
    reg, act = _activation(pg, world)
    customer = make_customer(pg, world["org"].id, code="PGP")
    BuyerEvidenceService(pg).add_tax_id(world["org"].id, world["maker"].id, customer.id, value="ZZ9")
    admin = _user(pg, "purger", UserRole.SUPER_ADMIN, platform_role=PlatformRole.PLATFORM_ADMINISTRATOR)
    reg_id = reg.id                                   # the ORM object is gone after the purge
    result = OrganizationPurgeService(pg).purge(world["org"], actor=admin, reason="pg erasure")
    assert result.per_table.get("entity_tax_activations") == 1 and result.per_table.get("customer_tax_ids") == 1
    remaining = pg.execute(text("SELECT count(*) FROM entity_tax_registrations WHERE id = :id"), {"id": reg_id}).scalar()
    assert remaining == 0


# ── concurrent classification approvals (change G) ──────────────────────

def test_concurrent_version_bumps_never_reuse_a_version(engine):
    with Session(engine) as setup:
        org = Organization(organization_name="P2 PG Concurrency", organization_code=f"P2CC{os.getpid()}")
        setup.add(org)
        setup.flush()
        setup.add(TaxClassificationCounter(organization_id=org.id, version=0))
        setup.commit()
        org_id = org.id

    first = Session(engine)
    second = Session(engine)
    results, errors = {}, []
    try:
        results["a"] = bump_classification_version(first, org_id)        # holds the row lock

        def other():
            try:
                results["b"] = bump_classification_version(second, org_id)  # blocks until `first` commits
                second.commit()
            except Exception as exc:                                      # pragma: no cover - surfaced below
                errors.append(exc)

        thread = threading.Thread(target=other)
        thread.start()
        thread.join(timeout=2)
        assert thread.is_alive(), "the second bump must wait for the first transaction's row lock"
        first.commit()
        thread.join(timeout=30)
        assert not errors and sorted(results.values()) == [1, 2]
    finally:
        first.close()
        second.close()
        with Session(engine) as cleanup:
            cleanup.execute(text("DELETE FROM tax_classification_counters WHERE organization_id = :o"), {"o": org_id})
            cleanup.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org_id})
            cleanup.commit()
