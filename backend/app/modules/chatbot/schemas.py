"""
chatbot/schemas.py
------------------
Pydantic schemas for the Zoiko Billing AI Assistant API layer.

Covers conversation lifecycle, message exchange, capability resolution,
evidence contracts, action control, and structured output validation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


# ── Request Schemas ──────────────────────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    title: str | None = Field(None, max_length=255)
    initial_message: str | None = Field(None, min_length=1, max_length=2000)


class SendMessageRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    # Current app route (e.g. "/billing/customers/dashboard") so the engine
    # can bias disambiguation toward the surface the user is already on.
    page: str | None = Field(None, max_length=300)


class CloseSessionRequest(BaseModel):
    resolution_note: str | None = Field(None, max_length=1000)


# ── Action Lifecycle Schemas ────────────────────────────────────────────────

class CreateDraftRequest(BaseModel):
    action_type: str = Field(..., description="Action type, e.g. 'invoice_draft'")
    proposed_params: dict[str, Any] = Field(..., description="Proposed action parameters")


class PreviewRequest(BaseModel):
    pass  # No body needed — preview is generated from draft


class ConfirmRequest(BaseModel):
    preview_uid: str = Field(..., description="Preview UID to confirm")
    preview_hash: str = Field(..., description="Preview hash for binding")


class ApprovalRequestBody(BaseModel):
    action_uid: str


class ApprovalDecisionRequest(BaseModel):
    decision: Literal["approve", "reject", "request_changes"]
    comment: str | None = None


class ExecuteRequest(BaseModel):
    idempotency_key: str = Field(..., description="Idempotency key for replay protection")


# ── Evidence & Context ──────────────────────────────────────────────────────

class ChatbotEvidence(BaseModel):
    source: str
    resource_type: str
    resource_id: int | None = None
    reference: str | None = None
    summary: str = ""
    fields: dict[str, Any] = Field(default_factory=dict)
    # Optional web URL a visitor can open for the source. Populated only when
    # the knowledge source/document carries a verifiable URL; consumers must
    # allowlist it before rendering as a link.
    url: str | None = None
    version: str | None = None


class ChatbotContext(BaseModel):
    request_id: str | None = None
    user_id: int
    organization_id: int | None = None
    tenant_name: str | None = None
    role: str
    billing_plane: str = "tenant_billing"
    permissions: list[str]


class Capability(BaseModel):
    id: str
    label: str
    description: str
    enabled: bool
    risk_class: str | None = None


# ── Response Schemas ─────────────────────────────────────────────────────────

class SessionSummary(BaseModel):
    conversation_uid: str
    title: str | None = None
    status: str
    domain: str | None = None
    highest_risk: str = "R0"
    message_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class MessageResponse(BaseModel):
    message_uid: str
    sender_type: str
    message_text: str
    mode: str | None = None
    risk_class: str = "R0"
    structured_payload: dict[str, Any] | None = None
    created_at: datetime | None = None


class SessionDetail(BaseModel):
    conversation_uid: str
    title: str | None = None
    status: str
    domain: str | None = None
    highest_risk: str = "R0"
    messages: list[MessageResponse] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChatbotResponse(BaseModel):
    message_uid: str
    answer: str
    mode: str = "M0_EXPLAIN"
    risk_class: str = "R0"
    evidence: list[ChatbotEvidence] = Field(default_factory=list)
    qualification: str | None = None
    next_actions: list[str] = Field(default_factory=list)
    suggested_prompts: list[str] = Field(default_factory=list)


class DraftResponse(BaseModel):
    action_uid: str
    action_type: str
    status: str
    proposed_params: dict[str, Any]
    expires_at: str | None = None


class PreviewResponse(BaseModel):
    preview_uid: str
    preview_hash: str
    preview_payload: dict[str, Any]
    money_summary: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    expires_at: str | None = None
    policy_result: dict[str, Any]
    requires_confirmation: bool = False
    requires_approval: bool = False


class ConfirmationResponse(BaseModel):
    confirmation_uid: str
    status: str
    preview_uid: str
    preview_hash: str


class ExecutionResponse(BaseModel):
    execution_uid: str
    status: str
    result: dict[str, Any] | None = None
    idempotent_replay: bool = False


class CapabilitiesResponse(BaseModel):
    effective_mode: str
    risk_classes_allowed: list[str]
    capabilities: list[Capability]


class MetricsResponse(BaseModel):
    total_requests: int = 0
    total_model_calls: int = 0
    abstention_rate: float = 0.0
    action_conversion_rate: float = 0.0
    approval_rejection_rate: float = 0.0
    citation_coverage: float = 0.0
    avg_model_latency_ms: float = 0.0


class HealthResponse(BaseModel):
    status: str = "ok"
    module: str = "chatbot"
    version: str = "3.0.0"
    safe_mode: bool = False
    model_gateway: str = "unknown"


# ── Public Assistant Schemas (zoikobilling.com marketing-site widget) ────────
# Auth-free. Mirrors the session-based platform paradigm, but lightweight and
# anonymous — no tenant, user, or financial references anywhere.

class PublicCreateSessionRequest(BaseModel):
    # Optional client-generated UUID so the widget can survive a page reload
    # (the same uid can be re-posted; the server treats it as idempotent).
    # Bounded to the 36-char DB column so an oversized value is a 422, never a
    # DB truncation/error.
    session_uid: str | None = Field(None, min_length=8, max_length=36)
    # Optional current marketing page slug (e.g. "/pricing") for page-context
    # boosting of retrieval.
    page: str | None = Field(None, max_length=300)


class PublicSendMessageRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    page: str | None = Field(None, max_length=300)
    # Client-generated idempotency key for this logical turn. A retried send
    # with the same key returns the original exchange instead of duplicating it.
    message_id: str | None = Field(None, min_length=8, max_length=64)
    # Optional stable intent id from a topic tile (e.g. "invoices").
    intent_id: str | None = Field(None, max_length=64)


class PublicMessage(BaseModel):
    message_uid: str
    sender_type: str
    message_text: str
    mode: str | None = None
    risk_class: str = "R0"
    created_at: datetime | None = None


class PublicSessionResponse(BaseModel):
    session_uid: str
    status: str
    messages: list[PublicMessage] = Field(default_factory=list)
    created_at: datetime | None = None


class PublicSessionSummary(BaseModel):
    """Lite row for the widget's Recent-conversations history dropdown."""
    session_uid: str
    title: str = "New Conversation"
    status: str
    message_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PublicChatResponse(BaseModel):
    session_uid: str
    message_uid: str
    answer: str
    mode: str = "M0_EXPLAIN"
    risk_class: str = "R0"
    evidence: list[ChatbotEvidence] = Field(default_factory=list)
    suggested_prompts: list[str] = Field(default_factory=list)
    # True when the question needs account-specific data the public assistant
    # can never access; the widget then shows the sign-in call to action.
    requires_auth: bool = False
    # Coarse, non-sensitive state for the widget: "answered" | "uncertain" |
    # "refused" | "degraded". Never carries model confidence or internals.
    safety_state: str = "answered"
    # Server-side timestamp of the assistant turn (spec §10.1) so the widget can
    # show the message time from a trusted clock instead of the browser's.
    created_at: datetime | None = None
    # Echo of the topic-tile intent id that produced this turn (spec §10.1),
    # so the widget can attribute the answer to the originating tile.
    intent_id: str | None = None


