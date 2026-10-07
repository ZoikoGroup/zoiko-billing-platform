"""add ai_escalation_request table

QA Gap Analysis P0 ("Dead-End Escalation Loop"): the assistant offers
"Would you like me to connect you to a team member?" but nothing records
or dispatches the handoff when the user accepts. This migration adds the
durable human-handoff request sink so an accepted escalation carries a
real reference, a webhook/queue delivery record, and a verbatim copy of
the recent conversation for the human picking the case up.

Revision ID: a9f3c2e8d1b4
Revises: f2b8d4a6c1e3
Create Date: 2026-10-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a9f3c2e8d1b4"
down_revision: Union[str, Sequence[str], None] = "f2b8d4a6c1e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_escalation_request",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("escalation_uid", sa.String(36), nullable=False),
        sa.Column("reference", sa.String(64), nullable=False),
        sa.Column("conversation_id", sa.Integer(), nullable=False),
        sa.Column("tenant_context_id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("trigger_text", sa.Text(), nullable=False),
        sa.Column("confirmation_text", sa.Text(), nullable=True),
        sa.Column("conversation_snapshot", sa.JSON(), nullable=True),
        sa.Column("dispatch_status", sa.Enum(
            'QUEUED', 'DISPATCHED', 'FAILED',
            name='escalationrequeststatus', native_enum=False,
        ), nullable=False),
        sa.Column("dispatch_channel", sa.String(32), nullable=True),
        sa.Column("webhook_status_code", sa.Integer(), nullable=True),
        sa.Column("dispatch_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["ai_conversation.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"], ["organizations.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_context_id"], ["ai_tenant_context.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.Index("ix_ai_escalation_org_created", "organization_id", "created_at"),
        sa.Index("ix_ai_escalation_status_created", "dispatch_status", "created_at"),
    )
    op.create_index(
        "ix_ai_escalation_request_escalation_uid",
        "ai_escalation_request",
        ["escalation_uid"],
        unique=True,
    )
    op.create_index(
        "ix_ai_escalation_request_reference",
        "ai_escalation_request",
        ["reference"],
        unique=True,
    )
    op.create_index(
        "ix_ai_escalation_request_conversation_id",
        "ai_escalation_request",
        ["conversation_id"],
    )
    op.create_index(
        "ix_ai_escalation_request_tenant_context_id",
        "ai_escalation_request",
        ["tenant_context_id"],
    )
    op.create_index(
        "ix_ai_escalation_request_user_id",
        "ai_escalation_request",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_table("ai_escalation_request")