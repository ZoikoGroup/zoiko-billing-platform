"""Reproduce every defect in the QA Gap Analysis against the live engine.

Run:  python -m pytest tests/ai_assistant/test_qa_gap_repro.py -q -s
This file is a diagnostic scratchpad, NOT the regression suite.
"""
import pytest
from datetime import date, timedelta

from app.database import Base
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.models import (
    AIConversation,
    AIConversationMessage,
    ConversationStatus,
    SenderType,
)
from app.modules.organizations.models import Organization
from app.modules.billing.models import Invoice, InvoiceItem, InvoiceStatus, Payment, PaymentStatus, PaymentType
from tests.conftest import make_organization, make_customer, make_invoice


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
    org = make_organization(db, code="QA1", name="QA Org")
    return AIContext(organization_id=org.id, user_id=1, tenant_context_id=1,
                     role="org_admin", permissions=[], request_id="qa-repro"), org


def new_conv(db, org, uid):
    conv = AIConversation(conversation_uid=uid, tenant_context_id=1,
                          organization_id=org.id, user_id=1, title="qa",
                          conversation_status=ConversationStatus.OPEN)
    db.add(conv)
    db.flush()
    return conv


def ask(db, conv, text, context, engine=None):
    e = engine or ConversationEngine(db, model_gateway=None)
    m = AIConversationMessage(conversation_id=conv.id, message_uid="u-" + text[:12],
                             sender_type=SenderType.USER, message_text=text)
    db.add(m)
    db.flush()
    return e._process_message(conv, text, context)


def route(db, text):
    """Just the routing decision, no handler."""
    e = ConversationEngine(db, model_gateway=None)
    return e._rules_classify_intent(text)


# ── P0: dead-end escalation loop ────────────────────────────────────────────

def test_p0_escalation_offer_then_yes(db, ctx):
    context, org = ctx
    conv = new_conv(db, org, "p0-yes")
    r1 = ask(db, conv, "I don't recognize this charge.", context)
    print("\n[P0] turn1 mode=", r1["mode"], "answer=", r1["answer"][:110])
    r2 = ask(db, conv, "yes connect me", context)
    print("[P0] turn2 mode=", r2["mode"], "answer=", r2["answer"][:220])
    assert "connect you to a team member" not in r2["answer"].lower() or "requested assistance" in r2["answer"]


# ── P1: keyword over-triggering ─────────────────────────────────────────────

def test_p1_payment_options(db, ctx):
    context, org = ctx
    print("\n[P1-A] route:", route(db, "What payment options are supported (ACH, debit card, digital wallets)?"))


def test_p1_failed_card_retry(db, ctx):
    context, org = ctx
    r = route(db, "My card payment failed yesterday. Can you retry the payment now?")
    print("[P1-B] route:", r)
    conv = new_conv(db, org, "p1b")
    res = ask(db, conv, "My card payment failed yesterday. Can you retry the payment now?", context)
    print("[P1-B] mode=", res["mode"], "risk=", res["risk_class"])
    print("[P1-B] answer=", res["answer"][:200])


# ── P1: entity extraction ───────────────────────────────────────────────────

@pytest.mark.parametrize("q", [
    "What's my due date?",
    "When is my bill due?",
    "Show me my last bill amount.",
    "How much was my last bill?",
    "Show me the items on my bill.",
    "How much tax was charged?",
    "What billing cycle am I on?",
    "What's my overdue invoice due date?",
])
def test_p1_entity_queries(db, ctx, q):
    print(f"\n[P1-ENT] {q!r} -> {route(db, q)}")


# ── P2: refund estimation ───────────────────────────────────────────────────

def test_p2_refund_estimate(db, ctx):
    context, org = ctx
    r = route(db, "Can you calculate my prorated refund if I downgrade my active subscription today?")
    print("\n[P2] route:", r)
    conv = new_conv(db, org, "p2")
    res = ask(db, conv, "Can you calculate my prorated refund if I downgrade my active subscription today?", context)
    print("[P2] mode=", res["mode"], "risk=", res["risk_class"])
    print("[P2] answer=", res["answer"][:300])


# ── P1: RAG coverage ────────────────────────────────────────────────────────

@pytest.mark.parametrize("q", [
    "Dunning warning email - how many days grace period do I have?",
    "How do I activate an add-on?",
    "How do I pay my bill online right now?",
    "How do I update my card?",
    "What payment methods are supported?",
    "How does proration work?",
    "How do billing cycles work?",
])
def test_p1_rag_questions(db, ctx, q):
    print(f"\n[RAG] {q!r} -> {route(db, q)}")