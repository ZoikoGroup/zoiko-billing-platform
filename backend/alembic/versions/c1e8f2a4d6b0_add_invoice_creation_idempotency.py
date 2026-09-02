"""add tenant-scoped invoice creation idempotency

Revision ID: c1e8f2a4d6b0
Revises: 7b4c1d9e2f10
Create Date: 2026-09-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c1e8f2a4d6b0"
down_revision: Union[str, Sequence[str], None] = "7b4c1d9e2f10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Store a request key and fingerprint for safe invoice retries."""
    op.add_column(
        "invoices",
        sa.Column("idempotency_key", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "invoices",
        sa.Column("idempotency_request_hash", sa.String(length=64), nullable=True),
    )
    op.create_unique_constraint(
        "uq_invoices_org_idempotency_key",
        "invoices",
        ["organization_id", "idempotency_key"],
    )


def downgrade() -> None:
    """Remove invoice creation idempotency storage."""
    op.drop_constraint(
        "uq_invoices_org_idempotency_key",
        "invoices",
        type_="unique",
    )
    op.drop_column("invoices", "idempotency_request_hash")
    op.drop_column("invoices", "idempotency_key")
