"""ZB-TAX-ARCH-001 Phase 4a-1 fixes (post-merge review of PR #132)

  1. tax_provider_outbox: verified_at (fix 6), review_kind (fixes 1 and 3),
     send_intent (fix 5). The terminal guard now also treats CANCELLED as
     final (fix 3) and lets a terminal row record its later verification
     (verified_at, remote_snapshot, updated_at) and nothing else.
  2. tax_quotes.supply_address (fix 4): the place-of-supply address and role
     the quote was determined with, frozen like the rest of the quote.
  3. customer_tax_addresses.line1 / line2 (fix 4): the street lines, frozen
     like the other address fields (a change is a new address version).

Postgres-only guards are recreated with the new frozen-field lists (frozen
copies). Downgrade restores the previous guards and drops the columns.

Revision ID: a8d3e6f1c9b2
Revises: f2c7a9e1b4d3
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'a8d3e6f1c9b2'
down_revision: Union[str, Sequence[str], None] = 'f2c7a9e1b4d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


# ── frozen copies ───────────────────────────────────────────────────────

_QUOTE_FROZEN_3B = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "context_fingerprint", "document_hash", "request_hash", "idempotency_key", "subtotal_unrounded",
    "discount_unrounded", "tax_unrounded", "total_unrounded", "subtotal", "discount_amount", "tax_amount",
    "total_amount", "issues", "warnings", "refusal_code", "refusal_reason", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at", "rounding_mode",
)
_QUOTE_FROZEN_4A = _QUOTE_FROZEN_3B + ("supply_address",)

_ADDRESS_FROZEN_2 = ("organization_id", "customer_id", "role", "country_code", "subdivision_code", "postal_code",
                     "city", "confidence", "source", "source_field", "validated_at", "created_by", "created_at")
_ADDRESS_FROZEN_4A = ("organization_id", "customer_id", "role", "country_code", "subdivision_code", "postal_code",
                      "city", "line1", "line2", "confidence", "source", "source_field", "validated_at", "created_by",
                      "created_at")

_TERMINAL_4A1 = """
CREATE OR REPLACE FUNCTION tax_provider_outbox_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('DONE', 'FAILED', 'VOIDED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax_provider_outbox % is % and final', OLD.id, OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_TERMINAL_FIXES = """
CREATE OR REPLACE FUNCTION tax_provider_outbox_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('DONE', 'FAILED', 'VOIDED', 'CANCELLED')
     AND (to_jsonb(NEW) - 'verified_at' - 'remote_snapshot' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'verified_at' - 'remote_snapshot' - 'updated_at') THEN
    RAISE EXCEPTION 'tax_provider_outbox % is % and final', OLD.id, OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _tenant_guard(table: str, fields: tuple) -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
    op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")


def upgrade() -> None:
    for column, type_ in (("verified_at", TS), ("review_kind", sa.String(40)), ("send_intent", sa.JSON())):
        if not _has_column("tax_provider_outbox", column):
            op.add_column("tax_provider_outbox", sa.Column(column, type_, nullable=True))
    if not _has_column("tax_quotes", "supply_address"):
        op.add_column("tax_quotes", sa.Column("supply_address", sa.JSON(), nullable=True))
    for column in ("line1", "line2"):
        if not _has_column("customer_tax_addresses", column):
            op.add_column("customer_tax_addresses", sa.Column(column, sa.String(255), nullable=True))
    if _is_postgres():
        op.execute(_TERMINAL_FIXES)
        _tenant_guard("tax_quotes", _QUOTE_FROZEN_4A)
        _tenant_guard("customer_tax_addresses", _ADDRESS_FROZEN_4A)


def downgrade() -> None:
    if _is_postgres():
        op.execute(_TERMINAL_4A1)
        _tenant_guard("tax_quotes", _QUOTE_FROZEN_3B)
        _tenant_guard("customer_tax_addresses", _ADDRESS_FROZEN_2)
    for table, column in (("customer_tax_addresses", "line2"), ("customer_tax_addresses", "line1"),
                          ("tax_quotes", "supply_address"), ("tax_provider_outbox", "send_intent"),
                          ("tax_provider_outbox", "review_kind"), ("tax_provider_outbox", "verified_at")):
        if _has_column(table, column):
            op.drop_column(table, column)
