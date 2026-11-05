"""ZB-TAX-ARCH-001 Phase 4c review: resolution dataset version, pseudonym key
records

Tenant (organization_id on every row):
  1. tax_address_resolutions.dataset_version — the resolver dataset an answer
     came from (a newer dataset makes it stale); frozen.
  2. tax_pseudonym_key_records — the fingerprint (never the key) of the
     pseudonym key a tenant's provider records were made under, and the
     two-person acknowledgements of a changed key.

Postgres guards (frozen copies): the resolution guard recreated with
dataset_version; a tenant record guard on the new table.

Revision ID: d2b8e4f6a1c3
Revises: c7f3a1d9e5b2
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import TenantApprovalStatus

revision: str = 'd2b8e4f6a1c3'
down_revision: Union[str, Sequence[str], None] = 'c7f3a1d9e5b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
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

_RESOLUTION_4C = ("organization_id", "address_id", "resolver_name", "source", "status", "precision", "candidates",
                  "jurisdiction_codes", "resolved_by", "resolved_at")
_RESOLUTION = ("organization_id", "address_id", "resolver_name", "source", "dataset_version", "status", "precision",
               "candidates", "jurisdiction_codes", "resolved_by", "resolved_at")
_PSEUDONYM = ("organization_id", "fingerprint", "reason", "proposed_by", "created_at")


def _guard(table: str, fields: tuple, frozen: str = "*") -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
    op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '{frozen}')")


def upgrade() -> None:
    if not _has_column("tax_address_resolutions", "dataset_version"):
        op.add_column("tax_address_resolutions", sa.Column("dataset_version", sa.String(100), nullable=True))
    if not _has_table("tax_pseudonym_key_records"):
        op.create_table(
            "tax_pseudonym_key_records",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("fingerprint", sa.String(32), nullable=True),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("status", CIE(TenantApprovalStatus), nullable=False,
                      server_default=TenantApprovalStatus.PROPOSED.name),
            sa.Column("proposed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("approved_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("id", "organization_id", "status"):
            op.create_index(f"ix_tax_pseudonym_key_records_{col}", "tax_pseudonym_key_records", [col])
        op.create_index("uq_tax_pseudonym_key_records_one_open", "tax_pseudonym_key_records", ["organization_id"],
                        unique=True, sqlite_where=sa.text("status = 'PROPOSED'"),
                        postgresql_where=sa.text("status = 'PROPOSED'"))
    if _is_postgres():
        _guard("tax_address_resolutions", _RESOLUTION)
        _guard("tax_pseudonym_key_records", _PSEUDONYM)


def downgrade() -> None:
    if _is_postgres():
        _guard("tax_address_resolutions", _RESOLUTION_4C)
    if _has_table("tax_pseudonym_key_records"):
        op.drop_table("tax_pseudonym_key_records")
    if _has_column("tax_address_resolutions", "dataset_version"):
        op.drop_column("tax_address_resolutions", "dataset_version")
