"""test_metric_comparison_and_customer_creation.py — STEP 4 regression tests.

Two chatbot gaps fixed in engine.py:
  GAP 1 (metric_comparison)  — "revenue vs collections", "compare revenue and
      collections", "collected revenue vs total revenue" were swallowed by the
      single-metric gates and answered with ONE figure (Collections OR Revenue).
      They now route to the metric_comparison intent, which answers BOTH figures
      read from the SAME data sources as the single-metric handlers (get_kpis
      total_revenue / BillingAdapter collected_totals), so the comparison can
      never disagree with a one-number query.  Seeded fixtures mirror
      TestCollectedRevenueDisambiguation (INV-CRC-1/2 + PAY-CRC-1/2/3), so the
      expected figures are NOT hardcoded here — they are asserted equal to what
      the existing metric_revenue / metric_collections answers produce.
  GAP 2 (unsupported_customer_creation) — "add/create a customer ..." either
      silently fell to the weak help fallback ("add a customer for Acme at
      $500" → help_general 0.7, because 'add' is not an action verb) or fell
      into the action_draft INVOICE default ("create a customer named Acme" →
      'I can prepare an invoice draft').  Both now route to
      unsupported_customer_creation (R0): an honest capability-gap answer that
      acknowledges the supplied name/amount and offers the real alternatives.

Every assertion runs ConversationEngine(db, model_gateway=None) — the
deterministic rules engine, exactly the production fallback when no AI
provider key is configured.
"""
from datetime import date
from decimal import Decimal

import pytest

from app.modules.billing.models import (
    BillingCustomer, CurrencyCode, Invoice, InvoiceStatus,
    Payment, PaymentStatus, PaymentType,
)
from app.modules.billing.services.dashboard_service import BillingDashboardService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.models import AIConversation, ConversationStatus
from app.modules.organizations.models import Organization


@pytest.fixture()
def org(db_session):
    o = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db_session.add(o)
    db_session.flush()
    return o


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="metric-comparison-test",
    )


@pytest.fixture()
def make_conv(db_session, org):
    def _mk(uid="cmp-conv"):
        conv = AIConversation(
            conversation_uid=uid, tenant_context_id=1, organization_id=org.id,
            user_id=1, title="test", conversation_status=ConversationStatus.OPEN,
        )
        db_session.add(conv)
        db_session.flush()
        return conv
    return _mk


@pytest.fixture()
def seeded(db_session, org):
    """Same fixtures as TestCollectedRevenueDisambiguation: two SENT invoices
    (₹119,964.20 + ₹100,000.00 = ₹219,964.20 total revenue) and three CLEARED
    payments (₹20,000 + ₹15,000 + ₹12,600.91 = ₹47,600.91 collections), base
    currency INR."""
    cfg = BillingConfigurationService(db_session).get_configuration(org.id)
    cfg.base_currency = CurrencyCode.INR
    go = BillingCustomer(
        organization_id=org.id, customer_code="CUST-GO",
        company_name="GOk", display_name="Go Enterprises", currency="USD",
    )
    acme = BillingCustomer(
        organization_id=org.id, customer_code="CUST-ACME",
        company_name="Acme Corp", display_name="Acme", currency="INR",
    )
    db_session.add_all([go, acme])
    db_session.flush()
    for cid, number, total in (
        (go.id, "INV-CRC-1", 119964.20),
        (acme.id, "INV-CRC-2", 100000.00),
    ):
        db_session.add(Invoice(
            organization_id=org.id, customer_id=cid, invoice_number=number,
            status=InvoiceStatus.SENT, issue_date=date.today(),
            due_date=date.today(), total_amount=str(total), paid_amount="0.00",
            balance_due=str(total), currency="INR",
        ))
    for cid, pnum, amt in (
        (go.id, "PAY-CRC-1", 20000.00),
        (go.id, "PAY-CRC-2", 15000.00),
        (acme.id, "PAY-CRC-3", 12600.91),
    ):
        db_session.add(Payment(
            organization_id=org.id, customer_id=cid, payment_number=pnum,
            payment_type=PaymentType.INVOICE_PAYMENT, status=PaymentStatus.CLEARED,
            amount=amt, currency="INR", payment_date=date.today(),
        ))
    db_session.flush()
    return {"go": go, "acme": acme}


