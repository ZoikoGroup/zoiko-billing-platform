"""ZB-TAX-ARCH-001 Phase 3b: declared rounding mode and rule-pack declarations

  1. tax_quotes.rounding_mode — the engine-declared RoundingMode (F4). Existing
     determined quotes are backfilled with HALF_UP, the mode Phase 3a always
     used, before the column is added to the frozen-field guard.
  2. tax_rule_pack_versions: rounding_mode (required), required_facts,
     coverage and source_dependencies — part of the frozen content once a
     version is submitted.

Postgres-only guards (frozen copies): the tax_quotes tenant guard trigger and
the tax_rule_pack_versions version guard are recreated with the new columns.

Downgrade drops the columns and restores the Phase 3a guards.

Revision ID: e4b8c1d6f2a9
Revises: d7a3f9c2e8b6
Create Date: 2026-11-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import RoundingMode

revision: str = 'e4b8c1d6f2a9'
down_revision: Union[str, Sequence[str], None] = 'd7a3f9c2e8b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum

PACK_COLUMNS = ("required_facts", "coverage", "source_dependencies")


def _inspector():
    return sa.inspect(op.get_bind())


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in _inspector().get_columns(table)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


# ── Frozen copies of the guard field lists ──────────────────────────────

_QUOTE_FROZEN_3A = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "context_fingerprint", "document_hash", "request_hash", "idempotency_key", "subtotal_unrounded",
    "discount_unrounded", "tax_unrounded", "total_unrounded", "subtotal", "discount_amount", "tax_amount",
    "total_amount", "issues", "warnings", "refusal_code", "refusal_reason", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at",
)
_QUOTE_FROZEN_3B = _QUOTE_FROZEN_3A + ("rounding_mode",)

_PACK_FIELDS_3A = ("code", "version", "markets", "rounding_rule", "golden_test_report", "notes",
                   "created_by_user_id", "created_at")
_PACK_FIELDS_3B = ("code", "version", "markets", "rounding_rule", "rounding_mode", "required_facts", "coverage",
                   "source_dependencies", "golden_test_report", "notes", "created_by_user_id", "created_at")

_EDITABLE = "('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED')"


def _rule_pack_guard_fn(fields: tuple) -> str:
    new = ", ".join(f"'{f}', NEW.{f}" for f in fields)
    old = ", ".join(f"'{f}', OLD.{f}" for f in fields)
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


def _set_quote_guard(fields: tuple) -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_tax_quotes_guard ON tax_quotes")
    op.execute("CREATE TRIGGER trg_tax_quotes_guard BEFORE UPDATE OR DELETE ON tax_quotes FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")


def upgrade() -> None:
    if not _has_column("tax_quotes", "rounding_mode"):
        op.add_column("tax_quotes", sa.Column("rounding_mode", CIE(RoundingMode), nullable=True))
    # Phase 3a rounded every governed quote HALF_UP. The status guard refuses
    # any change to a VOIDED quote, so it is paused for this one backfill.
    if _is_postgres():
        op.execute("ALTER TABLE tax_quotes DISABLE TRIGGER trg_tax_quotes_status_guard")
    op.execute("UPDATE tax_quotes SET rounding_mode = 'HALF_UP' "
               "WHERE engine_kind IS NOT NULL AND rounding_mode IS NULL")
    if _is_postgres():
        op.execute("ALTER TABLE tax_quotes ENABLE TRIGGER trg_tax_quotes_status_guard")
        _set_quote_guard(_QUOTE_FROZEN_3B)

    if not _has_column("tax_rule_pack_versions", "rounding_mode"):
        # The registry holds no rows before 3b; the default only satisfies
        # NOT NULL on add and is dropped: every pack declares its mode.
        op.add_column("tax_rule_pack_versions",
                      sa.Column("rounding_mode", sa.String(20), nullable=False, server_default="HALF_UP"))
        if _is_postgres():
            op.alter_column("tax_rule_pack_versions", "rounding_mode", server_default=None)
    for column in PACK_COLUMNS:
        if not _has_column("tax_rule_pack_versions", column):
            op.add_column("tax_rule_pack_versions", sa.Column(column, sa.JSON(), nullable=True))
    if _is_postgres():
        op.execute(_rule_pack_guard_fn(_PACK_FIELDS_3B))


def downgrade() -> None:
    if _is_postgres():
        op.execute(_rule_pack_guard_fn(_PACK_FIELDS_3A))
        _set_quote_guard(_QUOTE_FROZEN_3A)
    for column in reversed(PACK_COLUMNS + ("rounding_mode",)):
        if _has_column("tax_rule_pack_versions", column):
            op.drop_column("tax_rule_pack_versions", column)
    if _has_column("tax_quotes", "rounding_mode"):
        op.drop_column("tax_quotes", "rounding_mode")
