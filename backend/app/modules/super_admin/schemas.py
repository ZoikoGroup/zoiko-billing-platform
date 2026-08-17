"""
modules/super_admin/schemas.py
------------------------------
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.auth.models import UserRole

# Platform Settings can legitimately hold operational overrides (e.g. an SMTP
# password override under category="email"), but this table has no secret
# vault / encryption-at-rest / access-audit story of its own. Rather than
# invent one, any key that LOOKS sensitive is masked on every read: the raw
# value is never sent back to the browser once stored. There is no reveal
# endpoint — writing a new value is still supported (write-only, like a
# password field), but the stored value can never be read back through the
# API. This is a limitation of the current PlatformSetting model, not a
# feature; if a real secret-management need arises, it belongs in proper
# secret storage (env vars / a vault), not this table.
SENSITIVE_KEY_PATTERNS = (
    "password", "secret", "token", "api_key", "private_key",
    "credential", "database_url", "jwt_secret",
)
MASKED_VALUE_PLACEHOLDER = "•" * 10  # ••••••••••


def is_sensitive_setting_key(key: str) -> bool:
    lowered = (key or "").lower()
    return any(pattern in lowered for pattern in SENSITIVE_KEY_PATTERNS)


class SettingCreate(BaseModel):
    key: str
    value: Optional[str] = None
    description: Optional[str] = None
    category: str = "general"
    is_public: bool = False


class SettingUpdate(BaseModel):
    value: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    is_public: Optional[bool] = None


class SettingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    key: str
    value: Optional[str] = None
    description: Optional[str] = None
    category: str
    is_public: bool
    updated_at: datetime
    # Server-computed (never trust a client-supplied value for this): tells
    # the frontend to render a masked, read-only value with no inline edit.
    is_sensitive: bool = False

    @model_validator(mode="after")
    def _mask_sensitive_value(self):
        if is_sensitive_setting_key(self.key):
            self.is_sensitive = True
            if self.value:
                self.value = MASKED_VALUE_PLACEHOLDER
        return self


class SuperAdminUserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    role: UserRole
    organization_id: Optional[int] = None
    organization_name: Optional[str] = None
    organization_code: Optional[str] = None
    first_name: str
    last_name: str
    is_active: bool
    created_at: datetime
    mfa_enabled: Optional[bool] = None  # only meaningful for role == super_admin


class SuperAdminUserListResponse(BaseModel):
    users: list[SuperAdminUserResponse]
    total: int


class DashboardStats(BaseModel):
    total_organizations: int
    active_organizations: int
    total_users: int
    org_admins: int
    billing_admins: int
    total_customers: int
    total_invoices: int
    recent_organizations: list[dict]


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 11 — Platform audit log feed (Super Admin, cross-organization)
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformAuditLogResponse(BaseModel):
    """One platform-plane audit entry, enriched with the actor email and
    organization name for cross-org display. Built manually in the router
    (a LEFT JOIN against users/organizations)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    actor_id: Optional[int] = None
    actor_email: Optional[str] = None
    actor_role: Optional[str] = None
    action: str
    entity_type: str
    entity_id: Optional[int] = None
    organization_id: Optional[int] = None
    organization_name: Optional[str] = None
    old_values: Optional[dict] = None
    new_values: Optional[dict] = None
    metadata: Optional[dict] = None
    reason: Optional[str] = None
    correlation_id: Optional[str] = None
    created_at: datetime


class PlatformAuditLogListResponse(BaseModel):
    logs: list[PlatformAuditLogResponse]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 13 — Subscription lifecycle audit visibility (Super Admin, read-only)
# ═══════════════════════════════════════════════════════════════════════════════
# CommercialSubscription mutations are recorded in the org-scoped
# billing_audit_logs table (BillingAuditLog), not PlatformAuditLog — they are
# tenant-facing billing events with organization_id NOT NULL, so they belong
# in that table by design. This closes the visibility gap without changing
# that underlying audit model: it's a read-only, cross-organization Super
# Admin PROJECTION over the same rows the org-scoped billing audit already
# writes, filtered to entity_type == "CommercialSubscription".


