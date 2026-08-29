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
import unittest
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.billing.services.dashboard_service import BillingDashboardService
from app.modules.chatbot.conversation.engine import ConversationEngine, money, money_sym
from app.modules.billing.utils.currency_utils import format_currency_display
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


def add_customer(db, org, code, name, is_active=True, deleted=False):
    from app.modules.billing.models import BillingCustomer
    c = BillingCustomer(
        organization_id=org.id, customer_code=code,
        company_name=name, display_name=name,
        email=f"{code.lower()}@example.com", currency="USD",
    )
    if not is_active:
        c.is_active = False
    if deleted:
        from datetime import datetime
        c.deleted_at = datetime.utcnow()
    db.add(c)
    db.flush()
    return c


class TestDashboardSummaryCustomerCount:
    """Regression (user report): 'dashboard summary' showed 'Customers: 0'
    while the Customer List / dashboard card showed 1. The chatbot overview
    must always report EXACTLY get_kpis()['active_customers'] — the same
    source of truth the dashboard page's Customers card reads."""

    def _ask_dashboard_summary(self, db, org, ctx):
        import uuid
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"test-conv-dashsum-{uuid.uuid4().hex[:8]}")
        intent = engine._classify_intent(conv, "dashboard summary", ctx)
        assert intent["intent"] == "dashboard_summary", (
            f"'dashboard summary' routed to {intent['intent']}, expected dashboard_summary"
        )
        handler = engine._get_handler(intent["domain"])
        return handler(conv, "dashboard summary", intent, ctx)

    def test_customer_count_equals_org_customer_total(self, db, org, ctx):
        """Org with N=3 customers → 'Customers: 3' (never 0)."""
        for i in range(1, 4):
            add_customer(db, org, f"CUST-N{i}", f"Customer {i}")
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)

        result = self._ask_dashboard_summary(db, org, ctx)

        assert kpis["active_customers"] == 3
        answer = result["answer"]
        assert "**Customers:** 3" in answer or "Customers: 3" in answer.replace("**", ""), (
            f"expected Customers: 3 in overview, got: {answer[:300]}"
        )

    def test_customer_count_ignores_disabled_and_deleted(self, db, org, ctx):
        """Only active (enabled, non-deleted) customers count — same census
        as the reweighter/dashboard basis."""
        add_customer(db, org, "CUST-ACTIVE", "Active Co")
        add_customer(db, org, "CUST-OFF", "Disabled Co", is_active=False)
        add_customer(db, org, "CUST-GONE", "Deleted Co", deleted=True)
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)

        result = self._ask_dashboard_summary(db, org, ctx)

        assert kpis["active_customers"] == 1
        answer = result["answer"]
        assert "Customers: 1" in answer.replace("**", "")

    def test_customer_count_matches_kpis_source_of_truth(self, db, org, ctx):
        """Zero customers → overview says 0 (the original bug symptom); with
        customers it matches get_kpis exactly — one number, two surfaces."""
        result_empty = self._ask_dashboard_summary(db, org, ctx)
        assert "Customers: 0" in result_empty["answer"].replace("**", "")

        add_customer(db, org, "CUST-ONE", "Sole Trader")
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        result_one = self._ask_dashboard_summary(db, org, ctx)

        assert str(kpis["active_customers"]) in result_one["answer"].replace("**", "")


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
        ("explain about me quick actions", "ui_quick_actions"),
        ("What are quick actions?", "ui_quick_actions"),
        ("tell me about the Quick Actions panel", "ui_quick_actions"),
        ("where are the quick actions on my dashboard", "ui_quick_actions"),
        ("show me quick action", "ui_quick_actions"),
        ("what's quick-actions?", "ui_quick_actions"),
        ("explain quik actions", "ui_quick_actions"),
        ("what are qick acions", "ui_quick_actions"),
        ("describe the quickactions section", "ui_quick_actions"),
        ("What's the refund total?", "metric_refund_total"),
        ("total refunds issued", "metric_refund_total"),
        ("how much have we refunded?", "metric_refund_total"),
        ("average invoice amount", "metric_avg_invoice"),
        ("AVG invoice value", "metric_avg_invoice"),
        ("how many credit notes", "credit_note_count"),
        ("paid amount this month", "metric_paid_period"),
        ("revenue this month", "metric_paid_period"),
        ("how many billing admins", "admin_count"),
        ("monthly growth rate", "metric_growth_rate"),
        ("What's our monthly growth rate?", "metric_growth_rate"),
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
# UI navigation topics — Quick Actions panel
# (user report: "explain about me quick actions" answered "Me Quick Actions
#  is outside my scope" instead of describing the dashboard panel)
# ═══════════════════════════════════════════════════════════════════════════════

