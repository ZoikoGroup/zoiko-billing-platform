"""
test_tokenization_variants.py
-----------------------------
Regression tests for tokenization-drift NLU failures:

  - Spacing/hyphen variants of compound billing terms ("dash board",
    "sub scription", "over due", "creditnote") must classify EXACTLY like
    their canonical forms — never fall through to help/RAG or a bogus
    customer search.
  - Single-edit typos ("dashbord", "invoce") are rescued to the right
    surface, while exact-noun knowledge questions ("What is an invoice?")
    stay with RAG.
  - When retrieval is weak AND the wording nearly names a billing surface,
    the assistant CLARIFIES (D-11) instead of serving unrelated content.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import BillingCustomer, Invoice, InvoiceStatus
from app.modules.chatbot.conversation.engine import (
    ConversationEngine,
    normalize_domain_text,
)
from app.modules.chatbot.context.ai_context import AIContext


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
        tenant_context_id=1,
        role="admin", permissions=[], request_id="test",
        tenant_name="Zoiko Test",
    )


@pytest.fixture()
def customers(db, org):
    c = BillingCustomer(
        organization_id=org.id, customer_code="CUST-GO",
        company_name="GOk", display_name="Go Enterprises",
        email="go@example.com", currency="USD",
    )
    db.add(c)
    db.flush()
    return c


@pytest.fixture()
def invoices(db, org, customers):
    from datetime import date, timedelta
    today = date.today()
    db.add(Invoice(organization_id=org.id, customer_id=customers.id,
                   invoice_number="INV-TOK-1", status=InvoiceStatus.PAID,
                   issue_date=today, due_date=today,
                   total_amount=1000, balance_due=0, currency="USD"))
    db.add(Invoice(organization_id=org.id, customer_id=customers.id,
                   invoice_number="INV-TOK-2", status=InvoiceStatus.SENT,
                   issue_date=today, due_date=today - timedelta(days=10),
                   total_amount=500, balance_due=500, currency="USD"))
    db.flush()


# ── Unit: compound-term normalization ────────────────────────────────────────

class TestNormalizeDomainText:
    @pytest.mark.parametrize("variant,canonical", [
        ("dash board", "dashboard"),
        ("dash-board", "dashboard"),
        ("dash boards", "dashboards"),
        ("Dash Board Summary", "Dashboard Summary"),
        ("sub scription", "subscription"),
        ("sub scriptions", "subscriptions"),
        ("sub-scription list", "subscription list"),
        ("over due", "overdue"),
        ("over-due amount", "overdue amount"),
        ("pastdue", "past due"),
        ("creditnote", "credit note"),
        ("credit-notes policy", "credit notes policy"),
        ("writeoff", "write off"),
        ("writtenoff", "written off"),
        ("dashboard summary", "dashboard summary"),  # idempotent
        ("credit note", "credit note"),              # canonical stays two words
    ])
    def test_variant_maps_to_canonical(self, variant, canonical):
        assert normalize_domain_text(variant).lower() == canonical.lower(), (
            f"{variant!r}: expected {canonical!r}, got {normalize_domain_text(variant)!r}"
        )


# ── Classification equivalence: variant ≡ canonical ──────────────────────────

class TestSpacingVariantRouting:
    CASES = [
        # (variant phrase, canonical phrase, expected intent, expected domain)
        ("dash board summary", "dashboard summary", "dashboard_summary", "dashboard"),
        ("show me the dash board", "show me the dashboard", "dashboard_summary", "dashboard"),
        ("sub scriptions list", "subscriptions list", "subscription_list", "billing"),
        ("list sub scriptions", "list subscriptions", "subscription_list", "billing"),
        ("over due invoices", "overdue invoices", "invoice_list", "billing"),
        ("what is the over due amount", "what is the overdue amount",
         "metric_definition", "help"),
    ]

    @pytest.mark.parametrize("variant,canonical,exp_intent,exp_domain", CASES)
    def test_variant_matches_canonical_routing(self, db, org, ctx, variant, canonical,
                                               exp_intent, exp_domain):
        engine = ConversationEngine(db, model_gateway=None)
        got_variant = engine._rules_classify_intent(variant)
        got_canonical = engine._rules_classify_intent(canonical)
        assert got_variant["intent"] == exp_intent, (
            f"{variant!r}: expected {exp_intent}, got {got_variant['intent']}"
        )
        assert got_variant["domain"] == exp_domain
        assert got_variant["intent"] == got_canonical["intent"], (
            f"variant {variant!r} ({got_variant['intent']}) != canonical "
            f"{canonical!r} ({got_canonical['intent']})"
        )

    def test_dash_board_summary_end_to_end_returns_dashboard(self, db, org, ctx, invoices):
        """The reported repro: 'dash board summary' must return the financial
        overview — never an abstention or unrelated RAG content."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "tok-dash")
        intent = engine._classify_intent(conv, "dash board summary", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "dash board summary", intent, ctx)
        assert intent["intent"] == "dashboard_summary"
        assert "Revenue" in result["answer"]
        assert "don't have specific information" not in result["answer"]

    def test_show_me_the_dash_board_not_customer_search(self, db, org, ctx, invoices):
        """'show me the dash board' must never become a customer search for a
        customer named 'dashboard'."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "tok-dash2")
        intent = engine._classify_intent(conv, "show me the dash board", ctx)
        assert intent["intent"] == "dashboard_summary", intent
        assert intent["intent"] != "customer_search"

    def test_over_due_invoices_filters_to_overdue(self, db, org, ctx, invoices):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "tok-overdue")
        intent = engine._classify_intent(conv, "over due invoices", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "over due invoices", intent, ctx)
        assert intent["domain"] == "billing"
        assert "INV-TOK-2" in result["answer"]
        assert "INV-TOK-1" not in result["answer"], "paid invoice must not appear"


# ── Typo rescue vs exact-noun knowledge questions ────────────────────────────

class TestFuzzyRescue:
    TYPOS = [
        ("dashbord summary", "dashboard_summary", "dashboard"),
        ("show me the dashbord", "dashboard_summary", "dashboard"),
        ("invoce list", "invoice_list", "billing"),
        ("my subscribtions", "subscription_list", "billing"),
        ("paymnts list", "payment_list", "billing"),
    ]

    @pytest.mark.parametrize("phrase,exp_intent,exp_domain", TYPOS)
    def test_single_edit_typo_rescued(self, db, org, ctx, phrase, exp_intent, exp_domain):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._rules_classify_intent(phrase)
        assert result["intent"] == exp_intent, (
            f"{phrase!r}: expected {exp_intent}, got {result['intent']}"
        )
        assert result["domain"] == exp_domain

    @pytest.mark.parametrize("phrase", [
        "What is an invoice?",
        "Explain subscription billing cycles",
        "What are payment terms?",
    ])
    def test_exact_noun_knowledge_questions_stay_rag(self, db, org, ctx, phrase):
        """A well-formed knowledge question mentioning an exact billing noun
        must NOT be hijacked into a list intent."""
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._rules_classify_intent(phrase)
        assert result["intent"] == "help_general", (
            f"{phrase!r}: expected help_general, got {result['intent']}"
        )


# ── D-11 safety floor + clarify follow-through ───────────────────────────────

class TestSafetyFloor:
    def test_weak_retrieval_with_near_domain_word_clarifies(self, db, org, ctx):
        """Low-confidence retrieval + wording that nearly names a billing
        surface → clarify ('Did you mean…'), never loose RAG content."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "tok-floor")
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(conv, "about the dashbord summery thing", intent, ctx)
        assert "did you mean" in result["answer"].lower()
        assert result.get("clarify_state", {}).get("options")

    def test_affirmative_reply_resolves_clarification(self, db, org, ctx):
        """Replying 'yes' to a clarify question moves forward — never loops."""
        engine = ConversationEngine(db, model_gateway=None)
        conversation = engine.create_conversation(ctx=ctx)
        uid = conversation["conversation_uid"]
        r1 = engine.send_message(conversation_uid=uid, message="team dashboard", ctx=ctx)
        r2 = engine.send_message(conversation_uid=uid, message="yes", ctx=ctx)
        assert "did you mean" in r1["answer"].lower()
        assert "did you mean" not in r2["answer"].lower(), (
            f"Clarify repeated after affirmative reply: {r2['answer'][:200]!r}"
        )


def _make_conv(db, org, uid):
    from app.modules.chatbot.models import AIConversation, ConversationStatus
    conv = AIConversation(
        conversation_uid=uid,
        tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="test", conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv
