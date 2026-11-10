"""ZB-TAX-ARCH-001 Phase 7 PR 4: targeted remediation

tax_remediation_batches, tax_remediation_items (unique per kind and
invoice: never remediated twice) and tax_duplicate_row_archive (removed
duplicate rows kept whole for reversal). Tenant tables under the tenant
record guard.

Revision ID: c1f5d7b9e2a4
Revises: b9e4c6a8d3f5
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.core.db_types import CaseInsensitiveEnum as CIE
from app.modules.tax.enums import TenantApprovalStatus

revision: str = 'c1f5d7b9e2a4'
down_revision: Union[str, Sequence[str], None] = 'b9e4c6a8d3f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)
GUARDS = {
    "tax_remediation_batches": ("organization_id", "kind", "invoice_ids", "reason", "proposed_by", "created_at"),
    "tax_remediation_items": ("organization_id", "batch_id", "kind", "invoice_id", "credit_note_id", "amount",
                              "rows_removed", "created_at"),
    "tax_duplicate_row_archive": ("organization_id", "batch_id", "tax_row_id", "invoice_id", "row", "archived_at"),
}


def _fk(target, ondelete="RESTRICT"):
    return sa.ForeignKey(target, ondelete=ondelete)


def _user(name):
    return sa.Column(name, sa.Integer(), _fk("users.id", "SET NULL"), nullable=True)


def _has(table):
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    if not _has("tax_remediation_batches"):
        op.create_table(
            "tax_remediation_batches",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False),
            sa.Column("kind", sa.String(30), nullable=False),
            sa.Column("status", CIE(TenantApprovalStatus), nullable=False),
            sa.Column("invoice_ids", sa.JSON(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            _user("proposed_by"), _user("approved_by"),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("result", sa.JSON(), nullable=True),
            sa.Column("evidence_sha256", sa.String(64), nullable=True),
            _user("reversed_by"),
            sa.Column("reversed_at", TS, nullable=True),
            sa.Column("reverse_reason", sa.Text(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("organization_id", "kind", "status"):
            op.create_index(f"ix_tax_remediation_batches_{col}", "tax_remediation_batches", [col])
    if not _has("tax_remediation_items"):
        op.create_table(
            "tax_remediation_items",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False),
            sa.Column("batch_id", sa.Integer(), _fk("tax_remediation_batches.id"), nullable=False),
            sa.Column("kind", sa.String(30), nullable=False),
            sa.Column("invoice_id", sa.Integer(), _fk("invoices.id"), nullable=False),
            sa.Column("credit_note_id", sa.Integer(), _fk("credit_notes.id"), nullable=True),
            sa.Column("amount", sa.Numeric(14, 2), nullable=True),
            sa.Column("rows_removed", sa.Integer(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.UniqueConstraint("kind", "invoice_id", name="uq_tax_remediation_items_kind_invoice"),
        )
        for col in ("organization_id", "batch_id"):
            op.create_index(f"ix_tax_remediation_items_{col}", "tax_remediation_items", [col])
    if not _has("tax_duplicate_row_archive"):
        op.create_table(
            "tax_duplicate_row_archive",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False),
            sa.Column("batch_id", sa.Integer(), _fk("tax_remediation_batches.id"), nullable=False),
            sa.Column("tax_row_id", sa.Integer(), nullable=False),
            sa.Column("invoice_id", sa.Integer(), nullable=True),
            sa.Column("row", sa.JSON(), nullable=False),
            sa.Column("archived_at", TS, nullable=False),
            sa.Column("restored_at", TS, nullable=True),
        )
        for col in ("organization_id", "batch_id"):
            op.create_index(f"ix_tax_duplicate_row_archive_{col}", "tax_duplicate_row_archive", [col])
    if op.get_bind().dialect.name == "postgresql":
        for table, fields in GUARDS.items():
            op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
            op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
                       f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")


def downgrade() -> None:
    for table in ("tax_duplicate_row_archive", "tax_remediation_items", "tax_remediation_batches"):
        if _has(table):
            if op.get_bind().dialect.name == "postgresql":
                op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
            op.drop_table(table)
