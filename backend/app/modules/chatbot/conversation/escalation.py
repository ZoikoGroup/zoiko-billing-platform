"""chatbot/conversation/escalation.py
------------------------------------
Stateful human-handoff (EscalateR0) flow.

QA Gap Analysis — defect 1 (P0, "Dead-End Escalation Loop"):

    The router offers "Would you like me to connect you to a team member?"
    but nothing remembers that the offer was made, so the very next turn
    ("yes connect", "connect me", "I want to speak to someone") is classified
    from scratch and lands in the out-of-scope blocklist — the user is
    refused at the exact moment they asked for a human.

This module supplies the three things the old flow was missing:

1. ``offer_state()``   — an explicit, expiring ``ESCALATION_PENDING_CONFIRMATION``
                         marker that rides on the assistant message that made
                         the offer (the same persisted-payload convention the
                         clarification state already uses).
2. ``classify_escalation_reply()`` — decides whether the NEXT message is an
                         affirmation, a decline, or neither — and therefore
                         must be answered before (not after) the normal
                         intent router ever sees it.
3. ``EscalationService`` — durably records the handoff with the conversation
                         snapshot attached and best-effort dispatches it to
                         the configured support webhook, reporting the channel
                         truthfully when no webhook is configured or it fails.

State never traps the conversation: the marker expires after
``ESCALATION_TTL_SECONDS`` and is consumed by the first message that follows
the offer whatever that message turns out to be.
"""

from __future__ import annotations

import enum
import json
import logging
import re
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Payload key written into AIConversationMessage.structured_payload — the same
# convention as the existing "clarify" key.
ESCALATION_PAYLOAD_KEY = "escalation"

STATUS_OFFERED = "offered"
STATUS_DISPATCHED = "dispatched"
STATUS_DECLINED = "declined"

# An offer is a live invitation, not a permanent latch. After this long the
# next message is classified normally again even if nobody ever answered.
ESCALATION_TTL_SECONDS = 15 * 60

# Turns of conversation history handed to the human so the user never has to
# repeat the issue they escalated.
SNAPSHOT_MAX_TURNS = 20


# ── Reply classification ────────────────────────────────────────────────────
# Order matters. An explicit "connect / speak to / talk to a human" phrase is
# an escalation request even inside a larger message ("no thanks, but connect
# me to someone"). A bare affirmation ("yes", "sure") only counts when the
# message says nothing else — otherwise "yes my invoice is wrong" would be
# read as a handoff request instead of the billing question it is.

_ESCALATION_PHRASES = re.compile(
    r"\b(?:"
    r"connect\s*(?:me|us)?(?:\s+(?:to|with|into))?"
    r"|speak\s+to\s+(?:a|an|the|some)?\s*(?:one|body|human|person|agent|representative|team)"
    r"|speak\s+with\s+(?:a|an|the|some)?\s*(?:one|body|human|person|agent|representative|team)"
    r"|talk\s+to\s+(?:a|an|the|some)?\s*(?:one|body|human|person|agent|representative|team|member)"
    r"|talk\s+with\s+(?:a|an|the|some)?\s*(?:one|body|human|person|agent|representative|team)"
    r"|get\s+(?:me|us)\s+(?:a|an|the)\s*(?:human|agent|representative|person|team\s+member)"
    r"|i\s+want\s+to\s+(?:speak|talk|chat)"
    r"|put\s+(?:me|us)\s+through"
    r"(?:\s+(?:to|with))?\s+(?:a|an|the)?\s*(?:human|agent|representative|team\s+member)"
    r"|human\s+(?:support|agent|representative|help|being)"
    r"|real\s+(?:person|human|agent)"
    r"|team\s+member"
    r"|support\s+agent|speak\s+to\s+support|talk\s+to\s+support"
    r"|\bcustomer\s+support\b"
    r"|(?:i|we)\s+(?:want|need|would\s+like|'d\s+like|'d|’d\s+like)"
    r"(?:\s+to)?(?:\s+(?:speak|talk|chat|connect|ask|get|referred\s+to))?"
    r"(?:\s+(?:to|with|from))?(?:\s+(?:a|an|the|one))?\s*"
    r"(?:human|agent|representative|person|team\s+member|someone|human\s+being)"
    r")\b",
    re.IGNORECASE,
)

