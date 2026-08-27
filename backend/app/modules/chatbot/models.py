"""
chatbot/models.py
-----------------
Enterprise SQLAlchemy models for the Zoiko Billing AI Chatbot.

Records identity, context, conversation state, AI evidence, governed
action previews/confirmations/approvals/executions, knowledge retrieval,
and audit events. The chatbot is a governed orchestration layer — never
a financial system of record. Authoritative financial state remains in
Zoiko Billing domain services.

Tables (28):
  Identity & Context:
    ai_tenant_context, ai_iam_user_ref, ai_permission_snapshot, ai_chatbot_session

  Conversation:
    ai_conversation, ai_conversation_message

  AI/Retrieval Evidence:
    ai_intent_classification, ai_model_run, ai_prompt_template, ai_tool_invocation

  Governed Action Control Plane:
    ai_action_draft, ai_action_preview, ai_action_confirmation,
    ai_approval_request, ai_approval_decision, ai_action_execution,
    ai_financial_resource_pointer, ai_service_response_snapshot

  Knowledge/RAG:
    ai_knowledge_namespace, ai_knowledge_source, ai_knowledge_document,
    ai_knowledge_chunk, ai_retrieval_run, ai_retrieval_citation,
    ai_policy_evaluation

  Audit:
    ai_audit_event, ai_evidence_packet, ai_support_access_session
"""

import enum

from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, Float,
    ForeignKey, JSON, Index, Enum as SAEnum, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


# ═══════════════════════════════════════════════════════════════════════════════
# ENUMS
# ═══════════════════════════════════════════════════════════════════════════════


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


class BillingPlane(str, enum.Enum):
    TENANT_BILLING = "tenant_billing"
    ZOIKO_COMMERCIAL = "zoiko_commercial_billing"


