"""
chatbot/router.py
-----------------
Enterprise API router for the Zoiko Billing AI Chatbot.

Endpoints per ZB-AI-API-001:
  POST   /chatbot/sessions                    - Create conversation
  GET    /chatbot/sessions                    - List user's conversations
  GET    /chatbot/sessions/{uid}              - Get conversation with messages
  DELETE /chatbot/sessions/{uid}              - Close conversation
  POST   /chatbot/sessions/{uid}/messages     - Send message (main endpoint)
  POST   /chatbot/actions/draft               - Create action draft (M2)
  POST   /chatbot/actions/{uid}/preview       - Generate preview (M3)
  POST   /chatbot/actions/{uid}/confirm       - Confirm action (M3)
  POST   /chatbot/actions/{uid}/approval-request - Request approval
  POST   /chatbot/actions/{uid}/execute       - Execute action (M4)
  GET    /chatbot/capabilities                - Resolve effective capabilities
  GET    /chatbot/metrics                     - Observability metrics
  GET    /chatbot/health                      - Module health check

All endpoints gated by:
  - require_active_subscription("billing")
  - get_current_user (authenticated, active)
  - get_ai_context (tenant context resolution)
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_active_subscription
from app.database import get_db

from .context import get_ai_context, AIContext
from .schemas import (
    CreateSessionRequest,
    SendMessageRequest,
    CloseSessionRequest,
    CreateDraftRequest,
    ConfirmRequest,
    ApprovalDecisionRequest,
    ExecuteRequest,
    SessionSummary,
    SessionDetail,
    ChatbotResponse,
    DraftResponse,
    PreviewResponse,
    ConfirmationResponse,
    ExecutionResponse,
    CapabilitiesResponse,
    MetricsResponse,
    HealthResponse,
    ChatbotEvidence,
    ChatbotContext,
    Capability,
)
from .conversation.engine import ConversationEngine
from .actions.action_engine import ActionEngine, ActionEngineError
from .knowledge.retrieval import KnowledgeRetriever
from .model_gateway.base import ModelGateway, ModelGatewayError
from .model_gateway.anthropic_gateway import AnthropicModelGateway
from .guardrails.guardrails import GuardrailEngine, SystemPromptBuilder
from .audit.middleware import get_metrics

import uuid
import logging

_logger = logging.getLogger("zoiko_billing.chatbot")

router = APIRouter(
    prefix="/chatbot",
    tags=["Zoiko Billing AI Chatbot"],
    dependencies=[Depends(require_active_subscription("billing"))],
)

# ── Singletons ───────────────────────────────────────────────────────────────

_guardrail = GuardrailEngine()
_gateway: ModelGateway | None = None

def _get_gateway() -> ModelGateway | None:
    global _gateway
    if _gateway is None:
        try:
            _gateway = AnthropicModelGateway()
        except Exception:
            pass
    return _gateway


def _engine(db: Session) -> ConversationEngine:
    return ConversationEngine(db, model_gateway=_get_gateway())


def _actions(db: Session) -> ActionEngine:
    return ActionEngine(db)


# ── Session Endpoints ────────────────────────────────────────────────────────

@router.post("/sessions", status_code=201)
def create_session(
    body: CreateSessionRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    result = _engine(db).create_conversation(
        ctx=ctx,
        title=body.title,
        initial_message=body.initial_message,
    )
    return result


@router.get("/sessions")
def list_sessions(
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    return _engine(db).list_conversations(ctx=ctx, limit=limit, offset=offset)


@router.get("/sessions/{conversation_uid}")
def get_session(
    conversation_uid: str,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    result = _engine(db).get_conversation(conversation_uid=conversation_uid, ctx=ctx)
    if result is None:
        raise HTTPException(status_code=404, detail="Conversation not found or access denied.")
    return result


@router.delete("/sessions/{conversation_uid}", status_code=204)
def close_session(
    conversation_uid: str,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    success = _engine(db).close_conversation(conversation_uid=conversation_uid, ctx=ctx)
    if not success:
        raise HTTPException(status_code=404, detail="Conversation not found or access denied.")


# ── Message Endpoints ────────────────────────────────────────────────────────

@router.post("/sessions/{conversation_uid}/messages")
def send_message(
    conversation_uid: str,
    body: SendMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    _logger.error("[CHATBOT-DIAG] ENTRY: POST /sessions/%s/messages text=%r", conversation_uid, body.message[:200] if body.message else "")
    _logger.error("[CHATBOT-DIAG] ENTRY: ctx.org_id=%s ctx.user_id=%s ctx.tenant_ctx_id=%s", ctx.organization_id, ctx.user_id, ctx.tenant_context_id)
    # Input sanitization via guardrails
    cleaned_text, violations = _guardrail.sanitize_input(body.message)
    if violations and any("injection" in v for v in violations):
        _logger.error("[CHATBOT-DIAG] BLOCKED by guardrail: %s", violations)
        return ChatbotResponse(
            message_uid=str(uuid.uuid4()),
            answer="I'm sorry, I couldn't process that request. Please rephrase your billing question.",
            mode="M0_EXPLAIN",
            risk_class="R0",
        )

    try:
        result = _engine(db).send_message(
            conversation_uid=conversation_uid,
            message=cleaned_text,
            ctx=ctx,
            page_path=body.page,
        )
        _logger.error("[CHATBOT-DIAG] EXIT: mode=%s risk=%s answer_len=%d", result.get("mode"), result.get("risk_class"), len(result.get("answer", "")))
        return result
    except Exception as exc:
        import traceback as _tb
        _logger.error("[CHATBOT-DIAG] UNHANDLED EXCEPTION: %s: %s", type(exc).__name__, exc)
        _logger.error("[CHATBOT-DIAG] TRACEBACK:\n%s", _tb.format_exc())
        raise


# ── Action Lifecycle Endpoints ───────────────────────────────────────────────

@router.post("/actions/draft", response_model=DraftResponse)
def create_draft(
    body: CreateDraftRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    try:
        return _actions(db).create_draft(
            ctx=ctx,
            action_type=body.action_type,
            proposed_params=body.proposed_params,
        )
    except ActionEngineError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))


@router.post("/actions/{action_uid}/preview", response_model=PreviewResponse)
def preview_action(
    action_uid: str,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    try:
        return _actions(db).generate_preview(ctx=ctx, action_uid=action_uid)
    except ActionEngineError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))


@router.post("/actions/{action_uid}/confirm", response_model=ConfirmationResponse)
def confirm_action(
    action_uid: str,
    body: ConfirmRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    try:
        return _actions(db).confirm_action(
            ctx=ctx,
            action_uid=action_uid,
            preview_uid=body.preview_uid,
            preview_hash=body.preview_hash,
        )
    except ActionEngineError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))


@router.post("/actions/{action_uid}/approval-request")
def request_approval(
    action_uid: str,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    try:
        return _actions(db).request_approval(ctx=ctx, action_uid=action_uid)
    except ActionEngineError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))


@router.post("/actions/{action_uid}/approve")
def approve_action(
    action_uid: str,
    body: ApprovalDecisionRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    try:
        return _actions(db).decide_approval(
            ctx=ctx,
            approval_uid=action_uid,
            decision=body.decision,
            comment=body.comment,
        )
    except ActionEngineError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))


@router.post("/actions/{action_uid}/execute", response_model=ExecutionResponse)
def execute_action(
    action_uid: str,
    body: ExecuteRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    if _guardrail.is_safe_mode:
        raise HTTPException(status_code=503, detail="Safe mode active. M4 execution disabled.")
    try:
        return _actions(db).execute_action(
            ctx=ctx,
            action_uid=action_uid,
            idempotency_key=body.idempotency_key,
        )
    except ActionEngineError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))


# ── Capabilities, Metrics & Health ───────────────────────────────────────────

@router.get("/capabilities")
def get_capabilities(
    request: Request,
    ctx: AIContext = Depends(get_ai_context),
):
    role = ctx.role

    capabilities = [
        Capability(id="read_invoices", label="Read Invoices", description="Look up and explain invoice state", enabled="invoice:read" in ctx.permissions, risk_class="R1"),
        Capability(id="read_payments", label="Read Payments", description="Look up and explain payment state", enabled="payment:read" in ctx.permissions, risk_class="R1"),
        Capability(id="read_customers", label="Read Customers", description="Look up customer billing data", enabled="customer:read" in ctx.permissions, risk_class="R1"),
        Capability(id="draft_invoice", label="Draft Invoice", description="Prepare invoice drafts for review", enabled="billing:draft" in ctx.permissions, risk_class="R2"),
        Capability(id="knowledge_help", label="Knowledge Help", description="Billing workflow guidance", enabled=True, risk_class="R0"),
    ]

    modes = ["M0_EXPLAIN", "M1_INSPECT"]
    if "billing:draft" in ctx.permissions:
        modes.append("M2_PREPARE")
    if "billing:admin" in ctx.permissions:
        modes.extend(["M3_PREVIEW", "M4_EXECUTE"])

    return CapabilitiesResponse(
        effective_mode="_".join(m.lower().split("_")[0] for m in modes[:2]),
        risk_classes_allowed=["R0", "R1"] + (["R2", "R3", "R4"] if "billing:admin" in ctx.permissions else []),
        capabilities=capabilities,
    )


@router.get("/metrics", response_model=MetricsResponse)
def get_chatbot_metrics(
    ctx: AIContext = Depends(get_ai_context),
):
    return get_metrics()


@router.get("/health", response_model=HealthResponse)
def health():
    gateway = _get_gateway()
    return HealthResponse(
        safe_mode=_guardrail.is_safe_mode,
        model_gateway="anthropic" if gateway else "unavailable",
    )
