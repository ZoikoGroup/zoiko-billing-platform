"""
chatbot/public_router.py
------------------------
UNAUTHENTICATED assistant API for the zoikobilling.com marketing-site widget
(ZB-AI-PUB-001).

  POST  /api/assistant/public/sessions                   -> PublicSessionResponse
  GET   /api/assistant/public/sessions                    -> list[PublicSessionSummary]
  POST  /api/assistant/public/sessions/{uid}/messages    -> PublicChatResponse
  GET   /api/assistant/public/config                      -> PublicConfigResponse
  POST  /api/assistant/public/support/request             -> PublicSupportRequestResponse
  POST  /api/assistant/public/feedback                    -> PublicFeedbackResponse
  POST  /api/assistant/public/events                      -> PublicEventResponse
  GET   /api/assistant/public/health                      -> PublicHealthResponse

Deliberately free of require_active_subscription / get_current_user — the
widget runs on a public marketing page. Abuse controls:
  - per-IP DB-backed rate limit (PUBLIC_ASSISTANT_* settings) — the primary
    gate; holds across every worker process.
  - slowapi transport-level limits below — coarse second gate.
  - public-only KB scope enforced inside the retriever, not here.
"""

import ipaddress
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from slowapi.util import get_remote_address

from app.config import settings
from app.core.rate_limiter import limit_route
from app.database import get_db

from .public_assistant import PublicAssistantService, _resolve_public_gateway
from .public_config import build_public_config
from .schemas import (
    PublicChatResponse,
    PublicConfigResponse,
    PublicCreateSessionRequest,
    PublicEventRequest,
    PublicEventResponse,
    PublicFeedbackRequest,
    PublicFeedbackResponse,
    PublicHealthResponse,
    PublicSendMessageRequest,
    PublicSessionResponse,
    PublicSessionSummary,
    PublicSupportRequestCreate,
    PublicSupportRequestResponse,
)

_logger = logging.getLogger("zoiko_billing.chatbot.public")

router = APIRouter(
    prefix="/assistant/public",
    tags=["Zoiko Billing Public Assistant"],
)

# Gateway resolved once at import (mirrors chatbot/router caching). None when
# the provider key is absent -> deterministic rules-only mode.
_PUBLIC_GATEWAY = _resolve_public_gateway()


# ── IP hashing ───────────────────────────────────────────────────────────────
# Raw client IPs are hashed before they ever touch a rate-limit row or the
# session table, so no PII (an IP address) is stored.

def _client_ip(request: Request) -> str:
    """Best-effort real client IP, honouring a reverse proxy.

    The marketing widget reaches this API through the Next.js server-side proxy
    at /api/assistant/public/* (same-origin, so the browser never needs CORS).
    Without honouring X-Forwarded-For every visitor on the site would resolve to
    this proxy's own socket address and collapse into ONE rate-limit bucket, so
    the first 15 messages in a 2-minute window would take the whole website
    offline.

    X-Forwarded-For is a "client, proxy1, proxy2" chain (each hop appends), so
    the visitor is the leftmost entry. Falls back to X-Real-IP and then to the
    socket peer, which is the correct answer for a direct unproxied call.

    Note: this is an abuse-rate-limit key, not a security boundary - a client
    that can reach the backend directly could still spoof the leftmost entry.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        for candidate in (part.strip() for part in forwarded.split(",")):
            if not candidate:
                continue
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            return candidate
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    peer = get_remote_address(request)
    return peer or "unknown"


def _hash_ip(request: Request) -> str:
    from app.core.rate_limiter import PublicRateLimiter
    return PublicRateLimiter().ip_key(_client_ip(request))


def _service(db: Session) -> PublicAssistantService:
    return PublicAssistantService(db, gateway=_PUBLIC_GATEWAY)


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/sessions", status_code=201, response_model=PublicSessionResponse)
@limit_route("20/minute")
def create_public_session(
    body: PublicCreateSessionRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Start (or idempotently resume) an anonymous chat session."""
    service = _service(db)
    try:
        return service.create_session(
            session_uid=body.session_uid,
            ip_hash=_hash_ip(request),
        )
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        _logger.error("public session create failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Could not start a chat session right now. Please try again in a moment.",
        )


