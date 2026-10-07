"""QA P0 production-hardening — escalation adversarial scenarios.

The core P0 regression suite (test_escalation_flow.py) proves accept/decline/
unrelated/TTL/webhook-success. This module covers the adversarial edges a
release has to be safe at:

- no DOUBLE dispatch when the user accepts more than once;
- no dispatch for accept-like phrasing when NO offer is pending;
- no lost user request / no trap after an accept (normal routing resumes);
- a decline never creates a handoff record;
- a stale offer (not on the last assistant message) never fires;
- webhook HTTP error and network failure are reported truthfully (request
  recorded, nothing claims it was "sent", the user never sees a crash).
"""
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.database import Base
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.models import (
    AIConversation,
    AIConversationMessage,
    AIEscalationRequest,
    ConversationStatus,
    EscalationRequestStatus,
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
    org = make_organization(db, code="ESCX", name="Esc Adv Org")
    return AIContext(organization_id=org.id, user_id=33, tenant_context_id=1,
                     role="org_admin", permissions=[], request_id="esc-adv"), org


def new_conv(db, org, uid):
    conv = AIConversation(conversation_uid=uid, tenant_context_id=1,
                          organization_id=org.id, user_id=33, title="esc-adv",
                          conversation_status=ConversationStatus.OPEN)
    db.add(conv)
    db.flush()
    return conv


def ask(db, conv, text, context):
    e = ConversationEngine(db, model_gateway=None)
    m = AIConversationMessage(conversation_id=conv.id,
                              message_uid="u-" + uuid.uuid4().hex[:10],
                              sender_type=SenderType.USER, message_text=text)
    db.add(m)
    db.flush()
    return e._process_message(conv, text, context)


def esc_rows(db, conv):
    return (
        db.query(AIEscalationRequest)
        .filter(AIEscalationRequest.conversation_id == conv.id)
        .count()
    )


# ── Adversarial state-machine scenarios ─────────────────────────────────────

def test_accept_twice_never_double_dispatches(db, ctx):
    context, org = ctx
    convo = new_conv(db, org, "esc-adv-twice")
    ask(db, convo, "I don't recognize this charge.", context)          # offer

    r2 = ask(db, convo, "yes connect me to a team member", context)    # accept
    assert r2["mode"] == "M5_ESCALATE"
    assert "ESC-" in r2["answer"]
    assert esc_rows(db, convo) == 1

    r3 = ask(db, convo, "yes connect me", context)                     # accept again
    # No second handoff record, no second reference, no re-latch into dispatch.
    assert esc_rows(db, convo) == 1
    assert "ESC-" not in r3["answer"]


def test_question_after_accept_is_not_trapped(db, ctx):
    context, org = ctx
    convo = new_conv(db, org, "esc-adv-after")
    ask(db, convo, "I don't recognize this charge.", context)          # offer
    r2 = ask(db, convo, "connect me", context)                         # accept
    assert esc_rows(db, convo) == 1

    r3 = ask(db, convo, "Show me my dashboard.", context)              # normal question
    assert r3["mode"] == "M1_INSPECT", r3
    assert esc_rows(db, convo) == 1


def test_decline_twice_creates_no_handoff(db, ctx):
    context, org = ctx
    convo = new_conv(db, org, "esc-adv-decline")
    ask(db, convo, "I don't recognize this charge.", context)          # offer
    assert esc_rows(db, convo) == 0

    ask(db, convo, "no thanks", context)                               # decline
    ask(db, convo, "no thanks", context)                               # decline again
    assert esc_rows(db, convo) == 0   # declining never writes a request


def test_accept_without_offer_is_not_dispatched(db, ctx):
    context, org = ctx
    convo = new_conv(db, org, "esc-adv-nooffer")
    # No prior offer: "connect me" must NOT fabricate a handoff dispatch.
    r = ask(db, convo, "connect me to someone", context)
    assert esc_rows(db, convo) == 0
    assert "ESC-" not in r["answer"]


def test_stale_offer_older_broken_state_never_dispatches(db, ctx):
    context, org = ctx
    convo = new_conv(db, org, "esc-adv-stale")
    ask(db, convo, "I don't recognize this charge.", context)          # offer
    # An unrelated reply CONSUMES the offer; later accept-like text must not
    # dispatch because the last assistant message no longer carries it.
    ask(db, convo, "Show me my dashboard.", context)
    assert esc_rows(db, convo) == 0
    r = ask(db, convo, "connect me now", context)
    assert esc_rows(db, convo) == 0
    assert "ESC-" not in r["answer"]


# ── Webhook failure paths ───────────────────────────────────────────────────

class _Fail500(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):
        type(self).calls += 1
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        self.send_response(500)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture()
def failing_webhook():
    server = HTTPServer(("127.0.0.1", 0), _Fail500)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/escalate"
    server.shutdown()
    thread.join(timeout=2)


def test_webhook_http_500_reports_truthfully_and_marks_failed(db, ctx, failing_webhook, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "AI_ESCALATION_WEBHOOK_URL", failing_webhook)

    context, org = ctx
    convo = new_conv(db, org, "esc-adv-500")
    ask(db, convo, "I don't recognize this charge.", context)
    r = ask(db, convo, "connect me", context)

    assert "sent to the support desk" not in r["answer"].lower()
    row = db.query(AIEscalationRequest).filter(
        AIEscalationRequest.conversation_id == convo.id
    ).first()
    assert row is not None
    assert row.dispatch_status == EscalationRequestStatus.FAILED
    assert row.webhook_status_code == 500
    assert row.dispatch_error


def test_webhook_network_error_never_crashes_user_path(db, ctx, monkeypatch):
    # A URL on an unused loopback port => connection refused.
    from app.config import settings
    monkeypatch.setattr(settings, "AI_ESCALATION_WEBHOOK_URL", "http://127.0.0.1:1/escalate")

    context, org = ctx
    convo = new_conv(db, org, "esc-adv-net")
    ask(db, convo, "I don't recognize this charge.", context)
    r = ask(db, convo, "connect me", context)

    assert r["mode"] == "M5_ESCALATE"
    assert "sent to the support desk" not in r["answer"].lower()
    row = db.query(AIEscalationRequest).filter(
        AIEscalationRequest.conversation_id == convo.id
    ).first()
    assert row is not None
    assert row.dispatch_status == EscalationRequestStatus.FAILED
    assert row.dispatch_error