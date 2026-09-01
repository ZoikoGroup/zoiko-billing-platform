"""
modules/super_admin/schemas.py
------------------------------
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

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
    # Phase 4 (G-02) — evidence of who last changed this setting. None means
    # no recorded actor exists (row predates audit coverage) and renders as
    # UNKNOWN, never as a fabricated name.
    updated_by_email: Optional[str] = None

    @model_validator(mode="after")
    def _mask_sensitive_value(self):
        if is_sensitive_setting_key(self.key):
            self.is_sensitive = True
            if self.value:
                self.value = MASKED_VALUE_PLACEHOLDER
        return self


# ── Configuration governance read model (Phase 4, G-03) ────────────────────
# One inventory composed from three real sources: DB platform settings,
# code-declared operational thresholds (imported live from their owning
# modules so this view cannot drift from enforcement), and environment
# capability status (presence only). See configuration_service.py.


class ConfigurationEntry(BaseModel):
    name: str
    category: str  # platform_setting | operational_threshold | environment_capability
    value_kind: str  # value | masked | status
    value: Optional[str] = None
    is_sensitive: bool = False
    source: str  # where the value actually lives ("platform_settings", "code:<module>::<attr>", "environment")
    scope: str = "platform"
    mutable: bool = False
    effective_from: Optional[datetime] = None  # None => UNKNOWN (no recorded evidence)
    last_updated_at: Optional[datetime] = None
    updated_by: Optional[str] = None  # email or None => UNKNOWN
    audit_status: str
    description: Optional[str] = None


class ConfigurationInventoryResponse(BaseModel):
    generated_at: datetime
    environment: str = "PRODUCTION"
    entries: list[ConfigurationEntry]
    summary: dict[str, int] = {}
    honesty_notes: list[str] = []


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
    # P14: truthful invite-email outcome — None = no email attempted
    # (send_invite=False), True/False = the actual SMTP result.
    invite_email_sent: Optional[bool] = None

    # ── ZB-SA-P3 (Phase 3B) — additive, evidence-based fields ──────────────
    # derived_status: server-composed account state (active / suspended /
    # invited / locked). last_login_at: real last successful login; None is
    # rendered honestly as "never logged in" — never inferred.
    derived_status: Optional[str] = None
    last_login_at: Optional[datetime] = None

    # ── Organization's commercial subscription — only meaningful for
    # role == org_admin (an org_admin's own tenant); None for platform
    # accounts / users with no organization.
    subscription_status: Optional[str] = None
    subscription_plan_code: Optional[str] = None
    subscription_plan_name: Optional[str] = None
    trial_ends_at: Optional[datetime] = None
    recovery_ends_at: Optional[datetime] = None


class SuperAdminUserListResponse(BaseModel):
    users: list[SuperAdminUserResponse]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-P3 — Phase 3B Administrators & Users (Super-Admin-scoped mutations)
# Every mutation requires a documented reason and writes a platform audit
# event transactionally with the change.
# ═══════════════════════════════════════════════════════════════════════════════

class SuperAdminUserInviteRequest(BaseModel):
    organization_id: int
    email: EmailStr
    first_name: str = Field("", max_length=100)
    last_name: str = Field("", max_length=100)
    phone: str = Field("", max_length=50)
    role: UserRole  # must be a TENANT role (org_admin/billing_admin/...) — validated in the service
    send_invite: bool = True


class UserRoleChangeRequest(BaseModel):
    role: UserRole
    reason: str = Field(..., min_length=3, description="Mandatory audit justification")


class UserMembershipChangeRequest(BaseModel):
    organization_id: Optional[int] = Field(None, description="Target organization (None removes tenant membership)")
    reason: str = Field(..., min_length=3)


class UserStatusChangeRequest(BaseModel):
    is_active: bool
    reason: str = Field(..., min_length=3)


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


# ZB-SA-P3 Phase 3D — per-tenant operational health (Domain C purity: counts,
# states and timestamps only; never a monetary value or a derived score).
class TenantHealthOrganizationRow(BaseModel):
    id: int
    organization_code: str
    organization_name: str
    lifecycle_state: str
    total_users: int = 0
    active_users: int = 0
    suspended_users: int = 0
    unverified_users: int = 0
    org_admins: int = 0
    open_incident_count: int = 0
    worst_open_severity: Optional[str] = None
    last_incident_at: Optional[datetime] = None
    last_activity_at: Optional[datetime] = None
    plane: str = "TENANT"


class TenantHealthSummary(BaseModel):
    total_organizations: int
    counts_by_lifecycle_state: dict[str, int]
    open_incident_total: int
    jobs_tracked: int
    jobs_with_failures_24h: int
    jobs_not_fresh: int


class TenantHealthOverviewResponse(BaseModel):
    summary: TenantHealthSummary
    organizations: list[TenantHealthOrganizationRow]
    generated_at: datetime
    plane: str = "PLATFORM"


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


class AttentionEscalateRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=1000)


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
    # Phase 4 (G-06) — status/plane enrichment so a hit can be triaged from
    # the result list itself. status is the entity's real lifecycle/status
    # state (UNKNOWN when the row predates governed state); plane labels
    # which control plane the entity belongs to (TENANT vs PLATFORM) using
    # the spec's vocabulary, not a new one.
    status: Optional[str] = None
    severity: Optional[str] = None
    plane: Optional[str] = None


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
    run_id: Optional[str] = None
    evaluated_at: Optional[datetime] = None
    total_invoices_checked: int
    coverage: Optional[dict] = None
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



class FinancialCurrencyBucket(BaseModel):
    """Per-currency monetary bucket (Phase 4 G-01). Amounts are NEVER summed
    across currencies at this level or above."""

    currency: str
    invoice_count: int
    invoiced_amount: str
    collected_amount: str
    overdue_count: int
    overdue_amount: str


class FinancialBillingsSummary(BaseModel):
    """Plane 2 billings summary with currency honesty (Phase 4, G-01).

    Scalar amounts are populated ONLY when every invoice shares one currency
    (`currency_state == "single_currency"`). Multi-currency platforms carry
    per-currency buckets with no combined figure; an empty database reports
    ``unknown`` — never zero. ``overdue_count`` is a count and remains safe
    to total across currencies.
    """

    total_invoices: int
    currency_state: str  # "unknown" | "single_currency" | "multi_currency"
    currencies: list[FinancialCurrencyBucket] = []
    overdue_count: int = 0
    basis: str = ""
    invoiced_amount: Optional[str] = None
    collected_amount: Optional[str] = None
    overdue_amount: Optional[str] = None


class FinancialRecoverySummary(BaseModel):
    failed_payments_count: int
    dunning_cycle_status: str
    active_dunning_cases_count: int = 0
    resolved_dunning_cases_count: int = 0


class FinancialLeakageSummary(BaseModel):
    over_allocated_count: int
    under_allocated_paid_count: int
    unbilled_usage_anomalies: int
    active_credit_notes_count: int


class FinancialOperationsSummaryResponse(BaseModel):
    consistency: FinancialConsistencyResponse
    billings: FinancialBillingsSummary
    recovery: FinancialRecoverySummary
    leakage: FinancialLeakageSummary


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 — Billing Command Center read models (Domain B, cross-tenant)
# Currency honesty rule identical to FinancialBillingsSummary: per-currency
# buckets always; scalar amounts only when single_currency; multi-currency
# responses additionally carry a `primary_currency` (largest invoiced bucket)
# with every chart/card figure explicitly scoped to it — never a cross-currency
# sum.
# ═══════════════════════════════════════════════════════════════════════════════

class BillingCommandCurrencyBucket(BaseModel):
    currency: str
    invoice_count: int
    invoiced_amount: str
    collected_amount: str
    outstanding_amount: str
    current_amount: str
    overdue_amount: str
    overdue_count: int


class BillingCommandKpis(BaseModel):
    currency_state: str  # unknown | single_currency | multi_currency
    primary_currency: Optional[str] = None
    total_invoices: int = 0
    overdue_count: int = 0
    # Scalar conveniences — populated ONLY when currency_state == "single_currency".
    invoiced_amount: Optional[str] = None
    collected_amount: Optional[str] = None
    outstanding_amount: Optional[str] = None
    current_amount: Optional[str] = None
    overdue_amount: Optional[str] = None
    collection_rate_pct: Optional[float] = None
    # Figures scoped to primary_currency (labeled as such in the UI).
    display_invoiced_amount: Optional[str] = None
    display_collected_amount: Optional[str] = None
    display_outstanding_amount: Optional[str] = None
    display_current_amount: Optional[str] = None
    display_overdue_amount: Optional[str] = None
    display_collection_rate_pct: Optional[float] = None
    currencies: list[BillingCommandCurrencyBucket] = []


class BillingSparklines(BaseModel):
    """Trailing daily series in the display currency (last ~12 days)."""

    billed: list[float] = []
    collected: list[float] = []
    newly_overdue: list[float] = []
    rate: list[float] = []


class BillingAgingBucket(BaseModel):
    key: str
    label: str
    count: int
    amount: str
    pct: float


class BillingActionCenter(BaseModel):
    overdue_30d_count: int
    overdue_30d_amount: str
    failed_payments_count: int
    failed_payments_amount: str
    draft_invoices_count: int
    draft_invoices_amount: str
    active_dunning_cases_count: int
    active_credit_notes_count: int


class BillingNextSevenDays(BaseModel):
    invoices_scheduled: int
    expected_billing_amount: Optional[str] = None
    expected_billing_currency: Optional[str] = None
    renewals: int
    payment_retries: int
    quotes_expiring: int


class BillingOverviewResponse(BaseModel):
    generated_at: datetime
    kpis: BillingCommandKpis
    sparklines: BillingSparklines
    aging: list[BillingAgingBucket]
    aging_basis: dict
    action_center: BillingActionCenter
    next_seven_days: BillingNextSevenDays
    customers_at_risk: int


class BillingTrendPoint(BaseModel):
    label: str
    billed: float
    collected: float
    collection_rate_pct: float


class BillingTrendResponse(BaseModel):
    granularity: str  # daily | weekly | monthly
    currency: Optional[str] = None
    currency_state: str
    available_currencies: list[str] = []
    points: list[BillingTrendPoint]


class OverdueInvoiceRow(BaseModel):
    invoice_id: int
    organization_id: int
    organization_name: str
    invoice_number: str
    customer_id: int
    customer_name: str
    due_date: date
    days_overdue: int
    amount: str
    currency: str


class OverdueInvoiceListResponse(BaseModel):
    total: int
    invoices: list[OverdueInvoiceRow]


class CollectionsRiskRow(BaseModel):
    customer_id: int
    customer_name: str
    organization_name: str
    outstanding: str
    currency: str
    risk: str  # High | Medium
    last_activity: Optional[date] = None
    note: str


class CollectionsRiskListResponse(BaseModel):
    rows: list[CollectionsRiskRow]


class BillingActivityItem(BaseModel):
    kind: str  # payment_received | payment_failed | invoice_sent | subscription_changed
    title: str
    meta: str
    actor: Optional[str] = None
    occurred_at: Optional[datetime] = None


class BillingActivityListResponse(BaseModel):
    items: list[BillingActivityItem]


# ═══════════════════════════════════════════════════════════════════════════════
# Financial Operations detail pages — Invoice Engine, Payments & Disputes,
# Balances & Allocations, Reconciliation, Credits/Adjustments/Refunds, Tax.
# Cross-tenant read models backing the split of the former single shared
# FinancialOperationsPage into its 7 sidebar sub-pages.
# ═══════════════════════════════════════════════════════════════════════════════

class InvoiceStatusBucket(BaseModel):
    status: str
    count: int
    total_amount: str


class InvoiceStatusDistributionResponse(BaseModel):
    buckets: list[InvoiceStatusBucket]
    total_invoices: int


class InvoiceDeliveryDiagnosticsResponse(BaseModel):
    sent: int
    delivered: int
    failed: int
    bounced: int
    total: int


class FailedPaymentRow(BaseModel):
    payment_id: int
    organization_id: int
    organization_name: str
    customer_name: str
    amount: str
    currency: str
    failure_code: Optional[str] = None
    failure_reason: Optional[str] = None
    payment_date: Optional[date] = None
    attempt_count: int = 0


class FailedPaymentListResponse(BaseModel):
    total: int
    items: list[FailedPaymentRow]


class DunningCaseRow(BaseModel):
    dunning_case_id: int
    organization_id: int
    organization_name: str
    customer_name: str
    invoice_id: Optional[int] = None
    invoice_number: Optional[str] = None
    currency: str
    status: str
    current_level: int
    total_overdue_amount: str
    days_overdue: int
    last_action_at: Optional[datetime] = None
    next_action_at: Optional[date] = None


class DunningCaseListResponse(BaseModel):
    total: int
    items: list[DunningCaseRow]


class AllocationExceptionRow(BaseModel):
    invoice_id: int
    organization_id: int
    organization_name: str
    invoice_number: str
    currency: str
    total_amount: str
    allocated_amount: str


class AllocationExceptionListResponse(BaseModel):
    total: int
    items: list[AllocationExceptionRow]


class CreditApplicationRow(BaseModel):
    application_id: int
    organization_id: int
    organization_name: str
    credit_note_number: str
    invoice_number: str
    amount: str
    currency: str
    created_at: Optional[datetime] = None


class CreditApplicationListResponse(BaseModel):
    total: int
    items: list[CreditApplicationRow]


class StatusCount(BaseModel):
    status: str
    count: int


class CreditNoteRow(BaseModel):
    credit_note_id: int
    organization_id: int
    organization_name: str
    customer_name: str
    credit_note_number: str
    credit_note_type: str
    status: str
    total_amount: str
    remaining_amount: str
    currency: str
    issue_date: Optional[date] = None


class CreditNoteListResponse(BaseModel):
    total: int
    items: list[CreditNoteRow]
    status_distribution: list[StatusCount]


class RefundRow(BaseModel):
    refund_id: int
    organization_id: int
    organization_name: str
    customer_name: str
    refund_number: str
    refund_type: str
    status: str
    amount: str
    currency: str
    reason: Optional[str] = None
    created_at: Optional[datetime] = None


class RefundListResponse(BaseModel):
    total: int
    items: list[RefundRow]
    status_distribution: list[StatusCount]


class WriteOffRow(BaseModel):
    write_off_id: int
    organization_id: int
    organization_name: str
    customer_name: str
    write_off_number: str
    write_off_type: str
    status: str
    amount: str
    currency: str
    reason: Optional[str] = None
    created_at: Optional[datetime] = None


class WriteOffListResponse(BaseModel):
    total: int
    items: list[WriteOffRow]
    status_distribution: list[StatusCount]


class TaxSummaryBucket(BaseModel):
    currency: str
    jurisdiction: str
    tax_type: str
    record_count: int
    taxable_amount: str
    tax_amount: str


class TaxSummaryResponse(BaseModel):
    buckets: list[TaxSummaryBucket]
    total_records: int


# ── Reconciliation (REC-01) — typed schemas for the previously dict-typed
# /reconciliation-runs* endpoints. Shapes match _serialize_reconciliation_run
# and the inline exception dicts in router.py exactly — no behavior change.

class ReconciliationExceptionResponse(BaseModel):
    id: int
    run_id: int
    kind: str
    organization_id: Optional[int] = None
    entity_type: str
    entity_id: Optional[int] = None
    detail: Optional[dict] = None
    status: str
    owner_user_id: Optional[int] = None
    acknowledged_at: Optional[str] = None
    resolved_at: Optional[str] = None
    resolution_note: Optional[str] = None


class ReconciliationRunResponse(BaseModel):
    id: int
    state: str
    started_at: str
    finished_at: Optional[str] = None
    trigger: str
    checks_total: int
    exceptions_found: int
    processor_source: str
    processor_note: Optional[str] = None
    # ISS-017: set only when compare_processor=True was requested for this
    # run. processor_stats never contains secrets — range, org ids, counts,
    # and safe error categories/messages only (see stripe_reconciliation.py).
    processor_environment: Optional[str] = None
    processor_stats: Optional[dict] = None


class ReconciliationRunListResponse(BaseModel):
    items: list[ReconciliationRunResponse]


class ReconciliationRunDetailResponse(ReconciliationRunResponse):
    exceptions: list[ReconciliationExceptionResponse] = []


class TriggerReconciliationRunRequest(BaseModel):
    """ISS-017: optional processor-comparison extension to the existing
    manual-trigger endpoint. Omitting this body (or `compare_processor`)
    preserves the exact pre-Phase-11 behavior — internal checks only."""
    compare_processor: bool = False
    range_start: Optional[date] = None
    range_end: Optional[date] = None


class ReconciliationExceptionActionResponse(BaseModel):
    id: int
    status: str
    owner_user_id: Optional[int] = None
    acknowledged_at: Optional[str] = None
    resolved_at: Optional[str] = None
    resolution_note: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-P3 — Phase 3A Organizations workspace (directory + overview)
# Identity / lifecycle / operational counts ONLY. No monetary values ever
# appear in these read models (Domain B stays behind privileged access).
# ═══════════════════════════════════════════════════════════════════════════════

class OrganizationDirectoryItem(BaseModel):
    id: int
    organization_code: str
    organization_name: str
    country: Optional[str] = None
    currency: Optional[str] = None
    is_active: bool
    lifecycle_state: str
    billing_classification: Optional[str] = None
    billing_source: Optional[str] = None
    commercial_account_status: Optional[str] = None
    can_charge: bool = False
    subscription_status: Optional[str] = None
    subscription_plan_code: Optional[str] = None
    subscription_plan_name: Optional[str] = None
    trial_ends_at: Optional[datetime] = None
    recovery_ends_at: Optional[datetime] = None
    total_users: int = 0
    active_users: int = 0
    org_admins: int = 0
    unverified_users: int = 0
    open_incident_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Latest real activity evidence (org update / platform audit / incident);
    # None means "no recorded evidence" and is rendered honestly as UNKNOWN.
    last_activity_at: Optional[datetime] = None
    plane: str = "TENANT"


class OrganizationDirectoryResponse(BaseModel):
    total: int
    organizations: list[OrganizationDirectoryItem]


class OrganizationAdministratorItem(BaseModel):
    id: int
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    is_active: bool
    is_verified: bool
    last_login_at: Optional[datetime] = None


class OrganizationUserLoginItem(BaseModel):
    email: str
    last_login_at: datetime


class OrganizationUserSummary(BaseModel):
    total_users: int = 0
    active_users: int = 0
    suspended_users: int = 0
    invited_unverified: int = 0
    by_role: dict[str, int]
    recent_logins: list[OrganizationUserLoginItem]


class OrganizationAuditEventItem(BaseModel):
    id: int
    action: Optional[str] = None
    entity_type: str
    entity_id: Optional[int] = None
    actor_role: Optional[str] = None
    reason: Optional[str] = None
    correlation_id: Optional[str] = None
    created_at: Optional[datetime] = None


class OrganizationPrivilegedGrantItem(BaseModel):
    id: int
    status: str
    ticket_reference: str
    reason: str
    scope: str
    requested_minutes: int
    requested_at: datetime
    activated_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    exited_at: Optional[datetime] = None


class OrganizationOverviewResponse(BaseModel):
    organization: OrganizationDirectoryItem
    lifecycle_state: str
    allowed_transitions: list[str]
    access_blocked: bool
    onboarding_readiness: dict[str, str]
    onboarding_blockers: list[str]
    administrators: list[OrganizationAdministratorItem]
    user_summary: OrganizationUserSummary
    recent_audit_events: list[OrganizationAuditEventItem]
    recent_privileged_grants: list[OrganizationPrivilegedGrantItem]
    generated_at: datetime
    plane: str = "TENANT"


class LifecycleTransitionRequest(BaseModel):
    target: str = Field(..., description="Target TenantLifecycleState value")
    reason: str = Field(..., min_length=3, description="Mandatory human-readable justification")


class LifecycleTransitionResponse(BaseModel):
    organization_id: int
    organization_code: str
    previous_state: str
    current_state: str
    is_active: bool
    allowed_transitions: list[str]
    correlation_id: str
    plane: str = "TENANT"


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-SA-P3 — Phase 3C Platform Lifecycle & Onboarding (fleet-wide read model)
# ═══════════════════════════════════════════════════════════════════════════════

class OnboardingPipelineItem(BaseModel):
    id: int
    organization_code: str
    organization_name: str
    state: str
    registered_at: Optional[datetime] = None
    onboarding_readiness: dict[str, str]
    blockers: list[str] = []


class BlockedOrganizationItem(BaseModel):
    id: int
    organization_code: str
    organization_name: str
    lifecycle_state: str
    last_transition_reason: Optional[str] = None
    last_transition_at: Optional[datetime] = None


class LifecycleTransitionEventItem(BaseModel):
    id: int
    organization_id: Optional[int] = None
    organization_code: Optional[str] = None
    organization_name: Optional[str] = None
    from_state: Optional[str] = None
    to_state: Optional[str] = None
    reason: Optional[str] = None
    correlation_id: Optional[str] = None
    actor_email: Optional[str] = None
    created_at: Optional[datetime] = None


class PlatformLifecycleResponse(BaseModel):
    total_organizations: int
    counts_by_state: dict[str, int]
    onboarding_pipeline: list[OnboardingPipelineItem]
    blocked_organizations: list[BlockedOrganizationItem]
    recent_transitions: list[LifecycleTransitionEventItem]
    generated_at: datetime
    plane: str = "PLATFORM"


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3F F10 — Plane 1 SaaS reporting (honest read model)
# ═══════════════════════════════════════════════════════════════════════════════


class SaasPlanOpenCount(BaseModel):
    plan_id: int
    plan_code: str
    plan_name: Optional[str] = None
    open_subscriptions: int


class SaasPlanPriceCoverage(BaseModel):
    """Per-plan price-book coverage (Phase 4, G-04): explains WHERE the
    unpriced open subscriptions named in MRR coverage actually live, so the
    gap is actionable per plan instead of only visible in aggregate."""

    plan_id: int
    plan_code: str
    plan_name: Optional[str] = None
    open_subscriptions_total: int
    open_subscriptions_priced: int
    # unpriced_open_subscriptions == total - priced (denormalized for the UI)
    unpriced_open_subscriptions: int
    # True when the plan has at least one PUBLISHED catalog version with a
    # non-null price_amount — i.e. a usable price book exists.
    has_published_price_book: bool
    priced_state: str  # fully_priced | partially_priced | unpriced


class SaasMrrCurrencyItem(BaseModel):
    currency: str
    monthly_amount: Decimal
    subscriptions: int


class SaasMrrCoverage(BaseModel):
    open_subscriptions_total: int
    open_subscriptions_priced: int
    plans_with_published_price: int


class SaasMrr(BaseModel):
    """MRR is only ever 'computed' from priced published catalog versions;
    'unknown' when no open subscription carries a price; per-currency when
    mixed currencies make a single total meaningless."""

    state: str  # computed | unknown | multi_currency
    amount: Optional[Decimal] = None
    currencies: list[SaasMrrCurrencyItem]
    coverage: SaasMrrCoverage
    basis: str


class SaasAccountsReporting(BaseModel):
    total: int
    by_status: dict[str, int]


class SaasSubscriptionsReporting(BaseModel):
    total_ever: int
    total_open: int
    by_status: dict[str, int]
    open_by_plan: list[SaasPlanOpenCount]
    # Phase 4 (G-04) — per-plan price-book coverage explanation.
    coverage_by_plan: list[SaasPlanPriceCoverage] = []


class SaasReportingResponse(BaseModel):
    generated_at: datetime
    accounts: SaasAccountsReporting
    subscriptions: SaasSubscriptionsReporting
    mrr: SaasMrr
    plane: str = "PLATFORM"
    honesty_notes: list[str]
