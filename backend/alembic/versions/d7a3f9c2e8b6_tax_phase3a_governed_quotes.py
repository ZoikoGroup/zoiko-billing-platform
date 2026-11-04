"""ZB-TAX-ARCH-001 Phase 3a: governed tax quotes, snapshots and credits

Tenant-private (organization_id on every row; retained like Phase 2 records):
  1. tax_quotes, tax_quote_lines, tax_quote_components — governed quotes; a
     COMMITTED quote is the invoice's immutable tax snapshot. Amounts stored
     unrounded at NUMERIC(18,6) and rounded at NUMERIC(14,2).
  2. credit_note_tax_lines — governed credit notes reverse snapshot components
     (signed amounts).
  3. invoices.tax_quote_id — the committed quote (FK RESTRICT).

Platform (non-tenant):
  4. tax_rule_pack_versions — registry of approved native rule-pack versions
     (no rows in 3a; packs arrive in 3b).

Postgres-only guards (frozen copies): tenant guard triggers on the four
tenant tables (content frozen from insert, DELETE only with the
zoiko.tax_erasure flag), a status guard (COMMITTED -> VOIDED only, VOIDED
final), and the platform version guard on tax_rule_pack_versions.

No data is written. Downgrade drops everything above.

Revision ID: d7a3f9c2e8b6
Revises: c5e2d8a4b7f1
Create Date: 2026-11-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import (
    EngineKind,
    PlatformVersionStatus,
    RemoteCommitState,
    RoundingRule,
    SupplyCategory,
    TaxOutcome,
    TaxQuoteStatus,
    TransactionClass,
)

revision: str = 'd7a3f9c2e8b6'
down_revision: Union[str, Sequence[str], None] = 'c5e2d8a4b7f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
TS = sa.DateTime(timezone=True)
PRECISE = sa.Numeric(18, 6)
MONEY = sa.Numeric(14, 2)
RATE = sa.Numeric(9, 6)

TENANT_TABLES = ("tax_quotes", "tax_quote_lines", "tax_quote_components", "credit_note_tax_lines")


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(table: str) -> bool:
    return _inspector().has_table(table)


def _has_column(table: str, column: str) -> bool:
    return _has_table(table) and column in {c["name"] for c in _inspector().get_columns(table)}


def _has_index(table: str, index: str) -> bool:
    return _has_table(table) and index in {i["name"] for i in _inspector().get_indexes(table)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _pg_has(sql: str, **params) -> bool:
    return op.get_bind().execute(sa.text(sql), params).scalar() is not None


def _fk(target, ondelete="RESTRICT"):
    return sa.ForeignKey(target, ondelete=ondelete)


def _org():
    return sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False)


def _by(name):
    return sa.Column(name, sa.Integer(), _fk("users.id", "SET NULL"), nullable=True)


def _create_tables() -> None:
    if not _has_table("tax_rule_pack_versions"):
        op.create_table(
            "tax_rule_pack_versions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(60), nullable=False),
            sa.Column("version", sa.String(30), nullable=False),
            sa.Column("markets", sa.JSON(), nullable=False),
            sa.Column("rounding_rule", sa.String(20), nullable=False),
            sa.Column("golden_test_report", sa.JSON(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("status", CIE(PlatformVersionStatus), nullable=False,
                      server_default=PlatformVersionStatus.PENDING_REVIEW.name),
            sa.Column("predecessor_id", sa.Integer(), _fk("tax_rule_pack_versions.id"), nullable=True),
            sa.Column("validation_errors", sa.JSON(), nullable=True),
            sa.Column("approval_request_id", sa.Integer(), _fk("approval_requests.id"), nullable=True),
            _by("created_by_user_id"), _by("maker_user_id"), _by("checker_user_id"), _by("publisher_user_id"),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("submitted_at", TS, nullable=True),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("published_at", TS, nullable=True),
            sa.Column("superseded_at", TS, nullable=True),
            sa.Column("rejection_reason", sa.Text(), nullable=True),
            sa.UniqueConstraint("code", "version", name="uq_tax_rule_pack_versions_code_version"),
        )
        op.create_index("ix_tax_rule_pack_versions_id", "tax_rule_pack_versions", ["id"])
        op.create_index("ix_tax_rule_pack_versions_status", "tax_rule_pack_versions", ["status"])
        op.create_index("uq_tax_rule_pack_one_active", "tax_rule_pack_versions", ["code"], unique=True,
                        postgresql_where=sa.text("status = 'ACTIVE'"), sqlite_where=sa.text("status = 'ACTIVE'"))

    if not _has_table("tax_quotes"):
        op.create_table(
            "tax_quotes",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("document_type", sa.String(20), nullable=False),
            sa.Column("document_id", sa.Integer(), nullable=False),
            sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=True),
            sa.Column("status", CIE(TaxQuoteStatus), nullable=False),
            sa.Column("engine_kind", CIE(EngineKind), nullable=True),
            sa.Column("engine_name", sa.String(100), nullable=True),
            sa.Column("engine_version", sa.String(100), nullable=True),
            sa.Column("rounding_rule", CIE(RoundingRule), nullable=True),
            sa.Column("currency", sa.String(3), nullable=True),
            sa.Column("currency_decimals", sa.Integer(), nullable=True),
            sa.Column("tax_date", sa.Date(), nullable=True),
            sa.Column("pricing_mode", sa.String(20), nullable=True),
            sa.Column("context_fingerprint", sa.String(64), nullable=False),
            sa.Column("document_hash", sa.String(64), nullable=False),
            sa.Column("request_hash", sa.String(64), nullable=False),
            sa.Column("idempotency_key", sa.String(255), nullable=True),
            sa.Column("subtotal_unrounded", PRECISE, nullable=True),
            sa.Column("discount_unrounded", PRECISE, nullable=True),
            sa.Column("tax_unrounded", PRECISE, nullable=True),
            sa.Column("total_unrounded", PRECISE, nullable=True),
            sa.Column("subtotal", MONEY, nullable=True),
            sa.Column("discount_amount", MONEY, nullable=True),
            sa.Column("tax_amount", MONEY, nullable=True),
            sa.Column("total_amount", MONEY, nullable=True),
            sa.Column("issues", sa.JSON(), nullable=True),
            sa.Column("warnings", sa.JSON(), nullable=True),
            sa.Column("refusal_code", sa.String(60), nullable=True),
            sa.Column("refusal_reason", sa.Text(), nullable=True),
            sa.Column("provider_name", sa.String(100), nullable=True),
            sa.Column("provider_response_hash", sa.String(64), nullable=True),
            sa.Column("provider_correlation_id", sa.String(255), nullable=True),
            sa.Column("remote_commit_state", CIE(RemoteCommitState), nullable=False,
                      server_default=RemoteCommitState.NOT_APPLICABLE.name),
            _by("created_by"),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("expires_at", TS, nullable=True),
            sa.Column("validated_at", TS, nullable=True),
            sa.Column("stale_reason", sa.Text(), nullable=True),
            sa.Column("committed_at", TS, nullable=True),
            _by("committed_by"),
            sa.Column("voided_at", TS, nullable=True),
            _by("voided_by"),
            sa.Column("void_reason", sa.Text(), nullable=True),
        )
        op.create_index("ix_tax_quotes_id", "tax_quotes", ["id"])
        op.create_index("ix_tax_quotes_organization_id", "tax_quotes", ["organization_id"])
        op.create_index("ix_tax_quotes_status", "tax_quotes", ["status"])
        op.create_index("ix_tax_quotes_document", "tax_quotes", ["organization_id", "document_type", "document_id"])
        op.create_index("uq_tax_quotes_idempotency_key", "tax_quotes", ["organization_id", "idempotency_key"],
                        unique=True, postgresql_where=sa.text("idempotency_key IS NOT NULL"),
                        sqlite_where=sa.text("idempotency_key IS NOT NULL"))

    if not _has_table("tax_quote_lines"):
        op.create_table(
            "tax_quote_lines",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("tax_quote_id", sa.Integer(), _fk("tax_quotes.id"), nullable=False),
            sa.Column("document_line_id", sa.Integer(), nullable=False),
            sa.Column("line_number", sa.Integer(), nullable=False),
            sa.Column("product_id", sa.Integer(), nullable=True),
            sa.Column("tax_code", sa.String(50), nullable=True),
            sa.Column("supply_category", CIE(SupplyCategory), nullable=True),
            sa.Column("transaction_class", CIE(TransactionClass), nullable=True),
            sa.Column("outcome", CIE(TaxOutcome), nullable=False),
            sa.Column("explanation_code", sa.String(60), nullable=False),
            sa.Column("legal_reason", sa.Text(), nullable=True),
            sa.Column("is_tax_inclusive", sa.Boolean(), nullable=False),
            sa.Column("quantity", PRECISE, nullable=False),
            sa.Column("gross_unrounded", PRECISE, nullable=False),
            sa.Column("line_discount_unrounded", PRECISE, nullable=False),
            sa.Column("document_discount_unrounded", PRECISE, nullable=False),
            sa.Column("taxable_base_unrounded", PRECISE, nullable=False),
            sa.Column("tax_unrounded", PRECISE, nullable=False),
            sa.Column("effective_rate", RATE, nullable=False),
            sa.Column("taxable_base", MONEY, nullable=False),
            sa.Column("tax_amount", MONEY, nullable=False),
            sa.Column("line_total", MONEY, nullable=False),
        )
        op.create_index("ix_tax_quote_lines_id", "tax_quote_lines", ["id"])
        op.create_index("ix_tax_quote_lines_organization_id", "tax_quote_lines", ["organization_id"])
        op.create_index("ix_tax_quote_lines_tax_quote_id", "tax_quote_lines", ["tax_quote_id"])

    if not _has_table("tax_quote_components"):
        op.create_table(
            "tax_quote_components",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("tax_quote_id", sa.Integer(), _fk("tax_quotes.id"), nullable=False),
            sa.Column("tax_quote_line_id", sa.Integer(), _fk("tax_quote_lines.id"), nullable=False),
            sa.Column("component_code", sa.String(80), nullable=False),
            sa.Column("label", sa.String(255), nullable=True),
            sa.Column("jurisdiction_id", sa.Integer(), _fk("tax_jurisdictions.id"), nullable=True),
            sa.Column("tax_type_id", sa.Integer(), _fk("tax_type_definitions.id"), nullable=True),
            sa.Column("rate_source", sa.String(20), nullable=False),
            sa.Column("rate_version_id", sa.Integer(), _fk("tax_rate_versions.id"), nullable=True),
            sa.Column("activation_id", sa.Integer(), _fk("entity_tax_activations.id"), nullable=True),
            sa.Column("rate_percent", RATE, nullable=False),
            sa.Column("taxable_unrounded", PRECISE, nullable=False),
            sa.Column("tax_unrounded", PRECISE, nullable=False),
            sa.Column("tax_amount", MONEY, nullable=False),
            sa.Column("reporting_code", sa.String(50), nullable=True),
            sa.Column("is_reverse_charge", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
        op.create_index("ix_tax_quote_components_id", "tax_quote_components", ["id"])
        op.create_index("ix_tax_quote_components_organization_id", "tax_quote_components", ["organization_id"])
        op.create_index("ix_tax_quote_components_tax_quote_id", "tax_quote_components", ["tax_quote_id"])
        op.create_index("ix_tax_quote_components_tax_quote_line_id", "tax_quote_components", ["tax_quote_line_id"])

    if not _has_table("credit_note_tax_lines"):
        op.create_table(
            "credit_note_tax_lines",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("credit_note_id", sa.Integer(), _fk("credit_notes.id"), nullable=False),
            sa.Column("invoice_id", sa.Integer(), _fk("invoices.id"), nullable=False),
            sa.Column("tax_quote_id", sa.Integer(), _fk("tax_quotes.id"), nullable=False),
            sa.Column("tax_quote_line_id", sa.Integer(), _fk("tax_quote_lines.id"), nullable=False),
            sa.Column("tax_quote_component_id", sa.Integer(), _fk("tax_quote_components.id"), nullable=False),
            sa.Column("credited_base_unrounded", PRECISE, nullable=False),
            sa.Column("credited_tax_unrounded", PRECISE, nullable=False),
            sa.Column("credited_base", MONEY, nullable=False),
            sa.Column("credited_tax", MONEY, nullable=False),
            _by("created_by"),
            sa.Column("created_at", TS, nullable=False),
        )
        op.create_index("ix_credit_note_tax_lines_id", "credit_note_tax_lines", ["id"])
        op.create_index("ix_credit_note_tax_lines_organization_id", "credit_note_tax_lines", ["organization_id"])
        op.create_index("ix_credit_note_tax_lines_credit_note_id", "credit_note_tax_lines", ["credit_note_id"])
        op.create_index("ix_credit_note_tax_lines_invoice_id", "credit_note_tax_lines", ["invoice_id"])


def _add_invoice_column() -> None:
    if not _has_column("invoices", "tax_quote_id"):
        op.add_column("invoices", sa.Column("tax_quote_id", sa.Integer(), nullable=True))
        if _is_postgres():
            op.create_foreign_key("fk_invoices_tax_quote_id", "invoices", "tax_quotes",
                                  ["tax_quote_id"], ["id"], ondelete="RESTRICT")
    if not _has_index("invoices", "ix_invoices_tax_quote_id"):
        op.create_index("ix_invoices_tax_quote_id", "invoices", ["tax_quote_id"])


# ── Postgres guards (frozen copies of quote_models / policy_models DDL) ──

_TENANT_GUARD_FN = """
CREATE OR REPLACE FUNCTION tax_tenant_record_guard() RETURNS trigger AS $$
DECLARE
  f text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('zoiko.tax_erasure', true), '') <> 'on' THEN
      RAISE EXCEPTION '% rows are retained tax evidence: only the tenant erasure purge may delete them', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_ARGV[1] = '*' OR (to_jsonb(OLD) ->> 'status') = ANY (string_to_array(TG_ARGV[1], ',')) THEN
    FOREACH f IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
      IF (to_jsonb(NEW) -> f) IS DISTINCT FROM (to_jsonb(OLD) -> f) THEN
        RAISE EXCEPTION '%.% is frozen on record %; record a new version instead', TG_TABLE_NAME, f, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_FROZEN = {
    "tax_quotes": (
        "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
        "engine_version", "rounding_rule", "currency", "currency_decimals", "tax_date", "pricing_mode",
        "context_fingerprint", "document_hash", "request_hash", "idempotency_key", "subtotal_unrounded",
        "discount_unrounded", "tax_unrounded", "total_unrounded", "subtotal", "discount_amount", "tax_amount",
        "total_amount", "issues", "warnings", "refusal_code", "refusal_reason", "provider_name",
        "provider_response_hash", "created_by", "created_at", "expires_at",
    ),
    "tax_quote_lines": (
        "organization_id", "tax_quote_id", "document_line_id", "line_number", "product_id", "tax_code",
        "supply_category", "transaction_class", "outcome", "explanation_code", "legal_reason", "is_tax_inclusive",
        "quantity", "gross_unrounded", "line_discount_unrounded", "document_discount_unrounded",
        "taxable_base_unrounded", "tax_unrounded", "effective_rate", "taxable_base", "tax_amount", "line_total",
    ),
    "tax_quote_components": (
        "organization_id", "tax_quote_id", "tax_quote_line_id", "component_code", "label", "jurisdiction_id",
        "tax_type_id", "rate_source", "rate_version_id", "activation_id", "rate_percent", "taxable_unrounded",
        "tax_unrounded", "tax_amount", "reporting_code", "is_reverse_charge",
    ),
    "credit_note_tax_lines": (
        "organization_id", "credit_note_id", "invoice_id", "tax_quote_id", "tax_quote_line_id",
        "tax_quote_component_id", "credited_base_unrounded", "credited_tax_unrounded", "credited_base",
        "credited_tax", "created_by", "created_at",
    ),
}

