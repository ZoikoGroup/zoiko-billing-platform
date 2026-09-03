"""
modules/notifications/models.py
--------------------------------
Foundation tables for the Zoiko Billing email-communications pipeline
(ZB-* template catalog). Five tables, each append-only or narrow-only:

- NotificationTemplateState: DB-level kill switch, one row per template_id.
  Can only ever narrow what template_registry.TEMPLATE_REGISTRY already
  declares active — it can never activate a template code hasn't wired up.
- SuppressedRecipient: hard-suppression ledger (bounce/complaint/manual/
  legal hold). Append-only — a lift and a later re-suppression both survive
  as separate rows, never overwritten or deleted.
- MarketingConsent: opt-in/opt-out ledger for T3/T4 sends. A revocation is
  its own new row (granted=False), never a delete or update of a prior grant.
- CommunicationSend: one-shot idempotency ledger, same shape as
  billing.models.StripeEvent — a unique dedupe_key prevents double-sending
  the same (event, entity, template) tuple.
- CommunicationLog: append-only outcome record of every send attempt
  (sent/suppressed/failed/skipped), for audit/ops queries.
"""

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import relationship

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base


class SuppressionReason(str, enum.Enum):
    HARD_BOUNCE = "hard_bounce"
    COMPLAINT = "complaint"
    MANUAL = "manual"
    LEGAL_HOLD = "legal_hold"


class MarketingConsentScope(str, enum.Enum):
    ORG_LEVEL = "org_level"
    RECIPIENT_LEVEL = "recipient_level"


class CommunicationSendStatus(str, enum.Enum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"


class CommunicationLogStatus(str, enum.Enum):
    SENT = "sent"
    SUPPRESSED = "suppressed"
    FAILED = "failed"
    SKIPPED_INACTIVE = "skipped_inactive"


class NotificationTemplateState(Base):
    """DB-level kill switch for a template_id declared in TEMPLATE_REGISTRY.

    No auto-expiry: disabling a template because its copy or legal review
    failed must never silently self-re-enable. Re-enabling is always an
    explicit second action by an operator.
    """

    __tablename__ = "notification_template_states"

    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(String(50), nullable=False, unique=True, index=True)
    enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    reason = Column(Text, nullable=True)
    changed_by_user_id = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    changed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    changed_by = relationship("User", foreign_keys=[changed_by_user_id])


class SuppressedRecipient(Base):
    """Hard-suppression ledger. organization_id NULL = globally suppressed
    (e.g. a hard bounce is invalid everywhere); non-null = one tenant's
    legal hold on a specific contact. Append-only by design — see module
    docstring.
    """

    __tablename__ = "suppressed_recipients"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reason = Column(CaseInsensitiveEnum(SuppressionReason), nullable=False)
    detail = Column(Text, nullable=True)
    suppressed_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by_user_id = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    lifted_at = Column(DateTime, nullable=True)

    organization = relationship("Organization", foreign_keys=[organization_id])
    created_by = relationship("User", foreign_keys=[created_by_user_id])

    __table_args__ = (
        Index("ix_suppressed_recipients_email_org", "email", "organization_id"),
    )


class MarketingConsent(Base):
    """Opt-in/opt-out ledger gating T3/T4 sends only. Most-recent row per
    (email, organization_id, scope) wins; RECIPIENT_LEVEL overrides
    ORG_LEVEL when both exist. A revocation is a new row, never a delete.
    """

    __tablename__ = "marketing_consents"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    scope = Column(CaseInsensitiveEnum(MarketingConsentScope), nullable=False)
    granted = Column(Boolean, nullable=False)
    granted_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    source = Column(String(100), nullable=True)
    created_by_user_id = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    organization = relationship("Organization", foreign_keys=[organization_id])
    created_by = relationship("User", foreign_keys=[created_by_user_id])

    __table_args__ = (
        Index("ix_marketing_consents_email_org_scope", "email", "organization_id", "scope"),
    )


class CommunicationSend(Base):
    """One-shot idempotency ledger. dedupe_key defaults to
    f"{event_name}:{entity_type}:{entity_id}:{template_id}" unless the
    caller supplies an explicit idempotency_key. Mirrors
    billing.models.StripeEvent's check-then-insert idiom.
    """

    __tablename__ = "communication_sends"

    id = Column(Integer, primary_key=True, index=True)
    dedupe_key = Column(String(300), nullable=False)
    event_name = Column(String(150), nullable=False, index=True)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(Integer, nullable=True)
    template_id = Column(String(50), nullable=False, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    recipient_email = Column(String(255), nullable=False)
    status = Column(
        CaseInsensitiveEnum(CommunicationSendStatus),
        nullable=False,
        default=CommunicationSendStatus.PENDING,
        server_default="PENDING",
    )
    correlation_id = Column(String(100), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), nullable=True)

    organization = relationship("Organization", foreign_keys=[organization_id])

    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_communication_sends_dedupe_key"),
    )


class CommunicationLog(Base):
    """Append-only outcome record of every send attempt. Distinct from
    CommunicationSend: this is a pure audit record (one row per attempt,
    including suppressed/skipped attempts that never reserve a send row),
    not the idempotency check itself.
    """

    __tablename__ = "communication_logs"

    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(String(50), nullable=False, index=True)
    event_name = Column(String(150), nullable=False, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    recipient_email = Column(String(255), nullable=False, index=True)
    status = Column(CaseInsensitiveEnum(CommunicationLogStatus), nullable=False, index=True)
    reason = Column(Text, nullable=True)
    correlation_id = Column(String(100), nullable=True, index=True)
    communication_send_id = Column(
        Integer, ForeignKey("communication_sends.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    organization = relationship("Organization", foreign_keys=[organization_id])
    communication_send = relationship("CommunicationSend", foreign_keys=[communication_send_id])

    __table_args__ = (
        Index("ix_communication_logs_org_created", "organization_id", "created_at"),
    )
