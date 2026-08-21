"""
eval_chatbot_90.py
------------------
§6.0 Topic-screening acceptance evaluation: 90 questions covering

  - the 5 required hard refusals (verbatim),
  - additional OUT_OF_DOMAIN probes,
  - in-domain knowledge questions (must be answered from the KB),
  - billing/dashboard/reconciliation/action routing,
  - meta/capability asks and filler utterances.

Each case runs the full pipeline: _classify_intent -> _get_handler ->
handler(), against an in-memory database with a seeded knowledge base.
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


KB_DOCS = {
    "Invoices Overview": [
        "An invoice is a commercial document issued by a seller to a buyer, indicating the products, quantities, and agreed prices for services provided.",
        "Invoice statuses in Zoiko Billing: Draft, Sent, Partially Paid, Paid, Overdue, Cancelled, Refunded, Written Off.",
        "To find a payment, search by payment number, transaction ID, or customer name.",
    ],
    "User Roles and Permissions": [
        "Zoiko Billing has three user roles: Super Admin, Organization Admin, and Billing Admin. Roles control what a user can see and do.",
        "Super Admin: platform-level operator. Manages platform settings, organizations, kill switches, and cross-tenant support access.",
        "Organization Admin: the administrator of an organization. Manages users and role assignments; only an Organization Admin can change another user's role.",
        "Who can access billing settings: both Organization Admin and Billing Admin roles can open and change billing settings.",
    ],
    "Subscriptions and Plans": [
        "A subscription represents a recurring billing arrangement where a customer is charged at regular intervals for access to a product or service.",
        "Subscription billing cycles define the recurrence period: monthly, quarterly, or annual. Plans can include trials, upgrades, downgrades, and renewals.",
    ],
    "Contracts and Quotations": [
        "A quotation (or quote) is a preliminary document outlining proposed pricing and terms. It can be accepted by the customer to create a contract or generate an invoice.",
        "Quotation statuses: Draft (being prepared), Sent (delivered to customer), Accepted (customer agreed), Rejected (customer declined), Expired (past validity date).",
        "A contract records the agreed commercial terms between your organization and a customer, including pricing, discounts, and payment terms.",
    ],
    "Billing Terminology": [
        "Billing terminology glossary: an invoice requests payment; a credit note reduces an invoice balance; proration adjusts charges for partial billing periods; dunning is the structured collection of overdue invoices.",
        "Payment terms define when an invoice is due, such as Net 30 (due 30 days after issue) or Net 60. Payment terms appear on every issued invoice.",
        "Multi-currency invoicing lets an organization bill customers in different currencies. Exchange rates convert foreign-currency amounts into the organization base currency.",
        "The aging report groups outstanding invoice balances by how long they are overdue: current, 1-30 days, 31-60 days, 61-90 days, and 90+ days buckets.",
        "The audit trail records every governed interaction and mutation in the platform: who did what, when, and from where. Every AI action is written to the audit trail.",
    ],
    "Refunds and Credit Notes": [
        "A refund returns money to the customer for an overpayment, duplicate payment, or cancelled order. Refunds reference the original payment.",
        "A credit note is a document that reduces the amount owed on an invoice without returning cash. Credit notes can be applied to open or paid invoices.",
    ],
    "Dunning and Collections": [
        "The dunning process chases overdue invoices with escalating reminders: reminder, warning, final notice, then escalation to collections.",
        "Late fees are charges applied to overdue invoices according to the organization's payment terms and applicable tax regulations.",
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
        conversation_uid="eval-conv", tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="eval", conversation_status=ConversationStatus.OPEN,
    )
    db.add(c)
    db.flush()
    return c


# ── The 90 evaluation cases ──────────────────────────────────────────────────
# Expectation keys (all optional):
#   refuse          -> must classify out_of_scope, refuse, cite nothing
#   intent          -> exact rules intent code
#   domain          -> exact classified domain
#   kb              -> some evidence source must contain this substring
#   answer_contains -> substrings required in the answer (case-insensitive)
#   mode            -> exact response mode

CASES = [
    # ── Hard refusals: the 5 required, verbatim ──────────────────────────────
    ("What is machine learning?", {"refuse": True}),
    ("Explain me about python", {"refuse": True}),
    ("Explain the stock market", {"refuse": True}),
    ("Explain cryptocurrency", {"refuse": True}),
    ("What is payroll?", {"refuse": True}),
    # ── Additional OUT_OF_DOMAIN probes ──────────────────────────────────────
    ("Tell me about quantum computing", {"refuse": True}),
    ("How do I cook pasta?", {"refuse": True}),
    ("What's the capital of France?", {"refuse": True}),
    ("Explain photosynthesis", {"refuse": True}),
    ("Who won the world cup?", {"refuse": True}),
    ("Give me a recipe for pasta carbonara", {"refuse": True}),
    ("Describe the plot of Hamlet", {"refuse": True}),
    # ── In-domain knowledge (KB-backed) ──────────────────────────────────────
    ("What is a quotation?", {"kb": "Contracts and Quotations"}),
    ("What is a quote?", {"kb": "Contracts and Quotations"}),
    ("Explain billing terminology", {"kb": "Billing Terminology"}),
    ("How do refunds work?", {"kb": "Refunds and Credit Notes"}),
    ("What is a credit note?", {"kb": "Refunds and Credit Notes"}),
    ("How do user roles and permissions work?", {"kb": "User Roles and Permissions"}),
    ("What does paid mean for invoice status?", {"answer_contains": ["paid"]}),
    ("What are the valid invoice statuses?", {"intent": "explain_statuses"}),
    ("Tell me about the dunning process", {"kb": "Dunning and Collections"}),
    ("What is an invoice?", {"kb": "Billing Terminology"}),
    ("Explain subscription billing cycles", {"kb": "Subscriptions and Plans"}),
    ("What is proration?", {"kb": "Billing Terminology"}),
    ("What are payment terms?", {"kb": "Billing Terminology"}),
    ("How do late fees work?", {"kb": "Dunning and Collections"}),
    # ── Billing data lookups ─────────────────────────────────────────────────
    ("Show overdue invoices", {"intent": "invoice_list"}),
    ("List all invoices", {"intent": "invoice_list"}),
    ("Show recent payments", {"intent": "general_billing_lookup"}),
    ("List payments", {"intent": "payment_list"}),
    ("How many invoices are there?", {"intent": "invoice_count"}),
    ("How many customers are there?", {"intent": "customer_count"}),
    ("How many payments?", {"intent": "payment_count"}),
    ("List subscriptions", {"intent": "subscription_list"}),
    ("What contracts do we have?", {"intent": "contract_list"}),
    ("Show the product catalog", {"intent": "product_list"}),
    ("Which customers owe us money?", {"intent": "customer_outstanding"}),
    ("Show customer GOk", {"intent": "customer_search"}),
    ("Find customer GOk", {"intent": "customer_search"}),
    ("What is INV-2024-0001?", {"intent": "invoice_search"}),
    ("Show me Gok's outstanding balance", {"intent": "customer_search"}),
    ("List all credit notes", {"intent": "general_billing_lookup"}),
    ("Show refunds", {"domain": "billing"}),
    ("List quotations", {"domain": "billing"}),
    ("Display contracts", {"intent": "contract_list"}),
    ("View products", {"intent": "product_list"}),
    ("Search invoice INV-2024-0002", {"intent": "general_billing_lookup"}),
    ("Show unpaid invoices", {"intent": "invoice_list"}),
    ("Show past due invoices", {"intent": "invoice_list"}),
    ("How much do we owe?", {"intent": "account_balance"}),
    ("Show overdue invoices now", {"intent": "invoice_list"}),
    ("List active contracts", {"intent": "contract_list"}),
    ("Show available products", {"intent": "product_list"}),
    ("Show payments made by Gok", {"intent": "payment_list"}),
    # ── Dashboard / metrics ──────────────────────────────────────────────────
    ("Total Revenue", {"intent": "metric_revenue"}),
    ("How much revenue do we have?", {"intent": "metric_revenue"}),
    ("Dashboard summary", {"intent": "dashboard_summary"}),
    ("Financial overview", {"intent": "dashboard_summary"}),
    ("Monthly revenue", {"intent": "metric_revenue"}),
    ("Earnings overview", {"intent": "clarify_dashboard_scope"}),
    ("Show financial summary", {"domain": "billing"}),
    ("How much is outstanding?", {"intent": "account_balance"}),
    # ── Actions ──────────────────────────────────────────────────────────────
    ("Create an invoice for Acme", {"intent": "action_draft"}),
    ("Draft a credit note", {"intent": "action_draft"}),
    ("Refund payment PAY-12", {"intent": "action_draft"}),
    ("Export unpaid invoices for Europe", {"intent": "export_request"}),
    ("Remind them this is overdue", {"intent": "communicate_request"}),
    ("Customer was overcharged", {"intent": "correct_request"}),
    ("Change the due date to net 30", {"intent": "action_draft"}),
    ("Preview action abc-123", {"intent": "action_preview"}),
    ("Confirm and execute action abc-123", {"intent": "action_confirm_execute"}),
    ("Send a follow-up about the invoice", {"intent": "communicate_request"}),
    # ── Reconciliation ───────────────────────────────────────────────────────
    ("Do I have any unmatched payments?", {"intent": "help_reconciliation"}),
    ("Show unallocated payments", {"intent": "help_reconciliation"}),
    ("Match this $5,000 payment", {"intent": "help_reconciliation"}),
    ("Explain payment reconciliation", {"intent": "help_reconciliation"}),
    # ── Meta / capability / filler ───────────────────────────────────────────
    ("What can you do?", {
        "intent": "help_general",
        "answer_contains": ["look up invoices"],
    }),
    ("Who are you?", {"answer_contains": ["zoiko billing ai assistant"]}),
    ("What is your name?", {"answer_contains": ["zoiko billing ai assistant"]}),
    ("Capabilities", {
        "intent": "help_general",
        "answer_contains": ["look up invoices"],
    }),
    ("Hmm interesting", {"intent": "help_general"}),
    ("Hello", {"mode": "M5_ESCALATE"}),
    ("asdasd qwezxc", {"mode": "M5_ESCALATE"}),
    ("Thanks", {"mode": "M5_ESCALATE"}),
    ("Goodbye", {"mode": "M5_ESCALATE"}),
    # ── Context / misc ───────────────────────────────────────────────────────
    ("Show me everything", {"intent": "ambiguous_general"}),
    ("What do we owe?", {"intent": "account_balance"}),
    ("Explain multi-currency invoicing", {"kb": "Billing Terminology"}),
    ("What is the aging report?", {"kb": "Billing Terminology"}),
    ("Where can I see the audit trail?", {"kb": "Billing Terminology"}),
]

assert len(CASES) == 90, f"Expected 90 evaluation cases, found {len(CASES)}"


def _run_case(engine, conv, q, exp, ctx):
    intent = engine._classify_intent(conv, q, ctx)
    if exp.get("refuse"):
        assert intent["intent"] == "out_of_scope", (
            f"{q!r}: expected out_of_scope, got {intent['intent']}")
    if exp.get("intent"):
        assert intent["intent"] == exp["intent"], (
            f"{q!r}: expected intent {exp['intent']}, got {intent['intent']}")
    if exp.get("domain"):
        assert intent["domain"] == exp["domain"], (
            f"{q!r}: expected domain {exp['domain']}, got {intent['domain']}")

    handler = engine._get_handler(intent["domain"])
    result = handler(conv, q, intent, ctx)
    answer = (result.get("answer") or "").lower()

    if exp.get("refuse"):
        assert "outside my scope" in answer, (
            f"{q!r}: refusal template missing, got: {answer[:120]!r}")
        assert result.get("evidence") == [], (
            f"{q!r}: refusal must cite no evidence, got {result.get('evidence')}")
    if exp.get("kb"):
        sources = [(e.get("source") or "").lower() for e in result.get("evidence", [])]
        assert any(exp["kb"].lower() in s for s in sources), (
            f"{q!r}: expected KB source ~{exp['kb']!r}, got {sources}")
    for needle in exp.get("answer_contains", []):
        assert needle.lower() in answer, (
            f"{q!r}: answer missing {needle!r}: {answer[:160]!r}")
    if exp.get("mode"):
        assert result.get("mode") == exp["mode"], (
            f"{q!r}: expected mode {exp['mode']}, got {result.get('mode')}")


class TestEvalChatbot90:
    @pytest.mark.parametrize("q,exp", CASES, ids=[c[0] for c in CASES])
    def test_case(self, db, ctx, conv, q, exp):
        engine = ConversationEngine(db, model_gateway=None)
        _run_case(engine, conv, q, exp, ctx)
