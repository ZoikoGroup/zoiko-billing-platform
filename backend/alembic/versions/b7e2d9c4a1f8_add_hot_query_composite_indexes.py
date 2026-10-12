"""add composite indexes for hot list/filter queries (additive only)

Indexes added (no column, constraint or data changes):

  ix_invoices_org_deleted_created   invoices (organization_id, deleted_at, created_at DESC)
  ix_invoices_org_status            invoices (organization_id, status)
  ix_payments_org_created           payments (organization_id, created_at DESC)
  ix_attention_items_status_severity attention_items (status, severity)
  ix_billing_customers_org_deleted  billing_customers (organization_id, deleted_at)

Deliberately NOT added (already served by existing indexes, verified against
pg_indexes on the live DB): platform_audit_logs.created_at
(ix_platform_audit_logs_created_at), billing_audit_logs.timestamp
(ix_billing_audit_logs_timestamp), job_run_logs (job_name, started_at)
(ix_job_run_logs_job_started; a btree is scanned backward for DESC).

Write cost: every index adds one btree insert per row write and extra
storage. invoices and payments are the heaviest-insert tables here (and
invoices.status is updated on every state transition, which defeats HOT
updates for rows touching an indexed column); attention_items.status is
updated on each lifecycle step. Volumes are modest today, so the cost is
small, but do not pile further indexes on these tables without evidence.

Postgres: built with CREATE INDEX CONCURRENTLY IF NOT EXISTS inside an
autocommit block (does not block writes; cannot run in a transaction).
If a CONCURRENTLY build is interrupted it leaves an INVALID index which
IF NOT EXISTS will then skip; drop it (DROP INDEX CONCURRENTLY <name>) and
re-run. Other dialects (SQLite tests): plain CREATE INDEX IF NOT EXISTS
(DESC is honoured by SQLite). Fully idempotent; downgrade drops IF EXISTS.

Revision ID: b7e2d9c4a1f8
Revises: 6a17bacad9bb
Create Date: 2026-10-12

"""
from typing import Sequence, Union

from alembic import op


revision: str = "b7e2d9c4a1f8"
down_revision: Union[str, Sequence[str], None] = "6a17bacad9bb"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (index name, table, column list SQL)
INDEXES = [
    ("ix_invoices_org_deleted_created", "invoices", "organization_id, deleted_at, created_at DESC"),
    ("ix_invoices_org_status", "invoices", "organization_id, status"),
    ("ix_payments_org_created", "payments", "organization_id, created_at DESC"),
    ("ix_attention_items_status_severity", "attention_items", "status, severity"),
    ("ix_billing_customers_org_deleted", "billing_customers", "organization_id, deleted_at"),
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            for name, table, cols in INDEXES:
                op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} ({cols})")
    else:
        for name, table, cols in INDEXES:
            op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({cols})")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            for name, _table, _cols in INDEXES:
                op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
    else:
        for name, _table, _cols in INDEXES:
            op.execute(f"DROP INDEX IF EXISTS {name}")