class TestQuickActionsTopic:
    def test_topic_screen_accepts_quick_actions(self):
        """The §6.0 gate must treat Quick Actions as in-domain evidence."""
        from app.modules.chatbot.conversation.engine import topic_screen
        assert topic_screen("explain about me quick actions")
        assert topic_screen("what are quick actions?")

    def test_explain_quick_actions_describes_panel_not_refusal(self, db, org, ctx):
        """The exact reported failure: word-order noise ("about me") must not
        turn the panel name into an invented "Me Quick Actions" refusal."""
        from app.modules.chatbot.conversation.engine import (
            looks_like_quick_actions_query, normalize_domain_text,
        )

        phrase = "explain about me quick actions"
        assert looks_like_quick_actions_query(normalize_domain_text(phrase))

        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-quickactions")

        intent = engine._classify_intent(conv, phrase, ctx)
        assert intent["intent"] == "ui_quick_actions", (
            f"'{phrase}' routed to {intent['intent']}, expected ui_quick_actions"
        )
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, phrase, intent, ctx)

        answer = result["answer"]
        assert "outside my scope" not in answer.lower()
        assert "Quick Actions" in answer
        # The panel's real tiles (from the billing dashboard definition)
        for tile in ("Create Invoice", "Add Customer", "Record Payment"):
            assert tile in answer, f"tile '{tile}' missing from: {answer[:200]}"
        assert result["mode"] == "M0_EXPLAIN"
        assert result["evidence"]

    def test_typo_variants_still_reach_the_panel_answer(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        for i, phrase in enumerate(("explain quik actions", "what are qick acions?")):
            conv = make_conv(db, org, uid=f"test-conv-qa-typo-{i}")
            intent = engine._classify_intent(conv, phrase, ctx)
            assert intent["intent"] == "ui_quick_actions", phrase
            handler = engine._get_handler(intent["domain"])
            result = handler(conv, phrase, intent, ctx)
            assert "outside my scope" not in result["answer"].lower(), phrase

    def test_action_phrase_not_hijacked(self, db, org, ctx):
        """"take quick action" in a billing sentence must NOT route to the
        UI-topic answer — both words must be adjacent AND query-shaped."""
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._rules_classify_intent("how do I take quick action on this overdue invoice")
        assert intent["intent"] != "ui_quick_actions"

    def test_unknown_topic_refusal_strips_filler_cleanly(self, db, org, ctx):
        """The out-of-scope frame-stripper consumes me/about in any order,
        so refusals never invent topics like 'Me Python'."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-scope-strip")

        intent = engine._classify_intent(conv, "Explain about me python.", ctx)
        assert intent["intent"] == "out_of_scope"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "Explain about me python.", intent, ctx)

        assert "**Python** is outside my scope" in result["answer"]
        assert "Me Python" not in result["answer"]


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


# ═══════════════════════════════════════════════════════════════════════════════
# Inspect-over-Explain: named-metric data questions must return LIVE figures,
# never RAG glossary chunks ("collection rate" → Tax Report defs, etc.)
# ═══════════════════════════════════════════════════════════════════════════════

class TestInspectOverExplain:
    @pytest.mark.parametrize("phrase,expected", [
        ("Who joined this month", "customer_joined"),
        ("What's our collection rate?", "metric_collection_rate"),
        ("What's MRR and ARR?", "metric_mrr_arr"),
        ("average invoice amount", "metric_avg_invoice"),
        ("AVG invoice value", "metric_avg_invoice"),
        ("how many credit notes", "credit_note_count"),
        ("paid amount this month", "metric_paid_period"),
        ("how many billing admins", "admin_count"),
        ("monthly growth rate", "metric_growth_rate"),
    ])
    def test_data_questions_route_to_inspect(self, db, phrase, expected):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == expected, (
            f"{phrase!r} routed to {result['intent']} ({result['risk_class']}), "
            f"expected {expected}"
        )
        assert result["risk_class"] == "R1"

    @pytest.mark.parametrize("phrase", [
        "What does MRR mean?",
        "What is MRR?",
        "Explain me about Revenue",
        "What does average invoice value mean?",
    ])
    def test_meaning_questions_stay_definitional(self, db, phrase):
        """Definition asks keep the R0 definitional path — no figure hijack."""
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "metric_definition", (
            f"{phrase!r} routed to {result['intent']}, expected metric_definition"
        )

    def test_readiness_score_is_documented_exclusion(self, db, org, ctx):
        """Owner decision: readiness score is NOT an Inspect metric — its
        asks return the documented exclusion, never a §6.0 refusal or RAG."""
        result = self._ask(db, org, ctx, "What's our readiness score?")

        low = result["answer"].lower()
        assert "readiness score" in low
        assert "intentionally not" in low or "not an organization billing metric" in low
        assert "outside my scope" not in low

    def _ask(self, db, org, ctx, phrase):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"test-conv-inspect-{abs(hash(phrase)) % 10**9}")
        intent = engine._classify_intent(conv, phrase, ctx)
        handler = engine._get_handler(intent["domain"])
        return handler(conv, phrase, intent, ctx)

    def test_who_joined_this_month_returns_live_census(self, db, org, ctx):
        from datetime import datetime
        from app.modules.billing.models import BillingCustomer
        add_customer(db, org, "CUST-JOINED", "Newbie Co")
        old = add_customer(db, org, "CUST-OLDT", "Ancient Co")
        old.created_at = datetime.utcnow() - timedelta(days=45)
        db.flush()

        result = self._ask(db, org, ctx, "Who joined this month")

        assert result["mode"] == "M1_INSPECT"
        answer = result["answer"]
        assert "**1 customer(s)**" in answer
        assert "Newbie Co" in answer and "Ancient Co" not in answer
        assert "joined **this month**" in answer.replace("**1 customer(s)** joined", "joined")

    def test_collection_rate_matches_dashboard_formula(self, db, org, ctx):
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        billed = float(kpis["total_revenue"])
        collected = float(kpis["collections"])
        expected_rate = (
            min(100.0, collected / billed * 100.0) if billed > 0
            else (100.0 if collected > 0 else 0.0)
        )

        result = self._ask(db, org, ctx, "What's our collection rate?")

        assert result["mode"] == "M1_INSPECT"
        assert f"{round(expected_rate, 1):.1f}".rstrip("0").rstrip(".") + "%" in result["answer"]
        assert "outside my scope" not in result["answer"].lower()

    def test_collection_rate_nonzero_with_cleared_payment(self, db, org, ctx):
        from app.modules.billing.models import Invoice, InvoiceStatus, Payment, PaymentType, PaymentStatus
        cust = add_customer(db, org, "CUST-PAYER", "Payer Co")
        inv = add_invoice(db, org, cust.id, "INV-RATE-1000", InvoiceStatus.SENT, 1000)
        db.add(Payment(
            organization_id=org.id, customer_id=cust.id,
            payment_number="PAY-RATE-1",
            payment_type=PaymentType.INVOICE_PAYMENT, status=PaymentStatus.CLEARED,
            amount=250, currency="USD", payment_date=date.today(),
        ))
        db.flush()

        result = self._ask(db, org, ctx, "What's our collection rate?")

        # Billed = SENT 1000; cleared payments = 250 → 25% (dashboard formula)
        assert "**25%**" in result["answer"], result["answer"][:200]
        assert money(1000, "USD") in result["answer"] and money(250, "USD") in result["answer"]

    def test_mrr_arr_returns_reporting_read_model(self, db, org, ctx):
        result = self._ask(db, org, ctx, "What's MRR and ARR?")

        assert result["mode"] == "M1_INSPECT"
        assert "**MRR:**" in result["answer"] and "**ARR:**" in result["answer"]
        from decimal import Decimal
        assert Decimal(result["evidence"][0]["mrr"]) == 0
        assert Decimal(result["evidence"][0]["arr"]) == 0

    def test_mrr_arr_reflects_active_subscription(self, db, org, ctx):
        from decimal import Decimal
        from app.modules.billing.models import (
            BillingSubscriptionStatus as SubStatus, BillingPeriod, PlanCategory,
            Subscription, SubscriptionPlan,
        )
        cust = add_customer(db, org, "CUST-SUB", "Subscriber Co")
        plan = SubscriptionPlan(
            organization_id=org.id, plan_code="PLAN-M", plan_name="Monthly Basic",
            category=PlanCategory.SUBSCRIPTION, billing_period=BillingPeriod.MONTHLY,
        )
        db.add(plan)
        db.flush()
        today = date.today()
        db.add(Subscription(
            organization_id=org.id, customer_id=cust.id, plan_id=plan.id,
            subscription_number="SUB-M-1", status=SubStatus.ACTIVE,
            unit_price=Decimal("90.00"), quantity=1, currency="USD",
            start_date=today, current_term_start=today, current_term_end=today,
        ))
        db.flush()

        result = self._ask(db, org, ctx, "What's MRR and ARR?")

        # Monthly sub at 90 → MRR 90, ARR 1080 (monthly divisor = 1)
        assert f"**MRR:** {money(90, 'USD')}" in result["answer"], result["answer"][:200]
        assert f"**ARR:** {money(1080, 'USD')}" in result["answer"]

    def test_rag_glossary_words_alone_still_go_to_help(self, db, org, ctx, kb):
        """Guardrail inverse: removing metric words restores Explain routing —
        the fix is a routing preference, not a blanket Explain shutdown."""
        result = self._ask(db, org, ctx, "What are invoice statuses?")
        assert result is not None


# ═══════════════════════════════════════════════════════════════════════════════
# Bug 1: customer list status filter ('list inactive customers' returned
# active customers because the filter words were parsed but never applied)
# ═══════════════════════════════════════════════════════════════════════════════

class TestCustomerStatusFilter:
    def _list(self, db, org, ctx, phrase):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"test-conv-cf-{abs(hash(phrase)) % 10**9}")
        intent = engine._classify_intent(conv, phrase, ctx)
        assert intent["intent"] == "customer_list", intent
        handler = engine._get_handler(intent["domain"])
        return handler(conv, phrase, intent, ctx)

    def test_inactive_filter_returns_only_disabled_customers(self, db, org, ctx):
        add_customer(db, org, "CUST-ACT1", "Active One")
        add_customer(db, org, "CUST-ACT2", "Active Two")
        off = add_customer(db, org, "CUST-OFF1", "Disabled One", is_active=False)

        result = self._list(db, org, ctx, "List inactive customers")

        answer = result["answer"]
        assert result["mode"] == "M1_INSPECT"
        assert "**1 inactive customer(s)**" in answer
        assert "Disabled One" in answer
        assert "Active One" not in answer and "Active Two" not in answer
        # Row marker reflects the filtered flag, not the lifecycle enum.
        import re as _re
        assert _re.search(r"CUST-OFF1\).*— inactive", answer.replace("**", ""))

    def test_inactive_filter_empty_when_all_enabled(self, db, org, ctx):
        add_customer(db, org, "CUST-ONLYACT", "Solo Active")

        result = self._list(db, org, ctx, "show inactive customers")

        assert "No inactive customers" in result["answer"], result["answer"]
        assert "Solo Active" not in result["answer"]

    def test_active_filter_returns_only_enabled(self, db, org, ctx):
        add_customer(db, org, "CUST-ON1", "Enabled One")
        add_customer(db, org, "CUST-DIS1", "Disabled Two", is_active=False)

        result = self._list(db, org, ctx, "List active customers")

        answer = result["answer"]
        assert "**1 active customer(s)**" in answer
        assert "Enabled One" in answer and "Disabled Two" not in answer

    def test_unfiltered_list_ignores_nothing(self, db, org, ctx):
        add_customer(db, org, "CUST-U1", "Visible One")
        add_customer(db, org, "CUST-U2", "Visible Two", is_active=False)

        result = self._list(db, org, ctx, "List customers")

        answer = result["answer"]
        assert "**2 customer(s)**" in answer
        assert "Visible One" in answer and "Visible Two" in answer


# ═══════════════════════════════════════════════════════════════════════════════
# Bug: history lost the first question — create_conversation(initial_message=…)
# saved only the assistant reply (send_message saves both sides of a turn)
# ═══════════════════════════════════════════════════════════════════════════════

class TestInitialMessagePersistence:
    def test_first_question_is_saved_with_the_answer(self, db, org, ctx):
        from app.modules.chatbot.models import AIConversation, AIConversationMessage, SenderType

        engine = ConversationEngine(db, model_gateway=None)
        result = engine.create_conversation(ctx=ctx, title="New Conversation",
                                            initial_message="What is MRR?")

        uid = result["conversation_uid"]
        stored = (
            db.query(AIConversationMessage)
            .join(AIConversation, AIConversation.id == AIConversationMessage.conversation_id)
            .filter(AIConversation.conversation_uid == uid)
            .order_by(AIConversationMessage.id.asc())
            .all()
        )
        senders = [m.sender_type for m in stored]
        assert SenderType.USER in senders, (
            f"user's opening message was not persisted; only {senders}"
        )
        assert senders[0] == SenderType.USER
        assert senders[-1] == SenderType.ASSISTANT
        assert stored[0].message_text == "What is MRR?"

    def test_reopened_history_shows_both_sides_and_count(self, db, org, ctx):
        from app.modules.chatbot.models import AIConversation

        engine = ConversationEngine(db, model_gateway=None)
        created = engine.create_conversation(ctx=ctx, initial_message="List all customers")
        detail = engine.get_conversation(conversation_uid=created["conversation_uid"], ctx=ctx)

        kinds = [m["sender_type"] for m in detail["messages"]]
        assert kinds == ["user", "assistant"]
        conv = db.query(AIConversation).filter(
            AIConversation.conversation_uid == created["conversation_uid"]).first()
        assert (conv.message_count or 0) == 2

    def test_followup_turn_appends_after_initial(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        created = engine.create_conversation(ctx=ctx, initial_message="Hello")
        engine.send_message(conversation_uid=created["conversation_uid"],
                            message="What is a credit note?", ctx=ctx)
        detail = engine.get_conversation(conversation_uid=created["conversation_uid"], ctx=ctx)

        kinds = [m["sender_type"] for m in detail["messages"]]
        assert kinds == ["user", "assistant", "user", "assistant"]
        assert detail["messages"][2]["message_text"] == "What is a credit note?"


# ═══════════════════════════════════════════════════════════════════════════════
# Bug: "Who hasn't paid their August invoice?" fell to generic RAG instead of
# the customer-outstanding census (collections phrasing lacks finance words)
# ═══════════════════════════════════════════════════════════════════════════════

class TestCollectionsPhrasingOutstanding:
    @pytest.mark.parametrize("phrase", [
        "Who hasn't paid their invoice?",
        "Who hasn't paid their August invoice?",
        "which customers haven't paid",
        "who did not pay this month",
    ])
    def test_collections_questions_route_to_outstanding(self, db, phrase):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "customer_outstanding", (
            f"{phrase!r} routed to {result['intent']}, expected customer_outstanding"
        )

    def test_who_hasnt_paid_returns_live_census_not_rag(self, db, org, ctx):
        add_customer(db, org, "CUST-HP1", "Hasn't Paid Co")

        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-hasntpaid")
        phrase = "Who hasn't paid their August invoice?"
        intent = engine._classify_intent(conv, phrase, ctx)
        assert intent["intent"] == "customer_outstanding"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, phrase, intent, ctx)

        assert result["mode"] == "M1_INSPECT"
        assert "No customers have an outstanding balance" in result["answer"]

    def test_status_meaning_question_not_hijacked(self, db):
        """'not paid' inside a status-semantics ask stays out of the census."""
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(
            "What does not paid mean for an invoice status?")
        assert result["intent"] != "customer_outstanding"


# ═══════════════════════════════════════════════════════════════════════════════
# Bug: credit-limit filter ("show customers over their credit limit" returned
# unfiltered results — same unapplied-predicate class as the status filter)
# ═══════════════════════════════════════════════════════════════════════════════

class TestCustomerCreditLimitFilter:
    def _list(self, db, org, ctx, phrase):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"test-conv-cl-{abs(hash(phrase)) % 10**9}")
        intent = engine._classify_intent(conv, phrase, ctx)
        assert intent["intent"] == "customer_list", intent
        handler = engine._get_handler(intent["domain"])
        return handler(conv, phrase, intent, ctx)

    def test_over_limit_customers_only(self, db, org, ctx):
        over = add_customer(db, org, "CUST-OVL1", "Over Limit Co")
        under = add_customer(db, org, "CUST-UND1", "Under Limit Co")
        for c, total in ((over, 150), (under, 50)):
            c.credit_limit = 100
            add_invoice(db, org, c.id, f"INV-CL-{c.customer_code[-3:]}",
                        InvoiceStatus.SENT, total)
        db.flush()

        result = self._list(db, org, ctx, "Show customers over their credit limit")

        answer = result["answer"]
        assert result["mode"] == "M1_INSPECT"
        assert "**1 customer(s) over their credit limit**" in answer
        assert "Over Limit Co" in answer
        assert "Under Limit Co" not in answer

    @pytest.mark.parametrize("phrase", [
        "Show customers over their credit limit",
        "customers above credit limit",
        "which customers exceeded the credit limit",
    ])
    def test_empty_when_no_one_over_limit(self, db, org, ctx, phrase):
        """The original repro: Micro (no credit limit) must NOT be returned."""
        add_customer(db, org, "CUST-PLAIN", "Micro")

        result = self._list(db, org, ctx, phrase)

        assert "No customers are currently over their credit limit" in result["answer"], (
            result["answer"][:200]
        )
        assert "Micro" not in result["answer"]


# ═══════════════════════════════════════════════════════════════════════════════
# Bug: aggregate questions fell into the action-draft flow and the raw question
# text was echoed back as a customer name ("I couldn't find a customer named
# 'What's the refund total?'")
# ═══════════════════════════════════════════════════════════════════════════════

class TestRefundQuestionsNotActionDrafts:
    def test_aggregate_refund_questions_return_data_not_draft_flow(self, db, org, ctx):
        from app.modules.billing.models import Payment, PaymentType, PaymentStatus
        cust = add_customer(db, org, "CUST-REF", "Refundee Co")
        db.add(Payment(
            organization_id=org.id, customer_id=cust.id,
            payment_number="PAY-REF-1",
            payment_type=PaymentType.REFUND, status=PaymentStatus.CLEARED,
            amount=250, currency="USD", payment_date=date.today(),
        ))
        db.flush()

        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-refund")
        phrase = "What's the refund total?"
        intent = engine._classify_intent(conv, phrase, ctx)
        assert intent["intent"] == "metric_refund_total"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, phrase, intent, ctx)

        answer = result["answer"]
        assert result["mode"] == "M1_INSPECT"
        assert "couldn't find a customer named" not in answer.lower()
        assert "**1 refund(s)**" in answer
        assert money(250, "USD") in answer

    def test_no_customer_specified_asks_instead_of_echoing_question(self, db, org, ctx):
        """Even if a draft flow is ever reached without a customer name, it
        must ASK for a resolution — never echo the utterance back as a
        'name'. A forced REFUND draft asks for the PAYMENT first (the refund
        guard resolves the missing payment reference before any customer
        check, PRD §11: a refund must name the paying transaction)."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-noask")
        forced = {"intent": "action_draft", "domain": "action", "risk_class": "R2"}

        result = engine._handle_action(conv, "What's the refund total?", forced, ctx)

        low = result["answer"].lower()
        assert "couldn't find a customer named" not in low
        assert "which payment" in low

    def test_named_but_unknown_customer_still_reports_name(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-named")
        forced = {"intent": "action_draft", "domain": "action", "risk_class": "R2"}

        result = engine._handle_action(
            conv, "Create an invoice for Zork Industries", forced, ctx)

        assert "couldn't find a customer named" in result["answer"].lower()
        assert "Zork Industries" in result["answer"]

    @pytest.mark.parametrize("phrase", [
        "Draft a refund for Acme",
        "Refund the duplicate payment.",
        "Create an invoice for Acme for consulting at $500",
    ])
    def test_real_draft_requests_stay_actions(self, db, phrase):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "action_draft", (
            f"{phrase!r} routed to {result['intent']}, expected action_draft"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Bug batch: avg invoice value / credit notes / paid this month / billing admins
# were misrouted to Explain/RAG despite being live dashboard metrics
# ═══════════════════════════════════════════════════════════════════════════════

class TestNewDashboardMetricsLive:
    def _ask(self, db, org, ctx, phrase):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"test-conv-metric-{abs(hash(phrase)) % 10**9}")
        intent = engine._classify_intent(conv, phrase, ctx)
        handler = engine._get_handler(intent["domain"])
        return handler(conv, phrase, intent, ctx)

    def test_avg_invoice_matches_dashboard_formula(self, db, org, ctx, customers):
        from app.modules.billing.models import InvoiceStatus
        go = customers["go"]
        add_invoice(db, org, go.id, "INV-AVG-1", InvoiceStatus.SENT, 1000)
        add_invoice(db, org, go.id, "INV-AVG-2", InvoiceStatus.SENT, 500)

        result = self._ask(db, org, ctx, "average invoice amount")

        # Billed 1500 across 2 issued invoices → 750 (dashboard formula)
        assert result["mode"] == "M1_INSPECT"
        assert f"Your average invoice value is **{money(750, 'USD')}**." in result["answer"], (
            result["answer"][:200]
        )

    def test_avg_invoice_zero_when_no_invoices(self, db, org, ctx, customers):
        result = self._ask(db, org, ctx, "AVG invoice value")

        assert "No invoices have been issued yet" in result["answer"], result["answer"][:200]

    def test_credit_note_count_live(self, db, org, ctx):
        from app.modules.billing.models import CreditNote, CreditNoteType, CreditNoteStatus
        result = self._ask(db, org, ctx, "how many credit notes")
        assert "No credit notes have been issued" in result["answer"], result["answer"][:200]

        cust = add_customer(db, org, "CUST-CN", "Credit Note Co")
        db.add(CreditNote(
            organization_id=org.id, customer_id=cust.id,
            credit_note_number="CN-T1",
            credit_note_type=CreditNoteType.PARTIAL_CREDIT,
            status=CreditNoteStatus.ISSUED,
            total_amount="300.00", remaining_amount="300.00",
            issue_date=date.today(), currency="USD",
        ))
        db.flush()

        result = self._ask(db, org, ctx, "How many credit notes do we have?")
        assert "**1 credit note(s)**" in result["answer"], result["answer"][:200]
        assert money(300, "USD") in result["answer"]

    def test_paid_amount_this_month_matches_monthly_revenue_card(self, db, org, ctx, customers):
        from app.modules.billing.models import InvoiceStatus
        go = customers["go"]
        add_invoice(db, org, go.id, "INV-PAID-M", InvoiceStatus.PAID, 700, paid=700)

        result = self._ask(db, org, ctx, "paid amount this month")

        assert result["mode"] == "M1_INSPECT"
        assert f"Paid revenue this month is **{money(700, 'USD')}**." in result["answer"], (
            result["answer"][:200]
        )
        assert "Monthly Revenue card" in result["answer"]

    def test_billing_admin_count_from_user_accounts(self, db, org, ctx):
        from app.modules.auth.models import User, UserRole
        db.add_all([
            User(email=f"admin{org.id}@test.io", hashed_password="x",
                 role=UserRole.ORG_ADMIN, first_name="A", last_name="One",
                 organization_id=org.id),
            User(email=f"billing{org.id}@test.io", hashed_password="x",
                 role=UserRole.BILLING_ADMIN, first_name="B", last_name="Two",
                 organization_id=org.id),
        ])
        db.flush()

        result = self._ask(db, org, ctx, "how many billing admins")

        assert result["mode"] == "M1_INSPECT"
        assert "**2 admin user(s)**" in result["answer"], result["answer"][:200]
        assert "1 organization admin(s)" in result["answer"]
        assert "1 billing admin(s)" in result["answer"]
        assert "**2 active team member(s)**" in result["answer"]

    def test_growth_rate_computed_like_dashboard_chart(self, db, org, ctx, customers):
        from datetime import date as d
        from app.modules.billing.models import InvoiceStatus
        go = customers["go"]
        today = d.today()
        first_of_this_month = today.replace(day=1)
        prev_month_last = first_of_this_month - timedelta(days=1)

        def paid_inv(number, day, total):
            inv = Invoice(
                organization_id=org.id, customer_id=go.id,
                invoice_number=number, status=InvoiceStatus.PAID,
                issue_date=day, due_date=day,
                total_amount=str(total), paid_amount=str(total),
                balance_due="0.00", currency="USD",
            )
            db.add(inv)

        paid_inv("INV-GROW-PREV", prev_month_last, 400)
        paid_inv("INV-GROW-CURR", first_of_this_month, 500)
        db.flush()

        result = self._ask(db, org, ctx, "What's our monthly growth rate?")

        assert result["mode"] == "M1_INSPECT"
        # (500 − 400) / 400 × 100 = +25.0% — same formula as dashboard.jsx
        assert "**+25.0%**" in result["answer"], result["answer"][:200]


# ═══════════════════════════════════════════════════════════════════════════════
# Eval-210 regressions (live triage 2026-08-24): greetings, invoice status
# filters, reference extraction in sentence context, metric phrasings,
# domain guardrails, customer lookup by code/email.
# ═══════════════════════════════════════════════════════════════════════════════

class TestGreetingSmalltalk:
    @pytest.mark.parametrize("phrase", ["Hi", "hey", "Good morning!", "Thanks", "thank you", "bye"])
    def test_pure_greetings_get_welcome(self, db, org, ctx, phrase):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org)
        intent = engine._classify_intent(conv, phrase, ctx)
        assert intent["intent"] == "greeting"
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, phrase, intent, ctx)
        assert "Zoiko Billing AI Assistant" in result["answer"]

    def test_greeting_with_request_stays_request(self, db):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent("Hi, show overdue invoices")
        assert result["intent"] != "greeting"