@router.get("/sessions", response_model=list[PublicSessionSummary])
@limit_route("30/minute")
def list_public_sessions(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Lite history for the widget's Recent-conversations dropdown.

    Scoped to the caller's hashed IP — a visitor only ever sees their own
    anonymous sessions; no raw IPs are stored or returned.
    """
    service = _service(db)
    try:
        return service.list_sessions(ip_hash=_hash_ip(request), limit=limit)
    except SQLAlchemyError as exc:
        db.rollback()
        _logger.error("public session listing failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Could not load conversation history right now. Please try again in a moment.",
        )


@router.post("/sessions/{session_uid}/messages", response_model=PublicChatResponse)
@limit_route("120/minute")
def send_public_message(
    session_uid: str,
    body: PublicSendMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Send a message to an anonymous chat session.

    Every branch is wrapped so a failure degrades to a polite canned answer
    (503 with a human-readable detail) rather than a raw 5xx — the request
    comes from a public marketing page with no one to apologize to but a
    visitor.
    """
    service = _service(db)
    try:
        return service.send_message(
            session_uid=session_uid,
            message=body.message,
            ip_hash=_hash_ip(request),
            page=body.page,
            idempotency_key=body.message_id,
            intent_id=body.intent_id,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        _logger.exception("public message failed (session=%s): %s", session_uid, exc)
        raise HTTPException(
            status_code=503,
            detail="I ran into a temporary issue. Please try sending your message again.",
        )


@router.get("/config", response_model=PublicConfigResponse)
@limit_route("60/minute")
def public_config(request: Request):
    """Widget configuration: copy, the eight approved topic tiles, theme,
    support mode and the link allowlist.

    The tiles are served from a managed config so the product team can change
    entry points WITHOUT editing the model prompt. No feature promises live in
    the AI prompt.
    """
    return build_public_config()


@router.post("/support/request", response_model=PublicSupportRequestResponse, status_code=201)
@limit_route("10/minute")
def create_support_request(
    body: PublicSupportRequestCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Create a human-support request from the public widget.

    Consent for transcript sharing is explicit and optional. A reference is
    returned only after this system has durably persisted the request; delivery
    to a support desk is reported only when a configured webhook acknowledged
    it. Never fabricates a ticket or support availability.
    """
    service = _service(db)
    try:
        return service.create_support_request(
            issue_type=body.issue_type,
            email=body.email,
            summary=body.summary,
            message=body.message,
            transcript_consent=body.transcript_consent,
            session_uid=body.session_uid,
            ip_hash=_hash_ip(request),
            client_request_id=body.client_request_id,
        )
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        _logger.error("public support request failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Could not submit your support request right now. Please try again in a moment.",
        )


@router.post("/feedback", response_model=PublicFeedbackResponse, status_code=201)
@limit_route("60/minute")
def public_feedback(
    body: PublicFeedbackRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Optional, privacy-minimal helpful/not-helpful signal on one answer."""
    service = _service(db)
    try:
        return service.record_feedback(
            session_uid=body.session_uid,
            message_uid=body.message_uid,
            helpful=body.helpful,
            reason=body.reason,
        )
    except SQLAlchemyError as exc:
        db.rollback()
        _logger.error("public feedback failed: %s", exc)
        raise HTTPException(status_code=503, detail="Could not record feedback right now.")


@router.post("/events", response_model=PublicEventResponse, status_code=202)
@limit_route("240/minute")
def public_event(
    body: PublicEventRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Record one privacy-minimized widget instrumentation event (spec §12.3).

    Fire-and-forget from the widget. Only allowlisted event names plus the
    §12.3 safe metadata are accepted; the visitor's question text is never part
    of this contract. Unknown events are dropped server-side, so a client typo
    can never widen the telemetry surface.
    """
    service = _service(db)
    return service.record_event(
        event=body.event,
        session_uid=body.session_uid,
        topic_id=body.topic_id,
        locale=body.locale,
        config_version=body.config_version,
        timing_bucket=body.timing_bucket,
    )


@router.get("/health", response_model=PublicHealthResponse)
def public_health():
    """Liveness for the widget's pre-flight.

    Deliberately minimal: availability + degraded mode only. Never reveals the
    provider, model, version or any other internal detail. ``available`` is
    true whenever the assistant module is enabled; ``degraded`` is true when a
    model gateway is not configured (deterministic rules-only mode).
    """
    enabled = bool(settings.PUBLIC_ASSISTANT_ENABLED)
    rules_only = _PUBLIC_GATEWAY is None
    return {
        "status": "ok" if enabled else "degraded",
        "available": enabled,
        "degraded": enabled and rules_only,
    }