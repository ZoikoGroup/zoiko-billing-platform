"""
app/modules/tax/remediation_models.py
-------------------------------------
Targeted remediation (ZB-TAX-ARCH-001 Phase 7 PR 4, handoff §10.1 step 08:
no silent historical mutation). Tenant data only.

  TaxRemediationBatch     a two-person, capped, audited batch of remediation
  TaxRemediationItem      one invoice in an executed batch; unique per
                          (kind, invoice): never remediated twice
  TaxDuplicateRowArchive  a duplicate legacy tax row removed by a batch, kept
                          whole so the batch can be reversed
"""
from datetime import datetime, timezone

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.tax.enums import TenantApprovalStatus
from app.modules.tax.models import register_tenant_record_guard


def _now():
    return datetime.now(timezone.utc)


OVERCOLLECTION_CREDIT = "OVERCOLLECTION_CREDIT"
DUPLICATE_ROWS = "DUPLICATE_ROWS"
REMEDIATION_KINDS = (OVERCOLLECTION_CREDIT, DUPLICATE_ROWS)


class TaxRemediationBatch(Base):
    __tablename__ = "tax_remediation_batches"

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    kind            = Column(String(30), nullable=False, index=True)
    # PROPOSED -> APPROVED (executed) | REJECTED | WITHDRAWN; APPROVED + reversed_at = reversed
    status          = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True)
    invoice_ids     = Column(JSON, nullable=False)
    reason          = Column(Text, nullable=False)
    proposed_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_at     = Column(DateTime(timezone=True), nullable=True)
    decision_reason = Column(Text, nullable=True)
    result          = Column(JSON, nullable=True)
    evidence_sha256 = Column(String(64), nullable=True)
    reversed_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reversed_at     = Column(DateTime(timezone=True), nullable=True)
    reverse_reason  = Column(Text, nullable=True)
    created_at      = Column(DateTime(timezone=True), nullable=False, default=_now)


class TaxRemediationItem(Base):
    __tablename__ = "tax_remediation_items"
    __table_args__ = (UniqueConstraint("kind", "invoice_id", name="uq_tax_remediation_items_kind_invoice"),)

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    batch_id        = Column(Integer, ForeignKey("tax_remediation_batches.id", ondelete="RESTRICT"), nullable=False,
                             index=True)
    kind            = Column(String(30), nullable=False)
    invoice_id      = Column(Integer, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False)
    credit_note_id  = Column(Integer, ForeignKey("credit_notes.id", ondelete="RESTRICT"), nullable=True)
    amount          = Column(Numeric(14, 2), nullable=True)
    rows_removed    = Column(Integer, nullable=True)
    created_at      = Column(DateTime(timezone=True), nullable=False, default=_now)


class TaxDuplicateRowArchive(Base):
    __tablename__ = "tax_duplicate_row_archive"

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    batch_id        = Column(Integer, ForeignKey("tax_remediation_batches.id", ondelete="RESTRICT"), nullable=False,
                             index=True)
    tax_row_id      = Column(Integer, nullable=False)               # the removed taxes.id, re-used on restore
    invoice_id      = Column(Integer, nullable=True)
    row             = Column(JSON, nullable=False)                   # every column of the removed row
    archived_at     = Column(DateTime(timezone=True), nullable=False, default=_now)
    restored_at     = Column(DateTime(timezone=True), nullable=True)


register_tenant_record_guard(TaxRemediationBatch.__table__,
                             ("organization_id", "kind", "invoice_ids", "reason", "proposed_by", "created_at"))
register_tenant_record_guard(TaxRemediationItem.__table__,
                             ("organization_id", "batch_id", "kind", "invoice_id", "credit_note_id", "amount",
                              "rows_removed", "created_at"))
register_tenant_record_guard(TaxDuplicateRowArchive.__table__,
                             ("organization_id", "batch_id", "tax_row_id", "invoice_id", "row", "archived_at"))