class UserRefStatus(str, enum.Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    DELETED_REF = "deleted_ref"


class SessionChannel(str, enum.Enum):
    WEB = "web"
    MOBILE = "mobile"
    ADMIN = "admin"
    EMBED = "embed"
    API = "api"


class ConversationDomain(str, enum.Enum):
    BILLING = "billing"
    SUPPORT = "support"
    ACCOUNT = "account"
    UNKNOWN = "unknown"


class RetentionClass(str, enum.Enum):
    STANDARD = "standard"
    EXTENDED = "extended"
    LEGAL_HOLD = "legal_hold"


class IntentClassifiedBy(str, enum.Enum):
    RULES = "rules"
    MODEL = "model"
    HYBRID = "hybrid"


class ModelRunType(str, enum.Enum):
    ANSWER = "answer"
    CLASSIFY = "classify"
    PLAN = "plan"
    SUMMARIZE = "summarize"
    REDACT = "redact"
    EVALUATE = "evaluate"


class PromptTemplateStatus(str, enum.Enum):
    DRAFT = "draft"
    APPROVED = "approved"
    DEPRECATED = "deprecated"
    REVOKED = "revoked"


class ToolInvocationStatus(str, enum.Enum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    DENIED = "denied"
    TIMED_OUT = "timed_out"


class DraftStatus(str, enum.Enum):
    PROPOSED = "proposed"
    VALIDATED = "validated"
    REJECTED = "rejected"
    EXPIRED = "expired"


class PreviewStatus(str, enum.Enum):
    VALID = "valid"
    EXPIRED = "expired"
    SUPERSEDED = "superseded"
    REJECTED = "rejected"


class ConfirmationStatus(str, enum.Enum):
    CONFIRMED = "confirmed"
    REVOKED = "revoked"
    EXPIRED = "expired"


class ApprovalRequestStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class ApprovalDecisionType(str, enum.Enum):
    APPROVE = "approve"
    REJECT = "reject"
    REQUEST_CHANGES = "request_changes"


class ExecutionStatus(str, enum.Enum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    COMPENSATED = "compensated"
    UNKNOWN = "unknown"


class SnapshotType(str, enum.Enum):
    QUERY = "query"
    PREVIEW = "preview"
    EXECUTION = "execution"
    ERROR = "error"


class KnowledgeSourceDocType(str, enum.Enum):
    DOC = "doc"
    SOP = "sop"
    FAQ = "faq"
    POLICY = "policy"
    API = "api"
    TENANT_FILE = "tenant_file"


class KnowledgeClassification(str, enum.Enum):
    PUBLIC = "public"
    INTERNAL = "internal"
    CONFIDENTIAL = "confidential"
    RESTRICTED = "restricted"


class FreshnessStatus(str, enum.Enum):
    CURRENT = "current"
    STALE = "stale"
    EXPIRED = "expired"
    UNKNOWN = "unknown"


class AuditEventType(str, enum.Enum):
    SESSION_CREATED = "session_created"
    SESSION_CLOSED = "session_closed"
    MESSAGE_SENT = "message_sent"
    INTENT_CLASSIFIED = "intent_classified"
    EMISSION_GROUNDED = "emission_grounded"
    ACTION_DRAFTED = "action_drafted"
    ACTION_PREVIEWED = "action_previewed"
    ACTION_CONFIRMED = "action_confirmed"
    ACTION_APPROVED = "action_approved"
    ACTION_REJECTED = "action_rejected"
    ACTION_EXECUTED = "action_executed"
    ACTION_CANCELLED = "action_cancelled"
    ACTION_FAILED = "action_failed"
    GUARDRAIL_TRIGGERED = "guardrail_triggered"
    PERMISSION_DENIED = "permission_denied"
    ESCALATION = "escalation"
    RETRIEVAL_RUN = "retrieval_run"
    MODEL_INVOKED = "model_invoked"
    TOOL_INVOKED = "tool_invoked"
    SAFE_MODE_ACTIVATED = "safe_mode_activated"


class EvidencePacketType(str, enum.Enum):
    SUPPORT = "support"
    AUDIT = "audit"
    DISPUTE = "dispute"
    QA = "qa"
    SECURITY = "security"


class AccessReasonCode(str, enum.Enum):
    CUSTOMER_SUPPORT = "customer_support"
    AUDIT = "audit"
    QA_REVIEW = "qa_review"
    SECURITY_INVESTIGATION = "security_investigation"


# ═══════════════════════════════════════════════════════════════════════════════
# IDENTITY & CONTEXT
# ═══════════════════════════════════════════════════════════════════════════════


class TenantContext(Base):
    """Resolved tenant/legal-entity context for every AI interaction."""
    __tablename__ = "ai_tenant_context"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    legal_entity_id = Column(Integer, nullable=True)
    billing_plane = Column(SAEnum(BillingPlane, native_enum=False), nullable=False, default=BillingPlane.TENANT_BILLING)
    locale = Column(String(10), nullable=True)
    timezone = Column(String(50), nullable=True)
    data_residency_region = Column(String(10), nullable=True)
    context_hash = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_ai_tenant_context_tenant", "tenant_id", "billing_plane"),
    )


class IAMUserRef(Base):
    """Reference to an authenticated user within a tenant context."""
    __tablename__ = "ai_iam_user_ref"

    id = Column(Integer, primary_key=True, index=True)
    user_ref_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    idp_subject_hash = Column(String(64), nullable=True)
    role_summary = Column(String(100), nullable=True)
    status = Column(SAEnum(UserRefStatus, native_enum=False), default=UserRefStatus.ACTIVE, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_ref_id", "tenant_context_id", name="uq_ai_iam_user_tenant"),
    )


class PermissionSnapshot(Base):
    """Point-in-time permission scopes for a user in a tenant context."""
    __tablename__ = "ai_permission_snapshot"

    id = Column(Integer, primary_key=True, index=True)
    user_ref_id = Column(Integer, ForeignKey("ai_iam_user_ref.id", ondelete="RESTRICT"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    scopes_json = Column(JSON, nullable=False)
    source_policy_version = Column(String(50), nullable=True)
    snapshot_hash = Column(String(64), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AIChatbotSession(Base):
    """Top-level session record linking user, tenant, and channel."""
    __tablename__ = "ai_chatbot_session"

    id = Column(Integer, primary_key=True, index=True)
    session_uid = Column(String(36), unique=True, nullable=False, index=True)
    user_ref_id = Column(Integer, ForeignKey("ai_iam_user_ref.id", ondelete="RESTRICT"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    channel = Column(SAEnum(SessionChannel, native_enum=False), default=SessionChannel.WEB, nullable=False)
    risk_score = Column(Float, default=0.0)
    status = Column(String(20), default="active", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ═══════════════════════════════════════════════════════════════════════════════
# CONVERSATION
# ═══════════════════════════════════════════════════════════════════════════════


class AIConversation(Base):
    """Business conversation thread scoped to a tenant context."""
    __tablename__ = "ai_conversation"

    id = Column(Integer, primary_key=True, index=True)
    conversation_uid = Column(String(36), unique=True, nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("ai_chatbot_session.id", ondelete="CASCADE"), nullable=True, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    title = Column(String(255), nullable=True)
    conversation_status = Column(SAEnum(ConversationStatus, native_enum=False), default=ConversationStatus.OPEN, nullable=False)
    primary_domain = Column(SAEnum(ConversationDomain, native_enum=False), default=ConversationDomain.UNKNOWN)
    highest_risk_class = Column(SAEnum(RiskClass, native_enum=False), default=RiskClass.R0)
    retention_class = Column(SAEnum(RetentionClass, native_enum=False), default=RetentionClass.STANDARD)
    message_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    messages = relationship("AIConversationMessage", back_populates="conversation", lazy="dynamic", order_by="AIConversationMessage.created_at")
    action_drafts = relationship("AIActionDraft", back_populates="conversation", lazy="dynamic")
    audit_events = relationship("AIAuditEvent", back_populates="conversation", lazy="dynamic")

    __table_args__ = (
        Index("ix_ai_conversation_org_user", "organization_id", "user_id"),
        Index("ix_ai_conversation_tenant_status", "tenant_context_id", "conversation_status"),
    )


class AIConversationMessage(Base):
    """Individual message within a conversation."""
    __tablename__ = "ai_conversation_message"

    id = Column(Integer, primary_key=True, index=True)
    message_uid = Column(String(36), unique=True, nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("ai_conversation.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_type = Column(SAEnum(SenderType, native_enum=False), nullable=False)
    message_text = Column(Text, nullable=False)
    mode = Column(String(20), nullable=True)
    risk_class = Column(SAEnum(RiskClass, native_enum=False), default=RiskClass.R0)
    contains_financial_data = Column(Boolean, default=False)
    contains_pii = Column(Boolean, default=False)
    structured_payload = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("AIConversation", back_populates="messages")

    __table_args__ = (
        Index("ix_ai_message_conversation_created", "conversation_id", "created_at"),
    )


# ═══════════════════════════════════════════════════════════════════════════════
# AI / RETRIEVAL EVIDENCE
# ═══════════════════════════════════════════════════════════════════════════════


class IntentClassification(Base):
    """Classified intent for a conversation message."""
    __tablename__ = "ai_intent_classification"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("ai_conversation_message.id", ondelete="CASCADE"), nullable=False, index=True)
    intent_code = Column(String(100), nullable=False)
    intent_domain = Column(String(50), nullable=False)
    confidence = Column(Float, nullable=True)
    risk_class = Column(SAEnum(RiskClass, native_enum=False), nullable=False)
    classified_by = Column(SAEnum(IntentClassifiedBy, native_enum=False), default=IntentClassifiedBy.RULES)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ModelRun(Base):
    """Record of each model invocation."""
    __tablename__ = "ai_model_run"

    id = Column(Integer, primary_key=True, index=True)
    model_run_uid = Column(String(36), unique=True, nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("ai_conversation.id", ondelete="SET NULL"), nullable=True, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    run_type = Column(SAEnum(ModelRunType, native_enum=False), nullable=False)
    provider = Column(String(50), nullable=True)
    model_name = Column(String(100), nullable=True)
    prompt_template_id = Column(Integer, ForeignKey("ai_prompt_template.id", ondelete="SET NULL"), nullable=True)
    input_hash = Column(String(64), nullable=True)
    output_hash = Column(String(64), nullable=True)
    latency_ms = Column(Integer, nullable=True)
    token_input = Column(Integer, nullable=True)
    token_output = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PromptTemplate(Base):
    """Versioned prompt templates for reproducibility."""
    __tablename__ = "ai_prompt_template"

    id = Column(Integer, primary_key=True, index=True)
    template_code = Column(String(100), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    content = Column(Text, nullable=False)
    risk_scope = Column(String(20), nullable=True)
    template_hash = Column(String(64), nullable=True)
    status = Column(SAEnum(PromptTemplateStatus, native_enum=False), default=PromptTemplateStatus.DRAFT, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("template_code", "version", name="uq_ai_prompt_template_code_version"),
    )


class ToolInvocation(Base):
    """Record of each tool call made during a model run."""
    __tablename__ = "ai_tool_invocation"

    id = Column(Integer, primary_key=True, index=True)
    tool_invocation_uid = Column(String(36), unique=True, nullable=False, index=True)
    model_run_id = Column(Integer, ForeignKey("ai_model_run.id", ondelete="SET NULL"), nullable=True, index=True)
    conversation_id = Column(Integer, ForeignKey("ai_conversation.id", ondelete="SET NULL"), nullable=True, index=True)
    tool_name = Column(String(100), nullable=False)
    tool_args_hash = Column(String(64), nullable=True)
    status = Column(SAEnum(ToolInvocationStatus, native_enum=False), default=ToolInvocationStatus.PENDING, nullable=False)
    result_summary = Column(Text, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ═══════════════════════════════════════════════════════════════════════════════
# GOVERNED ACTION CONTROL PLANE
# ═══════════════════════════════════════════════════════════════════════════════


class AIActionDraft(Base):
    """Proposed structured intent (draft) — no mutation possible."""
    __tablename__ = "ai_action_draft"

    id = Column(Integer, primary_key=True, index=True)
    action_uid = Column(String(36), unique=True, nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("ai_conversation.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    created_by_message_id = Column(Integer, ForeignKey("ai_conversation_message.id", ondelete="SET NULL"), nullable=True)
    action_type = Column(String(100), nullable=False)
    risk_class = Column(SAEnum(RiskClass, native_enum=False), nullable=False)
    proposed_params = Column(JSON, nullable=True)
    draft_status = Column(SAEnum(DraftStatus, native_enum=False), default=DraftStatus.PROPOSED, nullable=False)
    validation_errors = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)

    conversation = relationship("AIConversation", back_populates="action_drafts")
    preview = relationship("AIActionPreview", back_populates="action_draft", uselist=False)

    __table_args__ = (
        Index("ix_ai_action_draft_org_status", "organization_id", "draft_status"),
    )


class AIActionPreview(Base):
    """Deterministic preview from authoritative billing service — no commit."""
    __tablename__ = "ai_action_preview"

    id = Column(Integer, primary_key=True, index=True)
    preview_uid = Column(String(36), unique=True, nullable=False, index=True)
    action_draft_id = Column(Integer, ForeignKey("ai_action_draft.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    preview_status = Column(SAEnum(PreviewStatus, native_enum=False), default=PreviewStatus.VALID, nullable=False)
    authoritative_service = Column(String(100), nullable=True)
    preview_payload = Column(JSON, nullable=True)
    resource_version_vector = Column(JSON, nullable=True)
    money_summary = Column(JSON, nullable=True)
    preview_hash = Column(String(64), nullable=False)
    warnings = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)

    action_draft = relationship("AIActionDraft", back_populates="preview")
    confirmation = relationship("AIActionConfirmation", back_populates="action_preview", uselist=False)
    execution = relationship("AIActionExecution", back_populates="action_preview", uselist=False)

    __table_args__ = (
        Index("ix_ai_action_preview_draft_status", "action_draft_id", "preview_status"),
    )


class AIActionConfirmation(Base):
    """Explicit user confirmation bound to a preview hash."""
    __tablename__ = "ai_action_confirmation"

    id = Column(Integer, primary_key=True, index=True)
    confirmation_uid = Column(String(36), unique=True, nullable=False, index=True)
    action_preview_id = Column(Integer, ForeignKey("ai_action_preview.id", ondelete="CASCADE"), nullable=False, index=True)
    confirmed_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    confirmation_phrase_hash = Column(String(64), nullable=True)
    status = Column(SAEnum(ConfirmationStatus, native_enum=False), default=ConfirmationStatus.CONFIRMED, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    action_preview = relationship("AIActionPreview", back_populates="confirmation")


class AIApprovalRequest(Base):
    """Maker-checker approval request for high-consequence actions."""
    __tablename__ = "ai_approval_request"

    id = Column(Integer, primary_key=True, index=True)
    approval_uid = Column(String(36), unique=True, nullable=False, index=True)
    action_draft_id = Column(Integer, ForeignKey("ai_action_draft.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    requested_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    approval_policy_code = Column(String(100), nullable=True)
    required_approver_role = Column(String(50), nullable=True)
    request_status = Column(SAEnum(ApprovalRequestStatus, native_enum=False), default=ApprovalRequestStatus.PENDING, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)

    decisions = relationship("AIApprovalDecision", back_populates="approval_request", lazy="dynamic")


class AIApprovalDecision(Base):
    """Individual approval/rejection decision."""
    __tablename__ = "ai_approval_decision"

    id = Column(Integer, primary_key=True, index=True)
    decision_uid = Column(String(36), unique=True, nullable=False, index=True)
    approval_request_id = Column(Integer, ForeignKey("ai_approval_request.id", ondelete="CASCADE"), nullable=False, index=True)
    decided_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    decision = Column(SAEnum(ApprovalDecisionType, native_enum=False), nullable=False)
    comment = Column(Text, nullable=True)
    permission_snapshot_id = Column(Integer, ForeignKey("ai_permission_snapshot.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    approval_request = relationship("AIApprovalRequest", back_populates="decisions")


class AIActionExecution(Base):
    """Record of a confirmed and executed action via canonical service."""
    __tablename__ = "ai_action_execution"

    id = Column(Integer, primary_key=True, index=True)
    execution_uid = Column(String(36), unique=True, nullable=False, index=True)
    action_preview_id = Column(Integer, ForeignKey("ai_action_preview.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    idempotency_key = Column(String(64), nullable=False, index=True)
    execution_status = Column(SAEnum(ExecutionStatus, native_enum=False), default=ExecutionStatus.PENDING, nullable=False)
    authoritative_service = Column(String(100), nullable=True)
    service_operation_id = Column(String(100), nullable=True)
    result_payload = Column(JSON, nullable=True)
    error_detail = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    action_preview = relationship("AIActionPreview", back_populates="execution")

    __table_args__ = (
        UniqueConstraint("action_preview_id", "idempotency_key", name="uq_ai_action_execution_idempotency"),
    )


class FinancialResourcePointer(Base):
    """References into authoritative billing tables — never copies data."""
    __tablename__ = "ai_financial_resource_pointer"

    id = Column(Integer, primary_key=True, index=True)
    execution_id = Column(Integer, ForeignKey("ai_action_execution.id", ondelete="CASCADE"), nullable=False, index=True)
    resource_type = Column(String(50), nullable=False)
    resource_ref_id = Column(Integer, nullable=False)
    service_name = Column(String(100), nullable=True)
    resource_version = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ServiceResponseSnapshot(Base):
    """Redacted snapshots of service responses for audit/evidence."""
    __tablename__ = "ai_service_response_snapshot"

    id = Column(Integer, primary_key=True, index=True)
    snapshot_uid = Column(String(36), unique=True, nullable=False, index=True)
    action_draft_id = Column(Integer, ForeignKey("ai_action_draft.id", ondelete="SET NULL"), nullable=True, index=True)
    execution_id = Column(Integer, ForeignKey("ai_action_execution.id", ondelete="SET NULL"), nullable=True, index=True)
    snapshot_type = Column(SAEnum(SnapshotType, native_enum=False), nullable=False)
    payload_hash = Column(String(64), nullable=True)
    payload_redacted = Column(JSON, nullable=True)
    classification = Column(String(20), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ═══════════════════════════════════════════════════════════════════════════════
# KNOWLEDGE / RAG
# ═══════════════════════════════════════════════════════════════════════════════


class KnowledgeNamespace(Base):
    """Scoped knowledge namespaces for retrieval isolation."""
    __tablename__ = "ai_knowledge_namespace"

    id = Column(Integer, primary_key=True, index=True)
    namespace_code = Column(String(100), unique=True, nullable=False, index=True)
    tenant_id = Column(Integer, nullable=True)
    allowed_domains = Column(JSON, nullable=True)
    blocked_domains = Column(JSON, nullable=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class KnowledgeSource(Base):
    """Registry of knowledge sources within a namespace."""
    __tablename__ = "ai_knowledge_source"

    id = Column(Integer, primary_key=True, index=True)
    namespace_id = Column(Integer, ForeignKey("ai_knowledge_namespace.id", ondelete="RESTRICT"), nullable=False, index=True)
    source_type = Column(SAEnum(KnowledgeSourceDocType, native_enum=False), nullable=False)
    classification = Column(SAEnum(KnowledgeClassification, native_enum=False), default=KnowledgeClassification.INTERNAL)
    owner_team = Column(String(100), nullable=True)
    title = Column(String(255), nullable=True)
    source_url = Column(String(500), nullable=True)
    status = Column(String(20), default="active", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class KnowledgeDocument(Base):
    """Versioned documents within a source."""
    __tablename__ = "ai_knowledge_document"

    id = Column(Integer, primary_key=True, index=True)
    source_id = Column(Integer, ForeignKey("ai_knowledge_source.id", ondelete="RESTRICT"), nullable=False, index=True)
    document_version = Column(Integer, nullable=False, default=1)
    document_hash = Column(String(64), nullable=True)
    freshness_status = Column(SAEnum(FreshnessStatus, native_enum=False), default=FreshnessStatus.CURRENT)
    object_uri = Column(String(500), nullable=True)
    title = Column(String(255), nullable=True)
    status = Column(String(20), default="approved", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    approved_at = Column(DateTime(timezone=True), nullable=True)
    superseded_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_ai_knowledge_doc_source_status", "source_id", "status"),
    )


class KnowledgeChunk(Base):
    """Individual text chunks with embeddings for retrieval."""
    __tablename__ = "ai_knowledge_chunk"

    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("ai_knowledge_document.id", ondelete="RESTRICT"), nullable=False, index=True)
    chunk_sequence = Column(Integer, nullable=False)
    chunk_text = Column(Text, nullable=False)
    embedding_ref = Column(String(200), nullable=True)
    page_start = Column(Integer, nullable=True)
    page_end = Column(Integer, nullable=True)
    classification = Column(SAEnum(KnowledgeClassification, native_enum=False), default=KnowledgeClassification.INTERNAL)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_ai_knowledge_chunk_doc_seq", "document_id", "chunk_sequence"),
    )


class RetrievalRun(Base):
    """Record of each retrieval operation."""
    __tablename__ = "ai_retrieval_run"

    id = Column(Integer, primary_key=True, index=True)
    retrieval_run_uid = Column(String(36), unique=True, nullable=False, index=True)
    knowledge_namespace_id = Column(Integer, ForeignKey("ai_knowledge_namespace.id", ondelete="RESTRICT"), nullable=False, index=True)
    message_id = Column(Integer, ForeignKey("ai_conversation_message.id", ondelete="SET NULL"), nullable=True, index=True)
    query_hash = Column(String(64), nullable=True)
    filters = Column(JSON, nullable=True)
    top_k = Column(Integer, default=10)
    freshness_policy = Column(String(20), nullable=True)
    result_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class RetrievalCitation(Base):
    """Citation linking a retrieval result to a source chunk."""
    __tablename__ = "ai_retrieval_citation"

    id = Column(Integer, primary_key=True, index=True)
    retrieval_run_id = Column(Integer, ForeignKey("ai_retrieval_run.id", ondelete="CASCADE"), nullable=False, index=True)
    knowledge_chunk_id = Column(Integer, ForeignKey("ai_knowledge_chunk.id", ondelete="RESTRICT"), nullable=False, index=True)
    rank = Column(Integer, nullable=False)
    score = Column(Float, nullable=True)
    used_in_message_id = Column(Integer, ForeignKey("ai_conversation_message.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PolicyEvaluation(Base):
    """Risk/policy evaluation result for an action."""
    __tablename__ = "ai_policy_evaluation"

    id = Column(Integer, primary_key=True, index=True)
    evaluation_uid = Column(String(36), unique=True, nullable=False, index=True)
    action_draft_id = Column(Integer, ForeignKey("ai_action_draft.id", ondelete="CASCADE"), nullable=True, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    policy_code = Column(String(100), nullable=True)
    risk_class = Column(SAEnum(RiskClass, native_enum=False), nullable=False)
    result = Column(String(50), nullable=False)
    thresholds_applied = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ═══════════════════════════════════════════════════════════════════════════════
# AUDIT
# ═══════════════════════════════════════════════════════════════════════════════


class AIAuditEvent(Base):
    """Immutable audit event for every material action."""
    __tablename__ = "ai_audit_event"

    id = Column(Integer, primary_key=True, index=True)
    event_uid = Column(String(36), unique=True, nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("ai_conversation.id", ondelete="SET NULL"), nullable=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=True, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    event_type = Column(SAEnum(AuditEventType, native_enum=False), nullable=False)
    event_subject_type = Column(String(50), nullable=True)
    event_subject_id = Column(String(50), nullable=True)
    event_payload = Column(JSON, nullable=True)
    event_payload_hash = Column(String(64), nullable=True)
    correlation_id = Column(String(36), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("AIConversation", back_populates="audit_events")

    __table_args__ = (
        Index("ix_ai_audit_org_created", "organization_id", "created_at"),
        Index("ix_ai_audit_tenant_type", "tenant_context_id", "event_type"),
    )


class EvidencePacket(Base):
    """Bundled evidence for support, audit, dispute, or QA purposes."""
    __tablename__ = "ai_evidence_packet"

    id = Column(Integer, primary_key=True, index=True)
    packet_uid = Column(String(36), unique=True, nullable=False, index=True)
    packet_type = Column(SAEnum(EvidencePacketType, native_enum=False), nullable=False)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=True)
    conversation_id = Column(Integer, ForeignKey("ai_conversation.id", ondelete="SET NULL"), nullable=True)
    object_uri = Column(String(500), nullable=True)
    content_hash = Column(String(64), nullable=True)
    retention_class = Column(SAEnum(RetentionClass, native_enum=False), default=RetentionClass.STANDARD)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SupportAccessSession(Base):
    """Scoped support access for cross-tenant investigation."""
    __tablename__ = "ai_support_access_session"

    id = Column(Integer, primary_key=True, index=True)
    support_user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    tenant_context_id = Column(Integer, ForeignKey("ai_tenant_context.id", ondelete="RESTRICT"), nullable=False, index=True)
    access_reason_code = Column(SAEnum(AccessReasonCode, native_enum=False), nullable=False)
    scope = Column(JSON, nullable=True)
    status = Column(String(20), default="active", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
