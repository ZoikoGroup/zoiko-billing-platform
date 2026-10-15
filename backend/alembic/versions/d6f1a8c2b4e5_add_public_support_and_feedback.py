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


# Idempotent guards: some databases (incl. production) already have parts of
# this schema — created outside Alembic or by a partially applied run — while
# alembic_version doesn't record this revision. Every step checks first, so the
# migration converges on the target schema instead of failing on duplicates.
def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(table: str) -> bool:
    return _inspector().has_table(table)


def _has_column(table: str, column: str) -> bool:
    return _has_table(table) and column in {c["name"] for c in _inspector().get_columns(table)}


def _has_index(table: str, index: str) -> bool:
    return _has_table(table) and index in {i["name"] for i in _inspector().get_indexes(table)}


def _add_column(table: str, column: sa.Column) -> None:
    if not _has_column(table, column.name):
        op.add_column(table, column)


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if not _has_index(table, name):
        op.create_index(name, table, columns, unique=unique)


def _drop_index(name: str, table: str) -> None:
    if _has_index(table, name):
        op.drop_index(name, table_name=table)


def _drop_column(table: str, column: str) -> None:
    if _has_column(table, column):
        op.drop_column(table, column)


def _drop_table(table: str) -> None:
    if _has_table(table):
        op.drop_table(table)


def upgrade() -> None:
    """Upgrade schema."""
    _add_column('ai_public_assistant_message', sa.Column('idempotency_key', sa.String(length=64), nullable=True))
    # f6b2d1e8c4a7 later replaces this with a unique index; don't recreate the
    # non-unique one if the database is already past that point.
    if not _has_index('ai_public_assistant_message', 'uq_ai_public_msg_session_idem'):
        _create_index('ix_ai_public_msg_session_idem', 'ai_public_assistant_message', ['session_id', 'idempotency_key'])

    if not _has_table('ai_public_support_request'):
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
    _create_index(op.f('ix_ai_public_support_request_id'), 'ai_public_support_request', ['id'])
    _create_index(op.f('ix_ai_public_support_request_reference'), 'ai_public_support_request', ['reference'], unique=True)
    _create_index(op.f('ix_ai_public_support_request_session_uid'), 'ai_public_support_request', ['session_uid'])

    if not _has_table('ai_public_assistant_feedback'):
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
    _create_index(op.f('ix_ai_public_assistant_feedback_id'), 'ai_public_assistant_feedback', ['id'])
    _create_index(op.f('ix_ai_public_assistant_feedback_session_uid'), 'ai_public_assistant_feedback', ['session_uid'])
    _create_index(op.f('ix_ai_public_assistant_feedback_message_uid'), 'ai_public_assistant_feedback', ['message_uid'])


def downgrade() -> None:
    """Downgrade schema."""
    _drop_index(op.f('ix_ai_public_assistant_feedback_message_uid'), 'ai_public_assistant_feedback')
    _drop_index(op.f('ix_ai_public_assistant_feedback_session_uid'), 'ai_public_assistant_feedback')
    _drop_index(op.f('ix_ai_public_assistant_feedback_id'), 'ai_public_assistant_feedback')
    _drop_table('ai_public_assistant_feedback')

    _drop_index(op.f('ix_ai_public_support_request_session_uid'), 'ai_public_support_request')
    _drop_index(op.f('ix_ai_public_support_request_reference'), 'ai_public_support_request')
    _drop_index(op.f('ix_ai_public_support_request_id'), 'ai_public_support_request')
    _drop_table('ai_public_support_request')

    _drop_index('ix_ai_public_msg_session_idem', 'ai_public_assistant_message')
    _drop_column('ai_public_assistant_message', 'idempotency_key')