_QUOTE_STATUS_FN = """
CREATE OR REPLACE FUNCTION tax_quotes_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'VOIDED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax quote % is voided and final', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'COMMITTED' AND NEW.status NOT IN ('COMMITTED', 'VOIDED') THEN
    RAISE EXCEPTION 'tax quote % is committed: it can only be voided', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_EDITABLE = "('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED')"
_RULE_PACK_FIELDS = ("code", "version", "markets", "rounding_rule", "golden_test_report", "notes",
                     "created_by_user_id", "created_at")


def _rule_pack_guard_fn() -> str:
    new = ", ".join(f"'{f}', NEW.{f}" for f in _RULE_PACK_FIELDS)
    old = ", ".join(f"'{f}', OLD.{f}" for f in _RULE_PACK_FIELDS)
    return f"""
CREATE OR REPLACE FUNCTION tax_rule_pack_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN {_EDITABLE} THEN
      RAISE EXCEPTION 'tax_rule_pack_versions % is %: only unsubmitted drafts can be deleted', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status NOT IN {_EDITABLE}
     AND jsonb_build_object({new}) IS DISTINCT FROM jsonb_build_object({old}) THEN
    RAISE EXCEPTION 'tax_rule_pack_versions % content is frozen once submitted; create a new version', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'SUPERSEDED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax_rule_pack_versions % is superseded and immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'ACTIVE' AND (
       (to_jsonb(NEW) - 'status' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'superseded_at')
       OR NEW.status NOT IN ('ACTIVE', 'SUPERSEDED')
       OR (NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'tax_rule_pack_versions % is active: it can only be superseded', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _trigger(name: str, sql: str) -> None:
    if not _pg_has("SELECT 1 FROM pg_trigger WHERE tgname = :n", n=name):
        op.execute(sql)


def _add_postgres_guards() -> None:
    if not _is_postgres():
        return
    op.execute(_TENANT_GUARD_FN)
    for table, fields in _FROZEN.items():
        _trigger(f"trg_{table}_guard",
                 f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
                 f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")
    op.execute(_QUOTE_STATUS_FN)
    _trigger("trg_tax_quotes_status_guard",
             "CREATE TRIGGER trg_tax_quotes_status_guard BEFORE UPDATE ON tax_quotes "
             "FOR EACH ROW EXECUTE FUNCTION tax_quotes_status_guard()")
    op.execute(_rule_pack_guard_fn())
    _trigger("trg_tax_rule_pack_versions_guard",
             "CREATE TRIGGER trg_tax_rule_pack_versions_guard BEFORE UPDATE OR DELETE ON tax_rule_pack_versions "
             "FOR EACH ROW EXECUTE FUNCTION tax_rule_pack_versions_guard()")


def upgrade() -> None:
    _create_tables()
    _add_invoice_column()
    _add_postgres_guards()


def downgrade() -> None:
    if _has_column("invoices", "tax_quote_id"):
        if _is_postgres():
            op.drop_constraint("fk_invoices_tax_quote_id", "invoices", type_="foreignkey")
        if _has_index("invoices", "ix_invoices_tax_quote_id"):
            op.drop_index("ix_invoices_tax_quote_id", table_name="invoices")
        op.drop_column("invoices", "tax_quote_id")
    for table in reversed(TENANT_TABLES):
        if _has_table(table):
            op.drop_table(table)
    if _has_table("tax_rule_pack_versions"):
        op.drop_table("tax_rule_pack_versions")
    if _is_postgres():
        # tax_tenant_record_guard belongs to Phase 2 and stays.
        for fn in ("tax_quotes_status_guard", "tax_rule_pack_versions_guard"):
            op.execute(f"DROP FUNCTION IF EXISTS {fn}()")
