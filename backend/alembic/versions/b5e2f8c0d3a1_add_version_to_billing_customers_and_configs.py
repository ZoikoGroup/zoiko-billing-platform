"""add optimistic-lock version to billing_customers and billing_configurations

CRIT-Q17 (option 1) remediation: give BillingCustomer and BillingConfiguration
a real optimistic-lock `version` integer so the AI action engine's stale-write
guard can pin a concrete version at preview time and detect any change (human
or automatic) before confirm/execute.

Design contract (review artifact only — NOT applied to any database):
- Fresh rows start at version = 1 (model `default=1` + `server_default=1`).
- version is bumped EXPLICITLY at the service/repository layer (repo `_apply`/
  `save`, and the exchange-rate mutators) — never by an ORM `onupdate` hook,
  so a bulk Query.update()/raw-SQL path cannot silently skip the bump.
- Backfill: every existing row is set to 1, then the column is made NOT NULL.

Revision ID: b5e2f8c0d3a1
Revises: a3c7e91f4d28
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b5e2f8c0d3a1"
down_revision: Union[str, Sequence[str], None] = "a3c7e91f4d28"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _add_version(table: str) -> None:
    bind = op.get_bind()
    is_sqlite = bind.dialect.name == "sqlite"

    # Postgres cannot add a NOT NULL column to a populated table without a
    # constant default; SQLite CAN add NOT NULL DEFAULT in one step (existing
    # rows get the default). Handle each dialect accordingly.
    if is_sqlite:
        op.add_column(
            table,
            sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        )
        return

    # 1) Add nullable + server_default so existing rows materialize 1.
    op.add_column(
        table,
        sa.Column("version", sa.Integer(), nullable=True, server_default=sa.text("1")),
    )
    # 2) Backfill any rows that predate the server_default (defensive; should
    #    be empty after step 1, but guarantees no NULL is ever left behind).
    op.execute(f"UPDATE {table} SET version = 1 WHERE version IS NULL")
    # 3) Enforce NOT NULL now that every row is populated.
    op.alter_column(table, "version", existing_type=sa.Integer(), nullable=False)


def upgrade() -> None:
    """Add and backfill the version column on both financial resources."""
    _add_version("billing_customers")
    _add_version("billing_configurations")


def downgrade() -> None:
    """Remove the version columns (rollback of an unreleased change only)."""
    op.drop_column("billing_configurations", "version")
    op.drop_column("billing_customers", "version")
