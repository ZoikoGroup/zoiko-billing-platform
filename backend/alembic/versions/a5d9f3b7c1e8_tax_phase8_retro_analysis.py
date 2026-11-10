"""ZB-TAX-ARCH-001 Phase 8 PR 4: retroactive change analysis

  1. tax_quotes.decision_facts: the facts a native pack reads (seller and
     billing country, buyer status, line product scopes) recorded at quote
     time, frozen with the quote (the tenant guard is recreated with it).
  2. tax_retro_analyses (platform: previews and full analyses, aggregates,
     the exact versions compared against; no tenant identifiers).
  3. tax_retro_org_runs and tax_retro_results (tenant records under the
     tenant record guard; deleted only by the erasure purge). Results are
     unique per (analysis, quote).

Revision ID: a5d9f3b7c1e8
Revises: f4c8e2a6b9d1
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'a5d9f3b7c1e8'
down_revision: Union[str, Sequence[str], None] = 'f4c8e2a6b9d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)
MONEY = sa.Numeric(14, 2)

_QUOTE_FROZEN_8 = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "rounding_mode", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "supply_address", "exemption_claims", "provider_connection_id", "context_fingerprint", "document_hash",
    "request_hash", "idempotency_key", "subtotal_unrounded", "discount_unrounded", "tax_unrounded",
    "total_unrounded", "subtotal", "discount_amount", "tax_amount", "total_amount", "issues", "warnings",
    "refusal_code", "refusal_reason", "rule_pack_version_id", "rule_pack_code_hash", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at",
)
_QUOTE_FROZEN_8_4 = _QUOTE_FROZEN_8 + ("decision_facts",)
ORG_RUN_FROZEN = ("organization_id", "analysis_id", "created_at")
RESULT_FROZEN = ("organization_id", "analysis_id", "quote_id", "invoice_id", "status", "reason", "currency",
                 "original_tax", "comparison_tax", "difference", "direction", "lines", "basis_label",
                 "versions_used", "inputs_hash", "created_at")


def _cols(table: str) -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _has(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def _pg() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _tenant_guard(table: str, fields: tuple) -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
    op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '*')")


def upgrade() -> None:
    if "decision_facts" not in _cols("tax_quotes"):
        op.add_column("tax_quotes", sa.Column("decision_facts", sa.JSON(), nullable=True))
    if not _has("tax_retro_analyses"):
        op.create_table(
            "tax_retro_analyses",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("mode", sa.String(10), nullable=False),
            sa.Column("trigger_kind", sa.String(20), nullable=False),
            sa.Column("trigger_id", sa.Integer(), nullable=False),
            sa.Column("subject_id", sa.Integer(), nullable=True),
            sa.Column("basis", sa.String(40), nullable=False),
            sa.Column("basis_label", sa.Text(), nullable=False),
            sa.Column("versions_used", sa.JSON(), nullable=False),
            sa.Column("inputs_hash", sa.String(64), nullable=False),
            sa.Column("scope_hash", sa.String(64), nullable=False),
            sa.Column("range_from", sa.String(10), nullable=True),
            sa.Column("range_to", sa.String(10), nullable=True),
            sa.Column("severity", sa.String(10), nullable=True),
            sa.Column("status", sa.String(10), nullable=False),
            sa.Column("orgs_total", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("orgs_done", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("documents_total", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("documents_done", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("aggregates", sa.JSON(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("started_at", TS, nullable=True),
            sa.Column("finished_at", TS, nullable=True),
        )
        for col in ("id", "mode", "status"):
            op.create_index(f"ix_tax_retro_analyses_{col}", "tax_retro_analyses", [col])
    if not _has("tax_retro_org_runs"):
        op.create_table(
            "tax_retro_org_runs",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("analysis_id", sa.Integer(), sa.ForeignKey("tax_retro_analyses.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("status", sa.String(10), nullable=False),
            sa.Column("cursor", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("documents", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("finished_at", TS, nullable=True),
            sa.UniqueConstraint("analysis_id", "organization_id", name="uq_tax_retro_org_runs_analysis_org"),
        )
        for col in ("id", "analysis_id", "organization_id"):
            op.create_index(f"ix_tax_retro_org_runs_{col}", "tax_retro_org_runs", [col])
    if not _has("tax_retro_results"):
        op.create_table(
            "tax_retro_results",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("analysis_id", sa.Integer(), sa.ForeignKey("tax_retro_analyses.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
                      nullable=False),
            sa.Column("quote_id", sa.Integer(), sa.ForeignKey("tax_quotes.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("invoice_id", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(30), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("currency", sa.String(3), nullable=True),
            sa.Column("original_tax", MONEY, nullable=True),
            sa.Column("comparison_tax", MONEY, nullable=True),
            sa.Column("difference", MONEY, nullable=True),
            sa.Column("direction", sa.String(5), nullable=True),
            sa.Column("lines", sa.JSON(), nullable=True),
            sa.Column("basis_label", sa.Text(), nullable=False),
            sa.Column("versions_used", sa.JSON(), nullable=False),
            sa.Column("inputs_hash", sa.String(64), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.UniqueConstraint("analysis_id", "quote_id", name="uq_tax_retro_results_analysis_quote"),
        )
        for col in ("id", "analysis_id", "organization_id", "quote_id"):
            op.create_index(f"ix_tax_retro_results_{col}", "tax_retro_results", [col])
    if _pg():
        _tenant_guard("tax_quotes", _QUOTE_FROZEN_8_4)
        _tenant_guard("tax_retro_org_runs", ORG_RUN_FROZEN)
        _tenant_guard("tax_retro_results", RESULT_FROZEN)


def downgrade() -> None:
    if _pg():
        _tenant_guard("tax_quotes", _QUOTE_FROZEN_8)
    for table in ("tax_retro_results", "tax_retro_org_runs", "tax_retro_analyses"):
        if _has(table):
            op.drop_table(table)
    if "decision_facts" in _cols("tax_quotes"):
        op.drop_column("tax_quotes", "decision_facts")
