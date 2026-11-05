"""ZB-TAX-ARCH-001 Phase 4c: US address resolution and exemption claims

Tenant (organization_id on every row):
  1. tax_address_resolutions — each resolution of a buyer tax address to tax
     jurisdictions (resolver, source, precision, candidates, codes);
     write-once evidence.
  2. tax_quotes.exemption_claims — the valid certificates a quote claimed
     (frozen with the quote).

Postgres guards (frozen copies): a tenant record guard on the new table; the
quote guard recreated with exemption_claims.

Revision ID: c7f3a1d9e5b2
Revises: b5e9d2c7a4f1
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'c7f3a1d9e5b2'
down_revision: Union[str, Sequence[str], None] = 'b5e9d2c7a4f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)


def _insp():
    return sa.inspect(op.get_bind())


def _has_table(t: str) -> bool:
    return _insp().has_table(t)


def _has_column(t: str, c: str) -> bool:
    return _has_table(t) and c in {x["name"] for x in _insp().get_columns(t)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


# ── frozen copies ───────────────────────────────────────────────────────

_QUOTE_4A2 = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "context_fingerprint", "document_hash", "request_hash", "idempotency_key", "subtotal_unrounded",
    "discount_unrounded", "tax_unrounded", "total_unrounded", "subtotal", "discount_amount", "tax_amount",
    "total_amount", "issues", "warnings", "refusal_code", "refusal_reason", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at", "rounding_mode", "supply_address",
    "provider_connection_id",
)
_QUOTE_4C = _QUOTE_4A2 + ("exemption_claims",)
_RESOLUTION = ("organization_id", "address_id", "resolver_name", "source", "status", "precision", "candidates",
               "jurisdiction_codes", "resolved_by", "resolved_at")


def _guard(table: str, fields: tuple, frozen: str = "*") -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
    op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '{frozen}')")


def upgrade() -> None:
    if not _has_table("tax_address_resolutions"):
        op.create_table(
            "tax_address_resolutions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("address_id", sa.Integer(), sa.ForeignKey("customer_tax_addresses.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("resolver_name", sa.String(100), nullable=False),
            sa.Column("source", sa.String(200), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("precision", sa.String(20), nullable=True),
            sa.Column("candidates", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("jurisdiction_codes", sa.JSON(), nullable=False),
            sa.Column("resolved_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("resolved_at", TS, nullable=False),
        )
        for col in ("id", "organization_id", "address_id"):
            op.create_index(f"ix_tax_address_resolutions_{col}", "tax_address_resolutions", [col])
    if not _has_column("tax_quotes", "exemption_claims"):
        op.add_column("tax_quotes", sa.Column("exemption_claims", sa.JSON(), nullable=True))
    if _is_postgres():
        _guard("tax_address_resolutions", _RESOLUTION)
        _guard("tax_quotes", _QUOTE_4C)


def downgrade() -> None:
    if _is_postgres():
        _guard("tax_quotes", _QUOTE_4A2)
    if _has_column("tax_quotes", "exemption_claims"):
        op.drop_column("tax_quotes", "exemption_claims")
    if _has_table("tax_address_resolutions"):
        op.drop_table("tax_address_resolutions")
