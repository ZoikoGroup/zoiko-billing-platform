"""add tenant-scoped subscription creation idempotency

Revision ID: 7b4c1d9e2f10
Revises: 4f990f372281
Create Date: 2026-09-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7b4c1d9e2f10"
down_revision: Union[str, Sequence[str], None] = "4f990f372281"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Store a request key and fingerprint for safe subscription retries."""
    op.add_column(
        "subscriptions",
        sa.Column("idempotency_key", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "subscriptions",
        sa.Column("idempotency_request_hash", sa.String(length=64), nullable=True),
    )
    op.create_unique_constraint(
        "uq_subscriptions_org_idempotency_key",
        "subscriptions",
        ["organization_id", "idempotency_key"],
    )


def downgrade() -> None:
    """Remove subscription creation idempotency storage."""
    op.drop_constraint(
        "uq_subscriptions_org_idempotency_key",
        "subscriptions",
        type_="unique",
    )
    op.drop_column("subscriptions", "idempotency_request_hash")
    op.drop_column("subscriptions", "idempotency_key")
