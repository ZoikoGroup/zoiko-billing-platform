"""ZB-TAX-ARCH-001 Phase 8 PR 5: source change detection and review cadence

Platform tables (no tenant data): tax_source_monitors,
tax_source_monitor_changes, tax_source_observations (append-only: Postgres
trigger), tax_source_reviews (unique per cycle), tax_review_dues,
tax_source_hosts.

Revision ID: b6e0a4c8d2f9
Revises: a5d9f3b7c1e8
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b6e0a4c8d2f9'
down_revision: Union[str, Sequence[str], None] = 'a5d9f3b7c1e8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)


def _has(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def _user(name: str) -> sa.Column:
    return sa.Column(name, sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


def upgrade() -> None:
    if not _has("tax_source_monitors"):
        op.create_table(
            "tax_source_monitors",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("handoff_ref", sa.String(20), nullable=True),
            sa.Column("title", sa.String(300), nullable=False),
            sa.Column("monitoring_url", sa.String(1000), nullable=False),
            sa.Column("host", sa.String(255), nullable=False),
            sa.Column("jurisdiction_id", sa.Integer(), sa.ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"),
                      nullable=True),
            sa.Column("risk_tier", sa.String(20), nullable=False),
            sa.Column("access_mode", sa.String(20), nullable=False),
            sa.Column("manual_reason", sa.Text(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("retired_at", TS, nullable=True),
            sa.Column("next_check_due", TS, nullable=False),
            sa.Column("last_checked_at", TS, nullable=True),
            sa.Column("last_outcome", sa.String(30), nullable=True),
            sa.Column("last_observation_id", sa.Integer(), nullable=True),
            sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("consecutive_429", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("retry_after_until", TS, nullable=True),
            sa.Column("dismissals", sa.Integer(), nullable=False, server_default="0"),
            _user("created_by"),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("updated_at", TS, nullable=True),
        )
        for col in ("id", "handoff_ref", "host", "next_check_due"):
            op.create_index(f"ix_tax_source_monitors_{col}", "tax_source_monitors", [col])
    if not _has("tax_source_monitor_changes"):
        op.create_table(
            "tax_source_monitor_changes",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("monitor_id", sa.Integer(), sa.ForeignKey("tax_source_monitors.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("action", sa.String(20), nullable=False),
            sa.Column("value", sa.String(1000), nullable=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("status", sa.String(10), nullable=False),
            _user("proposed_by"), _user("decided_by"),
            sa.Column("decided_at", TS, nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("id", "monitor_id"):
            op.create_index(f"ix_tax_source_monitor_changes_{col}", "tax_source_monitor_changes", [col])
    if not _has("tax_source_observations"):
        op.create_table(
            "tax_source_observations",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("monitor_id", sa.Integer(), sa.ForeignKey("tax_source_monitors.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("fetched_at", TS, nullable=False),
            sa.Column("url_fetched", sa.String(1000), nullable=True),
            sa.Column("outcome", sa.String(30), nullable=False),
            sa.Column("http_status", sa.Integer(), nullable=True),
            sa.Column("content_type", sa.String(150), nullable=True),
            sa.Column("normalization", sa.String(60), nullable=True),
            sa.Column("raw_sha256", sa.String(64), nullable=True),
            sa.Column("normalized_sha256", sa.String(64), nullable=True),
            sa.Column("artifact_sha256", sa.String(64), sa.ForeignKey("tax_source_artifacts.sha256",
                                                                     ondelete="RESTRICT"), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
        )
        for col in ("id", "monitor_id"):
            op.create_index(f"ix_tax_source_observations_{col}", "tax_source_observations", [col])
    if not _has("tax_source_reviews"):
        op.create_table(
            "tax_source_reviews",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("kind", sa.String(30), nullable=False),
            sa.Column("monitor_id", sa.Integer(), sa.ForeignKey("tax_source_monitors.id", ondelete="RESTRICT"),
                      nullable=True),
            sa.Column("rate_version_id", sa.Integer(), sa.ForeignKey("tax_rate_versions.id", ondelete="RESTRICT"),
                      nullable=True),
            sa.Column("observation_id", sa.Integer(), sa.ForeignKey("tax_source_observations.id", ondelete="RESTRICT"),
                      nullable=True),
            sa.Column("previous_observation_id", sa.Integer(), nullable=True),
            sa.Column("diff", sa.Text(), nullable=True),
            sa.Column("cycle_key", sa.String(120), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("resolution", sa.Text(), nullable=True),
            sa.Column("source_revision_id", sa.Integer(),
                      sa.ForeignKey("tax_legal_source_revisions.id", ondelete="RESTRICT"), nullable=True),
            _user("decided_by"),
            sa.Column("decided_at", TS, nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.UniqueConstraint("cycle_key", name="uq_tax_source_reviews_cycle"),
        )
        for col in ("id", "kind", "status"):
            op.create_index(f"ix_tax_source_reviews_{col}", "tax_source_reviews", [col])
    if not _has("tax_review_dues"):
        op.create_table(
            "tax_review_dues",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("subject_kind", sa.String(20), nullable=False),
            sa.Column("subject_key", sa.String(60), nullable=False),
            sa.Column("label", sa.String(300), nullable=False),
            sa.Column("tier", sa.String(20), nullable=False),
            sa.Column("next_review_due", TS, nullable=False),
            sa.Column("last_reviewed_at", TS, nullable=True),
            _user("last_reviewed_by"),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.UniqueConstraint("subject_kind", "subject_key", name="uq_tax_review_dues_subject"),
        )
        for col in ("id", "next_review_due"):
            op.create_index(f"ix_tax_review_dues_{col}", "tax_review_dues", [col])
    if not _has("tax_source_hosts"):
        op.create_table(
            "tax_source_hosts",
            sa.Column("host", sa.String(255), primary_key=True),
            sa.Column("last_request_at", TS, nullable=True),
            sa.Column("robots_fetched_at", TS, nullable=True),
            sa.Column("robots_status", sa.Integer(), nullable=True),
            sa.Column("robots_body", sa.Text(), nullable=True),
        )
    if op.get_bind().dialect.name == "postgresql":
        op.execute("""
CREATE OR REPLACE FUNCTION tax_source_observations_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax_source_observations % is append-only', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql
""")
        op.execute("DROP TRIGGER IF EXISTS trg_tax_source_observations_guard ON tax_source_observations")
        op.execute("CREATE TRIGGER trg_tax_source_observations_guard BEFORE UPDATE OR DELETE ON tax_source_observations "
                   "FOR EACH ROW EXECUTE FUNCTION tax_source_observations_guard()")


def downgrade() -> None:
    for table in ("tax_source_reviews", "tax_review_dues", "tax_source_hosts", "tax_source_observations",
                  "tax_source_monitor_changes", "tax_source_monitors"):
        if _has(table):
            op.drop_table(table)
