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


class PlatformAuditAction(str, enum.Enum):
    """Actions recorded on the platform-plane audit trail.

    Scoped to the mutation surface that exists today (CommercialPlan
    management). New platform mutations may extend this enum in future
    phases; actions are stored as enum names via CaseInsensitiveEnum.
    """

    CREATE = "create"
    UPDATE = "update"
    ACTIVATE = "activate"
    DEACTIVATE = "deactivate"
    SET_DEFAULT = "set_default"
    CLEAR_DEFAULT = "clear_default"
    ARCHIVE = "archive"


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
