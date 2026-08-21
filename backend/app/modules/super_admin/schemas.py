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
    platform_role: Optional[str] = None  # only meaningful for role == super_admin; None == platform_administrator


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
    # ZB-SA-CMD-003 §9.1 — mandatory auto-expiry deadline for engaged breaks.
    expires_at: Optional[datetime] = None
    changed_by_user_id: Optional[int] = None
    changed_by_email: Optional[str] = None
    changed_at: datetime
    created_at: datetime


class BillingKillSwitchUpdate(BaseModel):
    enabled: bool
    reason: str = Field(..., min_length=1, max_length=1000)


# ZB-SA-CMD-003 §9 — Domain B circuit breaker toggle (break-glass direct
# path), MFA step-up required. Engaging a breaker REQUIRES an incident
# reference (§12 privileged-access discipline) and always carries a bounded
# auto-expiry window; releasing clears any pending expiry.
class CircuitBreakerToggleRequest(BaseModel):
    enabled: bool
    reason: str = Field(..., min_length=1, max_length=1000)
    incident_reference: Optional[str] = Field(None, max_length=100)
    auto_expire_minutes: Optional[int] = None  # clamped server-side
    code: Optional[str] = Field(None, min_length=6, max_length=10)
    recovery_code: Optional[str] = Field(None, min_length=6, max_length=20)

    @model_validator(mode="after")
    def _one_factor_required(self):
        if not self.code and not self.recovery_code:
            raise ValueError("Either a TOTP code or a recovery code is required to change a circuit breaker.")
        return self

    @model_validator(mode="after")
    def _incident_reference_required_to_engage(self):
        if not self.enabled and not (self.incident_reference or "").strip():
            raise ValueError("An incident_reference is required to engage (disable) a circuit breaker.")
        return self


# §9.1 catalog entry — blast-radius preview metadata so the UI can show what
# engaging a breaker actually stops BEFORE an operator confirms anything.
class CircuitBreakerCatalogEntry(BaseModel):
    scope: str
    display_name: str
    domain: str
    effect: str
    gated_paths: list[str]
    enabled: bool
    expires_at: Optional[datetime] = None
    reason: Optional[str] = None
    changed_by_email: Optional[str] = None
    changed_at: Optional[datetime] = None


class CircuitBreakerCatalogResponse(BaseModel):
    breakers: list[CircuitBreakerCatalogEntry]
    generated_at: datetime


# §9 maker-checker path: a proposed breaker change goes through the generic
# ApprovalRequest engine as request_type="circuit_breaker_change"; a second,
# different Super Admin approves/rejects via /approval-requests/{id}/decision.
class CircuitBreakerChangeProposalCreate(BaseModel):
    enabled: bool
    reason: str = Field(..., min_length=1, max_length=1000)
    incident_reference: Optional[str] = Field(None, max_length=100)
    auto_expire_minutes: Optional[int] = None  # clamped server-side

    @model_validator(mode="after")
    def _incident_reference_required_to_engage(self):
        if not self.enabled and not (self.incident_reference or "").strip():
            raise ValueError("An incident_reference is required to propose engaging (disabling) a circuit breaker.")
        return self


class ApprovalDecisionRequest(BaseModel):
    decision: str = Field(..., pattern="^(approve|reject)$")
    reason: str = Field(..., min_length=1, max_length=2000)
    # Required when deciding a circuit_breaker_change request — the CHECKER
    # authenticates with the same depth as the maker (§9/§12).
    code: Optional[str] = Field(None, min_length=6, max_length=10)
    recovery_code: Optional[str] = Field(None, min_length=6, max_length=20)


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


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §6/§7 — Domain B: privileged tenant support access
# ═══════════════════════════════════════════════════════════════════════════════

class PrivilegedAccessRequestCreate(BaseModel):
    organization_id: int
    reason: str = Field(..., min_length=1, max_length=2000)
    ticket_reference: str = Field(..., min_length=1, max_length=100)
    requested_minutes: int = Field(30, ge=1, le=30)


class PrivilegedAccessStepUp(BaseModel):
    code: Optional[str] = Field(None, min_length=6, max_length=10)
    recovery_code: Optional[str] = Field(None, min_length=6, max_length=20)

    @model_validator(mode="after")
    def _one_factor_required(self):
        if not self.code and not self.recovery_code:
            raise ValueError("Either a TOTP code or a recovery code is required.")
        return self


class PrivilegedAccessGrantResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    organization_name: Optional[str] = None
    requested_by_user_id: Optional[int] = None
    reason: str
    ticket_reference: str
    scope: str
    status: str
    correlation_id: str
    requested_minutes: int
    requested_at: datetime
    activated_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    exited_at: Optional[datetime] = None


class PrivilegedAccessGrantListResponse(BaseModel):
    grants: list[PrivilegedAccessGrantResponse]


class TenantAccessSummaryResponse(BaseModel):
    grant_id: int
    organization_id: int
    organization_name: Optional[str] = None
    organization_code: Optional[str] = None
    domain: str
    scope: str
    expires_at: Optional[datetime] = None
    customer_summary: dict
    subscription_summary: dict
    invoice_summary: dict


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §8 — Domain C: cross-tenant operational telemetry
# ═══════════════════════════════════════════════════════════════════════════════

