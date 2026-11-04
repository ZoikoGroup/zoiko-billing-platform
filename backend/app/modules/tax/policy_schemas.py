"""Request contracts for ZB-TAX-ARCH-001 Phase 2 routes (policy, activation,
classification, buyer evidence). Responses are built by the services' view_*
helpers so enums are always serialized by name."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.tax.enums import (
    AddressConfidence,
    AddressRole,
    EntityTaxRegime,
    RegistrationStatus,
    SupplyCategory,
    TaxOperatingMode,
    TransactionClass,
    VerificationStatus,
)

RatePercent = Annotated[Decimal, Field(max_digits=9, decimal_places=6)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Platform: market availability and tax codes ─────────────────────────

class GateEvidence(_Strict):
    status: str = Field(..., description="NOT_STARTED, PASSED, FAILED or NOT_APPLICABLE")
    evidence_ref: Optional[str] = Field(None, max_length=1000)
    notes: Optional[str] = None


class AvailabilityDraftRequest(_Strict):
    jurisdiction_id: int
    tax_type_id: int
    transaction_class: TransactionClass
    mode: TaxOperatingMode
    tenant_config_permitted: bool = False
    gates: Optional[Dict[str, GateEvidence]] = None
    notes: Optional[str] = None


class AvailabilityAmendRequest(_Strict):
    mode: Optional[TaxOperatingMode] = None
    tenant_config_permitted: Optional[bool] = None
    gates: Optional[Dict[str, GateEvidence]] = None
    notes: Optional[str] = None


class CodeSetDraftRequest(_Strict):
    code: str = Field("ZB-TC", min_length=1, max_length=30)
    notes: Optional[str] = None
    copy_active: bool = True


class TaxCodeUpsertRequest(_Strict):
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    supply_category: SupplyCategory
    description: Optional[str] = None
    parent_code: Optional[str] = Field(None, max_length=50)
    registry_product_scope: str = Field("GENERAL", min_length=1, max_length=100)


class PolicyActionRequest(_Strict):
    """Body for validate/submit/approve/reject/publish. submit and reject need
    a reason; approve and publish need a fresh MFA factor."""
    reason: Optional[str] = Field(None, max_length=2000)
    code: Optional[str] = Field(None, min_length=6, max_length=8)
    recovery_code: Optional[str] = Field(None, min_length=6, max_length=20)


# ── Tenant: registrations, legal bases, activations ─────────────────────

class RegistrationCreate(_Strict):
    seller_entity_id: int
    jurisdiction_id: int
    tax_type_id: int
    registration_number: str = Field(..., min_length=1, max_length=100)
    valid_from: date
    valid_to: Optional[date] = None
    status: RegistrationStatus = RegistrationStatus.ACTIVE
    evidence_ref: Optional[str] = Field(None, max_length=500)
    notes: Optional[str] = None


class RegistrationUpdate(_Strict):
    valid_to: Optional[date] = None
    status: Optional[RegistrationStatus] = None
    verification_status: Optional[VerificationStatus] = None
    verification_method: Optional[str] = Field(None, max_length=100)
    verification_response: Optional[dict] = None
    verified_at: Optional[datetime] = None
    verification_expires_at: Optional[datetime] = None
    evidence_ref: Optional[str] = Field(None, max_length=500)
    notes: Optional[str] = None


class LegalBasisCreate(_Strict):
    seller_entity_id: int
    jurisdiction_id: int
    tax_type_id: int
    legal_basis: str = Field(..., min_length=3)
    evidence_ref: str = Field(..., min_length=1, max_length=500)
    valid_from: date
    valid_to: Optional[date] = None
    supersedes_id: Optional[int] = None


class ActivationCreate(_Strict):
    seller_entity_id: int
    jurisdiction_id: int
    tax_type_id: int
    transaction_class: TransactionClass
    mode: TaxOperatingMode
    effective_from: date
    effective_to: Optional[date] = None
    registration_id: Optional[int] = None
    legal_basis_id: Optional[int] = None
    tenant_rate_percent: Optional[RatePercent] = None
    tenant_source_citation: Optional[str] = None
    tenant_source_url: Optional[str] = Field(None, max_length=1000)


class DecisionRequest(_Strict):
    reason: Optional[str] = Field(None, max_length=2000)


class RegimeChangeRequest(_Strict):
    tax_regime: EntityTaxRegime


# ── Tenant: product classification ──────────────────────────────────────

class ClassificationCreate(_Strict):
    product_id: int
    tax_code_id: int
    reason: Optional[str] = None


class ImpactPreviewRequest(_Strict):
    product_ids: List[int] = Field(..., min_length=1, max_length=500)


# ── Tenant: buyer evidence ───────────────────────────────────────────────

class TaxAddressCreate(_Strict):
    role: AddressRole
    country_code: Optional[str] = Field(None, max_length=2)
    subdivision_code: Optional[str] = Field(None, max_length=6)
    postal_code: Optional[str] = Field(None, max_length=20)
    city: Optional[str] = Field(None, max_length=100)
    confidence: AddressConfidence = AddressConfidence.ENTERED


class TaxIdCreate(_Strict):
    value: str = Field(..., min_length=1, max_length=100)
    id_type: Optional[str] = Field(None, max_length=50)
    country_code: Optional[str] = Field(None, max_length=2)


class TaxIdVerification(_Strict):
    status: VerificationStatus
    method: str = Field(..., min_length=1, max_length=100)
    response: dict
    verified_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None


class CertificateCreate(_Strict):
    certificate_number: str = Field(..., min_length=1, max_length=100)
    jurisdiction_id: int
    tax_type_id: Optional[int] = None
    scope_description: str = Field(..., min_length=1)
    valid_from: date
    expires_at: Optional[date] = None
    evidence_ref: str = Field(..., min_length=1, max_length=500)
