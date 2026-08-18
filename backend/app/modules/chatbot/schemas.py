from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatbotMessageRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    conversation_id: str | None = None


class ChatbotEvidence(BaseModel):
    source: str
    resource_type: str
    resource_id: int | None = None
    reference: str | None = None
    summary: str
    fields: dict[str, Any] = Field(default_factory=dict)


class ChatbotContext(BaseModel):
    request_id: str | None = None
    user_id: int
    organization_id: int | None = None
    tenant_name: str | None = None
    role: str
    billing_plane: Literal["TENANT", "ZOIKO_COMMERCIAL"] = "TENANT"
    permissions: list[str]


class ChatbotResponse(BaseModel):
    conversation_id: str
    mode: Literal["M0_EXPLAIN", "M1_INSPECT", "M5_ESCALATE"]
    risk_class: Literal["R0", "R1"]
    answer: str
    evidence: list[ChatbotEvidence] = Field(default_factory=list)
    qualification: str | None = None
    next_actions: list[str] = Field(default_factory=list)
    action_status: str = "NO_ACTION_EXECUTED"
    context: ChatbotContext
