"""add customer_extra_settings JSON blob to billing_configurations

Backs Customer Settings' "Require Billing Address" / "Require Tax ID"
preferences, which had no storage and so were display-only. Same typed-JSON-blob
pattern as pricing_extra_settings (f2b8d4a6c1e3).

Revision ID: c3d9e1a7b5f2
Revises: b7e2d9c4a1f8
Create Date: 2026-10-13

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3d9e1a7b5f2"
down_revision: Union[str, Sequence[str], None] = "b7e2d9c4a1f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "billing_configurations",
        sa.Column("customer_extra_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.alter_column("billing_configurations", "customer_extra_settings", server_default=None)


def downgrade() -> None:
    op.drop_column("billing_configurations", "customer_extra_settings")
