"""backfill NULL platform_role for super admins (GOV-01)

Revision ID: a7c3e91d4b52
Revises: f6731b8027fb
Create Date: 2026-10-15 10:00:00.000000

A NULL users.platform_role used to be treated implicitly as
platform_administrator. From this revision on a NULL role grants NO platform
capabilities (core/capabilities.py), so every existing super admin that still
has NULL is made an explicit platform_administrator to preserve their access.

Additive and idempotent: only rows with role='super_admin' AND platform_role
IS NULL are touched; re-running changes nothing.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c3e91d4b52'
down_revision: Union[str, Sequence[str], None] = 'f6731b8027fb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "platform_role" not in cols:
        return
    # Stored form: CaseInsensitiveEnum persists the enum NAME (upper-case); role is compared
    # case-insensitively to tolerate legacy value-cased rows.
    bind.execute(sa.text(
        "UPDATE users SET platform_role = 'PLATFORM_ADMINISTRATOR' "
        "WHERE platform_role IS NULL AND LOWER(CAST(role AS VARCHAR(50))) = 'super_admin'"
    ))


def downgrade() -> None:
    # Intentional no-op: we cannot tell backfilled rows from explicitly
    # assigned platform_administrator rows, and restoring NULL would silently
    # strip access under the new model.
    pass
