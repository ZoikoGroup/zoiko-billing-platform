"""add customer settings to billing_configurations

BUG-13 (/billing/customers/settings): Default Customer Type, Customer
Numbering Prefix/Format, Require Billing Address and Require Tax ID were shown
as read-only "Not configurable yet" values because BillingConfiguration had
nowhere to store them (BillingConfigurationUpdate silently ignored the keys).

First-class columns, like the other permanent, well-defined settings
(a1c9d3e7f5b2 auto_send_invoices; the product/contract settings columns):

  * default_customer_type      CustomerType enum name, default BUSINESS
  * customer_numbering_prefix  same rules as the other document prefixes
                               (<= 10 chars), default "CUST-"
  * customer_numbering_format  NumberFormat enum name, default PREFIX_SEQ
                               (the document-numbering grammar already used
                               for invoices/credit notes)
  * require_billing_address    boolean, default false
  * require_tax_id             boolean, default false

The server defaults are kept (they match the model) so every existing
organization keeps today's behaviour: "CUST-" codes, Business, nothing
required. Enum columns store the enum NAME, as CaseInsensitiveEnum does for
the existing invoice_number_format / invoice_sequence_reset columns.

Revision ID: b13c5e7a9d21
Revises: 6a17bacad9bb
Create Date: 2026-10-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b13c5e7a9d21"
down_revision: Union[str, Sequence[str], None] = "6a17bacad9bb"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "billing_configurations",
        sa.Column("default_customer_type", sa.String(), nullable=False, server_default="BUSINESS"),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("customer_numbering_prefix", sa.String(length=10), nullable=False, server_default="CUST-"),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("customer_numbering_format", sa.String(), nullable=False, server_default="PREFIX_SEQ"),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("require_billing_address", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "billing_configurations",
        sa.Column("require_tax_id", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("billing_configurations", "require_tax_id")
    op.drop_column("billing_configurations", "require_billing_address")
    op.drop_column("billing_configurations", "customer_numbering_format")
    op.drop_column("billing_configurations", "customer_numbering_prefix")
    op.drop_column("billing_configurations", "default_customer_type")
