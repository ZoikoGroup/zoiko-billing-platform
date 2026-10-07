"""merge heads: ai_escalation_request + public assistant tables

Revision ID: 6a17bacad9bb
Revises: a9f3c2e8d1b4, c3d4e5f6a7b8
Create Date: 2026-10-07 13:16:11.384051

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6a17bacad9bb'
down_revision: Union[str, Sequence[str], None] = ('a9f3c2e8d1b4', 'c3d4e5f6a7b8')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
