"""ZB-TAX-ARCH-001 Phase 4d: manual address resolution (two people, evidence)

Tenant (organization_id on every row):
  tax_manual_resolution_requests: a proposed set of districts for an address
  the resolver could not place, its reason, an evidence document (written
  once), the two-person decision, and the resolution it produced. One open
  proposal per address.

Postgres guards (frozen copy): a tenant record guard on the new table, and
its evidence document is write-once.

Revision ID: b8e2d4f6a0c3
Revises: f7a2c4e6b8d1
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import TenantApprovalStatus

revision: str = 'b8e2d4f6a0c3'
down_revision: Union[str, Sequence[str], None] = 'f7a2c4e6b8d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
TS = sa.DateTime(timezone=True)
TABLE = "tax_manual_resolution_requests"

_FROZEN = ("organization_id", "address_id", "jurisdiction_codes", "reason", "proposed_by", "created_at")

_EVIDENCE_WRITE_ONCE = """
CREATE OR REPLACE FUNCTION tax_manual_resolution_evidence_write_once() RETURNS trigger AS $$
BEGIN
  IF OLD.evidence_file_id IS NOT NULL AND NEW.evidence_file_id IS DISTINCT FROM OLD.evidence_file_id THEN
    RAISE EXCEPTION 'manual resolution % already has its evidence document', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _user(name):
    return sa.Column(name, sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


def upgrade() -> None:
    if not sa.inspect(op.get_bind()).has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("address_id", sa.Integer(), sa.ForeignKey("customer_tax_addresses.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("jurisdiction_codes", sa.JSON(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("evidence_file_id", sa.Integer(), sa.ForeignKey("tax_evidence_files.id", ondelete="RESTRICT"),
                      nullable=True),
            sa.Column("status", CIE(TenantApprovalStatus), nullable=False,
                      server_default=TenantApprovalStatus.PROPOSED.name),
            _user("proposed_by"), _user("approved_by"),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("resolution_id", sa.Integer(),
                      sa.ForeignKey("tax_address_resolutions.id", ondelete="RESTRICT"), nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("id", "organization_id", "address_id", "status"):
            op.create_index(f"ix_{TABLE}_{col}", TABLE, [col])
        op.create_index("uq_tax_manual_resolution_one_open", TABLE, ["address_id"], unique=True,
                        sqlite_where=sa.text("status = 'PROPOSED'"), postgresql_where=sa.text("status = 'PROPOSED'"))
    if _is_postgres():
        op.execute(f"DROP TRIGGER IF EXISTS trg_{TABLE}_guard ON {TABLE}")
        op.execute(f"CREATE TRIGGER trg_{TABLE}_guard BEFORE UPDATE OR DELETE ON {TABLE} FOR EACH ROW "
                   f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(_FROZEN)}', '*')")
        op.execute(_EVIDENCE_WRITE_ONCE)
        op.execute(f"DROP TRIGGER IF EXISTS trg_{TABLE}_evidence_write_once ON {TABLE}")
        op.execute(f"CREATE TRIGGER trg_{TABLE}_evidence_write_once BEFORE UPDATE ON {TABLE} FOR EACH ROW "
                   "EXECUTE FUNCTION tax_manual_resolution_evidence_write_once()")


def downgrade() -> None:
    if _is_postgres():
        op.execute(f"DROP TRIGGER IF EXISTS trg_{TABLE}_evidence_write_once ON {TABLE}")
        op.execute("DROP FUNCTION IF EXISTS tax_manual_resolution_evidence_write_once()")
    if sa.inspect(op.get_bind()).has_table(TABLE):
        op.drop_table(TABLE)
