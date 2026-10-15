"""add public support request + feedback + message idempotency

Extends the ZB-AI-PUB-001 public (unauthenticated) assistant schema:
  - ai_public_assistant_message.idempotency_key: makes a retried public send
    idempotent, so a double-click or network retry never duplicates an exchange
  - ai_public_support_request: consent-gated human-support requests from the
    marketing widget (no tenant linkage; genuine reference minted on persist)
  - ai_public_assistant_feedback: optional, privacy-minimal helpful signal

Revision ID: d6f1a8c2b4e5
Revises: 6a17bacad9bb
Create Date: 2026-10-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd6f1a8c2b4e5'
down_revision: Union[str, Sequence[str], None] = '6a17bacad9bb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'ai_public_assistant_message',
        sa.Column('idempotency_key', sa.String(length=64), nullable=True),
    )
    op.create_index(
        'ix_ai_public_msg_session_idem',
        'ai_public_assistant_message',
        ['session_id', 'idempotency_key'],
        unique=False,
    )

    op.create_table(
        'ai_public_support_request',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('reference', sa.String(length=24), nullable=False),
        sa.Column('session_uid', sa.String(length=36), nullable=True),
        sa.Column('issue_type', sa.String(length=40), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('summary', sa.String(length=500), nullable=False),
        sa.Column('message', sa.Text(), nullable=True),
        sa.Column('transcript_consent', sa.Boolean(), server_default='0', nullable=False),
        sa.Column('transcript_excerpt', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=20), server_default='received', nullable=False),
        sa.Column('ip_hash', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP'), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_ai_public_support_request_id'), 'ai_public_support_request', ['id'], unique=False)
    op.create_index(op.f('ix_ai_public_support_request_reference'), 'ai_public_support_request', ['reference'], unique=True)
    op.create_index(op.f('ix_ai_public_support_request_session_uid'), 'ai_public_support_request', ['session_uid'], unique=False)

    op.create_table(
        'ai_public_assistant_feedback',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_uid', sa.String(length=36), nullable=True),
        sa.Column('message_uid', sa.String(length=36), nullable=True),
        sa.Column('helpful', sa.Boolean(), nullable=False),
        sa.Column('reason', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP'), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_ai_public_assistant_feedback_id'), 'ai_public_assistant_feedback', ['id'], unique=False)
    op.create_index(op.f('ix_ai_public_assistant_feedback_session_uid'), 'ai_public_assistant_feedback', ['session_uid'], unique=False)
    op.create_index(op.f('ix_ai_public_assistant_feedback_message_uid'), 'ai_public_assistant_feedback', ['message_uid'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_ai_public_assistant_feedback_message_uid'), table_name='ai_public_assistant_feedback')
    op.drop_index(op.f('ix_ai_public_assistant_feedback_session_uid'), table_name='ai_public_assistant_feedback')
    op.drop_index(op.f('ix_ai_public_assistant_feedback_id'), table_name='ai_public_assistant_feedback')
    op.drop_table('ai_public_assistant_feedback')

    op.drop_index(op.f('ix_ai_public_support_request_session_uid'), table_name='ai_public_support_request')
    op.drop_index(op.f('ix_ai_public_support_request_reference'), table_name='ai_public_support_request')
    op.drop_index(op.f('ix_ai_public_support_request_id'), table_name='ai_public_support_request')
    op.drop_table('ai_public_support_request')

    op.drop_index('ix_ai_public_msg_session_idem', table_name='ai_public_assistant_message')
    op.drop_column('ai_public_assistant_message', 'idempotency_key')
