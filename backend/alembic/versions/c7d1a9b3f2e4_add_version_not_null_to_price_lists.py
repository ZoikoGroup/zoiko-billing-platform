"""add optimizer-version NOT NULL + default to price_lists.version

CRIT-Q17b remediation: PriceList.version was a dead "safety" column —
`Column(Integer, default=1)` (nullable, ORM-default only, no server_default),
never incremented by any write path. The code fix now bumps it explicitly at
the repository/service layer; this migration makes the column robust in the DB:

- The column ALREADY EXISTS in `price_lists` (unlike Migration A, which added
  fresh columns). So this does NOT add it — it hardens the existing one:
  1. SET DEFAULT 1 (so future raw/Server-side inserts get a default, not NULL),
  2. backfill any existing NULL rows to 1,
  3. SET NOT NULL (enforce the same invariant as the model).

Design contract (review artifact only — NOT applied to any database):
- Fresh rows start at version = 1 (model `default=1` + now `server_default=1`).
- Postgres-aware: uses `ALTER COLUMN ... SET DEFAULT / SET NOT NULL` plus an
  explicit backfill UPDATE. SQLite has no native ALTER COLUMN and never runs
  Alembic migrations (test DBs build from `create_all`), so its branch is a
  safe no-op.
- Rollback (downgrade) restores the prior nullable, no-default state.

Revision ID: c7d1a9b3f2e4
Revises: b5e2f8c0d3a1
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7d1a9b3f2e4"
down_revision: Union[str, Sequence[str], None] = "b5e2f8c0d3a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "price_lists"


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        # SQLite test DBs build schema from models via create_all() (which now
        # emits a NOT NULL DEFAULT 1 column); Alembic migrations are not run
        # against them, and SQLite has no ALTER COLUMN. No-op for safety.
        return

    # 1) Existing rows predating any default must land at 1, never NULL.
    op.execute(f"UPDATE {_TABLE} SET version = 1 WHERE version IS NULL")
    # 2) Give the column a DB-level default so future raw inserts get 1.
    op.alter_column(
        _TABLE,
        "version",
        existing_type=sa.Integer(),
        existing_nullable=True,
        server_default=sa.text("1"),
    )
    # 3) Enforce NOT NULL now that every row is populated.
    op.alter_column(
        _TABLE,
        "version",
        existing_type=sa.Integer(),
        nullable=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        return
    # Restore the prior nullable, no-DB-default state (rollback of an
    # unreleased change only).
    op.alter_column(
        _TABLE,
        "version",
        existing_type=sa.Integer(),
        server_default=None,
    )
    op.alter_column(
        _TABLE,
        "version",
        existing_type=sa.Integer(),
        nullable=True,
    )
