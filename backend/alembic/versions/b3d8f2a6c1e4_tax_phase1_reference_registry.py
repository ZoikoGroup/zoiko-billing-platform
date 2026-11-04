"""ZB-TAX-ARCH-001 Phase 1: Global Tax Reference Registry

Platform-level (non-tenant) reference tables, kept apart from tenant tax
data (§12.1):

  1. tax_jurisdictions, tax_authorities, tax_type_definitions, tax_components
  2. tax_source_artifacts (content-addressed, write-once) and
     tax_legal_source_revisions (evidence attachable once)
  3. tax_rate_staging -> tax_change_approvals -> tax_rate_versions
     (staging, maker-checker record, immutable published versions)

Postgres-only guarantees (SQLite dev/test relies on the app-layer checks):
  * btree_gist + EXCLUDE constraint: no overlapping ACTIVE, non-cumulative
    intervals for the same (component, tax_code, product_scope) — T02.
    DEFERRABLE INITIALLY DEFERRED so a correction supersedes and inserts in
    one transaction.
  * Triggers: tax_rate_versions only ever change status/superseded_at
    (ACTIVE -> SUPERSEDED) and are never deleted (T04); source revisions
    only gain their evidence fields once; artifacts are write-once.

No data is written here: reference seed data is loaded separately by
scripts/seed_tax_registry.py, entirely as PENDING_REVIEW staging rows.

Revision ID: b3d8f2a6c1e4
Revises: a7c4e1b9d3f0
Create Date: 2026-11-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import (
    AcquisitionMethod,
    ComponentCombination,
    EvidenceStatus,
    JurisdictionLevel,
    RateKind,
    RateVersionStatus,
    RedistributionPermission,
    SourceTier,
    StagedRateStatus,
    StagingOrigin,
    TaxableBaseRule,
    TaxOperatingMode,
)

revision: str = 'b3d8f2a6c1e4'
down_revision: Union[str, Sequence[str], None] = 'a7c4e1b9d3f0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
RATE = sa.Numeric(9, 6)
TS = sa.DateTime(timezone=True)

TABLES = (
    "tax_jurisdictions", "tax_authorities", "tax_type_definitions", "tax_components",
    "tax_source_artifacts", "tax_legal_source_revisions", "tax_rate_staging",
    "tax_change_approvals", "tax_rate_versions",
)


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(table: str) -> bool:
    return _inspector().has_table(table)


def _has_fk(table: str, name: str) -> bool:
    return _has_table(table) and name in {fk["name"] for fk in _inspector().get_foreign_keys(table)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _pg_has(sql: str, **params) -> bool:
    return op.get_bind().execute(sa.text(sql), params).scalar() is not None


def _users_fk():
    return sa.ForeignKey("users.id", ondelete="SET NULL")


def _create_tables() -> None:
    if not _has_table("tax_jurisdictions"):
        op.create_table(
            "tax_jurisdictions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(20), nullable=False, unique=True),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("level", CIE(JurisdictionLevel), nullable=False),
            sa.Column("country_code", sa.String(2), nullable=True),
            sa.Column("subdivision_code", sa.String(6), nullable=True),
            sa.Column("parent_id", sa.Integer(), sa.ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=True),
            sa.Column("official_area_id", sa.String(100), nullable=True),
            sa.Column("timezone", sa.String(64), nullable=True),
            sa.Column("boundary_ref", sa.String(255), nullable=True),
            sa.Column("boundary_version", sa.String(50), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_at", TS, server_default=sa.func.now()),
        )
        op.create_index("ix_tax_jurisdictions_id", "tax_jurisdictions", ["id"])
        op.create_index("ix_tax_jurisdictions_country_code", "tax_jurisdictions", ["country_code"])
        op.create_index("ix_tax_jurisdictions_parent_id", "tax_jurisdictions", ["parent_id"])

    if not _has_table("tax_authorities"):
        op.create_table(
            "tax_authorities",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("jurisdiction_id", sa.Integer(), sa.ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=True),
            sa.Column("website_url", sa.String(1000), nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now()),
        )
        op.create_index("ix_tax_authorities_id", "tax_authorities", ["id"])

    if not _has_table("tax_type_definitions"):
        op.create_table(
            "tax_type_definitions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(20), nullable=False, unique=True),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now()),
        )
        op.create_index("ix_tax_type_definitions_id", "tax_type_definitions", ["id"])

    if not _has_table("tax_components"):
        op.create_table(
            "tax_components",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("jurisdiction_id", sa.Integer(), sa.ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("tax_type_id", sa.Integer(), sa.ForeignKey("tax_type_definitions.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("authority_id", sa.Integer(), sa.ForeignKey("tax_authorities.id", ondelete="RESTRICT"), nullable=True),
            sa.Column("compounding_order", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("combination", CIE(ComponentCombination), nullable=False, server_default=ComponentCombination.ADDITIVE.name),
            sa.Column("is_cumulative", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("taxable_base_rule", CIE(TaxableBaseRule), nullable=False, server_default=TaxableBaseRule.NET_AMOUNT.name),
            sa.Column("reporting_code", sa.String(50), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_at", TS, server_default=sa.func.now()),
        )
        op.create_index("ix_tax_components_id", "tax_components", ["id"])
        op.create_index("ix_tax_components_jurisdiction_id", "tax_components", ["jurisdiction_id"])

    if not _has_table("tax_source_artifacts"):
        op.create_table(
            "tax_source_artifacts",
            sa.Column("sha256", sa.String(64), primary_key=True),
            sa.Column("content", sa.LargeBinary(), nullable=False),
            sa.Column("media_type", sa.String(150), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False),
            sa.Column("original_filename", sa.String(255), nullable=True),
            sa.Column("uploaded_by_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("uploaded_at", TS, nullable=False),
        )

    if not _has_table("tax_legal_source_revisions"):
        op.create_table(
            "tax_legal_source_revisions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("authority_id", sa.Integer(), sa.ForeignKey("tax_authorities.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("handoff_ref", sa.String(10), nullable=True),
            sa.Column("source_tier", CIE(SourceTier), nullable=False),
            sa.Column("acquisition_method", CIE(AcquisitionMethod), nullable=False),
            sa.Column("permanent_url", sa.String(1000), nullable=False),
            sa.Column("document_id", sa.String(255), nullable=True),
            sa.Column("document_version", sa.String(100), nullable=True),
            sa.Column("title", sa.String(500), nullable=False),
            sa.Column("citation", sa.Text(), nullable=False),
            sa.Column("language", sa.String(10), nullable=False),
            sa.Column("internal_notes", sa.Text(), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("evidence_status", CIE(EvidenceStatus), nullable=False, server_default=EvidenceStatus.NOT_CAPTURED.name),
            sa.Column("redistribution_permission", CIE(RedistributionPermission), nullable=False,
                      server_default=RedistributionPermission.UNKNOWN.name),
            sa.Column("retrieved_at", TS, nullable=True),
            sa.Column("sha256", sa.String(64), sa.ForeignKey("tax_source_artifacts.sha256", ondelete="RESTRICT"), nullable=True),
            sa.Column("artifact_storage_uri", sa.String(255), nullable=True),
            sa.Column("artifact_media_type", sa.String(150), nullable=True),
            sa.Column("artifact_size_bytes", sa.Integer(), nullable=True),
            sa.Column("reviewer_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("reviewed_at", TS, nullable=True),
        )
        op.create_index("ix_tax_legal_source_revisions_id", "tax_legal_source_revisions", ["id"])
        op.create_index("ix_tax_legal_source_revisions_authority_id", "tax_legal_source_revisions", ["authority_id"])

    if not _has_table("tax_rate_staging"):
        # FKs to tax_change_approvals / tax_rate_versions are added below
        # (circular references).
        op.create_table(
            "tax_rate_staging",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("origin", CIE(StagingOrigin), nullable=False),
            sa.Column("external_ref", sa.String(150), nullable=True),
            sa.Column("component_id", sa.Integer(), sa.ForeignKey("tax_components.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("tax_code", sa.String(50), nullable=False),
            sa.Column("product_scope", sa.String(100), nullable=False, server_default="GENERAL"),
            sa.Column("rate_kind", CIE(RateKind), nullable=False),
            sa.Column("rate_percent", RATE, nullable=True),
            sa.Column("valid_from", sa.Date(), nullable=True),
            sa.Column("valid_to", sa.Date(), nullable=True),
            sa.Column("announced_at", TS, nullable=True),
            sa.Column("observed_at", TS, nullable=False),
            sa.Column("source_revision_id", sa.Integer(),
                      sa.ForeignKey("tax_legal_source_revisions.id", ondelete="RESTRICT"), nullable=True),
            sa.Column("owner", sa.String(150), nullable=True),
            sa.Column("supersedes_rate_version_id", sa.Integer(), nullable=True),
            sa.Column("raw_payload", sa.JSON(), nullable=True),
            sa.Column("raw_payload_sha256", sa.String(64), nullable=True),
            sa.Column("reviewer_notes", sa.Text(), nullable=True),
            sa.Column("status", CIE(StagedRateStatus), nullable=False, server_default=StagedRateStatus.PENDING_REVIEW.name),
            sa.Column("validation_errors", sa.JSON(), nullable=True),
            sa.Column("validation_warnings", sa.JSON(), nullable=True),
            sa.Column("validated_at", TS, nullable=True),
            sa.Column("escalation_reason", sa.Text(), nullable=True),
            sa.Column("escalated_at", TS, nullable=True),
            sa.Column("adopted_by_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("adopted_at", TS, nullable=True),
            sa.Column("change_approval_id", sa.Integer(), nullable=True),
            sa.Column("published_rate_version_id", sa.Integer(), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("updated_at", TS, nullable=True),
            sa.UniqueConstraint("origin", "external_ref", name="uq_tax_rate_staging_origin_external_ref"),
        )
        op.create_index("ix_tax_rate_staging_id", "tax_rate_staging", ["id"])
        op.create_index("ix_tax_rate_staging_component_id", "tax_rate_staging", ["component_id"])
        op.create_index("ix_tax_rate_staging_status", "tax_rate_staging", ["status"])

    if not _has_table("tax_change_approvals"):
        op.create_table(
            "tax_change_approvals",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("approval_request_id", sa.Integer(),
                      sa.ForeignKey("approval_requests.id", ondelete="RESTRICT"), nullable=False, unique=True),
            sa.Column("staged_rate_id", sa.Integer(), sa.ForeignKey("tax_rate_staging.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("change_kind", sa.String(20), nullable=False),
            sa.Column("detector", CIE(StagingOrigin), nullable=False),
            sa.Column("source_comparison", sa.JSON(), nullable=True),
            sa.Column("maker_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("checker_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("publisher_user_id", sa.Integer(), _users_fk(), nullable=True),
            sa.Column("test_results", sa.JSON(), nullable=True),
            sa.Column("impacted_documents", sa.JSON(), nullable=True),
            sa.Column("submitted_at", TS, nullable=False),
            sa.Column("decided_at", TS, nullable=True),
            sa.Column("published_at", TS, nullable=True),
            sa.Column("remediation_link", sa.String(1000), nullable=True),
        )
        op.create_index("ix_tax_change_approvals_id", "tax_change_approvals", ["id"])
        op.create_index("ix_tax_change_approvals_staged_rate_id", "tax_change_approvals", ["staged_rate_id"])

    if not _has_table("tax_rate_versions"):
        op.create_table(
            "tax_rate_versions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("component_id", sa.Integer(), sa.ForeignKey("tax_components.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("jurisdiction_id", sa.Integer(), sa.ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("tax_code", sa.String(50), nullable=False),
            sa.Column("product_scope", sa.String(100), nullable=False),
            sa.Column("rate_kind", CIE(RateKind), nullable=False),
            sa.Column("rate_percent", RATE, nullable=False),
            sa.Column("valid_from", sa.Date(), nullable=False),
            sa.Column("valid_to", sa.Date(), nullable=True),
            sa.Column("announced_at", TS, nullable=True),
            sa.Column("observed_at", TS, nullable=False),
            sa.Column("approved_at", TS, nullable=False),
            sa.Column("published_at", TS, nullable=False),
            sa.Column("activated_at", TS, nullable=False),
            sa.Column("superseded_at", TS, nullable=True),
            sa.Column("status", CIE(RateVersionStatus), nullable=False, server_default=RateVersionStatus.ACTIVE.name),
            sa.Column("mode", CIE(TaxOperatingMode), nullable=False, server_default=TaxOperatingMode.REFERENCE_ONLY.name),
            sa.Column("is_cumulative", sa.Boolean(), nullable=False),
            sa.Column("source_revision_id", sa.Integer(),
                      sa.ForeignKey("tax_legal_source_revisions.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("evidence_status", CIE(EvidenceStatus), nullable=False),
            sa.Column("owner", sa.String(150), nullable=False),
            sa.Column("predecessor_id", sa.Integer(), sa.ForeignKey("tax_rate_versions.id", ondelete="RESTRICT"), nullable=True),
            sa.Column("staged_rate_id", sa.Integer(), sa.ForeignKey("tax_rate_staging.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("change_approval_id", sa.Integer(),
                      sa.ForeignKey("tax_change_approvals.id", ondelete="RESTRICT"), nullable=False),
        )
        op.create_index("ix_tax_rate_versions_id", "tax_rate_versions", ["id"])
        op.create_index("ix_tax_rate_versions_jurisdiction_id", "tax_rate_versions", ["jurisdiction_id"])
        op.create_index("ix_tax_rate_versions_key", "tax_rate_versions", ["component_id", "tax_code", "product_scope"])


STAGING_FKS = (
    ("fk_tax_rate_staging_supersedes_rate_version_id", "supersedes_rate_version_id", "tax_rate_versions"),
    ("fk_tax_rate_staging_change_approval_id", "change_approval_id", "tax_change_approvals"),
    ("fk_tax_rate_staging_published_rate_version_id", "published_rate_version_id", "tax_rate_versions"),
)


def _add_circular_fks() -> None:
    # SQLite cannot ALTER constraints; its dev/test schema comes from create_all.
    if not _is_postgres():
        return
    for name, column, target in STAGING_FKS:
        if not _has_fk("tax_rate_staging", name):
            op.create_foreign_key(name, "tax_rate_staging", target, [column], ["id"], ondelete="RESTRICT")


# Frozen copy of registry_models.PG_* DDL as of Phase 1.
_RATE_VERSION_GUARD_FN = """
CREATE OR REPLACE FUNCTION tax_rate_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_rate_versions % is immutable: deletes are not allowed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'superseded_at') THEN
    RAISE EXCEPTION 'tax_rate_versions % is immutable: publish a new version instead', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'SUPERSEDED' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'tax_rate_versions % is already superseded', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'tax_rate_versions %: superseding requires superseded_at', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'ACTIVE' AND NEW.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'tax_rate_versions %: an ACTIVE version cannot carry superseded_at', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_SOURCE_REVISION_GUARD_FN = """
CREATE OR REPLACE FUNCTION tax_legal_source_revisions_guard() RETURNS trigger AS $$
DECLARE
  attach_fields text[] := ARRAY['evidence_status', 'redistribution_permission', 'retrieved_at', 'sha256',
                                'artifact_storage_uri', 'artifact_media_type', 'artifact_size_bytes',
                                'reviewer_user_id', 'reviewed_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_legal_source_revisions % is immutable: deletes are not allowed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.evidence_status = 'CAPTURED' THEN
    RAISE EXCEPTION 'tax_legal_source_revisions % evidence is already attached; register a new revision', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - attach_fields) IS DISTINCT FROM (to_jsonb(OLD) - attach_fields) THEN
    RAISE EXCEPTION 'tax_legal_source_revisions % is immutable outside evidence attachment', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.evidence_status IS DISTINCT FROM 'CAPTURED' OR NEW.sha256 IS NULL OR NEW.retrieved_at IS NULL
     OR NEW.artifact_storage_uri IS NULL OR NEW.reviewer_user_id IS NULL OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'tax_legal_source_revisions %: evidence attachment must set every evidence field at once', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_ARTIFACT_GUARD_FN = """
