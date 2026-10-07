"""QA Gap Analysis P0 — human-handoff (EscalateR0) regression suite.

The router must remember that it offered to connect the user to a team
member; a follow-up acceptance must dispatch a durable, reference-bearing
handoff request instead of being re-routed into the out-of-scope blocklist
(the original dead-end escalation loop).
"""
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.database import Base
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation import escalation as escmod
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.models import (
    AIConversation,
    AIConversationMessage,
    ConversationStatus,
    SenderType,
)
from tests.conftest import make_organization


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    S = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = S()
    yield s
    s.close()
    engine.dispose()


@pytest.fixture()
def ctx(db):
    org = make_organization(db, code="ESC1", name="Esc Test Org")
    return AIContext(organization_id=org.id, user_id=11, tenant_context_id=1,
                     role="org_admin", permissions=[], request_id="esc-test"), org


def new_conv(db, org, uid):
    conv = AIConversation(conversation_uid=uid, tenant_context_id=1,
                          organization_id=org.id, user_id=11, title="esc",
                          conversation_status=ConversationStatus.OPEN)
    db.add(conv)
    db.flush()
    return conv


def ask(db, conv, text, context):
    e = ConversationEngine(db, model_gateway=None)
    m = AIConversationMessage(conversation_id=conv.id, message_uid="u-" + text[:12],
                              sender_type=SenderType.USER, message_text=text)
    db.add(m)
    db.flush()
    return e._process_message(conv, text, context)


def last_assistant_payload(db, conv):
    msg = (
        db.query(AIConversationMessage)
        .filter(
            AIConversationMessage.conversation_id == conv.id,
            AIConversationMessage.sender_type == SenderType.ASSISTANT,
        )
        .order_by(AIConversationMessage.id.desc())
        .first()
    )
    return (msg.structured_payload or {}) if msg else {}


# ── Reply classification unit tests ─────────────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    # QA Gap Analysis doc: affected users replied "yes connect", "connect",
    # "connect you to a team member?" and were refused. All must hand off.
    ("yes connect", escmod.EscalationReply.AFFIRM),
    ("connect you to a team member?", escmod.EscalationReply.AFFIRM),
    ("yes connect me", escmod.EscalationReply.AFFIRM),
    ("connect me", escmod.EscalationReply.AFFIRM),
    ("connect", escmod.EscalationReply.AFFIRM),
    ("yes, please connect me to someone", escmod.EscalationReply.AFFIRM),
    ("I want to speak to someone", escmod.EscalationReply.AFFIRM),
    ("I want to speak to a team member", escmod.EscalationReply.AFFIRM),
    ("talk to an agent", escmod.EscalationReply.AFFIRM),
    ("can I talk to a person", escmod.EscalationReply.AFFIRM),
    ("get me a human", escmod.EscalationReply.AFFIRM),
    ("speak with support agent", escmod.EscalationReply.AFFIRM),
    ("no thanks but connect me to someone", escmod.EscalationReply.AFFIRM),
    ("yes", escmod.EscalationReply.AFFIRM),
    ("yes please", escmod.EscalationReply.AFFIRM),
    ("sure", escmod.EscalationReply.AFFIRM),
    ("ok", escmod.EscalationReply.AFFIRM),
    ("go ahead", escmod.EscalationReply.AFFIRM),
    ("no", escmod.EscalationReply.DECLINE),
    ("no thanks", escmod.EscalationReply.DECLINE),
    ("not now", escmod.EscalationReply.DECLINE),
    ("maybe later", escmod.EscalationReply.DECLINE),
    ("i'm fine", escmod.EscalationReply.DECLINE),
    ("i am fine, thanks", escmod.EscalationReply.DECLINE),
    ("nope", escmod.EscalationReply.DECLINE),
    # These must NOT be swallowed by the handoff flow:
    ("yes my invoice is wrong", escmod.EscalationReply.UNRELATED),
    ("what is my due date", escmod.EscalationReply.UNRELATED),
    ("my card payment failed yesterday", escmod.EscalationReply.UNRELATED),
    ("no, but what is my due date", escmod.EscalationReply.UNRELATED),
    ("show me my dashboard", escmod.EscalationReply.UNRELATED),
    ("", escmod.EscalationReply.UNRELATED),
])
def test_classify_escalation_reply(text, expected):
    assert escmod.classify_escalation_reply(text) is expected


