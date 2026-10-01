"""add email foundation tables (suppressions, consents, org preferences, audit logs)

Revision ID: 73e2ebbe6aad
Revises: 7709ed1aee3e
Create Date: 2026-09-19 18:35:03.910214

Written defensively (checks for each table/index before creating it) rather
than a plain, unconditional op.create_table()/op.create_index() sequence,
after a real production deploy failure proved that was necessary:

Production's database already has these 4 tables. They were created years
ago by an older version of this app that bootstrapped Postgres directly via
Base.metadata.create_all(), before this repo's Postgres schema ownership was
tightened to Alembic-only (see migrations/create_all/README.md). No later
revision ever recorded them, so a plain `alembic upgrade head` against
production failed immediately with `psycopg.errors.DuplicateTable: relation
"communication_audit_logs" already exists` (real GitHub Actions deploy
failure, 2026-09-19 -- the migration's own transactional DDL meant this
failure rolled back cleanly with no partial schema change, and
`set -euo pipefail` in deploy.yml aborted before the app ever restarted
against it).

A genuinely fresh database -- this repo's CI Postgres service container, a
new environment, or a disaster-recovery restore-to-empty -- has none of
these 4 tables at all and truly needs them created: confirmed by
reproducing a real `UndefinedTable` error from
ConsentSuppressionEngine/CommunicationAuditLogger (used by every
send_approval_email() call) against a from-scratch local Postgres instance
before this migration existed.

This migration is written to succeed correctly against BOTH starting
states. Column/index definitions were taken from
app/services/email_foundation/models.py via `alembic revision
--autogenerate` against a fresh database, so they exactly match what
production's legacy create_all() bootstrap would have produced from the
same ORM models -- not hand-typed, and not blindly "CREATE TABLE IF NOT
EXISTS" (which would silently accept a schema mismatch); the per-table
existence check below still runs the real create_table/create_index calls
whenever a piece is genuinely missing, on either kind of database.

--autogenerate also detected unrelated, pre-existing drift (nullable
changes on 5 billing_configurations columns, plus a dropped index/unique
constraint on invoices/payments/notification_template_states) that
predates and is unrelated to this fix -- deliberately NOT included here;
noted separately for its own investigation rather than bundled into an
unrelated migration.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '73e2ebbe6aad'
down_revision: Union[str, Sequence[str], None] = '7709ed1aee3e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _create_missing_indexes(inspector, table_name, table_already_existed, index_specs):
    """index_specs: list of (name, columns, unique) tuples."""
    existing_index_names = (
        {ix["name"] for ix in inspector.get_indexes(table_name)}
        if table_already_existed
        else set()
    )
    for name, columns, unique in index_specs:
        if name not in existing_index_names:
            op.create_index(name, table_name, columns, unique=unique)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    # ── communication_audit_logs ────────────────────────────────────────
    table = "communication_audit_logs"
    already_existed = table in existing_tables
    if not already_existed:
        op.create_table(
            table,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dedupe_key", sa.String(length=255), nullable=True),
            sa.Column("recipient", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("template_id", sa.String(length=50), nullable=False),
            sa.Column("event_name", sa.String(length=100), nullable=False),
            sa.Column("event_id", sa.String(length=255), nullable=True),
            sa.Column("target_record_id", sa.String(length=255), nullable=True),
            sa.Column("tier", sa.String(length=10), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("suppression_reason", sa.String(length=50), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("metadata_json", sa.Text(), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_missing_indexes(inspector, table, already_existed, [
        ("ix_communication_audit_logs_dedupe_key", ["dedupe_key"], False),
        ("ix_communication_audit_logs_event_id", ["event_id"], False),
        ("ix_communication_audit_logs_event_name", ["event_name"], False),
        ("ix_communication_audit_logs_id", ["id"], False),
        ("ix_communication_audit_logs_organization_id", ["organization_id"], False),
        ("ix_communication_audit_logs_recipient", ["recipient"], False),
        ("ix_communication_audit_logs_status", ["status"], False),
        ("ix_communication_audit_logs_target_record_id", ["target_record_id"], False),
        ("ix_communication_audit_logs_template_id", ["template_id"], False),
    ])

    # ── email_marketing_consents ────────────────────────────────────────
    table = "email_marketing_consents"
    already_existed = table in existing_tables
    if not already_existed:
        op.create_table(
            table,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("email_address", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("has_consented", sa.Boolean(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_missing_indexes(inspector, table, already_existed, [
        ("idx_consent_email_org", ["email_address", "organization_id"], False),
        ("ix_email_marketing_consents_email_address", ["email_address"], False),
        ("ix_email_marketing_consents_id", ["id"], False),
        ("ix_email_marketing_consents_organization_id", ["organization_id"], False),
    ])

    # ── email_org_preferences ───────────────────────────────────────────
    table = "email_org_preferences"
    already_existed = table in existing_tables
    if not already_existed:
        op.create_table(
            table,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=False),
            sa.Column("category", sa.String(length=100), nullable=False),
            sa.Column("is_enabled", sa.Boolean(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_missing_indexes(inspector, table, already_existed, [
        ("idx_org_pref_org_cat", ["organization_id", "category"], True),
        ("ix_email_org_preferences_id", ["id"], False),
        ("ix_email_org_preferences_organization_id", ["organization_id"], False),
    ])

    # ── email_suppressions ───────────────────────────────────────────────
    table = "email_suppressions"
    already_existed = table in existing_tables
    if not already_existed:
        op.create_table(
            table,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("email_address", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("reason", sa.String(length=50), nullable=False),
            sa.Column("details", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_missing_indexes(inspector, table, already_existed, [
        ("idx_suppression_email_org", ["email_address", "organization_id"], False),
        ("ix_email_suppressions_email_address", ["email_address"], False),
        ("ix_email_suppressions_id", ["id"], False),
        ("ix_email_suppressions_organization_id", ["organization_id"], False),
    ])


def downgrade() -> None:
    """Downgrade schema.

    NOT guarded the way upgrade() is: this unconditionally drops all 4
    tables, which is only correct to run against a database where this
    migration actually created them (a fresh environment). Running it
    against production would delete real, pre-existing audit-log/consent
    data that predates this migration entirely -- do not run this against
    production without independently confirming that first.
    """
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f('ix_email_suppressions_organization_id'), table_name='email_suppressions')
    op.drop_index(op.f('ix_email_suppressions_id'), table_name='email_suppressions')
    op.drop_index(op.f('ix_email_suppressions_email_address'), table_name='email_suppressions')
    op.drop_index('idx_suppression_email_org', table_name='email_suppressions')
    op.drop_table('email_suppressions')
    op.drop_index(op.f('ix_email_org_preferences_organization_id'), table_name='email_org_preferences')
    op.drop_index(op.f('ix_email_org_preferences_id'), table_name='email_org_preferences')
    op.drop_index('idx_org_pref_org_cat', table_name='email_org_preferences')
    op.drop_table('email_org_preferences')
    op.drop_index(op.f('ix_email_marketing_consents_organization_id'), table_name='email_marketing_consents')
    op.drop_index(op.f('ix_email_marketing_consents_id'), table_name='email_marketing_consents')
    op.drop_index(op.f('ix_email_marketing_consents_email_address'), table_name='email_marketing_consents')
    op.drop_index('idx_consent_email_org', table_name='email_marketing_consents')
    op.drop_table('email_marketing_consents')
    op.drop_index(op.f('ix_communication_audit_logs_template_id'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_target_record_id'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_status'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_recipient'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_organization_id'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_id'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_event_name'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_event_id'), table_name='communication_audit_logs')
    op.drop_index(op.f('ix_communication_audit_logs_dedupe_key'), table_name='communication_audit_logs')
    op.drop_table('communication_audit_logs')
    # ### end Alembic commands ###
