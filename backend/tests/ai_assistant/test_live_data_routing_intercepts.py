"""
test_live_data_routing_intercepts.py
-------------------------------------
Regression tests for LIVE-DATA routing precedence (Issue 1 & Issue 2):

A request for CURRENT billing data must NEVER be demoted to a knowledge /
how-to / `help_general` answer — in particular, the conversation-history
domain-inheritance heuristic (which forces `help_general` after a prior
`help` turn) must not hijack an EXPLICIT live-data request.

Issue 1 — "Show overdue invoices" and variants:
    MUST route to billing / invoice_list / M1_INSPECT / R1 (live ledger).
    MUST NOT return Explain R0, the KB abstention, or how-to instructions,
    even when typed right after a help/how-to turn.

Issue 2 — "Dashboard summary" and variants:
    MUST route to dashboard_summary / M1_INSPECT / R1 (live dashboard KPIs).
    MUST NOT return a "what is a dashboard summary?" KB explanation or the
    generic abstention, even when typed right after a help turn.

Collision prevention:
    "How do I view overdue invoices?" / "What is a dashboard summary?" stay
    on the knowledge/how-to path (help_general / M0_EXPLAIN / R0).

Mirrors the fixture pattern of test_capability_meta_routing.py.
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

ABSTENTION_MARKERS = ("rather not guess", "don't have specific information")
DASHBOARD_MARKERS = ("dashboard summary", "total revenue", "collections")
HOW_TO_OVERDUE_MARKER = "how to view overdue invoices"


KB_DOCS = {
    "Overdue Invoices and Dunning": [
        "The dunning process chases overdue invoices with escalating reminders: reminder, warning, final notice, then collections.",
        "How to view overdue invoices: Go to the Dashboard, check the Overdue widget, or open Invoices and filter by Overdue status.",
    ],
    "Dashboard": [
        "Dashboard summary is a quick view of key billing metrics shown on the dashboard screen.",
    ],
    "Invoices Overview": [
        "An invoice is a commercial document issued by a seller to a buyer describing services delivered.",
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
        conversation_uid="live-data-conv", tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="live-data", conversation_status=ConversationStatus.OPEN,
    )
    db.add(c)
    db.flush()
    return c


# ── Issue 1 required live phrasings ──────────────────────────────────────────
OVERDUE_LIVE_ASKS = [
    "Show overdue invoices",
    "Show me overdue invoices",
    "Which invoices are overdue?",
    "List overdue invoices",
    "Overdue invoices",
    "Show overdue invoices now",
]

# ── Issue 2 required live phrasings ──────────────────────────────────────────
DASHBOARD_LIVE_ASKS = [
    "Dashboard summary",
    "Summarize my dashboard",
    "Give me my dashboard summary",
    "Show my dashboard summary",
    "What is my dashboard summary?",
]

# Count phrasings that must also stay live-data.
COUNT_LIVE_ASKS = [
    "How many overdue invoices are there?",
    "How many open invoices are there?",
]

# Knowledge / how-to collisions that must STAY on the help path.
KNOWLEDGE_ASKS = [
    "How do I view overdue invoices?",
    "What is a dashboard summary?",
    "How do I use the dashboard?",
]


def _answer_prefix(result):
    return (result.get("answer") or "")[:120].lower()


class _LiveDataRouteBase:
    """Send a help/how-to turn first, then assert the follow-up is LIVE."""

    LIVE_ASKS = ()
    EXPECTED_INTENT = ()  # (intent, domain)

    def _assert_live_after_help(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        # Prior turn that would otherwise trigger help-domain inheritance.
        help_r = engine._process_message(conv, "How do I view overdue invoices?", ctx)
        assert help_r.get("mode") == "M0_EXPLAIN", help_r
        # The live-data follow-up must NOT be hijacked into help/KB.
        r = engine._process_message(conv, q, ctx)
        assert r.get("mode") == "M1_INSPECT", (q, help_r.get("mode"), r.get("mode"))
        assert r.get("risk_class") == "R1", (q, r.get("risk_class"))
        answer = _answer_prefix(r)
        assert not any(m in answer for m in ABSTENTION_MARKERS), (q, answer)

    def _assert_live_one_shot(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        r = engine._process_message(conv, q, ctx)
        assert r.get("mode") == "M1_INSPECT", (q, r.get("mode"))
        assert r.get("risk_class") == "R1", (q, r.get("risk_class"))


class TestOverdueInvoicesRouteToLiveInspect(_LiveDataRouteBase):
    LIVE_ASKS = OVERDUE_LIVE_ASKS

    @pytest.mark.parametrize("q", OVERDUE_LIVE_ASKS, ids=OVERDUE_LIVE_ASKS)
    def test_overdue_routes_live_after_help_turn(self, db, ctx, conv, q):
        self._assert_live_after_help(db, ctx, conv, q)

    @pytest.mark.parametrize("q", OVERDUE_LIVE_ASKS, ids=OVERDUE_LIVE_ASKS)
    def test_overdue_routes_live_one_shot(self, db, ctx, conv, q):
        self._assert_live_one_shot(db, ctx, conv, q)

    def test_overdue_classifies_invoice_list_billing(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "Show overdue invoices", ctx)
        assert intent["intent"] == "invoice_list", intent
        assert intent["domain"] == "billing", intent
        assert intent.get("risk_class") == "R1", intent


class TestDashboardSummaryRouteToLiveInspect(_LiveDataRouteBase):
    LIVE_ASKS = DASHBOARD_LIVE_ASKS

    @pytest.mark.parametrize("q", DASHBOARD_LIVE_ASKS, ids=DASHBOARD_LIVE_ASKS)
    def test_dashboard_routes_live_after_help_turn(self, db, ctx, conv, q):
        self._assert_live_after_help(db, ctx, conv, q)

    @pytest.mark.parametrize("q", DASHBOARD_LIVE_ASKS, ids=DASHBOARD_LIVE_ASKS)
    def test_dashboard_routes_live_one_shot(self, db, ctx, conv, q):
        self._assert_live_one_shot(db, ctx, conv, q)

    def test_dashboard_returns_live_kpi_metrics(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        r = engine._process_message(conv, "Dashboard summary", ctx)
        assert r.get("mode") == "M1_INSPECT", r
        answer = _answer_prefix(r)
        assert "dashboard summary" in answer, answer
        # Live financial KPI fields must be present, not a definition.
        assert any(m in answer for m in DASHBOARD_MARKERS), answer

    def test_dashboard_classifies_dashboard_summary_domain(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "Dashboard summary", ctx)
        assert intent["intent"] == "dashboard_summary", intent
        assert intent["domain"] == "dashboard", intent
        assert intent.get("risk_class") == "R1", intent


class TestCountQueriesStayLive:
    @pytest.mark.parametrize("q", COUNT_LIVE_ASKS, ids=COUNT_LIVE_ASKS)
    def test_count_routes_live_after_help(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        engine._process_message(conv, "How do I view overdue invoices?", ctx)
        r = engine._process_message(conv, q, ctx)
        assert r.get("mode") == "M1_INSPECT", (q, r.get("mode"))
        assert r.get("risk_class") == "R1", (q, r.get("risk_class"))


class TestKnowledgeCollisionsStayOnHelpPath:
    @pytest.mark.parametrize("q", KNOWLEDGE_ASKS, ids=KNOWLEDGE_ASKS)
    def test_knowledge_question_stays_help_even_after_purch(self, db, ctx, conv, q):
        engine = ConversationEngine(db, model_gateway=None)
        r = engine._process_message(conv, "How do I view overdue invoices?", ctx)
        assert r.get("mode") == "M0_EXPLAIN", (q, r.get("mode"))
        r2 = engine._process_message(conv, q, ctx)
        # A pure conceptual/how-to question must not become a live-data Inspect.
        assert r2.get("mode") == "M0_EXPLAIN", (q, r2.get("mode"))
        assert r2.get("risk_class") == "R0", (q, r2.get("risk_class"))
        assert not any(m in (r2.get("answer") or "").lower() for m in ABSTENTION_MARKERS), q

    def test_what_is_dashboard_summary_is_explain(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "What is a dashboard summary?", ctx)
        assert intent["intent"] == "help_general", intent
        assert intent["domain"] == "help", intent

    def test_how_do_i_view_overdue_is_explain(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, "How do I view overdue invoices?", ctx)
        assert intent["intent"] == "help_general", intent
        assert intent["domain"] == "help", intent

    def test_overdue_live_never_leaks_how_to_text(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        engine._process_message(conv, "How do I view overdue invoices?", ctx)
        r = engine._process_message(conv, "Show overdue invoices", ctx)
        answer = _answer_prefix(r)
        assert "how to view overdue invoices" not in answer, answer
        assert not any(m in answer for m in ABSTENTION_MARKERS), answer