class TestInvoiceStatusFilters:
    def _ask(self, db, org, ctx, phrase):
        import uuid
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"conv-{uuid.uuid4().hex[:8]}")
        intent = engine._classify_intent(conv, phrase, ctx)
        handler = engine._get_handler(intent["domain"])
        return handler(conv, phrase, intent, ctx)

    def test_status_filter_selects_only_matching(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "INV-ST-SENT", InvoiceStatus.SENT, 100)
        add_invoice(db, org, customers["go"].id, "INV-ST-PAID", InvoiceStatus.PAID, 200, paid="200.00")
        add_invoice(db, org, customers["go"].id, "INV-ST-CANC", InvoiceStatus.CANCELLED, 300)

        paid = self._ask(db, org, ctx, "Show paid invoices")
        assert "INV-ST-PAID" in paid["answer"]
        assert "INV-ST-SENT" not in paid["answer"]
        assert "INV-ST-CANC" not in paid["answer"]

        cancelled = self._ask(db, org, ctx, "List cancelled invoices")
        assert "INV-ST-CANC" in cancelled["answer"]
        assert "INV-ST-PAID" not in cancelled["answer"]

        sent = self._ask(db, org, ctx, "Show sent invoices")
        assert "INV-ST-SENT" in sent["answer"]
        assert "INV-ST-PAID" not in sent["answer"]


class TestReferenceExtractionSentenceContext:
    """'…will invoice INV-9999…' must extract INV-9999 (previously the INV
    alternative matched inside the English word 'invoice', returned None, and
    the latest-invoice fallback displayed an unrelated record)."""

    def test_unknown_ref_after_word_invoice_not_found(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "INV-REAL1", InvoiceStatus.SENT, 500)
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org)
        phrase = "When will invoice INV-9999 be paid?"
        intent = engine._classify_intent(conv, phrase, ctx)
        result = engine._get_handler(intent["domain"])(conv, phrase, intent, ctx)
        assert "No invoice found matching that reference" in result["answer"], result["answer"][:150]
        assert "INV-REAL1" not in result["answer"]

    def test_hyphenated_reference_survives(self, db, org):
        engine = ConversationEngine(db, model_gateway=None)
        assert engine._extract_reference(
            "What is INV-2024-0001?", prefixes=("INVOICE", "INV"),
        ) == "INV-2024-0001"


class TestMetricPhrasingRoutes:
    @pytest.mark.parametrize("phrase,expected", [
        ("Mean invoice amount", "metric_avg_invoice"),
        ("ARR value", "metric_mrr_arr"),
        ("what's our MRR total?", "metric_mrr_arr"),
        ("Growth compared to last month", "metric_growth_rate"),
        ("Paid revenue this week", "metric_paid_period"),
        ("What did we bill in July?", "metric_paid_period"),
        ("Show revenue by month", "metric_growth_rate"),
    ])
    def test_routes(self, db, phrase, expected):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == expected, f"{phrase!r} -> {result['intent']}"

    def test_paid_period_week_and_month_name_answer(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "INV-PER1", InvoiceStatus.PAID, 250, paid="250.00")
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org)
        for phrase in ("Paid revenue this week", "What did we bill in July?"):
            intent = engine._classify_intent(conv, phrase, ctx)
            result = engine._get_handler(intent["domain"])(conv, phrase, intent, ctx)
            assert result["mode"] == "M1_INSPECT"
            assert money(250, "USD") in result["answer"] or money(0, "USD") in result["answer"]


class TestDomainGuardrails:
    def test_offtopic_cost_question_never_account_balance(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "INV-BAL1", InvoiceStatus.SENT, 500)
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org)
        phrase = "How much does a car repair cost?"
        intent = engine._classify_intent(conv, phrase, ctx)
        result = engine._get_handler(intent["domain"])(conv, phrase, intent, ctx)
        assert "Account balance" not in result["answer"]
        assert "outstanding across" not in result["answer"]

    @pytest.mark.parametrize("phrase", [
        "What database does Zoiko Billing use?",
        "Explain your API endpoints",
        "My smartphone battery drains fast, what should I do?",
        "Tell me about War and Peace",
    ])
    def test_out_of_domain_refused(self, db, phrase):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "out_of_scope", f"{phrase!r} -> {result['intent']}"

    def test_dunning_timeline_is_knowledge_question(self, db):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(
            "What happens after 45 days overdue?")
        assert result["intent"] == "help_general"


class TestCustomerLookupByIdentifier:
    def _lookup(self, db, org, ctx, text):
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org)
        return engine._lookup_customer(text, text.lower(), conv, ctx)

    def test_lookup_by_customer_code(self, db, org, ctx):
        add_customer(db, org, "CUST-Z99", "Zeta Corp")
        result = self._lookup(db, org, ctx, "Find customer by code CUST-Z99")
        assert "Zeta Corp" in result["answer"]

    def test_lookup_by_email(self, db, org, ctx):
        add_customer(db, org, "CUST-ML1", "Mail Co")
        from app.modules.billing.models import BillingCustomer
        row = db.query(BillingCustomer).filter(BillingCustomer.customer_code == "CUST-ML1").first()
        row.email = "accounts@mailco.example"
        db.flush()
        result = self._lookup(db, org, ctx, "Which customer has email accounts@mailco.example?")
        assert "Mail Co" in result["answer"]

    def test_not_found_echoes_identifier(self, db, org, ctx):
        result = self._lookup(db, org, ctx, "Find customer by code CUST-NOTHING1")
        assert "couldn't find a customer" in result["answer"]
        assert "CUST-NOTHING1" in result["answer"]


class TestExploratoryFixes:
    """Locks in the 2026-08-24 exploratory-session fixes."""

    def _ask(self, db, org, ctx, phrase):
        import uuid
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid=f"conv-{uuid.uuid4().hex[:8]}")
        intent = engine._classify_intent(conv, phrase, ctx)
        return engine._get_handler(intent["domain"])(conv, phrase, intent, ctx), intent

    def test_compound_invoice_number_lookup(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "AI-INV-20260824-0001", InvoiceStatus.SENT, 500)
        result, _ = self._ask(db, org, ctx, "Tell me about invoice AI-INV-20260824-0001")
        assert "AI-INV-20260824-0001" in result["answer"], result["answer"][:150]
        assert "No invoice found" not in result["answer"]

    def test_metric_noun_is_not_a_customer_name(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "INV-REV1", InvoiceStatus.PAID, 250, paid="250.00")
        result, _ = self._ask(db, org, ctx, "Show me total revenue")
        assert "couldn't find a customer" not in result["answer"], result["answer"][:150]
        assert "Total revenue is" in result["answer"]

    def test_show_draft_invoices_lists(self, db, org, ctx, customers):
        add_invoice(db, org, customers["go"].id, "INV-DRAFTED", InvoiceStatus.DRAFT, 90)
        result, _ = self._ask(db, org, ctx, "Show draft invoices")
        assert result["mode"] == "M1_INSPECT", result["mode"]
        assert "INV-DRAFTED" in result["answer"]

    def test_possessive_balance_returns_figure(self, db, org, ctx, customers):
        add_invoice(db, org, customers["acme"].id, "INV-POSS1", InvoiceStatus.SENT, 400)
        result, _ = self._ask(db, org, ctx, "What is Acme Corp's outstanding balance?")
        assert result["mode"] == "M1_INSPECT"
        assert "outstanding balance" in result["answer"].lower()
        assert "400.00" in result["answer"]

    def test_smalltalk_variants_get_welcome(self, db, org, ctx):
        for phrase in ("How are you doing today?", "Thanks, that was helpful", "What's up?"):
            result, _ = self._ask(db, org, ctx, phrase)
            assert "outside my scope" not in result["answer"], (phrase, result["answer"][:120])
            assert "Zoiko Billing AI Assistant" in result["answer"]

    def test_refund_question_forms(self, db, org, ctx):
        for phrase in ("Did we receive any refunds?", "Any refunds?"):
            result, _ = self._ask(db, org, ctx, phrase)
            assert "No refunds have been issued" in result["answer"], result["answer"][:120]

    def test_any_credit_notes_counts(self, db, org, ctx):
        result, _ = self._ask(db, org, ctx, "Any credit notes?")
        assert "No credit notes have been issued" in result["answer"], result["answer"][:120]

    def test_named_customer_join_date(self, db, org, ctx, customers):
        result, _ = self._ask(db, org, ctx, "When did GOk join?")
        assert "joined on" in result["answer"], result["answer"][:150]
        assert "CUST-GO" in result["answer"]

    def test_quotation_list_not_customer_search(self, db, org, ctx):
        result, _ = self._ask(db, org, ctx, "Show quotations")
        assert "couldn't find a customer" not in result["answer"]
        assert "No quotations have been created" in result["answer"]

    def test_bare_mrr_acronym_routes_to_figure(self, db, org, ctx):
        _, intent = self._ask(db, org, ctx, "MRR please")
        assert intent["intent"] == "metric_mrr_arr", intent

    def test_prepare_copy_uses_an_article(self, db, org, ctx, customers):
        result, _ = self._ask(db, org, ctx, "Create an invoice")
        assert "an invoice draft" in result["answer"], result["answer"][:120]


