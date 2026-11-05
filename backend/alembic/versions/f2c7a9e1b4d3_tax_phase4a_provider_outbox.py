"""ZB-TAX-ARCH-001 Phase 4a-1: provider issuance outbox, circuits, heartbeats

Tenant (retained tax evidence):
  1. tax_provider_outbox — one row per provider operation (COMMIT, VOID,
     LINK) with a fixed idempotency key; at most one active COMMIT per
     invoice (partial unique index).

Platform (no tenant data):
  2. tax_provider_circuits — circuit breaker / suspension per provider.
  3. tax_job_heartbeats — reconciliation heartbeat; stale blocks issuing.

Postgres-only guards (frozen copies): the tenant record guard on the outbox
(key fields frozen from insert, DELETE only under the erasure flag) and a
terminal-state guard (DONE, FAILED, VOIDED rows never change).

No data is written. Downgrade drops everything above.

Revision ID: f2c7a9e1b4d3
Revises: e4b8c1d6f2a9
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import CircuitState, OutboxOperation, OutboxState

revision: str = 'f2c7a9e1b4d3'
down_revision: Union[str, Sequence[str], None] = 'e4b8c1d6f2a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
TS = sa.DateTime(timezone=True)
_ACTIVE_SQL = "operation = 'COMMIT' AND state IN ('PENDING', 'UNCERTAIN', 'REMOTE_COMMITTED')"
_FROZEN = ("organization_id", "invoice_id", "tax_quote_id", "operation", "provider_name", "idempotency_key",
           "created_by", "created_at")


def _has_table(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _fk(target, ondelete="RESTRICT"):
    return sa.ForeignKey(target, ondelete=ondelete)


_TERMINAL_FN = """
CREATE OR REPLACE FUNCTION tax_provider_outbox_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('DONE', 'FAILED', 'VOIDED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax_provider_outbox % is % and final', OLD.id, OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def upgrade() -> None:
    if not _has_table("tax_provider_outbox"):
        op.create_table(
            "tax_provider_outbox",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False),
            sa.Column("invoice_id", sa.Integer(), _fk("invoices.id"), nullable=False),
            sa.Column("tax_quote_id", sa.Integer(), _fk("tax_quotes.id"), nullable=False),
            sa.Column("operation", CIE(OutboxOperation), nullable=False),
            sa.Column("provider_name", sa.String(100), nullable=False),
            sa.Column("idempotency_key", sa.String(255), nullable=False),
            sa.Column("document_reference", sa.String(255), nullable=True),
            sa.Column("state", CIE(OutboxState), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("next_attempt_at", TS, nullable=True),
            sa.Column("grace_deadline", TS, nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("provider_transaction_id", sa.String(255), nullable=True),
            sa.Column("remote_snapshot", sa.JSON(), nullable=True),
            sa.Column("review_reason", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Integer(), _fk("users.id", "SET NULL"), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("updated_at", TS, nullable=True),
            sa.Column("completed_at", TS, nullable=True),
            sa.UniqueConstraint("idempotency_key", name="uq_tax_provider_outbox_idempotency_key"),
        )
        op.create_index("ix_tax_provider_outbox_id", "tax_provider_outbox", ["id"])
        op.create_index("ix_tax_provider_outbox_organization_id", "tax_provider_outbox", ["organization_id"])
        op.create_index("ix_tax_provider_outbox_invoice_id", "tax_provider_outbox", ["invoice_id"])
        op.create_index("ix_tax_provider_outbox_tax_quote_id", "tax_provider_outbox", ["tax_quote_id"])
        op.create_index("ix_tax_provider_outbox_state", "tax_provider_outbox", ["state"])
        op.create_index("uq_tax_provider_outbox_one_active_commit", "tax_provider_outbox", ["invoice_id"],
                        unique=True, sqlite_where=sa.text(_ACTIVE_SQL), postgresql_where=sa.text(_ACTIVE_SQL))
    if not _has_table("tax_provider_circuits"):
        op.create_table(
            "tax_provider_circuits",
            sa.Column("provider_name", sa.String(100), primary_key=True),
            sa.Column("state", CIE(CircuitState), nullable=False),
            sa.Column("failure_count", sa.Integer(), nullable=False),
            sa.Column("window_started_at", TS, nullable=True),
            sa.Column("opened_at", TS, nullable=True),
            sa.Column("suspended_reason", sa.Text(), nullable=True),
            sa.Column("updated_at", TS, nullable=True),
        )
    if not _has_table("tax_job_heartbeats"):
        op.create_table(
            "tax_job_heartbeats",
            sa.Column("job_name", sa.String(100), primary_key=True),
            sa.Column("last_started_at", TS, nullable=True),
            sa.Column("last_finished_at", TS, nullable=True),
            sa.Column("last_ok", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("stats", sa.JSON(), nullable=True),
        )
    if _is_postgres():
        # tax_tenant_record_guard() exists since Phase 2.
        op.execute("DROP TRIGGER IF EXISTS trg_tax_provider_outbox_guard ON tax_provider_outbox")
        op.execute("CREATE TRIGGER trg_tax_provider_outbox_guard BEFORE UPDATE OR DELETE ON tax_provider_outbox "
                   f"FOR EACH ROW EXECUTE FUNCTION tax_tenant_record_guard('{','.join(_FROZEN)}', '*')")
        op.execute(_TERMINAL_FN)
        op.execute("DROP TRIGGER IF EXISTS trg_tax_provider_outbox_terminal_guard ON tax_provider_outbox")
        op.execute("CREATE TRIGGER trg_tax_provider_outbox_terminal_guard BEFORE UPDATE ON tax_provider_outbox "
                   "FOR EACH ROW EXECUTE FUNCTION tax_provider_outbox_terminal_guard()")


def downgrade() -> None:
    for table in ("tax_job_heartbeats", "tax_provider_circuits", "tax_provider_outbox"):
        if _has_table(table):
            op.drop_table(table)
    if _is_postgres():
        op.execute("DROP FUNCTION IF EXISTS tax_provider_outbox_terminal_guard()")
