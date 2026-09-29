"""add email_outbox table (B1: durable async-email work queue)

Revision ID: c3f5a7e9d1b4
Revises: 8b2b6f10e693
Create Date: 2026-09-29 00:00:00.000000

send_approval_email's async_send=True path previously handed a send
straight to an in-process ThreadPoolExecutor with nothing persisted first
(app/services/email_foundation/async_dispatcher.py) -- a process crash or
restart between that hand-off and the background thread actually running
silently dropped the email with no trace anywhere. This table is a
dedicated durable work queue (a sibling to communication_audit_logs, which
is an audit trail, not a queue, and is left completely untouched by this
migration): a QUEUED row is written synchronously before the background
dispatch, and the crash-recovery sweep in email_foundation/recovery.py finds
and redelivers any row still QUEUED past a grace period.

Defensive create (checks table/index existence before creating) to match
this repo's established convention for new email-foundation tables -- see
73e2ebbe6aad_add_email_foundation_tables_.py's docstring for why a plain,
unconditional create_table() proved unsafe here before.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3f5a7e9d1b4'
down_revision: Union[str, Sequence[str], None] = '8b2b6f10e693'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    table = "email_outbox"
    already_existed = table in existing_tables
    if not already_existed:
        op.create_table(
            table,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dedupe_key", sa.String(length=255), nullable=True),
            sa.Column("recipient", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("template_name", sa.String(length=255), nullable=False),
            sa.Column("template_id", sa.String(length=50), nullable=True),
            sa.Column("event_name", sa.String(length=100), nullable=True),
            sa.Column("event_id", sa.String(length=255), nullable=True),
            sa.Column("target_record_id", sa.String(length=255), nullable=True),
            sa.Column("context_json", sa.Text(), nullable=True),
            sa.Column("attachments_json", sa.Text(), nullable=True),
            sa.Column("from_email_override", sa.String(length=255), nullable=True),
            sa.Column("from_display_name_override", sa.String(length=255), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="QUEUED"),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )

    existing_index_names = (
        {ix["name"] for ix in inspector.get_indexes(table)} if already_existed else set()
    )
    for name, columns, unique in [
        ("ix_email_outbox_id", ["id"], False),
        ("ix_email_outbox_dedupe_key", ["dedupe_key"], False),
        ("ix_email_outbox_recipient", ["recipient"], False),
        ("ix_email_outbox_organization_id", ["organization_id"], False),
        ("ix_email_outbox_template_id", ["template_id"], False),
        ("ix_email_outbox_event_name", ["event_name"], False),
        ("ix_email_outbox_event_id", ["event_id"], False),
        ("ix_email_outbox_target_record_id", ["target_record_id"], False),
        ("ix_email_outbox_status", ["status"], False),
        ("ix_email_outbox_created_at", ["created_at"], False),
        ("idx_email_outbox_status_created", ["status", "created_at"], False),
    ]:
        if name not in existing_index_names:
            op.create_index(name, table, columns, unique=unique)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("idx_email_outbox_status_created", table_name="email_outbox")
    op.drop_index("ix_email_outbox_created_at", table_name="email_outbox")
    op.drop_index("ix_email_outbox_status", table_name="email_outbox")
    op.drop_index("ix_email_outbox_target_record_id", table_name="email_outbox")
    op.drop_index("ix_email_outbox_event_id", table_name="email_outbox")
    op.drop_index("ix_email_outbox_event_name", table_name="email_outbox")
    op.drop_index("ix_email_outbox_template_id", table_name="email_outbox")
    op.drop_index("ix_email_outbox_organization_id", table_name="email_outbox")
    op.drop_index("ix_email_outbox_recipient", table_name="email_outbox")
    op.drop_index("ix_email_outbox_dedupe_key", table_name="email_outbox")
    op.drop_index("ix_email_outbox_id", table_name="email_outbox")
    op.drop_table("email_outbox")
