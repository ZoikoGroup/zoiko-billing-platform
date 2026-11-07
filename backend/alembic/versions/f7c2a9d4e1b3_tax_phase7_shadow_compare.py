"""ZB-TAX-ARCH-001 Phase 7 PR 1: shadow compare

tax_shadow_selections (platform), tax_shadow_enrolments and
tax_shadow_comparisons (tenant, under the tenant record guard; comparisons
are write-once).

Revision ID: f7c2a9d4e1b3
Revises: e6b1d3f5a7c9
Create Date: 2026-11-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.core.db_types import CaseInsensitiveEnum as CIE
from app.modules.tax.enums import TenantApprovalStatus

revision: str = 'f7c2a9d4e1b3'
down_revision: Union[str, Sequence[str], None] = 'e6b1d3f5a7c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)
MONEY = sa.Numeric(18, 2)
ENROLMENT_FROZEN = ("organization_id", "seller_entity_id", "reason", "proposed_by", "created_at")
COMPARISON_FROZEN = ("organization_id", "seller_entity_id", "enrolment_id", "invoice_id", "invoice_number",
                     "issue_date", "currency", "outcome", "cause", "reason", "legacy_tax", "shadow_tax",
                     "tax_difference", "lines", "rule_pack_version_id", "pack_code", "pack_version", "computed_at")


def _fk(target, ondelete="RESTRICT"):
    return sa.ForeignKey(target, ondelete=ondelete)


def _user(name):
    return sa.Column(name, sa.Integer(), _fk("users.id", "SET NULL"), nullable=True)


def _has(table):
    return sa.inspect(op.get_bind()).has_table(table)


def _guard(table, fields):
    op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
    op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")


def upgrade() -> None:
    if not _has("tax_shadow_selections"):
        op.create_table(
            "tax_shadow_selections",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("rule_pack_version_id", sa.Integer(), _fk("tax_rule_pack_versions.id"), nullable=False),
            sa.Column("exit_min_invoices", sa.Integer(), nullable=False, server_default="50"),
            sa.Column("exit_min_days", sa.Integer(), nullable=False, server_default="30"),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("reason", sa.Text(), nullable=True),
            _user("chosen_by"),
            sa.Column("chosen_at", TS, nullable=False),
            _user("ended_by"),
            sa.Column("ended_at", TS, nullable=True),
        )
        op.create_index("ix_tax_shadow_selections_rule_pack_version_id", "tax_shadow_selections", ["rule_pack_version_id"])
        op.create_index("ix_tax_shadow_selections_active", "tax_shadow_selections", ["active"])
    if not _has("tax_shadow_enrolments"):
        op.create_table(
            "tax_shadow_enrolments",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False),
            sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=False),
            sa.Column("status", CIE(TenantApprovalStatus), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            _user("proposed_by"), _user("approved_by"),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            _user("ended_by"),
            sa.Column("ended_at", TS, nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("organization_id", "seller_entity_id", "status"):
            op.create_index(f"ix_tax_shadow_enrolments_{col}", "tax_shadow_enrolments", [col])
    if not _has("tax_shadow_comparisons"):
        op.create_table(
            "tax_shadow_comparisons",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False),
            sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=True),
            sa.Column("enrolment_id", sa.Integer(), _fk("tax_shadow_enrolments.id"), nullable=False),
            sa.Column("invoice_id", sa.Integer(), _fk("invoices.id"), nullable=False),
            sa.Column("invoice_number", sa.String(100), nullable=True),
            sa.Column("issue_date", sa.Date(), nullable=True),
            sa.Column("currency", sa.String(3), nullable=True),
            sa.Column("outcome", sa.String(30), nullable=False),
            sa.Column("cause", sa.String(60), nullable=True),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("legacy_tax", MONEY, nullable=True),
            sa.Column("shadow_tax", MONEY, nullable=True),
            sa.Column("tax_difference", MONEY, nullable=True),
            sa.Column("lines", sa.JSON(), nullable=True),
            sa.Column("rule_pack_version_id", sa.Integer(), _fk("tax_rule_pack_versions.id"), nullable=True),
            sa.Column("pack_code", sa.String(60), nullable=True),
            sa.Column("pack_version", sa.String(30), nullable=True),
            sa.Column("computed_at", TS, nullable=False),
            sa.UniqueConstraint("invoice_id", name="uq_tax_shadow_comparisons_invoice"),
        )
        for col in ("organization_id", "seller_entity_id", "enrolment_id", "outcome", "cause"):
            op.create_index(f"ix_tax_shadow_comparisons_{col}", "tax_shadow_comparisons", [col])
    if op.get_bind().dialect.name == "postgresql":
        _guard("tax_shadow_enrolments", ENROLMENT_FROZEN)
        _guard("tax_shadow_comparisons", COMPARISON_FROZEN)


def downgrade() -> None:
    for table in ("tax_shadow_comparisons", "tax_shadow_enrolments", "tax_shadow_selections"):
        if _has(table):
            if op.get_bind().dialect.name == "postgresql":
                op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
            op.drop_table(table)
