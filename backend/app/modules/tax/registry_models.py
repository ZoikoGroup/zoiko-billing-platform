"""
app/modules/tax/registry_models.py
----------------------------------
Global Tax Reference Registry (ZB-TAX-ARCH-001 Phase 1, §06, §07, §10).

PLATFORM-LEVEL reference data. None of these tables carry an
organization_id or reference a tenant table: public authority-source records
are kept separate from tenant-private tax facts (§12.1). Tenant-private tax
objects live in models.py.

Time model (§07 bitemporal integrity rule):
  * valid time — ``valid_from`` / ``valid_to`` are DATEs in the
    jurisdiction's local legal calendar, end-exclusive (``[from, to)``);
    ``valid_to`` NULL means open-ended.
  * knowledge time — ``announced_at``, ``observed_at``, ``approved_at``,
    ``published_at``, ``activated_at`` and ``superseded_at`` are UTC
    timestamptz. A version was "known" during ``[published_at,
    superseded_at)``.

Immutability (T04): a published TaxRateVersion never changes except
ACTIVE -> SUPERSEDED (status + superseded_at). A TaxLegalSourceRevision may
only have its evidence-attach fields set once. Enforced three ways: the ORM
guard in registry_service.py (clear errors), Postgres triggers below (catch
query().update() and raw SQL), and the service never issuing such writes.

Overlap (T02): Postgres EXCLUDE constraint over (component, tax_code,
product_scope, daterange) for ACTIVE, non-cumulative versions, DEFERRABLE
INITIALLY DEFERRED so a correction can supersede and insert in one
transaction. SQLite (tests/dev) relies on the identical app-layer check.
"""
from sqlalchemy import (
    DDL,
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    event,
    text,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
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

RATE = Numeric(9, 6)


class TaxJurisdiction(Base):
    __tablename__ = "tax_jurisdictions"

    id               = Column(Integer, primary_key=True, index=True)
    code             = Column(String(20), nullable=False, unique=True)     # "GB", "CA-ON"
    name             = Column(String(200), nullable=False)
    level            = Column(CaseInsensitiveEnum(JurisdictionLevel), nullable=False)
    country_code     = Column(String(2), nullable=True, index=True)        # ISO 3166-1 alpha-2; NULL for supranational
    subdivision_code = Column(String(6), nullable=True)                    # ISO 3166-2 suffix
    parent_id        = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=True, index=True)
    official_area_id = Column(String(100), nullable=True)
    # IANA zone that fixes the local legal calendar for valid_from/valid_to.
    # NULL for multi-timezone jurisdictions: callers must then supply an
    # explicit as_of date rather than have one guessed (T03/T17).
    timezone         = Column(String(64), nullable=True)
    boundary_ref     = Column(String(255), nullable=True)
    boundary_version = Column(String(50), nullable=True)
    notes            = Column(Text, nullable=True)
    is_active        = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    parent           = relationship("TaxJurisdiction", remote_side=[id])


class TaxAuthority(Base):
    __tablename__ = "tax_authorities"

    id              = Column(Integer, primary_key=True, index=True)
    code            = Column(String(50), nullable=False, unique=True)      # "GB-HMRC"
    name            = Column(String(255), nullable=False)
    jurisdiction_id = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=True)
    website_url     = Column(String(1000), nullable=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())

    jurisdiction    = relationship("TaxJurisdiction")


class TaxTypeDefinition(Base):
    """Global tax-type vocabulary (VAT, GST, HST, PST, QST, ...).

    Named ...Definition because billing.models already exports a tenant-side
    ``TaxType`` enum."""
    __tablename__ = "tax_type_definitions"

    id          = Column(Integer, primary_key=True, index=True)
    code        = Column(String(20), nullable=False, unique=True)
    name        = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())


class TaxComponent(Base):
    __tablename__ = "tax_components"

    id                = Column(Integer, primary_key=True, index=True)
    code              = Column(String(50), nullable=False, unique=True)    # "CA-ON-HST"
    name              = Column(String(255), nullable=False)
    jurisdiction_id   = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=False, index=True)
    tax_type_id       = Column(Integer, ForeignKey("tax_type_definitions.id", ondelete="RESTRICT"), nullable=False)
    # NULL until the levying authority is recorded from a cited source;
    # never defaulted to a guess.
    authority_id      = Column(Integer, ForeignKey("tax_authorities.id", ondelete="RESTRICT"), nullable=True)
    compounding_order = Column(Integer, nullable=False, default=1, server_default="1")
    combination       = Column(CaseInsensitiveEnum(ComponentCombination), nullable=False,
                               default=ComponentCombination.ADDITIVE, server_default=ComponentCombination.ADDITIVE.name)
    # Legally cumulative components may hold overlapping ACTIVE versions for
    # the same key (the only T02 exception).
    is_cumulative     = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    taxable_base_rule = Column(CaseInsensitiveEnum(TaxableBaseRule), nullable=False,
                               default=TaxableBaseRule.NET_AMOUNT, server_default=TaxableBaseRule.NET_AMOUNT.name)
    reporting_code    = Column(String(50), nullable=True)
    notes             = Column(Text, nullable=True)
    is_active         = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at        = Column(DateTime(timezone=True), server_default=func.now())

    jurisdiction      = relationship("TaxJurisdiction")
    tax_type          = relationship("TaxTypeDefinition")
    authority         = relationship("TaxAuthority")


