"""
modules/super_admin/models.py
-----------------------------
Platform-level configuration and audit for the standalone Billing Platform.

Deliberately minimal: the old platform's super_admin module held
PlatformProduct / OrganizationProduct / LoginActivity tables that the
Billing module never imports. The standalone platform keeps PlatformSetting
(key/value config, e.g. SMTP override) plus, since PHASE 11, the
platform-plane audit trail (PlatformAuditLog) that records Super Admin
mutations of platform entities (e.g. CommercialPlan templates).

PlatformAuditLog is the PLATFORM-plane audit store — deliberately distinct
from the org-scoped billing_audit_logs table (BillingAuditLog), whose
organization_id is NOT NULL and which documents tenant-facing billing
operations. Platform events may reference an org (organization_id) or be
org-agnostic (NULL), so the two audit domains never overlap.
"""

import enum
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import relationship

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.commercial.enums import ApprovalStatus


class PlatformAuditAction(str, enum.Enum):
    """Actions recorded on the platform-plane audit trail.

    Covers CommercialPlan management and Organization lifecycle mutations
    (create/activate/deactivate/delete). New platform mutations may extend
    this enum in future phases; actions are stored as enum names via
    CaseInsensitiveEnum.
    """

    CREATE = "create"
    UPDATE = "update"
    ACTIVATE = "activate"
    DEACTIVATE = "deactivate"
    SET_DEFAULT = "set_default"
    CLEAR_DEFAULT = "clear_default"
    ARCHIVE = "archive"
    DELETE = "delete"
    SUBMIT = "submit"
    PUBLISH = "publish"
    REJECT = "reject"

    # ── Super Admin MFA (release-blocker pass, Blocker 4) ──────────────
    MFA_ENROLLED = "mfa_enrolled"
    MFA_ENABLED = "mfa_enabled"
    MFA_DISABLED = "mfa_disabled"
    MFA_CHALLENGE_SUCCESS = "mfa_challenge_success"
    MFA_CHALLENGE_FAILURE = "mfa_challenge_failure"
    MFA_RECOVERY_CODE_USED = "mfa_recovery_code_used"
    MFA_ADMIN_RESET = "mfa_admin_reset"

    # ── ZB-SA-CMD-003 §6/§7 — Domain B privileged tenant support access ──
    PRIVILEGED_ACCESS_REQUESTED = "privileged_access_requested"
    PRIVILEGED_ACCESS_STEP_UP_FAILED = "privileged_access_step_up_failed"
    PRIVILEGED_ACCESS_GRANTED = "privileged_access_granted"
    PRIVILEGED_ACCESS_VIEWED = "privileged_access_viewed"
    PRIVILEGED_ACCESS_EXITED = "privileged_access_exited"
    PRIVILEGED_ACCESS_EXPIRED = "privileged_access_expired"
    PRIVILEGED_ACCESS_DENIED = "privileged_access_denied"

    # ── ZB-SA-CMD-003 §10/§11 — Attention Engine / incident lifecycle ────
    ATTENTION_OPENED = "attention_opened"
    ATTENTION_REOPENED = "attention_reopened"
    ATTENTION_ACKNOWLEDGED = "attention_acknowledged"
    ATTENTION_ASSIGNED = "attention_assigned"
    ATTENTION_TRANSITIONED = "attention_transitioned"
    ATTENTION_RESOLVED = "attention_resolved"
    ATTENTION_SUPPRESSED = "attention_suppressed"
    ATTENTION_ESCALATED = "attention_escalated"


