"""Live verification for items Q1 (collision-risk), Q2 (dashboard figures),
and RT-006 (refund guard).

All tests run through the REAL engine pipeline (classify → dispatch → handler)
against an in-memory DB seeded with known data.

Run: python -m pytest tests/ai_assistant/test_q1_q2_rt006_live.py -v
"""
import pytest
from datetime import date, timedelta
from decimal import Decimal
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer, CustomerStatus,
    Invoice, InvoiceStatus,
    Payment, PaymentStatus, PaymentType,
)
from app.modules.billing.services.dashboard_service import BillingDashboardService
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus


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
    o = Organization(organization_name="Q1Q2 Test Org", organization_code="Q1Q2")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="q1q2",
        tenant_name="Q1Q2 Test Org",
    )


def _conv(db, org):
    conv = AIConversation(
        conversation_uid="q1q2-conv", tenant_context_id=1,
        organization_id=org.id, user_id=1, title="q1q2",
        conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv


def _ask(ce, conv, ctx, phrase):
    intent = ce._classify_intent(conv, phrase, ctx)
    handler = ce._get_handler(intent["domain"])
    result = handler(conv, phrase, intent, ctx)
    return intent, result


@pytest.fixture()
def data(db, org):
    """Seed: TOM customer (USD, paid invoices + cleared payments) and
    Sales Corp customer (USD) for collision-risk testing."""
    today = date.today()

    # ── Customers ────────────────────────────────────────────────────────
    tom = BillingCustomer(
        organization_id=org.id, customer_code="CUST-TOM",
        company_name="TOM", display_name="TOM Ltd",
        email="tom@example.com", currency="USD",
    )
    sales = BillingCustomer(
        organization_id=org.id, customer_code="CUST-SALES",
        company_name="Sales Corp", display_name="Sales Corp",
        email="sales@example.com", currency="USD",
    )
    db.add_all([tom, sales]); db.flush()

    # ── TOM invoices ─────────────────────────────────────────────────────
    inv_paid1 = Invoice(
        organization_id=org.id, customer_id=tom.id,
        invoice_number="INV-TOM-001", status=InvoiceStatus.PAID,
        issue_date=today, due_date=today,
        total_amount="500.00", paid_amount="500.00",
        balance_due="0.00", currency="USD",
    )
    inv_paid2 = Invoice(
        organization_id=org.id, customer_id=tom.id,
        invoice_number="INV-TOM-002", status=InvoiceStatus.PAID,
        issue_date=today, due_date=today,
        total_amount="200.00", paid_amount="200.00",
        balance_due="0.00", currency="USD",
    )
    inv_sent = Invoice(
        organization_id=org.id, customer_id=tom.id,
        invoice_number="INV-TOM-003", status=InvoiceStatus.SENT,
        issue_date=today, due_date=today + timedelta(days=30),
        total_amount="300.00", paid_amount="0.00",
        balance_due="300.00", currency="USD",
    )
    db.add_all([inv_paid1, inv_paid2, inv_sent]); db.flush()

    # ── TOM payments ─────────────────────────────────────────────────────
    pay1 = Payment(
        organization_id=org.id, customer_id=tom.id,
        payment_number="PAY-TOM-001",
        amount=Decimal("500.00"), currency="USD",
        status=PaymentStatus.CLEARED,
        payment_type=PaymentType.INVOICE_PAYMENT,
        payment_date=today,
    )
    pay2 = Payment(
        organization_id=org.id, customer_id=tom.id,
        payment_number="PAY-TOM-002",
        amount=Decimal("200.00"), currency="USD",
        status=PaymentStatus.CLEARED,
        payment_type=PaymentType.INVOICE_PAYMENT,
        payment_date=today,
    )
    db.add_all([pay1, pay2]); db.flush()

    return {"tom": tom, "sales": sales, "payments": [pay1, pay2]}


# ── Item 2c(a): "show Sales Corp" finds the real customer ────────────────────

class TestCollisionRiskRealCustomer:
    def test_show_sales_corp_finds_customer(self, db, org, ctx, data):
        """A customer literally named 'Sales Corp' exists — confirm
        'show Sales Corp' routes to customer_search despite 'sales' being
        in _FUZZY_CANONICAL_LEXICON."""
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org)
        intent = ce._rules_classify_intent("show Sales Corp", ctx=ctx)
        assert intent["intent"] == "customer_search", (
            f"Expected customer_search, got {intent['intent']}. "
            f"The _has_matching_customer override should allow a real customer "
            f"named 'Sales Corp' to be found despite 'sales' being in the domain lexicon."
        )

    def test_show_financial_year_abstains(self, db, org, ctx, data):
        """No customer named 'financial year' exists — confirm
        'show financial year' does NOT route to customer_search."""
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org)
        intent = ce._rules_classify_intent("show financial year", ctx=ctx)
        assert intent["intent"] != "customer_search", (
            f"Expected NOT customer_search, got {intent['intent']}. "
            f"Without a matching customer record, the domain-term guard should "
            f"prevent 'financial year' from being treated as a customer lookup."
        )


