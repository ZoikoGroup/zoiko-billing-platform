"""
chatbot/public_assistant.py
---------------------------
Lean, auth-free assistant for the zoikobilling.com marketing-site widget
(ZB-AI-PUB-001).

Deliberately does NOT reuse ConversationEngine / create_conversation /
send_message: that pipeline is built for authenticated tenant context
(AIConversation requires organization/user/tenant FKs, intent classification,
action drafts, a static-answer cache keyed by tenant, ...). The public path is
EXPLAIN-only over an allowlisted public KB with:

  - per-IP DB-backed rate limiting (survives multi-worker deployments, where
    slowapi's in-process storage is trivially bypassed)
  - input sanitization + injection refusal (same GuardrailEngine as the
    platform assistant)
  - canned chitchat for greetings/gratitude/farewell
  - retrieval hard-scoped to billing_public + is_public=True only
  - LLM synthesis when a model gateway is configured, plus a deterministic
    rules-only fallback that answers verbatim from the single best chunk
  - every branch wraps so a failure degrades to a canned polite answer
    instead of a 5xx to a public visitor
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings

from .context.ai_context import AIContext
from .knowledge.retrieval import KnowledgeRetriever, RetrievalResult
from .guardrails.guardrails import GuardrailEngine, PublicSystemPromptBuilder
from .model_gateway.base import ModelGateway, ModelGatewayError, ModelMessage
from .models import (
    PublicAssistantFeedback,
    PublicAssistantMessage,
    PublicAssistantSession,
    PublicSupportRequest,
    RiskClass,
    SenderType,
)
from .public_config import (
    UNCERTAINTY_MESSAGE,
    SUPPORT_ISSUE_TYPES,
    is_public_url_allowed,
)
from .schemas import ChatbotEvidence

logger = logging.getLogger("zoiko_billing.ai.public")

# ── Canned answers (deterministic; no gateway required) ─────────────────────

_GREETING_ANSWER = (
    "Hi! I'm the Zoiko Billing assistant. I can answer questions about how "
    "Zoiko Billing's invoicing, payments, subscriptions, dunning, and "
    "multi-currency features work — and point you to the right page on "
    "zoikobilling.com. What would you like to know?"
)
_GRATITUDE_ANSWER = (
    "You're welcome! If anything else about Zoiko Billing comes to mind, just ask."
)
_FAREWELL_ANSWER = (
    "Thanks for chatting! There's plenty more on zoikobilling.com, and you can "
    " hit Book a demo whenever you're ready to talk to the team."
)
_INJECTION_REFUSAL = (
    "I can only answer questions about the Zoiko Billing platform. "
    "Please rephrase your question."
)
# Approved uncertainty copy (spec §4 / §8.2). Kept as the single source for the
# "no approved answer" state; the system prompt instructs the model to emit the
# same sentence so cached/streamed variants stay consistent.
_ABSTAIN_ANSWER = UNCERTAINTY_MESSAGE
_SESSION_LIMIT_ANSWER = (
    "We've covered a lot in this conversation. If you have more questions, "
    "open the assistant again or start a new conversation."
)
# Account-specific information can only be answered after authentication.
_REQUIRES_AUTH_ANSWER = (
    "I can’t access account-specific information in this public assistant. "
    "Sign in to your Zoiko Billing account to view your invoices, payments, "
    "balances and other account details."
)

# ── Account-data request detection (public mode must never answer these) ────
# A possessive/our + billing noun is a request for account data UNLESS the
# message is a how-to ("How do I create my first invoice?"). This keeps the
# public assistant honest: it explains the sign-in requirement instead of
# pretending it can look up a tenant record.
_ACCOUNT_NOUN_RE = re.compile(
    r"\b(?:my|our|mine)\s+"
    r"(?:invoice|invoices|bill|bills|billing|balance|balances|payment|payments|"
    r"payment\s+status|invoice\s+status|account|subscription|subscriptions|"
    r"plan|plans|due\s+date|outstanding|overdue|credit|credits|refund|refunds|"
    r"reconciliation|usage|transactions?|ledger|statement|statements)\b",
    re.IGNORECASE,
)
_ACCOUNT_OWE_RE = re.compile(
    r"\b(?:how\s+much\s+(?:do|does)\s+(?:i|we)\s+owe|what\s+do\s+i\s+owe)\b",
    re.IGNORECASE,
)
_HOWTO_RE = re.compile(
    r"^(?:\s*(?:how\s+(?:do|can|would|should)\s+(?:i|we)\b|"
    r"how\s+to\b|way\s+to\b|ways\s+to\b|steps?\s+to\b|guide\s+to\b|"
    r"gettings?\s+started\b))",
    re.IGNORECASE,
)

# ── Chitchat matchers (anchored; a real question after the greeting still
# gets answered — only a SHORT message with a bare greeting/farewell/thanks
# is canned) ──────────────────────────────────────────────────────────────────

_FAREWELL_RE = re.compile(r"^(?:bye+|goodbye+|see\s+(?:ya|you)|gtg)\b", re.IGNORECASE)
_GRATITUDE_RE = re.compile(r"^(?:thanks+|thank\s+you|thx+|ty)\b", re.IGNORECASE)
_GREETING_RE = re.compile(
    r"^(?:hi+|hello+|hey+|yo+|howdy|hola|good\s+(?:morning|afternoon|evening))\b",
    re.IGNORECASE,
)

# URL-ish tokens that carry no topical signal for page-context boosting.
_PAGE_BOOST_STOPWORDS = frozenset({
    "http", "https", "www", "com", "zoiko", "zoikobilling", "billing",
})

# ── Instrumentation allowlist (spec §12.3) ──────────────────────────────────
# The widget records only these privacy-minimized events. Anything not on the
# list is dropped at the server boundary so a client bug can never widen the
# telemetry surface or smuggle free text into the log stream.
_PUBLIC_EVENT_ALLOWLIST = frozenset({
    "widget_opened",
    "widget_minimized",
    "topic_selected",
    "message_submitted",
    "answer_rendered",
    "answer_source_clicked",
    "auth_cta_clicked",
    "support_requested",
    "ticket_confirmed",
    "assistant_error",
})


def _resolve_public_gateway() -> ModelGateway | None:
    """Mirror of chatbot/router._get_gateway for the public widget.

    Returns None (deterministic rules-only mode) when the configured
    provider's API key is absent — the public endpoint must never fail open
    toward a provider that isn't configured.
    """
    target = settings.AI_PROVIDER
    if target == "anthropic" and settings.ANTHROPIC_API_KEY:
        try:
            from .model_gateway.anthropic_gateway import AnthropicModelGateway
            return AnthropicModelGateway()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Anthropic gateway init failed for public assistant: %s", exc)
            return None
    if settings.GROQ_API_KEY:
        try:
            from .model_gateway.groq_gateway import GroqModelGateway
            return GroqModelGateway()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Groq gateway init failed for public assistant: %s", exc)
            return None
    return None


class PublicAssistantService:
    """Auth-free, session-based assistant for the marketing site."""

    def __init__(
        self,
        db: Session,
        gateway: ModelGateway | None = None,
        guardrail: GuardrailEngine | None = None,
        rate_limiter: Any = None,
    ):
        self.db = db
        self._gateway = gateway
        self._guardrail = guardrail or GuardrailEngine()
        if rate_limiter is None:
            from app.core.rate_limiter import PublicRateLimiter
            rate_limiter = PublicRateLimiter()
        self._rate_limiter = rate_limiter
        self._retriever = KnowledgeRetriever(db)

    # ── Sessions ────────────────────────────────────────────────────────

    def create_session(self, *, session_uid: str | None = None, ip_hash: str | None = None) -> dict:
        """Create (or idempotently return) a public chat session.

        A widget that pre-generates a session_uid can re-post the same uid
        after a page reload; if the session already exists, is still active,
        belongs to the caller and has not expired we return it with its recent
        history instead of erroring. Anything else (active-but-expired, bound
        to a different visitor, or closed) is reported as not resumable so the
        widget can start a genuinely fresh conversation; an existing session is
        never silently handed to a different IP.
        """
        sid = (session_uid or "").strip() or str(uuid.uuid4())
        existing = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.session_uid == sid)
            .first()
        )
        if existing is not None:
            if existing.status != "active":
                raise HTTPException(status_code=404, detail="Session already exists but is no longer active.")
            if ip_hash and existing.ip_hash and existing.ip_hash != ip_hash:
                raise HTTPException(
                    status_code=404,
                    detail="This conversation is not resumable on this device. A new conversation will be started.",
                )
            if self._session_age_seconds(existing) > settings.PUBLIC_ASSISTANT_MAX_SESSION_AGE_SECONDS:
                existing.status = "expired"
                self.db.commit()
                raise HTTPException(
                    status_code=404,
                    detail="This conversation session has expired. Please start a new conversation.",
                )
            self.db.rollback()
            return {
                "session_uid": existing.session_uid,
                "status": existing.status,
                "messages": self._session_history(sid),
                "created_at": existing.created_at,
            }

        sess = PublicAssistantSession(
            session_uid=sid,
            ip_hash=ip_hash,
            status="active",
            message_count=0,
        )
        self.db.add(sess)
        try:
            self.db.commit()
        except SQLAlchemyError:
            self.db.rollback()
            raise
        self.db.refresh(sess)
        return {
            "session_uid": sess.session_uid,
            "status": sess.status,
            "messages": [],
            "created_at": sess.created_at,
        }

    def _session_history(self, session_uid: str, limit: int = 6) -> list[dict]:
        """Last N turns of a public session, oldest→newest, for the widget."""
        sess = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.session_uid == session_uid)
            .first()
        )
        if sess is None:
            return []
        rows = (
            self.db.query(PublicAssistantMessage)
            .filter(PublicAssistantMessage.session_id == sess.id)
            .order_by(PublicAssistantMessage.id.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "message_uid": m.message_uid,
                "sender_type": m.sender_type.value if hasattr(m.sender_type, "value") else str(m.sender_type),
                "message_text": m.message_text,
                "mode": m.mode,
                "risk_class": m.risk_class.value if hasattr(m.risk_class, "value") else str(m.risk_class or "R0"),
                "created_at": m.created_at,
            }
            for m in reversed(rows)
        ]

    # ── History listing (widget Recent-conversations dropdown) ─────────

    def list_sessions(self, *, ip_hash: str | None, limit: int = 50) -> list[dict]:
        """Recent public sessions for a visitor (privacy-scoped to the hashed IP).

        Titles are derived from each session's first user message (mirrors the
        platform's conversation titling), so the widget's history dropdown reads
        like the authenticated assistant.
        """
        if not ip_hash:
            return []
        sessions = (
            self.db.query(PublicAssistantSession)
            .filter(
                PublicAssistantSession.ip_hash == ip_hash,
                PublicAssistantSession.status == "active",
            )
            .order_by(PublicAssistantSession.updated_at.desc())
            .limit(limit)
            .all()
        )
        if not sessions:
            return []
        first_user_text = self._first_user_texts([s.id for s in sessions])
        return [
            {
                "session_uid": s.session_uid,
                "title": self._derive_title(first_user_text.get(s.id, "")),
                "status": s.status,
                "message_count": s.message_count or 0,
                "created_at": s.created_at,
                "updated_at": s.updated_at,
            }
            for s in sessions
        ]

    def _first_user_texts(self, session_ids: list[int]) -> dict[int, str]:
        """Batch-fetch the first user message for each session (one query)."""
        if not session_ids:
            return {}
        rows = (
            self.db.query(PublicAssistantMessage)
            .filter(
                PublicAssistantMessage.session_id.in_(session_ids),
                PublicAssistantMessage.sender_type == SenderType.USER,
            )
            .order_by(PublicAssistantMessage.id.asc())
            .all()
        )
        first: dict[int, str] = {}
        for r in rows:
            if r.session_id not in first:
                first[r.session_id] = r.message_text
        return first

    @staticmethod
    def _derive_title(text: str, max_len: int = 48) -> str:
        """Derive a short title from the first user message (mirrors the
        platform's derive_conversation_title)."""
        t = re.sub(r"\s+", " ", text or "").strip()
        if not t:
            return "New Conversation"
        if len(t) > max_len:
            cut = t[:max_len]
            if " " in cut:
                cut = cut[: cut.rfind(" ")]
            cut = re.sub(r"[\s,;:.!?—-]+$", "", cut)
            return cut[0].upper() + cut[1:] + "…"
        return t[0].upper() + t[1:]

    def _session_age_seconds(self, sess: PublicAssistantSession) -> float:
        """Seconds since this session's last activity (inactivity expiry).

        Normalizes naive timestamps (SQLite stores CURRENT_TIMESTAMP as naive
        UTC) so the comparison never raises on mixed-aware/naive datetimes.
        """
        ts = sess.updated_at or sess.created_at
        if ts is None:
            return 0.0
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - ts).total_seconds()

    def expire_stale_sessions(
        self,
        *,
        max_age_seconds: int | None = None,
        batch_size: int = 500,
    ) -> int:
        """Bulk-mark inactive sessions as ``expired``. Never deletes.

        Retention support (spec §A12 time-based expiry / §9 item 8). Sessions
        become unusable once expired, but the transcript is intentionally NOT
        deleted here: hard deletion requires an approved retention policy (see
        the gap analysis — retention window is a legal/product decision). Safe
        to call from a scheduled job; idempotent, bounded by ``batch_size``, and
        returns the number of rows newly marked expired.
        """
        age = (
            settings.PUBLIC_ASSISTANT_MAX_SESSION_AGE_SECONDS
            if max_age_seconds is None
            else max_age_seconds
        )
        # Naive UTC cutoff: SQLite stores CURRENT_TIMESTAMP as naive UTC, so the
        # comparison stays valid regardless of the stored row's tz-awareness.
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=age)
        stale = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.status == "active")
            .filter(
                func.coalesce(
                    PublicAssistantSession.updated_at,
                    PublicAssistantSession.created_at,
                )
                < cutoff
            )
            .limit(batch_size)
            .all()
        )
        for sess in stale:
            sess.status = "expired"
        if stale:
            self.db.commit()
        return len(stale)

    def _get_session(
        self, session_uid: str, ip_hash: str | None = None
    ) -> PublicAssistantSession:
        sess = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.session_uid == session_uid)
            .first()
        )
        if sess is None:
            raise HTTPException(status_code=404, detail="Session not found or no longer active.")
        # Ownership: a session is only usable by the anonymous visitor that
        # created it (same hashed IP). A request from any other IP gets the same
        # 404 as an unknown session so nobody can probe or read another
        # visitor's anonymous UUID.
        if ip_hash and sess.ip_hash and sess.ip_hash != ip_hash:
            raise HTTPException(status_code=404, detail="Session not found or no longer active.")
        if sess.status != "active":
            raise HTTPException(status_code=404, detail="Session not found or no longer active.")
        # Time-based expiry (spec §A12): expired sessions invalidate correctly.
        if self._session_age_seconds(sess) > settings.PUBLIC_ASSISTANT_MAX_SESSION_AGE_SECONDS:
            sess.status = "expired"
            self.db.commit()
            raise HTTPException(
                status_code=404,
                detail="This conversation session has expired. Please start a new conversation.",
            )
        return sess

    # ── Messages ────────────────────────────────────────────────────────

    def send_message(
        self,
        *,
        session_uid: str,
        message: str,
        ip_hash: str | None,
        page: str | None = None,
        idempotency_key: str | None = None,
        intent_id: str | None = None,
    ) -> dict:
        """Process a public visitor message and return a governed reply dict."""
        if not settings.PUBLIC_ASSISTANT_ENABLED:
            raise HTTPException(status_code=503, detail="The public assistant is temporarily paused.")

        # 0. Session must exist, be active, belong to the caller and not be
        #    expired (cheap indexed lookups) so an idempotent retry can be
        #    recognised before it consumes rate budget.
        sess = self._get_session(session_uid, ip_hash)

        # Privacy-minimized telemetry: record the topic-tile intent id only
        # (a short config id), never the visitor's question text.
        if intent_id:
            logger.info("public topic_selected intent=%s session=%s", intent_id, session_uid)

        # 0b. Idempotency — a retried send (double-click, refresh, network
        #     retry) with the same key returns the ORIGINAL exchange instead of
        #     creating a second user turn + answer.
        if idempotency_key:
            existing = self._find_by_idempotency_key(sess, idempotency_key)
            if existing is not None:
                return existing

        # 1. Rate limit — the expensive/abusable part of an auth-free endpoint
        #    must be gated before any retrieval/LLM work happens.
        if not self._rate_limiter.check(
            db=self.db,
            rate_key=self._rate_limiter.ip_key(ip_hash),
            limit=settings.PUBLIC_ASSISTANT_RATE_LIMIT_PER_WINDOW,
            window_seconds=settings.PUBLIC_ASSISTANT_RATE_WINDOW_SECONDS,
        ):
            raise HTTPException(
                status_code=429,
                detail="You're sending messages a bit fast. Please wait a moment and try again.",
            )

        # 2. Sanitize + hard-refuse prompt-injection attempts.
        cleaned, violations = self._guardrail.sanitize_input(message)
        if violations and any("injection" in v for v in violations):
            logger.warning("public prompt-injection blocked on session %s: %s", session_uid, violations)
            return self._canned_reply(sess, message=_INJECTION_REFUSAL, intent_id=intent_id)

        # 3. Session-depth cap (server-enforced regardless of widget state).
        if (sess.message_count or 0) >= settings.PUBLIC_ASSISTANT_MAX_SESSION_MESSAGES:
            return self._canned_reply(sess, message=_SESSION_LIMIT_ANSWER, intent_id=intent_id)

        # 4. Account-specific request in public mode: never look up tenant data,
        #    explain the sign-in requirement instead. Handled BEFORE persistence
        #    so it also lands as a normal persisted turn.
        if self._needs_auth(cleaned):
            return self._finish(
                sess,
                answer=_REQUIRES_AUTH_ANSWER,
                mode="M0_EXPLAIN",
                evidence=[],
                requires_auth=True,
                safety_state="signin_required",
                user_text=cleaned,
                idempotency_key=idempotency_key,
                intent_id=intent_id,
            )

        # 5. Persist the user message.
        user_msg = PublicAssistantMessage(
            message_uid=str(uuid.uuid4()),
            session_id=sess.id,
            sender_type=SenderType.USER,
            message_text=cleaned[:2000],
            idempotency_key=(idempotency_key or None),
        )
        self.db.add(user_msg)
        self.db.flush()

        # 6. Chitchat (only when the message is essentially just the greeting).
        chitchat = self._match_chitchat(cleaned)
        if chitchat:
            return self._finish(
                sess, answer=chitchat, mode="M0_EXPLAIN", evidence=[], intent_id=intent_id
            )

        # 7. Retrieve — public-only scope, page-context boost from the widget.
        try:
            results, citations = self._retriever.retrieve_public(
                query=cleaned,
                top_k=5,
                boost_terms=self._page_boost(page),
            )
        except SQLAlchemyError:
            self.db.rollback()
            logger.exception("public retrieval failed; returning abstention")
            return self._finish(
                sess, answer=_ABSTAIN_ANSWER, mode="M0_EXPLAIN", evidence=[],
                safety_state="uncertain", intent_id=intent_id,
            )

        evidence = self._evidence_from(results)

        # 8. Confidence gate — never hallucinate a product answer.
        if not self._retriever.is_confident(results, threshold=0.5):
            return self._finish(
                sess, answer=_ABSTAIN_ANSWER, mode="M0_EXPLAIN", evidence=evidence,
                safety_state="uncertain", intent_id=intent_id,
            )

        # 9. Synthesize (LLM when available, deterministic rules-only otherwise).
        answer = self._synthesize(cleaned, results)
        if not answer:
            return self._finish(
                sess, answer=_ABSTAIN_ANSWER, mode="M0_EXPLAIN", evidence=evidence,
                safety_state="uncertain", intent_id=intent_id,
            )
        return self._finish(
            sess, answer=answer, mode="M0_EXPLAIN", evidence=evidence,
            safety_state="answered", intent_id=intent_id,
        )

    # ── Idempotency / account-data helpers ──────────────────────────────

    def _find_by_idempotency_key(
        self, sess: PublicAssistantSession, idempotency_key: str
    ) -> dict | None:
        """Return the previously-produced reply for a repeated user turn.

        A user message carrying the key is the anchor; the assistant turn is
        the next message in the session. Returns None when the key is new or
        the exchange never completed.
        """
        user_row = (
            self.db.query(PublicAssistantMessage)
            .filter(
                PublicAssistantMessage.session_id == sess.id,
                PublicAssistantMessage.idempotency_key == idempotency_key,
                PublicAssistantMessage.sender_type == SenderType.USER,
            )
            .order_by(PublicAssistantMessage.id.desc())
            .first()
        )
        if user_row is None:
            return None
        assistant_row = (
            self.db.query(PublicAssistantMessage)
            .filter(
                PublicAssistantMessage.session_id == sess.id,
                PublicAssistantMessage.sender_type == SenderType.ASSISTANT,
                PublicAssistantMessage.id > user_row.id,
            )
            .order_by(PublicAssistantMessage.id.asc())
            .first()
        )
        if assistant_row is None:
            return None
        return {
            "session_uid": sess.session_uid,
            "message_uid": assistant_row.message_uid,
            "answer": assistant_row.message_text,
            "mode": assistant_row.mode or "M0_EXPLAIN",
            "risk_class": "R0",
            "evidence": [],
            "suggested_prompts": [],
            "requires_auth": "sign in" in assistant_row.message_text.lower(),
            "safety_state": "answered",
            "created_at": assistant_row.created_at,
            "intent_id": None,
            "idempotent_replay": True,
        }

    @staticmethod
    def _needs_auth(text: str) -> bool:
        """True when the message asks for the visitor's own billing data.

        Only explicit instructional how-tos exempt. Imperatives + possessive+noun
        (e.g. "show my invoices", "view my balance") require sign-in.
        """
        if _ACCOUNT_OWE_RE.search(text):
            return True
        if not _ACCOUNT_NOUN_RE.search(text):
            return False
        return not _HOWTO_RE.match(text.strip())

    def _synthesize(self, query: str, results: list[RetrievalResult]) -> str:
        """LLM synthesis over retrieved snippets, with a rules-only fallback
        that answers verbatim from the single best chunk (fully deterministic —
        never silent, never fabricated)."""
        if self._gateway is not None:
            try:
                snippets = [r.chunk_text[:500] for r in results[:5]]
                system_prompt = PublicSystemPromptBuilder.build(snippets)
                resp = self._gateway.complete(
                    messages=[ModelMessage(role="user", content=query[:1000])],
                    system_prompt=system_prompt,
                    max_tokens=600,
                    temperature=0.2,
                )
                answer = (resp.content or "").strip()
                if answer and len(answer) >= 3:
                    return answer
            except (ModelGatewayError, Exception) as exc:  # noqa: BLE001
                logger.warning("public LLM synthesis failed; rules-only fallback: %s", exc)

        top = results[0]
        short = re.sub(r"\s+", " ", top.chunk_text).strip()
        if len(short) > 420:
            short = short[:420].rsplit(" ", 1)[0] + "…"
        return short

    # ── Helpers ─────────────────────────────────────────────────────────

    def _finished_message_dict(self) -> dict:
        return {
            "session_uid": "",
            "message_uid": "",
            "answer": "",
            "mode": "M0_EXPLAIN",
            "risk_class": "R0",
            "evidence": [],
            "suggested_prompts": [],
            "created_at": None,
            "intent_id": None,
        }

    def _canned_reply(
        self,
        sess: PublicAssistantSession,
        *,
        message: str,
        intent_id: str | None = None,
    ) -> dict:
        """A canned, stored reply with no retrieval/LLM — used for chitchat,
        injection refusal, and session-limit responses."""
        return self._finish(
            sess, answer=message, mode="M0_EXPLAIN", evidence=[], intent_id=intent_id
        )

    def _finish(
        self,
        sess: PublicAssistantSession,
        *,
        answer: str,
        mode: str,
        evidence: list,
        requires_auth: bool = False,
        safety_state: str = "answered",
        user_text: str | None = None,
        idempotency_key: str | None = None,
        intent_id: str | None = None,
    ) -> dict:
        """Persist the assistant turn and return the widget response dict.

        When ``user_text`` is supplied the user turn is persisted here too
        (used by branches that decide before the normal user-message write,
        such as the sign-in-required path) so every exchange is durable.
        """
        increments = 0
        if user_text is not None:
            self.db.add(
                PublicAssistantMessage(
                    message_uid=str(uuid.uuid4()),
                    session_id=sess.id,
                    sender_type=SenderType.USER,
                    message_text=user_text[:2000],
                    idempotency_key=(idempotency_key or None),
                )
            )

        assistant_msg = PublicAssistantMessage(
            message_uid=str(uuid.uuid4()),
            session_id=sess.id,
            sender_type=SenderType.ASSISTANT,
            message_text=answer[:4000],
            mode=mode,
            risk_class=RiskClass("R0"),
        )
        self.db.add(assistant_msg)
        # Each reply represents one logical exchange (user + assistant), so the
        # depth counter advances by two regardless of which rows were written.
        increments = 2
        sess.message_count = (sess.message_count or 0) + increments
        try:
            self.db.commit()
        except IntegrityError:
            # A truly concurrent duplicate (same session + idempotency_key)
            # that outran the application-level lookup at send time is stopped
            # by the DB unique constraint. Roll back and replay the ORIGINAL
            # exchange instead of surfacing a 5xx or writing twin rows.
            self.db.rollback()
            if idempotency_key:
                replay = self._find_by_idempotency_key(sess, idempotency_key)
                if replay is not None:
                    return replay
            raise
        self.db.refresh(assistant_msg)
        return {
            "session_uid": sess.session_uid,
            "message_uid": assistant_msg.message_uid,
            "answer": assistant_msg.message_text,
            "mode": assistant_msg.mode or mode,
            "risk_class": "R0",
            "evidence": evidence,
            "suggested_prompts": [],
            "requires_auth": requires_auth,
            "safety_state": safety_state,
            "created_at": assistant_msg.created_at,
            "intent_id": intent_id,
        }

    @staticmethod
    def _evidence_from(results: list[RetrievalResult]) -> list[dict]:
        ev = []
        for r in results[:3]:
            ev.append(
                ChatbotEvidence(
                    source=r.source_title,
                    resource_type=r.source_type,
                    reference=f"{r.namespace_code}:doc-{r.document_id}:chunk-{r.chunk_id}",
                    summary=r.chunk_text[:200],
                    fields={"rank": r.rank, "score": round(r.score, 3)},
                    # None surfaces as absent in the response when the KB source
                    # has no web URL, so the widget renders a plain pill and
                    # never a fabricated link. The allowlist check is a backend
                    # backstop that also drops unsafe schemes / unapproved hosts
                    # even if a misconfigured source_url ever carries one.
                    url=r.source_url if is_public_url_allowed(r.source_url) else None,
                ).model_dump()
            )
        return ev

    @staticmethod
    def _match_chitchat(text: str) -> str | None:
        """Return a canned chitchat answer, or None if the message carries a
        real request past the greeting (those still get answered)."""
        stripped = text.strip().lower()
        for regex, answer in (
            (_FAREWELL_RE, _FAREWELL_ANSWER),
            (_GRATITUDE_RE, _GRATITUDE_ANSWER),
            (_GREETING_RE, _GREETING_ANSWER),
        ):
            m = regex.match(stripped)
            if m:
                remainder = stripped[m.end():].strip(" .,!?")
                if not remainder or len(remainder) < 3:
                    return answer
        return None

    @staticmethod
    def _page_boost(page: str | None) -> list[str]:
        """Derive retrieval boost terms from the current marketing page slug
        (e.g. '/pricing' -> ['pricing'])."""
        if not page:
            return []
        segs = [
            s
            for s in re.split(r"[^a-z0-9]+", page.lower())
            if s and s not in _PAGE_BOOST_STOPWORDS
        ]
        return segs[:6]

    # ── Human support request ───────────────────────────────────────────

    def create_support_request(
        self,
        *,
        issue_type: str,
        email: str,
        summary: str,
        message: str | None,
        transcript_consent: bool,
        session_uid: str | None,
        ip_hash: str | None,
        client_request_id: str | None = None,
    ) -> dict:
        """Persist a support request and (when configured) forward it.

        The transcript excerpt is attached ONLY when the visitor explicitly
        consented AND the deployment requires consent. Delivery to a support
        desk is reported true only when a configured webhook acknowledged the
        request; otherwise the request is truthfully reported as received.

        Idempotency: a repeated submit carrying the same client_request_id
        (the widget reuses one key for the lifetime of the support form) is
        answered with the ORIGINAL reference before any new row is written, so
        a retry after a lost response can never create a duplicate request.
        """
        if not settings.PUBLIC_ASSISTANT_ENABLED:
            raise HTTPException(status_code=503, detail="The public assistant is temporarily paused.")

        if issue_type not in SUPPORT_ISSUE_TYPES:
            raise HTTPException(status_code=422, detail="Unsupported issue type.")

        # Idempotency runs BEFORE the rate budget so a legitimate retry after a
        # lost response returns the original reference instead of being eaten
        # by the limiter or creating a duplicate row.
        if client_request_id:
            existing = (
                self.db.query(PublicSupportRequest)
                .filter(PublicSupportRequest.client_request_id == client_request_id)
                .first()
            )
            if existing is not None:
                return {
                    "reference": existing.reference,
                    "status": existing.status,
                    "message": (
                        "Thanks — your support request has already been received. "
                        "Keep this reference for your records."
                    ),
                    "transcript_shared": bool(existing.transcript_excerpt),
                    "delivered_to_desk": existing.status == "dispatched",
                }

        # Rate-limit support submissions on the same per-IP budget as messages.
        if not self._rate_limiter.check(
            db=self.db,
            rate_key=self._rate_limiter.ip_key(ip_hash),
            limit=settings.PUBLIC_ASSISTANT_RATE_LIMIT_PER_WINDOW,
            window_seconds=settings.PUBLIC_ASSISTANT_RATE_WINDOW_SECONDS,
        ):
            raise HTTPException(
                status_code=429,
                detail="You're sending messages a bit fast. Please wait a moment and try again.",
            )

        excerpt: str | None = None
        if transcript_consent and session_uid:
            # The excerpt is bound to the caller: a visitor's own conversation
            # is only attached when the session belongs to them.
            excerpt = self._transcript_excerpt(session_uid, ip_hash)

        reference = f"SUP-{uuid.uuid4().hex[:8].upper()}"
        row = PublicSupportRequest(
            reference=reference,
            session_uid=session_uid,
            issue_type=issue_type,
            email=str(email)[:320],
            summary=summary[:500],
            message=(message or None),
            transcript_consent=bool(transcript_consent),
            transcript_excerpt=excerpt,
            status="received",
            ip_hash=ip_hash,
            client_request_id=client_request_id,
        )
        self.db.add(row)
        # Durable first: persist the request before any network call so it
        # survives a dispatch failure or a process death mid-forward. This also
        # keeps the transaction free of slow network I/O, and means a retry with
        # the same client_request_id is caught by the dedupe above instead of
        # forwarding a second copy to the support desk.
        try:
            self.db.commit()
        except IntegrityError:
            # A concurrent retry won the unique(client_request_id) race; return
            # the winner rather than erroring or double-dispatching.
            self.db.rollback()
            existing = (
                self.db.query(PublicSupportRequest)
                .filter(PublicSupportRequest.client_request_id == client_request_id)
                .first()
                if client_request_id
                else None
            )
            if existing is None:
                raise
            return {
                "reference": existing.reference,
                "status": existing.status,
                "message": (
                    "Thanks — your support request has already been received. "
                    "Keep this reference for your records."
                ),
                "transcript_shared": bool(existing.transcript_excerpt),
                "delivered_to_desk": existing.status == "dispatched",
            }
        # Reload server-populated defaults (id, created_at) for the payload.
        self.db.refresh(row)

        delivered = self._dispatch_support_webhook(row)
        if delivered:
            row.status = "dispatched"
            self.db.commit()

        return {
            "reference": reference,
            "status": row.status,
            "message": (
                "Thanks — your support request has been received. "
                "Keep this reference for your records."
            ),
            "transcript_shared": bool(excerpt),
            "delivered_to_desk": delivered,
        }

    def _transcript_excerpt(self, session_uid: str, ip_hash: str | None = None, max_turns: int = 10) -> str | None:
        """Last N turns of the visitor's own session, for consented sharing.

        Ownership-bound: when the session carries an ip_hash and it differs
        from the caller's, no excerpt is returned — a request from another
        visitor never reads through to someone else's anonymous conversation.
        """
        sess = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.session_uid == session_uid)
            .first()
        )
        if sess is None:
            return None
        if ip_hash and sess.ip_hash and sess.ip_hash != ip_hash:
            return None
        rows = (
            self.db.query(PublicAssistantMessage)
            .filter(PublicAssistantMessage.session_id == sess.id)
            .order_by(PublicAssistantMessage.id.desc())
            .limit(max_turns)
            .all()
        )
        if not rows:
            return None
        lines = []
        for m in reversed(rows):
            sender = "Visitor" if m.sender_type == SenderType.USER else "Assistant"
            text = self._guardrail.redact_sensitive(re.sub(r"\s+", " ", m.message_text or "").strip())
            lines.append(f"{sender}: {text[:500]}")
        return "\n".join(lines)[:4000]

    def _dispatch_support_webhook(self, row: PublicSupportRequest) -> bool:
        """Best-effort forward to the configured support desk. Never raises.

        Returns False (not delivered) when no webhook is configured or it
        fails, so the visitor is never told a human has been reached.
        """
        webhook_url = (settings.AI_PUBLIC_SUPPORT_WEBHOOK_URL or "").strip()
        if not webhook_url:
            return False
        payload = {
            "event": "chatbot.public_support_requested",
            "reference": row.reference,
            "issue_type": row.issue_type,
            "email": row.email,
            "summary": row.summary,
            "message": row.message,
            "transcript_shared": bool(row.transcript_excerpt),
            "transcript_excerpt": row.transcript_excerpt,
            "session_uid": row.session_uid,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        try:
            request = urllib.request.Request(
                webhook_url,
                data=json.dumps(payload, default=str).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "zoiko-billing-assistant/public-support",
                },
                method="POST",
            )
            with urllib.request.urlopen(
                request, timeout=settings.AI_PUBLIC_SUPPORT_WEBHOOK_TIMEOUT_SECONDS
            ) as response:
                return 200 <= int(response.status) < 300
        except Exception as exc:  # noqa: BLE001 — dispatch must never break the request
            logger.warning("public support webhook delivery failed for %s: %s", row.reference, exc)
            return False

    # ── Feedback ────────────────────────────────────────────────────────

    def record_feedback(
        self,
        *,
        session_uid: str | None,
        message_uid: str | None,
        helpful: bool,
        reason: str | None = None,
    ) -> dict:
        """Store an optional, privacy-minimal helpful/not-helpful signal."""
        clean_reason = None
        if reason:
            clean_reason = self._guardrail.redact_sensitive(reason.strip())[:500]
        self.db.add(
            PublicAssistantFeedback(
                session_uid=session_uid,
                message_uid=message_uid,
                helpful=bool(helpful),
                reason=clean_reason,
            )
        )
        self.db.commit()
        return {"status": "recorded"}

    # ── Instrumentation (spec §12.3) ────────────────────────────────────

    @staticmethod
    def _safe_meta(value: str | None, limit: int = 64) -> str | None:
        """Bound a telemetry field to short, log-safe characters.

        Telemetry metadata is always a short id/token (session uid, topic id,
        locale, config version, timing bucket) — never free text. Anything with
        whitespace or over-long content is dropped rather than logged.
        """
        if not value:
            return None
        token = value.strip()
        if not token or len(token) > limit or any(c.isspace() for c in token):
            return None
        return token

    def record_event(
        self,
        *,
        event: str,
        session_uid: str | None = None,
        topic_id: str | None = None,
        locale: str | None = None,
        config_version: str | None = None,
        timing_bucket: str | None = None,
    ) -> dict:
        """Record one privacy-minimized widget event (spec §12.3).

        Only allowlisted event names are logged, and only the §12.3 safe
        metadata — never the visitor's question text or any free-form value.
        Unknown events are ignored (a client typo must never widen telemetry or
        surface an error to a public visitor).
        """
        if event not in _PUBLIC_EVENT_ALLOWLIST:
            logger.warning("public event ignored (not allowlisted): %r", event[:64])
            return {"status": "recorded"}
        logger.info(
            "public_event name=%s session=%s topic=%s locale=%s config=%s timing=%s",
            event,
            self._safe_meta(session_uid),
            self._safe_meta(topic_id),
            self._safe_meta(locale, limit=16),
            self._safe_meta(config_version, limit=40),
            self._safe_meta(timing_bucket, limit=16),
        )
        return {"status": "recorded"}