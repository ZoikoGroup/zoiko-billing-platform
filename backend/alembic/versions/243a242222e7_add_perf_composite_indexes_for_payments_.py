"""add perf composite indexes for payments invoices aggregation

Revision ID: 243a242222e7
Revises: ee85ae4bd5f8
Create Date: 2026-08-31 15:28:18.788943

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '243a242222e7'
down_revision: Union[str, Sequence[str], None] = 'ee85ae4bd5f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Proven by EXPLAIN ANALYZE on the Phase-8 perf dataset: the dashboard/
    # reporting aggregations over payments filter on (organization_id, status,
    # payment_date) and previously fell back to a full sequential scan over the
    # payments table (100k rows, ~77-120ms). A covering composite index turns
    # that into a narrow index scan. invoices benefits from the analogous
    # (organization_id, status, issue_date) composite.
    op.create_index(
        op.f('ix_payments_org_status_date'),
        'payments',
        ['organization_id', 'status', 'payment_date'],
        unique=False,
    )
    op.create_index(
        op.f('ix_invoices_org_status_issue'),
        'invoices',
        ['organization_id', 'status', 'issue_date'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_invoices_org_status_issue'), table_name='invoices')
    op.drop_index(op.f('ix_payments_org_status_date'), table_name='payments')
