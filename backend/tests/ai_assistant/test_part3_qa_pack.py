"""Part 3 — Live-Data / Real-Query Test Questions

Comprehensive test for the Zoiko Billing Chatbot QA Test Pack v1.0 Part 3.
Seeds realistic billing data and verifies every live-data question routes
correctly and returns a substantive answer (no refusals, no wrong routing).
"""
import pytest
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    Invoice, InvoiceStatus, BillingCustomer, CustomerStatus,
    Payment, PaymentStatus, PaymentType,
    Product, ProductType,
    Quotation, QuoteStatus,
    Subscription, BillingSubscriptionStatus,
    SubscriptionPlan, PlanCategory, BillingPeriod, PricingModel,
    Contract, ContractStatus,
    CreditNote, CreditNoteStatus, CreditNoteType,
    TaxRate, TaxType, TaxApplicability,
)
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus

from tests.conftest import (
    make_customer, make_invoice, make_payment, make_contract,
    make_subscription_plan, make_subscription, make_quotation, make_tax_rate,
)


# ── shared fixtures ─────────────────────────────────────────────────────────

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


# ── helpers ─────────────────────────────────────────────────────────────────

def _conv(db, org, uid="part3"):
    conv = AIConversation(
        conversation_uid=uid,
        tenant_context_id=1,
        organization_id=org.id,
        user_id=1,
        title="part3",
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


def _has_refusal(answer: str) -> bool:
    a = answer.lower()
    return any(p in a for p in [
        "i can't help with that",
        "i cannot help",
        "i'm not able to",
        "outside my scope",
        "can only answer",
        "i don't have access",
        "i'm unable to",
        "no action has been taken",
        "i can't assist",
        "i don't have enough",
    ])


# ── fixture: seed comprehensive billing data ────────────────────────────────

@pytest.fixture()
def part3_data(db, org):
    """Seed a realistic billing dataset covering all Part 3 areas."""
    customers = {}
    for code, name, currency in [
        ("CUST-ACME", "Acme Corp", "INR"),
        ("CUST-GOK", "Globex Inc", "USD"),
        ("CUST-WAYNE", "Wayne Enterprises", "USD"),
        ("CUST-STARK", "Stark Industries", "USD"),
        ("CUST-LEX", "LexCorp", "INR"),
    ]:
        c = make_customer(db, org.id, code=code, currency=currency, email=f"{code.lower()}@test.com")
        c.company_name = name
        c.display_name = name
        c.status = CustomerStatus.ACTIVE
        c.outstanding_balance = Decimal("0.00")
        c.total_revenue = Decimal("0.00")
        db.flush()
        customers[code] = c

    # ── Invoices (various statuses) ─────────────────────────────────────
    invoices = {}
    inv_data = [
        ("INV-1001", "CUST-ACME", InvoiceStatus.SENT,     "5000.00", "0.00",  5),
        ("INV-1002", "CUST-GOK",   InvoiceStatus.SENT,    "12000.00", "0.00",  10),
        ("INV-1003", "CUST-WAYNE", InvoiceStatus.PAID,     "8000.00", "8000.00", -30),
        ("INV-1004", "CUST-ACME",  InvoiceStatus.OVERDUE,  "3500.00", "0.00", -15),
        ("INV-1005", "CUST-STARK", InvoiceStatus.SENT,     "7500.00", "2500.00", 7),
        ("INV-1006", "CUST-LEX",   InvoiceStatus.DRAFT,    "2000.00", "0.00", 14),
        ("INV-1007", "CUST-GOK",   InvoiceStatus.OVERDUE,  "6000.00", "0.00", -20),
        ("INV-1008", "CUST-WAYNE", InvoiceStatus.SENT,     "4500.00", "0.00",  3),
        ("INV-1009", "CUST-STARK", InvoiceStatus.CANCELLED, "1000.00", "0.00", -10),
        ("INV-1010", "CUST-ACME",  InvoiceStatus.PARTIALLY_PAID, "9000.00", "4000.00", 5),
    ]
    for inv_no, cust_key, status, total, paid, due_offset in inv_data:
        inv = make_invoice(
            db, org.id, customers[cust_key].id,
            status=status, total_amount=total, paid_amount=paid,
            invoice_number=inv_no,
        )
        inv.due_date = date.today() + timedelta(days=due_offset)
        inv.currency = customers[cust_key].currency
        db.flush()
        invoices[inv_no] = inv

    # Update customer outstanding balances
    customers["CUST-ACME"].outstanding_balance = Decimal("13500.00")
    customers["CUST-GOK"].outstanding_balance = Decimal("18000.00")
    customers["CUST-WAYNE"].outstanding_balance = Decimal("4500.00")
    customers["CUST-STARK"].outstanding_balance = Decimal("5000.00")
    customers["CUST-LEX"].outstanding_balance = Decimal("2000.00")
    db.flush()

    # ── Payments ────────────────────────────────────────────────────────
    payments = {}
    pay_data = [
        ("PAY-1001", "CUST-WAYNE", "8000.00", PaymentStatus.CLEARED, -5),
        ("PAY-1002", "CUST-STARK", "2500.00", PaymentStatus.CLEARED, -1),
        ("PAY-1003", "CUST-ACME",  "4000.00", PaymentStatus.CLEARED, -2),
        ("PAY-1004", "CUST-GOK",   "5000.00", PaymentStatus.PENDING, 0),
        ("PAY-1005", "CUST-WAYNE", "1500.00", PaymentStatus.CLEARED, -3),
    ]
    for pay_no, cust_key, amount, status, day_offset in pay_data:
        pay = make_payment(
            db, org.id, customers[cust_key].id,
            amount=amount, status=status,
            payment_number=pay_no,
        )
        pay.payment_date = date.today() + timedelta(days=day_offset)
        pay.currency = customers[cust_key].currency
        db.flush()
        payments[pay_no] = pay

    # ── Products ────────────────────────────────────────────────────────
    products = {}
    for code, name, ptype, price in [
        ("PROD-SaaS", "SaaS Platform License", ProductType.SERVICE, "999.00"),
        ("PROD-CONSULT", "Consulting Hours", ProductType.SERVICE, "200.00"),
        ("PROD-HW", "Server Hardware", ProductType.GOOD, "5500.00"),
    ]:
        p = Product(
            organization_id=org.id, code=code, name=name,
            product_type=ptype, default_price=Decimal(price),
            currency="USD", is_active=True,
        )
        db.add(p)
        db.flush()
        products[code] = p

    # ── Quotations ──────────────────────────────────────────────────────
    quotations = {}
    for q_no, cust_key, status, total in [
        ("QT-1001", "CUST-ACME", QuoteStatus.SENT,      "15000.00"),
        ("QT-1002", "CUST-GOK",  QuoteStatus.DRAFT,      "8000.00"),
        ("QT-1003", "CUST-WAYNE",QuoteStatus.ACCEPTED,   "22000.00"),
        ("QT-1004", "CUST-STARK",QuoteStatus.SENT,       "10000.00"),
        ("QT-1005", "CUST-LEX",  QuoteStatus.REJECTED,    "5000.00"),
    ]:
        q = make_quotation(
            db, org.id, customers[cust_key].id,
            status=status, total_amount=total, quote_number=q_no,
        )
        q.currency = customers[cust_key].currency
        db.flush()
        quotations[q_no] = q

    # ── Subscriptions ───────────────────────────────────────────────────
    plan = make_subscription_plan(db, org.id, code="PLAN-STD")
    plan.plan_name = "Standard Plan"
    plan.unit_price = Decimal("99.00")
    db.flush()

    for sub_no, cust_key, status in [
        ("SUB-1001", "CUST-ACME",  BillingSubscriptionStatus.ACTIVE),
        ("SUB-1002", "CUST-GOK",   BillingSubscriptionStatus.ACTIVE),
        ("SUB-1003", "CUST-WAYNE", BillingSubscriptionStatus.PAUSED),
    ]:
        make_subscription(
            db, org.id, customers[cust_key].id, plan.id,
            status=status, subscription_number=sub_no,
        )

    # ── Contracts ───────────────────────────────────────────────────────
    for c_no, cust_key, status in [
        ("CTR-1001", "CUST-ACME",  ContractStatus.ACTIVE),
        ("CTR-1002", "CUST-GOK",   ContractStatus.ACTIVE),
    ]:
        make_contract(db, org.id, customers[cust_key].id, status=status, contract_number=c_no)

    # ── Credit Notes ────────────────────────────────────────────────────
    for cn_no, cust_key, inv_key, total in [
        ("CN-1001", "CUST-ACME", "INV-1004", "500.00"),
        ("CN-1002", "CUST-GOK",  "INV-1007", "1000.00"),
    ]:
        cn = CreditNote(
            organization_id=org.id,
            customer_id=customers[cust_key].id,
            invoice_id=invoices[inv_key].id,
            credit_note_number=cn_no,
            credit_note_type=CreditNoteType.ADJUSTMENT,
            status=CreditNoteStatus.APPROVED,
            subtotal=Decimal(total),
            total_amount=Decimal(total),
            remaining_amount=Decimal(total),
            currency=customers[cust_key].currency,
            issue_date=date.today() - timedelta(days=5),
        )
        db.add(cn)
        db.flush()

    # ── Tax Rates ───────────────────────────────────────────────────────
    make_tax_rate(db, org.id, code="GST-18", rate="18.00", name="GST 18%")
    make_tax_rate(db, org.id, code="VAT-20", rate="20.00", name="VAT 20%", tax_type=TaxType.VAT)

    db.commit()
    return {"customers": customers, "invoices": invoices, "payments": payments,
            "products": products, "quotations": quotations}


# ══════════════════════════════════════════════════════════════════════════════
# PART 3 TEST CASES
# ══════════════════════════════════════════════════════════════════════════════

class TestPart3DashboardOverview:
    """Dashboard / overview questions."""

    @pytest.mark.parametrize("phrase", [
        "Can you give me a summary of the billing dashboard for this month?",
        "What does the overview dashboard look like right now?",
        "Show me a quick snapshot of our current billing status.",
    ])
    def test_dashboard_summary_routing(self, db, org, ctx, part3_data, phrase):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, f"dash-{abs(hash(phrase))}")
        intent, result = _ask(ce, conv, ctx, phrase)
        assert intent["intent"] == "dashboard_summary", (
            f"{phrase!r}: expected dashboard_summary, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"]), f"{phrase!r}: got refusal"


