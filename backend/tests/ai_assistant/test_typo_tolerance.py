"""
test_typo_tolerance.py
---------------------
Regression suite for the typo/fuzzy-tolerance layer of the intent router.

Regression: "dashboard sumary", "paid ammount", "how to add the custmer"
previously misrouted because keyword/intent matching was close-to-exact —
every new typo (missing/doubled/swapped letter) produced a fresh instance of
the same bug. The fix is a single token-level canonicalization pass
(_apply_fuzzy_canonical) applied BEFORE all rule gates, so a token uniquely
within edit distance 1-2 of a canonical trigger word ("summary", "amount",
"invoice") is rewritten to it.  "sumary" is deliberately NOT a hardcoded
alias anywhere.

The contract asserted here: for every key trigger phrase already fixed this
session (how-to gate, dashboard qualifiers, paid-amount, open-invoices), at
least two single-character typo variants must route to EXACTLY the same
(domain, intent) as the correctly-spelled phrase.
"""
import pytest

from app.modules.chatbot.conversation.engine import (
    ConversationEngine,
    _apply_fuzzy_canonical,
    _edit_distance_leq,
)


@pytest.fixture()
def engine():
    # _rules_classify_intent never touches the DB; any session works.
    return ConversationEngine(None)


# (correct phrase, [typo variants], expected domain, expected intent).
# Variants cover the three typo classes named in the spec: missing letter,
# swapped letters, doubled letter.
TRIGGER_PHRASE_CASES = [
    (
        "dashboard summary",
        ["dashboard sumary", "dashboard summery", "dashboard summry"],
        "dashboard", "dashboard_summary",
    ),
    (
        "billing dashboard summary",
        ["billing dashbord summary", "billing dashboard summerry"],
        "dashboard", "dashboard_summary",
    ),
    (
        "sumary",
        ["sumary"],
        "dashboard", "dashboard_summary",
    ),
    (
        "how to add the customer",
        ["how to add the custmer", "how to add custmer"],
        "help", "help_general",
    ),
    (
        "how many open invoices",
        ["how many open invoice", "how many open invoce", "how many open invoces"],
        "billing", "invoice_count",
    ),
    (
        "paid amount",
        ["paid ammount", "paid amout", "paid ammount please"],
        "dashboard", "metric_paid_total",
    ),
    (
        "total revenue",
        ["total revenu", "total revnue", "tatal revenue"],
        "dashboard", "metric_revenue",
    ),
    (
        "customer dashboard",
        ["customur dashboard", "customar dashboard"],
        "clarify", "clarify_dashboard_scope",
    ),
    (
        "invoice list",
        ["invoce list", "invoic list", "the invoce list"],
        "billing", "invoice_list",
    ),
    (
        "reconciliation",
        ["reconcilliation", "reconsiliation"],
        "reconciliation", "help_reconciliation",
    ),
    (
        "customers",
        ["costumers", "custumers", "customers please"],
        "billing", "customer_list",
    ),
]


@pytest.mark.parametrize(
    "correct,typos,domain,intent",
    TRIGGER_PHRASE_CASES,
    ids=[c[0] for c in TRIGGER_PHRASE_CASES],
)
def test_typos_route_identically_to_correct(engine, correct, typos, domain, intent):
    baseline = engine._rules_classify_intent(correct)
    assert (baseline.get("domain"), baseline.get("intent")) == (domain, intent)

    for typo in typos:
        result = engine._rules_classify_intent(typo)
        assert (result.get("domain"), result.get("intent")) == (
            domain,
            intent,
        ), f"{typo!r} misrouted: got {result.get('domain')}/{result.get('intent')}"


# Real-world phrases that must never be altered: the canonicalizer may only
# fix tokens THAT ARE misses of a trigger word, never valid English words or
# unrelated proper nouns. "mount" must not become "amount", "account" must
# not become "amount", inflectional forms must survive.
UNTOUCHED_PHRASES = [
    "show me the mount everest summary",
    "what is my account balance",
    "total due on account 42",
    "customer accounts receivable aging report",
    "the cost of a new plan for our company",
    "how tall is mount everest",
    "what vehicles are covered",
    "our revenue management dashboard",
    "show the catalogue for our new product line",
    "any outstanding invoices from mount street trading",
    "please list our franchisee contracts",
    "we collected the payment from collectship logistics",
]


@pytest.mark.parametrize("phrase", UNTOUCHED_PHRASES, ids=UNTOUCHED_PHRASES)
def test_real_words_are_not_overcorrected(phrase):
    assert _apply_fuzzy_canonical(phrase) == phrase


def test_canonicalization_mapping():
    cases = {
        "dashboard sumary": "dashboard summary",
        "paid ammount": "paid amount",
        "customur dashboard": "customer dashboard",
        "open invoces": "open invoices",
        "reconcilliation report": "reconciliation report",
        "subscritions list": "subscriptions list",
        "invoice amout": "invoice amount",
        "overdure invoices": "overdue invoices",
        "recuring revenue": "recurring revenue",
        "organzation dashboards": "organization dashboards",
        "dashbaord summery": "dashboard summary",
        "billing summery please": "billing summary please",
    }
    for src, expected in cases.items():
        assert _apply_fuzzy_canonical(src) == expected, src
        assert expected.split(), "expected must be non-empty"


def test_edit_distance_bounds():
    assert _edit_distance_leq("sumary", "summary", 2) == 1
    assert _edit_distance_leq("summry", "summary", 1) == 1
    assert _edit_distance_leq("summary", "summary", 1) == 0
    assert _edit_distance_leq("mount", "amount", 1) == 1
    assert _edit_distance_leq("reconcilliation", "reconciliation", 2) == 1
    assert _edit_distance_leq("kitten", "sitting", 1) is None
    assert _edit_distance_leq("account", "amount", 1) is None