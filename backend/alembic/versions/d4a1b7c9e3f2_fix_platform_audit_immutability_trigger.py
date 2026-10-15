"""fix platform_audit_logs immutability trigger

Revision ID: d4a1b7c9e3f2
Revises: c3f9d1a4e2b5
Create Date: 2026-10-15

The trigger from c3f9d1a4e2b5 broke every platform audit write on Postgres:

1. It compared the json columns (old_values, new_values, metadata) with
   IS DISTINCT FROM. Postgres has no equality operator for `json`, so every
   UPDATE failed with "operator does not exist: json = json".
2. It also forbade ANY change to prev_hash/row_hash, but
   PlatformAuditService.log_no_commit writes the hash chain with an UPDATE
   right after the INSERT (the hash covers the row's id and created_at, which
   only exist after insert). That first write was always rejected.

Net effect: every privileged action that records an audit row (support
access request/approve/deny/cancel/revoke/exit, breaker changes, ...) returned
HTTP 500. This replaces the function: json is compared as jsonb, and the hash
columns may be set exactly once (NULL -> value) but never changed after that,
so the tamper-evidence guarantee is unchanged.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4a1b7c9e3f2'
down_revision: Union[str, Sequence[str], None] = 'c3f9d1a4e2b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


FIXED_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION trg_platform_audit_logs_immutability_func()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'platform_audit_logs entries are immutable and cannot be deleted';
    END IF;
    IF (TG_OP = 'UPDATE') THEN
        IF (OLD.id != NEW.id OR
            OLD.action != NEW.action OR
            OLD.entity_type != NEW.entity_type OR
            OLD.entity_id IS DISTINCT FROM NEW.entity_id OR
            OLD.old_values::jsonb IS DISTINCT FROM NEW.old_values::jsonb OR
            OLD.new_values::jsonb IS DISTINCT FROM NEW.new_values::jsonb OR
            OLD.metadata::jsonb IS DISTINCT FROM NEW.metadata::jsonb OR
            OLD.actor_role IS DISTINCT FROM NEW.actor_role OR
            OLD.reason IS DISTINCT FROM NEW.reason OR
            OLD.correlation_id IS DISTINCT FROM NEW.correlation_id OR
            OLD.created_at != NEW.created_at) THEN
            RAISE EXCEPTION 'platform_audit_logs entries are immutable and content cannot be updated';
        END IF;
        -- The hash chain is written once, right after insert; never rewritten.
        IF (OLD.prev_hash IS NOT NULL AND OLD.prev_hash IS DISTINCT FROM NEW.prev_hash) OR
           (OLD.row_hash IS NOT NULL AND OLD.row_hash IS DISTINCT FROM NEW.row_hash) THEN
            RAISE EXCEPTION 'platform_audit_logs hash chain values cannot be changed once set';
        END IF;
        IF (OLD.actor_id IS NOT NULL AND NEW.actor_id IS NOT NULL AND OLD.actor_id != NEW.actor_id) THEN
            RAISE EXCEPTION 'platform_audit_logs actor_id can only be set to NULL';
        END IF;
        IF (OLD.organization_id IS NOT NULL AND NEW.organization_id IS NOT NULL AND OLD.organization_id != NEW.organization_id) THEN
            RAISE EXCEPTION 'platform_audit_logs organization_id can only be set to NULL';
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(sa.text(FIXED_FUNCTION_SQL))


def downgrade() -> None:
    # Deliberately a no-op: restoring the broken function would make every
    # platform audit write fail again.
    pass