class _Harness:
    def __init__(self, db, org, ctx):
        self.db = db
        self.org = org
        self.ctx = ctx

    def ask(self, phrase, uid="h"):
        engine = ConversationEngine(self.db, model_gateway=None)
        conv = AIConversation(
            conversation_uid=uid, tenant_context_id=1, organization_id=self.org.id,
            user_id=1, title="test", conversation_status=ConversationStatus.OPEN,
        )
        self.db.add(conv)
        self.db.flush()
        intent = engine._classify_intent(conv, phrase, self.ctx)
        response = engine._get_handler(intent["domain"])(conv, phrase, intent, self.ctx)
        return intent, response

    def kpis(self):
        return BillingDashboardService(self.db).get_kpis(organization_id=self.org.id)

    def collections_base(self):
        """Clear-payments base figure identical to the metric_collections
        handler's computation (BillingAdapter collected_totals)."""
        ce = ConversationEngine(self.db, model_gateway=None)
        col = ce._billing.collected_totals(self.org.id)
        rates = ce._currency_rates(self.org.id)
        if not col.totals:
            return Decimal("0")
        if len(col.totals) == 1:
            one_ccy, one_amt = next(iter(col.totals.items()))
            return one_amt * Decimal(str(rates.get(one_ccy, 1.0)))
        return sum((amt * Decimal(str(rates.get(c, 1.0)))) for c, amt in col.totals.items())


# ── STEP 4.1 — comparison routing + dual figures ─────────────────────────────

class TestMetricComparison:
    @pytest.fixture()
    def harness(self, db_session, org, ctx, seeded):
        return _Harness(db_session, org, ctx)

    @pytest.mark.parametrize("phrase", [
        "collected revenue vs total revenue",
        "revenue vs collections",
        "compare revenue and collections",
        "collections vs revenue this month",
        "compare revenue and collections this month",
        "Revenue vs Collections",
        "collected revenue versus total revenue",
        "revenue compared to collections",
        "revenue and collections comparison",
        "collections and revenue comparison",
    ])
    def test_comparison_routes_to_dual_figure_intent(self, harness, phrase):
        intent, response = harness.ask(phrase)
        assert intent["intent"] == "metric_comparison", (
            f"{phrase!r} routed to {intent['intent']}, expected metric_comparison"
        )
        assert intent["domain"] == "dashboard"
        assert intent["risk_class"] == "R1"
        assert response["mode"] == "M1_INSPECT"
        assert "**Revenue:**" in response["answer"], response["answer"][:200]
        assert "**Collections:**" in response["answer"], response["answer"][:200]
        assert "You've collected" in response["answer"], response["answer"][:200]

    def test_comparison_figures_equal_single_metric_figures(self, harness):
        """The comparison must show the SAME two figures as asking each metric
        alone (metric_revenue / metric_collections) — same data source, no
        second copy of the numbers in this test."""
        kpis = harness.kpis()
        col_base = harness.collections_base()

        rev_intent, rev_resp = harness.ask("What's my total revenue?", uid="single-rev")
        col_intent, col_resp = harness.ask("What is my current collected revenue?", uid="single-col")
        cmp_intent, cmp_resp = harness.ask("revenue vs collections", uid="cmp")

        assert rev_intent["intent"] == "metric_revenue", rev_intent
        assert col_intent["intent"] == "metric_collections", col_intent
        assert "Total revenue is" in rev_resp["answer"]
        assert "Total collections is" in col_resp["answer"]

        rev_fig = f"{kpis['total_revenue']:.2f}" if isinstance(kpis['total_revenue'], float) else str(kpis['total_revenue'])
        cmp_resp_answer = cmp_resp["answer"]
        assert str(kpis["total_revenue"]) in cmp_resp_answer or f"{kpis['total_revenue']:.2f}" in cmp_resp_answer
        assert str(col_base) in cmp_resp_answer or f"{col_base:.2f}" in cmp_resp_answer

        # The percentages must be computed from the same two sources.
        if kpis["total_revenue"] > 0:
            expected_pct = (f"{round((col_base / Decimal(str(kpis['total_revenue']))) * Decimal('100'), 1):.1f}"
                            .rstrip("0").rstrip(".") + "%")
            assert expected_pct in cmp_resp_answer, cmp_resp_answer

    @pytest.mark.parametrize("phrase,first,second", [
        ("revenue vs collections", "Revenue", "Collections"),
        ("collections vs revenue", "Collections", "Revenue"),
        ("compare revenue and collections", "Revenue", "Collections"),
        ("compare collections and revenue", "Collections", "Revenue"),
        ("revenue and collections comparison", "Revenue", "Collections"),
        ("collections and revenue comparison", "Collections", "Revenue"),
    ])
    def test_comparison_order_follows_user_phrasing_every_shape(
            self, harness, phrase, first, second):
        """Ordering is driven by which metric NAME appears FIRST in the user's
        text, identically across every phrasing shape — connector ('vs'),
        leading compare verb, and trailing comparison noun.  It must never be
        hardcoded to always show Revenue first."""
        _, response = harness.ask(phrase, uid=f"o-{phrase}")
        assert response["answer"].index(f"{first}") < response["answer"].index(second)

    @pytest.mark.parametrize("phrase", [
        "total collections this month",
        "current revenue",
        "What's my total revenue?",
    ])
    def test_single_metric_queries_unaffected(self, harness, phrase):
        """Single-metric queries must keep their existing one-figure routes —
        the new comparison gate must not shadow them."""
        intent, response = harness.ask(phrase)
        assert intent["intent"] in ("metric_collections", "metric_revenue"), intent
        if intent["intent"] == "metric_collections":
            assert "Total collections is" in response["answer"]
            assert "**Revenue:**" not in response["answer"]
        else:
            assert "Total revenue is" in response["answer"]
            assert "**Collections:**" not in response["answer"]

    def test_metric_definition_phrase_not_captured_as_comparison(self, harness):
        """'what is the difference between X and Y' is a definitional/KB ask —
        it must not be hijacked by the comparison data gate."""
        intent, response = harness.ask("what is the difference between revenue and collections")
        assert intent["intent"] != "metric_comparison", intent


