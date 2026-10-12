"""merge heads: customer settings (BUG-13) + hot-query composite indexes

Both b13c5e7a9d21 (customer settings columns on billing_configurations) and
b7e2d9c4a1f8 (additive composite indexes) were branched from 6a17bacad9bb on
separate branches. They touch unrelated objects, so this revision only joins
the two heads; it has no schema operations of its own.

Revision ID: 92ffc75e89a0
Revises: b13c5e7a9d21, b7e2d9c4a1f8
Create Date: 2026-10-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '92ffc75e89a0'
down_revision: Union[str, Sequence[str], None] = ('b13c5e7a9d21', 'b7e2d9c4a1f8')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
