"""chatbot/conversation/intent_matrix.py
--------------------------------------
Semantic intent resolution for the QA Gap Analysis defects (P1).

The rules router is token/keyword weighted, so informational and
entity-attribute questions fall into a handful of wrong buckets:

- "What payment options are supported (ACH, debit card, digital wallets)?"
  -> previously dumped InspectR1 cleared-payment records (keyword 'payment').
- "My card payment failed yesterday. Can you retry the payment now?"
  -> previously opened a blank PrepareR2 Payment-Allocation draft ('retry' +
    'payment' are both action words, no entity is ever resolved).
- "What's my due date?" / "What billing cycle am I on?" / "How much tax was
  charged?" -> previously dropped to a 0.7 help* fallback or an unrelated
  dashboard because no field-level (attribute) layer exists.

This module owns the FIELD-LEVEL + INFORMATIONAL-LEVEL layer.  It is a pure
function over the already-normalized query text; the engine calls it at the
top of ``_rules_classify_intent``, before the token-weighted gates, so these
precise shapes win over the noisy catch-alls.  Every route it returns is an
exact shape or an explicit semantic keyword map — never a bare keyword.
"""

from __future__ import annotations

import re

from ..models import IntentClassifiedBy

RISK_R0 = "R0"
RISK_R1 = "R1"


def _route(intent: str, domain: str, risk: str, confidence: float) -> dict:
    return {
        "intent": intent,
        "domain": domain,
        "risk_class": risk,
        "confidence": confidence,
        "classified_by": IntentClassifiedBy.RULES,
    }


# ── 1. Informational payment questions (P1-A) ───────────────────────────────
# "What payment options are supported?" — a capabilities/policy question, never
# a request to LIST payment records.  Must also match "how do I pay", "what
# payment methods exist".  Always requires a payment/billing anchor.
_PAYMENT_OPTIONS_RE = re.compile(
    r"(?:"
    r"\b(?:payment|billing)\b[\s\S]{0,35}\b(?:options|methods?|ways?|channels?)\b"
    r"|\b(?:options|methods?|ways?|channels?)\b[\s\S]{0,30}\b(?:of\s+)?(?:payment|paying|pay)\b"
    r"|\b(?:accept|supported|accepted|available)\b[\s\S]{0,30}\b(?:payment|ach|debit|card|wallet|bank)"
    r"|\b(?:payment\s+gateway|gateways?)\b"
    r"|\bdo\s+you\s+(?:accept|support|take|offer)\b"
    r"|\bcan\s+i\s+pay\s+(?:with|via|through)\b"
    r"|\bwhat\s+(?:is|are)\s+(?:the\s+)?(?:payment|billing)\s+(?:options|methods)\b"
    r")",
    re.IGNORECASE,
)

# ── 2. Payment failure / retry troubleshooting (P1-B) ───────────────────────
# "My card payment failed yesterday. Can you retry the payment now?" is a
# TROUBLESHOOTING ask, not a draft-create command.  The router must never
# open a blank R2 payment-allocation draft for it.  A BARE imperative
# ("retry payment PAY-1001") with no failure context stays an action command.
_PAYMENT_RETRY_RE = re.compile(
    r"(?:"
    r"\b(?:my|the|this|that)\s+(?:card|payment|charge|transaction|debit)\b[\s\S]{0,30}\b(?:failed|declined|rejected|didn'?t|did\s+not|wasn'?t|was\s+not|couldn'?t|could\s+not|unsuccessful|error|problem|issue|trouble)\b"
    r"|\b(?:payment|card|charge|transaction)\s+(?:was\s+)?(?:failed|declined|rejected|not\s+processed|unsuccessful)\b"
    r"|\b(?:card\s+was\s+declined|card\s+got\s+declined|payment\s+error|payment\s+failed)\b"
    r"|\b(?:retry|retried|retrying)\b[\s\S]{0,35}\b(?:payment|card|charge|transaction)\b[\s\S]{0,30}\b(?:failed|declined|rejected|error|issue|problem|didn't|did\s+not|wouldn't|wasn't|unsuccessful)\b"
    r"|\b(?:retry|retried|retrying)\b[\s\S]{0,10}\b(?:failed|declined|rejected|unsuccessful)\b[\s\S]{0,30}\b(?:payment|card|charge|transaction)\b"
    r"|\b(?:it|that)\b[\s\S]{0,12}\b(?:didn'?t|did\s+not|couldn'?t|could\s+not|failed)\s+(?:go|went)\s+through\b"
    r")",
    re.IGNORECASE,
)