_DECLINE_PHRASES = re.compile(
    r"^(?:no|nope|nah|n)\b[\s!.,'\u2019-]*"
    r"(?:"
    r"thanks|thank\s+you|thanks\s+lots|thanks\s+anyway|appreciate(?:\s+it)?"
    r"|i('| i)?\s*(?:m|am)\s+fine|all\s+good|nothing\s+(?:else)?|not\s+(?:right\s+)?now"
    r"|later|maybe\s+later|some\s+other\s+time|i('| i)?\s*(?:ll|will)\s+(?:do|pass)"
    r")?"
    r"(?:[\s!.,'\u2019-]*(?:fine|ok(?:ay)?|good))*"
    r"[\s!.,'\u2019-]*$",
    re.IGNORECASE,
)

# Standalone declines that do not start with "no".
_DECLINE_CORE = re.compile(
    r"^(?:"
    r"not\s+(?:right\s+)?now|maybe\s+later|later|some\s+other\s+time"
    r"|i(?:'|’)?m\s+fine|i\s+am\s+fine|i(?:'|’)?m\s+ok(?:ay)?|i\s+am\s+ok(?:ay)?|all\s+good|i(?:'|’)?\s*(?:ll|will)\s+pass"
    r"|no\s+need|don'?t\s+(?:need|want)|leave\s+it|stop|cancel"
    r"|i(?:'|’)?ll\s+stick\s+(?:to\s+)?(?:the\s+)?(?:chat|assistant|bot)"
    r"|i(?:'|’)?\s*(?:ll|will)\s+(?:stay|keep)\s+it?\s+(?:in\s+)?(?:the\s+)?(?:chat|assistant|bot)"
    r")[\s!.,'\u2019]*"
    r"(?:thanks|thank\s+you|appreciate(?:\s+it)?|cheers)?"
    r"[\s!.,'\u2019]*$",
    re.IGNORECASE,
)

_BARE_AFFIRM = re.compile(
    r"^(?:"
    r"y(?:es|eah|y|ep|up|up)?"
    r"|sure|okay|ok|fine|absolutely|definitely|certainly|of\s+course"
    r"|please\s+do|do\s+it|go\s+ahead|go\s+on|yep|yup|y|affirmative"
    r"|yeah|aye"
    r"|(?:yes|sure|please|yep|yeah)[\s,!.,]+(?:do\s+it|please|connect|sure)"
    r")\b[\s!.,'\u2019?]*$",
    re.IGNORECASE,
)


# ── Direct handoff requests (no offer pending) ──────────────────────────────
# The state machine above only answers a handoff AFTER an offer was made.
# But a user may OPEN with "connect me to a team member?" — no offer exists,
# so the accept path never runs and the message falls through to the
# out-of-scope refusal: the very dead end the QA gap analysis flagged (P0).
#
# Such a message must never be refused, and it must never dispatch either
# (nothing has been confirmed yet). The engine answers it with the EscalateR0
# OFFER instead, so the next "yes" / "connect" is handled by the stateful
# accept path above.
#
# Deciding it is a handoff request means deciding the person is the WHOLE
# point of the message: after removing the matched escalation span, only
# vocabulary from this list (politeness, the person asked for, connectives)
# may remain — or a reason clause ("… about my car insurance"). That keeps
# "connect my bank account" a billing question instead of a handoff.

_HANDOFF_VOCAB = frozenset({
    # politeness / framing
    "please", "thanks", "thank", "you", "now", "asap", "today", "hi", "hello",
    "hey", "yes", "yeah", "sure", "ok", "okay", "no", "not", "but", "however",
    "actually", "also", "just", "anyway", "still", "either", "really",
    "can", "could", "would", "i", "we", "my", "our", "your", "me", "us",
    "to", "with", "into", "through", "of", "for", "a", "an", "the", "some",
    "and", "or",
    # the ask itself
    "connect", "speak", "talk", "chat", "get", "put", "want", "need", "like",
    "be", "referred", "escalate", "transfer", "hand", "pass", "over",
    # person references
    "one", "body", "someone", "somebody", "anybody", "human", "being",
    "person", "persons", "people", "agent", "agents", "representative",
    "representatives", "team", "member", "members", "real", "support", "desk",
    "staff", "specialist", "advisor", "consultant", "billing",
})

