"""add public session expiry + support/message idempotency enforcement

Extends the ZB-AI-PUB-001 public (unauthenticated) assistant schema:
  - ai_public_assistant_message: replace the non-unique (session_id,
    idempotency_key) index with a UNIQUE constraint so a concurrently-duplicated
    send is stopped at the database and replayed instead of creating twin turns
  - ai_public_support_request.client_request_id: client-minted idempotency key
    so a retried support submit (lost response) returns the original reference
    instead of creating a duplicate request

Deployment note: PUBLIC_ASSISTANT_MAX_SESSION_AGE_SECONDS (config) provides the
time-based session expiry; it needs no schema change.

Revision ID: f6b2d1e8c4a7
Revises: d6f1a8c2b4e5
Create Date: 2026-10-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f6b2d1e8c4a7'
down_revision: Union[str, Sequence[str], None] = 'd6f1a8c2b4e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_index('ix_ai_public_msg_session_idem', table_name='ai_public_assistant_message')
    op.create_index(
        'uq_ai_public_msg_session_idem',
        'ai_public_assistant_message',
        ['session_id', 'idempotency_key'],
        unique=True,
    )

    op.add_column(
        'ai_public_support_request',
        sa.Column('client_request_id', sa.String(length=64), nullable=True),
    )
    op.create_index(
        'uq_ai_public_support_client_request_id',
        'ai_public_support_request',
        ['client_request_id'],
        unique=True,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('uq_ai_public_support_client_request_id', table_name='ai_public_support_request')
    op.drop_column('ai_public_support_request', 'client_request_id')

    op.drop_index('uq_ai_public_msg_session_idem', table_name='ai_public_assistant_message')
    op.create_index(
        'ix_ai_public_msg_session_idem',
        'ai_public_assistant_message',
        ['session_id', 'idempotency_key'],
        unique=False,
    )