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


class TaxMarketAvailabilityVersion(_PolicyApprovalMixin, Base):
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


#: Platform policy tables (§12.1): never tenant data, never purged with a tenant.
POLICY_TABLES = ("tax_market_availability_versions", "tax_code_set_versions", "tax_codes")

# Content columns frozen once a version leaves the editable states.
AVAILABILITY_CONTENT_FIELDS = ("jurisdiction_id", "tax_type_id", "transaction_class", "mode",
                               "tenant_config_permitted", "gates", "notes", "created_by_user_id", "created_at")
CODE_SET_CONTENT_FIELDS = ("code", "version", "notes", "created_by_user_id", "created_at")


# ── Postgres-only DDL (frozen copy in migration c5e2d8a4b7f1) ────────────

def _version_guard_sql(table: str, content_fields: tuple) -> list:
    content = ", ".join(f"'{f}', NEW.{f}" for f in content_fields)
    old_content = ", ".join(f"'{f}', OLD.{f}" for f in content_fields)
    fn = f"{table}_guard"
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
               (to_jsonb(NEW) - 'status' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'superseded_at')
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
