"""
app/modules/tax/retro_models.py
-------------------------------
Retroactive change analysis (ZB-TAX-ARCH-001 Phase 8 PR 4, handoff §10.3,
T04).

  TaxRetroAnalysis   platform: one analysis (or preview) of one trigger, with
                     the exact versions and hashes it compared against,
                     progress and aggregates. No tenant identifiers.
  TaxRetroOrgRun     tenant: one organization's progress through an
                     analysis (the job locks it, one tenant at a time).
  TaxRetroResult     tenant: one committed document's comparison: original
                     snapshot vs the comparison basis, per line and
                     component. Unique per (analysis, quote): idempotent.

The analysis is read-only for every issued record; these tables are the only
thing it writes. Tenant rows are retained tax records under the tenant
record guard (erasure purge only).
"""
from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint

from app.database import Base
from app.modules.tax.models import register_tenant_record_guard

TRIGGER_KINDS = ("rollback", "rate", "rule_pack")
MONEY = Numeric(14, 2)


class TaxRetroAnalysis(Base):
    __tablename__ = "tax_retro_analyses"

    id              = Column(Integer, primary_key=True, index=True)
    mode            = Column(String(10), nullable=False, index=True)         # PREVIEW | FULL
    trigger_kind    = Column(String(20), nullable=False)                     # rollback | rate | rule_pack
    trigger_id      = Column(Integer, nullable=False)                        # request / rate version / pack version
    subject_id      = Column(Integer, nullable=True)                         # preview: staged rate / pack version
    basis           = Column(String(40), nullable=False)                     # see retro_service.BASES
    basis_label     = Column(Text, nullable=False)
    versions_used   = Column(JSON, nullable=False)                           # exact ids and hashes compared against
    inputs_hash     = Column(String(64), nullable=False)                     # versions in force + candidate
    scope_hash      = Column(String(64), nullable=False)                     # sorted in-scope committed quote ids
    range_from      = Column(String(10), nullable=True)
    range_to        = Column(String(10), nullable=True)
    severity        = Column(String(10), nullable=True)                      # rollback triggers
    status          = Column(String(10), nullable=False, index=True)         # PENDING | RUNNING | DONE | FAILED
    orgs_total      = Column(Integer, nullable=False, default=0)
    orgs_done       = Column(Integer, nullable=False, default=0)
    documents_total = Column(Integer, nullable=False, default=0)
    documents_done  = Column(Integer, nullable=False, default=0)
    aggregates      = Column(JSON, nullable=True)                            # exact; views band small populations
    error           = Column(Text, nullable=True)
    created_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(DateTime(timezone=True), nullable=False)
    started_at      = Column(DateTime(timezone=True), nullable=True)
    finished_at     = Column(DateTime(timezone=True), nullable=True)


class TaxRetroOrgRun(Base):
    __tablename__ = "tax_retro_org_runs"

    id              = Column(Integer, primary_key=True, index=True)
    analysis_id     = Column(Integer, ForeignKey("tax_retro_analyses.id", ondelete="RESTRICT"), nullable=False, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    status          = Column(String(10), nullable=False, default="PENDING")  # PENDING | DONE
    cursor          = Column(Integer, nullable=False, default=0)             # last quote id processed
    documents       = Column(Integer, nullable=False, default=0)
    created_at      = Column(DateTime(timezone=True), nullable=False)
    finished_at     = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (UniqueConstraint("analysis_id", "organization_id", name="uq_tax_retro_org_runs_analysis_org"),)


class TaxRetroResult(Base):
    __tablename__ = "tax_retro_results"

    id              = Column(Integer, primary_key=True, index=True)
    analysis_id     = Column(Integer, ForeignKey("tax_retro_analyses.id", ondelete="RESTRICT"), nullable=False, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    quote_id        = Column(Integer, ForeignKey("tax_quotes.id", ondelete="RESTRICT"), nullable=False, index=True)
    invoice_id      = Column(Integer, nullable=True)
    status          = Column(String(30), nullable=False)       # COMPARED | NO_DIFFERENCE | MANUAL_REVIEW_REQUIRED | NOT_ANALYSABLE
    reason          = Column(Text, nullable=True)
    currency        = Column(String(3), nullable=True)
    original_tax    = Column(MONEY, nullable=True)
    comparison_tax  = Column(MONEY, nullable=True)
    difference      = Column(MONEY, nullable=True)             # original - comparison: > 0 over-collected
    direction       = Column(String(5), nullable=True)         # OVER | UNDER | NONE
    lines           = Column(JSON, nullable=True)
    basis_label     = Column(Text, nullable=False)
    versions_used   = Column(JSON, nullable=False)
    inputs_hash     = Column(String(64), nullable=True)
    created_at      = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (UniqueConstraint("analysis_id", "quote_id", name="uq_tax_retro_results_analysis_quote"),)


ORG_RUN_FROZEN_FIELDS = ("organization_id", "analysis_id", "created_at")
RESULT_FROZEN_FIELDS = ("organization_id", "analysis_id", "quote_id", "invoice_id", "status", "reason", "currency",
                        "original_tax", "comparison_tax", "difference", "direction", "lines", "basis_label",
                        "versions_used", "inputs_hash", "created_at")
register_tenant_record_guard(TaxRetroOrgRun.__table__, ORG_RUN_FROZEN_FIELDS)
register_tenant_record_guard(TaxRetroResult.__table__, RESULT_FROZEN_FIELDS)
