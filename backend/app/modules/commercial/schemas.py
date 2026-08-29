"""
modules/commercial/schemas.py
-----------------------------
Read-only AND Super-Admin-mutation schemas for Plane 1 (Zoiko Commercial
Billing).

Read models present the combined view used by the future Super Admin: the
account's own lifecycle fields PLUS the Organization's Phase 1 server-stamped
billing_source / billing_classification, which stay on the Organization as the
single source of truth.

Mutation schemas (PHASE 8) are Super-Admin-only. Tenants never mutate these:
billing_source / billing_classification stay server-stamped and uneditable,
and every lifecycle change goes through the service layer's state machine.

No pricing values are invented here — price fields are optional structure that
remain null until an approved catalogue supplies them.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialAccountStatus,
    CommercialBillingInterval,
    CommercialOverrideStatus,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
    EntitlementEnforcementType,
    EntitlementRiskClassification,
    EntitlementValueType,
)


class CommercialSubscriptionSummary(BaseModel):
    """Lightweight marker of the account's CURRENT open subscription,
    embedded in account read models (PHASE 9). Full lifecycle history stays on
    the dedicated subscription endpoints / consolidated org view."""

    id: int
    status: CommercialSubscriptionStatus
    plan_code: str
    plan_name: str
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    trial_ends_at: Optional[datetime] = None
    recovery_ends_at: Optional[datetime] = None


class CommercialAccountResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    organization_code: str
    organization_name: str
    status: CommercialAccountStatus
    billing_source: BillingSource
    billing_classification: BillingClassification
    is_active: bool
    # PHASE 9 read-only additions for the Super Admin control center:
    # whether the standalone platform may charge this org (double-charge
    # prevention readiness) and the org's CURRENT open subscription marker.
    can_charge: bool
    current_subscription: Optional[CommercialSubscriptionSummary] = None
    created_at: datetime
    updated_at: datetime


class CommercialAccountListResponse(BaseModel):
    accounts: list[CommercialAccountResponse]
    total: int


class CommercialPlanResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plan_code: str
    plan_name: str
    description: Optional[str] = None
    status: CommercialPlanStatus
    is_default: bool = False
    billing_interval: Optional[CommercialBillingInterval] = None
    currency: Optional[str] = None
    price_amount: Optional[Decimal] = None
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    max_users: Optional[int] = None
    max_storage_gb: Optional[int] = None
    features: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class CommercialPlanListResponse(BaseModel):
    plans: list[CommercialPlanResponse]
    total: int


class CommercialPlanCreate(BaseModel):
    """Super Admin create (PHASE 8). No pricing is invented — structure only.

    plan_code / plan_name are required identity fields. Every pricing / limit /
    feature field is optional structure: it stays NULL unless an approved
    catalogue explicitly supplies a value.
    """

    plan_code: str = Field(..., min_length=1, max_length=50)
    plan_name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    is_default: bool = False
    billing_interval: Optional[CommercialBillingInterval] = None
    currency: Optional[str] = None
    price_amount: Optional[Decimal] = None
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    max_users: Optional[int] = None
    max_storage_gb: Optional[int] = None
    features: Optional[dict] = None


class CommercialPlanUpdate(BaseModel):
    """Super Admin structural update (PHASE 8).

    plan_code is immutable (stable identity referenced by history).
    Updating these template fields never rewrites subscription rows.
    """

    plan_name: Optional[str] = None
    description: Optional[str] = None
    billing_interval: Optional[CommercialBillingInterval] = None
    currency: Optional[str] = None
    price_amount: Optional[Decimal] = None
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    max_users: Optional[int] = None
    max_storage_gb: Optional[int] = None
    features: Optional[dict] = None


class CommercialPlanStatusUpdate(BaseModel):
    status: CommercialPlanStatus


class CommercialPlanDefaultUpdate(BaseModel):
    is_default: bool


class CommercialSubscriptionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    commercial_account_id: int
    organization_id: int
    organization_code: str
    organization_name: str
    commercial_plan_id: int
    catalog_version_id: Optional[int] = None
    plan_code: str
    plan_name: str
    status: CommercialSubscriptionStatus
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    current_period_start: Optional[datetime] = None
    current_period_end: Optional[datetime] = None
    trial_ends_at: Optional[datetime] = None
    # ZB-COM-ENT-001 Part 1 — trial/recovery window + the entitlement bundle
    # snapshot granted during the trial (copied from the evaluation program's
    # granted_plan_id PlanEntitlement rows at provision time).
    recovery_ends_at: Optional[datetime] = None
    trial_granted_entitlements: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class CommercialSubscriptionListResponse(BaseModel):
    subscriptions: list[CommercialSubscriptionResponse]
    total: int


class CommercialSubscriptionCreate(BaseModel):
    """Super Admin manual subscription creation (PHASE 8).

    organization_id and plan are required; status may only be PENDING or ACTIVE
    (service-validated). Lifecycle changes after creation go through the state
    machine endpoint — never direct status writes.
    """

    organization_id: int
    plan_id: int
    status: CommercialSubscriptionStatus = CommercialSubscriptionStatus.PENDING


class CommercialSubscriptionStatusUpdate(BaseModel):
    status: CommercialSubscriptionStatus


class CommercialSubscriptionPlanChange(BaseModel):
    """Phase 3F F5 — plan change request.

    A plan change supersedes the current open subscription with a new one on
    the target plan (history preserved, both audited). A reason is mandatory
    for the platform audit trail.
    """

    new_plan_id: int
    reason: str = Field(min_length=3, max_length=1000)


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 9 — Consolidated Commercial Organization view (Super Admin, read-only)
# ═══════════════════════════════════════════════════════════════════════════════


class CommercialBillingConfigurationSummary(BaseModel):
    """Minimal operational summary of the org's BillingConfiguration.

    Kept deliberately separate from the CommercialSubscription: the Billing
    module's configuration is the org's OPERATIONAL settings (currency,
    templates, numbering), whereas a CommercialSubscription assigns a
    platform-plane CommercialPlan. The two must never be conflated.
    """

    id: int
    company_name: Optional[str] = None
    default_currency: Optional[str] = None
    timezone: Optional[str] = None
    language: Optional[str] = None
    invoice_prefix: Optional[str] = None
    tax_number: Optional[str] = None


class CommercialOrganizationDetailResponse(BaseModel):
    """One read-only, all-in-one view of an organization's commercial plane:
    org identity + server-stamped billing source/classification + commercial
    account (+ charging readiness + current subscription) + operational billing
    configuration + current subscription/plan + full subscription history +
    entitlement view. Composed from existing services; no new fields on any
    source model."""

    organization_id: int
    organization_code: str
    organization_name: str
    is_active: bool
    billing_source: BillingSource
    billing_classification: BillingClassification
    can_charge: bool
    account: CommercialAccountResponse
    billing_configuration: Optional[CommercialBillingConfigurationSummary] = None
    current_subscription: Optional[CommercialSubscriptionResponse] = None
    plan: Optional[CommercialPlanResponse] = None
    subscription_history: list[CommercialSubscriptionResponse]
    entitlements: dict


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-ENT-001 Part 1 — Entitlement Catalog read models (§12–§13)
# Read-only Super Admin surfaces. No mutation endpoints exist in Part 1 —
# the catalog is seeded (scripts/seed_entitlement_definitions.py) and read.
# ═══════════════════════════════════════════════════════════════════════════════


class EntitlementDefinitionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    key: str
    value_type: EntitlementValueType
    risk_classification: EntitlementRiskClassification
    enforcement_type: EntitlementEnforcementType
    description: Optional[str] = None
    created_at: datetime


class EntitlementDefinitionListResponse(BaseModel):
    definitions: list[EntitlementDefinitionResponse]
    total: int


class PlanEntitlementResponse(BaseModel):
    """One typed entitlement value bound to a CommercialPlanVersion.

    is_contracted=True with value=None means the entitlement is governed by
    the signed Enterprise order form, not this catalog row.
    """

    id: int
    plan_version_id: int
    entitlement_definition_id: int
    key: str
    value_type: EntitlementValueType
    risk_classification: EntitlementRiskClassification
    enforcement_type: EntitlementEnforcementType
    value: Optional[Any] = None
    is_contracted: bool = False


class PlanVersionEntitlementsResponse(BaseModel):
    version_id: int
    entitlements: list[PlanEntitlementResponse]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-ENT-001 Part 2 §16.1 — Commercial Overrides (dual-approval)
# ═══════════════════════════════════════════════════════════════════════════════


class CommercialOverrideCreate(BaseModel):
    organization_id: int
    entitlement_definition_id: int
    value: Optional[Any] = None
    reason: str = Field(..., min_length=1, max_length=2000)
    expires_at: Optional[datetime] = None


class CommercialOverrideResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    entitlement_definition_id: int
    entitlement_key: Optional[str] = None
    value: Optional[Any] = None
    reason: str
    status: CommercialOverrideStatus
    expires_at: Optional[datetime] = None
    requested_by_user_id: Optional[int] = None
    approval_request_id: Optional[int] = None
    approved_by_user_id: Optional[int] = None
    revoked_at: Optional[datetime] = None
    revoked_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class CommercialOverrideListResponse(BaseModel):
    overrides: list[CommercialOverrideResponse]
    total: int


class CommercialOverrideRevokeRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=2000)


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-ENT-001 Part 3 §16 — draft-version editing, usage diagnostics,
# plan-change queue, trial controls
# ═══════════════════════════════════════════════════════════════════════════════


class CommercialPlanVersionUpdate(BaseModel):
    """Every field optional — PATCH semantics (only supplied fields change).
    Rejected server-side (CommercialPlanVersionService.update_draft) unless
    the version is still DRAFT."""

    plan_name: Optional[str] = None
    description: Optional[str] = None
    billing_interval: Optional[CommercialBillingInterval] = None
    currency: Optional[str] = None
    price_amount: Optional[Decimal] = None
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    max_users: Optional[int] = None
    max_storage_gb: Optional[int] = None
    features: Optional[dict] = None


class PlanEntitlementSet(BaseModel):
    value: Optional[Any] = None
    is_contracted: bool = False


class UsageCounterResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    entitlement_definition_id: int
    entitlement_key: Optional[str] = None
    window_key: str
    count: int
    soft_warned_at: Optional[datetime] = None
    updated_at: datetime


class UsageCounterListResponse(BaseModel):
    counters: list[UsageCounterResponse]
    total: int


class SubscriptionChangeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    commercial_subscription_id: int
    from_plan_id: int
    to_plan_id: int
    from_plan_code: Optional[str] = None
    to_plan_code: Optional[str] = None
    direction: str
    status: str
    effective_at: Optional[datetime] = None
    requested_at: datetime
    requested_by_user_id: Optional[int] = None
    applied_at: Optional[datetime] = None
    reversed_at: Optional[datetime] = None
    reversed_by_user_id: Optional[int] = None
    reason: Optional[str] = None
    blockers: Optional[Any] = None
    price_impact: Optional[Any] = None


class SubscriptionChangeListResponse(BaseModel):
    changes: list[SubscriptionChangeResponse]
    total: int


class SubscriptionChangeReverseRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=2000)


class TrialStatusResponse(BaseModel):
    organization_id: int
    has_open_subscription: bool
    subscription_status: Optional[str] = None
    trial_ends_at: Optional[datetime] = None
    recovery_ends_at: Optional[datetime] = None
    evaluation_conversion_policy: Optional[str] = None
    evaluation_expiry_action: Optional[str] = None
    trial_granted_entitlements: Optional[Any] = None
    is_trial_eligible: bool
