"""support access: temporary tenant credentials

Revision ID: e5b2c8d1f4a6
Revises: d4a1b7c9e3f2
Create Date: 2026-10-15

When a tenant's organization admin approves a support access request, the
platform issues the requesting operator a temporary, read-only login for that
tenant, valid only for the requested number of minutes.

- users.access_expires_at: hard expiry for a temporary account. Login, token
  refresh and every authenticated request refuse the account once it passes,
  independently of the background job that deactivates it.
- privileged_tenant_access_grants.support_user_id / support_username /
  support_password_encrypted: the account issued for the grant. The password
  is stored encrypted (same key as MFA secrets) so the requester can re-read it
  while the session is active; the login itself only uses the bcrypt hash on
  the user row.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5b2c8d1f4a6'
down_revision: Union[str, Sequence[str], None] = 'd4a1b7c9e3f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('access_expires_at', sa.DateTime(), nullable=True))
    op.add_column(
        'privileged_tenant_access_grants',
        sa.Column('support_user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
    )
    op.add_column('privileged_tenant_access_grants', sa.Column('support_username', sa.String(length=200), nullable=True))
    op.add_column('privileged_tenant_access_grants', sa.Column('support_password_encrypted', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('privileged_tenant_access_grants', 'support_password_encrypted')
    op.drop_column('privileged_tenant_access_grants', 'support_username')
    op.drop_column('privileged_tenant_access_grants', 'support_user_id')
    op.drop_column('users', 'access_expires_at')
