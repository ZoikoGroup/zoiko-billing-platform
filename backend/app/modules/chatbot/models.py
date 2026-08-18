"""
chatbot/models.py
-----------------
Enterprise SQLAlchemy models for the Zoiko Billing AI Chatbot.

Records conversation state, grounded evidence, action previews,
confirmations, and audit events. The chatbot is a governed orchestration
layer — never a financial system of record. Authoritative financial state
remains in Zoiko Billing domain services.

Tables (4):
  conversations          - Business conversation threads
  conversation_messages   - Messages with risk/redaction flags
  action_drafts          - Proposed structured intents (Phase B)
  chatbot_audit_events   - Append-only evidence trail
"""

import enum

from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime,
    ForeignKey, JSON, Index, Enum as SAEnum,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


# ── Enums ────────────────────────────────────────────────────────────────────

class ConversationStatus(str, enum.Enum):
    OPEN = "open"
    RESOLVED = "resolved"
    ARCHIVED = "archived"
    LOCKED = "locked"


class SenderType(str, enum.Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class RiskClass(str, enum.Enum):
    R0 = "R0"  # Informational — no tenant data
    R1 = "R1"  # Tenant read — record lookup/explanation
    R2 = "R2"  # Draft/preparation — no side effects
    R3 = "R3"  # Governed mutation — requires confirmation
    R4 = "R4"  # High consequence — requires approval
    RX = "RX"  # Prohibited — block / safe refusal


class AuthorityMode(str, enum.Enum):
    EXPLAIN = "explain"
    INSPECT = "inspect"
    PREPARE = "prepare"
    PREVIEW = "preview"
    EXECUTE = "execute"


class ActionDraftStatus(str, enum.Enum):
    PROPOSED = "proposed"
    VALIDATED = "validated"
    REJECTED = "rejected"
    EXPIRED = "expired"


class AuditEventType(str, enum.Enum):
    SESSION_CREATED = "session_created"
    SESSION_CLOSED = "session_closed"
    MESSAGE_SENT = "message_sent"
    INTENT_CLASSIFIED = "intent_classified"
    EMISSION_GROUNDED = "emission_grounded"
    ACTION_DRAFTED = "action_drafted"
    ACTION_PREVIEWED = "action_previewed"
    ACTION_CONFIRMED = "action_confirmed"
    ACTION_EXECUTED = "action_executed"
    GUARDRAIL_TRIGGERED = "guardrail_triggered"
    PERMISSION_DENIED = "permission_denied"
    ESCALATION = "escalation"


# ── Models ───────────────────────────────────────────────────────────────────

class Conversation(Base):
    __tablename__ = "chatbot_conversations"

    id = Column(Integer, primary_key=True, index=True)
    conversation_uid = Column(String(36), unique=True, nullable=False, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    title = Column(String(255), nullable=True)
    status = Column(SAEnum(ConversationStatus, native_enum=False), default=ConversationStatus.OPEN, nullable=False)
    primary_domain = Column(String(50), nullable=True)
    highest_risk_class = Column(SAEnum(RiskClass, native_enum=False), default=RiskClass.R0)
    message_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    messages = relationship("ConversationMessage", back_populates="conversation", lazy="dynamic", order_by="ConversationMessage.created_at")
    action_drafts = relationship("ActionDraft", back_populates="conversation", lazy="dynamic")
    audit_events = relationship("ChatbotAuditEvent", back_populates="conversation", lazy="dynamic")

    __table_args__ = (
        Index("ix_chatbot_conversations_org_user", "organization_id", "user_id"),
    )


class ConversationMessage(Base):
    __tablename__ = "chatbot_conversation_messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("chatbot_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    message_uid = Column(String(36), unique=True, nullable=False, index=True)
    sender_type = Column(SAEnum(SenderType, native_enum=False), nullable=False)
    message_text = Column(Text, nullable=False)
    mode = Column(String(20), nullable=True)
    risk_class = Column(SAEnum(RiskClass, native_enum=False), default=RiskClass.R0)
    contains_financial_data = Column(Boolean, default=False)
    structured_payload = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("Conversation", back_populates="messages")

    __table_args__ = (
        Index("ix_chatbot_messages_conversation_created", "conversation_id", "created_at"),
    )


class ActionDraft(Base):
    __tablename__ = "chatbot_action_drafts"

    id = Column(Integer, primary_key=True, index=True)
    action_uid = Column(String(36), unique=True, nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("chatbot_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by_message_id = Column(Integer, ForeignKey("chatbot_conversation_messages.id", ondelete="SET NULL"), nullable=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    action_type = Column(String(100), nullable=False)
    risk_class = Column(SAEnum(RiskClass, native_enum=False), nullable=False)
    proposed_params = Column(JSON, nullable=True)
    status = Column(SAEnum(ActionDraftStatus, native_enum=False), default=ActionDraftStatus.PROPOSED, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)

    conversation = relationship("Conversation", back_populates="action_drafts")


class ChatbotAuditEvent(Base):
    __tablename__ = "chatbot_audit_events"

    id = Column(Integer, primary_key=True, index=True)
    event_uid = Column(String(36), unique=True, nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("chatbot_conversations.id", ondelete="SET NULL"), nullable=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    event_type = Column(SAEnum(AuditEventType, native_enum=False), nullable=False)
    event_payload = Column(JSON, nullable=True)
    correlation_id = Column(String(36), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("Conversation", back_populates="audit_events")

    __table_args__ = (
        Index("ix_chatbot_audit_org_created", "organization_id", "created_at"),
    )
