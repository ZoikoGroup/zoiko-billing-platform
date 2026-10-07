"""QA Gap Analysis — Phase 3 regression suite (P1 routing / field-level reads).

Locks in the P1 fixes:
- P1-A  payment-capability questions ("what payment options are supported …")
        answer from the approved Payments & Allocations KB doc as M0/R0, never
        an InspectR1 dump of cleared payment records.
- P1-B  "my card payment failed / can you retry" is troubleshooting (live-aware,
        M0), never a blank PrepareR2 payment-allocation draft.  A BARE imperative
        ("retry payment PAY-1001") must still be the normal action command.
- P1-ENT field-level attributes read the real schema field live:
        due date -> Invoice.due_date; billing cycle -> plan.billing_period;
        tax charged -> Invoice.tax_amount / per-line tax.
- P1-RAG add-on activation / card update / pay-online questions stay IN DOMAIN
        (help_general), never refused as out_of_scope.
- P2    "what-if" downgrade estimates produce a labeled ESTIMATE, never a
        fabricated PrepareR2 refund draft.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.models import (
    AIConversation,
    AIConversationMessage,
    AIActionDraft,
    ConversationStatus,
    SenderType,
)
from app.modules.billing.models import PaymentStatus
from tests.conftest import (
    make_organization,
    make_customer,
    make_invoice,
    make_invoice_item,
    make_payment,
    make_subscription,
    make_subscription_plan,
)


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    S = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = S()
    yield s
    s.close()
    engine.dispose()


@pytest.fixture()
def ctx(db):
    org = make_organization(db, code="QA3", name="QA Org")
    return (
        AIContext(organization_id=org.id, user_id=1, tenant_context_id=1,
                  role="org_admin", permissions=[], request_id="qa3"),
        org,
    )


@pytest.fixture()
def approved_kb(db):
    """The REAL approved public knowledge base (seed_knowledge.py)."""
    from seed_knowledge import KB_ENTRIES
    from app.modules.chatbot.models import (
        KnowledgeNamespace, KnowledgeSource, KnowledgeDocument, KnowledgeChunk,
        KnowledgeClassification, KnowledgeSourceDocType, FreshnessStatus,
    )
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="approved public KB",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id, source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing", title="Zoiko Billing Knowledge Base",
        status="active",
    )
    db.add(src)
    db.flush()
    for entry in KB_ENTRIES:
        doc = KnowledgeDocument(
            source_id=src.id, document_version=1,
            document_hash=f"test-{entry['title']}",
            freshness_status=FreshnessStatus.CURRENT, title=entry["title"],
            status="approved", is_public=entry.get("is_public", False),
        )
        db.add(doc)
        db.flush()
        for seq, chunk_text in enumerate(entry["chunks"], 1):
            db.add(KnowledgeChunk(
                document_id=doc.id, chunk_sequence=seq, chunk_text=chunk_text,
                classification=KnowledgeClassification.INTERNAL,
            ))
    db.flush()
    return ns


def new_conv(db, org, uid):
    conv = AIConversation(conversation_uid=uid, tenant_context_id=1,
                          organization_id=org.id, user_id=1, title="qa3",
                          conversation_status=ConversationStatus.OPEN)
    db.add(conv)
    db.flush()
    return conv


def route(db, text):
    engine = ConversationEngine(db, model_gateway=None)
    return engine._rules_classify_intent(text)


def ask(db, conv, text, context, engine=None):
    e = engine or ConversationEngine(db, model_gateway=None)
    m = AIConversationMessage(conversation_id=conv.id, message_uid="u-" + text[:12],
                              sender_type=SenderType.USER, message_text=text)
    db.add(m)
    db.flush()
    return e._process_message(conv, text, context)


def drafts_for(db, conv):
    return (
        db.query(AIActionDraft)
        .filter(AIActionDraft.conversation_id == conv.id)
        .count()
    )


# ── P1-A: payment-capability questions are KB answers, not record dumps ───────

class TestPaymentCapabilityRouting:

    @pytest.mark.parametrize("phrase", [
        "What payment options are supported (ACH, debit card, digital wallets)?",
        "What payment methods are supported?",
        "what payment methods do you accept",
        "how many ways can I pay",
    ])
    def test_capability_question_is_knowledge_not_payment_list(self, db, ctx, approved_kb, phrase):
        context, org = ctx
        r = route(db, phrase)
        assert r["intent"] != "payment_list", f"{phrase!r} must not dump payment records"
        assert r["domain"] == "help"
        conv = new_conv(db, org, "pa-" + phrase[:8])
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M0_EXPLAIN"
        assert res["evidence"], f"{phrase!r} produced no evidence"
        # Grounded in the approved document, not a live-record source.
        sources = {e.get("source") for e in res["evidence"]}
        assert "Payments and Allocations" in sources, sources

    def test_qa_string_exact_not_misrouted(self, db, ctx, approved_kb):
        context, org = ctx
        phrase = "What payment options are supported (ACH, debit card, digital wallets)?"
        conv = new_conv(db, org, "pa-exact")
        res = ask(db, conv, phrase, context)
        answer = res["answer"].lower()
        for method in ("bank transfer", "credit card", "cash", "check"):
            assert method in answer, f"documented method '{method}' missing"
        assert "no payments found" not in answer


# ── P1-B: failed-payment retry is troubleshooting, never a tabula-rasa draft ──

class TestPaymentTroubleshootRouting:

    def test_failed_card_payment_is_troubleshoot_not_draft(self, db, ctx):
        context, org = ctx
        cust = make_customer(db, org.id, code="PB1")
        make_payment(db, org.id, cust.id, amount="250.00",
                     status=PaymentStatus.FAILED, payment_number="PAY-FAIL-1")
        phrase = "My card payment failed yesterday. Can you retry the payment now?"
        r = route(db, phrase)
        assert r["intent"] == "payment_troubleshoot", r
        assert r["risk_class"] == "R0"
        conv = new_conv(db, org, "pb-fail")
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M0_EXPLAIN"
        assert res["risk_class"] == "R0"
        assert "PAY-FAIL-1" in res["answer"]
        assert drafts_for(db, conv) == 0, "a troubleshooting ask must not open a draft"

    def test_bare_retry_command_is_still_an_action(self, db, ctx):
        r = route(db, "retry payment PAY-1001")
        assert r["intent"] == "action_draft", r
        assert r["risk_class"] == "R2", r


# ── P1-ENT: field-level reads resolve to live schema fields ──────────────────

class TestFieldLevelEntityReads:

    def _seed_live_invoice(self, db, org_id, due_offset=7):
        from app.modules.billing.models import Invoice
        cust = make_customer(db, org_id, code="ENT1")
        inv = make_invoice(db, org_id, cust.id, status="sent",
                           total_amount="100.00", paid_amount="25.00",
                           invoice_number="INV-ENT-1")
        inv.due_date = date.today() + timedelta(days=due_offset)
        inv.tax_amount = "10.00"
        inv.subtotal = "90.00"
        make_invoice_item(db, org_id, inv.id, description="Consulting",
                          unit_price="90.00", total="90.00", tax_percentage="11.11")
        db.flush()
        return inv

    @pytest.mark.parametrize("phrase", [
        "What's my due date?",
        "When is my bill due?",
        "due date",
    ])
    def test_due_date_reads_invoice_field(self, db, ctx, phrase):
        context, org = ctx
        inv = self._seed_live_invoice(db, org.id)
        r = route(db, phrase)
        assert r["intent"] == "invoice_due_date", phrase
        conv = new_conv(db, org, "dd-" + phrase[:6])
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M1_INSPECT"
        assert res["risk_class"] == "R1"
        assert res["qualification"] and "due date" in res["qualification"].lower()
        assert str(inv.due_date) in res["answer"]

    def test_billing_cycle_reads_plan_period(self, db, ctx):
        from app.modules.billing.models import BillingPeriod
        context, org = ctx
        cust = make_customer(db, org.id, code="ENT2")
        plan = make_subscription_plan(db, org.id)
        plan.billing_period = BillingPeriod.MONTHLY
        make_subscription(db, org.id, cust.id, plan.id,
                          subscription_number="SUB-ENT-1", unit_price="10.00")
        db.flush()
        phrase = "What billing cycle am I on?"
        r = route(db, phrase)
        assert r["intent"] == "subscription_billing_cycle", r
        conv = new_conv(db, org, "bc-" + phrase[:6])
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M1_INSPECT"
        assert "monthly" in res["answer"].lower(), res["answer"]
        fields = res["evidence"][0]["fields"]
        assert any(f["billing_period"] == "monthly" for f in fields), fields

    def test_tax_breakdown_reads_invoice_field(self, db, ctx):
        context, org = ctx
        inv = self._seed_live_invoice(db, org.id)
        phrase = "How much tax was charged?"
        r = route(db, phrase)
        assert r["intent"] == "invoice_tax_breakdown", r
        conv = new_conv(db, org, "tx-" + phrase[:6])
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M1_INSPECT"
        assert "10.00" in res["answer"]
        fields = res["evidence"][0]["fields"]
        assert fields["tax_amount"] == str(inv.tax_amount), fields


# ── P1-RAG: add-on / card / pay-online stay in-domain (help), never refused ──

class TestInDomainHelpRouting:

    @pytest.mark.parametrize("phrase", [
        "How do I activate an add-on?",
        "How do I update my card?",
        "How do I pay my bill online right now?",
    ])
    def test_not_refused_as_out_of_scope(self, db, ctx, phrase):
        r = route(db, phrase)
        assert r["domain"] != "out_of_scope", f"{phrase!r} refused: {r}"
        assert r["domain"] == "help", r

    def test_add_on_question_never_creates_subscription(self, db, ctx):
        from app.modules.billing.models import Subscription
        context, org = ctx
        phrase = "How do I activate an add-on?"
        r = route(db, phrase)
        assert r["intent"] == "help_general", r
        conv = new_conv(db, org, "addon")
        res = ask(db, conv, phrase, context)
        # By design, add-ons are not documented: the assistant honestly
        # abstains (optionally with an escalation offer) rather than inventing
        # activation steps or routing to subscription creation.
        assert res["mode"] in ("M0_EXPLAIN", "M1_INSPECT", "M5_ESCALATE"), res["mode"]
        assert res["risk_class"] == "R0", res
        low = res["answer"].lower()
        assert "don't have specific information" in low or "subscription" not in low
        assert db.query(Subscription).filter(
            Subscription.organization_id == org.id).count() == 0


# ── P2: what-if estimates, never fabricated refund drafts ────────────────────

class TestChangeEstimation:

    def _seed_subscription(self, db, org_id):
        cust = make_customer(db, org_id, code="EST1")
        plan = make_subscription_plan(db, org_id)
        sub = make_subscription(db, org_id, cust.id, plan.id,
                                subscription_number="SUB-EST-1", unit_price="120.00")
        return sub

    @pytest.mark.parametrize("phrase", [
        "Can you calculate my prorated refund if I downgrade my active subscription today?",
        "How much would an upgrade to Pro cost?",
        "What would I get back if I downgrade?",
    ])
    def test_estimate_never_drafts_refund(self, db, ctx, phrase):
        context, org = ctx
        self._seed_subscription(db, org.id)
        r = route(db, phrase)
        assert r["intent"] == "estimate_change", phrase
        assert r["risk_class"] == "R1", r
        conv = new_conv(db, org, "est-" + phrase[:8])
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M1_INSPECT"
        assert res["risk_class"] == "R1"
        assert "estimate" in res["answer"].lower() or "approx" in res["answer"].lower()
        assert "refund $50 from payment" not in res["answer"].lower()
        assert drafts_for(db, conv) == 0, "estimate must never open a refund draft"

    def test_prorated_estimate_labels_non_authoritative(self, db, ctx):
        context, org = ctx
        self._seed_subscription(db, org.id)
        phrase = "Can you calculate my prorated refund if I downgrade my active subscription today?"
        conv = new_conv(db, org, "est-lab")
        res = ask(db, conv, phrase, context)
        low = res["answer"].lower()
        assert "estimate" in low or "approx" in low
        assert "prorat" in low
        QUALIFIES = ("estimate", "non-authoritative", "illustrative", "for planning", "final prorated")
        assert any(q in low for q in QUALIFIES), low


class TestDueDateDisplayFixes:

    def test_show_last_bill_includes_due_date(self, db, ctx):
        from app.modules.billing.models import Invoice
        context, org = ctx
        cust = make_customer(db, org.id, code="DUE1")
        inv = make_invoice(db, org.id, cust.id, status="sent",
                           total_amount="100.00", invoice_number="INV-DUE-1")
        inv.due_date = date.today() + timedelta(days=5)
        db.flush()
        phrase = "Show me my last bill amount and the due date."
        r = route(db, phrase)
        assert r["intent"] == "invoice_due_date", r
        conv = new_conv(db, org, "lbl")
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M1_INSPECT"
        assert str(inv.due_date) in res["answer"], res["answer"]

    def test_overdue_list_shows_each_due_date(self, db, ctx):
        context, org = ctx
        cust = make_customer(db, org.id, code="OV1")
        inv = make_invoice(db, org.id, cust.id, status="overdue",
                           total_amount="80.00", invoice_number="INV-OV-1")
        inv.due_date = date.today() - timedelta(days=9)
        db.flush()
        phrase = "Show overdue invoices"
        r = route(db, phrase)
        assert r["intent"] == "invoice_list", r
        conv = new_conv(db, org, "ovl")
        res = ask(db, conv, phrase, context)
        assert str(inv.due_date) in res["answer"], res["answer"]


class TestGracePeriodLiveConfig:

    def test_grace_period_reads_live_dunning(self, db, ctx):
        from app.modules.billing.models import DunningLevel, DunningActionType
        context, org = ctx
        db.add(DunningLevel(organization_id=org.id, level_number=1,
                            name="Gentle Reminder", min_days_overdue=7,
                            action_type=DunningActionType.EMAIL_REMINDER, is_active=True))
        db.add(DunningLevel(organization_id=org.id, level_number=2,
                            name="Firm Notice", min_days_overdue=14,
                            action_type=DunningActionType.EMAIL_REMINDER, is_active=True))
        db.flush()
        phrase = "Dunning warning email - how many days grace period do I have?"
        r = route(db, phrase)
        assert r["intent"] == "dunning_grace_period", r
        conv = new_conv(db, org, "grace")
        res = ask(db, conv, phrase, context)
        assert "7 days" in res["answer"], res["answer"]
        assert "14 days" in res["answer"], res["answer"]
        assert res["evidence"][0]["type"] == "dunning_levels"


# ── Adversarial paraphrase shapes (PHASE 6 audit) ────────────────────────────

class TestAdversarialRouteShapes:

    @pytest.mark.parametrize("phrase", [
        "when is payment due?",
        "when do I need to pay?",
    ])
    def test_due_date_paraphrases(self, db, ctx, phrase):
        r = route(db, phrase)
        assert r["intent"] == "invoice_due_date", (phrase, r)

    def test_last_invoice_due_date(self, db, ctx):
        context, org = ctx
        inv = make_invoice(db, org.id, make_customer(db, org.id, code="AD1").id,
                           status="overdue", total_amount="60.00",
                           invoice_number="INV-AD-1")
        inv.due_date = date.today() - timedelta(days=3)
        db.flush()
        phrase = "last invoice due date"
        r = route(db, phrase)
        assert r["intent"] == "invoice_due_date", r
        res = ask(db, new_conv(db, org, "add"), phrase, context)
        assert str(inv.due_date) in res["answer"], res["answer"]

    def test_tax_on_invoice_paraphrase(self, db, ctx):
        context, org = ctx
        inv = make_invoice(db, org.id, make_customer(db, org.id, code="AD2").id,
                           status="overdue", total_amount="100.00",
                           invoice_number="INV-AD-2")
        inv.tax_amount = "10.00"
        db.flush()
        phrase = "tax on my invoice"
        r = route(db, phrase)
        assert r["intent"] == "invoice_tax_breakdown", r
        res = ask(db, new_conv(db, org, "adx"), phrase, context)
        assert "10.00" in res["answer"], res["answer"]

    def test_billing_cycle_paraphrases(self, db, ctx):
        for phrase in ["when does my subscription renew", "monthly or annual"]:
            r = route(db, phrase)
            assert r["intent"] == "subscription_billing_cycle", (phrase, r)

    def test_grace_period_before_suspension(self, db, ctx):
        from app.modules.billing.models import DunningLevel, DunningActionType
        db.add(DunningLevel(organization_id=ctx[1].id, level_number=1,
                            name="Reminder", min_days_overdue=7,
                            action_type=DunningActionType.EMAIL_REMINDER, is_active=True))
        db.flush()
        phrase = "how many days before suspension"
        r = route(db, phrase)
        assert r["intent"] == "dunning_grace_period", r

    def test_retry_failed_payment_is_troubleshoot_not_draft(self, db, ctx):
        """'retry failed payment' reverses the noun/adjective order of the
        canonical P1-B shape and must still never open an R2 draft."""
        r = route(db, "retry failed payment")
        assert r["intent"] == "payment_troubleshoot", r
        assert r["risk_class"] == "R0", r
        context, org = ctx
        conv = new_conv(db, org, "rfn")
        res = ask(db, conv, "retry failed payment", context)
        assert res["mode"] == "M0_EXPLAIN"
        assert res["risk_class"] == "R0"
        assert drafts_for(db, conv) == 0, "troubleshooting must not open a draft"

    def test_bare_retry_identifier_stays_action(self, db, ctx):
        r = route(db, "retry payment PAY-1001")
        assert r["intent"] == "action_draft", r
        assert r["risk_class"] == "R2", r

    def test_retry_bare_identifier_is_lookup_not_action(self, db, ctx):
        r = route(db, "retry PAY-1001")
        assert r["intent"] != "action_draft", r


# ── P1-ENT: invoice line items are live InvoiceItem rows, not a KB explainer ──

class TestInvoiceLineItemsRead:

    def _seed_items_invoice(self, db, org_id):
        cust = make_customer(db, org_id, code="LI1")
        inv = make_invoice(db, org_id, cust.id, status="sent",
                           total_amount="100.00", invoice_number="INV-LI-1")
        inv.due_date = date.today() + timedelta(days=6)
        make_invoice_item(db, org_id, inv.id, description="Consulting",
                          unit_price="70.00", total="70.00")
        make_invoice_item(db, org_id, inv.id, line_number=2, description="Support",
                          unit_price="30.00", total="30.00")
        db.flush()
        return inv

    @pytest.mark.parametrize("phrase", [
        "Show me the items on my bill.",
        "What line items are on my last invoice?",
        "itemized charges on my invoice",
        "What's on my invoice?",
    ])
    def test_line_items_read_the_real_rows(self, db, ctx, phrase):
        context, org = ctx
        inv = self._seed_items_invoice(db, org.id)
        r = route(db, phrase)
        assert r["intent"] == "invoice_line_items", (phrase, r)
        assert r["domain"] == "billing", (phrase, r)
        assert r["risk_class"] == "R1", (phrase, r)
        conv = new_conv(db, org, "li-" + phrase[:8])
        res = ask(db, conv, phrase, context)
        assert res["mode"] == "M1_INSPECT", res
        assert "Consulting" in res["answer"], res["answer"]
        assert "Support" in res["answer"], res["answer"]
        assert inv.invoice_number in res["answer"], res["answer"]
        ev = res["evidence"][0]
        assert ev["source"] == "Zoiko Billing Invoices", ev
        fields = ev["fields"]
        assert fields["due_date"], fields
        assert [i["description"] for i in fields["line_items"]] == ["Consulting", "Support"]
        assert [i["line_number"] for i in fields["line_items"]] == [1, 2]

    @pytest.mark.parametrize("phrase", [
        "What can you do with a line item?",
        "How do I add a line item to my invoice?",
        "Show overdue invoices",
        "Show me my last bill amount and the due date.",
        "retry payment PAY-1001",
    ])
    def test_line_items_route_never_hijacks_other_shapes(self, db, ctx, phrase):
        r = route(db, phrase)
        assert r["intent"] != "invoice_line_items", (phrase, r)

    def test_line_items_without_any_invoice_says_so(self, db, ctx):
        context, org = ctx
        conv = new_conv(db, org, "li-none")
        res = ask(db, conv, "Show me the items on my bill.", context)
        assert res["mode"] == "M1_INSPECT", res
        assert "no line items" in res["answer"].lower(), res["answer"]
        assert not res["evidence"], res["evidence"]


# ── P1-RAG: add-on asks abstain even when the full approved KB is seeded ─────

class TestAddOnAbstentionWithKnowledgeBase:

    @pytest.mark.parametrize("phrase", [
        "How do I activate an add-on?",
        "How do I add an add-on to my subscription?",
    ])
    def test_full_kb_never_supplies_add_on_steps(self, db, ctx, approved_kb, phrase):
        context, org = ctx
        conv = new_conv(db, org, "addon-kb")
        res = ask(db, conv, phrase, context)
        # The seeded KB is exactly what used to be misquoted (the customer
        # model chunk, or the *create a subscription* SOP), so an abstention
        # has to win over retrieval.
        assert res["mode"] == "M5_ESCALATE", res
        assert res["risk_class"] == "R0", res
        assert not res["evidence"], res["evidence"]
        low = res["answer"].lower()
        assert "don't have specific information" in low, low
        assert "how to create a subscription" not in low, low
