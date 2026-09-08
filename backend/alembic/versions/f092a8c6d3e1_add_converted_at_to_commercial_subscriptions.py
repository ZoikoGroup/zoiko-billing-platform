"""add converted_at to commercial_subscriptions

Model (app/modules/commercial/models.py §5.2 trial->paid conversion) gained
commercial_subscriptions.converted_at in the "commercials gaps" change, but no
Alembic migration shipped with it. Any ORM SELECT on CommercialSubscription
(require_active_subscription -> _check_subscription, the subscriber gate on the
chatbot/billing routers) therefore raises

    psycopg.errors.UndefinedColumn: column commercial_subscriptions.converted_at
    does not exist

=> HTTP 500 on POST /api/chatbot/sessions (and every billing route) for any org
that owns a CommercialAccount. This migration repairs the drift.

Revision ID: f092a8c6d3e1
Revises: c7d1a9b3f2e4
Create Date: 2026-09-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f092a8c6d3e1"
down_revision: Union[str, Sequence[str], None] = "c7d1a9b3f2e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the trial->paid conversion timestamp column (nullable)."""
    op.add_column(
        "commercial_subscriptions",
        sa.Column("converted_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    """Remove the trial->paid conversion timestamp column."""
    op.drop_column("commercial_subscriptions", "converted_at")