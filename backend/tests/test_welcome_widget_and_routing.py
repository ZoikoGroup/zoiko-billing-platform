"""
Regression tests for two related data-consistency fixes:

ISSUE 1 — Intent routing (chatbot):
    Live-data / specific-metric queries must route to INSPECT (a figure), while
    conceptual "what/how" asks stay in EXPLAIN. The bug: bare "paid amount" /
    "total paid amount" fell through to the default EXPLAIN intent instead of
    returning the live paid-total figure. Metric/summary/dashboard phrasing
    ("total revenue", "billing dashboard summary") must stay INSPECT.

ISSUE 2 — Welcome widget data source (Organization Admin dashboard):
    GET /api/organizations/me/dashboard-stats must read its Outstanding and
    Revenue figures from the SAME BillingDashboardService.get_kpis() the main
    Billing Dashboard page uses — not a separate, currency-naive inline query
    (which produced "$2,300 outstanding" / "$500 revenue" vs the main
    dashboard's "₹1.72L" / "₹2.2L").
"""
import pytest

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus
from app.modules.organizations.router import get_my_organization_dashboard_stats
from app.modules.billing.services.dashboard_service import BillingDashboardService
from tests.conftest import make_organization, make_customer, make_invoice


def _make_ctx(db):
    o = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db.add(o)
    db.flush()
    conv = AIConversation(
        conversation_uid="c1", tenant_context_id=1, organization_id=o.id,
        user_id=1, title="t", conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    ctx = AIContext(
        organization_id=o.id, user_id=1, tenant_context_id=1, role="admin",
        permissions=[], request_id="test", tenant_name="Zoiko Test",
    )
    return o, conv, ctx


def test_paid_amount_asks_route_to_inspect_not_explain(db_session):
    org, conv, ctx = _make_ctx(db_session)
    ce = ConversationEngine(db_session, model_gateway=None)

    for phrase in ["total paid amount", "paid amount", "total amount paid"]:
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] == "metric_paid_total", f"{phrase!r} -> {r['intent']}"
        assert r["domain"] == "dashboard"
        assert r["risk_class"] == "R1"


def test_dashboard_summary_phrases_stay_inspect(db_session):
    org, conv, ctx = _make_ctx(db_session)
    ce = ConversationEngine(db_session, model_gateway=None)

    for phrase in ["billing dashboard summary", "billing dashboard", "dashboard summary"]:
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] in ("dashboard_summary", "metric_paid_total", "metric_revenue")


def test_definitional_paid_amount_asks_stay_explain(db_session):
    org, conv, ctx = _make_ctx(db_session)
    ce = ConversationEngine(db_session, model_gateway=None)

    for phrase in ["what is paid amount", "how is paid amount calculated"]:
        r = ce._classify_intent(conv, phrase, ctx)
        # Must NOT be the live-figure intent — these are conceptual explanations.
        assert r["intent"] != "metric_paid_total"


class _StubUser:
    def __init__(self, organization_id, role="billing_admin"):
        self.organization_id = organization_id
        self.role = role


def test_welcome_widget_matches_billing_dashboard(db_session):
    org = make_organization(db_session, code="WEL1", name="Welcome Org")
    # Seed an invoice STORED in USD to prove the widget is derived through the
    # same get_kpis() path as the main dashboard (no separate naive sum that
    # would value it in its stored currency).
    customer = make_customer(db_session, org.id, code="WCUST", currency="USD")
    make_invoice(
        db_session, org.id, customer.id,
        status="sent", total_amount="1000.00", paid_amount="0.00",
        currency="USD", invoice_number="WINV1",
    )
    db_session.commit()

    stats = get_my_organization_dashboard_stats(
        current_user=_StubUser(org.id), db=db_session,
    )
    kpis = BillingDashboardService(db_session).get_kpis(organization_id=org.id)

    # The welcome widget must read from the single source of truth.
    assert stats.outstanding_amount == pytest.approx(float(kpis["outstanding_amount"]))
    assert stats.revenue_this_month == pytest.approx(float(kpis["total_revenue"]))


def test_dashboard_stats_counts_correct_after_query_batching(db_session):
    """QA bug #42 (performance): get_my_organization_dashboard_stats used to
    issue 6 separate COUNT round trips (total/active customers, open/overdue
    invoices as two more separate queries, active subscriptions, billing
    admins) against a remote database, each paying full network latency.
    Customer and invoice counts were each collapsed into a single
    conditional-aggregation query (one round trip covering both counts on
    that table). This locks in that the collapsed queries still return
    exactly the same values as before, against deterministic fixtures with a
    mix of statuses on both tables -- not just an all-active/all-sent
    happy path that could hide an off-by-one in the CASE conditions."""
    from app.modules.billing.models import CustomerStatus

    org = make_organization(db_session, code="PERF1", name="Perf Org")

    active_customer = make_customer(db_session, org.id, code="PC-ACTIVE", email="a@example.com")
    suspended_customer = make_customer(db_session, org.id, code="PC-SUSPENDED", email="b@example.com")
    suspended_customer.status = CustomerStatus.SUSPENDED
    db_session.flush()

    # 2 open (sent + partially_paid), 1 overdue, 1 draft (neither open nor
    # overdue -- must not be double-counted into either bucket), 1 paid.
    make_invoice(db_session, org.id, active_customer.id, status=InvoiceStatus.SENT, invoice_number="PI-1")
    make_invoice(db_session, org.id, active_customer.id, status=InvoiceStatus.PARTIALLY_PAID, invoice_number="PI-2")
    make_invoice(db_session, org.id, active_customer.id, status=InvoiceStatus.OVERDUE, invoice_number="PI-3")
    make_invoice(db_session, org.id, active_customer.id, status=InvoiceStatus.DRAFT, invoice_number="PI-4")
    make_invoice(db_session, org.id, active_customer.id, status=InvoiceStatus.PAID, invoice_number="PI-5")
    db_session.commit()

    stats = get_my_organization_dashboard_stats(
        current_user=_StubUser(org.id), db=db_session,
    )

    assert stats.total_customers == 2
    assert stats.active_customers == 1
    assert stats.open_invoices == 2
    assert stats.overdue_invoices == 1


