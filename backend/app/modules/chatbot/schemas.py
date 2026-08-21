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

from pydantic import BaseModel, Field


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