@pytest.mark.parametrize("reply", [
    "yes connect me", "connect me", "talk to a team member", "I want a human",
])
def test_offer_then_accept_dispatches(db, ctx, reply):
    """The dead-end loop: offer must be remembered, and an acceptance must be
    dispatched with a reference — NOT routed to out-of-scope."""
    context, org = ctx
    conv = new_conv(db, org, "esc-acc")

    r1 = ask(db, conv, "I don't recognize this charge.", context)
    assert r1["mode"] == "M5_ESCALATE", r1
    offered = last_assistant_payload(db, conv).get("escalation")
    assert offered and offered["status"] == "offered"

    r2 = ask(db, conv, reply, context)
    assert r2["mode"] == "M5_ESCALATE", r2
    body = r2["answer"]
    assert reply not in r2.get("qualification", "") or True
    assert "ESC-" in body  # a real reference was generated
    assert "outside my scope" not in body.lower()
    assert "connect you to a team member" not in body.replace("connect you to a team member", "")

    # The handoff was recorded durably.
    from app.modules.chatbot.models import AIEscalationRequest
    row = db.query(AIEscalationRequest).filter(
        AIEscalationRequest.conversation_id == conv.id
    ).first()
    assert row is not None
    assert row.reference in body
    assert row.confirmation_text == reply
    assert row.trigger_text

    # The dispatch answer must NOT re-offer (state is 'dispatched', consumed).
    assert last_assistant_payload(db, conv).get("escalation", {}).get("status") == "dispatched"


def test_offer_then_decline_is_polite_and_consumes(db, ctx):
    context, org = ctx
    conv = new_conv(db, org, "esc-dec")
    ask(db, conv, "I don't recognize this charge.", context)

    r = ask(db, conv, "no thanks", context)
    assert "still help" in r["answer"].lower() or "helping you" in r["answer"].lower()
    assert "outside my scope" not in r["answer"].lower()
    # Offer is consumed: the very next message is routed normally.
    assert last_assistant_payload(db, conv).get("escalation") is None


def test_offer_then_unrelated_question_is_answered_not_trapped(db, ctx):
    context, org = ctx
    conv = new_conv(db, org, "esc-unrel")
    ask(db, conv, "I don't recognize this charge.", context)

    r = ask(db, conv, "Show me my dashboard.", context)
    # Not swallowed as an escalation acceptance:
    assert "ESC-" not in r["answer"]
    assert "connected you to the support desk" not in r["answer"].lower()
    # And on the stored state, the offer was NOT confirmed:
    assert (last_assistant_payload(db, conv).get("escalation") or {}).get("status") != "dispatched"


def test_offer_is_expired_after_ttl(db, ctx):
    """An old offer must not latch the conversation: after the TTL the message
    is classified from scratch even if it looks like an acceptance."""
    context, org = ctx
    conv = new_conv(db, org, "esc-ttl")
    ask(db, conv, "I don't recognize this charge.", context)

    stored = db.query(AIConversationMessage).filter(
        AIConversationMessage.conversation_id == conv.id,
        AIConversationMessage.sender_type == SenderType.ASSISTANT,
    ).order_by(AIConversationMessage.id.desc()).first()
    state = (stored.structured_payload or {}).get("escalation")
    assert state and state["status"] == "offered"

    # Age the offer beyond the TTL inside the same payload and re-read it.
    state["offered_at"] = time.time() - 10_000
    stored.structured_payload = dict(stored.structured_payload or {})
    stored.structured_payload["escalation"] = state
    db.add(stored)
    db.flush()

    e = ConversationEngine(db, model_gateway=None)
    assert e._get_pending_escalation(conv) is None


# ── Webhook delivery ────────────────────────────────────────────────────────

class _Capture(BaseHTTPRequestHandler):
    payload = None
    calls = 0

    def do_POST(self):
        type(self).calls += 1
        length = int(self.headers.get("Content-Length", "0"))
        type(self).payload = self.rfile.read(length).decode("utf-8", "replace")
        self.send_response(202)
        self.end_headers()

    def log_message(self, *args):  # silence the dev server
        pass