class TaxSourceArtifact(Base):
    """Content-addressed, write-once store for captured source artifacts
    (PDF, HTML snapshot, dataset file). The SHA-256 is always computed by
    the server from the uploaded bytes, never accepted from a client."""
    __tablename__ = "tax_source_artifacts"

    sha256              = Column(String(64), primary_key=True)
    content             = Column(LargeBinary, nullable=False)
    media_type          = Column(String(150), nullable=False)
    size_bytes          = Column(Integer, nullable=False)
    original_filename   = Column(String(255), nullable=True)
    uploaded_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    uploaded_at         = Column(DateTime(timezone=True), nullable=False)


class TaxLegalSourceRevision(Base):
    __tablename__ = "tax_legal_source_revisions"

    id                        = Column(Integer, primary_key=True, index=True)
    authority_id              = Column(Integer, ForeignKey("tax_authorities.id", ondelete="RESTRICT"), nullable=False, index=True)
    handoff_ref               = Column(String(10), nullable=True)          # ZB-TAX-ARCH-001 §17 id, e.g. "S11"
    source_tier               = Column(CaseInsensitiveEnum(SourceTier), nullable=False)
    acquisition_method        = Column(CaseInsensitiveEnum(AcquisitionMethod), nullable=False)
    permanent_url             = Column(String(1000), nullable=False)
    document_id               = Column(String(255), nullable=True)
    document_version          = Column(String(100), nullable=True)
    title                     = Column(String(500), nullable=False)
    citation                  = Column(Text, nullable=False)
    language                  = Column(String(10), nullable=False)
    internal_notes            = Column(Text, nullable=True)
    created_by_user_id        = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at                = Column(DateTime(timezone=True), nullable=False)

    # ── Evidence-attach fields: set together, once (see EVIDENCE_ATTACH_FIELDS)
    evidence_status           = Column(CaseInsensitiveEnum(EvidenceStatus), nullable=False,
                                       default=EvidenceStatus.NOT_CAPTURED, server_default=EvidenceStatus.NOT_CAPTURED.name)
    redistribution_permission = Column(CaseInsensitiveEnum(RedistributionPermission), nullable=False,
                                       default=RedistributionPermission.UNKNOWN, server_default=RedistributionPermission.UNKNOWN.name)
    retrieved_at              = Column(DateTime(timezone=True), nullable=True)
    sha256                    = Column(String(64), ForeignKey("tax_source_artifacts.sha256", ondelete="RESTRICT"), nullable=True)
    artifact_storage_uri      = Column(String(255), nullable=True)
    artifact_media_type       = Column(String(150), nullable=True)
    artifact_size_bytes       = Column(Integer, nullable=True)
    reviewer_user_id          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reviewed_at               = Column(DateTime(timezone=True), nullable=True)

    authority                 = relationship("TaxAuthority")
    reviewer                  = relationship("User", foreign_keys=[reviewer_user_id])


#: Columns the one-shot evidence attachment may move from unset to set.
EVIDENCE_ATTACH_FIELDS = (
    "evidence_status", "redistribution_permission", "retrieved_at", "sha256",
    "artifact_storage_uri", "artifact_media_type", "artifact_size_bytes",
    "reviewer_user_id", "reviewed_at",
)


class TaxChangeApproval(Base):
    """Tax-side record of one maker-checker change (§07 ChangeApproval).

    The two-person decision itself is the shared ``approval_requests`` row
    (request_type="tax_rate_publish"), so the self-approval guard lives in
    one place (ApprovalService)."""
    __tablename__ = "tax_change_approvals"

    id                  = Column(Integer, primary_key=True, index=True)
    approval_request_id = Column(Integer, ForeignKey("approval_requests.id", ondelete="RESTRICT"), nullable=False, unique=True)
    staged_rate_id      = Column(Integer, ForeignKey("tax_rate_staging.id", ondelete="RESTRICT"), nullable=False, index=True)
    change_kind         = Column(String(20), nullable=False)
    detector            = Column(CaseInsensitiveEnum(StagingOrigin), nullable=False)
    source_comparison   = Column(JSON, nullable=True)
    maker_user_id       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    checker_user_id     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    publisher_user_id   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    test_results        = Column(JSON, nullable=True)
    impacted_documents  = Column(JSON, nullable=True)
    submitted_at        = Column(DateTime(timezone=True), nullable=False)
    decided_at          = Column(DateTime(timezone=True), nullable=True)
    published_at        = Column(DateTime(timezone=True), nullable=True)
    remediation_link    = Column(String(1000), nullable=True)

    approval_request    = relationship("ApprovalRequest")


