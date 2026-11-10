"""ZB-TAX-ARCH-001 Phase 7 PR 3: anomaly monitoring runs

tax_anomaly_runs (platform, aggregate only). The per-invoice findings are
tenant review items (new kinds are VARCHAR enum values, no DDL).

Revision ID: b9e4c6a8d3f5
Revises: a8d3b5f7c2e4
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b9e4c6a8d3f5'
down_revision: Union[str, Sequence[str], None] = 'a8d3b5f7c2e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("tax_anomaly_runs"):
        return
    op.create_table(
        "tax_anomaly_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("markets", sa.JSON(), nullable=False),
        sa.Column("alerts_fired", sa.JSON(), nullable=True),
    )
    op.create_index("ix_tax_anomaly_runs_started_at", "tax_anomaly_runs", ["started_at"])


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("tax_anomaly_runs"):
        op.drop_table("tax_anomaly_runs")
