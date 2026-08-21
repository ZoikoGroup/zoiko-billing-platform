"""
test_intent_regression.py
-------------------------
Regression tests for the PRD §09 intent-taxonomy round:

  ISSUE A — Figure mismatch: chatbot vs dashboard page vs DB
            (Revenue / Outstanding / invoice count must agree exactly,
             drafts and cancelled invoices must never count as revenue)
  ISSUE B — Intent misrouting:
            "product Dashboard"        -> generic financial dump
            "Total Revenue"            -> full overview instead of the figure
            "How many customers...?"   -> credit-note / unrelated content
            "Valid invoice statuses?"  -> audit-log content
  ISSUE C — Missing PRD §09 families: Modify draft, Correct, Refund,
            Communicate, Export, Reconcile ("match")
  DOCTRINE — D-11 Safe uncertainty: ambiguous input must CLARIFY, never guess;
            a specific rules match must beat a generic/hostile model result.
"""
import json
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.billing.services.dashboard_service import BillingDashboardService
from app.modules.chatbot.conversation.engine import ConversationEngine, money
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


def make_conv(db, org, uid="test-conv"):
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


def add_invoice(db, org, customer_id, number, status, total, paid="0.00",
                currency="USD", due_offset_days=0):
    inv = Invoice(
        organization_id=org.id,
        customer_id=customer_id,
        invoice_number=number,
        status=status,
        issue_date=date.today(),
        due_date=date.today() + timedelta(days=due_offset_days),
        total_amount=str(total),
        paid_amount=str(paid),
        balance_due=str(float(total) - float(paid)),
        currency=currency,
    )
    db.add(inv)
    db.flush()
    return inv


@pytest.fixture()
def customers(db, org):
    from app.modules.billing.models import BillingCustomer
    c1 = BillingCustomer(
        organization_id=org.id, customer_code="CUST-GO",
        company_name="GOk", display_name="Go Enterprises",
        email="go@example.com", currency="USD",
    )
    c2 = BillingCustomer(
        organization_id=org.id, customer_code="CUST-ACME",
        company_name="Acme Corp", display_name="Acme",
        email="billing@acme.com", currency="INR",
    )
    db.add_all([c1, c2])
    db.flush()
    return {"go": c1, "acme": c2}


@pytest.fixture()
def kb(db):
    """Minimal approved KB so knowledge questions ground via retrieval.
    Status text mirrors seed_knowledge.py / the live InvoiceStatus enum."""
    from app.modules.chatbot.models import (
        KnowledgeNamespace, KnowledgeSource, KnowledgeDocument, KnowledgeChunk,
        KnowledgeClassification, KnowledgeSourceDocType, FreshnessStatus,
    )
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="test public KB",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id,
        source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing",
        title="Zoiko Billing Knowledge Base",
        status="active",
    )
    db.add(src)
    db.flush()
    doc = KnowledgeDocument(
        source_id=src.id,
        document_version=1,
        document_hash="test-invoices-overview",
        freshness_status=FreshnessStatus.CURRENT,
        title="Invoices Overview",
        status="approved",
    )
    db.add(doc)
    db.flush()
    for seq, chunk_text in enumerate([
        "An invoice is a commercial document issued by a seller to a buyer, "
        "indicating the products, quantities, and agreed prices. In Zoiko "
        "Billing, invoices track what customers owe.",
        "Invoice statuses in Zoiko Billing: Draft (created but not yet sent), "
        "Sent (delivered to customer, awaiting payment), Partially Paid (some "
        "payment received), Paid (fully settled), Overdue (past due date with "
        "unpaid balance), Cancelled (voided before any collection effort), "
        "Refunded (payment returned to customer), Written Off (remaining "
        "balance written off as uncollectable).",
    ], 1):
        db.add(KnowledgeChunk(
            document_id=doc.id,
            chunk_sequence=seq,
            chunk_text=chunk_text,
            classification=KnowledgeClassification.INTERNAL,
        ))
    db.flush()
    return doc


