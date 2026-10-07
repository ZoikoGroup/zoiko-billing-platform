"""Regression tests: knowledge/explanation questions vs live financial inspection.

Root cause these lock in: `_ACCOUNT_SPECIFIC_RE` treats a bare definite article
before an entity noun ("the payment") as a deictic pointer to one of the user's
own records. Inside a concept frame that article is ordinary grammar, so
"what is the payment" was classified account-specific, the WHAT_IS flag was
suppressed, the whole §2.1 definitional gate was skipped, and the bare-topic
"query contains <entity> -> <entity>_list" catch-all answered a knowledge
question from empty live records.

The distinction is the FRAME plus the absence of a value subject - never the
noun itself. These tests pin both directions: concept questions must reach the
knowledge base, and live-inspection frames must NOT be relaxed.
"""
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation.engine import ConversationEngine


# ── Fixtures ─────────────────────────────────────────────────────────────────

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
def org(db):
    o = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1,
        tenant_context_id=1, role="admin", permissions=[],
        request_id="test", tenant_name="Zoiko Test",
    )


def make_conv(db, org, uid="test-conv"):
    from app.modules.chatbot.models import AIConversation, ConversationStatus
    conv = AIConversation(
        conversation_uid=uid, tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="test", conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv


@pytest.fixture()
def approved_kb(db):
    """The REAL approved public knowledge base (seed_knowledge.py), so every
    grounding assertion below is checked against content product actually
    approved - not invented test text."""
    from seed_knowledge import KB_ENTRIES
    from app.modules.chatbot.models import (
        KnowledgeNamespace, KnowledgeSource, KnowledgeDocument, KnowledgeChunk,
        KnowledgeClassification, KnowledgeSourceDocType, FreshnessStatus,
    )
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="approved public KB",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id, source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing", title="Zoiko Billing Knowledge Base",
        status="active",
    )
    db.add(src)
    db.flush()
    for entry in KB_ENTRIES:
        doc = KnowledgeDocument(
            source_id=src.id, document_version=1,
            document_hash=f"test-{entry['title']}",
            freshness_status=FreshnessStatus.CURRENT, title=entry["title"],
            status="approved", is_public=entry.get("is_public", False),
        )
        db.add(doc)
        db.flush()
        for seq, chunk_text in enumerate(entry["chunks"], 1):
            db.add(KnowledgeChunk(
                document_id=doc.id, chunk_sequence=seq, chunk_text=chunk_text,
                classification=KnowledgeClassification.INTERNAL,
            ))
    db.flush()
    return ns


def _run(db, org, ctx, phrase, uid):
    """Classify then dispatch, returning (intent, result)."""
    engine = ConversationEngine(db, model_gateway=None)
    conv = make_conv(db, org, uid=uid)
    intent = engine._classify_intent(conv, phrase, ctx)
    handler = engine._get_handler(intent["domain"])
    result = handler(conv, phrase, intent, ctx)
    return intent, result


# ── The reported defect ──────────────────────────────────────────────────────

class TestBareArticleConceptQuestion:
    """A definite article inside a concept frame is grammar, not a deictic
    pointer. None of these may become a live record listing."""

    @pytest.mark.parametrize("phrase", [
        "what is the payment",
        "what is the invoice",
        "what is the customer",
        "what is the refund",
        "what is the credit note",
        "what is the subscription",
        "what is the contract",
    ])
    def test_not_an_entity_list(self, db, org, ctx, approved_kb, phrase):
        intent, result = _run(db, org, ctx, phrase, f"c-{phrase[:12]}")
        assert intent["domain"] == "help", (
            f"'{phrase}' -> {intent['intent']}/{intent['domain']}, expected help"
        )
        assert intent["intent"] != "payment_list"
        assert result["mode"] == "M0_EXPLAIN"
        assert result["evidence"], f"'{phrase}' produced no evidence"

    def test_reported_bug_exactly(self, db, org, ctx, approved_kb):
        """'what is the payment' must not be answered from payment records."""
        intent, result = _run(db, org, ctx, "what is the payment", "c-bug")
        assert intent["intent"] == "help_general", intent
        assert result["mode"] == "M0_EXPLAIN"
        assert "No payments found" not in result["answer"]


