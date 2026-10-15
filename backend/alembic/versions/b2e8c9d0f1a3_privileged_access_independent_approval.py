"""independent approval revocation and break glass for privileged access

Revision ID: b2e8c9d0f1a3
Revises: a7c3e91d4b52
Create Date: 2026-10-15 10:15:00.000000

ZB-SEC-PRIV-001 / GOV-04, GOV-07, PRV-01, PRV-02, PRV-04, IAM-04, IAM-06, AUD-04
- Add approval, revocation, break-glass, review, and tenant approval columns to privileged_tenant_access_grants
- Add CHECK constraint on privileged_tenant_access_grants preventing self-approval
- Add require_tenant_approval_for_support_access to organizations
- Update native Postgres enum for privilegedaccessstatus if existing
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2e8c9d0f1a3'
down_revision: Union[str, Sequence[str], None] = 'a7c3e91d4b52'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


NEW_STATUS_VALUES = [
    'PENDING_APPROVAL',
    'APPROVED',
    'REVOKED',
    'EXPIRED_UNUSED',
]


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # If running against Postgres with a native enum type, only alter if the type exists
    if dialect == "postgresql":
        has_type = bind.execute(sa.text("SELECT 1 FROM pg_type WHERE typname = 'privilegedaccessstatus'")).scalar()
        if has_type:
            for val in NEW_STATUS_VALUES:
                try:
                    op.execute(sa.text(f"ALTER TYPE privilegedaccessstatus ADD VALUE IF NOT EXISTS '{val}'"))
                except Exception:
                    pass

    # Add columns to privileged_tenant_access_grants
    op.add_column('privileged_tenant_access_grants', sa.Column('approved_by_user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('approved_at', sa.DateTime(), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('approval_note', sa.Text(), nullable=True))

    op.add_column('privileged_tenant_access_grants', sa.Column('revoked_by_user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('revoked_by_tenant', sa.Boolean(), server_default='0', nullable=False))
    op.add_column('privileged_tenant_access_grants', sa.Column('revoked_at', sa.DateTime(), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('revoke_reason', sa.Text(), nullable=True))

    op.add_column('privileged_tenant_access_grants', sa.Column('is_break_glass', sa.Boolean(), server_default='0', nullable=False))
    op.add_column('privileged_tenant_access_grants', sa.Column('review_due_at', sa.DateTime(), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('reviewed_by_user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('reviewed_at', sa.DateTime(), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('review_outcome', sa.String(length=50), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('review_note', sa.Text(), nullable=True))

    op.add_column('privileged_tenant_access_grants', sa.Column('tenant_approved_by_user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('tenant_approved_at', sa.DateTime(), nullable=True))

    # Add CHECK constraint: approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id
    if dialect != "sqlite":
        op.create_check_constraint(
            'ck_privileged_access_no_self_approval',
            'privileged_tenant_access_grants',
            'approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id'
        )

    # Add require_tenant_approval_for_support_access to organizations
    op.add_column('organizations', sa.Column('require_tenant_approval_for_support_access', sa.Boolean(), server_default='0', nullable=False))


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    op.drop_column('organizations', 'require_tenant_approval_for_support_access')

    if dialect != "sqlite":
        op.drop_constraint('ck_privileged_access_no_self_approval', 'privileged_tenant_access_grants', type_='check')

    op.drop_column('privileged_tenant_access_grants', 'tenant_approved_at')
    op.drop_column('privileged_tenant_access_grants', 'tenant_approved_by_user_id')
    op.drop_column('privileged_tenant_access_grants', 'review_note')
    op.drop_column('privileged_tenant_access_grants', 'review_outcome')
    op.drop_column('privileged_tenant_access_grants', 'reviewed_at')
    op.drop_column('privileged_tenant_access_grants', 'reviewed_by_user_id')
    op.drop_column('privileged_tenant_access_grants', 'review_due_at')
    op.drop_column('privileged_tenant_access_grants', 'is_break_glass')

    op.drop_column('privileged_tenant_access_grants', 'revoke_reason')
    op.drop_column('privileged_tenant_access_grants', 'revoked_at')
    op.drop_column('privileged_tenant_access_grants', 'revoked_by_tenant')
    op.drop_column('privileged_tenant_access_grants', 'revoked_by_user_id')

    op.drop_column('privileged_tenant_access_grants', 'approval_note')
    op.drop_column('privileged_tenant_access_grants', 'approved_at')
    op.drop_column('privileged_tenant_access_grants', 'approved_by_user_id')