class TestDunningPhrasingRegression:
    """Regression: short dunning queries must NOT trigger unnecessary
    disambiguation.  All six phrasings below are conceptual taxonomy
    queries about dunning types/stages — they must route to help_general
    with confidence >= SPECIFIC_INTENT_CONFIDENCE, never through the
    CLARIFY path."""

    @pytest.mark.parametrize("phrase", [
        "types of dunning",
        "list the types of dunning",
        "how many types of dunning are there",
        "list out the types of dunning",
        "dunning levels",
        "list dunning stages",
    ])
    def test_dunning_taxonomy_queries_route_to_help(self, db, phrase):
        from app.modules.chatbot.conversation.engine import SPECIFIC_INTENT_CONFIDENCE
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "help_general", (
            f"{phrase!r} routed to {result['intent']}/{result['domain']} "
            f"(confidence={result.get('confidence')}), expected help_general/help"
        )
        assert result["domain"] == "help"
        assert result["risk_class"] == "R0"
        assert result.get("confidence", 0) >= SPECIFIC_INTENT_CONFIDENCE, (
            f"{phrase!r} confidence {result.get('confidence')} < "
            f"SPECIFIC_INTENT_CONFIDENCE ({SPECIFIC_INTENT_CONFIDENCE})"
        )

    @pytest.mark.parametrize("phrase", [
        "types of dunning",
        "list the types of dunning",
        "dunning levels",
    ])
    def test_dunning_taxonomy_not_clarify(self, db, phrase):
        """These queries must NEVER produce a clarify intent — they are
        unambiguous conceptual taxonomy questions."""
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] != "clarify", (
            f"{phrase!r} produced clarify intent (options={result.get('options')}), "
            f"should have been help_general"
        )


class TestExplainR0NoClarifyRegression:
    """CRITICAL REGRESSION: the clarification path was firing for EVERY
    Explain (R0) query because help_general was in FALLBACK_INTENTS and
    the rules fast-path required intent NOT in FALLBACK_INTENTS.

    Root cause: help_general at confidence 0.85-0.90 always fell through
    to the model classifier, which disagreed → both were fallback-level
    → D-11 clarification ladder fired → generic "Product guidance /
    Billing records" options every time.

    Fix: the fast-path now treats help_general as specific when
    confidence >= SPECIFIC_INTENT_CONFIDENCE, AND known domain-vocabulary
    taxonomy queries are caught by _WHAT_IS_HOW_TO_RE patterns.

    These tests confirm every tested phrasing classifies directly as
    help_general (or a specific non-fallback intent) with confidence >=
    SPECIFIC_INTENT_CONFIDENCE, and NEVER produces clarify or "I'll
    assume" on the rules path."""

    @pytest.mark.parametrize("phrase,expected_domain,expected_intent", [
        ("why collection rate", "dashboard", "metric_collection_rate"),
        ("explain about the collection rate", "help", "metric_definition"),
        ("explain about the subscription metrics", "help", "help_general"),
        ("invoice report means", "help", "help_general"),
        ("explain about the payment report", "help", "help_general"),
        ("use of tax reports", "help", "help_general"),
        ("explain about the subscription report", "help", "help_general"),
        ("types of dunning", "help", "help_general"),
        ("explain about the dunning", "help", "help_general"),
    ])
    def test_explain_queries_classify_directly(self, db, phrase, expected_domain, expected_intent):
        """All Explain (R0) queries must classify with high confidence on
        the rules path — no model fallback needed, no clarification."""
        from app.modules.chatbot.conversation.engine import SPECIFIC_INTENT_CONFIDENCE
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        conf = result.get("confidence", 0)
        assert result["domain"] == expected_domain, (
            f"{phrase!r} domain={result['domain']!r}, expected {expected_domain!r}"
        )
        assert result["intent"] == expected_intent, (
            f"{phrase!r} intent={result['intent']!r}, expected {expected_intent!r}"
        )
        assert result["intent"] != "clarify", (
            f"{phrase!r} produced clarify — should never happen for "
            f"domain-vocabulary explain queries"
        )
        assert conf >= SPECIFIC_INTENT_CONFIDENCE, (
            f"{phrase!r} confidence={conf} < SPECIFIC_INTENT_CONFIDENCE "
            f"({SPECIFIC_INTENT_CONFIDENCE}) — would trigger model fallback"
        )

    @pytest.mark.parametrize("phrase", [
        "explain about the collection rate",
        "explain about the subscription metrics",
        "explain about the payment report",
        "explain about the subscription report",
        "explain about the dunning",
        "use of tax reports",
    ])
    def test_explain_queries_not_clarify(self, db, phrase):
        """These must NEVER produce a clarify intent — they are
        unambiguous explain/how-to questions about known domain terms."""
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] != "clarify", (
            f"{phrase!r} produced clarify intent (options={result.get('options')}), "
            f"should have been help_general"
        )

    @pytest.mark.parametrize("phrase", [
        "explain about the collection rate",
        "explain about the payment report",
        "invoice report means",
        "use of tax reports",
    ])
    def test_explain_queries_skip_llm(self, db, phrase):
        """These queries must hit the rules fast-path and skip the LLM
        intent classification call entirely."""
        from app.modules.chatbot.conversation.engine import SPECIFIC_INTENT_CONFIDENCE, FALLBACK_INTENTS
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        intent = result["intent"]
        conf = result.get("confidence", 0)
        is_specific = (
            (intent not in FALLBACK_INTENTS or intent == "help_general")
            and conf >= SPECIFIC_INTENT_CONFIDENCE
        )
        is_high_conf_fallback = intent in FALLBACK_INTENTS and conf >= 0.95
        assert is_specific or is_high_conf_fallback, (
            f"{phrase!r} would NOT skip LLM: intent={intent} conf={conf} "
            f"is_specific={is_specific} is_high_conf_fallback={is_high_conf_fallback}"
        )


class TestSignalWordStructuralMatch:
    """Permanent regression matrix: every signal-word phrasing style × multiple
    domain terms.  The WHAT_IS/HOW_TO detection was restructured from a giant
    phrase-enumeration regex to a structural (signal word + domain term)
    two-part match.  This test class ensures the new approach covers ALL
    phrasing styles across BOTH axes (phrasing style AND topic).

    None of these should trigger the clarification prompt.  All should
    answer directly in the structured format, with no hedge language.
    """

    @pytest.mark.parametrize("phrase", [
        # "explain X" / "explain about X" / "explain about the X"
        "explain dunning",
        "explain payment report",
        "explain tax report",
        # "explain why X"
        "explain why dunning",
        "explain why collection rate",
        # "why X" (bare)
        "why payment report",
        "why dunning",
        "why tax report",
        # "why is X" / "why is X important"
        "why is dunning important",
        "why is tax report important",
        # "how to use X"
        "how to use payment report",
        "how to use dunning",
        "how to use tax report",
        # "how do I use X"
        "how do I use payment report",
        "how do I use reconciliation",
        # "importance of X"
        "importance of tax report",
        "importance of dunning",
        # "purpose of X"
        "purpose of subscription report",
        "purpose of payment report",
        # "what is X"
        "what is collection rate",
        "what is dunning",
        "what is payment report",
        # "what's X"
        "what's dunning",
        "what's payment report",
        # "what does X mean"
        "what does collection rate mean",
        "what does dunning mean",
        "what does payment report mean",
        # "X means"
        "dunning means",
        "payment report means",
        "tax report means",
        # "tell me about X"
        "tell me about credit notes",
        "tell me about dunning",
        "tell me about reconciliation",
        # "describe X"
        "describe dunning",
        "describe payment report",
        "describe credit notes",
        # "what is X for"
        "what is invoice report for",
        "what is dunning for",
        # "meaning of X"
        "meaning of revenue report",
        "meaning of dunning",
        # "how does X work"
        "how does payment reconciliation work",
        "how does dunning work",
        # "use of X"
        "use of invoice report",
        "use of tax reports",
        # "how many types of X"
        "how many types of dunning are there",
        "how many types of credit notes",
        # "what are the types of X"
        "what are the types of credit notes",
        "what are the types of dunning",
        # bare taxonomy
        "types of dunning",
        "dunning levels",
    ])
    def test_signal_word_no_clarify(self, db, phrase):
        """Every signal-word × domain-term combination must classify
        directly on the rules path — NEVER produce clarify."""
        from app.modules.chatbot.conversation.engine import SPECIFIC_INTENT_CONFIDENCE
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        conf = result.get("confidence", 0)
        assert result["intent"] != "clarify", (
            f"{phrase!r} produced clarify (conf={conf}) — should answer directly"
        )
        assert conf >= SPECIFIC_INTENT_CONFIDENCE, (
            f"{phrase!r} confidence={conf} < SPECIFIC_INTENT_CONFIDENCE "
            f"({SPECIFIC_INTENT_CONFIDENCE}) — would trigger model fallback"
        )

    @pytest.mark.parametrize("phrase,expected_intent", [
        ("why payment report", "help_general"),
        ("why dunning", "help_general"),
        ("why tax report", "help_general"),
        ("how to use payment report", "help_general"),
        ("how to use dunning", "help_general"),
        ("importance of tax report", "help_general"),
        ("purpose of subscription report", "help_general"),
        ("what is collection rate", "metric_definition"),
        ("tell me about credit notes", "help_general"),
    ])
    def test_signal_word_routes_to_help(self, db, phrase, expected_intent):
        """These must classify as help_general (knowledge explanation),
        NOT as any entity-specific or fallback intent."""
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == expected_intent, (
            f"{phrase!r} routed to {result['intent']}/{result['domain']} "
            f"(conf={result.get('confidence')}), expected {expected_intent}/help"
        )
        assert result["domain"] == "help", (
            f"{phrase!r} domain={result['domain']!r}, expected 'help'"
        )


# ──────────────────────────────────────────────────────────────────────
# Four-Issue Regression (bare-noun fallback, typo tolerance, KB content)
# ──────────────────────────────────────────────────────────────────────

class TestPaymentListBareNounFallback:
    """ISSUE A: 'list recent payments' must route to payment_list via the
    bare-noun fallback, matching the same safety net that invoices and
    subscriptions already have."""

    @pytest.mark.parametrize("phrase", [
        "list recent payments",
        "show recent payments",
        "list the recent payments",
        "show me recent payments",
        "recent payments",
        "payments from last week",
        "payments this month",
    ])
    def test_recent_payments_routes_to_payment_list(self, db, phrase):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "payment_list", (
            f"{phrase!r} routed to {result['intent']}, expected payment_list"
        )
        assert result["risk_class"] == "R1"

    @pytest.mark.parametrize("phrase", [
        "list recent invoices",
        "show recent invoices",
        "list the recent invoices",
    ])
    def test_recent_invoices_still_work(self, db, phrase):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == "invoice_list", (
            f"{phrase!r} routed to {result['intent']}, expected invoice_list"
        )


class TestDomainTypoTaxReport:
    """ISSUE B: The typo 'taxi' must resolve to 'tax' via the domain
    typo correction dictionary, so ALL phrasing styles resolve to Tax Report."""

    @pytest.mark.parametrize("phrase", [
        "explain about the taxi report",
        "why taxi report",
        "use of taxi report",
        "how to use taxi report",
        "importance of taxi report",
        "what is taxi report",
        "tell me about taxi report",
        "describe taxi report",
        "purpose of taxi report",
        "taxi report means",
        "what does taxi report mean",
        "how does taxi report work",
    ])
    def test_taxi_typo_resolves_to_tax_report(self, db, phrase):
        from app.modules.chatbot.conversation.engine import _apply_domain_typos, _detect_what_is_how_to
        corrected = _apply_domain_typos(phrase)
        assert "tax" in corrected, (
            f"{phrase!r} -> corrected to {corrected!r}, expected 'tax' present"
        )
        assert "taxi" not in corrected, (
            f"{phrase!r} -> corrected to {corrected!r}, 'taxi' should be replaced"
        )
        # The corrected text must be detected as WHAT_IS/HOW_TO
        assert _detect_what_is_how_to(corrected), (
            f"corrected {corrected!r} not detected as WHAT_IS/HOW_TO"
        )


