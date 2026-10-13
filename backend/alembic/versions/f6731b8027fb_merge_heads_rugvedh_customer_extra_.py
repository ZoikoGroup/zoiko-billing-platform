"""merge heads: rugvedh customer extra settings + quotation reminder

Revision ID: f6731b8027fb
Revises: 92ffc75e89a0, d4e8f2b6a9c1
Create Date: 2026-10-13 14:38:43.821564

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6731b8027fb'
down_revision: Union[str, Sequence[str], None] = ('92ffc75e89a0', 'd4e8f2b6a9c1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