# ── Knowledge questions: natural paraphrases (all must be KB answers) ────────

class TestKnowledgeQuestions:

    @pytest.mark.parametrize("phrase", [
        # Payments
        "explain about the payment", "explain payments", "what is a payment",
        "what is the payment", "what are payments", "how do payments work",
        "how does payment work", "how to record a payment",
        "what payment methods are supported", "how many types of payment are there",
        # Invoices
        "what is an invoice", "explain invoices", "how do invoices work",
        "how do I create an invoice",
        # Customers
        "what is a customer",
        # Tax
        "what is tax", "explain tax", "what is a tax report",
        # Other approved topics
        "what is a credit note", "how does reconciliation work",
        "what is an overdue invoice", "what reports are available",
    ])
    def test_answers_from_knowledge_base(self, db, org, ctx, approved_kb, phrase):
        intent, result = _run(db, org, ctx, phrase, f"k-{abs(hash(phrase)) % 10**6}")
        assert result["mode"] == "M0_EXPLAIN", (
            f"'{phrase}' -> {intent['intent']} / {result['mode']}, expected a knowledge answer"
        )
        assert result["risk_class"] == "R0"
        assert result["evidence"], f"'{phrase}' retrieved no evidence"

    def test_customer_creation_still_unsupported(self, db, org, ctx, approved_kb):
        """'how do I add a customer' routing must not be changed by this fix."""
        intent, result = _run(db, org, ctx, "how do I add a customer", "c-addcust")
        assert intent["intent"] == "unsupported_customer_creation", intent
        assert result["mode"] == "M0_EXPLAIN"
        assert "Add Customer" in result["answer"]

    def test_payment_methods_grounded_in_approved_document(self, db, org, ctx, approved_kb):
        """The answer must come from the approved public Payments document, name
        only the methods that document actually documents, and invent nothing."""
        intent, result = _run(db, org, ctx, "what payment methods are supported", "m-methods")
        assert result["mode"] == "M0_EXPLAIN"
        assert result["evidence"], "payment-methods question retrieved no evidence"
        # Evidence must name the approved public document, not a live record source.
        sources = {e.get("source") for e in result["evidence"]}
        assert sources == {"Payments and Allocations"}, sources
        grounded = result["answer"].lower()
        # Only methods the approved document actually documents.
        for method in ("bank transfer", "credit card", "cash", "check"):
            assert method in grounded, f"documented method '{method}' missing from the answer"
        # Nothing invented beyond what is documented.
        for invented in ("bitcoin", "crypto", "paypal", "wire transfer"):
            assert invented not in grounded, f"invented method '{invented}' in the answer"

    def test_count_question_is_not_auto_abstained(self, db, org, ctx, approved_kb):
        """'how many types of payment' must retrieve first; the fallback is only
        allowed when the evidence truly cannot answer."""
        intent, result = _run(db, org, ctx, "how many types of payment are there", "m-count")
        assert result["mode"] == "M0_EXPLAIN"
        assert result["evidence"], "count question retrieved no evidence"
        assert "don't have a confirmed answer" not in result["answer"].lower()


# ── Live financial inspection must NOT be relaxed ────────────────────────────