class TaxRateStaging(Base):
    """Ingestion staging (§10.1 steps 1-5). Every proposal — seed, manual,
    feed or AI — lands here; nothing writes tax_rate_versions directly."""
    __tablename__ = "tax_rate_staging"

    id                         = Column(Integer, primary_key=True, index=True)
    origin                     = Column(CaseInsensitiveEnum(StagingOrigin), nullable=False)
    external_ref               = Column(String(150), nullable=True)        # idempotency key for seeds/feeds
    component_id               = Column(Integer, ForeignKey("tax_components.id", ondelete="RESTRICT"), nullable=False, index=True)
    tax_code                   = Column(String(50), nullable=False)
    product_scope              = Column(String(100), nullable=False, default="GENERAL", server_default="GENERAL")
    rate_kind                  = Column(CaseInsensitiveEnum(RateKind), nullable=False)
    # Proposals may be incomplete; validation refuses them until complete.
    rate_percent               = Column(RATE, nullable=True)
    valid_from                 = Column(Date, nullable=True)
    valid_to                   = Column(Date, nullable=True)
    announced_at               = Column(DateTime(timezone=True), nullable=True)
    observed_at                = Column(DateTime(timezone=True), nullable=False)
    source_revision_id         = Column(Integer, ForeignKey("tax_legal_source_revisions.id", ondelete="RESTRICT"), nullable=True)
    owner                      = Column(String(150), nullable=True)
    supersedes_rate_version_id = Column(Integer, ForeignKey("tax_rate_versions.id", ondelete="RESTRICT", use_alter=True,
                                                            name="fk_tax_rate_staging_supersedes_rate_version_id"), nullable=True)
    raw_payload                = Column(JSON, nullable=True)
    raw_payload_sha256         = Column(String(64), nullable=True)
    reviewer_notes             = Column(Text, nullable=True)

    status                     = Column(CaseInsensitiveEnum(StagedRateStatus), nullable=False, index=True,
                                        default=StagedRateStatus.PENDING_REVIEW, server_default=StagedRateStatus.PENDING_REVIEW.name)
    validation_errors          = Column(JSON, nullable=True)
    validation_warnings        = Column(JSON, nullable=True)
    validated_at               = Column(DateTime(timezone=True), nullable=True)
    escalation_reason          = Column(Text, nullable=True)
    escalated_at               = Column(DateTime(timezone=True), nullable=True)

    # AI proposals must be adopted by a human maker before approval.
    adopted_by_user_id         = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    adopted_at                 = Column(DateTime(timezone=True), nullable=True)

    change_approval_id         = Column(Integer, ForeignKey("tax_change_approvals.id", ondelete="RESTRICT", use_alter=True,
                                                            name="fk_tax_rate_staging_change_approval_id"), nullable=True)
    published_rate_version_id  = Column(Integer, ForeignKey("tax_rate_versions.id", ondelete="RESTRICT", use_alter=True,
                                                            name="fk_tax_rate_staging_published_rate_version_id"), nullable=True)
    created_by_user_id         = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at                 = Column(DateTime(timezone=True), nullable=False)
    updated_at                 = Column(DateTime(timezone=True), nullable=True)

    component                  = relationship("TaxComponent")
    source_revision            = relationship("TaxLegalSourceRevision")
    change_approval            = relationship("TaxChangeApproval", foreign_keys=[change_approval_id])

    __table_args__ = (
        UniqueConstraint("origin", "external_ref", name="uq_tax_rate_staging_origin_external_ref"),
    )


