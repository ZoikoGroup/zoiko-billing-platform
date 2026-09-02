"""add account-level login lockout fields

Revision ID: d4f7a9c2b1e6
Revises: c1e8f2a4d6b0
Create Date: 2026-09-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4f7a9c2b1e6"
down_revision: Union[str, Sequence[str], None] = "c1e8f2a4d6b0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Persist per-account failed-login state for distributed lockout."""
    op.add_column(
        "users",
        sa.Column(
            "failed_login_attempts",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "users",
        sa.Column("login_locked_until", sa.DateTime(), nullable=True),
    )
    op.alter_column("users", "failed_login_attempts", server_default=None)


def downgrade() -> None:
    """Remove persisted account-level login lockout state."""
    op.drop_column("users", "login_locked_until")
    op.drop_column("users", "failed_login_attempts")
