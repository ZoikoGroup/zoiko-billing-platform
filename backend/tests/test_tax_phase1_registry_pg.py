"""tests/test_tax_phase1_registry_pg.py
-------------------------------------
ZB-TAX-ARCH-001 Phase 1 guarantees that only PostgreSQL can provide:
immutability triggers (catching query().update() and raw SQL, not just ORM
writes), the btree_gist EXCLUDE constraint against overlapping ACTIVE
intervals (T02), and its DEFERRABLE behaviour for corrections (T04).

Runs only when TAX_PG_TEST_URL points at a PostgreSQL database already
migrated to head (CI sets it to the workflow's Postgres service after an
upgrade -> downgrade -> upgrade round trip). Unset: every test is skipped
with that reason — unless TAX_PG_TESTS_REQUIRED is set (CI), which makes it
an error. Set to anything that is not PostgreSQL: the module errors — it
never falls back to SQLite.

Each test runs inside one outer transaction that is rolled back, so the
database is left untouched. Deferred constraints are forced with
SET CONSTRAINTS ... IMMEDIATE instead of committing.
"""
import os
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only tax registry guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.auth.models import PlatformRole, User, UserRole  # noqa: E402
from app.modules.super_admin.models import ApprovalRequest  # noqa: E402
from app.modules.tax.enums import (  # noqa: E402
    AcquisitionMethod,
    EvidenceStatus,
    RateKind,
    RateVersionStatus,
    RedistributionPermission,
    SourceTier,
    StagingOrigin,
)
from app.modules.tax.registry_models import (  # noqa: E402
    TaxAuthority,
    TaxChangeApproval,
    TaxComponent,
    TaxJurisdiction,
    TaxRateStaging,
    TaxRateVersion,
    TaxTypeDefinition,
)
from app.modules.tax.registry_service import TaxRegistryPipeline  # noqa: E402

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


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


def _expect_db_error(session, statement, params=None, errors=(IntegrityError,)):
    """Run one statement in a savepoint and assert Postgres rejects it."""
    with pytest.raises(errors):
        with session.begin_nested():
            session.execute(text(statement) if isinstance(statement, str) else statement, params or {})


def _check_constraints_now(session):
    session.execute(text("SET CONSTRAINTS ex_tax_rate_versions_active_overlap IMMEDIATE"))
    session.execute(text("SET CONSTRAINTS ex_tax_rate_versions_active_overlap DEFERRED"))


@pytest.fixture()
def world(pg):
    users = []
    for i, role in enumerate((PlatformRole.TAX_REVIEWER, PlatformRole.TAX_PUBLISHER)):
        u = User(email=f"pg-tax-{i}-{id(pg)}@example.test", hashed_password="x", role=UserRole.SUPER_ADMIN,
                 platform_role=role, organization_id=None, first_name="Pg", last_name=f"User{i}")
        pg.add(u)
        users.append(u)
    j = TaxJurisdiction(code="ZZ-PGT", name="PG test land", level="country", country_code="ZZ", timezone="UTC")
    pg.add(j)
    pg.flush()
    authority = TaxAuthority(code="ZZ-PGT-AUTH", name="PG test authority", jurisdiction_id=j.id)
    tax_type = TaxTypeDefinition(code="ZZPGT", name="PG test tax")
    pg.add_all([authority, tax_type])
    pg.flush()
    component = TaxComponent(code="ZZ-PGT-VAT", name="PG VAT", jurisdiction_id=j.id, tax_type_id=tax_type.id,
                             authority_id=authority.id)
    cumulative = TaxComponent(code="ZZ-PGT-LEVY", name="PG levy", jurisdiction_id=j.id, tax_type_id=tax_type.id,
                              authority_id=authority.id, is_cumulative=True)
    pg.add_all([component, cumulative])
    pg.flush()
    pipeline = TaxRegistryPipeline(pg)
    source = pipeline.register_source_revision(
        actor_id=None, authority_id=authority.id, source_tier=SourceTier.OFFICIAL_GUIDANCE,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url="https://example.test/src",
        title="PG source", citation="PG citation", language="en",
    )
    pipeline.attach_evidence(actor_id=users[0].id, revision_id=source.id, content=b"pg evidence",
                             media_type="text/plain", filename=None,
                             redistribution_permission=RedistributionPermission.PERMITTED)
    return {"maker": users[0], "checker": users[1], "jurisdiction": j, "component": component,
            "cumulative": cumulative, "source": source, "pipeline": pipeline}


