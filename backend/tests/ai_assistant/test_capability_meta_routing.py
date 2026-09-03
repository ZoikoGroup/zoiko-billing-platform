"""
test_capability_meta_routing.py
-------------------------------
Regression tests for capability / help / meta-request routing (Issue 1).

"What can you help me with?" and its natural variants MUST classify as the
existing capability/help meta intent (help_general / help) and be answered
from the CANONICAL capability response:

  - intent          == help_general, domain == help (R0, rules fast-path)
  - answer          == the canonical capability overview ("look up invoices")
  - mode            == M0_EXPLAIN
  - NEVER out_of_scope / NOT_ANSWERABLE
  - NEVER the generic KB abstention ("I'd rather not guess")
  - NEVER a live financial-inspection (M1) path

Real billing questions must keep their existing routes and must NOT be
hijacked into the canned capability overview even when they echo a capability
phrase ("What can you do with a line item?").

Mirrors the fixture pattern of eval_chatbot_90.py.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.models import (
    KnowledgeNamespace,
    KnowledgeSource,
    KnowledgeDocument,
    KnowledgeChunk,
    KnowledgeClassification,
    KnowledgeSourceDocType,
    FreshnessStatus,
    AIConversation,
    ConversationStatus,
)
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext

CAPABILITY_MARKER = "what i can do (m0 explain / m1 inspect)"
ABSTENTION_MARKERS = ("rather not guess", "don't have specific information")


KB_DOCS = {
    "Invoices Overview": [
        "An invoice is a commercial document issued by a seller to a buyer, indicating the products, quantities, and agreed prices for services provided.",
        "Invoice statuses in Zoiko Billing: Draft, Sent, Partially Paid, Paid, Overdue, Cancelled, Refunded, Written Off.",
        "To find a payment, search by payment number, transaction ID, or customer name.",
    ],
    "Billing Terminology": [
        "Billing terminology glossary: an invoice requests payment; a credit note reduces an invoice balance; proration adjusts charges for partial billing periods; dunning is the structured collection of overdue invoices.",
    ],
    "Dunning and Collections": [
        "The dunning process chases overdue invoices with escalating reminders: reminder, warning, final notice, then escalation to collections.",
        "Late fees are charges applied to overdue invoices according to the organization's payment terms and applicable tax regulations.",
    ],
}


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def kb(db):
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="public KB",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id, source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing", title="Zoiko Billing Knowledge Base", status="active",
    )
    db.add(src)
    db.flush()
    for title, chunks in KB_DOCS.items():
        doc = KnowledgeDocument(
            source_id=src.id, document_version="1.0",
            freshness_status=FreshnessStatus.CURRENT, title=title, status="approved",
        )
        db.add(doc)
        db.flush()
        for seq, text in enumerate(chunks, 1):
            db.add(KnowledgeChunk(
                document_id=doc.id, chunk_sequence=seq, chunk_text=text,
                classification=KnowledgeClassification.INTERNAL,
            ))
    db.flush()
    return ns


@pytest.fixture()
def org(db):
    o = Organization(organization_name="Eval Org", organization_code="EV1")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def ctx(db, kb, org):
    return AIContext(
        organization_id=org.id, user_id=1,
        tenant_context_id=1,
        role="admin", permissions=[], request_id="test",
        tenant_name="Eval Org",
    )


@pytest.fixture()
def conv(db, org):
    c = AIConversation(
        conversation_uid="capability-conv", tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="capability", conversation_status=ConversationStatus.OPEN,
    )
    db.add(c)
    db.flush()
    return c


# ── Issue 1 required phrasings + natural variants ─────────────────────────────
CAPABILITY_ASKS = [
    "What can you help me with?",
    "What can you do?",
    "How can you help me?",
    "What can you help with?",
    "What can this assistant do?",
    "What can I ask you?",
    "What can I ask?",
    "What questions can I ask?",
    "What kind of questions can I ask?",
    "What are you able to help with?",
    "What are you able to do?",
    "What kind of help can you provide?",
    "What capabilities do you have?",
    "What are your capabilities?",
    "What can you do for me?",
    "What can you do for us?",
    "What can you help me with today?",
    "Capabilities",
    "Can you help me?",
    "What do you do?",
    "how can you help me please",
]

# ── Real billing questions that must NOT be hijacked ──────────────────────────
BILLING_PROBES = [
    ("What can you do with a line item?", {}),
    ("What do you do with a line item?", {}),
]


class TestCapabilityAsksRouteToCapabilityIntent:
    @pytest.mark.parametrize("q", CAPABILITY_ASKS, ids=CAPABILITY_ASKS)
    def test_routes_to_help_general_capability_response(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, q, ctx)
        assert intent["intent"] == "help_general", (q, intent)
        assert intent["domain"] == "help", (q, intent)
        assert intent.get("risk_class") == "R0", (q, intent)
        assert intent.get("confidence", 0) >= 0.8, (q, intent)

        handler = engine._get_handler(intent["domain"])
        result = handler(conv, q, intent, ctx)
        answer = (result.get("answer") or "").lower()

        assert result.get("mode") == "M0_EXPLAIN", (q, result.get("mode"))
        assert "look up invoices" in answer, (q, answer[:200])
        assert "i am the zoiko billing ai assistant" in answer, (q, answer[:120])
        assert not any(m in answer for m in ABSTENTION_MARKERS), (q, answer[:200])
        assert "outside my scope" not in answer, (q, answer[:200])
        assert answer != CAPABILITY_MARKER  # sanity: the marker exists in the answer


class TestCapabilityRoutingDoesNotHijackBillingQuestions:
    @pytest.mark.parametrize("q", [p[0] for p in BILLING_PROBES], ids=[p[0] for p in BILLING_PROBES])
    def test_billing_questions_not_hijacked(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, q, ctx)
        result = engine._get_handler(intent["domain"])(conv, q, intent, ctx)
        answer = (result.get("answer") or "").lower()
        assert intent["intent"] != "out_of_scope", (q, intent)
        assert CAPABILITY_MARKER not in answer, (q, answer[:200])

    def test_help_question_must_not_become_capability_dump(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "How do I create an invoice?", ctx)
        assert intent["intent"] == "help_general", intent
        result = engine._get_handler(intent["domain"])(conv, "How do I create an invoice?", intent, ctx)
        answer = (result.get("answer") or "").lower()
        assert "create invoice" in answer, answer[:200]
        assert CAPABILITY_MARKER not in answer, answer[:200]

    def test_metric_questions_stay_on_inspect_path(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        revenue = engine._classify_intent(conv, "What is my current revenue?", ctx)
        assert revenue["intent"] == "metric_revenue", revenue
        rev = engine._get_handler(revenue["domain"])(conv, "What is my current revenue?", revenue, ctx)
        assert rev.get("mode") == "M1_INSPECT", rev
        assert CAPABILITY_MARKER not in (rev.get("answer") or "").lower()

        rate = engine._classify_intent(conv, "What is my collection rate?", ctx)
        assert rate["intent"] == "metric_collection_rate", rate
        rat = engine._get_handler(rate["domain"])(conv, "What is my collection rate?", rate, ctx)
        assert rat.get("mode") == "M1_INSPECT", rat
        assert CAPABILITY_MARKER not in (rat.get("answer") or "").lower()

    def test_collections_knowledge_question_stays_on_help_path(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "What are my collections?", ctx)
        assert intent["intent"] == "help_general", intent
        result = engine._get_handler(intent["domain"])(conv, "What are my collections?", intent, ctx)
        answer = (result.get("answer") or "").lower()
        assert result.get("mode") == "M0_EXPLAIN", result
        assert CAPABILITY_MARKER not in answer, answer[:200]
        assert not any(m in answer for m in ABSTENTION_MARKERS), answer[:200]


class TestCapabilityResponseNeverLeaksToOutOfDomain:
    def test_out_of_scope_still_refuses(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "Explain quantum computing", ctx)
        assert intent["intent"] == "out_of_scope", intent
        result = engine._get_handler(intent["domain"])(conv, "Explain quantum computing", intent, ctx)
        answer = (result.get("answer") or "").lower()
        assert "outside my scope" in answer, answer[:200]
        assert "capabilit" not in answer, answer[:200]
        assert result.get("evidence") in ([], None), result.get("evidence")


class TestMetaShopkeeperVariants:
    @pytest.mark.parametrize("q", CAPABILITY_ASKS, ids=CAPABILITY_ASKS)
    def test_all_variants_share_one_canonical_answer(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, q, ctx)
        result = engine._get_handler(intent["domain"])(conv, q, intent, ctx)
        assert result["answer"] == engine._capability_response()["answer"], q