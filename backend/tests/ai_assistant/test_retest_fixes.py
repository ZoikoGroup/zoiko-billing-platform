"""
test_retest_fixes.py
--------------------
Regression tests for the three issues found in the retest round:
  ISSUE 1 — Suggested example text with $ and quote marks
  ISSUE 2 — Customer lookup fails for short names (e.g. "Go")
  ISSUE 3 — "Delivered" status returns irrelevant content
"""
import re

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import BillingCustomer
from app.modules.chatbot.conversation.engine import ConversationEngine
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
def kb(db):
    """Minimal approved KB so status-list questions ground via retrieval.
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
def customers(db, org):
    """Create customers that exercise various name fields.

    The 'Go' customer mirrors the real scenario: company_name='GOk',
    display_name='Go Enterprises' — so both 'Go' and 'GOk' should resolve.
    """
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
    c3 = BillingCustomer(
        organization_id=org.id, customer_code="CUST-GLO",
        company_name="GlobalTech", display_name="Glo",
        email="info@globaltech.com", currency="USD",
    )
    db.add_all([c1, c2, c3])
    db.flush()
    return {"go": c1, "acme": c2, "glo": c3}


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 1 — Dollar sign parsing and quote-wrapping
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue1_DollarSignParsing:
    """Verify $500 is extracted as an amount and action intent is detected
    even when the input contains wrapping quote marks."""

    def test_rules_classify_action_with_dollar_sign(self, db, org, customers):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._rules_classify_intent(
            'Create an invoice for GOk for Consulting services at $500'
        )
        assert result["intent"] == "action_draft", (
            f"Expected action_draft but got {result['intent']}"
        )
        assert result["domain"] == "action"

    def test_rules_classify_action_with_quotes_and_dollar(self, db, org, customers):
        """Input wrapped in double-quotes (as user copies from suggestion)."""
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._rules_classify_intent(
            '"Create an invoice for GOk for Consulting services at $500"'
        )
        assert result["intent"] == "action_draft", (
            f"Expected action_draft but got {result['intent']}"
        )

    def test_dollar_amount_extracted(self, db, org, customers, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        params = engine._extract_action_params(
            "Create an invoice for Go for Consulting services at $500",
            "invoice_draft", ctx,
        )
        assert params.get("amount") == "500", (
            f"Expected amount='500' but got {params.get('amount')}"
        )
        assert params.get("customer_id") is not None, (
            "Expected customer_id to be resolved"
        )
        assert params.get("line_items"), "Expected line_items to be built"

    def test_rupee_amount_also_works(self, db, org, customers, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        params = engine._extract_action_params(
            "Create an invoice for Acme Corp for Consulting services at ₹5000",
            "invoice_draft", ctx,
        )
        assert params.get("amount") == "5000", (
            f"Expected amount='5000' but got {params.get('amount')}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 2 — Customer lookup fails for short names
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue2_CustomerLookup:
    """Verify customer resolution works for short names like 'Go' across
    display_name, company_name, customer_code, and email."""

    def test_resolve_customer_by_company_name(self, db, org, customers, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._resolve_customer("GOk", ctx)
        assert result is not None, "Expected to find customer 'GOk' by company_name"
        assert result.company_name == "GOk"

    def test_resolve_customer_by_display_name(self, db, org, customers, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._resolve_customer("Glo", ctx)
        assert result is not None, "Expected to find customer 'Glo' by display_name"
        assert result.customer_code == "CUST-GLO"

    def test_resolve_customer_by_email(self, db, org, customers, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._resolve_customer("billing@acme.com", ctx)
        assert result is not None, "Expected to find customer by email"
        assert result.company_name == "Acme Corp"

    def test_resolve_customer_by_customer_code(self, db, org, customers, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine._resolve_customer("CUST-ACME", ctx)
        assert result is not None, "Expected to find customer by customer_code"
        assert result.company_name == "Acme Corp"

    def test_lookup_customer_go_finds_result(self, db, org, customers, ctx):
        """The 'Look up customer details Go' path — 'Go' should match via
        display_name='Go Enterprises' even though company_name='GOk'."""
        engine = ConversationEngine(db, model_gateway=None)
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid="test-conv", tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id, user_id=ctx.user_id,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()

        result = engine._lookup_customer(
            "Look up customer details Go",
            "look up customer details go",
            conv, ctx,
        )
        assert "GOk" in result["answer"] or "Go" in result["answer"], (
            f"Expected customer 'GOk'/'Go' in answer but got: {result['answer']}"
        )
        assert "No customer found" not in result["answer"], (
            f"Got 'No customer found' but should have found 'Go': {result['answer']}"
        )

    def test_lookup_customer_gok_finds_result(self, db, org, customers, ctx):
        """Verify 'GOk' resolves via company_name='GOk'."""
        engine = ConversationEngine(db, model_gateway=None)
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid="test-conv-2", tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id, user_id=ctx.user_id,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()

        result = engine._lookup_customer(
            "Look up customer details GOk",
            "look up customer details gok",
            conv, ctx,
        )
        assert "GOk" in result["answer"], (
            f"Expected customer 'GOk' in answer but got: {result['answer']}"
        )

    def test_extract_action_params_finds_go(self, db, org, customers, ctx):
        """Invoice creation draft path also resolves 'Go' via display_name fallback."""
        engine = ConversationEngine(db, model_gateway=None)
        params = engine._extract_action_params(
            "Create an invoice for Go for Consulting at $500",
            "invoice_draft", ctx,
        )
        assert params.get("customer_id") is not None, (
            f"Expected customer_id to be resolved but got None"
        )
        assert params.get("customer_id") == customers["go"].id, (
            f"Expected customer_id={customers['go'].id} but got {params.get('customer_id')}"
        )

    def test_extract_action_params_at_amount_after_customer(self, db, org, customers, ctx):
        """'invoice for <customer> at <amount>' phrasing must still resolve the
        customer — the 'at' + amount must NOT be absorbed into the customer name.

        Regression: 'draft an invoice for Acme at $500' previously resolved no
        customer (the '$' broke the capture), and '... at 500' treated the whole
        'Acme at 500' string as the customer name, so no draft was created for
        the intended customer.
        """
        engine = ConversationEngine(db, model_gateway=None)
        for phrase, expected in [
            ("Create an invoice for Acme at $250", customers["acme"].id),
            ("Create an invoice for Acme at 250", customers["acme"].id),
            ("draft an invoice for Go at $500", customers["go"].id),
        ]:
            params = engine._extract_action_params(phrase, "invoice_draft", ctx)
            assert params.get("customer_id") == expected, (
                f"Expected customer_id={expected} for {phrase!r} "
                f"but got {params.get('customer_id')} (customer_name={params.get('customer_name')!r})"
            )
            assert params.get("amount") in ("250", "500"), (
                f"Expected amount for {phrase!r} but got {params.get('amount')}"
            )


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 3 — "Delivered" status response
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue3_DeliveredStatus:
    """Verify status-definition queries return correct answers even when
    routed to _handle_billing (not just _handle_help)."""

    def _make_conv(self, db, org):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid="test-conv-status", tenant_context_id=1,
            organization_id=org.id, user_id=1,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()
        return conv

    def test_delivered_not_valid_in_help_handler(self, db, org, customers, ctx):
        """Status question routed to _handle_help — should say 'not valid'."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(
            conv, "What does 'Delivered' mean for invoice status?", intent, ctx,
        )
        answer = result["answer"]
        assert "Delivered" in answer
        assert "not a valid invoice status" in answer, (
            f"Expected 'not a valid invoice status' but got:\n{answer}"
        )
        assert "Draft" in answer
        assert "Sent" in answer
        assert "Paid" in answer

    def test_delivered_not_valid_in_billing_handler(self, db, org, customers, ctx):
        """Status question routed to _handle_billing — should ALSO say 'not valid'."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "general_billing_lookup", "domain": "billing", "risk_class": "R1"}
        result = engine._handle_billing(
            conv, "What does 'Delivered' mean for invoice status?", intent, ctx,
        )
        answer = result["answer"]
        assert "Delivered" in answer
        assert "not a valid invoice status" in answer, (
            f"Expected 'not a valid invoice status' in billing handler but got:\n{answer}"
        )
        assert "Draft" in answer
        assert "Sent" in answer
        assert "Paid" in answer

    def test_valid_status_returns_definition(self, db, org, customers, ctx):
        """A valid status like 'overdue' should return its definition."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(
            conv, "What does 'overdue' mean for invoice status?", intent, ctx,
        )
        answer = result["answer"]
        assert "overdue" in answer.lower()
        assert "Payment due date has passed" in answer

    def test_pending_not_valid(self, db, org, customers, ctx):
        """'Pending' is also not a valid status — should list valid ones."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(
            conv, "What does 'Pending' mean for invoice status?", intent, ctx,
        )
        answer = result["answer"]
        assert "Pending" in answer
        assert "not a valid invoice status" in answer


# ═══════════════════════════════════════════════════════════════════════════════
# Intent cross-check override
# ═══════════════════════════════════════════════════════════════════════════════

class TestIntentCrossCheck:
    """Verify the rules override logic prevents model misclassification
    from routing action intents to the wrong handler."""

    def test_rules_override_when_model_misses_action(self, db, org, customers, ctx):
        """If rules detect action_draft but model doesn't, rules should win."""
        engine = ConversationEngine(db, model_gateway=None)

        class FakeGateway:
            def complete(self, **kwargs):
                class R:
                    content = '{"domain": "help", "intent": "help_general", "confidence": 0.7}'
                    def content_hash(self): return "abc"
                    usage = {"latency_ms": 10}
                return R()

        engine._gateway = FakeGateway()

        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid="test-conv-cross", tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id, user_id=ctx.user_id,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()

        result = engine._classify_intent(
            conv, "Create an invoice for Go for Consulting at $500", ctx,
        )
        assert result["intent"] == "action_draft", (
            f"Expected action_draft after rules override but got {result['intent']}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 4 — "What are the valid invoice statuses?" direct question
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue4_StatusListQuestion:
    """Verify that direct questions about valid statuses return the status list,
    not audit logging or unrelated content."""

    @staticmethod
    def _make_conv(db, org):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid="test-conv-status-list",
            tenant_context_id=1,
            organization_id=org.id, user_id=1,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()
        return conv

    def test_what_are_valid_statuses_help(self, db, org, ctx, kb):
        """'What are the valid invoice statuses?' should return status list."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(
            conv, "What are the valid invoice statuses?", intent, ctx,
        )
        answer = result["answer"]
        assert "Draft" in answer
        assert "Sent" in answer
        assert "Paid" in answer
        assert "Overdue" in answer
        assert "Cancelled" in answer
        assert "Partially Paid" in answer
        assert "Refunded" in answer
        assert "Written Off" in answer

    def test_what_are_valid_statuses_billing(self, db, org, ctx, kb):
        """Same question routed to _handle_billing should also return status list."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "billing", "risk_class": "R1"}
        result = engine._handle_billing(
            conv, "What are the valid invoice statuses?", intent, ctx,
        )
        answer = result["answer"]
        assert "Draft" in answer
        assert "Sent" in answer
        assert "Written Off" in answer

    def test_list_all_statuses(self, db, org, ctx, kb):
        """'List all invoice statuses' should also work."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(
            conv, "List all invoice statuses", intent, ctx,
        )
        answer = result["answer"]
        assert "Draft" in answer
        assert "Written Off" in answer

    def test_status_list_not_about_audit_logging(self, db, org, ctx, kb):
        """Status list response must NOT mention audit logging or unallocated payments."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "help_general", "domain": "help", "risk_class": "R0"}
        result = engine._handle_help(
            conv, "What are the valid invoice statuses?", intent, ctx,
        )
        answer = result["answer"].lower()
        assert "audit" not in answer
        assert "unallocated" not in answer


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 5 — T05: financial facts must come from live authoritative queries
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue5_T05FinancialConsistency:
    """T05 guardrail: financial questions (balance, dashboard) MUST be answered
    from live DB queries, never from RAG knowledge snippets, and all phrasings
    must produce the SAME authoritative figure."""

    @staticmethod
    def _make_conv(db, org):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid=f"test-conv-t05-{id(org)}",
            tenant_context_id=1,
            organization_id=org.id, user_id=1,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()
        return conv

    def test_balance_question_never_routed_to_help_rag(self, db, org, ctx):
        """If the model misclassifies 'What's my outstanding balance?' as help,
        the rules override MUST force billing so RAG snippets are never shown."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)

        class FakeGateway:
            def complete(self, **kwargs):
                class R:
                    content = '{"domain": "help", "intent": "help_general", "confidence": 0.9}'
                    def content_hash(self): return "abc"
                    usage = {"latency_ms": 10}
                return R()

        engine._gateway = FakeGateway()
        result = engine._classify_intent(
            conv, "What's my outstanding balance?", ctx,
        )
        assert result["domain"] == "billing", (
            f"Expected billing after rules override but got {result['domain']}"
        )
        assert result["intent"] == "account_balance"

    def test_dashboard_question_never_routed_to_help_rag(self, db, org, ctx):
        """Same guardrail for 'Dashboard summary' -> must stay in dashboard domain."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)

        class FakeGateway:
            def complete(self, **kwargs):
                class R:
                    content = '{"domain": "help", "intent": "help_general", "confidence": 0.9}'
                    def content_hash(self): return "abc"
                    usage = {"latency_ms": 10}
                return R()

        engine._gateway = FakeGateway()
        result = engine._classify_intent(
            conv, "Dashboard summary", ctx,
        )
        assert result["domain"] == "dashboard", (
            f"Expected dashboard after rules override but got {result['domain']}"
        )
        assert result["intent"] == "dashboard_summary"

    def test_action_question_never_routed_away(self, db, org, ctx):
        """If the model returns a non-action domain for an action question,
        the rules result must win."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)

        class FakeGateway:
            def complete(self, **kwargs):
                class R:
                    content = '{"domain": "help", "intent": "help_general", "confidence": 0.9}'
                    def content_hash(self): return "abc"
                    usage = {"latency_ms": 10}
                return R()

        engine._gateway = FakeGateway()
        result = engine._classify_intent(
            conv, "Create an invoice for Go for Consulting at $500", ctx,
        )
        assert result["domain"] == "action", (
            f"Expected action after rules override but got {result['domain']}"
        )
        assert result["intent"] == "action_draft"

    def test_balance_and_dashboard_answers_consistent(self, db, org, ctx):
        """'What's my outstanding balance?' and 'Dashboard summary' must both
        reflect the SAME outstanding figure computed by BillingDashboardService."""
        from app.modules.billing.services.dashboard_service import BillingDashboardService

        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)

        balance_intent = {"intent": "account_balance", "domain": "billing", "risk_class": "R1"}
        dash_intent = {"intent": "dashboard_summary", "domain": "dashboard", "risk_class": "R1"}
        bal = engine._handle_billing(conv, "What's my outstanding balance?", balance_intent, ctx)
        dash = engine._handle_dashboard(conv, "Dashboard summary", dash_intent, ctx)

        svc = BillingDashboardService(db)
        kpis = svc.get_kpis(organization_id=ctx.organization_id)
        expected = kpis.get("outstanding_amount", 0)

        if expected:
            assert str(expected) in bal["answer"], "balance answer missing authoritative figure"
            assert str(expected) in dash["answer"], "dashboard answer missing authoritative figure"
        else:
            assert "no outstanding balance" in bal["answer"]
            assert "0.00" in dash["answer"]


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 6 — Aggregate outstanding == sum of per-customer outstanding
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue6_AggregateEqualsComponents:
    """T05 data-integrity: org-wide outstanding MUST equal the sum of each
    customer's individual outstanding. Guards against the stale cached-column
    bug where per-customer showed 0 while the aggregate showed a real balance."""

    @staticmethod
    def _make_customer(db, org, name, code):
        from app.modules.billing.models import BillingCustomer
        c = BillingCustomer(
            organization_id=org.id, company_name=name, display_name=name,
            customer_code=code, status="active", currency="USD",
        )
        db.add(c)
        db.flush()
        return c

    @staticmethod
    def _make_invoice(db, org, cust, status, total, balance):
        from datetime import date, timedelta
        from app.modules.billing.repositories.invoice import Invoice
        from app.modules.billing.models import InvoiceStatus
        inv = Invoice(
            organization_id=org.id, customer_id=cust.id, status=InvoiceStatus(status),
            currency="USD", total_amount=total, balance_due=balance, paid_amount=total - balance,
            is_active=True, invoice_number=f"INV-{total}-{status}",
            issue_date=date.today(), due_date=date.today() + timedelta(days=30),
        )
        db.add(inv)
        db.flush()
        return inv

    def test_aggregate_equals_sum_of_customers(self, db, org, ctx):
        """With one SENT invoice on customer A and none on customer B, the
        org aggregate must equal customer A's outstanding (customer B = 0)."""
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        from app.modules.billing.services.customer_service import CustomerService

        c1 = self._make_customer(db, org, "Alpha", "A-1")
        c2 = self._make_customer(db, org, "Beta", "B-1")
        self._make_invoice(db, org, c1, "sent", 500, 500)

        svc = BillingDashboardService(db)
        kpis = svc.get_kpis(organization_id=org.id)
        agg = kpis.get("outstanding_amount", 0)
        by_customer = svc.get_outstanding_by_customer(org.id)

        per_cust = {r["customer_id"]: r["outstanding"] for r in by_customer}
        assert c1.id in per_cust, "customer with SENT invoice missing from breakdown"
        assert abs(per_cust.get(c1.id, 0) - 500.0) < 0.01
        assert abs(per_cust.get(c2.id, 0) - 0.0) < 0.01
        assert abs(sum(per_cust.values()) - agg) < 0.01, (
            f"sum of per-customer ({sum(per_cust.values())}) != aggregate ({agg})"
        )

        # Customer analytics must agree (regression for the stale cached column).
        cs = CustomerService(db)
        a1 = cs.get_customer_analytics(org.id, c1.id)
        a2 = cs.get_customer_analytics(org.id, c2.id)
        assert abs(float(a1["outstanding_balance"]) - agg) < 0.01
        assert abs(float(a2["outstanding_balance"]) - 0.0) < 0.01

    def test_draft_excluded_from_count_and_outstanding(self, db, org, ctx):
        """A DRAFT invoice must count as neither an invoice nor outstanding —
        so 'Dashboard summary' and 'outstanding balance' report the SAME count."""
        from app.modules.billing.services.dashboard_service import BillingDashboardService

        c1 = self._make_customer(db, org, "Alpha", "A-1")
        self._make_invoice(db, org, c1, "draft", 5000, 5000)
        self._make_invoice(db, org, c1, "sent", 500, 500)

        svc = BillingDashboardService(db)
        kpis = svc.get_kpis(organization_id=org.id)
        assert kpis.get("total_invoices") == 1, (
            f"draft must be excluded from total_invoices, got {kpis.get('total_invoices')}"
        )
        assert abs(kpis.get("outstanding_amount", 0) - 500.0) < 0.01


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 7 — "How many customers are there?" must return the live count
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue7_CustomerCountQuestion:
    """Regression for Issue 3: customer-count questions must route to the live
    customer count handler, never fall through to RAG knowledge snippets."""

    @staticmethod
    def _make_conv(db, org):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid=f"test-conv-custcount-{id(org)}",
            tenant_context_id=1,
            organization_id=org.id, user_id=1,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()
        return conv

    def test_rules_route_customer_count_to_dashboard(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        result = engine._classify_intent(conv, "How many customers are there?", ctx)
        assert result["domain"] == "dashboard"
        assert result["intent"] == "customer_count"

    def test_handle_dashboard_returns_live_count(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)
        intent = {"intent": "customer_count", "domain": "dashboard", "risk_class": "R1"}
        result = engine._handle_dashboard(conv, "How many customers are there?", intent, ctx)
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        svc = BillingDashboardService(db)
        kpis = svc.get_kpis(organization_id=org.id)
        expected = kpis.get("active_customers", 0)
        assert str(expected) in result["answer"]
        # Must NOT be a credit-note/refund RAG snippet
        assert "credit note" not in result["answer"].lower()
        assert "refund" not in result["answer"].lower()

    def test_model_help_classification_still_routed_to_count(self, db, org, ctx):
        """Even if the model misclassifies the question as help, the rules
        override must route to the customer count (financial domain)."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org)

        class FakeGateway:
            def complete(self, **kwargs):
                class R:
                    content = '{"domain": "help", "intent": "help_general", "confidence": 0.9}'
                    def content_hash(self): return "abc"
                    usage = {"latency_ms": 10}
                return R()

        engine._gateway = FakeGateway()
        result = engine._classify_intent(conv, "How many customers are there?", ctx)
        assert result["domain"] == "dashboard"
        assert result["intent"] == "customer_count"


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE 8 — "List customers" must return the live customer list
# ═══════════════════════════════════════════════════════════════════════════════

class TestIssue8_ListCustomers:
    """Regression for listing-customers questions: 'list customers', 'show
    customers', 'who are my customers?' etc. must return the live customer
    list from the DB — never 'No customer found matching that name' or RAG
    knowledge snippets. Single lookups ('show customer X') must stay single."""

    @staticmethod
    def _make_conv(db, org, suffix="0"):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid=f"test-conv-listcust-{id(org)}-{suffix}",
            tenant_context_id=1,
            organization_id=org.id, user_id=1,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()
        return conv

    def _ask(self, db, org, ctx, phrase, suffix="0"):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._make_conv(db, org, suffix)
        intent = engine._classify_intent(conv, phrase, ctx)
        handler = engine._get_handler(intent["domain"])
        return intent, handler(conv, phrase, intent, ctx)

    def test_list_customers_returns_live_list(self, db, org, customers, ctx):
        intent, result = self._ask(db, org, ctx, "List all customers")
        assert intent["domain"] == "billing"
        answer = result["answer"]
        assert "GOk" in answer and "Acme Corp" in answer and "GlobalTech" in answer
        assert "customer(s)" in answer
        assert "No customer found" not in answer

    def test_plural_phrasings_all_return_list(self, db, org, customers, ctx):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        engine = ConversationEngine(db, model_gateway=None)
        for i, phrase in enumerate(("list customers", "show customers", "Show me my customers",
                                    "List my customers", "Show all customers", "Display all customers",
                                    "list the customers")):
            conv = AIConversation(
                conversation_uid=f"test-conv-listcust-{id(org)}-{i}",
                tenant_context_id=1, organization_id=org.id, user_id=1,
                title="test", conversation_status=ConversationStatus.OPEN,
            )
            db.add(conv)
            db.flush()
            intent = engine._classify_intent(conv, phrase, ctx)
            handler = engine._get_handler(intent["domain"])
            result = handler(conv, phrase, intent, ctx)
            assert intent["domain"] == "billing", f"{phrase!r} not routed to billing: {intent}"
            assert "customer(s)" in result["answer"], f"{phrase!r} did not return a list"

    def test_who_are_my_customers_not_rag(self, db, org, customers, ctx):
        intent, result = self._ask(db, org, ctx, "Who are my customers?")
        assert intent["domain"] == "billing", f"routed to {intent['domain']} instead of billing"
        answer = result["answer"].lower()
        assert "customer(s)" in answer
        assert "credit note" not in answer and "refund" not in answer
        assert "dunning" not in answer

    def test_single_customer_lookup_is_not_list(self, db, org, customers, ctx):
        intent, result = self._ask(db, org, ctx, "show customer GOk")
        assert intent["domain"] == "billing"
        answer = result["answer"]
        assert "**Customer: GOk**" in answer
        assert "customer(s) in your organization" not in answer

    def test_customer_details_phrase_routes_to_billing(self, db, org, customers, ctx):
        intent, result = self._ask(db, org, ctx, "customer details for GOk")
        assert intent["domain"] == "billing", f"routed to {intent['domain']} instead of billing"
        assert "**Customer: GOk**" in result["answer"]

    def test_show_invoices_is_list_not_single_lookup(self, db, org, customers, ctx):
        """Regression: 'show invoices' used to extract a bogus 'INV-S'
        reference (plural suffix parsed as a reference value) and fall into
        the single-invoice lookup. It must return the invoice list."""
        from app.modules.billing.repositories.invoice import Invoice
        from app.modules.billing.models import InvoiceStatus
        from datetime import date, timedelta
        inv = Invoice(
            organization_id=org.id, customer_id=customers["go"].id,
            status=InvoiceStatus("sent"), currency="USD",
            total_amount=500, balance_due=500, paid_amount=0,
            is_active=True, invoice_number="INV-LIST-1",
            issue_date=date.today(), due_date=date.today() + timedelta(days=30),
        )
        db.add(inv)
        db.flush()

        intent, result = self._ask(db, org, ctx, "Show invoices")
        assert intent["domain"] == "billing"
        answer = result["answer"]
        assert "invoice(s)" in answer
        assert "No invoice found matching that reference" not in answer
        assert "INV-LIST-1" in answer

    def test_list_customers_shows_live_outstanding(self, db, org, ctx):
        """The per-customer outstanding shown in the list must come from the
        same live aggregation as the dashboard (never the stale cached column)."""
        from datetime import date, timedelta
        from app.modules.billing.repositories.invoice import Invoice
        from app.modules.billing.models import InvoiceStatus, BillingCustomer

        c = BillingCustomer(
            organization_id=org.id, company_name="Owed Co", display_name="Owed",
            customer_code="CUST-OWE", status="active", currency="USD",
            outstanding_balance=0.0,
        )
        db.add(c)
        db.flush()
        inv = Invoice(
            organization_id=org.id, customer_id=c.id,
            status=InvoiceStatus("sent"), currency="USD",
            total_amount=700, balance_due=700, paid_amount=0,
            is_active=True, invoice_number="INV-OWE-1",
            issue_date=date.today(), due_date=date.today() + timedelta(days=30),
        )
        db.add(inv)
        db.flush()

        intent, result = self._ask(db, org, ctx, "List all customers")
        answer = result["answer"]
        assert "700" in answer, (
            "list must show LIVE outstanding (700), not the stale cached 0.00"
        )
        assert "**Owed Co**" in answer