class OrganizationHealthResponse(BaseModel):
    total_organizations: int
    active_organizations: int
    suspended_organizations: int


class JobHealthItem(BaseModel):
    job_name: str
    display_name: Optional[str] = None
    last_status: Optional[str] = None
    last_started_at: Optional[datetime] = None
    last_finished_at: Optional[datetime] = None
    last_error: Optional[str] = None
    run_count_24h: int
    failure_count_24h: int
    # ZB-SA-CMD-003 §10.2 — freshness of the underlying job signal itself
    # (time since last run vs its configured scheduler interval), not the
    # freshness of this HTTP response.
    freshness: str  # "fresh" | "stale" | "unknown"
    freshness_age_seconds: Optional[float] = None
    expected_interval_minutes: Optional[int] = None


class JobHealthListResponse(BaseModel):
    jobs: list[JobHealthItem]
    scheduler_enabled: bool


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §10/§11 — Attention Engine / incident lifecycle
# ═══════════════════════════════════════════════════════════════════════════════

class AttentionItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    source_key: str
    title: str
    description: Optional[str] = None
    severity: str
    status: str
    organization_id: Optional[int] = None
    owner_user_id: Optional[int] = None
    occurrence_count: int
    correlation_id: str
    opened_at: datetime
    last_seen_at: datetime
    acknowledged_at: Optional[datetime] = None
    assigned_at: Optional[datetime] = None
    mitigating_at: Optional[datetime] = None
    monitoring_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    reopened_at: Optional[datetime] = None
    resolution_code: Optional[str] = None
    suppressed_until: Optional[datetime] = None
    suppression_reason: Optional[str] = None
    sla_ack_deadline: Optional[datetime] = None
    sla_mitigate_deadline: Optional[datetime] = None


class AttentionItemListResponse(BaseModel):
    items: list[AttentionItemResponse]


class AttentionCountsResponse(BaseModel):
    p0: int
    p1: int
    p2: int
    p3: int
    total_open: int
    sla_breaches: int


class AttentionAssignRequest(BaseModel):
    owner_user_id: int


class AttentionTransitionRequest(BaseModel):
    to_status: str
    resolution_code: Optional[str] = Field(None, max_length=100)


class AttentionSuppressRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)
    minutes: int = Field(..., ge=1, le=10080)  # up to 7 days


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §10.1 — Metric Dictionary v1
# ═══════════════════════════════════════════════════════════════════════════════

class MetricDefinitionResponse(BaseModel):
    metric_id: str
    display_name: str
    definition: str
    domain: str
    unit: str
    numerator: Optional[str] = None
    denominator: Optional[str] = None
    period_basis: str
    timezone: str
    currency_basis: Optional[str] = None
    authoritative_source: str
    refresh_cadence_seconds: Optional[int] = None
    stale_threshold_seconds: Optional[int] = None
    unknown_threshold_seconds: Optional[int] = None
    owner: str
    version: str
    effective_date: str
    drilldown_route: Optional[str] = None


class MetricDictionaryResponse(BaseModel):
    metrics: list[MetricDefinitionResponse]


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §13/§14 — global search / command palette
# ═══════════════════════════════════════════════════════════════════════════════

class SearchResultItem(BaseModel):
    domain: str
    entity_type: str
    id: int
    label: str
    route: str
    requires_access: bool


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResultItem]


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §23 — Launch Readiness
# ═══════════════════════════════════════════════════════════════════════════════

class LaunchReadinessItem(BaseModel):
    id: str
    criterion: str
    status: str  # PASS | FAIL | WARNING | UNKNOWN
    evidence: str


class LaunchReadinessResponse(BaseModel):
    overall_status: str
    items: list[LaunchReadinessItem]


# ═══════════════════════════════════════════════════════════════════════════════
# Phase 15 — internal financial consistency (NOT external reconciliation)
# ═══════════════════════════════════════════════════════════════════════════════

class FinancialConsistencyResponse(BaseModel):
    state: str  # VERIFIED | FAILED | UNKNOWN
    scope: str
    total_invoices_checked: int
    over_allocated_count: int
    over_allocated_examples: list[dict]
    under_allocated_paid_count_informational: int
    coverage_note: str


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §11 — Triage lens: one pane, four sections. Composed from the
# SAME real sources as their dedicated endpoints (attention engine, job
# telemetry, breaker catalog, platform audit) — never a parallel data path.
# ═══════════════════════════════════════════════════════════════════════════════

class TriageIncidentsSection(BaseModel):
    counts: AttentionCountsResponse
    top_items: list[AttentionItemResponse]


class TriageSafetyControl(BaseModel):
    scope: str
    display_name: str
    enabled: bool
    expires_at: Optional[datetime] = None
    reason: Optional[str] = None


class TriageCriticalEvent(BaseModel):
    id: int
    action: str
    entity_type: str
    entity_id: Optional[int] = None
    actor_email: Optional[str] = None
    reason: Optional[str] = None
    created_at: datetime


class TriageSummaryResponse(BaseModel):
    generated_at: datetime
    incidents: TriageIncidentsSection
    pipeline_stages: list[JobHealthItem]
    scheduler_enabled: bool
    safety_controls: list[TriageSafetyControl]
    critical_events: list[TriageCriticalEvent]