@pytest.fixture()
def live_like_invoices(db, org, customers):
    """Mirror the production scenario: a big DRAFT, a smaller SENT, a PAID,
    and a CANCELLED invoice. Billed revenue must be 500 + 200 = 700; drafts
    and cancelled never count."""
    draft = add_invoice(db, org, customers["go"].id, "INV-DRAFT-5000", InvoiceStatus.DRAFT, 5000)
    sent = add_invoice(db, org, customers["go"].id, "INV-SENT-500", InvoiceStatus.SENT, 500)
    paid = add_invoice(db, org, customers["acme"].id, "INV-PAID-200", InvoiceStatus.PAID, 200, paid="200")
    cancelled = add_invoice(db, org, customers["acme"].id, "INV-CANC-999", InvoiceStatus.CANCELLED, 999)
    return {"draft": draft, "sent": sent, "paid": paid, "cancelled": cancelled}


class HostileGateway:
    """Simulates a model classifier that confidently answers the WRONG thing."""

    def __init__(self, payload):
        self.payload = payload

    def complete(self, **kwargs):
        class R:
            content = json.dumps(self.payload)
            def content_hash(self):
                return "hostile"
            usage = {"latency_ms": 5}
        return R()


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE A — Figures agree everywhere (chatbot == dashboard service == DB math)
# ═══════════════════════════════════════════════════════════════════════════════

