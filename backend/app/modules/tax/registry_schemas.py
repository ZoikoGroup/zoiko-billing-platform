"""Pydantic contracts for the Global Tax Reference Registry (ZB-TAX-ARCH-001 §09.1).

Public reference models (jurisdictions, rates) are explicit allow-lists: they
carry registry facts and a public source summary only — no tenant data, no
captured artifacts, hashes, storage locations or internal notes, and never an
amount owed.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.tax.enums import (
    AcquisitionMethod,
    RateKind,
    SourceTier,
)


# ── Public reference reads ──────────────────────────────────────────────

class RegistryJurisdiction(BaseModel):
    id: int
    code: str
    name: str
    level: str
    country_code: Optional[str] = None
    subdivision_code: Optional[str] = None
    parent_code: Optional[str] = None
    official_area_id: Optional[str] = None
    timezone: Optional[str] = None
    reference_status: str = Field(..., description="REFERENCE_ONLY or NO_APPROVED_RATES")
    production_calculation: str = Field(..., description="Always NOT_ACTIVATED in Phase 1")
    published_rate_versions: int
    last_published_at: Optional[datetime] = None


class RegistryJurisdictionListResponse(BaseModel):
    items: List[RegistryJurisdiction]


class PublicSourceSummary(BaseModel):
    authority: Optional[str] = None
    title: str
    permanent_url: str
    citation: str
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None


class RateVersionReference(BaseModel):
    id: int
    component_code: str
    component_name: str
    tax_type: str
    tax_code: str
    product_scope: str
    rate_kind: str
    rate_percent: Decimal
    is_cumulative: bool
    valid_from: date = Field(..., description="Jurisdiction-local legal date, inclusive")
    valid_to: Optional[date] = Field(None, description="Jurisdiction-local legal date, exclusive; null = open-ended")
    announced_at: Optional[datetime] = None
    observed_at: datetime
    approved_at: datetime
    published_at: datetime
    activated_at: datetime
    superseded_at: Optional[datetime] = None
    status: str
    mode: str
    evidence_status: str
    predecessor_id: Optional[int] = None
    source: PublicSourceSummary


class RateJurisdictionRef(BaseModel):
    id: int
    code: str
    name: str
    timezone: Optional[str] = None


class RateLookupResponse(BaseModel):
    jurisdiction: RateJurisdictionRef
    as_of: date
    known_at: datetime
    mode: str
    coverage: str = Field(..., description="APPROVED_REFERENCE_RATES or NO_APPROVED_RATE (never an implied 0%)")
    disclaimer: str
    items: List[RateVersionReference]


# ── Privileged (TAX_REVIEWER / TAX_PUBLISHER) ───────────────────────────

class SourceRevisionDetail(BaseModel):
    id: int
    authority_id: int
    authority: Optional[str] = None
    handoff_ref: Optional[str] = None
    source_tier: str
    acquisition_method: str
    permanent_url: str
    document_id: Optional[str] = None
    document_version: Optional[str] = None
    title: str
    citation: str
    language: str
    internal_notes: Optional[str] = None
    evidence_status: str
    redistribution_permission: str
    retrieved_at: Optional[datetime] = None
    sha256: Optional[str] = None
    artifact_storage_uri: Optional[str] = None
    artifact_media_type: Optional[str] = None
    artifact_size_bytes: Optional[int] = None
    reviewer_user_id: Optional[int] = None
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    created_at: datetime


class SourceRevisionListResponse(BaseModel):
    items: List[SourceRevisionDetail]


class RegisterSourceRevisionRequest(BaseModel):
    authority_id: int
    source_tier: SourceTier
    acquisition_method: AcquisitionMethod
    permanent_url: str = Field(..., min_length=9, max_length=1000)
    title: str = Field(..., min_length=1, max_length=500)
    citation: str = Field(..., min_length=1)
    language: str = Field(..., min_length=2, max_length=10)
    handoff_ref: Optional[str] = Field(None, max_length=10)
    document_id: Optional[str] = Field(None, max_length=255)
    document_version: Optional[str] = Field(None, max_length=100)
    internal_notes: Optional[str] = None


RatePercent = Annotated[Decimal, Field(max_digits=9, decimal_places=6)]


class _StagedFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    component_id: Optional[int] = None
    tax_code: Optional[str] = Field(None, max_length=50)
    product_scope: Optional[str] = Field(None, max_length=100)
    rate_kind: Optional[RateKind] = None
    rate_percent: Optional[RatePercent] = None
    valid_from: Optional[date] = None
    valid_to: Optional[date] = None
    announced_at: Optional[datetime] = None
    source_revision_id: Optional[int] = None
    owner: Optional[str] = Field(None, max_length=150)
    supersedes_rate_version_id: Optional[int] = None
    reviewer_notes: Optional[str] = None


class StageRateRequest(_StagedFields):
    """Manual proposal by a TAX_REVIEWER (origin MANUAL). Seeds, feeds and
    AI proposals enter through the service layer, never this route."""
    component_id: int
    tax_code: str = Field(..., min_length=1, max_length=50)
    rate_kind: RateKind
    product_scope: str = Field("GENERAL", min_length=1, max_length=100)


class AmendRateRequest(_StagedFields):
    pass


class StagedRateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    origin: str
    external_ref: Optional[str] = None
    component_id: int
    tax_code: str
    product_scope: str
    rate_kind: str
    rate_percent: Optional[Decimal] = None
    valid_from: Optional[date] = None
    valid_to: Optional[date] = None
    announced_at: Optional[datetime] = None
    observed_at: datetime
    source_revision_id: Optional[int] = None
    owner: Optional[str] = None
    supersedes_rate_version_id: Optional[int] = None
    raw_payload_sha256: Optional[str] = None
    reviewer_notes: Optional[str] = None
    status: str
    validation_errors: Optional[List[str]] = None
    validation_warnings: Optional[List[str]] = None
    validated_at: Optional[datetime] = None
    escalation_reason: Optional[str] = None
    escalated_at: Optional[datetime] = None
    adopted_by_user_id: Optional[int] = None
    adopted_at: Optional[datetime] = None
    change_approval_id: Optional[int] = None
    published_rate_version_id: Optional[int] = None
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None


class StagedRateListResponse(BaseModel):
    items: List[StagedRateResponse]
    total: int


class SubmitRateRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=2000)


class RejectRateRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=2000)


class StepUpRequest(BaseModel):
    """Fresh MFA factor for approve/publish (always required for the tax
    registry; see settings.TAX_REGISTRY_STEP_UP_REQUIRED)."""
    code: Optional[str] = Field(None, min_length=6, max_length=8)
    recovery_code: Optional[str] = Field(None, min_length=6, max_length=20)


class RegistryReadinessResponse(BaseModel):
    """Whether the two-person publication path can actually run: at least
    one active TAX_REVIEWER and one active TAX_PUBLISHER with MFA enrolled
    (different accounts by construction: one platform role per account)."""
    step_up_required: bool
    active_reviewers: int
    active_publishers: int
    publishers_with_mfa: int
    reviewers_with_mfa: int
    ready: bool


class PublishedRateResponse(BaseModel):
    staged_rate: StagedRateResponse
    rate_version_id: int
    predecessor_id: Optional[int] = None