class SubscriptionAuditLogResponse(BaseModel):
    """One CommercialSubscription lifecycle event, enriched with actor email
    and organization identity for cross-org display (mirrors
    PlatformAuditLogResponse's shape). `lifecycle_event` is a presentation-only
    label derived from the stored action + new_values.status — the underlying
    BillingAuditAction enum and billing_audit_logs schema are unchanged."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    actor_id: Optional[int] = None
    actor_email: Optional[str] = None
    action: str
    lifecycle_event: str
    subscription_id: Optional[int] = None
    organization_id: int
    organization_name: str
    organization_code: str
    old_values: Optional[dict] = None
    new_values: Optional[dict] = None
    created_at: datetime


class SubscriptionAuditLogListResponse(BaseModel):
    logs: list[SubscriptionAuditLogResponse]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-BILL-001 §Phase2 — Billing classification controlled mutation
# ═══════════════════════════════════════════════════════════════════════════════

class BillingClassificationUpdate(BaseModel):
    billing_classification: str
    reason: str = Field(..., min_length=1, max_length=1000)


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-BILL-001 §T1 / Phase 4 — Versioned price catalog
# ═══════════════════════════════════════════════════════════════════════════════

class CommercialPlanVersionCreate(BaseModel):
    """Draft a new version. No pricing is invented — every field below is
    optional structure exactly like CommercialPlan; only plan_name is
    required as the version's own display identity."""

    plan_name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    billing_interval: Optional[str] = None
    currency: Optional[str] = None
    price_amount: Optional[Decimal] = None
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    max_users: Optional[int] = None
    max_storage_gb: Optional[int] = None
    features: Optional[dict] = None


class CommercialPlanVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plan_id: int
    plan_code: Optional[str] = None
    version_number: int
    status: str
    plan_name: str
    description: Optional[str] = None
    billing_interval: Optional[str] = None
    currency: Optional[str] = None
    price_amount: Optional[Decimal] = None
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    max_users: Optional[int] = None
    max_storage_gb: Optional[int] = None
    features: Optional[dict] = None
    created_by_user_id: Optional[int] = None
    approval_request_id: Optional[int] = None
    published_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class CommercialPlanVersionListResponse(BaseModel):
    versions: list[CommercialPlanVersionResponse]
    total: int


class SubmitForApprovalRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)


class RejectApprovalRequest(BaseModel):
    rejection_reason: str = Field(..., min_length=1, max_length=1000)


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-BILL-001 Phase 5 — Maker-checker approval queue
# ═══════════════════════════════════════════════════════════════════════════════

class ApprovalRequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    request_type: str
    requested_by_user_id: Optional[int] = None
    requested_by_email: Optional[str] = None
    requested_at: datetime
    reason: Optional[str] = None
    scope: Optional[dict] = None
    before_state: Optional[dict] = None
    proposed_state: Optional[dict] = None
    evidence: Optional[dict] = None
    approver_user_id: Optional[int] = None
    approver_email: Optional[str] = None
    approved_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    status: str
    correlation_id: Optional[str] = None


class ApprovalRequestListResponse(BaseModel):
    requests: list[ApprovalRequestResponse]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-BILL-001 §30.1 — Billing kill switch
# ═══════════════════════════════════════════════════════════════════════════════

class BillingKillSwitchResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    scope: str
    enabled: bool
    reason: Optional[str] = None
    changed_by_user_id: Optional[int] = None
    changed_by_email: Optional[str] = None
    changed_at: datetime
    created_at: datetime


class BillingKillSwitchUpdate(BaseModel):
    enabled: bool
    reason: str = Field(..., min_length=1, max_length=1000)


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-BILL-001 §26 — Mandatory Production Acceptance Checklist
# ═══════════════════════════════════════════════════════════════════════════════

class ProductionAcceptanceItem(BaseModel):
    id: str
    criterion: str
    status: str  # PASS | FAIL | WARNING | NOT_CONFIGURED | NOT_APPLICABLE
    evidence: str


class ProductionAcceptanceReport(BaseModel):
    generated_at: datetime
    items: list[ProductionAcceptanceItem]
    overall_status: str  # READY | CONDITIONAL | BLOCKED
    summary: str
