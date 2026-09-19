"""add notification platform tables (ZB-* email pipeline foundation)

Revision ID: a3c7e91f4d28
Revises: d4f7a9c2b1e6
Create Date: 2026-09-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
import app.modules.notifications.models


revision: str = "a3c7e91f4d28"
down_revision: Union[str, Sequence[str], None] = "d4f7a9c2b1e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "suppressed_recipients",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=True),
        sa.Column(
            "reason",
            app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.SuppressionReason
            ),
            nullable=False,
        ),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("suppressed_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("lifted_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_suppressed_recipients_id"), "suppressed_recipients", ["id"], unique=False)
    op.create_index(op.f("ix_suppressed_recipients_email"), "suppressed_recipients", ["email"], unique=False)
    op.create_index(op.f("ix_suppressed_recipients_organization_id"), "suppressed_recipients", ["organization_id"], unique=False)
    op.create_index("ix_suppressed_recipients_email_org", "suppressed_recipients", ["email", "organization_id"], unique=False)

    op.create_table(
        "marketing_consents",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=True),
        sa.Column(
            "scope",
            app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.MarketingConsentScope
            ),
            nullable=False,
        ),
        sa.Column("granted", sa.Boolean(), nullable=False),
        sa.Column("granted_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("source", sa.String(length=100), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_marketing_consents_id"), "marketing_consents", ["id"], unique=False)
    op.create_index(op.f("ix_marketing_consents_email"), "marketing_consents", ["email"], unique=False)
    op.create_index(op.f("ix_marketing_consents_organization_id"), "marketing_consents", ["organization_id"], unique=False)
    op.create_index("ix_marketing_consents_email_org_scope", "marketing_consents", ["email", "organization_id", "scope"], unique=False)

    op.create_table(
        "notification_template_states",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("template_id", sa.String(length=50), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("changed_by_user_id", sa.Integer(), nullable=True),
        sa.Column("changed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.ForeignKeyConstraint(["changed_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("template_id"),
    )
    op.create_index(op.f("ix_notification_template_states_id"), "notification_template_states", ["id"], unique=False)
    op.create_index(op.f("ix_notification_template_states_template_id"), "notification_template_states", ["template_id"], unique=True)

    op.create_table(
        "communication_sends",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("dedupe_key", sa.String(length=300), nullable=False),
        sa.Column("event_name", sa.String(length=150), nullable=False),
        sa.Column("entity_type", sa.String(length=50), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=True),
        sa.Column("template_id", sa.String(length=50), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=True),
        sa.Column("recipient_email", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.CommunicationSendStatus
            ),
            server_default="PENDING",
            nullable=False,
        ),
        sa.Column("correlation_id", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dedupe_key", name="uq_communication_sends_dedupe_key"),
    )
    op.create_index(op.f("ix_communication_sends_id"), "communication_sends", ["id"], unique=False)
    op.create_index(op.f("ix_communication_sends_event_name"), "communication_sends", ["event_name"], unique=False)
    op.create_index(op.f("ix_communication_sends_template_id"), "communication_sends", ["template_id"], unique=False)
    op.create_index(op.f("ix_communication_sends_organization_id"), "communication_sends", ["organization_id"], unique=False)
    op.create_index(op.f("ix_communication_sends_correlation_id"), "communication_sends", ["correlation_id"], unique=False)

    op.create_table(
        "communication_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("template_id", sa.String(length=50), nullable=False),
        sa.Column("event_name", sa.String(length=150), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=True),
        sa.Column("recipient_email", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.CommunicationLogStatus
            ),
            nullable=False,
        ),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("correlation_id", sa.String(length=100), nullable=True),
        sa.Column("communication_send_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["communication_send_id"], ["communication_sends.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_communication_logs_id"), "communication_logs", ["id"], unique=False)
    op.create_index(op.f("ix_communication_logs_template_id"), "communication_logs", ["template_id"], unique=False)
    op.create_index(op.f("ix_communication_logs_event_name"), "communication_logs", ["event_name"], unique=False)
    op.create_index(op.f("ix_communication_logs_organization_id"), "communication_logs", ["organization_id"], unique=False)
    op.create_index(op.f("ix_communication_logs_recipient_email"), "communication_logs", ["recipient_email"], unique=False)
    op.create_index(op.f("ix_communication_logs_status"), "communication_logs", ["status"], unique=False)
    op.create_index(op.f("ix_communication_logs_correlation_id"), "communication_logs", ["correlation_id"], unique=False)
    op.create_index("ix_communication_logs_org_created", "communication_logs", ["organization_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_communication_logs_org_created", table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_correlation_id"), table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_status"), table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_recipient_email"), table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_organization_id"), table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_event_name"), table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_template_id"), table_name="communication_logs")
    op.drop_index(op.f("ix_communication_logs_id"), table_name="communication_logs")
    op.drop_table("communication_logs")

    op.drop_index(op.f("ix_communication_sends_correlation_id"), table_name="communication_sends")
    op.drop_index(op.f("ix_communication_sends_organization_id"), table_name="communication_sends")
    op.drop_index(op.f("ix_communication_sends_template_id"), table_name="communication_sends")
    op.drop_index(op.f("ix_communication_sends_event_name"), table_name="communication_sends")
    op.drop_index(op.f("ix_communication_sends_id"), table_name="communication_sends")
    op.drop_table("communication_sends")

    op.drop_index(op.f("ix_notification_template_states_template_id"), table_name="notification_template_states")
    op.drop_index(op.f("ix_notification_template_states_id"), table_name="notification_template_states")
    op.drop_table("notification_template_states")

    op.drop_index("ix_marketing_consents_email_org_scope", table_name="marketing_consents")
    op.drop_index(op.f("ix_marketing_consents_organization_id"), table_name="marketing_consents")
    op.drop_index(op.f("ix_marketing_consents_email"), table_name="marketing_consents")
    op.drop_index(op.f("ix_marketing_consents_id"), table_name="marketing_consents")
    op.drop_table("marketing_consents")

    op.drop_index("ix_suppressed_recipients_email_org", table_name="suppressed_recipients")
    op.drop_index(op.f("ix_suppressed_recipients_organization_id"), table_name="suppressed_recipients")
    op.drop_index(op.f("ix_suppressed_recipients_email"), table_name="suppressed_recipients")
    op.drop_index(op.f("ix_suppressed_recipients_id"), table_name="suppressed_recipients")
    op.drop_table("suppressed_recipients")
