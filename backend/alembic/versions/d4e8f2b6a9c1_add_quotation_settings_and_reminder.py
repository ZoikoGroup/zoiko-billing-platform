"""quotation settings blob + expiry reminder marker

Backs Quotation Settings' Customer Acceptance Required, Discount Approval
Threshold and Expiry Reminder Days (billing_configurations.quotation_extra_settings)
and records when a quote's expiry reminder was sent (quotations.expiry_reminder_sent_at).

Revision ID: d4e8f2b6a9c1
Revises: c3d9e1a7b5f2
Create Date: 2026-10-13

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e8f2b6a9c1"
down_revision: Union[str, Sequence[str], None] = "c3d9e1a7b5f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "billing_configurations",
        sa.Column("quotation_extra_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.alter_column("billing_configurations", "quotation_extra_settings", server_default=None)
    op.add_column("quotations", sa.Column("expiry_reminder_sent_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("quotations", "expiry_reminder_sent_at")
    op.drop_column("billing_configurations", "quotation_extra_settings")
