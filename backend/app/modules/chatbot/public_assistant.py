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

import logging
import re
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings

from .context.ai_context import AIContext
from .knowledge.retrieval import KnowledgeRetriever, RetrievalResult
from .guardrails.guardrails import GuardrailEngine, PublicSystemPromptBuilder
from .model_gateway.base import ModelGateway, ModelGatewayError, ModelMessage
from .models import (
    PublicAssistantMessage,
    PublicAssistantSession,
    RiskClass,
    SenderType,
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
_ABSTAIN_ANSWER = (
    "I don't have a confirmed answer for that yet. To learn more, explore "
    "zoikobilling.com or book a demo and the Zoiko team will help you directly."
)
_SESSION_LIMIT_ANSWER = (
    "We've covered a lot in this conversation. If you have more questions, "
    "open the assistant again or book a demo on zoikobilling.com."
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
        after a page reload; if the session already exists and is active we
        return it with its recent history instead of erroring.
        """
        sid = (session_uid or "").strip() or str(uuid.uuid4())
        existing = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.session_uid == sid)
            .first()
        )
        if existing is not None:
            if existing.status != "active":
                raise HTTPException(status_code=409, detail="Session already exists but is no longer active.")
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

    def _get_session(self, session_uid: str) -> PublicAssistantSession:
        sess = (
            self.db.query(PublicAssistantSession)
            .filter(PublicAssistantSession.session_uid == session_uid)
            .first()
        )
        if sess is None or sess.status != "active":
            raise HTTPException(status_code=404, detail="Session not found or no longer active.")
        return sess

    # ── Messages ────────────────────────────────────────────────────────

    def send_message(
        self,
        *,
        session_uid: str,
        message: str,
        ip_hash: str | None,
        page: str | None = None,
    ) -> dict:
        """Process a public visitor message and return a governed reply dict."""
        if not settings.PUBLIC_ASSISTANT_ENABLED:
            raise HTTPException(status_code=503, detail="The public assistant is temporarily paused.")

        # 1. Rate limit FIRST — the expensive/abusable part of an auth-free
        #    endpoint must be gated before any session/RAG work happens.
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

        sess = self._get_session(session_uid)

        # 2. Sanitize + hard-refuse prompt-injection attempts.
        cleaned, violations = self._guardrail.sanitize_input(message)
        if violations and any("injection" in v for v in violations):
            logger.warning("public prompt-injection blocked on session %s: %s", session_uid, violations)
            return self._canned_reply(sess, message=_INJECTION_REFUSAL)

        # 3. Session-depth cap (server-enforced regardless of widget state).
        if (sess.message_count or 0) >= settings.PUBLIC_ASSISTANT_MAX_SESSION_MESSAGES:
            return self._canned_reply(sess, message=_SESSION_LIMIT_ANSWER)

        # 4. Persist the user message.
        user_msg = PublicAssistantMessage(
            message_uid=str(uuid.uuid4()),
            session_id=sess.id,
            sender_type=SenderType.USER,
            message_text=cleaned[:2000],
        )
        self.db.add(user_msg)
        self.db.flush()

        # 5. Chitchat (only when the message is essentially just the greeting).
        chitchat = self._match_chitchat(cleaned)
        if chitchat:
            return self._finish(sess, answer=chitchat, mode="M0_EXPLAIN", evidence=[])

        # 6. Retrieve — public-only scope, page-context boost from the widget.
        try:
            results, citations = self._retriever.retrieve_public(
                query=cleaned,
                top_k=5,
                boost_terms=self._page_boost(page),
            )
        except SQLAlchemyError:
            self.db.rollback()
            logger.exception("public retrieval failed; returning abstention")
            return self._finish(sess, answer=_ABSTAIN_ANSWER, mode="M0_EXPLAIN", evidence=[])

        evidence = self._evidence_from(results)

        # 7. Confidence gate — never hallucinate a product answer.
        if not self._retriever.is_confident(results, threshold=0.5):
            return self._finish(sess, answer=_ABSTAIN_ANSWER, mode="M0_EXPLAIN", evidence=evidence)

        # 8. Synthesize (LLM when available, deterministic rules-only otherwise).
        answer = self._synthesize(cleaned, results)
        return self._finish(sess, answer=answer or _ABSTAIN_ANSWER, mode="M0_EXPLAIN", evidence=evidence)

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
        }

    def _canned_reply(self, sess: PublicAssistantSession, *, message: str) -> dict:
        """A canned, stored reply with no retrieval/LLM — used for chitchat,
        injection refusal, and session-limit responses."""
        return self._finish(sess, answer=message, mode="M0_EXPLAIN", evidence=[])

    def _finish(self, sess: PublicAssistantSession, *, answer: str, mode: str, evidence: list) -> dict:
        """Persist the assistant turn and return the widget response dict."""
        assistant_msg = PublicAssistantMessage(
            message_uid=str(uuid.uuid4()),
            session_id=sess.id,
            sender_type=SenderType.ASSISTANT,
            message_text=answer[:4000],
            mode=mode,
            risk_class=RiskClass("R0"),
        )
        self.db.add(assistant_msg)
        sess.message_count = (sess.message_count or 0) + 2
        self.db.commit()
        self.db.refresh(assistant_msg)
        return {
            "session_uid": sess.session_uid,
            "message_uid": assistant_msg.message_uid,
            "answer": assistant_msg.message_text,
            "mode": assistant_msg.mode or mode,
            "risk_class": "R0",
            "evidence": evidence,
            "suggested_prompts": [],
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