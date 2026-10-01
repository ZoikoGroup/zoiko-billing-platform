"""add pricing_extra_settings JSON blob to billing_configurations

Follow-up to e5a1c3f7b9d2: Pricing Settings' "Rounding Rule" field
(nearest-increment values like "nearest_0.10") is not a valid member of
the existing strict `rounding_method` enum column, so it needs its own
home rather than either an invalid-enum write or a user-facing copy
change to match that enum's real values.

Revision ID: f2b8d4a6c1e3
Revises: e5a1c3f7b9d2
Create Date: 2026-09-19

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2b8d4a6c1e3"
down_revision: Union[str, Sequence[str], None] = "e5a1c3f7b9d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "billing_configurations",
        sa.Column("pricing_extra_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.alter_column("billing_configurations", "pricing_extra_settings", server_default=None)


def downgrade() -> None:
    op.drop_column("billing_configurations", "pricing_extra_settings")
