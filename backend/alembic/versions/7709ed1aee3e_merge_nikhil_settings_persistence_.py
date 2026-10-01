"""merge nikhil settings-persistence branch with main

Revision ID: 7709ed1aee3e
Revises: f092a8c6d3e1, f2b8d4a6c1e3
Create Date: 2026-09-19 13:54:16.219556

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7709ed1aee3e'
down_revision: Union[str, Sequence[str], None] = ('f092a8c6d3e1', 'f2b8d4a6c1e3')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
