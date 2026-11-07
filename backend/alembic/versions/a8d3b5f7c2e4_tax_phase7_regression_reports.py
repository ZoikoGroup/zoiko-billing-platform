"""ZB-TAX-ARCH-001 Phase 7 PR 2: regression reports

tax_regression_reports (platform, append-only): the historical regression
attached to a rule pack version or a staged rate before approval.

Revision ID: a8d3b5f7c2e4
Revises: f7c2a9d4e1b3
Create Date: 2026-11-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'a8d3b5f7c2e4'
down_revision: Union[str, Sequence[str], None] = 'f7c2a9d4e1b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("tax_regression_reports"):
        return
    op.create_table(
        "tax_regression_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("subject_kind", sa.String(20), nullable=False),
        sa.Column("subject_id", sa.Integer(), nullable=False),
        sa.Column("fixture_hash", sa.String(64), nullable=False),
        sa.Column("baseline_ref", sa.String(500), nullable=False),
        sa.Column("case_count", sa.Integer(), nullable=False),
        sa.Column("changed_count", sa.Integer(), nullable=False),
        sa.Column("report", sa.JSON(), nullable=False),
        sa.Column("generated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_tax_regression_reports_subject_kind", "tax_regression_reports", ["subject_kind"])
    op.create_index("ix_tax_regression_reports_subject_id", "tax_regression_reports", ["subject_id"])


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("tax_regression_reports"):
        op.drop_table("tax_regression_reports")