class TestPart3RevenueCollections:
    """Revenue & collections questions."""

    @pytest.mark.parametrize("phrase,expected_intents", [
        ("What is our total revenue for this quarter?", ["metric_revenue", "dashboard_summary"]),
        ("What is my current collected revenue?", ["metric_collections", "dashboard_summary"]),
        ("How much have we collected so far this month?", ["metric_collections", "dashboard_summary"]),
    ])
    def test_revenue_collections_routing(self, db, org, ctx, part3_data, phrase, expected_intents):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, f"rev-{abs(hash(phrase))}")
        intent, result = _ask(ce, conv, ctx, phrase)
        assert intent["intent"] in expected_intents, (
            f"{phrase!r}: expected one of {expected_intents}, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"]), f"{phrase!r}: got refusal"

    def test_metric_comparison_routing(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "rev-compare")
        phrase = "What's the difference between billed revenue and collected revenue right now?"
        intent, result = _ask(ce, conv, ctx, phrase)
        assert intent["intent"] in ("metric_comparison", "dashboard_summary", "metric_revenue", "metric_collections"), (
            f"expected comparison-type intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_outstanding_revenue_routing(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "rev-outstanding")
        phrase = "Show me outstanding (uncollected) revenue as of today."
        intent, result = _ask(ce, conv, ctx, phrase)
        assert intent["intent"] in ("account_balance", "metric_collections", "dashboard_summary", "metric_revenue"), (
            f"expected outstanding/intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])


class TestPart3Invoices:
    """Invoice questions."""

    def test_overdue_invoice_count(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "inv-overdue")
        intent, result = _ask(ce, conv, ctx, "How many invoices are currently overdue?")
        assert intent["intent"] in ("invoice_count", "invoice_list", "dashboard_summary"), (
            f"expected invoice_count/list, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_invoices_for_customer(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "inv-cust")
        intent, result = _ask(ce, conv, ctx, "Show me all invoices issued to Acme Corp this month.")
        assert intent["intent"] in ("invoice_list", "invoice_search", "customer_search", "customer_details"), (
            f"expected invoice/customer list, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_invoice_status_by_id(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "inv-status")
        intent, result = _ask(ce, conv, ctx, "What's the status of invoice INV-1001?")
        assert intent["intent"] in ("invoice_search", "invoice_list"), (
            f"expected invoice_search/list, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_invoices_pending_above_amount(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "inv-pending")
        intent, result = _ask(ce, conv, ctx, "List invoices pending payment above $5,000.")
        assert intent["intent"] in ("invoice_list", "invoice_count"), (
            f"expected invoice_list/count, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_total_unpaid_invoices(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "inv-unpaid")
        intent, result = _ask(ce, conv, ctx, "What's the total value of unpaid invoices right now?")
        assert intent["intent"] in ("invoice_list", "invoice_count", "dashboard_summary", "account_balance"), (
            f"expected invoice/account intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])


class TestPart3Payments:
    """Payment questions."""

    def test_payments_this_week(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "pay-week")
        intent, result = _ask(ce, conv, ctx, "What payments have come in this week?")
        assert intent["intent"] in ("payment_list", "payment_count", "dashboard_summary"), (
            f"expected payment_list/count, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_payment_history_for_customer(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "pay-cust")
        intent, result = _ask(ce, conv, ctx, "Show me the payment history for Acme Corp.")
        assert intent["intent"] in ("payment_list", "customer_search", "customer_details"), (
            f"expected payment/customer intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_payment_for_invoice(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "pay-inv")
        intent, result = _ask(ce, conv, ctx, "Has payment for invoice INV-1001 been received?")
        assert intent["intent"] in ("payment_search", "invoice_search", "payment_list", "invoice_list"), (
            f"expected payment/invoice search, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_total_pending_payments(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "pay-pending")
        intent, result = _ask(ce, conv, ctx, "What's the total amount pending in payments?")
        assert intent["intent"] in ("payment_list", "payment_count", "dashboard_summary"), (
            f"expected payment intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])


class TestPart3Customers:
    """Customer questions."""

    def test_customer_dashboard_summary(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "cust-dash")
        intent, result = _ask(ce, conv, ctx, "Give me a summary of the customers dashboard.")
        assert intent["intent"] in ("customer_dashboard", "dashboard_summary", "customer_count"), (
            f"expected customer/dashboard intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_active_customer_count(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "cust-count")
        intent, result = _ask(ce, conv, ctx, "How many active customers do we have this month?")
        assert intent["intent"] in ("customer_count", "customer_dashboard", "dashboard_summary"), (
            f"expected customer_count/dashboard, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_top_customers_by_revenue(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "cust-top")
        intent, result = _ask(ce, conv, ctx, "Show me the top 5 customers by revenue.")
        assert intent["intent"] in ("customer_list", "customer_dashboard", "dashboard_summary"), (
            f"expected customer_list/dashboard, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_customer_outstanding_balance(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "cust-out")
        intent, result = _ask(ce, conv, ctx, "What's the outstanding balance for Acme Corp?")
        assert intent["intent"] in ("customer_outstanding", "account_balance", "customer_details"), (
            f"expected customer_outstanding/account_balance, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])


class TestPart3ProductsPricing:
    """Products / Pricing questions."""

    def test_pricing_dashboard(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "price-dash")
        intent, result = _ask(ce, conv, ctx, "Can you give me a summary of the pricing dashboard?")
        assert intent["intent"] in ("pricing_dashboard", "product_dashboard", "dashboard_summary"), (
            f"expected pricing/product dashboard, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_active_price_list(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "price-list")
        intent, result = _ask(ce, conv, ctx, "Show me the current active price list for SaaS Platform License.")
        assert intent["intent"] in ("product_list", "product_search", "pricing_dashboard", "product_dashboard"), (
            f"expected product/pricing intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_products_pending_approval(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "prod-pending")
        intent, result = _ask(ce, conv, ctx, "What products have pricing updates pending approval?")
        assert intent["intent"] in ("product_list", "product_dashboard", "pricing_dashboard", "dashboard_summary"), (
            f"expected product/pricing intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])


class TestPart3Quotations:
    """Quotation questions."""

    def test_quotation_dashboard(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "qt-dash")
        intent, result = _ask(ce, conv, ctx, "Give me a summary of the quotations dashboard.")
        assert intent["intent"] in ("quotation_dashboard", "quotation_list", "dashboard_summary"), (
            f"expected quotation/dashboard intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_quotations_awaiting_approval(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "qt-approve")
        intent, result = _ask(ce, conv, ctx, "How many quotations are awaiting customer approval?")
        assert intent["intent"] in ("quotation_list", "quotation_dashboard", "dashboard_summary"), (
            f"expected quotation intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_total_open_quotations(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "qt-value")
        intent, result = _ask(ce, conv, ctx, "What's the total value of open quotations this month?")
        assert intent["intent"] in ("quotation_list", "quotation_dashboard", "dashboard_summary"), (
            f"expected quotation intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])


class TestPart3Reconciliation:
    """Reconciliation questions."""

    @pytest.mark.parametrize("phrase", [
        "What transactions are still unreconciled this month?",
        "Show me the reconciliation status for my bank account.",
    ])
    def test_reconciliation_routing(self, db, org, ctx, part3_data, phrase):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, f"recon-{abs(hash(phrase))}")
        intent, result = _ask(ce, conv, ctx, phrase)
        assert intent["intent"] in ("help_reconciliation", "help_general", "dashboard_summary"), (
            f"{phrase!r}: expected reconciliation/help intent, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"]), f"{phrase!r}: got refusal"


class TestPart3Reports:
    """Report questions."""

    @pytest.mark.parametrize("phrase", [
        "Can you generate an accounts receivable report as of today?",
        "Show me the aging report for outstanding invoices.",
    ])
    def test_report_routing(self, db, org, ctx, part3_data, phrase):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, f"rpt-{abs(hash(phrase))}")
        intent, result = _ask(ce, conv, ctx, phrase)
        assert not _has_refusal(result["answer"]), f"{phrase!r}: got refusal"
        assert intent["intent"] not in ("out_of_scope", "cross_tenant"), (
            f"{phrase!r}: should not be out_of_scope, got {intent['intent']}"
        )


class TestPart3EdgeCases:
    """Edge-case phrasing targeting known routing sensitivity."""

    def test_how_to_add_customer(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "edge-addcust")
        for phrase in ["How to add customer", "How to add the customer"]:
            intent, result = _ask(ce, conv, ctx, phrase)
            assert intent["intent"] == "unsupported_customer_creation", (
                f"{phrase!r}: expected unsupported_customer_creation, got {intent['intent']}"
            )
            assert not _has_refusal(result["answer"])

    def test_collected_vs_total_revenue(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "edge-rev")
        _, r1 = _ask(ce, conv, ctx, "What's my current collected revenue?")
        _, r2 = _ask(ce, conv, ctx, "What's my current total revenue?")
        a1 = r1["answer"].lower()
        a2 = r2["answer"].lower()
        # They should return different content (not identical answers)
        assert a1 != a2, "collected revenue and total revenue should return different answers"

    def test_module_dashboard_summaries(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "edge-mod")
        for phrase, expected_intents in [
            ("Product dashboard summary", ["product_dashboard", "pricing_dashboard", "dashboard_summary"]),
            ("Pricing dashboard summary", ["pricing_dashboard", "product_dashboard", "dashboard_summary"]),
            ("Quotations dashboard summary", ["quotation_dashboard", "quotation_list", "dashboard_summary"]),
            ("Overview dashboard summary", ["dashboard_summary"]),
        ]:
            intent, result = _ask(ce, conv, ctx, phrase)
            assert intent["intent"] in expected_intents, (
                f"{phrase!r}: expected {expected_intents}, got {intent['intent']}"
            )
            assert not _has_refusal(result["answer"]), f"{phrase!r}: got refusal"

    def test_greeting(self, db, org, ctx, part3_data):
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "edge-hello")
        intent, result = _ask(ce, conv, ctx, "Good morning")
        assert intent["intent"] in ("greeting", "dashboard_summary"), (
            f"expected greeting/dashboard, got {intent['intent']}"
        )
        assert not _has_refusal(result["answer"])

    def test_no_wrong_scope_for_billing_questions(self, db, org, ctx, part3_data):
        """None of the Part 3 live-data questions should be classified as out_of_scope or cross_tenant."""
        ce = ConversationEngine(db, model_gateway=None)
        conv = _conv(db, org, "edge-scope")
        billing_questions = [
            "What is our total revenue for this quarter?",
            "How many invoices are currently overdue?",
            "What payments have come in this week?",
            "Give me a summary of the customers dashboard.",
            "Can you give me a summary of the pricing dashboard?",
            "Give me a summary of the quotations dashboard.",
            "What transactions are still unreconciled this month?",
            "Can you generate an accounts receivable report as of today?",
        ]
        for phrase in billing_questions:
            intent, _ = _ask(ce, conv, ctx, phrase)
            assert intent["intent"] not in ("out_of_scope", "cross_tenant"), (
                f"{phrase!r}: should not be out_of_scope/cross_tenant, got {intent['intent']}"
            )
