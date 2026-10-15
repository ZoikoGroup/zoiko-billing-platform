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
    _drop_index('ix_ai_public_msg_session_idem', 'ai_public_assistant_message')
    _create_index('uq_ai_public_msg_session_idem', 'ai_public_assistant_message', ['session_id', 'idempotency_key'], unique=True)

    _add_column('ai_public_support_request', sa.Column('client_request_id', sa.String(length=64), nullable=True))
    _create_index('uq_ai_public_support_client_request_id', 'ai_public_support_request', ['client_request_id'], unique=True)


def downgrade() -> None:
    """Downgrade schema."""
    _drop_index('uq_ai_public_support_client_request_id', 'ai_public_support_request')
    _drop_column('ai_public_support_request', 'client_request_id')

    _drop_index('uq_ai_public_msg_session_idem', 'ai_public_assistant_message')
    _create_index('ix_ai_public_msg_session_idem', 'ai_public_assistant_message', ['session_id', 'idempotency_key'])
