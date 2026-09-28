"""add auto_send_invoices to billing_configurations

Bug 51 (Invoice Settings 'Save Changes' silently failed): the deprecated
Invoice Settings page (frontend/src/modules/billing/invoicing/settings.jsx)
posts an "Auto-Send Invoices" toggle that BillingConfigurationUpdate had no
matching field for at all -- unlike auto_send_receipts, which already has a
real column right next to where this one belongs. Pydantic's exclude_unset
silently dropped the field on every save (same root-cause family as
e5a1c3f7b9d2/f2b8d4a6c1e3), so the toggle never persisted even though the
request otherwise "succeeded".

This one gets a first-class column (mirroring auto_send_receipts) rather
than an extra_settings JSON blob, since it's a permanent, well-defined
boolean setting rather than a value that doesn't fit an existing enum's
domain.

Revision ID: a1c9d3e7f5b2
Revises: 73e2ebbe6aad
Create Date: 2026-09-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1c9d3e7f5b2"
down_revision: Union[str, Sequence[str], None] = "73e2ebbe6aad"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "billing_configurations",
        sa.Column("auto_send_invoices", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.alter_column("billing_configurations", "auto_send_invoices", server_default=None)


def downgrade() -> None:
    op.drop_column("billing_configurations", "auto_send_invoices")
