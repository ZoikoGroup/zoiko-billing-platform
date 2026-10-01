"""merge heads: auto_send_invoices + refund/write_off status indexes

Two migrations were written independently against the same parent
(73e2ebbe6aad) by parallel branches (main's a1c9d3e7f5b2 and rugvedh's
a4c8e2f6b1d9), producing two divergent heads once merged — `alembic upgrade
head` fails outright ("Multiple head revisions are present") until they're
joined back into one. No-op merge point; neither migration's contents
change.

Revision ID: 8b2b6f10e693
Revises: a1c9d3e7f5b2, a4c8e2f6b1d9
Create Date: 2026-09-28 21:48:32.755744

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8b2b6f10e693'
down_revision: Union[str, Sequence[str], None] = ('a1c9d3e7f5b2', 'a4c8e2f6b1d9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
