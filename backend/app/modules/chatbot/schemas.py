"""
chatbot/schemas.py
------------------
Pydantic schemas for the Zoiko Billing AI Chatbot API layer.

Covers conversation lifecycle, message exchange, capability resolution,
evidence contracts, action control (Phase B), and structured output
validation per ZB-AI-API-001 and ZB-AI-UX-001.
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


class CloseSessionRequest(BaseModel):
    resolution_note: str | None = Field(None, max_length=1000)


# ── Evidence & Context ──────────────────────────────────────────────────────

class ChatbotEvidence(BaseModel):
    source: str
    resource_type: str
    resource_id: int | None = None
    reference: str | None = None
    summary: str
    fields: dict[str, Any] = Field(default_factory=dict)
    url: str | None = None


class ChatbotContext(BaseModel):
    request_id: str | None = None
    user_id: int
    organization_id: int | None = None
    tenant_name: str | None = None
    role: str
    billing_plane: Literal["TENANT", "ZOIKO_COMMERCIAL"] = "TENANT"
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
    primary_domain: str | None = None
    highest_risk_class: str = "R0"
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
    primary_domain: str | None = None
    highest_risk_class: str = "R0"
    messages: list[MessageResponse] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChatbotResponse(BaseModel):
    conversation_uid: str
    message_uid: str
    mode: Literal["M0_EXPLAIN", "M1_INSPECT", "M2_PREPARE", "M3_PREVIEW", "M5_ESCALATE"]
    risk_class: Literal["R0", "R1", "R2", "R3", "R4", "RX"]
    answer: str
    evidence: list[ChatbotEvidence] = Field(default_factory=list)
    qualification: str | None = None
    next_actions: list[str] = Field(default_factory=list)
    action_status: str = "NO_ACTION_EXECUTED"
    suggested_prompts: list[str] = Field(default_factory=list)
    context: ChatbotContext


class CapabilitiesResponse(BaseModel):
    effective_mode: str
    risk_classes_allowed: list[str]
    capabilities: list[Capability]
    tenant_context: ChatbotContext


class HealthResponse(BaseModel):
    status: str = "ok"
    module: str = "chatbot"
    version: str = "2.0.0"