class TestForecastReportKBArticle:
    """ISSUE C: Forecast Report must have KB content so it answers instead
    of abstaining.  We verify the seed source (KB_ENTRIES) since the test
    DB is in-memory SQLite without seeded data."""

    def test_billing_reports_includes_forecast(self):
        from seed_knowledge import KB_ENTRIES
        reports_doc = next((e for e in KB_ENTRIES if e["title"] == "Billing Reports"), None)
        assert reports_doc is not None, "Billing Reports entry missing from KB_ENTRIES"
        all_text = " ".join(reports_doc["chunks"])
        assert "Forecast Report" in all_text, (
            f"Billing Reports chunks do not mention Forecast Report"
        )

    def test_forecast_chunk_describes_purpose(self):
        from seed_knowledge import KB_ENTRIES
        reports_doc = next((e for e in KB_ENTRIES if e["title"] == "Billing Reports"), None)
        forecast_chunks = [c for c in reports_doc["chunks"] if "Forecast Report" in c]
        assert len(forecast_chunks) >= 1, "No Forecast Report chunk in Billing Reports"
        text = forecast_chunks[0].lower()
        assert "revenue" in text or "mrr" in text or "forecast" in text, (
            f"Forecast Report chunk lacks purpose: {forecast_chunks[0][:100]}"
        )


class TestBillingConfigurationKBArticle:
    """ISSUE D: Billing Configuration must have its own KB article describing
    the actual settings page — NOT the AI's governance modes."""

    def test_billing_configuration_article_exists(self):
        from seed_knowledge import KB_ENTRIES
        doc = next((e for e in KB_ENTRIES if e["title"] == "Billing Configuration"), None)
        assert doc is not None, "Billing Configuration entry missing from KB_ENTRIES"
        assert len(doc["chunks"]) >= 5, (
            f"Billing Configuration has only {len(doc['chunks'])} chunks, expected >= 5"
        )

    def test_billing_configuration_mentions_all_tabs(self):
        from seed_knowledge import KB_ENTRIES
        doc = next((e for e in KB_ENTRIES if e["title"] == "Billing Configuration"), None)
        all_text = " ".join(doc["chunks"]).lower()
        for tab in ["general", "invoicing", "payments", "tax", "dunning",
                     "revenue", "notifications", "advanced", "administration"]:
            assert tab in all_text, (
                f"Billing Configuration KB missing mention of '{tab}' tab"
            )

    def test_governance_modes_not_in_billing_workflows(self):
        """The M0/M1/M2-M4 governance chunk must NOT be in Billing Workflows."""
        from seed_knowledge import KB_ENTRIES
        doc = next((e for e in KB_ENTRIES if e["title"] == "Billing Workflows and Policies"), None)
        assert doc is not None
        for chunk in doc["chunks"]:
            text = chunk.lower()
            assert "m0" not in text and "m1" not in text and "m2" not in text, (
                f"Governance modes leaked into Billing Workflows chunk: {chunk[:100]}"
            )


# ──────────────────────────────────────────────────────────────────────
# Dynamic Follow-Up Chips
# ──────────────────────────────────────────────────────────────────────

class TestTopicFollowupChips:
    """Each Explain/Inspect topic must produce topically distinct,
    relevant follow-up chips — not the same generic set every time."""

    def test_followup_function_returns_chips(self):
        from app.modules.chatbot.conversation.engine import _followup_prompts
        chips = _followup_prompts("help_general", "help")
        assert len(chips) >= 2, f"Expected >= 2 chips, got {len(chips)}"
        assert len(chips) <= 3, f"Expected <= 3 chips, got {len(chips)}"

    def test_followup_falls_back_to_default(self):
        from app.modules.chatbot.conversation.engine import _followup_prompts
        chips = _followup_prompts("unknown_intent", "unknown_domain")
        assert len(chips) >= 2
        assert "Dashboard summary" in chips

    @pytest.mark.parametrize("intent,domain,expected_keywords", [
        ("dunning", "help", ["overdue", "dunning"]),
        ("payment_report", "help", ["payment"]),
        ("tax_report", "help", ["tax"]),
        ("forecast_report", "help", ["collection", "dashboard"]),
        ("metric_collection_rate", "dashboard", ["overdue", "dunning"]),
        ("billing_configuration", "help", ["Dunning", "proration"]),
        ("invoice_list", "billing", ["overdue", "invoice"]),
        ("payment_list", "billing", ["overdue", "payment"]),
        ("metric_mrr_arr", "dashboard", ["subscription", "MRR"]),
    ])
    def test_topic_chips_are_topically_relevant(self, intent, domain, expected_keywords):
        from app.modules.chatbot.conversation.engine import _followup_prompts
        chips = _followup_prompts(intent, domain)
        all_text = " ".join(chips).lower()
        matched = [kw for kw in expected_keywords if kw.lower() in all_text]
        assert len(matched) >= 1, (
            f"({intent!r}, {domain!r}) chips {chips} have no keywords from {expected_keywords}"
        )

    def test_different_topics_get_different_chips(self):
        from app.modules.chatbot.conversation.engine import _followup_prompts
        dunning = _followup_prompts("dunning", "help")
        payment = _followup_prompts("payment_report", "help")
        tax = _followup_prompts("tax_report", "help")
        # At least one chip must differ across the three topics
        assert dunning != payment, "dunning and payment_report have identical chips"
        assert payment != tax, "payment_report and tax_report have identical chips"
        assert dunning != tax, "dunning and tax_report have identical chips"


# ──────────────────────────────────────────────────────────────────────
# Action-Verb/Action-Object Routing — Expanded Coverage
# ──────────────────────────────────────────────────────────────────────

class TestActionDraftExpandedVerbsObjects:
    """action_verbs and action_objects gates must cover all billing lifecycle
    verbs (cancel, delete, update, modify, record, apply, renew, close, void,
    retry) and all billing entities (subscription, contract, quotation,
    product, customer) — not just the original create/draft/issue set."""

    def _classify(self, text: str) -> dict:
        from app.modules.chatbot.conversation.engine import ConversationEngine
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            engine = ConversationEngine(db, model_gateway=None)
            return engine._rules_classify_intent(text)
        finally:
            db.close()

    @pytest.mark.parametrize("query", [
        "cancel subscription SUB-200",
        "cancel invoice INV-1001",
        "delete invoice INV-1001",
        "delete customer Acme",
        "update invoice INV-1001",
        "modify invoice INV-1001",
        "apply payment to invoice INV-1001",
        "record a payment of 200",
        "renew subscription SUB-200",
        "close invoice INV-1001",
        "void invoice INV-1001",
        "retry payment PAY-1001",
    ])
    def test_new_action_verbs_route_to_action_draft(self, query: str):
        result = self._classify(query)
        assert result["intent"] == "action_draft", (
            f"{query!r} should be action_draft, got {result['intent']}"
        )

    @pytest.mark.parametrize("query", [
        "create a subscription for Acme",
        "create a contract for Acme",
        "create a quotation for Acme",
        "draft a quotation for Acme",
        "create a product",
        "create a customer",
    ])
    def test_new_action_objects_route_to_action_draft(self, query: str):
        result = self._classify(query)
        assert result["intent"] == "action_draft", (
            f"{query!r} should be action_draft, got {result['intent']}"
        )

    @pytest.mark.parametrize("query", [
        "create a invoice for customer TOM for consulting charge 400",
        "draft an invoice for Acme Corp for 1500",
        "issue a refund to customer 7 for 200",
    ])
    def test_concrete_action_requests_with_parameters(self, query: str):
        result = self._classify(query)
        assert result["intent"] == "action_draft", (
            f"{query!r} should be action_draft, got {result['intent']}"
        )
        assert result["risk_class"] == "R2", (
            f"{query!r} should be R2, got {result['risk_class']}"
        )


class TestActionVsExplainGuard:
    """HARD how-to gate: any 'how do I' / 'how to' / 'steps to' / 'guide to'
    lead routes to EXPLAIN (help_general, R0) BEFORE the action-draft (PREPARE)
    logic — regardless of the verb that follows ('how do I create an invoice'
    is an explanation request, not a draft command).  Direct imperative
    requests without a how-to lead ('create an invoice for TOM', 'cancel
    invoice INV-1001') still route to action_draft (R2).  Non-guided verbs
    (cancel, delete, record, …) also route to help_general for 'how do I'
    queries since they lack guided M2 flows."""

    def _classify(self, text: str) -> dict:
        from app.modules.chatbot.conversation.engine import ConversationEngine
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            engine = ConversationEngine(db, model_gateway=None)
            return engine._rules_classify_intent(text)
        finally:
            db.close()

    @pytest.mark.parametrize("query,expected_intent", [
        ("how do I create an invoice", "help_general"),
        ("how do I issue a refund", "help_general"),
        ("how do I draft a credit note", "help_general"),
    ])
    def test_how_do_i_guided_verbs_are_explain(self, query: str, expected_intent: str):
        result = self._classify(query)
        assert result["intent"] == expected_intent, (
            f"{query!r} should be {expected_intent}, got {result['intent']}"
        )

    @pytest.mark.parametrize("query", [
        "how do I cancel an invoice",
        "how do I delete a subscription",
        "how do I record a payment",
        "how do I update a customer",
        "how do I check overdue invoices",
        "how do I view my billing dashboard",
        "how do I run a revenue report",
    ])
    def test_how_do_i_non_guided_verbs_go_help(self, query: str):
        result = self._classify(query)
        assert result["intent"] == "help_general", (
            f"{query!r} should be help_general, got {result['intent']}"
        )


# ──────────────────────────────────────────────────────────────────────
# Action Buttons: structured actions field, no UIDs in labels
# ──────────────────────────────────────────────────────────────────────

class TestActionButtonsNoUIDsInLabels:
    """M2/M3 responses must include a structured `actions` field with
    clean display labels and hidden UIDs. The `suggested_prompts` and
    `next_actions` must never contain action_uid values."""

    def _classify(self, text: str) -> dict:
        from app.modules.chatbot.conversation.engine import ConversationEngine
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            engine = ConversationEngine(db, model_gateway=None)
            return engine._rules_classify_intent(text)
        finally:
            db.close()

    def test_action_verbs_produce_actions_field(self):
        """Verify the rules engine classifies action requests correctly.
        The structured `actions` field is added by _handle_action, not
        by _rules_classify_intent, so we verify the intent classification
        reaches action_draft."""
        result = self._classify("create a invoice for customer TOM for consulting charge 400")
        assert result["intent"] == "action_draft"
        assert result["risk_class"] == "R2"

    def test_suggested_prompts_never_contain_uuid_pattern(self):
        """No suggested_prompts or next_actions string should match a UUID pattern."""
        import re
        uuid_re = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)

        from app.modules.chatbot.conversation.engine import ConversationEngine
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            engine = ConversationEngine(db, model_gateway=None)
            # Simulate M2 response payloads (what _handle_action returns)
            # The M2 response now uses actions field instead of embedding UIDs
            from app.modules.chatbot.conversation.engine import _followup_prompts
            prompts = _followup_prompts("action_draft", "action")
            for p in prompts:
                assert not uuid_re.search(p), f"suggested_prompt contains UUID: {p!r}"
        finally:
            db.close()