def _raw_version(pg, w, *, rate="20", valid_from=date(2020, 1, 1), valid_to=None, component=None,
                 status=RateVersionStatus.ACTIVE):
    """Insert a version directly (bypassing the pipeline) to probe DB constraints."""
    component = component or w["component"]
    staged = TaxRateStaging(origin=StagingOrigin.MANUAL, component_id=component.id, tax_code="STANDARD",
                            product_scope="GENERAL", rate_kind=RateKind.STANDARD, observed_at=NOW, created_at=NOW)
    pg.add(staged)
    pg.flush()
    request = ApprovalRequest(request_type="tax_rate_publish", requested_by_user_id=w["maker"].id, requested_at=NOW)
    pg.add(request)
    pg.flush()
    change = TaxChangeApproval(approval_request_id=request.id, staged_rate_id=staged.id, change_kind="NEW",
                               detector=StagingOrigin.MANUAL, submitted_at=NOW)
    pg.add(change)
    pg.flush()
    version = TaxRateVersion(
        component_id=component.id, jurisdiction_id=component.jurisdiction_id, tax_code="STANDARD",
        product_scope="GENERAL", rate_kind=RateKind.STANDARD, rate_percent=Decimal(rate), valid_from=valid_from,
        valid_to=valid_to, observed_at=NOW, approved_at=NOW, published_at=NOW, activated_at=NOW,
        superseded_at=NOW if status == RateVersionStatus.SUPERSEDED else None, status=status,
        is_cumulative=component.is_cumulative, source_revision_id=w["source"].id,
        evidence_status=EvidenceStatus.CAPTURED, owner="pg", staged_rate_id=staged.id, change_approval_id=change.id,
    )
    pg.add(version)
    pg.flush()
    return version


# ── Schema objects exist ────────────────────────────────────────────────

def test_btree_gist_extension_is_installed(pg):
    assert pg.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'")).scalar() == 1


def test_exclude_constraint_is_deferrable_initially_deferred(pg):
    row = pg.execute(text(
        "SELECT contype, condeferrable, condeferred FROM pg_constraint "
        "WHERE conname = 'ex_tax_rate_versions_active_overlap'"
    )).one()
    assert tuple(row) == ("x", True, True)


def test_guard_triggers_are_installed(pg):
    names = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    assert {"trg_tax_rate_versions_guard", "trg_tax_legal_source_revisions_guard",
            "trg_tax_source_artifacts_guard"} <= names


# ── T04: tax_rate_versions immutability at the database ─────────────────

@pytest.mark.parametrize("assignment", [
    "rate_percent = 25", "valid_from = DATE '2000-01-01'", "valid_to = DATE '2030-01-01'",
    "source_revision_id = NULL", "tax_code = 'OTHER'", "owner = 'someone else'", "mode = 'PROVIDER_APPROVED'",
])
def test_raw_sql_cannot_change_published_fields(pg, world, assignment):
    version = _raw_version(pg, world)
    _expect_db_error(pg, f"UPDATE tax_rate_versions SET {assignment} WHERE id = :id", {"id": version.id})


def test_bulk_query_update_is_rejected_by_trigger(pg, world):
    version = _raw_version(pg, world)
    with pytest.raises(IntegrityError):
        with pg.begin_nested():
            pg.execute(update(TaxRateVersion).where(TaxRateVersion.id == version.id).values(rate_percent=Decimal("1")))


def test_raw_sql_cannot_delete_a_version(pg, world):
    version = _raw_version(pg, world)
    _expect_db_error(pg, "DELETE FROM tax_rate_versions WHERE id = :id", {"id": version.id})


def test_only_active_to_superseded_is_allowed(pg, world):
    version = _raw_version(pg, world)
    _expect_db_error(pg, "UPDATE tax_rate_versions SET status = 'SUPERSEDED' WHERE id = :id", {"id": version.id})
    with pg.begin_nested():
        pg.execute(text("UPDATE tax_rate_versions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = :id"),
                   {"id": version.id})
    _expect_db_error(pg, "UPDATE tax_rate_versions SET status = 'ACTIVE', superseded_at = NULL WHERE id = :id",
                     {"id": version.id})


# ── T02: EXCLUDE constraint ─────────────────────────────────────────────

def test_overlapping_active_versions_are_rejected(pg, world):
    _raw_version(pg, world, valid_from=date(2020, 1, 1))
    _raw_version(pg, world, rate="21", valid_from=date(2021, 1, 1))
    with pytest.raises(IntegrityError):
        with pg.begin_nested():
            _check_constraints_now(pg)


def test_adjacent_and_superseded_versions_do_not_conflict(pg, world):
    _raw_version(pg, world, valid_from=date(2019, 1, 1), valid_to=date(2020, 1, 1))
    _raw_version(pg, world, rate="21", valid_from=date(2020, 1, 1))
    _raw_version(pg, world, rate="22", valid_from=date(2020, 6, 1), status=RateVersionStatus.SUPERSEDED)
    with pg.begin_nested():
        _check_constraints_now(pg)


def test_cumulative_components_may_overlap(pg, world):
    _raw_version(pg, world, component=world["cumulative"], rate="1")
    _raw_version(pg, world, component=world["cumulative"], rate="2")
    with pg.begin_nested():
        _check_constraints_now(pg)


