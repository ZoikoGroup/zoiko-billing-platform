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
  GET    /chatbot/capabilities                - Resolve effective capabilities
  GET    /chatbot/health                      - Module health check

All endpoints gated by:
  - require_active_subscription("billing")
  - get_current_user (authenticated, active)
"""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_active_subscription
from app.database import get_db

from .schemas import (
    CreateSessionRequest,
    SendMessageRequest,
    CloseSessionRequest,
    SessionSummary,
    SessionDetail,
    ChatbotResponse,
    CapabilitiesResponse,
    HealthResponse,
)
from .service import ChatbotService

router = APIRouter(
    prefix="/chatbot",
    tags=["Zoiko Billing AI Chatbot"],
    dependencies=[Depends(require_active_subscription("billing"))],
)


def _svc(db: Session) -> ChatbotService:
    return ChatbotService(db)


# ── Session Endpoints ────────────────────────────────────────────────────────

@router.post("/sessions", response_model=SessionDetail, status_code=201)
def create_session(
    body: CreateSessionRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Create a new conversation session, optionally with an initial message."""
    return _svc(db).create_session(
        current_user=current_user,
        title=body.title,
        initial_message=body.initial_message,
        request_id=getattr(request.state, "request_id", None),
    )


@router.get("/sessions", response_model=list[SessionSummary])
def list_sessions(
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List the current user's conversations, newest first."""
    return _svc(db).list_sessions(
        current_user=current_user,
        limit=limit,
        offset=offset,
    )


@router.get("/sessions/{conversation_uid}", response_model=SessionDetail)
def get_session(
    conversation_uid: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Get a conversation with its full message history."""
    result = _svc(db).get_session(
        conversation_uid=conversation_uid,
        current_user=current_user,
        request_id=getattr(request.state, "request_id", None),
    )
    if result is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Conversation not found or access denied.")
    return result


@router.delete("/sessions/{conversation_uid}", status_code=204)
def close_session(
    conversation_uid: str,
    body: CloseSessionRequest | None = None,
    request: Request = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Close/resolve a conversation session."""
    success = _svc(db).close_session(
        conversation_uid=conversation_uid,
        current_user=current_user,
        request_id=getattr(request.state, "request_id", None),
    )
    if not success:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Conversation not found or access denied.")


# ── Message Endpoints ────────────────────────────────────────────────────────

@router.post("/sessions/{conversation_uid}/messages", response_model=ChatbotResponse)
def send_message(
    conversation_uid: str,
    body: SendMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Send a user message and receive a governed assistant response."""
    return _svc(db).respond(
        conversation_uid=conversation_uid,
        message=body.message,
        current_user=current_user,
        request_id=getattr(request.state, "request_id", None),
    )


# ── Capability & Health ──────────────────────────────────────────────────────

@router.get("/capabilities", response_model=CapabilitiesResponse)
def get_capabilities(
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Resolve effective chatbot capabilities for the authenticated user."""
    return _svc(db).get_capabilities(
        current_user=current_user,
        request_id=getattr(request.state, "request_id", None),
    )


@router.get("/health", response_model=HealthResponse)
def health():
    """Chatbot module health check."""
    return HealthResponse()