# ── 3. Field-level entity attributes (P1-ENT) ───────────────────────────────
# "due date" -> the Invoice.due_date field; "billing cycle" -> the
# Subscription.plan.billing_period field; "how much tax was charged" -> the
# Invoice.tax_amount / line-item tax fields.  These are InspectR1 reads of a
# real schema attribute, so they must reach a live-data handler — never the
# RAG/help fallback and never a macro-level dashboard dump.
_DUE_DATE_RE = re.compile(
    r"(?:"
    r"\b(?:what(?:'s|s)?|when)\b[\s\S]{0,25}\b(?:due|bill\s+due)\s+date\b"
    r"|\bmy\s+(?:invoice\s+)?(?:due|billing)\s+date\b"
    r"|\b(?:when|what\s+day)\b[\s\S]{0,25}\b(?:is|do|does)\b[\s\S]{0,15}\b(?:bill|invoice|payment)\b[\s\S]{0,20}\bdue\b"
    r"|\b(?:show|display|get|tell)\s+me\b[\s\S]{0,40}\bdue\s+date\b"
    r"|\b(?:last|latest|most\s+recent)\s+(?:invoice|bill|statement)\s+due\s+date\b"
    r"|\bwhen\b[\s\S]{0,25}\b(?:need|have|got|must)\s+to\s+pay\b"
    r"|\bmy\s+(?:last|latest)\s+(?:bill|invoice|statement)\b[\s\S]{0,20}\b(?:amount|total)?[\s\S]{0,20}\b(?:and|,)\b[\s\S]{0,15}\bdue\s+date\b"
    r"|^\s*due\s*date\s*[?.!]*$"
    r")",
    re.IGNORECASE,
)

_BILLING_CYCLE_RE = re.compile(
    r"(?:"
    r"\bbilling\s+cycle\b|\bbilling\s+period\b|\b(?:how\s+often|how\s+frequently)\b[\s\S]{0,20}\b(?:billed|charged|invoiced)\b"
    r"|\bwhat\s+cycle\b|\bcadence\b[\s\S]{0,15}\b(?:billing|subscription)\b"
    r"|\b(?:on\s+what|what)\s+cycle\s+am\s+i\b"
    r"|\bwhen\s+(?:does|will|do|would)\b[\s\S]{0,15}\b(?:subscription|plan)\b[\s\S]{0,25}\b(?:renew|roll\s*over|next\s+be?\s+billed)\b"
    r"|^\s*(?:monthly|annual|quarterly|semi[-\s]?annual|bi[-\s]?monthly)\s+or\s+(?:monthly|annual|quarterly|semi[-\s]?annual|bi[-\s]?monthly)\s*[?.!]*$"
    r")",
    re.IGNORECASE,
)

_TAX_CHARGED_RE = re.compile(
    r"(?:"
    r"\bhow\s+much\s+(?:tax|vat|gst)\b"
    r"|\b(?:tax|vat|gst)\s+(?:was|is|got)\s+(?:charged|added|collected)\b"
    r"|\b(?:tax|vat|gst)\s+(?:charged|breakdown|amount)\s+(?:on|for|in)\s+(?:my|this|the)\s+(?:invoice|bill)\b"
    r"|\b(?:tax|vat|gst)\s+breakdown\b"
    r"|\btax\s+(?:on|for|in)\s+(?:my|our|this)\b[\s\S]{0,15}\b(?:invoice|bill|charge)\b"
    r"|\b(?:invoice|bill)\b[\s\S]{0,15}\b(?:tax|vat|gst)\b[\s\S]{0,15}\b(?:amount|breakdown|charges?)\b"
    r"|\bamount\s+of\s+(?:tax|vat|gst)\s+(?:on|for)\s+(?:my|this|the)?\s*(?:invoice|bill)\b"
    r")",
    re.IGNORECASE,
)

# ── 3b. Invoice line-item breakdown (P1-ENT) ─────────────────────────────────
# "Show me the items on my bill." / "What line items are on my last invoice?"
# is a read of InvoiceItem rows. It used to drop to the RAG/help fallback and
# answer with a generic knowledge-base explainer about what a bill IS.
# Every shape needs BOTH an item noun AND an invoice/bill anchor, so a command
# about a line item ("add a line item") or a meta ask ("What can you do with a
# line item?") never reaches this route.
_LINE_ITEMS_RE = re.compile(
    r"(?:"
    r"\b(?:show|list|display|give|pull|print|break\s+down)\b[\s\S]{0,60}"
    r"\b(?:line[-\s]?items?|items?|charges|lines?)\b[\s\S]{0,50}"
    r"\b(?:on|in|of|for|from)\b[\s\S]{0,30}\b(?:my|this|the|latest|last|an?)\s+"
    r"(?:invoice|bill|statement)\b"
    r"|\b(?:what|which)\b[\s\S]{0,50}\b(?:line[-\s]?items?|items|charges)\b"
    r"[\s\S]{0,50}\b(?:on|in|of|for|from)\b[\s\S]{0,30}\b(?:my|this|the|latest|last|an?)\s+"
    r"(?:invoice|bill|statement)\b"
    r"|\b(?:line[-\s]?items?|charges)\b[\s\S]{0,40}\b(?:on|in|of)\b[\s\S]{0,30}\b"
    r"(?:my|this|the|latest|last)\s+(?:invoice|bill|statement)\b"
    r"|\bitemized?\b[\s\S]{0,40}\b(?:invoice|bill|statement|breakdown|charges)\b"
    r"|\b(?:what'?s|what\s+is|whats)\s+(?:on|included\s+in)\b[\s\S]{0,25}\b"
    r"(?:my|this|the|latest|last)\s+(?:invoice|bill|statement)\b"
    r"|\bbreakdown\b[\s\S]{0,30}\b(?:of|on|for)\b[\s\S]{0,25}\b"
    r"(?:my|this|the|latest|last)\s+(?:invoice|bill|statement)\b"
    r")",
    re.IGNORECASE,
)

