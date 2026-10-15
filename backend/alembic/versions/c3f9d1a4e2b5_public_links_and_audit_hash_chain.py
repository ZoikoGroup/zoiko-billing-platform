"""public links expiry revocation and audit hash chain

Revision ID: c3f9d1a4e2b5
Revises: b2e8c9d0f1a3
Create Date: 2026-10-15 11:00:00.000000

ZB-SEC-PRIV-001 (Privacy Prompt 3 of 3) / FIN-07, AUD-01, AUD-02, AT-15
- Add public_link_version to invoices and quotations
- Add prev_hash and row_hash to platform_audit_logs
- Add immutability trigger for platform_audit_logs on PostgreSQL
- Update native Postgres enum for platformauditaction if existing
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3f9d1a4e2b5'
down_revision: Union[str, Sequence[str], None] = 'b2e8c9d0f1a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NEW_AUDIT_ACTIONS = [
    'PLATFORM_ACCESS_DENIED',
    'AUDIT_CHAIN_VERIFIED',
    'platform_access_denied',
    'audit_chain_verified',
]


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Add public_link_version to invoices and quotations
    op.add_column('invoices', sa.Column('public_link_version', sa.Integer(), server_default='1', nullable=False))
    op.add_column('quotations', sa.Column('public_link_version', sa.Integer(), server_default='1', nullable=False))

    # Add prev_hash and row_hash to platform_audit_logs
    op.add_column('platform_audit_logs', sa.Column('prev_hash', sa.String(length=64), nullable=True))
    op.add_column('platform_audit_logs', sa.Column('row_hash', sa.String(length=64), nullable=True))
    op.create_index('ix_platform_audit_logs_row_hash', 'platform_audit_logs', ['row_hash'])

    if dialect == "postgresql":
        has_type = bind.execute(sa.text("SELECT 1 FROM pg_type WHERE typname = 'platformauditaction'")).scalar()
        if has_type:
            for val in NEW_AUDIT_ACTIONS:
                try:
                    op.execute(sa.text(f"ALTER TYPE platformauditaction ADD VALUE IF NOT EXISTS '{val}'"))
                except Exception:
                    pass

        # Create trigger for tamper-evident immutability on platform_audit_logs
        trigger_sql = """
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
                    OLD.old_values IS DISTINCT FROM NEW.old_values OR
                    OLD.new_values IS DISTINCT FROM NEW.new_values OR
                    OLD.metadata IS DISTINCT FROM NEW.metadata OR
                    OLD.actor_role IS DISTINCT FROM NEW.actor_role OR
                    OLD.reason IS DISTINCT FROM NEW.reason OR
                    OLD.correlation_id IS DISTINCT FROM NEW.correlation_id OR
                    OLD.created_at != NEW.created_at OR
                    OLD.prev_hash IS DISTINCT FROM NEW.prev_hash OR
                    OLD.row_hash IS DISTINCT FROM NEW.row_hash) THEN
                    RAISE EXCEPTION 'platform_audit_logs entries are immutable and content cannot be updated';
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

        DROP TRIGGER IF EXISTS trg_platform_audit_logs_immutability ON platform_audit_logs;
        CREATE TRIGGER trg_platform_audit_logs_immutability
        BEFORE UPDATE OR DELETE ON platform_audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION trg_platform_audit_logs_immutability_func();
        """
        op.execute(sa.text(trigger_sql))


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        op.execute(sa.text("DROP TRIGGER IF EXISTS trg_platform_audit_logs_immutability ON platform_audit_logs;"))
        op.execute(sa.text("DROP FUNCTION IF EXISTS trg_platform_audit_logs_immutability_func;"))

    op.drop_index('ix_platform_audit_logs_row_hash', table_name='platform_audit_logs')
    op.drop_column('platform_audit_logs', 'row_hash')
    op.drop_column('platform_audit_logs', 'prev_hash')
    op.drop_column('quotations', 'public_link_version')
    op.drop_column('invoices', 'public_link_version')

