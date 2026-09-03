"""test_engine_howto_routing.py — how-to routing gates in engine.py.

Regression scope (issue round):
  STEP-2  _HOWTO_VERB_NOUN_RE only recognized the modal+pronoun pair
          ``how (do|can|to) [i]``.  Expanded to modal ∈ {do, does, can,
          could, should, would} × pronoun ∈ {i, we, you, one}, plus the
          bare "how to" form with no pronoun required.  Noun list
          (customer, invoice, product, quotation, price) and the
          article-optional structure are unchanged.
  STEP-3  _ACCOUNT_SPECIFIC_RE conflict — option (b): the regex is left
          untouched; each how-to gate is pinned with an independence test
          so removing either gate cannot silently change routing for
          "how to add the customer".

Every assertion runs ConversationEngine(db, model_gateway=None) — the
deterministic rules engine — exactly as production falls back to when no
AI provider key is configured.
"""
import pytest

from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.conversation import engine as engine_mod
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.organizations.models import Organization

VERBS = ["add", "create", "edit", "update", "delete", "find", "remove"]
NOUNS = ["customer", "invoice", "product", "quotation", "price"]
LEADS = [
    "how do we",
    "how can we",
    "how should i",
    "how should we",
    "how could you",
    "how would one",
]
ARTICLES = ["", "a ", "an ", "the "]


@pytest.fixture()
def ctx(db_session):
    org = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db_session.add(org)
    db_session.flush()
    return AIContext(
        organization_id=org.id,
        user_id=1,
        tenant_context_id=1,
        role="admin",
        permissions=[],
        request_id="howto-routing-test",
    )


def classify(db_session, text):
    return ConversationEngine(db_session, model_gateway=None)._rules_classify_intent(text)


def classify_response(db_session, text):
    """Classify and run the handler, returning the assistant answer."""
    from app.modules.chatbot.models import AIConversation, ConversationStatus
    org = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db_session.add(org)
    db_session.flush()
    conv = AIConversation(
        conversation_uid=f"h-{abs(hash(text)) % 10**9}",
        tenant_context_id=1, organization_id=org.id, user_id=1,
        title="test", conversation_status=ConversationStatus.OPEN,
    )
    db_session.add(conv)
    db_session.flush()
    engine = ConversationEngine(db_session, model_gateway=None)
    intent = engine._rules_classify_intent(text)
    ctx = AIContext(
        organization_id=org.id, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="howto-routing-test",
    )
    return engine._get_handler(intent["domain"])(conv, text, intent, ctx)["answer"]


# ── STEP-2: modal/pronoun matrix ─────────────────────────────────────────────

@pytest.mark.parametrize("noun", NOUNS)
@pytest.mark.parametrize("verb", VERBS)
@pytest.mark.parametrize("lead", LEADS)
@pytest.mark.parametrize("article", ARTICLES)
def test_modal_pronoun_matrix_routes_to_explain(db_session, noun, verb, lead, article):
    """Every Step-2 phrasing variant × verb × noun × article-option resolves
    to EXPLAIN at ≥0.9 confidence (the rules fast-path skips the LLM).

    Exception: ``add/create a customer`` is a customer-CREATION ask and
    resolves to the honest capability-gap intent (unsupported_customer_creation)
    instead of the customer glossary definition — there is no governed
    in-chat action to create a customer, so the definition would not answer
    the user's "how" question."""
    phrase = f"{lead} {verb} {article}{noun}"
    res = classify(db_session, phrase)
    if noun == "customer" and verb in ("add", "create"):
        assert res["domain"] == "help", f"{phrase!r} -> {res['intent']}/{res['domain']}"
        assert res["intent"] == "unsupported_customer_creation", f"{phrase!r} -> {res['intent']}/{res['domain']}"
        assert res["confidence"] >= 0.9, f"{phrase!r} conf={res['confidence']}"
        assert res["risk_class"] == "R0"
    else:
        assert res["domain"] == "help", f"{phrase!r} -> {res['intent']}/{res['domain']}"
        assert res["intent"] == "help_general", f"{phrase!r} -> {res['intent']}/{res['domain']}"
        assert res["confidence"] >= 0.9, f"{phrase!r} conf={res['confidence']}"
        assert res["risk_class"] == "R0"


@pytest.mark.parametrize("noun", NOUNS)
def test_plural_noun_forms_still_explain(db_session, noun):
    # The phrase always uses the verb "add", so the outcome depends on the noun:
    # plural "customers" is a customer-creation ask -> capability gap; other
    # plural nouns stay on help_general.
    phrase = f"how would one add the {noun}s"
    res = classify(db_session, phrase)
    if noun == "customer":
        assert res["intent"] == "unsupported_customer_creation"
    else:
        assert res["intent"] == "help_general"
    assert res["domain"] == "help"
    assert res["confidence"] >= 0.9