# ── 4. Dunning / grace-period ask (P1 RAG #4a) ──────────────────────────────
# "How many days grace period do I have after a dunning warning?" — this is a
# live-configuration fact (DunningLevel.min_days_overdue), not a generic KB
# look-up, so it must reach a live handler and never EscalateR0.
_GRACE_PERIOD_RE = re.compile(
    r"(?:"
    r"\b(?:grace|graces?)\s+period\b"
    r"|\bhow\s+many\s+days\b[\s\S]{0,20}\b(?:grace|overdue|dunning)\b"
    r"|\bdunning\b[\s\S]{0,25}\b(?:days|warning|level)\b"
    r"|\bhow\s+long\b[\s\S]{0,20}\b(?:before)\b[\s\S]{0,15}\b(?:overdue|dunning)\b"
    r"|\bhow\s+many\s+days\b[\s\S]{0,25}\b(?:before|until)\b[\s\S]{0,15}\b(?:suspension|disconnect|shutdown|restriction|penalty|overdue|dunning)\b"
    r")",
    re.IGNORECASE,
)

# ── 5. Change-cost / "what-if" estimation (P2) ──────────────────────────────
# "Can you calculate my prorated refund if I downgrade my active subscription
# today?" asks for a PROJECTION.  It must enter the estimation handler, never
# the transactional PrepareR2 refund draft flow (which produced a fabricated
# "Refund $50 from payment PAY-1001").  Critical guard: a FACTUAL historical
# summary ("how much have we refunded?") is a metric read and must NOT match —
# the shapes below require a forward-looking change/estimate frame.
_ESTIMATION_RE = re.compile(
    r"(?:"
    r"\b(?:calculate|compute|estimate(?:d)?|estimating|work\s+out|figure\s+out)\b[\s\S]{0,45}\b(?:refund|prorat|credit|cost)\b"
    r"|\b(?:what|how\s+much)\s+(?:would|will|could|might|may|do\s+you\s+estimate)\b[\s\S]{0,45}\b(?:refund|prorat|credit|get\s+back|owe|downgrade|upgrade|cancel(?:l)?ation)\b"
    r"|\bwhat[- ]?if\b[\s\S]{0,50}\b(?:subscription|prorat|refund|downgrade|upgrade)\b"
    r"|\b(?:if|when)\s+i\s+(?:downgrade|upgrade|cancel)\b[\s\S]{0,20}\b(?:subscription|plan)\b"
    r"|\b(?:prorated?|pro[- ]?rata)\b[\s\S]{0,25}\b(?:refund|credit|amount|charge)\b"
    r"|\b(?:how\s+much)\b[\s\S]{0,25}\b(?:refund|credit)\b[\s\S]{0,30}\b(?:if|when|upon|on|would|will)\b"
    r"|\b(?:can\s+you|please)\s+calculate\b[\s\S]{0,45}\b(?:refund|prorat|credit|cost)\b"
    r")",
    re.IGNORECASE,
)


def resolve_semantic_route(normalized: str) -> dict | None:
    """Return a high-specificity route for a semantically-precise query, or None.

    Only the exact QA gap shapes are intercepted; everything else is left to
    the existing token-weighted gates, so no regression is introduced to
    queries the current router already handles well.
    """
    text = (normalized or "").strip().lower()
    if not text:
        return None

    # Estimation/"what-if" must be decided BEFORE the retry/troubleshoot shape
    # (a downgrade-estimate can mention payment refunds).
    if _ESTIMATION_RE.search(text):
        return _route("estimate_change", "billing", RISK_R1, 0.9)

    if _GRACE_PERIOD_RE.search(text):
        return _route("dunning_grace_period", "billing", RISK_R1, 0.9)

    if _DUE_DATE_RE.search(text):
        return _route("invoice_due_date", "billing", RISK_R1, 0.9)

    if _BILLING_CYCLE_RE.search(text):
        return _route("subscription_billing_cycle", "billing", RISK_R1, 0.9)

    if _TAX_CHARGED_RE.search(text):
        return _route("invoice_tax_breakdown", "billing", RISK_R1, 0.9)

    if _LINE_ITEMS_RE.search(text):
        # A read of the actual InvoiceItem rows, never a generic knowledge
        # explainer about what an invoice or a line item is.
        return _route("invoice_line_items", "billing", RISK_R1, 0.9)

    if _PAYMENT_RETRY_RE.search(text):
        return _route("payment_troubleshoot", "help", RISK_R0, 0.9)

    if _PAYMENT_OPTIONS_RE.search(text):
        # Informational payment-capability questions ("what payment options /
        # methods are supported?") must answer from the approved Payments &
        # Allocations KB document (M0/R0), never from a dump of payment
        # records.  Routing to help_general sends them through retrieval so
        # the answer stays grounded in the approved public document.
        return _route("help_general", "help", RISK_R0, 0.9)

    return None