# ── Item 3: Dashboard figures for TOM ────────────────────────────────────────

class TestDashboardFiguresForTom:
    def test_show_financial_summary_figures(self, db, org, ctx, data):
        """Run 'Show financial summary' through the real engine and verify
        the Paid Amount and Collections figures are reported correctly.
        Paid Amount = sum of total_amount for PAID invoices = 500 + 200 = 700
        Collections = sum of amount for CLEARED payments = 500 + 200 = 700
        (In single-currency with no credits these legitimately match.)"""
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org)
        intent, result = _ask(ce, conv, ctx, "Show financial summary")

        # Routing
        assert intent["intent"] == "dashboard_summary"
        assert intent["domain"] == "dashboard"
        assert result["mode"] == "M1_INSPECT"

        answer = result["answer"]

        # Cross-check against live KPIs
        svc = BillingDashboardService(db)
        kpis = svc.get_kpis(organization_id=org.id, currency_rates={}, use_cache=False)

        paid_amount = Decimal(str(kpis["paid_amount"]))
        collections = Decimal(str(kpis["collections"]))

        print(f"\n  [DASHBOARD] paid_amount  = {paid_amount}")
        print(f"  [DASHBOARD] collections = {collections}")
        print(f"  [DASHBOARD] answer snippet: {answer[:300]}")

        # The answer must contain both figures
        assert str(int(paid_amount)) in answer or f"{paid_amount}" in answer, \
            f"Paid Amount {paid_amount} not found in answer: {answer}"
        assert str(int(collections)) in answer or f"{collections}" in answer, \
            f"Collections {collections} not found in answer: {answer}"

        # Labels must be disambiguated
        assert "value of paid invoices" in answer.lower() or "paid amount" in answer.lower(), \
            f"Missing 'Paid Amount' label in answer: {answer}"
        assert "cleared payments" in answer.lower() or "collections" in answer.lower(), \
            f"Missing 'Collections' label in answer: {answer}"


# ── Item 4: RT-006 live refund guard ─────────────────────────────────────────

class TestRT006RefundGuard:
    def test_overrefund_blocked_live(self, db, org, ctx, data):
        """Run 'Refund $50,000 from payment PAY-TOM-001 ($500 payment)'
        through the real engine pipeline. The refund MUST be blocked —
        the payment amount is $500, the refund is $50,000. Paste the
        EXACT response text."""
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org)

        phrase = "Refund $50,000 from payment PAY-TOM-001"
        intent, result = _ask(ce, conv, ctx, phrase)

        answer = result["answer"]

        print(f"\n  [RT-006] intent: {intent['intent']}")
        print(f"  [RT-006] mode:   {result['mode']}")
        print(f"  [RT-006] EXACT RESPONSE TEXT:")
        print(f"  {'='*60}")
        for line in answer.split("\n"):
            print(f"  {line}")
        print(f"  {'='*60}")

        # The response MUST contain a refusal / guard message
        lower = answer.lower()
        assert any(kw in lower for kw in [
            "exceeds", "cannot", "cannot refund", "over-refund",
            "payment amount", "500", "exceed",
        ]), f"RT-006 guard did not fire — answer: {answer}"

        # Verify no draft/execution rows were created
        from app.modules.billing.models import Refund, RefundStatus
        refunds = db.query(Refund).filter(
            Refund.organization_id == org.id,
        ).all()
        assert len(refunds) == 0, (
            f"RT-006 guard should not create any refund rows, "
            f"but found {len(refunds)}"
        )
