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
  POST   /chatbot/sessions/{uid}/messages/stream    - Send message (SSE stream)
  POST   /chatbot/sessions/{uid}/messages/stream/cancel - Stop in-flight generation
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
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

import asyncio
import json
import threading

from app.core.dependencies import get_current_user, require_active_subscription
from app.database import get_db, SessionLocal

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
from .model_gateway.groq_gateway import GroqModelGateway
from .model_gateway.anthropic_gateway import AnthropicModelGateway
from .guardrails.guardrails import GuardrailEngine, SystemPromptBuilder
from .audit.middleware import get_metrics

from app.config import settings as app_settings

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

_gateway_provider: str | None = None

def _get_gateway(provider: str | None = None) -> ModelGateway | None:
    """Resolve the model gateway for the requested provider.

    Uses the AI_PROVIDER setting when no explicit provider is given.
    Returns None when the provider's API key is not configured — the engine
    then runs rules-only (fully deterministic).
    """
    global _gateway, _gateway_provider
    target = provider or app_settings.AI_PROVIDER
    # Return cached gateway if provider matches
    if _gateway is not None and _gateway_provider == target:
        return _gateway
    if target == "anthropic" and app_settings.ANTHROPIC_API_KEY:
        try:
            _gateway = AnthropicModelGateway()
            _gateway_provider = "anthropic"
        except Exception:
            _gateway = None
            _gateway_provider = None
    elif app_settings.GROQ_API_KEY:
        try:
            _gateway = GroqModelGateway()
            _gateway_provider = "groq"
        except Exception:
            _gateway = None
            _gateway_provider = None
    else:
        _gateway = None
        _gateway_provider = None
    return _gateway


def _engine(db: Session, provider: str | None = None) -> ConversationEngine:
    return ConversationEngine(db, model_gateway=_get_gateway(provider))


def _raise_action_error(e: ActionEngineError) -> None:
    """Canonical action error body (guide §24 — ApiProblem-style): status +
    stable error_code + a human recovery hint so clients never see a bare
    message and never have to guess the next step from a status code."""
    raise HTTPException(
        status_code=e.status_code,
        detail={
            "error_code": getattr(e, "error_code", None) or f"action_{e.status_code}",
            "message": str(e),
            "recovery": getattr(e, "recovery", None),
        },
    )


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
        return ChatbotResponse(
            message_uid=str(uuid.uuid4()),
            answer="I ran into a temporary issue processing that. Your message wasn't lost — please try sending it again. If this keeps happening, I can connect you to a team member.",
            mode="M0_EXPLAIN",
            risk_class="R0",
        )


# ── Streaming (SSE) ─────────────────────────────────────────────────────
# Same governed pipeline as POST /messages, but with a token sink attached
# to the request-scoped engine: when the LLM synthesis step supports
# incremental generation the router relays each content delta as an SSE
# "token" event *while the pipeline is still running*, so the client sees
# words appear instead of a static "Checking records..." wait.

# Cancellation registry: conversation_uid -> threading.Event.  The Stop button
# sets the event via POST .../messages/stream/cancel; the producer thread's
# engine checks it between LLM deltas and stops generating immediately, so the
# provider is never asked to keep streaming for a client that already closed
# the connection (avoids wasted LLM tokens).  Entries live only for the
# lifetime of a stream — removed when the SSE generator closes.  NOTE: closing
# the SSE connection alone does NOT cancel the pipeline; the client must call
# the cancel endpoint when the user presses Stop.
_STREAM_STOPS: dict[str, threading.Event] = {}