def test_dashboard_stats_tenant_isolation_and_empty_org(db_session):
    """The batched count queries must stay scoped to the requesting org, and
    an org with no customers/invoices at all must return zeros, not an
    error (e.g. from a query.one() on an aggregate over zero rows)."""
    org_a = make_organization(db_session, code="PERF-A", name="Org A")
    org_b = make_organization(db_session, code="PERF-B", name="Org B")

    customer_a = make_customer(db_session, org_a.id, code="PA-CUST", email="pa@example.com")
    make_invoice(db_session, org_a.id, customer_a.id, status=InvoiceStatus.SENT, invoice_number="PA-INV1")
    db_session.commit()

    stats_b = get_my_organization_dashboard_stats(
        current_user=_StubUser(org_b.id), db=db_session,
    )
    assert stats_b.total_customers == 0
    assert stats_b.active_customers == 0
    assert stats_b.open_invoices == 0
    assert stats_b.overdue_invoices == 0

    stats_a = get_my_organization_dashboard_stats(
        current_user=_StubUser(org_a.id), db=db_session,
    )
    assert stats_a.total_customers == 1
    assert stats_a.open_invoices == 1


# ── HARD how-to gate (NEW ISSUE fix) ───────────────────────────────────────
# A leading "how to" / "how do I" / "steps to" / "guide to" pattern must route
# to EXPLAIN (help_general) BEFORE PREPARE, INSPECT, or any customer-name
# extraction — regardless of articles ("the"/"a") or the verb that follows.
class TestHowToHardGate:
    @pytest.mark.parametrize("phrase,expected_intent", [
        ("how to create an invoice", "help_general"),         # guided verb, still EXPLAIN
        ("guide to refund a payment", "help_general"),
    ])
    def test_how_to_leads_route_to_explain(self, db_session, phrase, expected_intent):
        org, conv, ctx = _make_ctx(db_session)
        ce = ConversationEngine(db_session, model_gateway=None)
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] == expected_intent, f"{phrase!r} -> {r['intent']}"
        assert r["domain"] == "help"
        assert r["risk_class"] == "R0"

    @pytest.mark.parametrize("phrase", [
        "how to add the customer",          # the original bug
        "how to add customer",
        "how do I add a customer",
        "how can i add the customer",
        "steps to add a customer",
        "how to add a customer",
    ])
    def test_how_to_add_customer_leads_to_capability_gap(self, db_session, phrase):
        """How-to phrasing about ADDING a customer asks how to create a
        customer record — there is no governed in-chat action, so it answers
        the honest capability gap instead of the customer glossary definition."""
        org, conv, ctx = _make_ctx(db_session)
        ce = ConversationEngine(db_session, model_gateway=None)
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] == "unsupported_customer_creation", f"{phrase!r} -> {r['intent']}"
        assert r["domain"] == "help"
        assert r["risk_class"] == "R0"

    @pytest.mark.parametrize("phrase", [
        "total paid amount",
        "total amount paid",
        "paid amount total",
        "how much paid amount",
    ])
    def test_paid_amount_variations_stay_inspect(self, db_session, phrase):
        org, conv, ctx = _make_ctx(db_session)
        ce = ConversationEngine(db_session, model_gateway=None)
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] == "metric_paid_total", f"{phrase!r} -> {r['intent']}"

    @pytest.mark.parametrize("phrase", [
        "billing history",
        "show billing history",
        "my billing history",
        "billing transaction history",
    ])
    def test_billing_history_variations_stay_list(self, db_session, phrase):
        org, conv, ctx = _make_ctx(db_session)
        ce = ConversationEngine(db_session, model_gateway=None)
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] == "invoice_list", f"{phrase!r} -> {r['intent']}"


# ── Regression: the 6 phrases from the report must all route correctly ──────
class TestReportedRegressionPhrases:
    @pytest.mark.parametrize("phrase,expected_intent,expected_handler", [
        ("how to add the customer", "unsupported_customer_creation", "EXPLAIN"),
        ("how to add customer", "unsupported_customer_creation", "EXPLAIN"),
        ("how do I add a customer", "unsupported_customer_creation", "EXPLAIN"),
        ("create an invoice for TOM for a Consulting Service, Rs500", "action_draft", "PREPARE"),
        ("show me TOM", "customer_search", "LOOKUP"),
        ("TOM's balance", "account_balance", "LOOKUP"),
        ("billing dashboard summary", "dashboard_summary", "INSPECT"),
        ("total paid amount", "metric_paid_total", "INSPECT"),
    ])
    def test_reported_phrases(self, db_session, phrase, expected_intent, expected_handler):
        org, conv, ctx = _make_ctx(db_session)
        ce = ConversationEngine(db_session, model_gateway=None)
        r = ce._classify_intent(conv, phrase, ctx)
        assert r["intent"] == expected_intent, (
            f"{phrase!r} expected {expected_intent} ({expected_handler}), got {r['intent']}"
        )

