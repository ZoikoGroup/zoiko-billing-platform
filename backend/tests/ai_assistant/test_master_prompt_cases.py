"""
test_master_prompt_cases.py
----------------------------
Regression tests for natural-language understanding (NLU) doctrine:
every canonical phrasing from the Zoiko Billing Assistant master system
prompt must route to the correct live-data intent, and conversational
follow-ups (pronouns, "count them", "how many are there") must resolve
via stored conversation context.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer,
    Invoice,
    Payment,
    Subscription,
    Contract,
    Product,
)
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import (
    AIConversation,
    AIConversationMessage,
    ConversationStatus,
    SenderType,
)


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
    c1 = BillingCustomer(
        organization_id=org.id, customer_code="CUST-GO",
        company_name="GOk", display_name="Go Enterprises",
        email="go@example.com", currency="USD",
    )
    c2 = BillingCustomer(
        organization_id=org.id, customer_code="CUST-ACME",
        company_name="Acme Corp", display_name="Acme",
        email="billing@acme.com", currency="USD",
    )
    db.add_all([c1, c2])
    db.flush()
    return {"go": c1, "acme": c2}


def _make_conv(db, org, uid):
    conv = AIConversation(
        conversation_uid=uid,
        tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="test", conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv


def _ask(engine, conv, phrase, ctx):
    intent = engine._classify_intent(conv, phrase, ctx)
    handler = engine._get_handler(intent["domain"])
    return intent, handler(conv, phrase, intent, ctx)


# ═══════════════════════════════════════════════════════════════════════════════
# Intent routing for master-prompt canonical phrasings
# ═══════════════════════════════════════════════════════════════════════════════

class TestMasterPromptRouting:
    """Every canonical phrasing must reach the right intent — never help/RAG."""

    RULES = [
        # (phrase, expected_intent, expected_domain)
        # ── Customer list variants ──
        ("give me customers", "customer_list", "billing"),
        ("customer list", "customer_list", "billing"),
        ("customers list", "customer_list", "billing"),
        ("fetch customers", "customer_list", "billing"),
        ("retrieve customers", "customer_list", "billing"),
        ("view customers", "customer_list", "billing"),
        ("who are our customers", "customer_list", "billing"),
        ("tell me our customers", "customer_list", "billing"),
        ("which customers do we have", "customer_list", "billing"),
        ("what customers do we have", "customer_list", "billing"),
        # ── Count variants ──
        ("how many customers are there", "customer_count", "dashboard"),
        ("how many customers do we have", "customer_count", "dashboard"),
        ("how many invoices are there", "invoice_count", "billing"),
        ("how many invoices", "invoice_count", "billing"),
        ("how many payments", "payment_count", "billing"),
        ("how many subscriptions", "subscription_count", "billing"),
        ("how many contracts", "contract_count", "billing"),
        ("how many products", "product_count", "billing"),
        ("count the invoices", "invoice_count", "billing"),
        ("count the customers", "customer_count", "dashboard"),
        # ── Customer outstanding ──
        ("which customers owe us money", "customer_outstanding", "billing"),
        ("which customers have dues", "customer_outstanding", "billing"),
        ("outstanding customers", "customer_outstanding", "billing"),
        ("customers with outstanding balances", "customer_outstanding", "billing"),
        ("who owes us money", "customer_outstanding", "billing"),
        # ── Customer search / details ──
        ("find customer GOk", "customer_search", "billing"),
        ("locate a customer", "customer_search", "billing"),
        ("search for customer GOk", "customer_search", "billing"),
        ("do we have a customer named GOk", "customer_search", "billing"),
        ("customer named GOk", "customer_search", "billing"),
        ("show customer GOk", "customer_search", "billing"),
        ("what do you know about GOk", "customer_search", "billing"),
        ("show me GOk details", "customer_details", "billing"),
        # ── Invoice ──
        ("show all invoices", "invoice_list", "billing"),
        ("list invoices", "invoice_list", "billing"),
        ("show me the invoices", "invoice_list", "billing"),
        ("what is INV-2024-0001", "invoice_search", "billing"),
        # ── Payment ──
        ("list payments", "payment_list", "billing"),
        ("show payments", "payment_list", "billing"),
        ("show payments made by GOk", "payment_list", "billing"),
        ("payments received from Acme Corp", "payment_list", "billing"),
        # ── Subscription / contract / product ──
        ("list subscriptions", "subscription_list", "billing"),
        ("show active subscriptions", "subscription_list", "billing"),
        ("list contracts", "contract_list", "billing"),
        ("what contracts do we have", "contract_list", "billing"),
        ("list products", "product_list", "billing"),
        ("show the catalog", "product_list", "billing"),
        ("which products do we have", "product_list", "billing"),
        # ── Balance / financial ──
        ("what is my outstanding balance", "account_balance", "billing"),
        ("what do we owe", "account_balance", "billing"),
        # ── Dashboard / help ──
        ("dashboard summary", "dashboard_summary", "dashboard"),
        ("what can you do", "help_general", "help"),
        ("how do refunds work", "help_general", "help"),
    ]

    @pytest.mark.parametrize("phrase,exp_intent,exp_domain", RULES)
    def test_rules_classifier_routes(self, db, org, ctx, phrase, exp_intent, exp_domain):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, f"conv-{abs(hash((phrase, id(db))))}")
        result = engine._rules_classify_intent(phrase)
        assert result["intent"] == exp_intent, (
            f"{phrase!r}: expected intent={exp_intent!r} got {result['intent']!r}"
        )
        assert result["domain"] == exp_domain, (
            f"{phrase!r}: expected domain={exp_domain!r} got {result['domain']!r}"
        )

    @pytest.mark.parametrize("phrase,exp_intent,exp_domain", RULES)
    def test_end_to_end_routing(self, db, org, ctx, phrase, exp_intent, exp_domain):
        """Through the full pipeline (no gateway): classify + dispatch."""
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, f"e2e-{abs(hash((phrase, id(db))))}")
        intent, result = _ask(engine, conv, phrase, ctx)
        assert intent["intent"] == exp_intent, (
            f"{phrase!r}: full-pipeline intent {intent['intent']!r} != {exp_intent!r}"
        )
        assert intent["domain"] == exp_domain
        assert result.get("answer"), f"{phrase!r}: empty answer"
        assert "credit note" not in result["answer"].lower(), (
            f"{phrase!r}: fell through to RAG/credit-note content"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Conversational follow-ups (context resolution)
# ═══════════════════════════════════════════════════════════════════════════════

class TestFollowUpResolution:
    """'how many are there?', 'count them', 'show his details' etc. must
    resolve from the stored prior user message."""

    def _seed(self, db, org, uid, prior_phrase):
        conv = _make_conv(db, org, uid)
        prior = AIConversationMessage(
            conversation_id=conv.id,
            message_uid=f"{uid}-prior",
            sender_type=SenderType.USER,
            message_text=prior_phrase,
        )
        db.add(prior)
        db.flush()
        return conv

    def test_how_many_are_there_resolves_invoice(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._seed(db, org, "ctx-inv", "how many invoices do we have?")
        intent = engine._classify_intent(conv, "how many are there?", ctx)
        assert intent["intent"] == "invoice_count", intent
        assert intent["domain"] == "billing"

    def test_count_them_resolves_customers(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._seed(db, org, "ctx-cust", "which customers do we have?")
        intent = engine._classify_intent(conv, "count them", ctx)
        assert intent["intent"] == "customer_count", intent
        assert intent["domain"] == "dashboard"

    def test_show_his_details_resolves_customer_name(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._seed(db, org, "ctx-cust2", "find customer GOk")
        intent = engine._classify_intent(conv, "show his details", ctx)
        assert intent["intent"] == "customer_details", intent
        assert intent["domain"] == "billing"

    def test_show_his_details_handler_returns_gok(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._seed(db, org, "ctx-cust3", "find customer GOk")
        resolved = engine._resolve_references("show his details", conv, ctx)
        assert "GOk" in resolved
        intent = engine._classify_intent(conv, "show his details", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, resolved, intent, ctx)
        assert "GOk" in result["answer"]

    def test_show_me_everything_lists_last_entity(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = self._seed(db, org, "ctx-every", "list payments")
        intent = engine._classify_intent(conv, "show me everything", ctx)
        assert intent["intent"] == "payment_list", intent

    def test_ambiguous_count_without_context(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "ctx-amb")
        intent = engine._classify_intent(conv, "count them", ctx)
        assert intent["intent"] == "ambiguous_count", intent
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "count them", intent, ctx)
        assert "Which would you like me to count" in result["answer"]


# ═══════════════════════════════════════════════════════════════════════════════
# Handler-level behaviors
# ═══════════════════════════════════════════════════════════════════════════════

class TestCountHandlers:

    def test_invoice_count_excludes_drafts(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-inv")
        from app.modules.billing.models import InvoiceStatus
        i1 = Invoice(organization_id=org.id, customer_id=customers["go"].id,
                     invoice_number="INV-1", status=InvoiceStatus.SENT,
                     issue_date=date_today(), due_date=date_today(),
                     total_amount=100, balance_due=100, currency="USD")
        i2 = Invoice(organization_id=org.id, customer_id=customers["go"].id,
                     invoice_number="INV-2", status=InvoiceStatus.DRAFT,
                     issue_date=date_today(), due_date=date_today(),
                     total_amount=50, balance_due=50, currency="USD")
        db.add_all([i1, i2])
        db.flush()
        result = engine._count_invoices("how many invoices are there", conv, ctx)
        assert "1" in result["answer"], result["answer"]

    def test_payment_count(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-pay")
        from app.modules.billing.models import PaymentStatus, PaymentType
        db.add(Payment(organization_id=org.id, customer_id=customers["go"].id,
                       payment_number="PAY-1", amount=100, currency="USD",
                       payment_type=PaymentType.MANUAL, payment_date=date_today(),
                       status=PaymentStatus.CLEARED))
        db.flush()
        result = engine._count_payments("how many payments", conv, ctx)
        assert "1" in result["answer"], result["answer"]

    def test_subscription_count(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-sub")
        from app.modules.billing.models import (
            BillingSubscriptionStatus, SubscriptionPlan,
            PlanCategory, BillingPeriod, PricingModel,
        )
        plan = SubscriptionPlan(organization_id=org.id, plan_code="PLAN-A",
                                plan_name="Basic", category=PlanCategory.SUBSCRIPTION,
                                billing_period=BillingPeriod.MONTHLY,
                                pricing_model=PricingModel.FLAT)
        db.add(plan)
        db.flush()
        db.add(Subscription(organization_id=org.id, customer_id=customers["go"].id,
                            plan_id=plan.id, subscription_number="SUB-1",
                            status=BillingSubscriptionStatus.ACTIVE,
                            unit_price=10, currency="USD", start_date=date_today(),
                            current_term_start=date_today(), current_term_end=date_today()))
        db.flush()
        result = engine._count_subscriptions("how many subscriptions", conv, ctx)
        assert "1" in result["answer"], result["answer"]

    def test_contract_count(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-con")
        from app.modules.billing.models import ContractStatus
        db.add(Contract(organization_id=org.id, customer_id=customers["go"].id,
                        contract_number="CT-1", contract_name="Test Agreement",
                        status=ContractStatus.ACTIVE, value=1000, currency="USD",
                        start_date=date_today()))
        db.flush()
        result = engine._count_contracts("how many contracts", conv, ctx)
        assert "1" in result["answer"], result["answer"]

    def test_product_count(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-prod")
        db.add(Product(organization_id=org.id, name="Consulting", code="CSLT",
                       default_price=500, currency="USD"))
        db.flush()
        result = engine._count_products("how many products", conv, ctx)
        assert "1" in result["answer"], result["answer"]


class TestLookupImprovements:

    def test_do_we_have_a_customer_named(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-named")
        intent = engine._classify_intent(conv, "do we have a customer named GOk", ctx)
        assert intent["intent"] == "customer_search", intent
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "do we have a customer named GOk", intent, ctx)
        assert "GOk" in result["answer"], result["answer"]

    def test_apostrophe_name_lookup(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-apo")
        intent = engine._classify_intent(conv, "show GOk's details", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "show GOk's details", intent, ctx)
        assert "GOk" in result["answer"], result["answer"]

    def test_find_a_customer_asks_for_name(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-noname")
        intent = engine._classify_intent(conv, "find a customer", ctx)
        assert intent["intent"] == "customer_search", intent
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "find a customer", intent, ctx)
        assert "Which customer name" in result["answer"], result["answer"]

    def test_payment_list_filters_by_customer(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-paycust")
        from app.modules.billing.models import PaymentStatus, PaymentType
        db.add(Payment(organization_id=org.id, customer_id=customers["go"].id,
                       payment_number="PAY-1", amount=100, currency="USD",
                       payment_type=PaymentType.MANUAL, payment_date=date_today(),
                       status=PaymentStatus.CLEARED))
        db.add(Payment(organization_id=org.id, customer_id=customers["acme"].id,
                       payment_number="PAY-2", amount=200, currency="USD",
                       payment_type=PaymentType.MANUAL, payment_date=date_today(),
                       status=PaymentStatus.CLEARED))
        db.flush()
        intent = engine._classify_intent(conv, "show payments made by GOk", ctx)
        assert intent["intent"] == "payment_list", intent
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "show payments made by GOk", intent, ctx)
        assert "PAY-1" in result["answer"], result["answer"]
        assert "PAY-2" not in result["answer"], "must filter to GOk only"

    def test_outstanding_customers_only(self, db, org, ctx, customers):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "h-outst")
        from app.modules.billing.models import InvoiceStatus
        db.add(Invoice(organization_id=org.id, customer_id=customers["go"].id,
                       invoice_number="INV-1", status=InvoiceStatus.SENT,
                       issue_date=date_today(), due_date=date_today(),
                       total_amount=100, balance_due=100, currency="USD"))
        db.flush()
        intent = engine._classify_intent(conv, "which customers owe us money", ctx)
        assert intent["intent"] == "customer_outstanding", intent
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "which customers owe us money", intent, ctx)
        assert "GOk" in result["answer"], result["answer"]
        assert "Acme Corp" not in result["answer"], "Acme has no outstanding"


def date_today():
    from datetime import date
    return date.today()