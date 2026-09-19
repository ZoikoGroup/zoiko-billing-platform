"""add previously-unbacked settings-page fields to billing_configurations

Several settings pages (Quotations, Pricing, Subscriptions, Payments) sent
field names that had no matching column on BillingConfiguration at all --
Pydantic silently dropped them from the update payload (no error, no 422),
so the PUT returned 200 "success" while nothing was actually persisted,
which is why values appeared to "disappear after refresh."

Adds:
- quote_terms_and_conditions (Quotation Settings' own terms field --
  previously the frontend wrote/read a key that doesn't exist anywhere;
  distinct from the Contract-domain default_terms_and_conditions)
- default_trial_days, default_pricing_strategy, default_billing_frequency
  (Pricing Settings)
- subscription_extra_settings, payment_extra_settings (JSON; Subscription
  Settings and Payment Settings are almost entirely composed of fields
  with no individual backing -- same shallow-merged-JSON-blob idiom
  already used for tax_preferences/tax_profiles on this same table,
  rather than one migration per field for ~35 fields across two pages)

Revision ID: e5a1c3f7b9d2
Revises: d4f7a9c2b1e6
Create Date: 2026-09-19

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5a1c3f7b9d2"
down_revision: Union[str, Sequence[str], None] = "d4f7a9c2b1e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("billing_configurations", sa.Column("quote_terms_and_conditions", sa.Text(), nullable=True))
    op.add_column(
        "billing_configurations",
        sa.Column("default_trial_days", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("default_pricing_strategy", sa.String(length=20), nullable=False, server_default=sa.text("'flat'")),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("default_billing_frequency", sa.String(length=20), nullable=False, server_default=sa.text("'monthly'")),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("subscription_extra_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("payment_extra_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.alter_column("billing_configurations", "default_trial_days", server_default=None)
    op.alter_column("billing_configurations", "default_pricing_strategy", server_default=None)
    op.alter_column("billing_configurations", "default_billing_frequency", server_default=None)
    op.alter_column("billing_configurations", "subscription_extra_settings", server_default=None)
    op.alter_column("billing_configurations", "payment_extra_settings", server_default=None)


def downgrade() -> None:
    op.drop_column("billing_configurations", "payment_extra_settings")
    op.drop_column("billing_configurations", "subscription_extra_settings")
    op.drop_column("billing_configurations", "default_billing_frequency")
    op.drop_column("billing_configurations", "default_pricing_strategy")
    op.drop_column("billing_configurations", "default_trial_days")
    op.drop_column("billing_configurations", "quote_terms_and_conditions")
