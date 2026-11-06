"""ZB-TAX-ARCH-001 Phase 5c PR 3: governed mode change on a provider connection

A connection moves between ESTIMATE_ONLY (safe mode: quotes, never issues)
and COMMIT through a proposal approved by a different finance approver,
keeping the same connection and credentials.

  * tax_provider_connections gains the pending change (mode_change_to,
    _requested_by, _requested_at, _reason) and the last decision
    (mode_changed_by, mode_changed_at).
  * `mode` leaves the general frozen-field guard and gets its own trigger:
    it may change only to the pending target, in the same update that
    records a decider (mode_changed_by, a new mode_changed_at) who is not
    the requester. Any other UPDATE of `mode` is refused.

Revision ID: d4a8c2e6f1b9
Revises: c9f1e3a5b7d2
Create Date: 2026-11-06
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'd4a8c2e6f1b9'
down_revision: Union[str, Sequence[str], None] = 'c9f1e3a5b7d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "tax_provider_connections"
FROZEN_BEFORE = ("organization_id", "seller_entity_id", "provider_name", "environment", "mode", "proposed_by",
                 "created_at")
FROZEN_AFTER = ("organization_id", "seller_entity_id", "provider_name", "environment", "proposed_by", "created_at")
USER_COLUMNS = ("mode_change_requested_by", "mode_changed_by")
TS = sa.DateTime(timezone=True)

MODE_GUARD = """
CREATE OR REPLACE FUNCTION tax_provider_connection_mode_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    IF OLD.mode_change_to IS NULL OR NEW.mode IS DISTINCT FROM OLD.mode_change_to
       OR OLD.mode_change_requested_by IS NULL OR NEW.mode_changed_by IS NULL
       OR NEW.mode_changed_by = OLD.mode_change_requested_by
       OR NEW.mode_changed_at IS NOT DISTINCT FROM OLD.mode_changed_at THEN
      RAISE EXCEPTION 'provider connection % changes mode only through an approved mode change decided by a second person', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _has_column(c: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(TABLE) and c in {x["name"] for x in insp.get_columns(TABLE)}


def _guard(fields: tuple) -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_{TABLE}_guard ON {TABLE}")
    op.execute(f"CREATE TRIGGER trg_{TABLE}_guard BEFORE UPDATE OR DELETE ON {TABLE} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")


def upgrade() -> None:
    columns = [
        sa.Column("mode_change_to", sa.String(20), nullable=True),
        sa.Column("mode_change_requested_at", TS, nullable=True),
        sa.Column("mode_change_reason", sa.Text(), nullable=True),
        sa.Column("mode_changed_at", TS, nullable=True),
    ]
    for name in USER_COLUMNS:
        if _is_postgres():
            columns.append(sa.Column(name, sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
        else:                                       # SQLite cannot ALTER in a foreign key
            columns.append(sa.Column(name, sa.Integer(), nullable=True))
    for column in columns:
        if not _has_column(column.name):
            op.add_column(TABLE, column)
    if _is_postgres():
        _guard(FROZEN_AFTER)
        op.execute(MODE_GUARD)
        op.execute(f"DROP TRIGGER IF EXISTS trg_{TABLE}_mode_guard ON {TABLE}")
        op.execute(f"CREATE TRIGGER trg_{TABLE}_mode_guard BEFORE UPDATE ON {TABLE} FOR EACH ROW "
                   "EXECUTE FUNCTION tax_provider_connection_mode_guard()")


def downgrade() -> None:
    if _is_postgres():
        op.execute(f"DROP TRIGGER IF EXISTS trg_{TABLE}_mode_guard ON {TABLE}")
        op.execute("DROP FUNCTION IF EXISTS tax_provider_connection_mode_guard()")
        _guard(FROZEN_BEFORE)
    for name in ("mode_change_to", "mode_change_requested_at", "mode_change_reason", "mode_changed_at") + USER_COLUMNS:
        if _has_column(name):
            op.drop_column(TABLE, name)
