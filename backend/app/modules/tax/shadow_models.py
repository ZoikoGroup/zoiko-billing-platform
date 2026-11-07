"""
app/modules/tax/shadow_models.py
--------------------------------
Shadow compare (ZB-TAX-ARCH-001 Phase 7 PR 1, handoff §10.1 step 06).

  TaxShadowSelection   platform: which rule pack version (ACTIVE or a draft)
                       shadows use, and the tax lead's advisory exit
                       thresholds. No tenant data.
  TaxShadowEnrolment   tenant: an entity opts in to shadowing; a tenant admin
                       proposes, a different finance approver approves. The
                       entity stays LEGACY_MANUAL: shadowing never changes
                       what is invoiced.
  TaxShadowComparison  tenant: for one issued legacy invoice, what governed
                       tax would have been, and the differences. Write-once.
"""
from sqlalchemy import JSON, Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.tax.enums import TenantApprovalStatus
from app.modules.tax.models import register_tenant_record_guard

MONEY = Numeric(18, 2)


class TaxShadowSelection(Base):
    __tablename__ = "tax_shadow_selections"

    id                   = Column(Integer, primary_key=True, index=True)
    rule_pack_version_id = Column(Integer, ForeignKey("tax_rule_pack_versions.id", ondelete="RESTRICT"), nullable=False,
                                  index=True)
    # Advisory exit signal (the tax lead's threshold): at least this many
    # compared invoices over at least this many days, with zero unexplained
    # differences. Never switches a regime.
    exit_min_invoices    = Column(Integer, nullable=False, default=50)
    exit_min_days        = Column(Integer, nullable=False, default=30)
    active               = Column(Boolean, nullable=False, default=True, index=True)
    reason               = Column(Text, nullable=True)
    chosen_by            = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    chosen_at            = Column(DateTime(timezone=True), nullable=False)
    ended_by             = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    ended_at             = Column(DateTime(timezone=True), nullable=True)


class TaxShadowEnrolment(Base):
    __tablename__ = "tax_shadow_enrolments"

    id               = Column(Integer, primary_key=True, index=True)
    organization_id  = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    seller_entity_id = Column(Integer, ForeignKey("seller_legal_entities.id", ondelete="RESTRICT"), nullable=False,
                              index=True)
    # PROPOSED -> APPROVED (shadowing) -> ENDED; or REJECTED / WITHDRAWN.
    status           = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True)
    reason           = Column(Text, nullable=True)
    proposed_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_at      = Column(DateTime(timezone=True), nullable=True)     # shadowing starts
    decision_reason  = Column(Text, nullable=True)
    ended_by         = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    ended_at         = Column(DateTime(timezone=True), nullable=True)
    created_at       = Column(DateTime(timezone=True), nullable=False)


class TaxShadowComparison(Base):
    __tablename__ = "tax_shadow_comparisons"
    __table_args__ = (UniqueConstraint("invoice_id", name="uq_tax_shadow_comparisons_invoice"),)

    id                   = Column(Integer, primary_key=True, index=True)
    organization_id      = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    seller_entity_id     = Column(Integer, ForeignKey("seller_legal_entities.id", ondelete="RESTRICT"), nullable=True,
                                  index=True)
    enrolment_id         = Column(Integer, ForeignKey("tax_shadow_enrolments.id", ondelete="RESTRICT"), nullable=False,
                                  index=True)
    invoice_id           = Column(Integer, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False)
    invoice_number       = Column(String(100), nullable=True)
    issue_date           = Column(Date, nullable=True)
    currency             = Column(String(3), nullable=True)
    # MATCH | DIFFERENT | NOT_DETERMINED | REVIEW_REQUIRED | UNSUPPORTED | ERROR
    outcome              = Column(String(30), nullable=False, index=True)
    # Why: RATE_DIFFERENT, ROUNDING, DISCOUNT_AFTER_TAX, TAX_MISSING_ON_LEGACY,
    # a refusal code (NOT_DETERMINED, REQUIRED_FACTS_MISSING, ...) or UNEXPLAINED.
    cause                = Column(String(60), nullable=True, index=True)
    reason               = Column(Text, nullable=True)
    legacy_tax           = Column(MONEY, nullable=True)
    shadow_tax           = Column(MONEY, nullable=True)
    tax_difference       = Column(MONEY, nullable=True)                 # shadow - legacy
    lines                = Column(JSON, nullable=True)                  # per-line / per-component differences
    rule_pack_version_id = Column(Integer, ForeignKey("tax_rule_pack_versions.id", ondelete="RESTRICT"), nullable=True)
    pack_code            = Column(String(60), nullable=True)
    pack_version         = Column(String(30), nullable=True)
    computed_at          = Column(DateTime(timezone=True), nullable=False)


SHADOW_ENROLMENT_FROZEN_FIELDS = ("organization_id", "seller_entity_id", "reason", "proposed_by", "created_at")
register_tenant_record_guard(TaxShadowEnrolment.__table__, SHADOW_ENROLMENT_FROZEN_FIELDS)
SHADOW_COMPARISON_FROZEN_FIELDS = (
    "organization_id", "seller_entity_id", "enrolment_id", "invoice_id", "invoice_number", "issue_date", "currency",
    "outcome", "cause", "reason", "legacy_tax", "shadow_tax", "tax_difference", "lines", "rule_pack_version_id",
    "pack_code", "pack_version", "computed_at",
)
register_tenant_record_guard(TaxShadowComparison.__table__, SHADOW_COMPARISON_FROZEN_FIELDS)