# ── STEP-4 #2: previously-fixed cases still pass ─────────────────────────────

@pytest.mark.parametrize("phrase", [
    "how to add the customer",
    "how to add customer",
    "how do I add a customer",
    "how can I add the customer",
])
def test_article_variant_howto_add_customer_is_capability_gap(db_session, phrase):
    """Article-invariant 'how to add/create the customer' now answers the
    honest capability gap (use Customers > Add Customer) instead of the
    customer glossary definition — the gloss text does not tell the user HOW
    to create a customer."""
    res = classify(db_session, phrase)
    assert res["domain"] == "help"
    assert res["intent"] == "unsupported_customer_creation"
    assert res["confidence"] >= 0.9
    answer = classify_response(db_session, phrase)
    assert "can't create new customer records" in answer


def test_collected_revenue_is_metric_collections_not_metric_revenue(db_session):
    res = classify(db_session, "what is my current collected revenue")
    assert res["domain"] == "dashboard"
    assert res["intent"] == "metric_collections"


def test_pricing_dashboard_is_inspect_not_help(db_session):
    res = classify(db_session, "pricing dashboard summary")
    assert res["domain"] == "billing"
    assert res["intent"] == "pricing_dashboard"
    assert res["risk_class"] == "R1"  # M1_INSPECT surface, live data


DASHBOARD_QUALIFIERS = {
    "product": "product_dashboard",
    "quotation": "quotation_dashboard",
    "contract": "contract_dashboard",
    "subscription": "subscription_dashboard",
    "invoice": "invoice_dashboard",
    "payment": "payment_dashboard",
    "tax": "tax_dashboard",
}


@pytest.mark.parametrize("noun,expected", sorted(DASHBOARD_QUALIFIERS.items()))
def test_dashboard_qualifiers_still_route(db_session, noun, expected):
    res = classify(db_session, f"{noun} dashboard summary")
    assert res["domain"] == "billing"
    assert res["intent"] == expected
    assert res["risk_class"] == "R1"


# ── STEP-4 #3: unaffected cases keep their existing routing ──────────────────

def test_direct_customer_creation_is_unsupported(db_session):
    """'add a customer for Acme at $500' is a customer-CREATION request, not a
    how-to question. The dedicated unsupported_customer_creation handling now
    REPLACES the old weak help_general 0.7 fallback (which ignored the intent):
    it answers honestly that customer creation isn't available through chat,
    still acknowledges the supplied details, and stays at R0 (no draft)."""
    res = classify(db_session, "add a customer for Acme at $500")
    assert res["intent"] == "unsupported_customer_creation"
    assert res["domain"] == "help"
    assert res["risk_class"] == "R0"
    assert res["confidence"] >= 0.9
    answer = classify_response(db_session, "add a customer for Acme at $500")
    assert "can't create new customer records" in answer
    assert "Acme" in answer
    assert "$500" in answer


def test_create_customer_named_is_unsupported(db_session):
    """'create a customer named Acme' previously fell to the action_draft
    invoice default (answered about an invoice). It must now be the honest
    capability-gap response, never an invoice draft."""
    res = classify(db_session, "create a customer named Acme")
    assert res["intent"] == "unsupported_customer_creation"
    assert res["domain"] == "help"
    assert res["risk_class"] == "R0"
    answer = classify_response(db_session, "create a customer named Acme")
    assert "can't create new customer records" in answer


def test_show_me_the_customer_unchanged(db_session):
    res = classify(db_session, "show me the customer")
    assert res["domain"] == "billing"
    assert res["intent"] == "general_billing_lookup"


def test_customer_balance_remains_account_specific(db_session):
    res = classify(db_session, "the customer's balance")
    assert res["domain"] == "billing"
    assert res["intent"] == "account_balance"


# ── STEP-3(b): gate independence contract ────────────────────────────────────

def test_how_to_gate_independence(db_session):
    """BOTH gates must independently handle 'how to add the customer':
    the deictic clause of _ACCOUNT_SPECIFIC_RE fires on bare 'the customer'
    (it is a standalone alternative), so the primary _HOWTO_LEAD_RE gate is
    BLOCKED for this phrase and the anchored _HOWTO_VERB_NOUN_RE gate is the
    layer that routes customer-CREATION how-tos to the honest capability-gap
    intent. Routing must stay unsupported_customer_creation ≥0.95 even if
    either regex is tightened later."""
    n = engine_mod.normalize_classification_input("how to add the customer")
    assert engine_mod._HOWTO_LEAD_RE.search(n) is not None
    assert engine_mod._ACCOUNT_SPECIFIC_RE.search(n) is not None  # deictic fires
    assert engine_mod._HOWTO_VERB_NOUN_RE.match(n) is not None
    res = classify(db_session, "how to add the customer")
    assert res["intent"] == "unsupported_customer_creation"
    assert res["domain"] == "help"
    assert res["confidence"] >= 0.95