async def _sse_events(conversation_uid: str, message: str, ctx: AIContext, page_path: str | None):
    """Async generator bridging a producer thread to an SSE stream.

    The pipeline runs on a daemon thread with its OWN database session (the
    request thread's session belongs to the dependency lifecycle and is never
    shared across threads).  Tokens arriving from the LLM stream are relayed
    live; the terminal event carries the full governed ChatbotResponse (which
    the client treats as authoritative — it reconciles any partial text).
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    tokens: list[str] = []
    # Stop-generation signal (see description above / POST .../stream/cancel).
    stop_event = threading.Event()
    _STREAM_STOPS[conversation_uid] = stop_event
    try:
        def sink(token: str) -> None:
            if stop_event.is_set():
                # Cancelled — drop any token that raced the Stop click; the
                # generator's own loop also stops on the event.
                return
            tokens.append(token)
            try:
                loop.call_soon_threadsafe(queue.put_nowait, ("token", token))
            except RuntimeError:
                pass  # event loop already shutting down

        def run_pipeline() -> None:
            try:
                with SessionLocal() as sess:
                    engine = ConversationEngine(sess, model_gateway=_get_gateway())
                    engine._token_sink = sink
                    engine._stop_event = stop_event
                    result = engine.send_message(
                        conversation_uid=conversation_uid,
                        message=message,
                        ctx=ctx,
                        page_path=page_path,
                    )
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ("done", {"response": result, "streamed": bool(tokens)}),
                )
            except Exception as exc:
                _logger.error("[CHATBOT-DIAG] STREAM pipeline failed: %s: %s", type(exc).__name__, exc)
                loop.call_soon_threadsafe(queue.put_nowait, ("error", str(exc)))

        threading.Thread(target=run_pipeline, daemon=True).start()

        # Flush headers immediately so the client switches to "streaming" state.
        yield "event: ready\ndata: {}\n\n"
        while True:
            kind, payload = await queue.get()
            if stop_event.is_set():
                # User pressed Stop — stop relaying; the client already shows
                # the partial answer it received before clicking.
                break
            if kind == "token":
                yield f"event: token\ndata: {json.dumps({'delta': payload})}\n\n"
            elif kind == "done":
                yield f"event: done\ndata: {json.dumps(payload)}\n\n"
                break
            elif kind == "error":
                yield f"event: error\ndata: {json.dumps({'message': payload})}\n\n"
                break
    finally:
        _STREAM_STOPS.pop(conversation_uid, None)


@router.post("/sessions/{conversation_uid}/messages/stream")
async def stream_message(
    conversation_uid: str,
    body: SendMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    """Send a message and receive the answer as a Server-Sent Events stream.

    Events:
      ready — headers flushed (generation started)
      token — ``{"delta": "..."}`` partial answer text (LLM-synthesized only)
      done  — ``{"response": {...}, "streamed": bool}`` authoritative reply;
              ``streamed`` true means tokens were relayed incrementally,
              false means the answer was produced whole (rules/canned/cached)
              and the client should animate it locally.
      error — ``{"message": "..."}`` terminal failure
    """
    _logger.error("[CHATBOT-DIAG] ENTRY: POST /sessions/%s/messages/stream text=%r", conversation_uid, body.message[:200] if body.message else "")
    cleaned_text, violations = _guardrail.sanitize_input(body.message)
    if violations and any("injection" in v for v in violations):
        _logger.error("[CHATBOT-DIAG] BLOCKED by guardrail (stream): %s", violations)
        return ChatbotResponse(
            message_uid=str(uuid.uuid4()),
            answer="I'm sorry, I couldn't process that request. Please rephrase your billing question.",
            mode="M0_EXPLAIN",
            risk_class="R0",
        )
    return StreamingResponse(
        _sse_events(conversation_uid, cleaned_text, ctx, body.page),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/sessions/{conversation_uid}/messages/stream/cancel")
def cancel_stream(conversation_uid: str, request: Request):
    """Best-effort cancellation of an in-flight SSE generation (Stop button).

    Sets the stop event registered by the streaming request; the producer
    thread's engine checks it between LLM deltas and stops immediately,
    keeping the partial answer already streamed.  Safe to call after the
    stream has finished (returns ``{"cancelled": false}`` and is a no-op).

    Closing the SSE connection alone does NOT stop generation — the pipeline
    runs on a daemon thread that would otherwise finish (burning LLM tokens), so
    the client must call this endpoint when the user presses Stop.
    """
    event = _STREAM_STOPS.get(conversation_uid)
    if event is not None:
        event.set()
        return {"cancelled": True}
    return {"cancelled": False}


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
        _raise_action_error(e)


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
        _raise_action_error(e)


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
        _raise_action_error(e)


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
        _raise_action_error(e)


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
        _raise_action_error(e)


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
        _raise_action_error(e)


@router.post("/actions/{action_uid}/cancel")
def cancel_action_endpoint(
    action_uid: str,
    request: Request,
    db: Session = Depends(get_db),
    ctx: AIContext = Depends(get_ai_context),
):
    try:
        return _actions(db).cancel_action(ctx=ctx, action_uid=action_uid)
    except ActionEngineError as e:
        _raise_action_error(e)


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
        model_gateway=gateway.provider_name if gateway else "unavailable",
    )