class PlatformAuditLog(Base):
    """Platform-plane audit trail for Super Admin mutations.

    Written transactionally via PlatformAuditService.log_no_commit: the row
    is flushed into the CALLER's transaction and only ever persists when that
    transaction commits, so a failed mutation can never leave an orphaned
    audit entry (all-or-nothing with the change it describes).

    Data classification (what is / is not stored):
      - actor_id: the Super Admin user id (no passwords, tokens, or JWT).
      - entity_type / entity_id: the audited platform entity.
      - organization_id: optional org reference for org-attached platform
        events; NULL for org-agnostic events (e.g. plan templates).
      - old_values / new_values: structured before/after state of the
        mutated entity's auditable fields (plan structure, status, defaults).
        Never secrets.
      - metadata: small non-sensitive context (e.g. transition name).
    """

    __tablename__ = "platform_audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    actor_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    action = Column(CaseInsensitiveEnum(PlatformAuditAction), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(Integer, nullable=True)
    organization_id = Column(
        Integer,
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    old_values = Column(JSON, nullable=True)
    new_values = Column(JSON, nullable=True)
    # DB column "metadata" (as specified for the table); the Python attribute
    # is metadata_ because "metadata" is reserved by the SQLAlchemy
    # Declarative API (Base.metadata).
    metadata_ = Column("metadata", JSON, nullable=True)
    # ZB-COM-BILL-001 §R3 / §29: audit events must capture actor + ROLE +
    # a human REASON + a correlation_id linking related events (e.g. an
    # ApprovalRequest and the change it authorized). Nullable/additive —
    # existing rows predate these columns and remain valid with them unset.
    actor_role = Column(String(50), nullable=True)
    reason = Column(Text, nullable=True)
    correlation_id = Column(String(100), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    actor = relationship("User", foreign_keys=[actor_id])
    organization = relationship("Organization", foreign_keys=[organization_id])

    __table_args__ = (
        # Index for entity lookups
        Index("ix_platform_audit_logs_entity", "entity_type", "entity_id"),
        Index("ix_platform_audit_logs_action", "action"),
        Index("ix_platform_audit_logs_created_at", "created_at"),
    )

    def __repr__(self):
        return (
            f"<PlatformAuditLog id={self.id} "
            f"entity={self.entity_type}:{self.entity_id} action={self.action}>"
        )


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(100), unique=True, index=True, nullable=False)
    value = Column(Text, nullable=True)
    description = Column(String(500), nullable=True)
    # Read by billing's admin_service.py / email_service.py to select the
    # SMTP override rows (category == "email").
    category = Column(String(100), nullable=False, default="general", server_default="general")
    is_public = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<PlatformSetting key={self.key!r}>"


class ApprovalRequest(Base):
    """Generic, reusable maker-checker request (ZB-COM-BILL-001 Phase 5).

    Deliberately domain-agnostic — `request_type` names what's being
    approved (e.g. "catalog_version_publish"); `scope` / `before_state` /
    `proposed_state` carry the domain-specific payload as JSON so this one
    table can serve any future material-operation approval without a schema
    change. The critical invariant, enforced in ApprovalService (never just
    in the UI): the approver can never be the same user as requested_by.
    """

    __tablename__ = "approval_requests"

    id = Column(Integer, primary_key=True, index=True)
    request_type = Column(String(100), nullable=False, index=True)
    requested_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    requested_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    reason = Column(Text, nullable=True)
    scope = Column(JSON, nullable=True)
    before_state = Column(JSON, nullable=True)
    proposed_state = Column(JSON, nullable=True)
    evidence = Column(JSON, nullable=True)
    approver_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    rejection_reason = Column(Text, nullable=True)
    status = Column(
        CaseInsensitiveEnum(ApprovalStatus),
        default=ApprovalStatus.PENDING,
        server_default="PENDING",
        nullable=False,
        index=True,
    )
    # Links this approval to the audit trail entries it authorized (see
    # PlatformAuditLog.correlation_id) and to the domain object it governs
    # (e.g. a CommercialPlanVersion.id) without a hard FK, since request_type
    # determines which table that id belongs to.
    correlation_id = Column(String(100), nullable=True, index=True)

    requested_by = relationship("User", foreign_keys=[requested_by_user_id])
    approver = relationship("User", foreign_keys=[approver_user_id])

    def __repr__(self):
        return f"<ApprovalRequest id={self.id} type={self.request_type!r} status={self.status!r}>"


class BillingKillSwitch(Base):
    """Narrow, real, audited circuit-breaker state (ZB-COM-BILL-001 §30.1 /
    ZB-SA-CMD-003 §9).

    One row per gated scope. Each scope is enforced at real service-layer
    code paths (see kill_switch_service.py's catalog) — never a UI-only
    toggle. Engaging a breaker (enabled=False) stops NEW gated actions; it
    never mutates or deletes existing data (read access is unaffected), and
    always carries a mandatory auto-expiry deadline (`expires_at`, §9.1).
    """

    __tablename__ = "billing_kill_switches"

    id = Column(Integer, primary_key=True, index=True)
    # One row per gated scope; "commercial_subscription_charging" is the only
    # scope wired up this pass. Additional scopes may be added later without
    # a schema change (new rows, not new columns).
    scope = Column(String(100), unique=True, index=True, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False, server_default="1")
    reason = Column(Text, nullable=True)
    # ZB-SA-CMD-003 §9.1 — "All breakers auto-expire. Permanent breaker
    # states are prohibited." When the breaker is engaged (enabled=False)
    # this carries the mandatory lift deadline; lazily evaluated on every
    # is_enabled()/require_enabled() call (same pattern as grant expiry).
    expires_at = Column(DateTime, nullable=True)
    changed_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    changed_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    changed_by = relationship("User", foreign_keys=[changed_by_user_id])

    def __repr__(self):
        return f"<BillingKillSwitch scope={self.scope!r} enabled={self.enabled}>"


# ═══════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §6/§7 — Domain B: privileged, just-in-time tenant support
# access. Deliberately separate from ApprovalRequest (that table is a
# generic BEFORE-the-fact maker-checker gate for a proposed state change;
# this one is a TIME-BOXED GRANT whose own lifecycle — pending step-up,
# active, exited, expired, denied — is the thing being modeled, with no
# "before/proposed state" payload to carry). No tenant data itself is
# stored here; only the fact and scope of who was allowed to look at it,
# for how long, and why.
# ═══════════════════════════════════════════════════════════════════════════

class PrivilegedAccessStatus(str, enum.Enum):
    PENDING_STEP_UP = "pending_step_up"
    ACTIVE = "active"
    EXITED = "exited"
    EXPIRED = "expired"
    DENIED = "denied"


class PrivilegedTenantAccessGrant(Base):
    """One row per Domain-B support-access request/grant.

    Lifecycle: PENDING_STEP_UP (requested, awaiting a fresh MFA code) ->
    ACTIVE (step-up verified, `expires_at` set, default/max 30 minutes) ->
    EXITED (explicit) | EXPIRED (lazily detected — see
    PrivilegedAccessService._expire_if_stale) | DENIED (step-up failed or
    request went stale before activation).

    `requested_by_user_id` is always a super_admin (the only role this
    engagement wires up to request tenant access — see
    get_current_super_admin on every router endpoint below). `scope` is a
    fixed, narrow constant today (read-only financial summary; no
    export/download surface exists for it at all, so there is nothing to
    disable) — kept as a column rather than a hardcoded assumption so a
    future, more granular scope model doesn't require a migration.
    """

    __tablename__ = "privileged_tenant_access_grants"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(
        Integer,
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    requested_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    reason = Column(Text, nullable=False)
    ticket_reference = Column(String(100), nullable=False)
    scope = Column(String(100), nullable=False, default="read_only_financial_summary", server_default="read_only_financial_summary")
    status = Column(
        CaseInsensitiveEnum(PrivilegedAccessStatus),
        default=PrivilegedAccessStatus.PENDING_STEP_UP,
        server_default="PENDING_STEP_UP",
        nullable=False,
        index=True,
    )
    correlation_id = Column(String(100), nullable=False, index=True)
    requested_minutes = Column(Integer, nullable=False, default=30, server_default="30")

    requested_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    activated_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True, index=True)
    exited_at = Column(DateTime, nullable=True)

    organization = relationship("Organization", foreign_keys=[organization_id])
    requested_by = relationship("User", foreign_keys=[requested_by_user_id])

    __table_args__ = (
        Index("ix_privileged_access_actor_status", "requested_by_user_id", "status"),
    )

    def __repr__(self):
        return (
            f"<PrivilegedTenantAccessGrant id={self.id} org={self.organization_id} "
            f"status={self.status!r}>"
        )


# ═══════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §8 — Domain C: cross-tenant operational telemetry only.
# One row per background-job execution (see core/scheduler.py's
# _tracked_job_runner). Deliberately holds no tenant identifiers, no
# monetary amounts, and no per-tenant breakdown — job name, outcome,
# timing and an error message are the entire allowed vocabulary here.
# ═══════════════════════════════════════════════════════════════════════════

class JobRunStatus(str, enum.Enum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobRunLog(Base):
    __tablename__ = "job_run_logs"

    id = Column(Integer, primary_key=True, index=True)
    job_name = Column(String(100), nullable=False, index=True)
    display_name = Column(String(200), nullable=True)
    status = Column(
        CaseInsensitiveEnum(JobRunStatus),
        default=JobRunStatus.RUNNING,
        server_default="RUNNING",
        nullable=False,
        index=True,
    )
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_job_run_logs_job_started", "job_name", "started_at"),
    )

    def __repr__(self):
        return f"<JobRunLog job={self.job_name!r} status={self.status!r}>"


# ═══════════════════════════════════════════════════════════════════════════
# ZB-SA-CMD-003 §10/§11 — Attention Engine + incident lifecycle.
#
# Deliberately fed only by REAL signals that exist in this codebase today:
# scheduled-job failure/recovery (core/scheduler.py:_tracked_job_runner) and
# the billing kill switch being disabled (kill_switch_service.py). No
# synthetic/demo attention items are ever created. `source_key` is the
# dedup/root-cause-grouping key: AttentionService.report_or_update() looks
# up an existing non-CLOSED row by source_key before creating a new one, so
# one flapping job produces one item with a growing occurrence_count, not a
# new row per failure — and reopens a RESOLVED row (preserving its history)
# rather than starting a clean timeline, per the spec's reopening rule.
# ═══════════════════════════════════════════════════════════════════════════

class AttentionSeverity(str, enum.Enum):
    P0 = "p0"
    P1 = "p1"
    P2 = "p2"
    P3 = "p3"


class AttentionStatus(str, enum.Enum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    ASSIGNED = "assigned"
    MITIGATING = "mitigating"
    MONITORING = "monitoring"
    RESOLVED = "resolved"
    CLOSED = "closed"
    SUPPRESSED = "suppressed"


class AttentionItem(Base):
    __tablename__ = "attention_items"

    id = Column(Integer, primary_key=True, index=True)
    source = Column(String(50), nullable=False)  # "job_failure" | "kill_switch" | "manual"
    source_key = Column(String(150), nullable=False, index=True)  # dedup/grouping key
    title = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    severity = Column(CaseInsensitiveEnum(AttentionSeverity), nullable=False, index=True)
    status = Column(
        CaseInsensitiveEnum(AttentionStatus),
        default=AttentionStatus.OPEN,
        server_default="OPEN",
        nullable=False,
        index=True,
    )
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    occurrence_count = Column(Integer, nullable=False, default=1, server_default="1")
    correlation_id = Column(String(100), nullable=False, index=True)

    opened_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    acknowledged_at = Column(DateTime, nullable=True)
    assigned_at = Column(DateTime, nullable=True)
    mitigating_at = Column(DateTime, nullable=True)
    monitoring_at = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    reopened_at = Column(DateTime, nullable=True)
    resolution_code = Column(String(100), nullable=True)
    suppressed_until = Column(DateTime, nullable=True)
    suppression_reason = Column(Text, nullable=True)

    # ZB-SA-CMD-003 Table 24 — computed once at open/severity-escalation time
    # from wall-clock minutes (not a business-hours calendar; see
    # AttentionService docstring for that simplification).
    sla_ack_deadline = Column(DateTime, nullable=True)
    sla_mitigate_deadline = Column(DateTime, nullable=True)

    organization = relationship("Organization", foreign_keys=[organization_id])
    owner = relationship("User", foreign_keys=[owner_user_id])

    __table_args__ = (
        Index("ix_attention_items_source_key_status", "source_key", "status"),
    )

    def __repr__(self):
        return f"<AttentionItem id={self.id} source={self.source_key!r} severity={self.severity!r} status={self.status!r}>"
