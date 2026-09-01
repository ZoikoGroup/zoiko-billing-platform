"""add stripe processor reconciliation fields to reconciliation_runs

Revision ID: 4f990f372281
Revises: 243a242222e7
Create Date: 2026-08-31 17:38:03.879987

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4f990f372281'
down_revision: Union[str, Sequence[str], None] = '243a242222e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """ISS-017: two new nullable columns on reconciliation_runs so a genuine
    Stripe processor-comparison run (Phase 11) can record which environment
    it ran against and its own stats (range, orgs compared, records
    inspected/matched, processor errors — never secrets), alongside the
    existing processor_source/processor_note fields. Purely additive:
    nullable, no default-value backfill needed, no existing row's data
    changes, no other table touched. Never modifies the frozen baseline
    (8e483f394797) or any historical revision."""
    op.add_column(
        "reconciliation_runs",
        sa.Column("processor_environment", sa.String(length=10), nullable=True),
    )
    op.add_column(
        "reconciliation_runs",
        sa.Column("processor_stats", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("reconciliation_runs", "processor_stats")
    op.drop_column("reconciliation_runs", "processor_environment")
