"""ZB-TAX-ARCH-001 Phase 5d PR 2: two-person tenant MFA reset

super_admin_mfa (one row per user with MFA, now opt-in for tenant users)
gains the pending reset: reset_requested_by, reset_requested_at,
reset_reason. A second org admin of the same organization approves it.

Revision ID: e6b1d3f5a7c9
Revises: d4a8c2e6f1b9
Create Date: 2026-11-06
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'e6b1d3f5a7c9'
down_revision: Union[str, Sequence[str], None] = 'd4a8c2e6f1b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "super_admin_mfa"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _has_column(c: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(TABLE) and c in {x["name"] for x in insp.get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column("reset_requested_by"):
        if _is_postgres():
            op.add_column(TABLE, sa.Column("reset_requested_by", sa.Integer(),
                                           sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
        else:                                       # SQLite cannot ALTER in a foreign key
            op.add_column(TABLE, sa.Column("reset_requested_by", sa.Integer(), nullable=True))
    if not _has_column("reset_requested_at"):
        op.add_column(TABLE, sa.Column("reset_requested_at", sa.DateTime(), nullable=True))
    if not _has_column("reset_reason"):
        op.add_column(TABLE, sa.Column("reset_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    for name in ("reset_reason", "reset_requested_at", "reset_requested_by"):
        if _has_column(name):
            op.drop_column(TABLE, name)
