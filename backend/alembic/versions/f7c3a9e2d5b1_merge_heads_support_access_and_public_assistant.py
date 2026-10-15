"""merge heads: support-access credentials + public assistant support

Revision ID: f7c3a9e2d5b1
Revises: e3a7c9f1b4d2, e5b2c8d1f4a6
Create Date: 2026-10-15

Two branches landed in parallel:
  - e3a7c9f1b4d2: public assistant support/feedback + session expiry (main)
  - e5b2c8d1f4a6: support access temporary tenant credentials (rugvedh)

They touch disjoint tables (chatbot/public support vs users.access_expires_at
and privileged_tenant_access_grants), so the merge needs no operations of its
own; it only restores a single head so `alembic upgrade head` works.
"""
from typing import Sequence, Union


revision: str = 'f7c3a9e2d5b1'
down_revision: Union[str, Sequence[str], None] = ('e3a7c9f1b4d2', 'e5b2c8d1f4a6')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