# What may follow a handoff request when the rest of the message is NOT
# vocabulary: the reason the user wants a human.
_HANDOFF_REASON_RE = re.compile(
    r"^(?:about|regarding|concerning|because|due\s+to|re|issue\s+with"
    r"|problem\s+with|help\s+with|an?\s+issue)\b",
    re.IGNORECASE,
)


def is_direct_handoff_request(text: str) -> bool:
    """True when the message only asks to be put through to a person.

    Conservative on purpose: the leftover around the handoff phrase must be
    pure handoff vocabulary or a reason clause, so an object that merely
    follows a verb ("connect my bank account") stays a billing question.
    """
    raw = (text or "").strip()
    if not raw:
        return False
    span = _ESCALATION_PHRASES.search(raw)
    if not span:
        return False
    leftover = f"{raw[:span.start()]} {raw[span.end():]}"
    tokens = [t for t in (tok.strip("'’\u2019") for tok in re.findall(r"[A-Za-z'\u2019]+", leftover)) if t]
    while tokens and tokens[0].lower() in _HANDOFF_VOCAB:
        tokens.pop(0)
    if not tokens:
        return True
    return bool(_HANDOFF_REASON_RE.match(" ".join(tokens)))


class EscalationReply(str, enum.Enum):
    AFFIRM = "affirm"
    DECLINE = "decline"
    UNRELATED = "unrelated"   # nothing to do with the offer — route normally


def classify_escalation_reply(text: str) -> EscalationReply:
    """Decide what the user's reply to a human-handoff offer means.

    Deliberately conservative: only returns AFFIRM when the message actually
    asks for a person or is nothing but agreement, so a billing question that
    happens to contain the word "yes" is never swallowed by the handoff flow.
    """
    raw = (text or "").strip()
    if not raw:
        return EscalationReply.UNRELATED
    normalized = raw.lower().strip()

    if _ESCALATION_PHRASES.search(normalized):
        return EscalationReply.AFFIRM
    if _DECLINE_PHRASES.match(normalized) or _DECLINE_CORE.match(normalized):
        return EscalationReply.DECLINE
    if _BARE_AFFIRM.match(normalized):
        return EscalationReply.AFFIRM
    return EscalationReply.UNRELATED


# ── Offer state ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EscalationState:
    status: str
    offered_at: float
    reason: str | None = None
    escalation_uid: str | None = None

    @property
    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.offered_at)

    @property
    def expired(self) -> bool:
        return self.age_seconds > ESCALATION_TTL_SECONDS


def offer_state(*, reason: str | None = None) -> dict:
    """Marker to embed in the assistant message that made the offer."""
    return {
        "status": STATUS_OFFERED,
        "offered_at": time.time(),
        "reason": reason,
    }


def read_state(structured_payload: dict | None) -> EscalationState | None:
    """Return the pending escalation state from an assistant payload, or None.

    Returns None for a missing key, an already-consumed status (dispatched /
    declined — i.e. the offer was answered on a previous turn) and a marker
    older than the TTL. That is what guarantees the conversation can never be
    latched into escalation mode.
    """
    if not structured_payload:
        return None
    raw = structured_payload.get(ESCALATION_PAYLOAD_KEY)
    if not isinstance(raw, dict):
        return None
    if raw.get("status") != STATUS_OFFERED:
        return None
    offered_at = raw.get("offered_at")
    if not isinstance(offered_at, (int, float)):
        return None
    state = EscalationState(
        status=STATUS_OFFERED,
        offered_at=float(offered_at),
        reason=raw.get("reason"),
        escalation_uid=raw.get("escalation_uid"),
    )
    if state.expired:
        return None
    return state


# ── Dispatch ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EscalationDispatchResult:
    reference: str
    escalation_uid: str
    channel: str          # "webhook" | "queue"
    delivered: bool
    detail: str