class TaxRateVersion(Base):
    """A published, immutable rate fact (§07 RateVersion)."""
    __tablename__ = "tax_rate_versions"

    id                 = Column(Integer, primary_key=True, index=True)
    component_id       = Column(Integer, ForeignKey("tax_components.id", ondelete="RESTRICT"), nullable=False)
    jurisdiction_id    = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=False, index=True)
    tax_code           = Column(String(50), nullable=False)
    product_scope      = Column(String(100), nullable=False)
    rate_kind          = Column(CaseInsensitiveEnum(RateKind), nullable=False)
    rate_percent       = Column(RATE, nullable=False)
    valid_from         = Column(Date, nullable=False)
    valid_to           = Column(Date, nullable=True)
    announced_at       = Column(DateTime(timezone=True), nullable=True)
    observed_at        = Column(DateTime(timezone=True), nullable=False)
    approved_at        = Column(DateTime(timezone=True), nullable=False)
    published_at       = Column(DateTime(timezone=True), nullable=False)
    activated_at       = Column(DateTime(timezone=True), nullable=False)
    superseded_at      = Column(DateTime(timezone=True), nullable=True)
    status             = Column(CaseInsensitiveEnum(RateVersionStatus), nullable=False,
                                default=RateVersionStatus.ACTIVE, server_default=RateVersionStatus.ACTIVE.name)
    # Phase 1 publishes reference facts only; production calculation needs
    # a separate per-entity activation record (Phase 2, §05).
    mode               = Column(CaseInsensitiveEnum(TaxOperatingMode), nullable=False,
                                default=TaxOperatingMode.REFERENCE_ONLY, server_default=TaxOperatingMode.REFERENCE_ONLY.name)
    is_cumulative      = Column(Boolean, nullable=False)                  # copied from the component for the EXCLUDE predicate
    source_revision_id = Column(Integer, ForeignKey("tax_legal_source_revisions.id", ondelete="RESTRICT"), nullable=False)
    evidence_status    = Column(CaseInsensitiveEnum(EvidenceStatus), nullable=False)
    owner              = Column(String(150), nullable=False)
    predecessor_id     = Column(Integer, ForeignKey("tax_rate_versions.id", ondelete="RESTRICT"), nullable=True)
    staged_rate_id     = Column(Integer, ForeignKey("tax_rate_staging.id", ondelete="RESTRICT"), nullable=False)
    change_approval_id = Column(Integer, ForeignKey("tax_change_approvals.id", ondelete="RESTRICT"), nullable=False)

    component          = relationship("TaxComponent")
    jurisdiction       = relationship("TaxJurisdiction")
    source_revision    = relationship("TaxLegalSourceRevision")

    __table_args__ = (
        Index("ix_tax_rate_versions_key", "component_id", "tax_code", "product_scope"),
    )


#: Platform reference tables (§12.1): never tenant data. The tenant erasure
#: purge must not walk into them (their user FKs are SET NULL).
REGISTRY_TABLES = (
    "tax_jurisdictions", "tax_authorities", "tax_type_definitions", "tax_components", "tax_source_artifacts",
    "tax_legal_source_revisions", "tax_change_approvals", "tax_rate_staging", "tax_rate_versions",
)

#: The only TaxRateVersion columns that may ever change after insert.
RATE_VERSION_MUTABLE_FIELDS = ("status", "superseded_at")


# ── Postgres-only DDL ────────────────────────────────────────────────────
# Attached to metadata so create_all on Postgres gets the same guarantees
# as the Alembic migration (b3d8f2a6c1e4, which carries a frozen copy).

PG_RATE_VERSION_GUARDS = [
    "CREATE EXTENSION IF NOT EXISTS btree_gist",
    """
    ALTER TABLE tax_rate_versions
      ADD CONSTRAINT ex_tax_rate_versions_active_overlap
      EXCLUDE USING gist (
        component_id WITH =,
        tax_code WITH =,
        product_scope WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      ) WHERE (status = 'ACTIVE' AND NOT is_cumulative)
      DEFERRABLE INITIALLY DEFERRED
    """,
    """
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
    """,
    """
    CREATE TRIGGER trg_tax_rate_versions_guard
      BEFORE UPDATE OR DELETE ON tax_rate_versions
      FOR EACH ROW EXECUTE FUNCTION tax_rate_versions_guard()
    """,
]

PG_SOURCE_REVISION_GUARDS = [
    """
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
    """,
    """
    CREATE TRIGGER trg_tax_legal_source_revisions_guard
      BEFORE UPDATE OR DELETE ON tax_legal_source_revisions
      FOR EACH ROW EXECUTE FUNCTION tax_legal_source_revisions_guard()
    """,
]

PG_ARTIFACT_GUARDS = [
    """
    CREATE OR REPLACE FUNCTION tax_source_artifacts_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'tax_source_artifacts are write-once' USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE TRIGGER trg_tax_source_artifacts_guard
      BEFORE UPDATE OR DELETE ON tax_source_artifacts
      FOR EACH ROW EXECUTE FUNCTION tax_source_artifacts_guard()
    """,
]


def _attach_pg_ddl(table, statements):
    for stmt in statements:
        event.listen(table, "after_create", DDL(stmt).execute_if(dialect="postgresql"))


_attach_pg_ddl(TaxRateVersion.__table__, PG_RATE_VERSION_GUARDS)
_attach_pg_ddl(TaxLegalSourceRevision.__table__, PG_SOURCE_REVISION_GUARDS)
_attach_pg_ddl(TaxSourceArtifact.__table__, PG_ARTIFACT_GUARDS)
