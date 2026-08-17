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
    """Narrow, real, audited kill switch (ZB-COM-BILL-001 §30.1).

    Scoped to the ONE live commercial-charging code path that actually exists
    in this codebase today — CommercialSubscriptionService creating/activating
    a subscription (see can_charge_commercially() / the service-layer check).
    This deliberately does NOT claim to gate tenant payment webhooks or a
    Plane-1 payment processor, because neither exists yet — see the
    Production Acceptance report for what remains unimplemented. Disabling
    this switch stops NEW charging state; it never mutates or deletes
    existing subscriptions/data (read access is unaffected).
    """

    __tablename__ = "billing_kill_switches"

    id = Column(Integer, primary_key=True, index=True)
    # One row per gated scope; "commercial_subscription_charging" is the only
    # scope wired up this pass. Additional scopes may be added later without
    # a schema change (new rows, not new columns).
    scope = Column(String(100), unique=True, index=True, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False, server_default="1")
    reason = Column(Text, nullable=True)
    changed_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    changed_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    changed_by = relationship("User", foreign_keys=[changed_by_user_id])

    def __repr__(self):
        return f"<BillingKillSwitch scope={self.scope!r} enabled={self.enabled}>"