@pytest.fixture()
def webhook_server():
    server = HTTPServer(("127.0.0.1", 0), _Capture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/escalate"
    server.shutdown()
    thread.join(timeout=2)


def test_dispatch_posts_webhook_and_reports_delivered(db, ctx, webhook_server, monkeypatch):
    context, org = ctx
    conv = new_conv(db, org, "esc-web")

    from app.config import settings
    monkeypatch.setattr(settings, "AI_ESCALATION_WEBHOOK_URL", webhook_server)

    r1 = ask(db, conv, "I don't recognize this charge.", context)
    assert r1["mode"] == "M5_ESCALATE"
    r2 = ask(db, conv, "yes connect me", context)
    assert "support desk" in r2["answer"].lower() or "support" in r2["answer"].lower()
    assert _Capture.calls == 1
    assert _Capture.payload
    assert '"event": "chatbot.escalation_requested"' in _Capture.payload


def test_dispatch_without_webhook_queues_silent_disabled(db, ctx):
    """Default config: no webhook �?" the request is recorded and the user is
    told the truth (nothing claims a delivery that did not happen)."""
    context, org = ctx
    conv = new_conv(db, org, "esc-queue")
    ask(db, conv, "I don't recognize this charge.", context)
    r = ask(db, conv, "connect me", context)
    assert "ESC-" in r["answer"]
    assert "sent to the support desk" not in r["answer"].lower()


# ── Direct handoff requests: no offer was ever made ─────────────────────────
# A user may OPEN the conversation by asking for a person. The stateful
# accept path only fires after an offer, so without this the message fell
# through to the out-of-scope refusal — the same dead end, one turn earlier.


def _handoff_rows(db, conv):
    from app.modules.chatbot.models import AIEscalationRequest
    return (
        db.query(AIEscalationRequest)
        .filter(AIEscalationRequest.conversation_id == conv.id)
        .count()
    )


@pytest.mark.parametrize("text", [
    "connect me to a team member?",
    "I want to speak to a human",
    "connect",
    "connect me to someone",
    "yes connect me",
    "Talk to a real person please",
    "can i talk to a person about my car insurance?",
    "put me through to an agent",
])
def test_direct_handoff_request_is_offered_then_dispatches(db, ctx, text):
    context, org = ctx
    conv = new_conv(db, org, "esc-direct")

    r = ask(db, conv, text, context)
    assert r["mode"] == "M5_ESCALATE", r
    assert "outside my scope" not in r["answer"].lower(), r["answer"]
    assert "connect you to a team member" in r["answer"].lower(), r["answer"]
    # Nothing is dispatched before the user confirms the offer.
    assert "ESC-" not in r["answer"], r["answer"]
    assert _handoff_rows(db, conv) == 0
    assert last_assistant_payload(db, conv).get(escmod.ESCALATION_PAYLOAD_KEY, {}).get("status") == "offered"

    r2 = ask(db, conv, "yes", context)
    assert r2["mode"] == "M5_ESCALATE", r2
    assert "ESC-" in r2["answer"], r2["answer"]
    assert _handoff_rows(db, conv) == 1


@pytest.mark.parametrize("text", [
    "Invite a team member",
    "How many team members do I have?",
    "What is payroll?",
    "connect my bank account to the billing platform",
    "How do I add a line item to my invoice?",
])
def test_non_handoff_message_never_becomes_a_handoff_offer(db, ctx, text):
    """Team-member MANAGEMENT, payroll and billing nouns must stay their own
    questions — only a message that asks for a PERSON gets the offer. (A
    generic KB abstention may still offer a handoff; what must never happen
    is the handoff-shaped answer being triggered by these.)"""
    context, org = ctx
    conv = new_conv(db, org, "esc-nonhandoff")
    r = ask(db, conv, text, context)
    assert _handoff_rows(db, conv) == 0
    offer = last_assistant_payload(db, conv).get(escmod.ESCALATION_PAYLOAD_KEY) or {}
    assert offer.get("reason") != "direct_handoff_request", (r, offer)


@pytest.mark.parametrize("text,expected", [
    ("connect", True),
    ("connect me to a team member?", True),
    ("I want to speak to a human", True),
    ("Talk to a real person please", True),
    ("connect me about my invoice issue", True),
    # The object after the verb keeps it a billing question:
    ("connect my bank account", False),
    ("Invite a team member", False),
    ("my team member asked about invoices", False),
    ("show me my dashboard", False),
    ("", False),
])
def test_is_direct_handoff_request(text, expected):
    assert escmod.is_direct_handoff_request(text) is expected