def test_correction_covering_the_same_interval_inside_one_transaction(pg, world):
    """Insert the corrected version BEFORE superseding the old one: legal
    only because the constraint is DEFERRABLE INITIALLY DEFERRED."""
    old = _raw_version(pg, world, valid_from=date(2020, 1, 1))
    new = _raw_version(pg, world, rate="20.5", valid_from=date(2020, 1, 1))
    pg.execute(text("UPDATE tax_rate_versions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = :id"),
               {"id": old.id})
    with pg.begin_nested():
        _check_constraints_now(pg)
    assert new.id != old.id


def test_pipeline_correction_publishes_cleanly_on_postgres(pg, world):
    p, maker, checker = world["pipeline"], world["maker"], world["checker"]

    def publish(**kw):
        row = p.stage(actor_id=maker.id, origin=StagingOrigin.MANUAL, component_id=world["component"].id,
                      tax_code="STANDARD", rate_kind=RateKind.STANDARD, source_revision_id=world["source"].id,
                      owner="pg", **kw)
        p.validate(actor_id=maker.id, staged_id=row.id)
        p.submit(actor_id=maker.id, staged_id=row.id, reason="pg")
        p.approve(actor_id=checker.id, staged_id=row.id)
        return p.publish(actor_id=checker.id, staged_id=row.id)

    original = publish(rate_percent=Decimal("20"), valid_from=date(2011, 1, 4))
    correction = publish(rate_percent=Decimal("20.5"), valid_from=date(2011, 1, 4),
                         supersedes_rate_version_id=original.id)
    with pg.begin_nested():
        _check_constraints_now(pg)
    pg.refresh(original)
    assert original.status == RateVersionStatus.SUPERSEDED and correction.predecessor_id == original.id
    assert original.rate_percent == Decimal("20")


# ── Source revisions and artifacts ──────────────────────────────────────

def test_captured_source_revision_is_frozen(pg, world):
    sid = world["source"].id
    _expect_db_error(pg, "UPDATE tax_legal_source_revisions SET citation = 'x' WHERE id = :id", {"id": sid})
    _expect_db_error(pg, "UPDATE tax_legal_source_revisions SET sha256 = NULL WHERE id = :id", {"id": sid})
    _expect_db_error(pg, "DELETE FROM tax_legal_source_revisions WHERE id = :id", {"id": sid})


def test_uncaptured_source_only_accepts_a_complete_evidence_attachment(pg, world):
    p = world["pipeline"]
    bare = p.register_source_revision(
        actor_id=None, authority_id=world["source"].authority_id, source_tier=SourceTier.OFFICIAL_GUIDANCE,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url="https://example.test/b",
        title="bare", citation="bare", language="en",
    )
    _expect_db_error(pg, "UPDATE tax_legal_source_revisions SET title = 'x' WHERE id = :id", {"id": bare.id})
    _expect_db_error(pg, "UPDATE tax_legal_source_revisions SET retrieved_at = now() WHERE id = :id", {"id": bare.id})
    p.attach_evidence(actor_id=world["maker"].id, revision_id=bare.id, content=b"complete",
                      media_type="text/plain", filename=None,
                      redistribution_permission=RedistributionPermission.RESTRICTED)
    pg.flush()


def test_artifacts_are_write_once(pg, world):
    sha = world["source"].sha256
    _expect_db_error(pg, "UPDATE tax_source_artifacts SET media_type = 'x' WHERE sha256 = :s", {"s": sha})
    _expect_db_error(pg, "DELETE FROM tax_source_artifacts WHERE sha256 = :s", {"s": sha},
                     errors=(IntegrityError, DBAPIError))


# ── Tenant erasure purge with the registry present ──────────────────────

def test_tenant_purge_runs_on_postgres_with_the_registry_present(pg, world):
    """Regression: the purge FK walk followed users -> registry SET NULL edges
    and UNIONed tax_source_artifacts' text key with integer keys, which
    Postgres rejects. Platform tables are now outside the purge graph."""
    from app.modules.organizations.models import Organization
    from app.modules.super_admin.organization_purge_service import OrganizationPurgeService

    org = Organization(organization_name="Purge PG Org", organization_code=f"PURGEPG{id(pg) % 100000}")
    pg.add(org)
    pg.flush()
    pg.add(User(email=f"tenant-{id(pg)}@purge.example", hashed_password="x", role=UserRole.ORG_ADMIN,
                organization_id=org.id, first_name="T", last_name="P"))
    pg.flush()
    result = OrganizationPurgeService(pg).purge(org, actor=world["checker"], reason="pg purge regression")
    pg.flush()
    assert result.per_table.get("organizations") == 1
    assert pg.execute(text("SELECT count(*) FROM tax_source_artifacts")).scalar() >= 1
