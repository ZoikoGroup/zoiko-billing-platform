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
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialAccountStatus,
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
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
