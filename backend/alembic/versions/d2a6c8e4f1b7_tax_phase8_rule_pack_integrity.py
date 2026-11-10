"""ZB-TAX-ARCH-001 Phase 8 PR 1: rule-pack integrity

  1. tax_rule_pack_versions.code_hash: SHA-256 of the pack's code and
     declarations, recorded at registration and frozen with the other
     content columns (the version guard is recreated with it).
  2. tax_quotes.rule_pack_version_id (FK, indexed) and rule_pack_code_hash:
     which approved native pack version produced a quote.

Backfill: a native-pack quote whose engine_name/engine_version match
exactly one (code, version) row gets that row's id; (code, version) is
unique, so a match is never ambiguous. rule_pack_code_hash stays null on
backfilled quotes: the code that produced a past quote can't be proven.
Every other quote stays null. Both counts are logged.

Postgres-only guards (frozen copies): the tax_quotes tenant guard is
recreated freezing every content column, including the new ones (the ORM
guard already freezes them all).

Revision ID: d2a6c8e4f1b7
Revises: c1f5d7b9e2a4
Create Date: 2026-11-10
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'd2a6c8e4f1b7'
down_revision: Union[str, Sequence[str], None] = 'c1f5d7b9e2a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")

# ── Frozen copies of the guard field lists ──────────────────────────────

_QUOTE_FROZEN_3B = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "context_fingerprint", "document_hash", "request_hash", "idempotency_key", "subtotal_unrounded",
    "discount_unrounded", "tax_unrounded", "total_unrounded", "subtotal", "discount_amount", "tax_amount",
    "total_amount", "issues", "warnings", "refusal_code", "refusal_reason", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at", "rounding_mode",
)
_QUOTE_FROZEN_8 = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "rounding_mode", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "supply_address", "exemption_claims", "provider_connection_id", "context_fingerprint", "document_hash",
    "request_hash", "idempotency_key", "subtotal_unrounded", "discount_unrounded", "tax_unrounded",
    "total_unrounded", "subtotal", "discount_amount", "tax_amount", "total_amount", "issues", "warnings",
    "refusal_code", "refusal_reason", "rule_pack_version_id", "rule_pack_code_hash", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at",
)
_PACK_FIELDS_3B = ("code", "version", "markets", "rounding_rule", "rounding_mode", "required_facts", "coverage",
                   "source_dependencies", "golden_test_report", "notes", "created_by_user_id", "created_at")
_PACK_FIELDS_8 = _PACK_FIELDS_3B + ("code_hash",)

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


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


NATIVE = "upper(q.engine_kind) = 'NATIVE_RULE_PACK'"
MATCH = ("FROM tax_rule_pack_versions r WHERE r.code = q.engine_name AND r.version = q.engine_version")


def backfill(bind) -> dict:
    """Backfill unambiguous quotes; return the counts (also used by tests)."""
    bind.execute(sa.text(
        f"UPDATE tax_quotes SET rule_pack_version_id = (SELECT r.id {MATCH.replace('q.', 'tax_quotes.')}) "
        f"WHERE {NATIVE.replace('q.', 'tax_quotes.')} AND rule_pack_version_id IS NULL "
        f"AND EXISTS (SELECT 1 {MATCH.replace('q.', 'tax_quotes.')})"))
    linked = bind.execute(sa.text(
        f"SELECT count(*) FROM tax_quotes q WHERE {NATIVE} AND q.rule_pack_version_id IS NOT NULL")).scalar()
    unlinked = bind.execute(sa.text(
        f"SELECT count(*) FROM tax_quotes q WHERE {NATIVE} AND q.rule_pack_version_id IS NULL")).scalar()
    return {"linked": int(linked or 0), "left_null": int(unlinked or 0)}


def upgrade() -> None:
    if not _has_column("tax_rule_pack_versions", "code_hash"):
        op.add_column("tax_rule_pack_versions", sa.Column("code_hash", sa.String(64), nullable=True))
    if not _has_column("tax_quotes", "rule_pack_version_id"):
        op.add_column("tax_quotes", sa.Column(
            "rule_pack_version_id", sa.Integer(),
            sa.ForeignKey("tax_rule_pack_versions.id", name="fk_tax_quotes_rule_pack_version_id",
                          ondelete="RESTRICT"), nullable=True))
        op.create_index("ix_tax_quotes_rule_pack_version_id", "tax_quotes", ["rule_pack_version_id"])
    if not _has_column("tax_quotes", "rule_pack_code_hash"):
        op.add_column("tax_quotes", sa.Column("rule_pack_code_hash", sa.String(64), nullable=True))

    # The status guard refuses any change to a VOIDED quote, so it is paused
    # for this one backfill (as in e4b8c1d6f2a9). The tenant guard does not
    # list the new columns yet.
    if _is_postgres():
        op.execute("ALTER TABLE tax_quotes DISABLE TRIGGER trg_tax_quotes_status_guard")
    counts = backfill(op.get_bind())
    if _is_postgres():
        op.execute("ALTER TABLE tax_quotes ENABLE TRIGGER trg_tax_quotes_status_guard")
        _set_quote_guard(_QUOTE_FROZEN_8)
        op.execute(_rule_pack_guard_fn(_PACK_FIELDS_8))
    logger.info("Phase 8 rule-pack provenance backfill: %s native-pack quotes linked, %s left null",
                counts["linked"], counts["left_null"])


def downgrade() -> None:
    if _is_postgres():
        op.execute(_rule_pack_guard_fn(_PACK_FIELDS_3B))
        _set_quote_guard(_QUOTE_FROZEN_3B)
    if _has_column("tax_quotes", "rule_pack_code_hash"):
        op.drop_column("tax_quotes", "rule_pack_code_hash")
    if _has_column("tax_quotes", "rule_pack_version_id"):
        op.drop_index("ix_tax_quotes_rule_pack_version_id", table_name="tax_quotes")
        op.drop_column("tax_quotes", "rule_pack_version_id")          # drops its foreign key with it
    if _has_column("tax_rule_pack_versions", "code_hash"):
        op.drop_column("tax_rule_pack_versions", "code_hash")