# ── STEP 4.2 — customer creation is NOT an invoice draft ─────────────────────

class TestUnsupportedCustomerCreation:
    @pytest.mark.parametrize("phrase", [
        "add a customer for Acme at $500",
        "add a customer",
        "create a customer named Acme",
        "create customer Acme Corp",
        "add a new customer",
        "new customer Acme",
        "add a client",
        "register a client",
    ])
    def test_customer_creation_is_unsupported_not_invoice(self, db_session, org, ctx, phrase):
        engine = ConversationEngine(db_session, model_gateway=None)
        conv = AIConversation(
            conversation_uid=f"cu-{abs(hash(phrase)) % 10**9}",
            tenant_context_id=1, organization_id=org.id, user_id=1,
            title="test", conversation_status=ConversationStatus.OPEN,
        )
        db_session.add(conv)
        db_session.flush()
        intent = engine._classify_intent(conv, phrase, ctx)
        response = engine._get_handler(intent["domain"])(conv, phrase, intent, ctx)

        assert intent["intent"] == "unsupported_customer_creation", (
            f"{phrase!r} routed to {intent['intent']}/{intent['domain']}, "
            f"expected unsupported_customer_creation"
        )
        assert intent["risk_class"] in ("R0", "R1"), intent
        assert "can't create new customer records" in response["answer"], response["answer"][:200]
        # NEVER an invoice / credit-note / refund draft.
        assert "invoice draft" not in response["answer"].lower()
        assert "prepare an invoice" not in response["answer"].lower()

    def test_customer_creation_acknowledges_supplied_details(self, db_session, org, ctx):
        engine = ConversationEngine(db_session, model_gateway=None)
        conv = AIConversation(
            conversation_uid="cu-ack", tenant_context_id=1, organization_id=org.id,
            user_id=1, title="test", conversation_status=ConversationStatus.OPEN,
        )
        db_session.add(conv)
        db_session.flush()
        phrase = "add a customer for Acme at $500"
        intent = engine._classify_intent(conv, phrase, ctx)
        response = engine._get_handler(intent["domain"])(conv, phrase, intent, ctx)
        assert intent["intent"] == "unsupported_customer_creation"
        assert "Acme" in response["answer"], response["answer"]
        assert "$500" in response["answer"], response["answer"]
        # Nothing was drafted or recorded.
        assert not response.get("evidence"), response


# ── STEP 4.3 — existing action_draft flows stay untouched ───────────────────

class TestActionDraftUnaffected:
    @pytest.mark.parametrize("phrase", [
        "create an invoice for Acme Corp for 1500",
        "draft an invoice for Acme Corp for 1500",
        "issue a refund to customer 7 for 200",
        "create a product",
        "create a subscription for Acme",
    ])
    def test_existing_action_draft_flows_unchanged(self, db_session, org, ctx, phrase):
        engine = ConversationEngine(db_session, model_gateway=None)
        result = engine._rules_classify_intent(phrase)
        assert result["intent"] == "action_draft", (
            f"{phrase!r} routed to {result['intent']}, expected action_draft"
        )
        assert result["risk_class"] == "R2"