CREATE OR REPLACE FUNCTION tax_source_artifacts_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax_source_artifacts are write-once' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql
"""

_TRIGGERS = (
    ("trg_tax_rate_versions_guard", "tax_rate_versions", "tax_rate_versions_guard"),
    ("trg_tax_legal_source_revisions_guard", "tax_legal_source_revisions", "tax_legal_source_revisions_guard"),
    ("trg_tax_source_artifacts_guard", "tax_source_artifacts", "tax_source_artifacts_guard"),
)


def _add_postgres_guards() -> None:
    if not _is_postgres():
        return
    # Fails loudly if the role cannot create the extension: the overlap
    # guarantee is not optional on Postgres.
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    if not _pg_has("SELECT 1 FROM pg_constraint WHERE conname = :n", n="ex_tax_rate_versions_active_overlap"):
        op.execute("""
            ALTER TABLE tax_rate_versions
              ADD CONSTRAINT ex_tax_rate_versions_active_overlap
              EXCLUDE USING gist (
                component_id WITH =,
                tax_code WITH =,
                product_scope WITH =,
                daterange(valid_from, valid_to, '[)') WITH &&
              ) WHERE (status = 'ACTIVE' AND NOT is_cumulative)
              DEFERRABLE INITIALLY DEFERRED
        """)
    op.execute(_RATE_VERSION_GUARD_FN)
    op.execute(_SOURCE_REVISION_GUARD_FN)
    op.execute(_ARTIFACT_GUARD_FN)
    for trigger, table, fn in _TRIGGERS:
        if not _pg_has("SELECT 1 FROM pg_trigger WHERE tgname = :n", n=trigger):
            op.execute(f"CREATE TRIGGER {trigger} BEFORE UPDATE OR DELETE ON {table} "
                       f"FOR EACH ROW EXECUTE FUNCTION {fn}()")


def upgrade() -> None:
    _create_tables()
    _add_circular_fks()
    _add_postgres_guards()


def downgrade() -> None:
    # Drops the registry outright. Every table here is platform reference
    # data with no tenant rows; export it first if it holds reviewed work.
    if _is_postgres():
        for name, _column, _target in STAGING_FKS:
            if _has_fk("tax_rate_staging", name):
                op.drop_constraint(name, "tax_rate_staging", type_="foreignkey")
    for table in reversed(TABLES):
        if _has_table(table):
            op.drop_table(table)
    if _is_postgres():
        for _trigger, _table, fn in _TRIGGERS:
            op.execute(f"DROP FUNCTION IF EXISTS {fn}()")
        # btree_gist is left installed: other objects may depend on it.