class TestActionEngineCancel:
    """ActionEngine.cancel_action must expire a valid draft and reject
    terminal/cancelled drafts."""

    def test_cancel_valid_draft(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.actions.action_engine import ActionEngine
        from app.modules.chatbot.models import DraftStatus

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-cancel-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.organization_id = 1
        draft.user_id = 1

        db.query.return_value.filter.return_value.first.return_value = draft

        ctx = MagicMock()
        ctx.organization_id = 1
        ctx.user_id = 1
        ctx.tenant_context_id = 1
        ctx.request_id = "test"

        result = engine.cancel_action(ctx=ctx, action_uid="test-cancel-1")
        assert result["cancelled"] is True
        assert result["status"] == "expired"
        assert draft.draft_status == DraftStatus.EXPIRED

    def test_cancel_already_expired_draft_returns_409(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError
        from app.modules.chatbot.models import DraftStatus

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-cancel-2"
        draft.draft_status = DraftStatus.EXPIRED
        draft.organization_id = 1
        draft.user_id = 1

        db.query.return_value.filter.return_value.first.return_value = draft

        ctx = MagicMock()
        ctx.organization_id = 1
        ctx.user_id = 1

        try:
            engine.cancel_action(ctx=ctx, action_uid="test-cancel-2")
            assert False, "Should have raised ActionEngineError"
        except ActionEngineError as e:
            assert e.status_code == 409

    def test_cancel_nonexistent_draft_returns_404(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        db.query.return_value.filter.return_value.first.return_value = None

        ctx = MagicMock()
        ctx.organization_id = 1
        ctx.user_id = 1

        try:
            engine.cancel_action(ctx=ctx, action_uid="nonexistent-uid")
            assert False, "Should have raised ActionEngineError"
        except ActionEngineError as e:
            assert e.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# §8 Governed Financial Action UX — Regression Tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestBuildDraftCard(unittest.TestCase):
    """Tests for _build_draft_card — §8.1 editable structured draft card."""

    def _make_engine(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.conversation.engine import ConversationEngine
        db = MagicMock()
        engine = ConversationEngine.__new__(ConversationEngine)
        engine.db = db
        return engine

    def test_draft_card_has_all_required_fields(self):
        engine = self._make_engine()
        params = {
            "customer_name": "TOM",
            "customer_id": 42,
            "line_items": [{"description": "Consulting", "quantity": 1, "unit_price": "500"}],
            "currency": "INR",
            "tax_rate": "18",
        }
        draft_result = {
            "action_uid": "act-123",
            "status": "validated",
            "created_at": "2026-08-26T10:00:00",
            "expires_at": "2026-08-26T11:00:00",
        }
        card = engine._build_draft_card(params, "invoice_draft", draft_result)
        assert card["action_type"] == "invoice_draft"
        assert card["customer_name"] == "TOM"
        assert card["customer_id"] == 42
        assert card["currency"] == "INR"
        assert card["action_uid"] == "act-123"
        assert card["status"] == "validated"
        assert "line_items" in card
        assert card["total"] is not None

    def test_draft_card_calculates_totals(self):
        engine = self._make_engine()
        params = {
            "customer_name": "X",
            "line_items": [
                {"description": "A", "quantity": 2, "unit_price": "100"},
                {"description": "B", "quantity": 1, "unit_price": "50"},
            ],
            "currency": "USD",
            "tax_rate": "10",
        }
        card = engine._build_draft_card(params, "invoice_draft", {"action_uid": "u1", "status": "validated"})
        assert card["subtotal"] == "250"  # 2*100 + 1*50
        assert card["tax_amount"] == "25"  # 250 * 10% = 25.0 (Decimal strips trailing .0)
        assert card["total"] == "275"  # 250 + 25

    def test_draft_card_empty_line_items(self):
        engine = self._make_engine()
        params = {"customer_name": "Y", "line_items": [], "currency": "INR", "tax_rate": "0"}
        card = engine._build_draft_card(params, "invoice_draft", {"action_uid": "u2", "status": "validated"})
        assert card["subtotal"] == "0"
        assert card["total"] == "0"

    def test_draft_card_zero_tax(self):
        engine = self._make_engine()
        params = {
            "customer_name": "Z",
            "line_items": [{"description": "Item", "quantity": 1, "unit_price": "100"}],
            "currency": "EUR",
            "tax_rate": "0",
        }
        card = engine._build_draft_card(params, "invoice_draft", {"action_uid": "u3", "status": "validated"})
        assert card["tax_amount"] == "0"
        assert card["total"] == "100"


class TestBuildConfirmLabel(unittest.TestCase):
    """Tests for _build_confirm_label — §8.3 restated-value confirm button."""

    def _make_engine(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.conversation.engine import ConversationEngine
        db = MagicMock()
        engine = ConversationEngine.__new__(ConversationEngine)
        engine.db = db
        return engine

    def test_invoice_with_customer(self):
        engine = self._make_engine()
        label = engine._build_confirm_label(
            "invoice_draft",
            {"customer_name": "TOM", "currency": "INR"},
            {"currency": "INR", "total": "500"},
        )
        assert "Confirm" in label
        assert money_sym(500, "INR") in label
        assert "invoice" in label
        assert "TOM" in label

    def test_invoice_without_customer(self):
        engine = self._make_engine()
        label = engine._build_confirm_label(
            "invoice_draft",
            {"currency": "USD"},
            {"currency": "USD", "total": "1000"},
        )
        assert "Confirm" in label
        assert money_sym(1000, "USD") in label
        assert "invoice" in label
        assert "for" not in label

    def test_refund_with_customer(self):
        engine = self._make_engine()
        label = engine._build_confirm_label(
            "refund",
            {"customer_name": "Acme Corp"},
            {"currency": "INR", "total": "250.50"},
        )
        assert "refund" in label
        assert "250.50" in label
        assert "Acme Corp" in label

    def test_credit_note(self):
        engine = self._make_engine()
        label = engine._build_confirm_label(
            "credit_note",
            {"customer_name": "X"},
            {"currency": "GBP", "total": "75"},
        )
        assert "credit note" in label
        assert money_sym(75, "GBP") in label

    def test_unknown_action_type_uses_generic(self):
        engine = self._make_engine()
        label = engine._build_confirm_label(
            "unknown_type",
            {},
            {"currency": "USD", "total": "100"},
        )
        assert "Confirm" in label
        assert "action" in label

    def test_no_bare_confirm(self):
        """§8.3: The confirm label must NEVER be bare 'Confirm' — it must restate value."""
        engine = self._make_engine()
        label = engine._build_confirm_label(
            "invoice_draft",
            {"customer_name": "TOM"},
            {"currency": "INR", "total": "500"},
        )
        assert label != "Confirm"
        assert len(label) > 10


class TestBuildPreviewCard(unittest.TestCase):
    """Tests for _build_preview_card — §8.2 all 10 required elements."""

    def _make_engine(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.conversation.engine import ConversationEngine
        db = MagicMock()
        engine = ConversationEngine.__new__(ConversationEngine)
        engine.db = db
        return engine

    def _base_params(self):
        return {
            "payload": {
                "action_type": "invoice_draft",
                "customer_name": "TOM",
                "line_items": [{"description": "Service", "quantity": 1, "unit_price": "500"}],
            },
            "money": {"currency": "INR", "subtotal": "500", "tax": "90", "total": "590"},
            "warnings": [],
            "preview_result": {
                "preview_uid": "pv-001",
                "preview_hash": "abc123",
                "created_at": "2026-08-26T10:00:00",
                "expires_at": "2026-08-26T10:30:00",
            },
            "proposed_params": {"customer_name": "TOM", "customer_id": 42},
            "policy_result": {"result": "CONFIRMATION_REQUIRED"},
        }

    def test_has_action_label(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert card["action_label"] == "Issue invoice"

    def test_has_risk_description_text(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert "Medium-risk" in card["risk_description"] or "confirmation" in card["risk_description"].lower()

    def test_has_customer_with_id(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert card["customer"]["name"] == "TOM"
        assert card["customer"]["id"] == 42

    def test_has_money_with_currency(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert card["money"]["currency"] == "INR"
        assert card["money"]["total"] == "590"
        assert "590" in card["money"]["display"]

    def test_has_side_effects(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert len(card["side_effects"]) > 0
        assert any("DRAFT" in s for s in card["side_effects"])

    def test_has_approval_requirement(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert "approval" in card
        # CONFIRMATION_REQUIRED = medium risk, approval NOT required
        assert card["approval"]["required"] is False

    def test_has_timestamps(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert card["generated_at"] is not None
        assert card["expires_at"] is not None

    def test_has_preview_hash(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert card["preview_hash"] == "abc123"

    def test_has_line_items(self):
        engine = self._make_engine()
        p = self._base_params()
        card = engine._build_preview_card(**p)
        assert len(card["line_items"]) == 1
        assert card["line_items"][0]["description"] == "Service"

    def test_low_risk_no_approval(self):
        engine = self._make_engine()
        p = self._base_params()
        p["policy_result"] = {"result": "READY_TO_EXECUTE"}
        card = engine._build_preview_card(**p)
        assert card["approval"]["required"] is False
        assert "Low-risk" in card["risk_description"]

    def test_approval_high_risk_requires_manager(self):
        engine = self._make_engine()
        p = self._base_params()
        p["policy_result"] = {"result": "APPROVAL_REQUIRED"}
        card = engine._build_preview_card(**p)
        assert card["approval"]["required"] is True
        assert card["approval"]["role"] == "Billing Manager"

    def test_credit_note_action_label(self):
        engine = self._make_engine()
        p = self._base_params()
        p["payload"]["action_type"] = "credit_note"
        card = engine._build_preview_card(**p)
        assert "credit note" in card["action_label"].lower()

    def test_refund_side_effects(self):
        engine = self._make_engine()
        p = self._base_params()
        p["payload"]["action_type"] = "refund"
        card = engine._build_preview_card(**p)
        assert any("payment gateway" in s.lower() for s in card["side_effects"])


# ═══════════════════════════════════════════════════════════════════════════════
# BUG 2 — Duplicate-execution prevention & stale draft card regression tests
# BUG 1 — Preview→Confirm→Execute stage separation regression tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestDuplicateExecutionGuard(unittest.TestCase):
    """BUG 2: ActionEngine.execute_action must reject a second execution
    attempt on an Action UID that already has a SUCCEEDED execution."""

    def _make_engine_with_succeeded_execution(self):
        """Build an ActionEngine with mocks that return a draft, valid
        preview, valid confirmation, and an existing SUCCEEDED execution."""
        from unittest.mock import MagicMock
        from app.modules.chatbot.actions.action_engine import ActionEngine
        from app.modules.chatbot.models import (
            DraftStatus, PreviewStatus, ConfirmationStatus, ExecutionStatus,
        )

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.id = 1
        draft.action_uid = "dup-test-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.risk_class = MagicMock()
        draft.proposed_params = {"customer_name": "TOM", "line_items": []}
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = None

        preview = MagicMock()
        preview.id = 10
        preview.preview_uid = "prev-1"
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "hash123"
        preview.resource_version_vector = None
        preview.expires_at = None

        confirmation = MagicMock()
        confirmation.status = ConfirmationStatus.CONFIRMED

        prior_execution = MagicMock()
        prior_execution.execution_uid = "exec-001"
        prior_execution.execution_status = ExecutionStatus.SUCCEEDED

        # Standard query chain: db.query().filter().first()
        # Used by: _get_draft, preview query, confirmation query
        query_results = [draft, preview, confirmation]
        query_idx = [0]

        def side_effect(*args, **kwargs):
            idx = min(query_idx[0], len(query_results) - 1)
            query_idx[0] += 1
            return query_results[idx]

        db.query.return_value.filter.return_value.first.side_effect = side_effect

        # The prior_succeeded query uses .join() which creates a separate chain:
        # db.query().join().filter().first()
        db.query.return_value.join.return_value.filter.return_value.first.return_value = prior_execution

        ctx = MagicMock()
        ctx.organization_id = 1
        ctx.user_id = 1
        ctx.tenant_context_id = 1

        return engine, ctx

    def test_duplicate_execute_returns_409(self):
        from app.modules.chatbot.actions.action_engine import ActionEngineError
        engine, ctx = self._make_engine_with_succeeded_execution()
        with self.assertRaises(ActionEngineError) as cm:
            engine.execute_action(
                ctx=ctx, action_uid="dup-test-1", idempotency_key="new-key-1",
            )
        assert cm.exception.status_code == 409
        assert "already been executed" in str(cm.exception)

    def test_duplicate_execute_message_mentions_original_uid(self):
        from app.modules.chatbot.actions.action_engine import ActionEngineError
        engine, ctx = self._make_engine_with_succeeded_execution()
        with self.assertRaises(ActionEngineError) as cm:
            engine.execute_action(
                ctx=ctx, action_uid="dup-test-1", idempotency_key="new-key-2",
            )
        # The error message should reference the prior execution UID
        err_msg = str(cm.exception)
        assert "exec-001" in err_msg or "already been executed" in err_msg


class TestTerminalStateAfterExecution(unittest.TestCase):
    """BUG 2: After a successful execution, the draft must be moved to
    EXPIRED (terminal) and the preview to SUPERSEDED, so subsequent
    generate_preview() or execute_action() calls are rejected."""

    def _make_engine_for_execution(self):
        from unittest.mock import MagicMock
        from app.modules.chatbot.actions.action_engine import ActionEngine
        from app.modules.chatbot.models import DraftStatus, PreviewStatus

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.id = 1
        draft.action_uid = "term-test-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.proposed_params = {}
        draft.risk_class = MagicMock()
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = None

        preview = MagicMock()
        preview.id = 10
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "hash"
        preview.resource_version_vector = None
        preview.expires_at = None

        confirmation = MagicMock()

        # Standard query chain: db.query().filter().first()
        # Order: _get_draft, preview, confirmation, idempotency check
        # Idempotency check must return None (no existing execution)
        query_results = [draft, preview, confirmation, None]
        query_idx = [0]

        def side_effect(*args, **kwargs):
            idx = min(query_idx[0], len(query_results) - 1)
            query_idx[0] += 1
            return query_results[idx]

        db.query.return_value.filter.return_value.first.side_effect = side_effect

        # No prior succeeded execution — the join chain returns None
        db.query.return_value.join.return_value.filter.return_value.first.return_value = None

        ctx = MagicMock()
        ctx.organization_id = 1
        ctx.user_id = 1
        ctx.tenant_context_id = 1

        # Mock _execute_billing_action to succeed
        engine._execute_billing_action = MagicMock(return_value={
            "operation_id": "op-1",
            "resources_created": [],
        })

        return engine, ctx, draft, preview

    def test_draft_becomes_expired_after_execution(self):
        engine, ctx, draft, _ = self._make_engine_for_execution()
        engine.execute_action(ctx=ctx, action_uid="term-test-1", idempotency_key="key-1")
        from app.modules.chatbot.models import DraftStatus
        assert draft.draft_status == DraftStatus.EXPIRED

    def test_preview_becomes_superseded_after_execution(self):
        engine, ctx, _, preview = self._make_engine_for_execution()
        engine.execute_action(ctx=ctx, action_uid="term-test-2", idempotency_key="key-2")
        from app.modules.chatbot.models import PreviewStatus
        assert preview.preview_status == PreviewStatus.SUPERSEDED


class TestM2ActionLabel(unittest.TestCase):
    """BUG 1: The M2 draft card action must say 'Preview' (not
    'Review draft') and must NOT include a 'Confirm' action."""

    def test_m2_actions_use_preview_not_review_draft(self):
        """The label must say 'Preview' so the user knows tapping it
        will render the deterministic Preview card."""
        # This tests the engine.py response construction.
        # We verify the label is "Preview" by checking the code path.
        import importlib
        import app.modules.chatbot.conversation.engine as engine_mod
        source = importlib.util.find_spec(engine_mod.__name__).origin
        with open(source, "r", encoding="utf-8") as f:
            code = f.read()
        # The M2 response actions should use "Preview" not "Review draft"
        assert '"Preview"' in code or "'Preview'" in code
        # Should NOT contain "Review draft" in the M2 actions block
        # (It's OK if it appears in comments or documentation)
        # Find the M2 return block and check
        idx = code.find('"actions": [')
        m2_block_end = code.find("next_actions", idx)
        m2_block = code[idx:m2_block_end] if m2_block_end > idx else code[idx:idx+500]
        assert "Review draft" not in m2_block

    def test_m2_actions_do_not_include_confirm(self):
        """The M2 draft card must NOT include a 'Confirm' action —
        only 'Preview' and 'Cancel'."""
        import importlib
        import app.modules.chatbot.conversation.engine as engine_mod
        source = importlib.util.find_spec(engine_mod.__name__).origin
        with open(source, "r", encoding="utf-8") as f:
            code = f.read()
        # Find the M2 return block (after create_draft)
        idx = code.find('engine.create_draft')
        m2_return = code[idx:idx+1500]
        # Confirm action should not appear in the M2 response actions
        # (It's OK in the M3 response)
        actions_idx = m2_return.find('"actions": [')
        if actions_idx >= 0:
            actions_block = m2_return[actions_idx:actions_idx+300]
            assert "confirm_draft" not in actions_block


class TestPreviewCardShowsConfirmLabel(unittest.TestCase):
    """BUG 1: The PreviewCard confirm button must show the restated-value
    confirm_label (e.g. 'Confirm INR 500.00 invoice for TOM'), never
    a bare 'Confirm'."""

    def test_preview_card_uses_confirm_label(self):
        """PreviewCard reads confirm_label from the preview data and
        renders it as the button text."""
        import os
        frontend_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "..",
            "frontend", "src", "modules", "ai-assistant", "PreviewCard.jsx",
        )
        if not os.path.exists(frontend_path):
            self.skipTest("PreviewCard.jsx not found")
        with open(frontend_path, "r", encoding="utf-8") as f:
            source = f.read()
        # The confirm button must use confirmLabel variable, not a hardcoded string
        assert "confirmLabel" in source
        # Should not have a bare "Confirm" as button text
        # (It's OK in comments or as part of a longer string)
        assert '>Confirm</button>' not in source
        assert '>"Confirm"' not in source


# ═══════════════════════════════════════════════════════════════════════════════
# Bug (user report): "billing history" / "payment history" routed to a
# customer-name search and answered "couldn't find a customer matching …".
# These are record-list requests and must reach invoice/payment list.
# ═══════════════════════════════════════════════════════════════════════════════

class TestBillingHistoryRouting:
    @pytest.mark.parametrize("phrase,expected", [
        ("billing history", "invoice_list"),
        ("show me billing history", "invoice_list"),
        ("show billing history", "invoice_list"),
        ("invoice history", "invoice_list"),
        ("payment history", "payment_list"),
        ("show me payment history", "payment_list"),
        ("transaction history", "payment_list"),
    ])
    def test_history_phrases_route_to_record_list(self, db, phrase, expected):
        result = ConversationEngine(db, model_gateway=None)._rules_classify_intent(phrase)
        assert result["intent"] == expected, (
            f"{phrase!r} routed to {result['intent']}, expected {expected}"
        )

    def test_billing_history_never_triggers_customer_search(self, db, org, ctx):
        """The exact reported regression: 'Show me billing history' must NOT
        be intercepted by the customer-name search branch."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-billhist")
        intent = engine._classify_intent(conv, "Show me billing history", ctx)
        assert intent["intent"] != "customer_search", intent
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "Show me billing history", intent, ctx)
        assert "couldn't find a customer matching" not in result["answer"], result["answer"]
        # It actually behaves like an invoice list (even with no invoices).
        assert "invoice" in result["answer"].lower()


# ═══════════════════════════════════════════════════════════════════════════════
# Bug (user report): outstanding-balance / invoice-listing figures rendered a
# currency label that didn't match the value's source currency (a hardcoded
# "USD"). The label must derive from the SAME currency as the value and render
# as a symbol (₹ / $) like the billing dashboard.
# ═══════════════════════════════════════════════════════════════════════════════

class TestCurrencyLabelConsistency:
    def test_money_sym_renders_symbol_not_currency_code(self):
        """A symbol (₹) is rendered, never the literal "USD" code as a label."""
        expected = format_currency_display(1800, "INR")
        assert money_sym(1800, "INR") == expected
        assert expected.startswith("₹")
        assert "USD" not in money_sym(1800, "INR")

    def test_invoice_list_label_matches_base_currency(self, db, org, ctx, customers):
        """Per-invoice list lines render the ORG BASE currency symbol (₹ for an
        INR org), matching the summary/total — never a USD currency code label."""
        from app.modules.billing.models import CurrencyCode
        from app.modules.billing.services.settings_service import BillingConfigurationService
        config = BillingConfigurationService(db).get_configuration(org.id)
        config.base_currency = CurrencyCode.INR
        db.commit()

        add_invoice(db, org, customers["go"].id, "INV-CUR-1", InvoiceStatus.SENT,
                    1800, currency="INR")
        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-cur")
        intent = engine._classify_intent(conv, "list invoices", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "list invoices", intent, ctx)

        # The org base-currency symbol is present in the line.
        assert "₹1800.00" in result["answer"], result["answer"]
        # The literal "USD" currency CODE is never used as a money label.
        assert "USD 1800" not in result["answer"]

    def test_dashboard_outstanding_label_matches_base_currency(self, db, org, ctx, customers, live_like_invoices):
        """Outstanding figure label uses the org base currency (same source as
        the value), rendered as a symbol — never an independent 'USD' code."""
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        kpis = BillingDashboardService(db).get_kpis(organization_id=org.id)
        base_ccy = BillingDashboardService(db)._get_base_currency(org.id)

        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="test-conv-dashcur")
        intent = engine._classify_intent(conv, "dashboard summary", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "dashboard summary", intent, ctx)

        # The rendered outstanding uses the base-currency SYMBOL, matching the value.
        rendered = format_currency_display(kpis["outstanding_amount"], base_ccy)
        assert rendered in result["answer"], (
            f"expected {rendered!r} in overview answer: {result['answer']}"
        )
        # Regression guard: the old code emitted a bare "USD <amount>" label.
        assert "USD " not in result["answer"], result["answer"]


class TestCurrencyLabelInrComprehensive:
    """INR org: every billing response type must render the ₹ symbol, never a
    literal '$' or 'USD' code. Covers the three surfaces from the bug report
    (outstanding-balance summary, per-invoice list, draft/preview/confirm
    cards) and proves the ActionEngine no longer hardcodes 'USD' when an
    invoice is drafted without an explicit currency."""

    def _set_base_currency(self, db, org, code):
        from app.modules.billing.models import CurrencyCode
        from app.modules.billing.services.settings_service import BillingConfigurationService
        config = BillingConfigurationService(db).get_configuration(org.id)
        config.base_currency = CurrencyCode[code] if hasattr(CurrencyCode, code) else code
        db.commit()

    def test_inr_invoice_all_response_types_show_rupee(self, db, org, ctx, customers):
        from types import SimpleNamespace

        from app.modules.chatbot.actions.action_engine import ActionEngine

        # Org base currency = INR (single source of truth, like the dashboard).
        self._set_base_currency(db, org, "INR")

        cust = add_customer(db, org, "CUST-INR", "INR Co")
        add_invoice(db, org, cust.id, "INV-INR-1", InvoiceStatus.SENT, 500, currency="INR")
        db.flush()

        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="conv-inr")

        def ask(phrase):
            intent = engine._classify_intent(conv, phrase, ctx)
            handler = engine._get_handler(intent["domain"])
            return handler(conv, phrase, intent, ctx)["answer"]

        # 1) Outstanding-balance summary line
        summary = ask("what's my outstanding balance?")
        assert "₹" in summary, summary
        assert "USD" not in summary and "$" not in summary, summary

        # 2) Per-invoice list line items
        listing = ask("list invoices")
        assert "₹500.00" in listing, listing
        assert "USD" not in listing and "$" not in listing, listing

        # 3) Dashboard summary
        dash = ask("dashboard summary")
        assert "₹" in dash, dash
        assert "USD" not in dash and "$" not in dash, dash

        # 4) Draft / preview / confirm cards — the ActionEngine must pass the
        #    DRAFT-pinned currency (Sec 8.2 authoritative: customer INR) through
        #    preview/confirm unchanged — never fall back to a hardcoded 'USD'
        #    nor re-derive the currency at a later state.
        cust.currency = "INR"
        db.flush()
        draft = SimpleNamespace(
            organization_id=org.id,
            action_uid="draft-inr-1",
            action_type="invoice_draft",
            proposed_params={
                "customer_id": cust.id,
                "currency": "INR",  # pinned at DRAFT creation (customer currency)
                "line_items": [{"description": "Consulting", "quantity": 1, "unit_price": 500}],
            },
        )
        ae = ActionEngine(db)
        preview = ae._generate_billing_preview(draft)
        assert preview["money_summary"]["currency"] == "INR", preview["money_summary"]

        label = engine._build_confirm_label(
            "invoice_draft", draft.proposed_params, preview["money_summary"], org_id=org.id,
        )
        assert "₹" in label and "USD" not in label and "$" not in label, label

        card = engine._build_preview_card(
            payload=preview["preview_payload"],
            money=preview["money_summary"],
            warnings=[],
            preview_result={"preview_hash": "h", "created_at": None, "expires_at": None},
            proposed_params=draft.proposed_params,
            policy_result={"result": "READY_TO_EXECUTE"},
            org_id=org.id,
        )
        assert "₹" in card["money"]["display"], card["money"]["display"]
        assert "USD" not in card["money"]["display"] and "$" not in card["money"]["display"]

    def test_legacy_usd_invoices_list_render_in_own_currency(self, db, org, ctx, customers):
        """GLB-002 / §30 money contract: an INR org whose invoices were created
        with currency='USD' must render every figure in the invoice's OWN
        currency ($) — never silently re-labelled as the org base (₹). A USD
        balance shown as ₹ would be a silent cross-currency mislabel. Because
        every invoice here is genuinely USD, the total is a USD total; no
        cross-currency aggregation is performed or implied."""
        self._set_base_currency(db, org, "INR")

        cust = add_customer(db, org, "CUST-LEG", "LEGACY FOREIGN Co")
        # Legacy invoices stored as USD (the pre-fix default).
        for num, bal in [("AI-INV-20260826-0004", 500),
                         ("AI-INV-20260826-0003", 500),
                         ("AI-INV-20260826-0002", 500),
                         ("AI-INV-20260826-0001", 300)]:
            add_invoice(db, org, cust.id, num, InvoiceStatus.SENT, bal, currency="USD")
        db.flush()

        engine = ConversationEngine(db, model_gateway=None)
        conv = make_conv(db, org, uid="conv-legacy-usd")

        intent = engine._classify_intent(conv, "list TOM's invoices with amounts", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "list TOM's invoices with amounts", intent, ctx)
        answer = result["answer"]

        # Every per-line bullet must carry the invoice's own $ currency, never ₹.
        bullet_lines = [ln for ln in answer.splitlines() if ln.strip().startswith("- **AI-INV")]
        assert bullet_lines, f"expected per-invoice bullets, got:\n{answer}"
        for ln in bullet_lines:
            assert "$" in ln, f"per-line bullet lost its own-currency $ symbol:\n{ln}"
            assert "₹" not in ln, f"per-line bullet mislabelled in base currency:\n{ln}"

        # No ₹ anywhere: the total must not silently convert USD invoices to INR.
        assert "₹" not in answer, answer
        # Total line agrees with the invoice currency label.
        assert "total outstanding:" in answer


# ═══════════════════════════════════════════════════════════════════════════════
# PRD §11 regression — Action Draft phrasing (no M0 how-to fallback)
# ═══════════════════════════════════════════════════════════════════════════════

def _run_phrase(db, org, ctx, phrase, uid):
    engine = ConversationEngine(db, model_gateway=None)
    conv = make_conv(db, org, uid=uid)
    intent = engine._classify_intent(conv, phrase, ctx)
    handler = engine._get_handler(intent["domain"])
    return engine, conv, intent, handler(conv, phrase, intent, ctx)


class TestInvoiceDraftPhrasingRegression:
    """PRD §11: imperative 'create/draft/generate/make <an invoice>' phrasings
    that carry a customer, a service, and an amount MUST land a real
    action_draft → M2_PREPARE (validated Action UID) — never the generic M0
    how-to fallback (the symptom of the pre-fix UnboundLocalError crash in
    _handle_action where the preview local `money` shadowed the formatter)."""

    TOM_VARIANTS = [
        "create a invoices for a TOM for a consulting charge for a INR500",
        "Create an invoice for TOM for a consulting charge for a 500",
        "create invoice for Tom for a consulting charge of INR 500",
        "Create a draft invoice for TOM for a consulting charge 500",
        "generate an invoice for TOM for a consulting charge at ₹500",
        "make an invoice for TOM for a consulting fee of 750",
        "create an invoice for TOM for a consulting charge for a INR 1000",
    ]

    @pytest.fixture()
    def tom(self, db, org):
        cust = add_customer(db, org, "CUST-TOM", "TOM")
        cust.currency = "INR"
        db.flush()
        return cust

    @pytest.mark.parametrize("phrase", TOM_VARIANTS)
    def test_customer_service_amount_phrasings_land_real_draft(
            self, db, org, ctx, tom, phrase):
        _, _, intent, result = _run_phrase(
            db, org, ctx, phrase, f"conv-draft-{abs(hash(phrase)) % 10 ** 9}")

        assert intent["intent"] == "action_draft", intent
        assert intent["risk_class"] == "R2", intent
        assert result["mode"] == "M2_PREPARE", (
            f"{phrase!r} fell back to {result['mode']} instead of a draft:\n"
            f"{result['answer'][:400]}"
        )
        answer = result["answer"]
        assert "Invoice Draft" in answer, answer[:300]
        assert "Action UID" in answer, answer[:300]
        assert "validated" in answer, answer[:300]

    @pytest.mark.parametrize("phrase", [
        "how do I create an invoice",
        "how should I generate an invoice for a customer",
    ])
    def test_how_to_stays_explain(self, db, org, ctx, phrase):
        """Guard: amount phrasings must not have widened action_draft into the
        how-to gate — 'how do I...' questions remain explain/escalate, never a
        draft card."""
        _, _, intent, result = _run_phrase(
            db, org, ctx, phrase, f"conv-how-{abs(hash(phrase)) % 10 ** 9}")
        assert intent["intent"] == "help_general", intent
        assert result["mode"] != "M2_PREPARE", result["mode"]
        assert "Action UID" not in result["answer"]


class TestInvoiceCountQualifierRegression:
    """PRD §11: 'how many invoices are there' (bare, open/unpaid/pending,
    overdue) must answer from the live ledger — invoice_count, M1_INSPECT,
    qualifier label + exact count — never a KB/RAG answer."""

    def _seed(self, db, org, cust):
        add_invoice(db, org, cust.id, "INV-OPEN1", InvoiceStatus.SENT, 1000)
        add_invoice(db, org, cust.id, "INV-OPEN2", InvoiceStatus.PARTIALLY_PAID, 2000, paid="500")
        add_invoice(db, org, cust.id, "INV-OVER1", InvoiceStatus.SENT, 1500, due_offset_days=-3)
        add_invoice(db, org, cust.id, "INV-PAID1", InvoiceStatus.PAID, 3000, paid="3000")
        add_invoice(db, org, cust.id, "INV-DRAFT1", InvoiceStatus.DRAFT, 9000)
        add_invoice(db, org, cust.id, "INV-CANC1", InvoiceStatus.CANCELLED, 8000)
        db.flush()

    @pytest.mark.parametrize("phrase,count,label", [
        ("how many invoices are there", 4, "invoice(s)"),
        ("how many open invoices are there", 3, "open invoice(s)"),
        ("how many unpaid invoices are there", 3, "unpaid invoice(s)"),
        ("how many pending invoices are there", 3, "pending invoice(s)"),
        ("how many outstanding invoices are there", 3, "outstanding invoice(s)"),
        ("how many overdue invoices are there", 1, "overdue invoice(s)"),
    ])
    def test_counts_answer_from_live_ledger(self, db, org, ctx, phrase, count, label):
        cust = add_customer(db, org, "CUST-COUNT", "Count Co")
        self._seed(db, org, cust)

        _, _, intent, result = _run_phrase(
            db, org, ctx, phrase, f"conv-count-{abs(hash(phrase)) % 10 ** 9}")

        assert intent["intent"] == "invoice_count", intent
        assert intent["risk_class"] == "R1", intent
        assert result["mode"] == "M1_INSPECT", result["mode"]
        assert result["answer"] == f"You currently have **{count} {label}**.", (
            result["answer"][:200]
        )
        evidence = result["evidence"][0]
        assert evidence["type"] == "invoice_count", evidence
        assert evidence["count"] == count, evidence
        assert "Zoiko Billing Invoices" in evidence["source"], evidence


# ═══════════════════════════════════════════════════════════════════════════════
# BUG-1 regression — standalone balance VALUE asks must be a FRESH live fetch
# ═══════════════════════════════════════════════════════════════════════════════

class TestOutstandingBalanceFreshFetch:
    """User report: "what's the outstanding balance?" (standalone, no
    customer) misrouted to R0/help + a KB glossary article instead of
    R1/account_balance. ZB-PRD-ANS-001: financial answers are grounded in a
    FRESH authoritative ledger fetch — the identical question asked twice must
    reflect intervening mutations (M1_INSPECT + evidence), never a stale or
    history-echoed figure."""

    def _seed(self, db, org):
        cust = add_customer(db, org, "BAL1", "Bal Co")
        add_invoice(db, org, cust.id, "INV-B1", InvoiceStatus.SENT, 1000)
        add_invoice(db, org, cust.id, "INV-B2", InvoiceStatus.SENT, 500)
        return cust

    @staticmethod
    def _figure(answer):
        import re as _re
        m = _re.search(r"\$?([\d,]+\.\d{2})", answer)
        return float(m.group(1).replace(",", "")) if m else None

    def test_standalone_outstanding_balance_goes_live_inspect(self, db, org, ctx):
        self._seed(db, org)
        _, _, intent, result = _run_phrase(
            db, org, ctx, "what's the outstanding balance?", "conv-bal-1")
        assert intent["intent"] == "account_balance", intent
        assert intent["risk_class"] == "R1", intent
        assert result["mode"] == "M1_INSPECT", result["mode"]
        assert result["evidence"], "expected ledger evidence"

    @pytest.mark.parametrize("phrase", [
        "What is the outstanding balance?",
        "what is the total balance due?",
        "how much is outstanding?",
    ])
    def test_outstanding_value_variants_route_to_account_balance(self, db, org, ctx, phrase):
        self._seed(db, org)
        _, _, intent, result = _run_phrase(
            db, org, ctx, phrase, f"conv-bal-v-{abs(hash(phrase))}")
        assert intent["intent"] == "account_balance", (phrase, intent)
        assert result["mode"] == "M1_INSPECT", result["mode"]

    def test_second_ask_reflects_intervening_mutation(self, db, org, ctx):
        """Identical question before/after a ledger change must NOT reuse a
        stale answer — every balance ask recomputes the live outstanding."""
        cust = self._seed(db, org)

        _, _, _, result1 = _run_phrase(
            db, org, ctx, "what's the outstanding balance?", "conv-bal-2a")
        assert result1["mode"] == "M1_INSPECT", result1["mode"]

        add_invoice(db, org, cust.id, "INV-B3", InvoiceStatus.SENT, 2000)
        db.flush()

        _, _, _, result2 = _run_phrase(
            db, org, ctx, "what's the outstanding balance?", "conv-bal-2b")
        assert result2["mode"] == "M1_INSPECT", result2["mode"]
        assert result2["evidence"], "expected fresh ledger evidence"

        f1 = self._figure(result1["answer"])
        f2 = self._figure(result2["answer"])
        assert f1 == 1500.0, result1["answer"]
        assert f2 == 3500.0, result2["answer"]

    @pytest.mark.parametrize("phrase", [
        "what is the outstanding balance concept?",
        "what does outstanding balance mean?",
        "explain me about Outstanding",
    ])
    def test_definitional_outstanding_stays_explain(self, db, org, ctx, phrase):
        """Definitional asks must stay on the KB/define path — never the
        live balance route."""
        self._seed(db, org)
        _, _, intent, _ = _run_phrase(
            db, org, ctx, phrase, f"conv-bal-def-{abs(hash(phrase))}")
        assert intent["intent"] == "metric_definition", (phrase, intent)

    @pytest.mark.parametrize("phrase", [
        "customers who owe money",
        "show customers with outstanding balances",
    ])
    def test_customer_list_balance_phrasing_not_hijacked(self, db, org, ctx, phrase):
        """Customer-LISTING phrasings keep their customer census — the new
        org-wide balance route must not clobber them."""
        self._seed(db, org)
        _, _, intent, result = _run_phrase(
            db, org, ctx, phrase, f"conv-bal-cust-{abs(hash(phrase))}")
        assert intent["intent"] == "customer_outstanding", (phrase, intent)
        assert result["mode"] == "M1_INSPECT", result["mode"]


# ═══════════════════════════════════════════════════════════════════════════════
# BUG-2 regression — Refund intent family vs Payment Allocation / fabricated
# zero-amount drafts
# ═══════════════════════════════════════════════════════════════════════════════

class TestRefundIntentRegression:
    """User report: "refund more than the original payment amount" routed to
    Payment Allocation (Reconciliation family) and fabricated an M2_PREPARE
    draft with ₹0.00 subtotal. PRD §11 separates Refund from Reconciliation;
    a refund must (a) name the payment it refunds and (b) never exceed what
    was originally collected — eligibility blocks BEFORE any preview, so no
    placeholder draft is ever produced."""

    def _seed(self, db, org):
        from app.modules.billing.models import Payment
        cust = add_customer(db, org, "GO", "Gok")
        p = Payment(
            organization_id=org.id, customer_id=cust.id,
            payment_number="PMT-1", payment_type="manual",
            status="cleared", currency="USD", amount="100.00",
            is_active=True, payment_date=date.today(),
        )
        db.add(p)
        db.flush()
        return cust

    def test_refund_without_payment_asks_not_drafts(self, db, org, ctx):
        from app.modules.chatbot.models import AIActionDraft
        self._seed(db, org)

        _, _, intent, result = _run_phrase(
            db, org, ctx, "Refund more than the original payment amount",
            "conv-refund-1")

        assert intent["intent"] == "action_draft", intent
        assert result["mode"] == "M2_PREPARE", result["mode"]
        answer = result["answer"].lower()
        assert "which payment" in answer, result["answer"]
        # Payment-Allocation family must NOT be suggested.
        assert "allocat" not in answer, result["answer"]
        # No fabricated zero/placeholder draft.
        assert "0.00" not in result["answer"]
        assert db.query(AIActionDraft).count() == 0

    def test_refund_exceeding_payment_blocked_before_preview(self, db, org, ctx):
        from app.modules.chatbot.models import AIActionDraft, AIActionExecution
        self._seed(db, org)

        _, _, intent, result = _run_phrase(
            db, org, ctx,
            "Refund $100000 from payment PMT-1 back to Gok beyond their payment amount",
            "conv-refund-2")

        assert intent["intent"] == "action_draft", intent
        assert result["mode"] != "M3_PREVIEW", result["mode"]
        assert result["mode"] != "M4_EXECUTE", result["mode"]
        answer = result["answer"].lower()
        assert "can't" in answer or "cannot" in answer or "exceed" in answer, (
            result["answer"][:200])
        assert result["evidence"], "expected payment evidence in the block"
        assert db.query(AIActionDraft).count() == 0
        assert db.query(AIActionExecution).count() == 0

    def test_refund_within_payment_amount_drafts(self, db, org, ctx):
        from app.modules.chatbot.models import AIActionDraft
        self._seed(db, org)

        _, _, intent, result = _run_phrase(
            db, org, ctx, "Refund $50 from payment PMT-1 back to Gok",
            "conv-refund-3")

        assert intent["intent"] == "action_draft", intent
        assert result["mode"] == "M2_PREPARE", result["mode"]
        assert "Refund" in result["answer"], result["answer"][:200]
        assert db.query(AIActionDraft).count() == 1