class TestFigureAgreement:
    """T05 guardrail: one canonical definition, three agreeing surfaces."""

    def test_kpis_billed_revenue_excludes_draft_and_cancelled(self, db, org, customers, live_like_invoices):
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        # Billed = SENT 500 + PAID 200. Draft 5000 and cancelled 999 excluded.
        assert abs(kpis["total_revenue"] - 700.0) < 0.01, (
            f"Expected billed revenue 700.0, got {kpis['total_revenue']}"
        )

    def test_kpis_paid_revenue_is_paid_only(self, db, org, customers, live_like_invoices):
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        assert abs(kpis["paid_revenue"] - 200.0) < 0.01

    def test_kpis_invoice_count_excludes_draft(self, db, org, customers, live_like_invoices):
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        assert kpis["total_invoices"] == 2, (
            f"Expected 2 non-draft invoices, got {kpis['total_invoices']}"
        )

    def test_kpis_outstanding_matches_sent_balance(self, db, org, customers, live_like_invoices):
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        assert abs(kpis["outstanding_amount"] - 500.0) < 0.01

    def test_chatbot_total_revenue_equals_dashboard_kpi(self, db, org, ctx, customers, live_like_invoices):
        """The exact reported failure: 'Total Revenue' must return the SAME
        figure as the dashboard KPI — as a single figure, not an overview."""
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-rev")

        intent = engine._classify_intent(conv, "Total Revenue", ctx)
        assert intent["intent"] == "metric_revenue", (
            f"'Total Revenue' classified as {intent['intent']}, expected metric_revenue"
        )
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "Total Revenue", intent, ctx)

        assert "Financial overview" not in result["answer"], (
            "'Total Revenue' returned the full overview instead of the figure"
        )
        assert money(kpis["total_revenue"]) in result["answer"], (
            f"Chatbot figure missing from answer; expected {money(kpis['total_revenue'])} "
            f"(KPI={kpis['total_revenue']}) in: {result['answer']}"
        )

    def test_chatbot_invoice_count_equals_kpi_count(self, db, org, ctx, customers, live_like_invoices):
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-count")

        intent = engine._classify_intent(conv, "How many invoices are there?", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "How many invoices are there?", intent, ctx)

        assert str(kpis["total_invoices"]) in result["answer"], (
            f"Count answer '{result['answer']}' does not carry KPI count {kpis['total_invoices']}"
        )

    def test_chatbot_outstanding_equals_kpi_outstanding(self, db, org, ctx, customers, live_like_invoices):
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-bal")

        intent = engine._classify_intent(conv, "What's my outstanding balance?", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "What's my outstanding balance?", intent, ctx)

        assert money(kpis["outstanding_amount"]) in result["answer"], (
            f"Outstanding answer does not carry KPI value {money(kpis['outstanding_amount'])}: "
            f"{result['answer']}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE B/C — Rules-level intent routing (PRD §09 taxonomy phrasings)
# ═══════════════════════════════════════════════════════════════════════════════

class TestRulesIntentRouting:
    @pytest.mark.parametrize("phrase,expected_intent", [
        ("product Dashboard", "product_dashboard"),
        ("products overview", "product_dashboard"),
        ("Total Revenue", "metric_revenue"),
        ("How much revenue do we have?", "metric_revenue"),
        ("What are the valid invoice statuses?", "explain_statuses"),
        ("Change the due date to net 30.", "action_draft"),
        ("Update the amount on INV-1042", "action_draft"),
        ("Customer was overcharged.", "correct_request"),
        ("We charged them twice.", "correct_request"),
        ("Remind them this is overdue.", "communicate_request"),
        ("Send a follow-up about the invoice", "communicate_request"),
        ("Export unpaid invoices for Europe.", "export_request"),
        ("Download the invoice list as csv", "export_request"),
        ("Refund the duplicate payment.", "action_draft"),
        ("Match this $5,000 payment.", "help_reconciliation"),
        ("Do we have any unmatched payments?", "help_reconciliation"),
    ])
    def test_routes_to_expected_intent(self, db, phrase, expected_intent):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._rules_classify_intent(phrase)
        assert result["intent"] == expected_intent, (
            f"'{phrase}' routed to {result['intent']} (conf={result.get('confidence')}), "
            f"expected {expected_intent}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# End-to-end: classify -> dispatch -> handler output
# ═══════════════════════════════════════════════════════════════════════════════

class TestEndToEndAnswers:
    def test_product_dashboard_returns_catalog_not_financial_dump(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-proddash")

        intent = engine._classify_intent(conv, "product Dashboard", ctx)
        assert intent["intent"] == "product_dashboard"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "product Dashboard", intent, ctx)

        assert "Financial overview" not in result["answer"]
        assert "catalog" in result["answer"].lower()

    def test_valid_statuses_returns_status_list_not_audit(self, db, org, ctx, kb):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-status")

        intent = engine._classify_intent(conv, "What are the valid invoice statuses?", ctx)
        assert intent["intent"] == "explain_statuses"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "What are the valid invoice statuses?", intent, ctx)

        low = result["answer"].lower()
        assert "draft" in low and "partially paid" in low
        assert "audit" not in low and "unallocated" not in low

    def test_ambiguous_qualified_dashboard_clarifies(self, db, org, ctx):
        """D-11: 'team dashboard' is ambiguous → ask, don't guess."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-teamdash")

        intent = engine._classify_intent(conv, "team dashboard", ctx)
        assert intent["domain"] == "clarify", (
            f"Ambiguous surface request did not clarify: routed to {intent['domain']}/{intent['intent']}"
        )
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "team dashboard", intent, ctx)
        assert "did you mean" in result["answer"].lower()

    def test_correct_request_guides_instead_of_guessing(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-correct")

        intent = engine._classify_intent(conv, "Customer was overcharged.", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "Customer was overcharged.", intent, ctx)

        assert "credit note" in result["answer"].lower()

    def test_export_request_does_not_silently_list(self, db, org, ctx, customers, live_like_invoices):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-export")

        intent = engine._classify_intent(conv, "Export unpaid invoices for Europe.", ctx)
        assert intent["intent"] == "export_request"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "Export unpaid invoices for Europe.", intent, ctx)

        assert "export" in result["answer"].lower()


# ═══════════════════════════════════════════════════════════════════════════════
# D-11 Safe uncertainty — hostile / disagreeing model classifier
# ═══════════════════════════════════════════════════════════════════════════════

class TestD11SafeUncertainty:
    def _conv(self, db, org, uid):
        return make_conv(db, org, uid=uid)

    def test_specific_rules_beat_confident_wrong_model(self, db, org, ctx, customers):
        """Model confidently claims a generic lookup for a customer-count
        question — the specific rules intent must win (no unrelated dumps)."""
        engine = ConversationEngine(db, model_gateway=None)
        engine._gateway = HostileGateway(
            {"domain": "billing", "intent": "general_billing_lookup", "confidence": 0.99}
        )
        conv = self._conv(db, org, "test-conv-hijack-count")

        intent = engine._classify_intent(conv, "How many customers are there?", ctx)
        assert intent["intent"] == "customer_count", (
            f"Hostile model hijacked routing to {intent['intent']}"
        )
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "How many customers are there?", intent, ctx)
        assert "customer" in result["answer"].lower()

    def test_specific_rules_beat_model_on_statuses(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        engine._gateway = HostileGateway(
            {"domain": "billing", "intent": "general_billing_lookup", "confidence": 0.98}
        )
        conv = self._conv(db, org, "test-conv-hijack-status")

        intent = engine._classify_intent(conv, "What are the valid invoice statuses?", ctx)
        assert intent["intent"] == "explain_statuses"

    def test_disagreeing_weak_sources_trigger_clarify(self, db, org, ctx):
        """Rules say fallback-help, model weakly says dashboard → CLARIFY."""
        engine = ConversationEngine(db, model_gateway=None)
        engine._gateway = HostileGateway(
            {"domain": "dashboard", "intent": "dashboard_summary", "confidence": 0.6}
        )
        conv = self._conv(db, org, "test-conv-clarify-weak")

        intent = engine._classify_intent(conv, "hmm interesting", ctx)
        assert intent["domain"] == "clarify", (
            f"Weak disagreement answered anyway: {intent['domain']}/{intent['intent']}"
        )

    def test_strong_model_beats_fallback_rules(self, db, org, ctx):
        """A confident model classification may win over a fallback-level
        rules result — otherwise the assistant could never improve."""
        engine = ConversationEngine(db, model_gateway=None)
        engine._gateway = HostileGateway(
            {"domain": "dashboard", "intent": "dashboard_summary", "confidence": 0.9}
        )
        conv = self._conv(db, org, "test-conv-strong-model")

        intent = engine._classify_intent(conv, "hmm interesting", ctx)
        assert intent["intent"] == "dashboard_summary"


# ═══════════════════════════════════════════════════════════════════════════════
# Definitional questions about financial metrics
# ═══════════════════════════════════════════════════════════════════════════════

class TestDefinitionalRouting:
    """'Explain me about Revenue' asks WHAT the metric means — the answer must
    lead with the DEFINITION and compose the live figure second. Never a bare
    number hijack (metric_revenue), never an abstention (help_general/RAG).
    Live-data phrasings must keep their existing routes."""

    def _seed(self, db, org, customers):
        add_invoice(db, org, customers["go"].id, "INV-DEF-1", InvoiceStatus.PAID,
                    1000, paid="1000", due_offset_days=30)
        add_invoice(db, org, customers["acme"].id, "INV-DEF-2", InvoiceStatus.SENT,
                    500, due_offset_days=-10)

    def _ask(self, db, org, ctx, phrase):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, f"def-{abs(hash(phrase))}")
        intent = engine._classify_intent(conv, phrase, ctx)
        handler = engine._get_handler(intent["domain"])
        return intent, handler(conv, phrase, intent, ctx)

    @pytest.mark.parametrize("phrase", [
        "explain me about Revenue",
        "explain Revenue",
        "What is Revenue?",
        "What does Revenue mean?",
        "meaning of revenue",
        "how is revenue calculated?",
    ])
    def test_revenue_definitions_route_to_metric_definition(self, db, org, ctx, customers, phrase):
        self._seed(db, org, customers)
        intent, result = self._ask(db, org, ctx, phrase)
        assert intent["intent"] == "metric_definition", (
            f"{phrase!r}: got {intent['intent']}"
        )
        answer = result["answer"].lower()
        assert "revenue is" in answer or "calculated by" in answer, (
            f"{phrase!r}: no definition in answer: {result['answer'][:160]!r}"
        )
        # Live figure composed SECOND — definition leads.
        assert answer.index("revenue is") < answer.rindex("current"), (
            f"{phrase!r}: definition must precede the live figure"
        )

    def test_outstanding_definition(self, db, org, ctx, customers):
        self._seed(db, org, customers)
        intent, result = self._ask(db, org, ctx, "explain me about Outstanding")
        assert intent["intent"] == "metric_definition"
        answer = result["answer"].lower()
        assert "still owe" in answer
        assert "500.00" in answer  # live outstanding from the SENT invoice

    def test_overdue_definition_not_live_lookup_hijack(self, db, org, ctx, customers):
        """'explain me about Overdue' used to hit the direct-entity lookup and
        return an account-balance dump."""
        self._seed(db, org, customers)
        intent, result = self._ask(db, org, ctx, "explain me about Overdue")
        assert intent["intent"] == "metric_definition", intent
        answer = result["answer"].lower()
        assert "due date has passed" in answer
        assert "account balance" not in answer

    def test_mrr_definition_without_live_figure(self, db, org, ctx, customers):
        self._seed(db, org, customers)
        intent, result = self._ask(db, org, ctx, "What is MRR?")
        assert intent["intent"] == "metric_definition"
        answer = result["answer"].lower()
        assert "monthly recurring revenue" in answer or "mrr" in answer
        assert "don't report a live figure" in answer or "do not report a live figure" in answer

    # ── Regressions: these must NOT be intercepted ────────────────────────

    def test_bare_kpi_name_stays_data_only(self, db, org, ctx, customers):
        """'Total Revenue' (no question shape) keeps returning ONLY the figure."""
        self._seed(db, org, customers)
        intent, result = self._ask(db, org, ctx, "Total Revenue")
        assert intent["intent"] == "metric_revenue", intent
        assert intent["domain"] == "dashboard"
        answer = result["answer"].lower().strip()
        assert answer.startswith("total revenue is **"), result["answer"]
        assert "calculated" not in answer

    def test_invoice_reference_question_stays_search(self, db, org, ctx, customers):
        self._seed(db, org, customers)
        intent, _ = self._ask(db, org, ctx, "What is INV-2024-0001?")
        assert intent["intent"] == "invoice_search", intent

    def test_possessive_balance_stays_account_balance(self, db, org, ctx, customers):
        self._seed(db, org, customers)
        intent, _ = self._ask(db, org, ctx, "What's my outstanding balance?")
        assert intent["intent"] == "account_balance", intent

    def test_status_semantics_stay_with_status_handlers(self, db, org, ctx, customers):
        """Status-meaning questions must reach a status-definition handler and
        never be intercepted as a metric definition."""
        self._seed(db, org, customers)
        intent, result = self._ask(db, org, ctx, "What does 'Delivered' mean for invoice status?")
        assert intent["intent"] in ("general_billing_lookup", "help_general"), intent
        assert "not a valid invoice status" in result["answer"].lower()

    def test_non_metric_knowledge_stays_rag(self, db, org, ctx, customers):
        self._seed(db, org, customers)
        for phrase in ("What is a quotation?", "How do refunds work?",
                       "Explain subscription billing cycles"):
            intent, _ = self._ask(db, org, ctx, phrase)
            assert intent["intent"] == "help_general", (
                f"{phrase!r}: routed to {intent['intent']} instead of help_general"
            )