class TestLiveFinancialInspectionPreserved:

    @pytest.mark.parametrize("phrase,expected_intent", [
        # Exact phrasings the task requires to stay on the live path.
        # "was collected" is a collections question (pre-existing split: the
        # existing pair "collected revenue" -> metric_collections vs
        # "revenue did we collect" -> metric_paid_period must not be collapsed).
        ("What is the current collected revenue?", "metric_collections"),
        ("How much revenue was collected?", "metric_collections"),
        ("Show overdue invoices", "invoice_list"),
        ("What is the current collection rate?", "metric_collection_rate"),
        # Pre-existing live inspection coverage.
        ("what is the current collection rate", "metric_collection_rate"),
        ("what is the current outstanding balance", "account_balance"),
        ("how much is outstanding", "account_balance"),
        ("what is the account balance", "account_balance"),
        ("what is my outstanding balance", "account_balance"),
        ("what is our revenue", "metric_revenue"),
        ("how much revenue did we collect", "metric_paid_period"),
        ("how much revenue did we generate this month", "metric_paid_period"),
        ("show overdue invoices", "invoice_list"),
        ("how many overdue invoices are there", "invoice_count"),
        ("show payments", "payment_list"),
        ("show today's payments", "payment_list"),
        ("show the payment", "payment_list"),
        ("this payment", "payment_list"),
        ("show payment history for customer ABC", "payment_list"),
        ("show invoice INV-1001", "invoice_search"),
        ("which invoices are overdue", "invoice_list"),
        ("how much is unpaid", "account_balance"),
    ])
    def test_still_live(self, db, org, ctx, phrase, expected_intent):
        intent, _ = _run(db, org, ctx, phrase, f"f-{abs(hash(phrase)) % 10**6}")
        assert intent["intent"] == expected_intent, (
            f"'{phrase}' -> {intent['intent']}, expected {expected_intent}"
        )
        assert intent["domain"] in ("billing", "dashboard"), intent

    @pytest.mark.parametrize("phrase", [
        "current collected revenue", "received revenue", "cleared revenue",
        "cash collected",
    ])
    def test_collections_not_revenue_only(self, db, org, ctx, phrase):
        """Collections/collected must keep the collections metric, not Revenue."""
        intent, _ = _run(db, org, ctx, phrase, f"col-{abs(hash(phrase)) % 10**6}")
        assert intent["intent"] == "metric_collections", (
            f"'{phrase}' -> {intent['intent']}, expected metric_collections"
        )

    def test_inspection_is_m1_not_m0(self, db, org, ctx):
        intent, result = _run(db, org, ctx, "show overdue invoices", "f-mode")
        assert result["mode"] == "M1_INSPECT"
        assert result["risk_class"] == "R1"


# ── Capability + domain guard ────────────────────────────────────────────────

class TestCapabilityAndDomainGuard:

    @pytest.mark.parametrize("phrase", [
        "what can you help me with", "what can you do",
    ])
    def test_capability_response(self, db, org, ctx, phrase):
        intent, result = _run(db, org, ctx, phrase, f"cap-{abs(hash(phrase)) % 10**6}")
        assert result["mode"] == "M0_EXPLAIN"
        assert "outside my scope" not in result["answer"].lower()

    @pytest.mark.parametrize("phrase", [
        "what is the weather in Paris tomorrow",
        "explain about me python",
        "how do I bake sourdough bread",
    ])
    def test_unrelated_questions_refused(self, db, org, ctx, phrase):
        intent, result = _run(db, org, ctx, phrase, f"ood-{abs(hash(phrase)) % 10**6}")
        assert intent["domain"] == "out_of_scope", (
            f"'{phrase}' -> {intent['intent']}/{intent['domain']}, expected out_of_scope"
        )
        assert result["mode"] == "M0_EXPLAIN"

    @pytest.mark.parametrize("phrase,expected", [
        ("how do I record a payemnt", "help_general"),   # typo -> payment
        ("revenu total", "metric_revenue"),              # fuzzy -> revenue
    ])
    def test_typo_and_fuzzy_still_resolve(self, db, org, ctx, phrase, expected):
        intent, _ = _run(db, org, ctx, phrase, f"ty-{abs(hash(phrase)) % 10**6}")
        assert intent["intent"] == expected, intent


# ── Collection rate: definition vs live figure ───────────────────────────────

class TestCollectionRateSplit:

    def test_definition_is_knowledge(self, db, org, ctx, approved_kb):
        for phrase in ("how is collection rate calculated", "what is the collection rate"):
            intent, result = _run(db, org, ctx, phrase, f"cr-{abs(hash(phrase)) % 10**6}")
            assert result["mode"] == "M0_EXPLAIN", f"'{phrase}' -> {intent['intent']}"

    def test_current_is_live(self, db, org, ctx):
        intent, result = _run(db, org, ctx, "what is the current collection rate", "cr-live")
        assert intent["intent"] == "metric_collection_rate"
        assert result["mode"] == "M1_INSPECT"