class EscalationService:
    """Records the handoff and, when configured, posts it to a support webhook.

    Failure is never fatal and never silent: the request row is committed
    first (so support can find it), the webhook is then attempted
    best-effort, and whatever happened is reported back so the answer the
    user sees does not over-promise.
    """

    def __init__(self, db, webhook_url: str | None = None, timeout_seconds: float = 5.0):
        self.db = db
        self.webhook_url = (webhook_url or "").strip() or None
        self.timeout_seconds = timeout_seconds

    # -- public ---------------------------------------------------------

    def dispatch(
        self,
        *,
        conversation,
        ctx,
        trigger_text: str,
        confirmation_text: str,
        reason: str | None = None,
        history: list[dict] | None = None,
    ) -> EscalationDispatchResult:
        from ..models import AIEscalationRequest, EscalationRequestStatus
        from .engine import _uid  # local import: avoids a cycle at module load

        escalation_uid = _uid()
        reference = _make_reference()
        row = AIEscalationRequest(
            escalation_uid=escalation_uid,
            reference=reference,
            conversation_id=conversation.id,
            tenant_context_id=conversation.tenant_context_id,
            organization_id=conversation.organization_id,
            user_id=conversation.user_id,
            reason=reason,
            trigger_text=trigger_text or "",
            confirmation_text=confirmation_text or "",
            conversation_snapshot={"turns": (history or [])[:SNAPSHOT_MAX_TURNS]},
            dispatch_status=EscalationRequestStatus.QUEUED,
        )
        self.db.add(row)
        self.db.flush()

        if not self.webhook_url:
            self.db.flush()
            return EscalationDispatchResult(
                reference=reference,
                escalation_uid=escalation_uid,
                channel="queue",
                delivered=False,
                detail="recorded for the support team",
            )

        status_code, error = self._post_webhook(row, ctx)
        if status_code and 200 <= status_code < 300:
            row.dispatch_status = EscalationRequestStatus.DISPATCHED
            row.dispatch_channel = "webhook"
            row.webhook_status_code = status_code
            row.dispatched_at = _utcnow()
            self.db.flush()
            return EscalationDispatchResult(
                reference=reference,
                escalation_uid=escalation_uid,
                channel="webhook",
                delivered=True,
                detail="sent to the support desk",
            )

        row.dispatch_status = EscalationRequestStatus.FAILED
        row.dispatch_channel = "webhook"
        row.webhook_status_code = status_code
        row.dispatch_error = (error or "webhook delivery failed")[:2000]
        self.db.flush()
        logger.warning(
            "[ESCALATION] webhook dispatch failed for %s: status=%s error=%s",
            reference, status_code, error,
        )
        return EscalationDispatchResult(
            reference=reference,
            escalation_uid=escalation_uid,
            channel="queue",
            delivered=False,
            detail="recorded for the support team",
        )

    # -- internals ------------------------------------------------------

    def _post_webhook(self, row, ctx) -> tuple[int | None, str | None]:
        payload = {
            "event": "chatbot.escalation_requested",
            "escalation_uid": row.escalation_uid,
            "reference": row.reference,
            "organization_id": row.organization_id,
            "tenant_context_id": row.tenant_context_id,
            "user_id": row.user_id,
            "role": getattr(ctx, "role", ""),
            "reason": row.reason,
            "trigger_text": row.trigger_text,
            "confirmation_text": row.confirmation_text,
            "conversation_uid": row.conversation.conversation_uid if row.conversation else None,
            "conversation_context": (row.conversation_snapshot or {}).get("turns", []),
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        try:
            request = urllib.request.Request(
                self.webhook_url,
                data=json.dumps(payload, default=str).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "zoiko-billing-assistant/escalation",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return int(response.status), None
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read(500).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 - reading the body is best effort
                body = ""
            return int(exc.code), f"HTTP {exc.code}: {body}"
        except Exception as exc:  # noqa: BLE001 - dispatch must never raise
            return None, f"{type(exc).__name__}: {exc}"


def _make_reference() -> str:
    return f"ESC-{uuid.uuid4().hex[:8].upper()}"


def _utcnow():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)


# ── Conversation history snapshot ───────────────────────────────────────────


def build_snapshot(history_rows: list) -> list[dict]:
    """Turn rows → the plain list handed to the human picking up the case."""
    turns: list[dict] = []
    for row in history_rows:
        turns.append({
            "sender": str(getattr(row, "sender_type", "")).lower(),
            "text": row.message_text or "",
        })
    return turns[-SNAPSHOT_MAX_TURNS:]
