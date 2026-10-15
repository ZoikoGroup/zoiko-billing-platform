"""merge heads: public support/feedback + public session expiry idempotency

f6731b8027fb (rugvedh customer extra settings + quotation reminder merge) and
f6b2d1e8c4a7 (public session expiry + support/message idempotency) branched onto
separate heads. They touch unrelated objects, so this revision only joins the two
heads; it has no schema operations of its own.

Revision ID: e3a7c9f1b4d2
Revises: f6731b8027fb, f6b2d1e8c4a7
Create Date: 2026-10-15

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e3a7c9f1b4d2'
down_revision: Union[str, Sequence[str], None] = ('f6731b8027fb', 'f6b2d1e8c4a7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