# ── Public assistant instrumentation (spec §12.3) ───────────────────────────

class PublicEventRequest(BaseModel):
    """Privacy-minimized client instrumentation event.

    Only an allowlisted event name plus the spec §12.3 safe metadata
    (anonymous session id, topic id, locale, config version, timing bucket)
    are accepted. Raw question text and any free-text field are never part of
    this contract.
    """

    event: str = Field(..., min_length=1, max_length=64)
    session_uid: str | None = Field(None, max_length=64)
    topic_id: str | None = Field(None, max_length=64)
    locale: str | None = Field(None, max_length=16)
    config_version: str | None = Field(None, max_length=40)
    timing_bucket: str | None = Field(None, max_length=16)


class PublicEventResponse(BaseModel):
    status: str = "recorded"


# ── Public assistant config / support / feedback (ZB-AI-PUB-001) ────────────

class PublicTopicTile(BaseModel):
    id: str
    label: str
    description: str = ""
    icon: str = "help-circle"
    accent: str = "#0868F7"
    tint: str = "#EEF4FA"
    starter_question: str


class PublicSupportConfig(BaseModel):
    mode: str
    live_chat_enabled: bool = False
    request_form_enabled: bool = True
    issue_types: list[str] = Field(default_factory=list)
    response_time_claim: str | None = None


class PublicLinkAllowlist(BaseModel):
    relative_prefixes: list[str] = Field(default_factory=list)
    external_domains: list[str] = Field(default_factory=list)


class PublicConfigResponse(BaseModel):
    config_version: str
    assistant_title: str
    greeting_title: str
    greeting_body: str
    composer_placeholder: str
    disclosure: str
    human_support_label: str = "Speak to a human"
    human_support_description: str = "Get help from our support team"
    uncertainty_message: str
    privacy_url: str
    privacy_label: str
    help_center_url: str
    contact_support_url: str
    sign_in_url: str
    sign_in_label: str
    tiles: list[PublicTopicTile]
    support: PublicSupportConfig
    link_allowlist: PublicLinkAllowlist


class PublicHealthResponse(BaseModel):
    # Deliberately minimal: availability + degraded mode only. Never the
    # provider, model, version or any internal detail.
    status: str = "ok"
    available: bool = True
    degraded: bool = False


class PublicSupportRequestCreate(BaseModel):
    issue_type: str = Field(..., min_length=1, max_length=40)
    email: EmailStr
    summary: str = Field(..., min_length=3, max_length=500)
    message: str | None = Field(None, max_length=4000)
    # Consent is required before any transcript excerpt is shared.
    transcript_consent: bool = False
    session_uid: str | None = Field(None, min_length=8, max_length=36)
    # Client-minted idempotency key (e.g. a UUID) generated once per support
    # form. Retries after a lost response reuse it; the server returns the
    # original reference instead of creating a duplicate request.
    client_request_id: str | None = Field(None, min_length=8, max_length=64)


class PublicSupportRequestResponse(BaseModel):
    reference: str
    status: str = "received"
    message: str
    transcript_shared: bool = False
    # A downstream support-desk delivery is only reported true when the
    # configured webhook actually acknowledged the request.
    delivered_to_desk: bool = False


class PublicFeedbackRequest(BaseModel):
    session_uid: str | None = Field(None, max_length=36)
    message_uid: str | None = Field(None, max_length=36)
    helpful: bool
    reason: str | None = Field(None, max_length=500)


class PublicFeedbackResponse(BaseModel):
    status: str = "recorded"
