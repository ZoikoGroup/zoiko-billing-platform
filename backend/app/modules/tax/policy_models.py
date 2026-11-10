"""
app/modules/tax/policy_models.py
--------------------------------
Platform-level (non-tenant) tax policy (ZB-TAX-ARCH-001 Phase 2, §05, §07,
§13.2): market availability and the product tax-code taxonomy.

Both are versioned and decided by maker-checker (TAX_REVIEWER submits,
TAX_PUBLISHER approves and publishes with MFA step-up), reusing the shared
``approval_requests`` engine. A version's content is frozen once submitted;
publishing supersedes the previous ACTIVE version and never edits it.
Postgres triggers below enforce that for raw SQL as well; the ORM guard in
policy_service.py gives clear errors.

No organization_id here (§12.1): tenant activation records live in models.py.
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
    String,
    Text,
    UniqueConstraint,
    event,
    text,
)
from sqlalchemy.orm import declared_attr, relationship

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.tax.enums import PlatformVersionStatus, SupplyCategory, TaxOperatingMode, TransactionClass


class _PolicyApprovalMixin:
    """Maker-checker bookkeeping shared by every platform policy version."""

    validation_errors = Column(JSON, nullable=True)
    created_at        = Column(DateTime(timezone=True), nullable=False)
    submitted_at      = Column(DateTime(timezone=True), nullable=True)
    approved_at       = Column(DateTime(timezone=True), nullable=True)
    published_at      = Column(DateTime(timezone=True), nullable=True)
    superseded_at     = Column(DateTime(timezone=True), nullable=True)
    rejection_reason  = Column(Text, nullable=True)

    @declared_attr
    def approval_request_id(cls):
        return Column(Integer, ForeignKey("approval_requests.id", ondelete="RESTRICT"), nullable=True)

    @declared_attr
    def created_by_user_id(cls):
        return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    @declared_attr
    def maker_user_id(cls):
        return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    @declared_attr
    def checker_user_id(cls):
        return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    @declared_attr
    def publisher_user_id(cls):
        return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class _ScheduleMixin:
    """Phase 8 PR 2: a publish can be scheduled. activate_at is UTC, entered
    as jurisdiction-local legal time (kept as entered, with its zone)."""

    activate_at       = Column(DateTime(timezone=True), nullable=True, index=True)
    activate_at_local = Column(String(40), nullable=True)
    activate_tz       = Column(String(64), nullable=True)
    activation_error  = Column(Text, nullable=True)

    @declared_attr
    def scheduled_by_user_id(cls):
        return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class TaxMarketAvailabilityVersion(_ScheduleMixin, _PolicyApprovalMixin, Base):
    """Jurisdiction × tax type × transaction class -> the mode the platform
    supports there, with evidence for each §13.2 launch gate."""
    __tablename__ = "tax_market_availability_versions"

    id                      = Column(Integer, primary_key=True, index=True)
    jurisdiction_id         = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=False)
    tax_type_id             = Column(Integer, ForeignKey("tax_type_definitions.id", ondelete="RESTRICT"), nullable=False)
    transaction_class       = Column(CaseInsensitiveEnum(TransactionClass), nullable=False)
    mode                    = Column(CaseInsensitiveEnum(TaxOperatingMode), nullable=False)
    # Default false and only ever set through this approval path: a missing
    # record or a false flag both mean TENANT_CONFIG_APPROVED is NOT allowed.
    tenant_config_permitted = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    # {MarketGate.name: {"status": GateStatus.name, "evidence_ref": str, "notes": str}}
    gates                   = Column(JSON, nullable=False)
    notes                   = Column(Text, nullable=True)
    status                  = Column(CaseInsensitiveEnum(PlatformVersionStatus), nullable=False, index=True,
                                     default=PlatformVersionStatus.PENDING_REVIEW,
                                     server_default=PlatformVersionStatus.PENDING_REVIEW.name)
    predecessor_id          = Column(Integer, ForeignKey("tax_market_availability_versions.id", ondelete="RESTRICT"), nullable=True)

    jurisdiction            = relationship("TaxJurisdiction")
    tax_type                = relationship("TaxTypeDefinition")

    __table_args__ = (
        Index("ix_tax_market_availability_key", "jurisdiction_id", "tax_type_id", "transaction_class"),
        Index("uq_tax_market_availability_one_active", "jurisdiction_id", "tax_type_id", "transaction_class",
              unique=True, sqlite_where=text("status = 'ACTIVE'"), postgresql_where=text("status = 'ACTIVE'")),
    )


class TaxCodeSetVersion(_PolicyApprovalMixin, Base):
    """A published version of the platform product tax-code taxonomy."""
    __tablename__ = "tax_code_set_versions"

    id             = Column(Integer, primary_key=True, index=True)
    code           = Column(String(30), nullable=False)       # taxonomy name, e.g. "ZB-TC"
    version        = Column(Integer, nullable=False)
    notes          = Column(Text, nullable=True)
    status         = Column(CaseInsensitiveEnum(PlatformVersionStatus), nullable=False, index=True,
                            default=PlatformVersionStatus.PENDING_REVIEW,
                            server_default=PlatformVersionStatus.PENDING_REVIEW.name)
    predecessor_id = Column(Integer, ForeignKey("tax_code_set_versions.id", ondelete="RESTRICT"), nullable=True)

    codes          = relationship("TaxCode", back_populates="code_set_version", order_by="TaxCode.code")

    __table_args__ = (
        UniqueConstraint("code", "version", name="uq_tax_code_set_versions_code_version"),
        Index("uq_tax_code_set_one_active", "code", unique=True,
              sqlite_where=text("status = 'ACTIVE'"), postgresql_where=text("status = 'ACTIVE'")),
    )


class TaxCode(Base):
    __tablename__ = "tax_codes"

    id                     = Column(Integer, primary_key=True, index=True)
    code_set_version_id    = Column(Integer, ForeignKey("tax_code_set_versions.id", ondelete="RESTRICT"), nullable=False, index=True)
    code                   = Column(String(50), nullable=False)
    name                   = Column(String(255), nullable=False)
    description            = Column(Text, nullable=True)
    parent_code            = Column(String(50), nullable=True)
    supply_category        = Column(CaseInsensitiveEnum(SupplyCategory), nullable=False)
    # Links to tax_rate_versions.product_scope in the reference registry.
    registry_product_scope = Column(String(100), nullable=False, default="GENERAL", server_default="GENERAL")

    code_set_version       = relationship("TaxCodeSetVersion", back_populates="codes")

    __table_args__ = (UniqueConstraint("code_set_version_id", "code", name="uq_tax_codes_set_code"),)


class TaxRulePackVersion(_ScheduleMixin, _PolicyApprovalMixin, Base):
    """Registry of native rule-pack versions (Phase 3a: table only; packs and
    their approval routes arrive in 3b). A pack's logic is code registered in
    app.modules.tax.engines.RULE_PACKS; this row records which code version
    is approved for which markets. The engine resolver uses a pack only when
    BOTH exist and the row is ACTIVE. Test-only packs never appear here."""
    __tablename__ = "tax_rule_pack_versions"

    id                 = Column(Integer, primary_key=True, index=True)
    code               = Column(String(60), nullable=False)
    version            = Column(String(30), nullable=False)
    markets            = Column(JSON, nullable=False)       # [{"jurisdiction_code": .., "tax_type": ..}]
    rounding_rule      = Column(String(20), nullable=False)
    rounding_mode      = Column(String(20), nullable=False)
    # Phase 3b declarations, copied from the pack's code at registration and
    # frozen with the rest of the content once submitted.
    required_facts     = Column(JSON, nullable=True)       # ["BUYER_ADDRESS_UNRESOLVED", ...]
    coverage           = Column(JSON, nullable=True)       # what the pack decides; all else NOT_DETERMINED
    source_dependencies = Column(JSON, nullable=True)      # [{"source_id", "source_code", "approved"}]
    golden_test_report = Column(JSON, nullable=True)
    notes              = Column(Text, nullable=True)
    # Phase 8 PR 1: SHA-256 of the pack's code and declarations
    # (rule_pack_integrity.py), recorded at registration and frozen.
    code_hash          = Column(String(64), nullable=True)
    # Phase 8 PR 2: effective-dated packs, like rates. DATEs in the
    # jurisdiction's legal calendar, end-exclusive; the quote's tax date picks
    # the version. valid_from NULL = from the start; valid_to is set once, on
    # the predecessor, when its successor activates.
    valid_from         = Column(Date, nullable=True)
    valid_to           = Column(Date, nullable=True)
    status             = Column(CaseInsensitiveEnum(PlatformVersionStatus), nullable=False, index=True,
                                default=PlatformVersionStatus.PENDING_REVIEW,
                                server_default=PlatformVersionStatus.PENDING_REVIEW.name)
    predecessor_id     = Column(Integer, ForeignKey("tax_rule_pack_versions.id", ondelete="RESTRICT"), nullable=True)

    # Several versions of one pack may be ACTIVE, for date ranges that don't
    # overlap (Phase 8 PR 2): enforced in the service and, on Postgres, by
    # ex_tax_rule_pack_active_ranges.
    __table_args__ = (
        UniqueConstraint("code", "version", name="uq_tax_rule_pack_versions_code_version"),
    )


class TaxActivationCancellation(Base):
    """A two-person request to cancel a scheduled activation (Phase 8 PR 2).
    Platform data only; frozen once decided."""
    __tablename__ = "tax_activation_cancellations"

    id              = Column(Integer, primary_key=True, index=True)
    version_kind    = Column(String(30), nullable=False)          # rule_pack | market_availability
    version_id      = Column(Integer, nullable=False, index=True)
    reason          = Column(Text, nullable=False)
    status          = Column(String(20), nullable=False, default="PROPOSED", index=True)
    proposed_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_at      = Column(DateTime(timezone=True), nullable=True)
    decision_reason = Column(Text, nullable=True)
    created_at      = Column(DateTime(timezone=True), nullable=False)


#: Platform policy tables (§12.1): never tenant data, never purged with a tenant.
POLICY_TABLES = ("tax_market_availability_versions", "tax_code_set_versions", "tax_codes", "tax_rule_pack_versions",
                 "tax_activation_cancellations")

# Content columns frozen once a version leaves the editable states.
AVAILABILITY_CONTENT_FIELDS = ("jurisdiction_id", "tax_type_id", "transaction_class", "mode",
                               "tenant_config_permitted", "gates", "notes", "created_by_user_id", "created_at")
CODE_SET_CONTENT_FIELDS = ("code", "version", "notes", "created_by_user_id", "created_at")
RULE_PACK_CONTENT_FIELDS = ("code", "version", "markets", "rounding_rule", "rounding_mode", "required_facts",
                            "coverage", "source_dependencies", "golden_test_report", "notes", "created_by_user_id",
                            "created_at", "code_hash", "valid_from")
#: Set exactly once on an ACTIVE row (the predecessor's end date).
RULE_PACK_SET_ONCE_FIELDS = ("valid_to",)


# ── Postgres-only DDL (frozen copy in migration c5e2d8a4b7f1) ────────────

def _version_guard_sql(table: str, content_fields: tuple, set_once: tuple = ()) -> list:
    content = ", ".join(f"'{f}', NEW.{f}" for f in content_fields)
    old_content = ", ".join(f"'{f}', OLD.{f}" for f in content_fields)
    fn = f"{table}_guard"
    minus = "".join(f" - '{f}'" for f in ("status", "superseded_at") + set_once)
    once = "".join(f"\n               OR (OLD.{f} IS NOT NULL AND NEW.{f} IS DISTINCT FROM OLD.{f})" for f in set_once)
    return [
        f"""
        CREATE OR REPLACE FUNCTION {fn}() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status NOT IN ('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED') THEN
              RAISE EXCEPTION '{table} % is %: only unsubmitted drafts can be deleted', OLD.id, OLD.status
                USING ERRCODE = 'integrity_constraint_violation';
            END IF;
            RETURN OLD;
          END IF;
          IF OLD.status NOT IN ('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED')
             AND jsonb_build_object({content}) IS DISTINCT FROM jsonb_build_object({old_content}) THEN
            RAISE EXCEPTION '{table} % content is frozen once submitted; create a new version', OLD.id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF OLD.status = 'SUPERSEDED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
            RAISE EXCEPTION '{table} % is superseded and immutable', OLD.id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF OLD.status = 'ACTIVE' AND (
               (to_jsonb(NEW){minus}) IS DISTINCT FROM (to_jsonb(OLD){minus}){once}
               OR NEW.status NOT IN ('ACTIVE', 'SUPERSEDED')
               OR (NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NULL)) THEN
            RAISE EXCEPTION '{table} % is active: it can only be superseded', OLD.id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """,
        f"""
        CREATE TRIGGER trg_{fn}
          BEFORE UPDATE OR DELETE ON {table}
          FOR EACH ROW EXECUTE FUNCTION {fn}()
        """,
    ]


PG_AVAILABILITY_GUARDS = _version_guard_sql("tax_market_availability_versions", AVAILABILITY_CONTENT_FIELDS)
PG_CODE_SET_GUARDS = _version_guard_sql("tax_code_set_versions", CODE_SET_CONTENT_FIELDS)
PG_RULE_PACK_GUARDS = _version_guard_sql("tax_rule_pack_versions", RULE_PACK_CONTENT_FIELDS, RULE_PACK_SET_ONCE_FIELDS) + [
    "CREATE EXTENSION IF NOT EXISTS btree_gist",
    """
    ALTER TABLE tax_rule_pack_versions
      ADD CONSTRAINT ex_tax_rule_pack_active_ranges
      EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
      WHERE (status = 'ACTIVE') DEFERRABLE INITIALLY DEFERRED
    """,
]
PG_ACTIVATION_CANCELLATION_GUARDS = [
    """
    CREATE OR REPLACE FUNCTION tax_activation_cancellations_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'tax_activation_cancellations % cannot be deleted', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status <> 'PROPOSED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'tax_activation_cancellations % is decided and final', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason') THEN
        RAISE EXCEPTION 'tax_activation_cancellations % request content is frozen', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE TRIGGER trg_tax_activation_cancellations_guard
      BEFORE UPDATE OR DELETE ON tax_activation_cancellations
      FOR EACH ROW EXECUTE FUNCTION tax_activation_cancellations_guard()
    """,
]
PG_TAX_CODE_GUARDS = [
    """
    CREATE OR REPLACE FUNCTION tax_codes_guard() RETURNS trigger AS $$
    DECLARE
      set_id integer;
      set_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        set_id := OLD.code_set_version_id;
      ELSE
        set_id := NEW.code_set_version_id;
      END IF;
      SELECT status INTO set_status FROM tax_code_set_versions WHERE id = set_id;
      IF set_status NOT IN ('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED') THEN
        RAISE EXCEPTION 'tax codes of a submitted code-set version are frozen'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.code_set_version_id IS DISTINCT FROM OLD.code_set_version_id THEN
        RAISE EXCEPTION 'a tax code cannot move between code-set versions'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE TRIGGER trg_tax_codes_guard
      BEFORE INSERT OR UPDATE OR DELETE ON tax_codes
      FOR EACH ROW EXECUTE FUNCTION tax_codes_guard()
    """,
]


def _attach(table, statements):
    for stmt in statements:
        event.listen(table, "after_create", DDL(stmt).execute_if(dialect="postgresql"))


_attach(TaxMarketAvailabilityVersion.__table__, PG_AVAILABILITY_GUARDS)
_attach(TaxCodeSetVersion.__table__, PG_CODE_SET_GUARDS)
_attach(TaxCode.__table__, PG_TAX_CODE_GUARDS)
_attach(TaxRulePackVersion.__table__, PG_RULE_PACK_GUARDS)
_attach(TaxActivationCancellation.__table__, PG_ACTIVATION_CANCELLATION_GUARDS)
