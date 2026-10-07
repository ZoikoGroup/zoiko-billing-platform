"""
chatbot/public_router.py
------------------------
UNAUTHENTICATED assistant API for the zoikobilling.com marketing-site widget
(ZB-AI-PUB-001).

  POST  /api/assistant/public/sessions                   -> PublicSessionResponse
  GET   /api/assistant/public/sessions                    -> list[PublicSessionSummary]
  POST  /api/assistant/public/sessions/{uid}/messages    -> PublicChatResponse
  GET   /api/assistant/public/health                     -> liveness

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

from app.core.rate_limiter import limit_route
from app.database import get_db

from .public_assistant import PublicAssistantService, _resolve_public_gateway
from .schemas import (
    PublicChatResponse,
    PublicCreateSessionRequest,
    PublicSendMessageRequest,
    PublicSessionResponse,
    PublicSessionSummary,
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


@router.get("/health")
def public_health():
    """Liveness for the widget's tiny pre-flight: does the module exist and
    is the model gateway configured (rules-only mode otherwise)?"""
    return {
        "status": "ok",
        "module": "public_assistant",
        "gateway": _PUBLIC_GATEWAY.provider_name if _PUBLIC_GATEWAY else "rules-only",
    }