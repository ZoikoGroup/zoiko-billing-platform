"""
conversation/engine.py
---------------------
Enhanced conversation engine integrating model gateway for intent
classification and grounded response generation.

Implements M0 (Explain) and M1 (Inspect) only. No mutation capability.
Every answer citing tenant financial data attaches retrieval_citation /
service_response_snapshot evidence.

Architecture per ZB-AI-ARCH-001:
  - Intent classification via model (with rules fallback)
  - Domain-specific handlers reuse existing billing read services
  - Every model_run and tool_invocation logged with prompt_template id
  - Evidence-backed responses with citation rows
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import traceback
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from app.modules.billing.models import (
    BillingCustomer,
    Invoice,
    Payment,
    PaymentAllocation,
    Subscription,
    Contract,
    Product,
    Quotation,
    CreditNote,
    Refund,
    DunningCase,
)
from app.modules.organizations.models import Organization

from ..context.ai_context import AIContext
from ..models import (
    AIConversation,
    AIConversationMessage,
    AIActionDraft,
    AIActionPreview,
    AIAuditEvent,
    IntentClassification,
    ModelRun,
    PromptTemplate,
    ToolInvocation,
    RetrievalRun,
    RetrievalCitation,
    ConversationStatus,
    ConversationDomain,
    SenderType,
    RiskClass,
    AuthorityMode,
    DraftStatus,
    PreviewStatus,
    AuditEventType,
    ModelRunType,
    IntentClassifiedBy,
    ToolInvocationStatus,
)
from ..model_gateway.base import ModelGateway, ModelMessage, ModelTool, ModelGatewayError
from ..model_gateway.router_config import get_model_config
from ..knowledge.retrieval import KnowledgeRetriever, QUERY_STOPWORDS

logger = logging.getLogger("zoiko_billing.ai.conversation")


# ── Constants ────────────────────────────────────────────────────────────────

RISK_ORDER = {"R0": 0, "R1": 1, "R2": 2, "R3": 3, "R4": 4, "RX": 5}

# ── D-11 Safe uncertainty (PRD §06) ─────────────────────────────────────────
# "When context is missing or ambiguous, ask, narrow scope or route; do not
# guess." These thresholds govern when the classifier must CLARIFY instead of
# silently answering a possibly-wrong intent.
#
# Fallback/generic intents are NOT specific answers — they are catch-alls.
FALLBACK_INTENTS = (
    "general_billing_lookup",
    "help_general",
    "ambiguous_count",
    "ambiguous_general",
)
# A rules match at/above this confidence is a SPECIFIC intent: it wins over a
# generic model classification (prevents e.g. "How many customers?" being
# hijacked into an unrelated credit-note/audit dump by the model classifier).
SPECIFIC_INTENT_CONFIDENCE = 0.8
# Below this bar a single-source classification is too weak to answer from —
# the assistant asks a clarifying question instead.
CLARIFY_CONFIDENCE = 0.7
# A model classification must reach this bar to beat a fallback-level rules
# result on its own; otherwise the two candidates are offered to the user.
MODEL_SPECIFIC_CONFIDENCE = 0.85

# ── §6.0 Topic screening (ZB-AI-GRD-001 §6.0 / OUT_OF_DOMAIN) ────────────────
# Positive domain-relevance screen: a query is ANSWERED only when it shows
# evidence of belonging to the billing/product domain. Off-topic questions are
# refused BEFORE intent classification, RAG retrieval, or handler routing
# (OUT_OF_DOMAIN state — see guardrail spec §6.0).
#
# Matching is TOKEN-EXACT (with light plural stemming) — NEVER substring — so
# that e.g. "cryptocurrency" does not match "currency".
BILLING_DOMAIN_VOCABULARY = frozenset((
    # Core billing objects
    "invoice", "payment", "customer", "client", "subscription", "contract",
    "quotation", "quote", "product", "credit", "refund", "dunning", "bill",
    "chargeback", "receipt", "statement", "reminder", "dispute", "adjustment",
    "proration", "catalog", "catalogue", "item", "line",
    # Money / figures
    "revenue", "balance", "amount", "subtotal", "price", "pricing", "cost",
    "fee", "discount", "tax", "vat", "gst", "currency", "money", "total",
    "overdue", "outstanding", "unpaid", "paid", "payable", "receivable",
    "due", "aging", "owe", "charged", "paying", "collection",
    # Plans / lifecycle
    "plan", "tier", "trial", "coupon", "voucher", "promo", "renewal",
    "cancellation", "upgrade", "downgrade", "seat", "usage", "metered",
    # Recurring-revenue metrics (acronyms must pass the topic gate)
    "mrr", "arr", "recurring",
    # Product / governance surface
    "billing", "dashboard", "kpi", "metric", "report", "export", "reconcile",
    "reconciliation", "allocation", "assistant", "chatbot", "capability",
    "feature", "zoiko", "organization", "tenant", "mode", "governance",
    # Platform access control (product docs domain)
    "user", "role", "permission",
))
# Multi-word domain evidence — substring match on the normalized query.
BILLING_DOMAIN_PHRASES = (
    "credit note", "write off", "written off", "payment terms", "due date",
    "net 30", "net 60", "net 90", "exchange rate", "billing cycle",
    "billing period", "billing workflow", "accounts receivable",
    "accounts payable", "purchase order", "po number", "sales tax",
    "tax id", "vat number", "late fee", "late payment", "payment method",
    "payment link", "trial period", "plan upgrade", "product catalog",
    "product catalogue", "knowledge base", "audit trail", "multi-currency",
    "multi currency", "pro rata", "pro-rated", "bank transfer",
    "wire transfer", "stripe", "invoice status", "aging report",
    "general ledger", "fiscal year", "tax rate",
)
# Words that carry no SUBJECT meaning for the refusal gates. A query whose
# only non-stopword tokens come from this set has no substantive subject and
# must NOT be refused (e.g. "hmm interesting" stays a help/clarify case).
GATE_FILLER_TOKENS = frozenset((
    "please", "assistant", "chatbot", "bot", "ai", "help", "assist",
    "support", "thing", "things", "stuff", "something", "anything", "it",
    "them", "they", "question", "questions", "interesting", "ok", "okay",
    "hello", "hi", "hey", "thanks", "thank", "bye", "sure", "cool", "nice",
    "great", "good", "well", "hmm", "wow", "really", "maybe", "perhaps",
))
# Informational question shapes the early gate screens.
_GATE_SHAPE_RE = re.compile(
    r"\b(explain|describe|define|elaborate|clarify|teach|educate"
    r"|meaning\s+of|definition\s+of|tell\s+me\s+about"
    r"|what\s+is|what\s+are|what's|whats|what\s+does"
    r"|how\s+does|how\s+do|how\s+to"
    r"|who\s+(?:is|are|was|were|won)|where\s+(?:is|are|can|do|does)"
    r"|give\s+me)\b"
)
# Document/reference identifiers always count as domain evidence
# (e.g. INV-2024-0001, PAY-17, kb-42).
_DOC_REF_RE = re.compile(r"\b(?:inv|pay|pmt|cust|sub|con|quo|qte|cn|rf|kb|doc|ref)[- ]?\d+\b|\b\w+(?:-\w+)*-\d{2,}\b")

# Definitional EXPLANATION shapes: the user is asking how/why something
# works or what something means — an M0 Explain (RAG) question. This must be
# detected on SENTENCE SHAPE alone, regardless of how many entity nouns the
# subject contains: entity-list rules below key on bare nouns ("invoices",
# "customers") and would otherwise hijack compound-subject explanations
# ("Explain how invoices and payments work") into live-data lookups.
# Deliberately NOT matched: "tell me about X" (legit customer/entity search),
# "what is Gok's balance" (live financial lookup — no work/mean tail),
# "how many ..." (count queries).
_DEFINITIONAL_SHAPE_RE = re.compile(
    r"\b(?:explain|describe)\b"
    r"|\bhow\s+(?:do|does|did)\b[^?]*\bworks?\b"
    r"|\bwhat\s+(?:is|are)\b[^?]*\b(?:works?|means?)\b"
    r"|\bwhat\s+does\b[^?]*\bmeans?\b"
)

# ── Compound-term normalization (tokenization drift) ────────────────────────
# Users (and speech-to-text) split or fuse compound billing terms:
# "dash board", "sub scription", "creditnote". Substring keyword matching
# never sees the canonical term, so classification falls through to RAG.
# Each family is rewritten to the CANONICAL form used by the classifier's
# keyword lists ("credit note" stays two words; "dashboard" stays one).
def _match_plural_to(match: re.Match, singular: str) -> str:
    word = match.group(0).lower()
    return singular + ("s" if word.endswith("s") else "")

COMPOUND_TERM_NORMALIZERS = (
    (re.compile(r"\bdash[\s-]?boards?\b", re.IGNORECASE), lambda m: _match_plural_to(m, "dashboard")),
    (re.compile(r"\bsub[\s-]?scriptions?\b", re.IGNORECASE), lambda m: _match_plural_to(m, "subscription")),
    (re.compile(r"\bover[\s-]?due\b", re.IGNORECASE), lambda m: "overdue"),
    (re.compile(r"\bpast[\s-]?due\b", re.IGNORECASE), lambda m: "past due"),
    (re.compile(r"\bwritten[\s-]?off\b", re.IGNORECASE), lambda m: "written off"),
    (re.compile(r"\bwrite[\s-]?offs?\b", re.IGNORECASE), lambda m: _match_plural_to(m, "write off")),
    (re.compile(r"\bcredit[\s-]?notes?\b", re.IGNORECASE), lambda m: _match_plural_to(m, "credit note")),
)


def normalize_domain_text(text: str) -> str:
    """Rewrite spacing/hyphen variants of compound billing terms to their
    canonical form. Idempotent on already-canonical text."""
    if not text:
        return text
    for pattern, repl in COMPOUND_TERM_NORMALIZERS:
        text = pattern.sub(repl, text)
    return text


def _within_edit_distance_1(a: str, b: str) -> bool:
    """True when `a` can be turned into `b` with at most one edit
    (insert / delete / substitute). Two-pointer, O(len)."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    i = j = 0
    used_edit = False
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        if used_edit:
            return False
        used_edit = True
        if la == lb:
            i += 1  # substitution consumes both
        # else: single insert/delete — consume only the longer string
        j += 1
    return True

# Fuzzy rescue: when NO exact rule matched but a token is within one edit of
# a core billing noun, route to that noun's surface instead of risking a
# loose RAG match. Singular and plural keys both listed (a doubled letter
# before the plural 's' would be distance 2 from the singular form).
FUZZY_INTENT_KEYWORDS = {
    "dashboard": ("dashboard_summary", "dashboard"),
    "dashboards": ("dashboard_summary", "dashboard"),
    "subscription": ("subscription_list", "billing"),
    "subscriptions": ("subscription_list", "billing"),
    "invoice": ("invoice_list", "billing"),
    "invoices": ("invoice_list", "billing"),
    "payment": ("payment_list", "billing"),
    "payments": ("payment_list", "billing"),
    "customer": ("customer_list", "billing"),
    "customers": ("customer_list", "billing"),
}

# ── Definitional questions about financial metrics ──────────────────────────
# "Explain me about Revenue" / "What is Outstanding?" are asking WHAT the
# metric means. They must yield definition-first answers composed with the
# live figure — not a bare number hijack (metric_revenue) and not an
# abstention (help_general → weak RAG).
_DEF_SHAPE_RES = (
    # explain [me] [about] X / explain X
    re.compile(
        r"^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|i\s+want\s+(?:to\s+)?|lemme\s+)?"
        r"explain(?:\s+(?:me|it|that|this|to\s+me))*(?:\s+about|\s+on)?\s*:?\s*(.+?)\s*\??\s*$",
        re.IGNORECASE,
    ),
    # what is X / what's X / what was X   (NOT "what are" — list shapes)
    re.compile(r"^\s*what\s+(?:is|'s|was)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s*\??\s*$", re.IGNORECASE),
    # what does X mean
    re.compile(r"^\s*what\s+does\s+(?:the\s+|a\s+)?(.+?)\s+mean\b.*$", re.IGNORECASE),
    # meaning of X / definition of X
    re.compile(r"^\s*(?:meaning|definition)\s+of\s+(?:the\s+|a\s+|an\s+)?(.+?)\s*\??\s*$", re.IGNORECASE),
    # how is X calculated/computed/defined
    re.compile(
        r"^\s*how\s+(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:calculated|computed|derived|defined)\b.*$",
        re.IGNORECASE,
    ),
    # how do(es) X work
    re.compile(r"^\s*how\s+(?:do|does)\s+(.+?)\s+work\b.*$", re.IGNORECASE),
)
# Status semantics have their own dedicated handlers — never intercept.
_DEF_GUARD_SKIP_RE = re.compile(r"\bstatuse?s?\b", re.IGNORECASE)
# Possessive subjects ("my outstanding balance") are live-data lookups.
_DEF_POSSESSIVE_RE = re.compile(r"^\s*(?:my|our|his|her|their|its)\b", re.IGNORECASE)

METRIC_DEFINITIONS = {
    "revenue": {
        "label": "Revenue",
        "definition": (
            "Revenue is the total value of all invoices you have issued to "
            "customers, in your organization's base currency."
        ),
        "formula": (
            "summing invoice totals across all active invoices — draft and "
            "cancelled invoices are excluded"
        ),
        "kpi_key": "total_revenue",
        "live": True,
    },
    "paid_revenue": {
        "label": "Paid revenue",
        "definition": (
            "Paid revenue is the portion of your revenue that has actually "
            "been collected — only fully paid invoices count toward it."
        ),
        "formula": "summing invoice totals across invoices whose status is paid",
        "kpi_key": "paid_revenue",
        "live": True,
    },
    "outstanding": {
        "label": "Outstanding amount",
        "definition": (
            "The outstanding amount is the money your customers still owe you: "
            "the unpaid balance on every issued invoice that is not yet settled."
        ),
        "formula": (
            "summing the balance due on invoices in sent, overdue, or "
            "partially-paid status (drafts excluded)"
        ),
        "kpi_key": "outstanding_amount",
        "live": True,
    },
    "overdue": {
        "label": "Overdue amount",
        "definition": (
            "The overdue amount is the slice of your outstanding balance whose "
            "payment due date has passed without being paid in full."
        ),
        "formula": (
            "summing the balance due on invoices whose due date is in the past "
            "and which still carry a balance"
        ),
        "kpi_key": "overdue_amount",
        "live": True,
    },
    "mrr": {
        "label": "MRR (Monthly Recurring Revenue)",
        "definition": (
            "MRR is the normalized monthly value of your recurring revenue — "
            "every subscription contributes its plan price divided by its "
            "billing period length."
        ),
        "formula": "summing each active subscription's price normalized to a monthly value",
        "kpi_key": None,
        "live": False,
    },
    "arr": {
        "label": "ARR (Annual Recurring Revenue)",
        "definition": (
            "ARR is the yearly equivalent of your MRR — what your active "
            "subscriptions are worth over twelve months."
        ),
        "formula": "multiplying MRR by 12",
        "kpi_key": None,
        "live": False,
    },
}
# Ordered subject matchers — first hit wins (checked longest/most-specific first).
_METRIC_SUBJECT_RULES = (
    ("mrr", re.compile(r"\b(?:mrr|monthly\s+recurring\s+revenue)\b", re.IGNORECASE)),
    ("arr", re.compile(r"\b(?:arr|annual\s+recurring\s+revenue)\b", re.IGNORECASE)),
    ("paid_revenue", re.compile(r"\bpaid\s+(?:revenue|amount|invoices?)\b|\bcash\s+collected\b|\bcollections?\b", re.IGNORECASE)),
    ("overdue", re.compile(r"\bover\s?due\b|\boverdues\b", re.IGNORECASE)),
    ("outstanding", re.compile(r"\boutstanding\b|\bunpaid\b|\breceivables?\b|\bowed?\b|\bbalance\b", re.IGNORECASE)),
    ("revenue", re.compile(r"\brevenue\b|\bincome\b|\bearnings\b|\bsales\b|\btop\s?line\b", re.IGNORECASE)),
)


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def _vocab_match(token: str) -> bool:
    """Token-exact vocabulary match with light plural stemming, plus a
    one-edit fuzzy pass so typos ("dashbord", "subscribtion") still count
    as domain evidence."""
    if token in BILLING_DOMAIN_VOCABULARY:
        return True
    if token.endswith("ies") and len(token) > 3 and token[:-3] + "y" in BILLING_DOMAIN_VOCABULARY:
        return True
    if token.endswith("es") and len(token) > 2 and token[:-2] in BILLING_DOMAIN_VOCABULARY:
        return True
    if token.endswith("s") and len(token) > 1 and token[:-1] in BILLING_DOMAIN_VOCABULARY:
        return True
    if len(token) >= 5:
        return any(
            len(entry) >= 5 and _within_edit_distance_1(token, entry)
            for entry in BILLING_DOMAIN_VOCABULARY
        )
    return False


def _gate_substantive_tokens(text: str) -> list[str]:
    """Non-stopword, non-filler tokens — the query's candidate subject."""
    return [
        t for t in _tokenize(text)
        if t not in QUERY_STOPWORDS and t not in GATE_FILLER_TOKENS
    ]


def topic_screen(text: str) -> bool:
    """§6.0 positive domain-relevance screen.

    Returns True when the query shows evidence of belonging to the
    billing/product domain (domain vocabulary, domain phrase, or a document
    reference). False means OUT_OF_DOMAIN — the caller must refuse.
    """
    normalized = (text or "").strip().lower()
    normalized = normalize_domain_text(normalized)
    if not normalized:
        return True  # empty/noise: never screened out here
    if _DOC_REF_RE.search(normalized):
        return True
    for phrase in BILLING_DOMAIN_PHRASES:
        if phrase in normalized:
            return True
    return any(_vocab_match(t) for t in _tokenize(normalized))

DOMAIN_SUGGESTIONS = {
    "billing": [
        "Show overdue invoices",
        "Look up customer details",
        "Explain invoice balances",
    ],
    "help": [
        "What can you do?",
        "How do refunds work?",
        "Explain payment allocations",
    ],
}

# Human-readable labels used by the D-11 clarification path.
DOMAIN_LABELS = {
    "billing": "Billing records (invoices, payments, customers)",
    "dashboard": "Your billing dashboard (financial summary)",
    "action": "A billing action (draft, issue, refund, correction)",
    "reconciliation": "Payment reconciliation",
    "help": "Product guidance (how things work)",
    "out_of_scope": "Something outside billing",
}

# Keyword sets used to match a user's REPLY against the options a
# clarification question just offered (D-11 follow-through: a reply like
# "I need the customer Dashboard summary" must resolve the pending
# clarification, not re-ask it).
CLARIFY_KEYWORDS = {
    "dashboard": ("billing", "financial", "finance", "summary", "revenue",
                  "kpi", "kpis", "money", "outstanding", "cash"),
    "customer": ("customer", "customers", "client", "clients"),
    "invoice": ("invoice", "invoices", "bill", "bills"),
    "payment": ("payment", "payments", "transaction", "transactions"),
    "subscription": ("subscription", "subscriptions", "plan", "plans"),
}

# Where each entity-qualified dashboard phrase routes when resolved
# ("the customer view" → customer list, etc.).
DASHBOARD_QUALIFIER_ROUTES = {
    "customer": {"intent": "customer_list", "domain": "billing"},
    "invoice": {"intent": "invoice_list", "domain": "billing"},
    "payment": {"intent": "payment_list", "domain": "billing"},
    "subscription": {"intent": "subscription_list", "domain": "billing"},
}

INTENT_TOOLS = [
    ModelTool(
        name="search_invoices",
        description="Search invoices by number, customer, status, or date range",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search term"},
                "status": {"type": "string", "enum": ["draft", "sent", "paid", "overdue", "cancelled", "partially_paid", "refunded", "written_off"]},
            },
        },
    ),
    ModelTool(
        name="search_payments",
        description="Search payments by number, transaction ID, or customer",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search term"},
            },
        },
    ),
    ModelTool(
        name="search_customers",
        description="Search customers by name, code, or email",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search term"},
            },
        },
    ),
    ModelTool(
        name="get_dashboard_summary",
        description="Get financial dashboard summary for the current tenant",
        input_schema={"type": "object", "properties": {}},
    ),
]


def _uid() -> str:
    return str(uuid.uuid4())


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# Titles still carrying this placeholder after the first user message are
# backfilled from that message (see list_conversations / send_message).
PLACEHOLDER_CONVERSATION_TITLES = ("", "new conversation", "untitled")

TITLE_MAX_LEN = 48


def derive_conversation_title(text: str | None, max_len: int = TITLE_MAX_LEN) -> str:
    """Derive a history-list title from the first user message.

    Collapses whitespace, cuts at a word boundary within ~48 chars and
    appends an ellipsis. Raw truncated text is the accepted first pass;
    an AI-summarized title can replace this later without touching callers.
    """
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return "New Conversation"
    if len(t) > max_len:
        cut = t[:max_len]
        if " " in cut:
            cut = cut.rsplit(" ", 1)[0]
        t = cut.rstrip(" ,;:.!?-—…") + "…"
    return t[0].upper() + t[1:]


def money(value, currency: str | None = None) -> str:
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, TypeError):
        amount = Decimal("0")
    rendered = f"{amount:,.2f}"
    return f"{currency or ''} {rendered}".strip()


def iso(value) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def enum_value(value) -> str | None:
    if value is None:
        return None
    return value.value if hasattr(value, "value") else str(value)


class ConversationEngine:
    """Enhanced conversation engine with model gateway integration."""

    def __init__(self, db: Session, model_gateway: ModelGateway | None = None):
        self.db = db
        self._gateway = model_gateway
        self._retriever = KnowledgeRetriever(db)
        # Current app route for page-context grounding (set per message in
        # _process_message; engines are request-scoped so this is safe).
        self._current_page_path: str | None = None

    # ── Retrieval helper ──────────────────────────────────────────────

    _GENERIC_PAGE_SEGMENTS = frozenset((
        "billing", "app", "home", "index", "new", "edit", "detail",
        "details", "page", "view", "list", "settings",
    ))

    # Status-knowledge question shapes. List-questions ("what are the valid
    # invoice statuses?") are grounded via KB retrieval; meaning-questions
    # ("what does 'Delivered' mean for invoice status?") validate against the
    # live InvoiceStatus enum — a system fact no KB document can state.
    _STATUS_LIST_RE = re.compile(
        r"(?:what|which|list|name|show)\s+(?:are|is|do|does|have|include)?\s*(?:the\s+)?"
        r"(?:valid|available|allowed|supported|possible|all|complete|full)?\s*"
        r"(?:invoice\s+)?statuse?s?\b"
    )
    _STATUS_MEANING_RE = re.compile(r"what does ['\"]?(\w+)['\"]?\s*(?:mean|stand)")

    def _page_boost_terms(self) -> list[str]:
        """Derive retrieval boost terms from the current app route, e.g.
        '/billing/reports' → ['reports', 'report']. Used to bias ranking
        toward content matching the surface the user is already on."""
        raw = getattr(self, "_current_page_path", None)
        if not raw:
            return []
        terms: set[str] = set()
        for seg in str(raw).lower().split("/"):
            seg = seg.strip()
            if len(seg) >= 4 and seg not in self._GENERIC_PAGE_SEGMENTS:
                terms.add(seg)
                terms.add(seg.rstrip("s"))
        return [t for t in terms if len(t) >= 4]

    def _retrieve(self, query: str, ctx: AIContext, top_k: int = 3) -> dict:
        """Retrieve knowledge chunks and build a retrieval-backed response dict."""
        logger.info("topic_screen: RAG retrieve called query=%r top_k=%s", query, top_k)
        try:
            results, citations = self._retriever.retrieve(
                query=query, ctx=ctx, top_k=top_k, min_score=0.2,
                boost_terms=self._page_boost_terms(),
            )
        except Exception:
            logger.warning("Knowledge retrieval failed, returning empty results")
            return {"answer": None, "evidence": [], "citations": [], "confident": False, "low_confidence": False}
        if not results:
            return {"answer": None, "evidence": [], "citations": [], "confident": False, "low_confidence": False}
        # Deduplicate by normalized text: identical content must never appear
        # twice in one answer, whichever layer let it through (duplicate
        # chunk rows from re-seeding, or two versions of the same document).
        seen_texts: set[str] = set()
        unique_results = []
        for r in results:
            key = " ".join(r.chunk_text.lower().split())
            if key in seen_texts:
                continue
            seen_texts.add(key)
            unique_results.append(r)
        results = unique_results
        # Synthesis and citations must agree: the answer is built from the
        # top chunks, and the citation label must name the document(s) that
        # content actually came from — led by the MAJORITY contributor.
        # Raw retrieval rank alone is not enough: single-word queries saturate
        # several chunks at the score ceiling, and stable sort then put an
        # incidental document first ("Billing Reports +1" on a payments
        # answer whose text was entirely Payments-and-Allocations).
        synth = results[:3]
        by_doc: dict[int, list] = {}
        for r in synth:
            by_doc.setdefault(r.document_id, []).append(r)
        lead_id = max(
            by_doc,
            key=lambda d: (len(by_doc[d]), max(r.score for r in by_doc[d])),
        )
        lead_best = max(r.score for r in by_doc[lead_id])
        kept = []
        for d, rs in by_doc.items():
            # Keep a secondary document only if it contributes as much content
            # as the lead OR its best chunk genuinely outscores the lead's.
            # A minority rider with no score edge is content bleed: drop it
            # from both the synthesized answer and the citation list.
            if len(rs) >= len(by_doc[lead_id]) or max(r.score for r in rs) > lead_best:
                kept.extend(rs)
        kept.sort(key=lambda r: (-r.score, r.rank))
        chunks_text = "\n\n".join(f"• {r.chunk_text}" for r in kept[:3])
        doc_stats: dict[int, dict] = {}
        for r in kept[:3]:
            st = doc_stats.setdefault(
                r.document_id, {"source": r.source_title, "score": r.score, "chunks": 0}
            )
            st["chunks"] += 1
            st["score"] = max(st["score"], r.score)
        evidence = [
            {"source": st["source"], "score": st["score"]}
            for st in sorted(doc_stats.values(), key=lambda s: (-s["chunks"], -s["score"]))
        ]
        confident = self._retriever.is_confident(results, threshold=0.3)
        return {
            "answer": chunks_text,
            "evidence": evidence,
            "citations": citations,
            "confident": confident,
            # Results exist but none clears the confidence bar — the handler
            # must ABSTAIN (offer escalation) instead of quoting weak matches.
            "low_confidence": not confident,
        }

    # ── Public API ─────────────────────────────────────────────────────

    def create_conversation(
        self,
        *,
        ctx: AIContext,
        title: str | None = None,
        initial_message: str | None = None,
    ) -> dict:
        """Create a new conversation and optionally process an initial message."""
        conv = AIConversation(
            conversation_uid=_uid(),
            session_id=None,
            tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            title=title or "New Conversation",
            conversation_status=ConversationStatus.OPEN,
        )
        self.db.add(conv)
        self.db.flush()

        self._audit(AuditEventType.SESSION_CREATED, conv, ctx, {"title": title})

        messages = []
        if initial_message:
            if str(conv.title or "").strip().lower() in PLACEHOLDER_CONVERSATION_TITLES:
                conv.title = derive_conversation_title(initial_message)
            response = self._process_message(conv, initial_message, ctx)
            messages.append(response)

        self.db.commit()
        self.db.refresh(conv)

        return {
            "conversation_uid": conv.conversation_uid,
            "title": conv.title,
            "status": enum_value(conv.conversation_status),
            "messages": messages,
            "created_at": conv.created_at,
        }

    def list_conversations(self, *, ctx: AIContext, limit: int = 20, offset: int = 0) -> list[dict]:
        """List the current user's conversations."""
        conversations = (
            self.db.query(AIConversation)
            .filter(
                AIConversation.organization_id == ctx.organization_id,
                AIConversation.user_id == ctx.user_id,
                AIConversation.conversation_status != ConversationStatus.ARCHIVED,
            )
            .order_by(AIConversation.updated_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

        # Backfill legacy titles: any listed conversation that still carries
        # the placeholder but has user messages gets its title derived from
        # the first stored user message (self-healing on history open).
        changed = False
        for c in conversations:
            if str(c.title or "").strip().lower() not in PLACEHOLDER_CONVERSATION_TITLES:
                continue
            first_user_msg = (
                c.messages.filter(AIConversationMessage.sender_type == SenderType.USER)
                .order_by(AIConversationMessage.created_at.asc())
                .first()
            )
            if first_user_msg:
                c.title = derive_conversation_title(first_user_msg.message_text)
                changed = True
        if changed:
            self.db.commit()

        return [
            {
                "conversation_uid": c.conversation_uid,
                "title": c.title,
                "status": enum_value(c.conversation_status),
                "domain": enum_value(c.primary_domain),
                "highest_risk": enum_value(c.highest_risk_class),
                "message_count": c.message_count or 0,
                "created_at": c.created_at,
                "updated_at": c.updated_at,
            }
            for c in conversations
        ]

    def get_conversation(self, *, conversation_uid: str, ctx: AIContext) -> dict | None:
        conv = (
            self.db.query(AIConversation)
            .filter(
                AIConversation.conversation_uid == conversation_uid,
                AIConversation.organization_id == ctx.organization_id,
                AIConversation.user_id == ctx.user_id,
            )
            .first()
        )
        if not conv:
            return None

        db_messages = conv.messages.order_by(AIConversationMessage.created_at.asc()).all()
        return {
            "conversation_uid": conv.conversation_uid,
            "title": conv.title,
            "status": enum_value(conv.conversation_status),
            "domain": enum_value(conv.primary_domain),
            "highest_risk": enum_value(conv.highest_risk_class),
            "messages": [
                {
                    "message_uid": m.message_uid,
                    "sender_type": enum_value(m.sender_type),
                    "message_text": m.message_text,
                    "mode": m.mode,
                    "risk_class": enum_value(m.risk_class),
                    "structured_payload": m.structured_payload,
                    "created_at": m.created_at,
                }
                for m in db_messages
            ],
            "created_at": conv.created_at,
            "updated_at": conv.updated_at,
        }

    def close_conversation(self, *, conversation_uid: str, ctx: AIContext) -> bool:
        conv = self._get_conversation(conversation_uid, ctx)
        if not conv:
            return False
        conv.conversation_status = ConversationStatus.RESOLVED
        self._audit(AuditEventType.SESSION_CLOSED, conv, ctx, {})
        self.db.commit()
        return True

    def send_message(
        self,
        *,
        conversation_uid: str,
        message: str,
        ctx: AIContext,
        page_path: str | None = None,
    ) -> dict:
        """Process a user message and return a governed response."""
        if not ctx.organization_id:
            return self._escalation_response(
                conversation_uid=conversation_uid,
                ctx=ctx,
                answer="I can explain Zoiko Billing concepts, but I cannot inspect tenant billing records until an organization context is selected.",
            )

        conv = self._get_conversation(conversation_uid, ctx)
        if not conv:
            return self._escalation_response(
                conversation_uid=conversation_uid,
                ctx=ctx,
                answer="Conversation not found or access denied.",
            )

        # Store user message
        user_msg = AIConversationMessage(
            conversation_id=conv.id,
            message_uid=_uid(),
            sender_type=SenderType.USER,
            message_text=message,
        )
        self.db.add(user_msg)
        self.db.flush()

        # Title the conversation from its first user message (ChatGPT-style):
        # placeholder-titled conversations get a derived title once real
        # content exists; explicitly titled ones are never overwritten.
        if str(conv.title or "").strip().lower() in PLACEHOLDER_CONVERSATION_TITLES and \
                not (conv.message_count or 0):
            conv.title = derive_conversation_title(message)

        self._audit(AuditEventType.MESSAGE_SENT, conv, ctx, {"sender": "user", "length": len(message)})

        # Process and generate response
        response = self._process_message(conv, message, ctx, page_path=page_path)

        # Update conversation metadata
        conv.message_count = (conv.message_count or 0) + 2
        resp_risk = response.get("risk_class", "R0")
        current_risk = enum_value(conv.highest_risk_class) or "R0"
        if RISK_ORDER.get(resp_risk, 0) > RISK_ORDER.get(current_risk, 0):
            conv.highest_risk_class = RiskClass(resp_risk)

        self.db.commit()

        return response

    # ── Message Processing ─────────────────────────────────────────────

    def _process_message(self, conv: AIConversation, text: str, ctx: AIContext, page_path: str | None = None) -> dict:
        """Core message processing: classify intent, route to handler, build response."""
        # Remember the caller's route so retrieval can bias toward the
        # surface the user is currently viewing (page-context grounding).
        self._current_page_path = page_path
        # Load conversational context (prior user turns) so follow-ups and
        # pronoun references resolve ("how many are there?", "show his details").
        context = self._load_conversation_context(conv, ctx, current_text=text)
        resolved_text = self._resolve_references(text, conv, ctx, context)

        # ── Clarification follow-through ────────────────────────────────
        # If the previous assistant message asked a disambiguation question,
        # treat THIS message as its answer first — before fresh intent
        # detection re-triggers the same clarification (loop prevention).
        pending = self._get_pending_clarification(conv)
        clarification_note: str | None = None
        executed = False

        if pending:
            matched = self._match_clarify_option(resolved_text, pending)
            if matched and pending.get("kind") == "dashboard_scope":
                # An option backed only by the help_general placeholder (no
                # real records surface exists for that qualifier, e.g. "team")
                # cannot actually be shown. Whatever the reply — echoed phrase
                # or explicit pick — commit to the billing dashboard with an
                # explicit assumption note instead.
                if (matched.get("route") or {}).get("intent") == "help_general":
                    matched, assumption = self._choose_clarification_fallback(pending, page_path)
                    clarification_note = assumption
            if matched:
                route = matched.get("route") or {"intent": "general_billing_lookup", "domain": "billing"}
                intent = {
                    "intent": route["intent"],
                    "domain": route["domain"],
                    "risk_class": "R1",
                    "confidence": 0.95,
                    "classified_by": IntentClassifiedBy.RULES,
                }
                logger.error("[CHATBOT-DIAG] clarify-resolved reply=%r -> %s/%s",
                             resolved_text[:80], intent["domain"], intent["intent"])
                handler = self._get_handler(intent["domain"])
                result = handler(conv, resolved_text, intent, ctx)
                executed = True
                if clarification_note is None:
                    clarification_note = f"Taking your reply as: **{matched['label']}**."
            else:
                # Reply didn't match any offered option — classify fresh. If
                # that classification wants to ask the SAME kind of clarify
                # again, commit to the best option instead (max one round-trip).
                intent = self._classify_intent(conv, resolved_text, ctx, context=context, page_path=page_path)
                if intent.get("domain") == "clarify":
                    chosen, assumption = self._choose_clarification_fallback(pending, page_path)
                    route = chosen.get("route") or {"intent": "general_billing_lookup", "domain": "billing"}
                    intent = {
                        "intent": route["intent"],
                        "domain": route["domain"],
                        "risk_class": "R1",
                        "confidence": 0.9,
                        "classified_by": IntentClassifiedBy.RULES,
                    }
                    logger.error("[CHATBOT-DIAG] clarify-loop-break reply=%r -> committing to %s",
                                 resolved_text[:80], chosen.get("label"))
                    handler = self._get_handler(intent["domain"])
                    result = handler(conv, resolved_text, intent, ctx)
                    executed = True
                    clarification_note = assumption

        if not executed:
            # Try model-based intent classification first, fall back to rules
            intent = self._classify_intent(conv, resolved_text, ctx, context=context, page_path=page_path)
            # Route to domain handler (M0/M1 only)
            handler = self._get_handler(intent["domain"])
            result = handler(conv, resolved_text, intent, ctx)

        logger.error("[CHATBOT-DIAG] intent=%s domain=%s confidence=%s classified_by=%s",
                      intent.get("intent"), intent.get("domain"), intent.get("confidence"), intent.get("classified_by"))
        logger.error("[CHATBOT-DIAG] handler=%s", handler.__name__ if hasattr(handler, '__name__') else str(handler))
        logger.error("[CHATBOT-DIAG] result mode=%s risk=%s answer_preview=%r", result.get("mode"), result.get("risk_class"), result.get("answer", "")[:120])

        if clarification_note:
            result = dict(result)
            result["answer"] = f"{clarification_note}\n\n{result['answer']}"

        # Store assistant message (must flush first to get ID for FK)
        assistant_msg = AIConversationMessage(
            conversation_id=conv.id,
            message_uid=_uid(),
            sender_type=SenderType.ASSISTANT,
            message_text=result["answer"],
            mode=result.get("mode", "M0_EXPLAIN"),
            risk_class=RiskClass(result.get("risk_class", "R0")),
            contains_financial_data=result.get("risk_class", "R0") in ("R1", "R2", "R3", "R4"),
            structured_payload={
                "evidence": result.get("evidence", []),
                "next_actions": result.get("next_actions", []),
                "qualification": result.get("qualification"),
                "suggested_prompts": result.get("suggested_prompts", []),
                # Pending disambiguation state: lets the NEXT user message be
                # matched against the options just offered (loop prevention).
                "clarify": result.get("clarify_state"),
            },
        )
        self.db.add(assistant_msg)
        self.db.flush()

        # Record intent classification (after flush so message_id FK is valid)
        ic = IntentClassification(
            message_id=assistant_msg.id,
            intent_code=intent["intent"],
            intent_domain=intent["domain"],
            confidence=intent.get("confidence", 0.9),
            risk_class=RiskClass(intent.get("risk_class", "R0")),
            classified_by=intent.get("classified_by", IntentClassifiedBy.RULES),
        )
        self.db.add(ic)

        self._audit(AuditEventType.INTENT_CLASSIFIED, conv, ctx, {
            "intent": intent["intent"],
            "domain": intent["domain"],
            "risk_class": result.get("risk_class", "R0"),
        })

        return {
            "message_uid": assistant_msg.message_uid,
            "answer": result["answer"],
            "mode": result.get("mode", "M0_EXPLAIN"),
            "risk_class": result.get("risk_class", "R0"),
            "evidence": result.get("evidence", []),
            "next_actions": result.get("next_actions", []),
            "qualification": result.get("qualification"),
            "suggested_prompts": result.get("suggested_prompts", []),
        }

    # ── Intent Classification ──────────────────────────────────────────

    def _classify_intent(self, conv: AIConversation, text: str, ctx: AIContext, context: dict | None = None, page_path: str | None = None) -> dict:
        """Classify intent using model gateway with rules-based fallback."""
        if context is None:
            context = self._load_conversation_context(conv, ctx, current_text=text)
        gateway_available = self._gateway is not None
        # Try model-based classification if gateway available
        model_result = None
        if self._gateway:
            try:
                model_result = self._model_classify_intent(conv, text, ctx)
                print(f"[INTENT-DBG] input={text!r} gateway=YES model_result={model_result['domain']}/{model_result['intent']} confidence={model_result.get('confidence')}")
            except ModelGatewayError:
                logger.warning("Model-based intent classification failed, falling back to rules")

        # Always compute rules-based result for cross-checking
        rules_result = self._rules_classify_intent(text, context, page_path=page_path)
        print(f"[INTENT-DBG] input={text!r} gateway={'YES(gateway_exists_but_failed)' if gateway_available else 'NO'} rules_result={rules_result['domain']}/{rules_result['intent']} confidence={rules_result.get('confidence')}")

        # If model classified as non-action but rules detected an action intent,
        # override with rules result — model classifiers frequently miss short
        # invoice-creation commands (especially when input contains quote marks).
        if model_result and rules_result.get("intent") == "action_draft" and model_result.get("intent") != "action_draft":
            print(f"[INTENT-DBG] OVERRIDING model {model_result['domain']}/{model_result['intent']} -> rules action_draft")
            return rules_result

        # If model classified as help/general but rules detected a specific
        # billing lookup, dashboard, action, or reconciliation query, prefer the
        # rules result. This is the T05 guardrail: financial questions MUST be
        # answered from live authoritative queries, never from RAG knowledge
        # snippets (which may contain stale or unrelated figures).
        authoritative_domains = ("billing", "dashboard", "action", "reconciliation")
        if model_result and rules_result.get("domain") in authoritative_domains and model_result.get("domain") == "help":
            print(f"[INTENT-DBG] OVERRIDING model help -> rules {rules_result['domain']}")
            return rules_result

        # Also override when the model returns a non-action domain for a
        # rules-detected action intent (quote-heavy input frequently confuses
        # the model classifier).
        if model_result and rules_result.get("domain") == "action" and model_result.get("domain") != "action":
            print(f"[INTENT-DBG] OVERRIDING model {model_result['domain']}/{model_result['intent']} -> rules action")
            return rules_result

        # If the model is confident about a domain but the rules detected a
        # *more specific* intent within the same billing family (e.g. a count,
        # list, or status question), prefer the specific rules intent so the
        # right handler runs.
        if model_result and rules_result.get("domain") == "billing" and model_result.get("domain") == "billing":
            if rules_result.get("intent") not in ("general_billing_lookup", "help_general"):
                if rules_result.get("confidence", 0) >= (model_result.get("confidence", 0) - 0.1):
                    print(f"[INTENT-DBG] OVERRIDING model {model_result['domain']}/{model_result['intent']} -> rules {rules_result['domain']}/{rules_result['intent']}")
                    return rules_result

        # ── D-11 Safe uncertainty ladder ─────────────────────────────────
        # 1) A SPECIFIC rules match (not a fallback catch-all, confidence at
        #    or above SPECIFIC_INTENT_CONFIDENCE) always wins over a generic
        #    or disagreeing model classification. This is what stops
        #    "How many customers are there?" from being answered with
        #    unrelated credit-note/audit content when the model misfires.
        rules_is_specific = (
            rules_result.get("intent") not in FALLBACK_INTENTS
            and rules_result.get("confidence", 0) >= SPECIFIC_INTENT_CONFIDENCE
        )
        if rules_is_specific:
            if model_result and model_result.get("domain") != rules_result.get("domain"):
                print(
                    f"[INTENT-DBG] D-11 specific-rules-wins: model {model_result['domain']}/{model_result['intent']} "
                    f"({model_result.get('confidence')}) overridden by rules "
                    f"{rules_result['domain']}/{rules_result['intent']} ({rules_result.get('confidence')})"
                )
            return rules_result

        # 2) Both sources produced only fallback-level results and they point
        #    at different domains with no confident winner → ask, don't guess.
        if model_result and rules_result.get("intent") in FALLBACK_INTENTS \
                and model_result.get("domain") != rules_result.get("domain"):
            model_conf = float(model_result.get("confidence", 0) or 0)
            rules_conf = float(rules_result.get("confidence", 0) or 0)
            best = model_result if model_conf >= rules_conf else rules_result
            other = rules_result if best is model_result else model_result
            if float(best.get("confidence", 0) or 0) >= MODEL_SPECIFIC_CONFIDENCE and \
                    other.get("intent") in FALLBACK_INTENTS:
                return best
            return self._clarify_intent(model_result, rules_result)

        # 3) Model-only path: accept it only above the clarify bar.
        if model_result:
            if float(model_result.get("confidence", 0) or 0) >= CLARIFY_CONFIDENCE:
                return model_result
            return self._clarify_intent(model_result, None)

        # 4) Rules-only path: same bar.
        if float(rules_result.get("confidence", 0) or 0) >= CLARIFY_CONFIDENCE:
            return rules_result
        # Fallback catch-alls (ambiguous_count, ambiguous_general, …) already
        # ask a specific narrowing question in their own handlers ("Which
        # would you like me to count — customers, invoices, …?"). Keep them
        # rather than re-wrapping in the generic clarify response.
        if rules_result.get("intent") in FALLBACK_INTENTS:
            return rules_result
        return self._clarify_intent(None, rules_result)

    def _clarify_intent(self, model_result: dict | None, rules_result: dict | None) -> dict:
        """Build a D-11 clarification result listing the candidate intents so
        the handler can ASK the user which one they meant — never guess."""
        options: list[str] = []
        for cand in (rules_result, model_result):
            if not cand:
                continue
            label = DOMAIN_LABELS.get(
                cand.get("domain"),
                f"{cand.get('domain', 'billing')} · {cand.get('intent', 'lookup')}",
            )
            if label not in options:
                options.append(label)
        if not options:
            options = ["Billing records (invoices, payments, customers)", "Product guidance (how things work)"]
        return {
            "intent": "clarify",
            "domain": "clarify",
            "risk_class": "R0",
            "confidence": max(
                float((model_result or {}).get("confidence", 0) or 0),
                float((rules_result or {}).get("confidence", 0) or 0),
            ),
            "classified_by": IntentClassifiedBy.RULES,
            "options": options,
        }

    def _model_classify_intent(self, conv: AIConversation, text: str, ctx: AIContext) -> dict:
        """Use model to classify intent into domain."""
        config = get_model_config("intent_classification")

        system_prompt = (
            "Classify the user's billing question into exactly one domain. "
            "Respond with JSON: {\"domain\": \"<domain>\", \"intent\": \"<intent>\", \"confidence\": <0.0-1.0>}\n"
            "Valid domains: billing, help, dashboard, action, reconciliation, out_of_scope\n"
            "Examples:\n"
            "- 'Show overdue invoices' -> {\"domain\": \"billing\", \"intent\": \"invoice_list\", \"confidence\": 0.95}\n"
            "- 'Who are our customers?' -> {\"domain\": \"billing\", \"intent\": \"customer_list\", \"confidence\": 0.95}\n"
            "- 'Which customers owe us money?' -> {\"domain\": \"billing\", \"intent\": \"customer_outstanding\", \"confidence\": 0.9}\n"
            "- 'Show customer GOk' -> {\"domain\": \"billing\", \"intent\": \"customer_search\", \"confidence\": 0.95}\n"
            "- 'How many invoices are there?' -> {\"domain\": \"billing\", \"intent\": \"invoice_count\", \"confidence\": 0.95}\n"
            "- 'How many payments?' -> {\"domain\": \"billing\", \"intent\": \"payment_count\", \"confidence\": 0.95}\n"
            "- 'List subscriptions' -> {\"domain\": \"billing\", \"intent\": \"subscription_list\", \"confidence\": 0.95}\n"
            "- 'What contracts do we have?' -> {\"domain\": \"billing\", \"intent\": \"contract_list\", \"confidence\": 0.9}\n"
            "- 'Show the product catalog' -> {\"domain\": \"billing\", \"intent\": \"product_list\", \"confidence\": 0.9}\n"
            "- 'Show payments made by Gok' -> {\"domain\": \"billing\", \"intent\": \"payment_list\", \"confidence\": 0.9}\n"
            "- 'What is INV-2024-0001?' -> {\"domain\": \"billing\", \"intent\": \"invoice_search\", \"confidence\": 0.95}\n"
            "- 'Show me Gok's outstanding balance' -> {\"domain\": \"billing\", \"intent\": \"account_balance\", \"confidence\": 0.9}\n"
            "- 'What does paid mean?' -> {\"domain\": \"billing\", \"intent\": \"general_billing_lookup\", \"confidence\": 0.9}\n"
            "- 'How do refunds work?' -> {\"domain\": \"help\", \"intent\": \"help_general\", \"confidence\": 0.9}\n"
            "- 'Dashboard summary' -> {\"domain\": \"dashboard\", \"intent\": \"dashboard_summary\", \"confidence\": 0.95}\n"
            "- 'Preview action abc-123' -> {\"domain\": \"action\", \"intent\": \"action_preview\", \"confidence\": 0.95}\n"
            "- 'Create an invoice for Acme' -> {\"domain\": \"action\", \"intent\": \"action_draft\", \"confidence\": 0.9}\n"
            "- 'Confirm and execute action abc-123' -> {\"domain\": \"action\", \"intent\": \"action_confirm_execute\", \"confidence\": 0.95}\n"
            "- 'Do I have any unmatched payments?' -> {\"domain\": \"reconciliation\", \"intent\": \"help_reconciliation\", \"confidence\": 0.9}\n"
            "- 'Show unallocated payments' -> {\"domain\": \"reconciliation\", \"intent\": \"help_reconciliation\", \"confidence\": 0.9}\n"
            "- 'Total Revenue' -> {\"domain\": \"dashboard\", \"intent\": \"metric_revenue\", \"confidence\": 0.95}\n"
            "- 'How much revenue do we have?' -> {\"domain\": \"dashboard\", \"intent\": \"metric_revenue\", \"confidence\": 0.95}\n"
            "- 'product Dashboard' -> {\"domain\": \"billing\", \"intent\": \"product_dashboard\", \"confidence\": 0.9}\n"
            "- 'What are the valid invoice statuses?' -> {\"domain\": \"help\", \"intent\": \"explain_statuses\", \"confidence\": 0.95}\n"
            "- 'How many customers are there?' -> {\"domain\": \"billing\", \"intent\": \"customer_count\", \"confidence\": 0.95}\n"
            "- 'Change the due date to net 30.' -> {\"domain\": \"action\", \"intent\": \"action_draft\", \"confidence\": 0.9}\n"
            "- 'Customer was overcharged.' -> {\"domain\": \"action\", \"intent\": \"correct_request\", \"confidence\": 0.9}\n"
            "- 'Remind them this is overdue.' -> {\"domain\": \"action\", \"intent\": \"communicate_request\", \"confidence\": 0.9}\n"
            "- 'Export unpaid invoices for Europe.' -> {\"domain\": \"action\", \"intent\": \"export_request\", \"confidence\": 0.9}\n"
            "- 'Match this $5,000 payment.' -> {\"domain\": \"reconciliation\", \"intent\": \"help_reconciliation\", \"confidence\": 0.9}\n"
            "- 'What is payroll?' -> {\"domain\": \"out_of_scope\", \"intent\": \"out_of_scope\", \"confidence\": 0.9}\n"
            "- 'Explain me about python.' -> {\"domain\": \"out_of_scope\", \"intent\": \"out_of_scope\", \"confidence\": 0.95}\n"
        )

        model_run_uid = _uid()
        model_run = ModelRun(
            model_run_uid=model_run_uid,
            conversation_id=conv.id,
            tenant_context_id=ctx.tenant_context_id,
            run_type=ModelRunType.CLASSIFY,
            provider="anthropic",
            model_name=config.model,
            input_hash=_hash(text),
        )
        self.db.add(model_run)
        self.db.flush()

        response = self._gateway.complete(
            messages=[ModelMessage(role="user", content=text[:1000])],
            system_prompt=system_prompt,
            model=config.model,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
        )

        model_run.output_hash = response.content_hash()
        model_run.latency_ms = response.usage.get("latency_ms", 0)

        # Parse JSON response
        try:
            parsed = json.loads(response.content)
            domain = parsed.get("domain", "billing")
            intent_code = parsed.get("intent", "general_lookup")
            confidence = parsed.get("confidence", 0.8)
        except (json.JSONDecodeError, KeyError):
            domain = "billing"
            intent_code = "general_lookup"
            confidence = 0.5

        return {
            "intent": intent_code,
            "domain": domain,
            "risk_class": "R2" if domain == "action" else ("R1" if domain in ("billing", "dashboard") else "R0"),
            "confidence": confidence,
            "classified_by": IntentClassifiedBy.MODEL,
        }

    def _rules_classify_intent(self, text: str, context: dict | None = None, page_path: str | None = None) -> dict:
        """Rules-based intent classification (fallback).

        Understands natural-language variation per the Zoiko Billing Assistant
        NLU doctrine: synonyms, singular/plural, word order, follow-up
        references and pronouns. Financial questions ALWAYS route to a live
        data handler (billing/dashboard) — never to RAG knowledge snippets.
        """
        context = context or {}
        normalized = text.strip().strip('""''').lower()
        # Tokenization-drift repair: "dash board" → "dashboard", "creditnote"
        # → "credit note", so every keyword check below sees canonical terms.
        normalized = normalize_domain_text(normalized)
        last_entity = context.get("last_entity")

        # ── FIX #4: Out-of-scope topics (explicit refusal) ────────────
        out_of_scope_keywords = (
            "payroll", "salary", "hr ", "human resources",
            "inventory", "stock", "warehouse",
            "marketing", "seo", "advertising",
            "crm", "customer relationship",
            "project management", "task management",
            "time tracking", "timesheet",
            "travel", "expense report",
        )
        if any(kw in normalized for kw in out_of_scope_keywords):
            return {"intent": "out_of_scope", "domain": "out_of_scope", "risk_class": "R0", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # ── §6.0 Topic screening: OUT_OF_DOMAIN early gate ──────────────
        # Informational question about a substantive subject with NO billing
        # domain evidence → refuse before classification/RAG/handlers.
        # (Placed AFTER the explicit blocklist so known off-domain topics
        # keep their exact refusal behavior.)
        if _GATE_SHAPE_RE.search(normalized) and not topic_screen(normalized):
            if _gate_substantive_tokens(normalized):
                logger.info("topic_screen: OUT_OF_DOMAIN short-circuit (early gate): %r", text)
                return {"intent": "out_of_scope", "domain": "out_of_scope", "risk_class": "R0", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # ── Definitional sentence-shape guard ────────────────────────────
        # Explanation requests route to the knowledge/EXPLAIN path no matter
        # how many entity nouns follow the verb. Entity-noun count must
        # never override sentence-shape classification: the entity rules
        # below would otherwise turn "Explain how invoices and payments
        # work" into a live invoice list (Inspect/R1) because "invoices"
        # appears in the subject.
        # Defers to the SPECIFIC metric-definition rule: "What does Revenue
        # mean?" gets the dedicated metric handler, not generic RAG.
        if _DEFINITIONAL_SHAPE_RE.search(normalized) \
                and not self._match_definitional_metric(normalized):
            return {"intent": "help_general", "domain": "help", "risk_class": "R0", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # ── FIX #1a: Action preview intent ("Preview action {uid}") ─────
        if re.match(r'^preview\s+action\s+\S+', normalized):
            return {"intent": "action_preview", "domain": "action", "risk_class": "R2", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # ── FIX #1c: Action confirm+execute intent ("Confirm and execute action {uid}") ──
        if re.match(r'^(?:confirm|execute|run|finalize)\s+.*action\s+\S+', normalized):
            return {"intent": "action_confirm_execute", "domain": "action", "risk_class": "R2", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # ── PRD §09 families previously mis-bucketed ─────────────────────
        # (These outrank the generic verb+object action match below, so e.g.
        # "Send a follow-up about the invoice" is communication, not drafting.)
        # Modify draft: "Change the due date to net 30."
        if re.search(r"^(change|update|edit|modify|set|extend)\b", normalized) and \
                re.search(r"\b(due date|date|amount|price|quantity|discount|tax|item|line|terms?)\b", normalized):
            return {"intent": "action_draft", "domain": "action", "risk_class": "R2", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # Correct: "Customer was overcharged." / "We charged them twice." —
        # never silently answered with unrelated content; routes to the
        # guided correction flow.
        if re.search(r"\b(overcharg|double[\s-]?charg|wrongly charged|billing error|incorrect (?:charge|invoice|amount)|wrong amount)\w*", normalized) or \
                ("charg" in normalized and "twice" in normalized):
            return {"intent": "correct_request", "domain": "action", "risk_class": "R2", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # Communicate: "Remind them this is overdue." / "Send a follow-up…"
        if re.search(r"\b(remind|reminder|follow[\s-]?up|notify|nudge)\b", normalized):
            return {"intent": "communicate_request", "domain": "action", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # Export: "Export unpaid invoices for Europe." — scope preview first;
        # must precede invoice/payment list patterns which would otherwise
        # silently ignore the requested scope.
        if re.search(r"\b(export|download|as csv|csv file|excel|xlsx)\b", normalized):
            return {"intent": "export_request", "domain": "action", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # ── FIX #1b: Action intent (draft/create/issue + billing object) ──
        action_verbs = ("draft", "create", "issue", "prepare", "send", "raise", "generate", "new", "make", "set up", "setup", "refund")
        action_objects = ("invoice", "payment", "credit note", "credit", "refund", "credit note")
        is_action_verb = any(normalized.startswith(v) or f" {v} " in normalized for v in action_verbs)
        is_action_object = any(o in normalized for o in action_objects)
        if is_action_verb and is_action_object:
            return {"intent": "action_draft", "domain": "action", "risk_class": "R2", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # ── FIX #5: Reconciliation intent ──────────────────────────────
        reconciliation_keywords = (
            "unmatched", "unallocated", "reconcil", "matching", "bank match",
            "payment match", "allocat", "discrepanc", "variance", "bank statement",
        )
        if any(kw in normalized for kw in reconciliation_keywords) or re.search(r"\bmatch(?:es|ing)?\b", normalized):
            return {"intent": "help_reconciliation", "domain": "reconciliation", "risk_class": "R0", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # ── D-11: Entity-qualified dashboard/page phrases ────────────────
        # "product dashboard", "products overview", "customer dashboard" …
        # must NEVER silently return the generic billing dashboard summary.
        m_qual = re.search(
            r"\b([a-z]+)\s+(?:dashboard|overview|home\s+page)\b", normalized
        ) or re.search(r"\b(?:dashboard|overview)\s+(?:for|of)\s+([a-z]+)\b", normalized)
        if m_qual:
            qualifier = m_qual.group(1)
            if qualifier.rstrip("s") == "product":
                return {"intent": "product_dashboard", "domain": "billing", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}
            if qualifier not in ("billing", "financial", "finance", "my", "our", "the", "org", "organization"):
                singular = qualifier.rstrip("s")
                route = DASHBOARD_QUALIFIER_ROUTES.get(singular)
                # Page-context biasing: the user is already ON that surface's
                # page (e.g. /billing/customers/dashboard) — resolve instead
                # of asking what "dashboard" means.
                if route and page_path and f"/{singular}" in str(page_path).lower():
                    return {**route, "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}
                # Ambiguous which surface the user means (e.g. "team dashboard")
                # → per D-11, ask instead of guessing. Options carry machine-
                # actionable routes so the reply can be matched against them.
                options = [
                    {
                        "label": "Your billing dashboard (financial summary)",
                        "primary": ["billing", "financial", "finance"],
                        "keywords": list(CLARIFY_KEYWORDS["dashboard"]),
                        "route": {"intent": "dashboard_summary", "domain": "dashboard"},
                    },
                    {
                        "label": f"The {qualifier} view (I can show {qualifier} records)",
                        "primary": [qualifier],
                        "keywords": [qualifier] + list(CLARIFY_KEYWORDS.get(singular, ())),
                        "route": route or {"intent": "help_general", "domain": "help"},
                    },
                ]
                return {
                    "intent": "clarify_dashboard_scope",
                    "domain": "clarify",
                    "risk_class": "R0",
                    "confidence": 0.85,
                    "classified_by": IntentClassifiedBy.RULES,
                    "options": [o["label"] for o in options],
                    "clarify_state": {
                        "kind": "dashboard_scope",
                        "qualifier": qualifier,
                        "asked_count": 1,
                        "options": options,
                    },
                }

        # ── COUNT INTENTS (must precede list/lookup detection) ──────────
        # Generic follow-up counts: "how many are there?", "count them" —
        # resolve the entity from conversation context when possible.
        generic_count = re.search(
            r"(?:how many (?:are|is|do|did|were) (?:there|their|we|you|i)?|"
            r"how many (?:do|did) we|"
            r"what.?s? the (?:count|number|total)|"
            r"count (?:them|those|these|it)|"
            r"total (?:count|number))",
            normalized,
        )
        if generic_count and not self._entity_from_text(normalized):
            if last_entity:
                intent_code, domain = self._count_intent_for_entity(last_entity)
                return {"intent": intent_code, "domain": domain, "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}
            return {"intent": "ambiguous_count", "domain": "billing", "risk_class": "R0", "confidence": 0.6, "classified_by": IntentClassifiedBy.RULES}

        # "How many customers are there?" / "customer count" / "count customers"
        customer_count_keywords = (
            "how many customers", "how many customer accounts", "number of customers",
            "customer count", "total customers", "total number of customers",
            "count of customers",
            "count customers", "count the customers", "count all customers",
            "how many clients", "how many client accounts", "number of clients",
            "client count", "total clients", "how many accounts",
            "number of customer accounts", "number of customer records",
            "how many customer records", "how many customer profiles",
"give me the customer total", "what is our customer total",
            "what is the number of customers", "tell me the number of customers",
            "tell me how many customers", "can you count the customers",
            "are there any customers", "do we have customers", "are there customers",
            "how many users do we have",
        )
        if any(kw in normalized for kw in customer_count_keywords):
            return {"intent": "customer_count", "domain": "dashboard", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # "How many invoices?" / "invoice count" / "how many bills are pending"
        invoice_count_keywords = (
            "how many invoice", "number of invoices", "invoice count", "total invoices",
            "count invoices", "count the invoices", "count all invoices",
            "how many bills", "number of bills", "bill count", "total bills",
            "how many unpaid invoices", "how many unpaid bills",
            "how many pending invoices", "how many pending bills",
            "how many overdue invoices", "how many overdue bills",
        )
        if any(kw in normalized for kw in invoice_count_keywords):
            return {"intent": "invoice_count", "domain": "billing", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # "How many payments?" / "payment count"
        payment_count_keywords = (
            "how many payment", "number of payments", "payment count", "total payments",
            "count payments", "count the payments", "how many transactions",
            "number of transactions", "payment total",
        )
        if any(kw in normalized for kw in payment_count_keywords):
            return {"intent": "payment_count", "domain": "billing", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # "How many subscriptions are active?" / "subscription count"
        subscription_count_keywords = (
            "how many subscription", "number of subscriptions", "subscription count",
            "total subscriptions", "count subscriptions", "count the subscriptions",
            "how many active subscriptions", "how many subscribers",
            "number of subscribers", "subscriber count",
        )
        if any(kw in normalized for kw in subscription_count_keywords):
            return {"intent": "subscription_count", "domain": "billing", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # "How many contracts?" / "contract count"
        contract_count_keywords = (
            "how many contract", "number of contracts", "contract count",
            "total contracts", "count contracts", "count the contracts",
            "how many agreements", "number of agreements", "agreement count",
            "active contract count",
        )
        if any(kw in normalized for kw in contract_count_keywords):
            return {"intent": "contract_count", "domain": "billing", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # "How many products?" / "product count" / catalog count
        product_count_keywords = (
            "how many product", "number of products", "product count",
            "total products", "count products", "count the products",
            "how many items", "number of items",
            "how many in the catalog", "how many in the catalogue",
        )
        if any(kw in normalized for kw in product_count_keywords):
            return {"intent": "product_count", "domain": "billing", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # ── CUSTOMER OUTSTANDING (customers who owe money) ───────────────
        # Must precede the generic balance check so "show customers with
        # outstanding balances" lists customers — never the org aggregate.
        has_customer_entity = re.search(r"\b(customer|customers|client|clients)\b", normalized) is not None
        customer_outstanding_keywords = (
            "customers who owe", "customers that owe", "customers who owe us",
            "customers with outstanding", "customers with dues", "customers with dues",
            "outstanding customers", "which customers owe", "which customers have",
            "what customers owe", "who owes us", "who owe us", "customer dues",
            "customers have outstanding", "customers with unpaid", "customers owe money",
            "customers who have dues", "clients who owe", "clients with outstanding",
            "which clients owe", "outstanding clients", "who owes us money",
            "which customers have outstanding", "which customers have dues",
            "who are the customers with outstanding", "customers have dues",
        )
        if any(kw in normalized for kw in customer_outstanding_keywords) or (
            has_customer_entity and re.search(r"\b(owe|owes|owed|due|dues|outstanding|unpaid|pending amount)\b", normalized)
            and not re.search(r"\bcount|how many|number of\b", normalized)
        ):
            return {"intent": "customer_outstanding", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # ── CUSTOMER LIST ───────────────────────────────────────────────
        # "list customers", "show all customers", "who are our customers?",
        # "which customers do we have", "give me the customer list", etc.
        customer_list_patterns = (
            "list customers", "list client", "list all customers", "list out customers",
            "list customer accounts", "list of customers", "list of clients",
            "list of my customers", "list of all customers", "list of customer accounts",
            "show customers", "show all customers", "show me customers",
            "show me my customers", "show my customers", "show me all customers",
            "show customer accounts", "display customers", "display all customers",
            "display customer accounts", "give me customers", "give me the customer list",
            "give me a list of customers", "give me customer names", "give me a customer list",
            "give me the customers", "show me the customer list", "show me the customers",
            "show me a list of customers", "customer list", "customers list",
            "all customers", "all clients", "all my customers", "all my clients",
            "fetch customers", "fetch all customers", "get customers", "get all customers",
            "get the customer list", "retrieve customers", "pull up customers",
            "bring up customers", "see customers", "see all customers",
            "view customers", "view all customers", "enumerate customers",
            "who are the customers", "who are our customers", "who are customers",
            "who are my customers", "who are all customers", "who are the clients",
            "who are our clients", "who is our customers", "who do we have as customers",
            "who are our customer accounts", "who are the customer accounts",
            "which customers do we have", "which customers are there",
            "what customers do we have", "what customers are there",
            "which clients do we have", "what clients do we have",
            "tell me our customers", "tell me the customers", "tell me about our customers",
            "can you tell me our customers", "can you show customers", "can you list customers",
            "i want to see customers", "i want to see all customers",
            "i need a list of customers", "customers please", "customers, please",
            "show me customer accounts", "display customer accounts",
        )
        if any(p in normalized for p in customer_list_patterns):
            return {"intent": "customer_list", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # Plural customer nouns without other intent → list (e.g. "customers?",
        # "clients?" as bare requests, "show me the customers")
        if re.search(r"\b(customers|clients)\b", normalized) and not re.search(r"\b(count|how many|details?|info|information|profile)\b", normalized):
            return {"intent": "customer_list", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # ── CUSTOMER SEARCH / DETAILS ───────────────────────────────────
        # "find Gok", "do we have a customer named Gok", "look up Gok",
        # "customer details for Gok", "what do you know about Gok"
        customer_details_keywords = (
            "customer details", "client details", "customer info", "client info",
            "customer information", "client information", "customer profile",
            "client profile", "customer record", "client record",
            "customer account details", "details of the customer", "details of customer",
            "details about the customer", "details on the customer", "about this customer",
            "about that customer", "about the customer", "customer overview",
            "describe the customer", "tell me about this customer",
            "tell me about the customer", "customer lookup",
        )
        if any(kw in normalized for kw in customer_details_keywords):
            return {"intent": "customer_details", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        if re.search(r"\b(customer|client)\b", normalized) and any(kw in normalized for kw in ("details", "info", "information", "profile", "record", "lookup", "about")):
            return {"intent": "customer_details", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # "show Gok details" / "get Gok's details" / "what are Gok's details"
        # (only when the target is a name, not another entity like 'invoice')
        if re.search(r"(?:details|info|information|profile|record)\s+(?:for|of|on|about)\s+\S+", normalized) or \
           re.search(r"\S+\s*'s\s+(?:details|info|information|profile)", normalized) or \
           re.search(r"what (?:are|is|do you know about)\s+\S+\s+(?:details|info|information)", normalized):
            return {"intent": "customer_details", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # "show me GOk details" — name first, then details word (no apostrophe)
        m_details = re.search(r"\b(?:show|get|give|display|open|view|see|look up)\s+(?:me\s+)?(\S+)\s+(?:details|info|information|profile|record)\b", normalized)
        if m_details and not self._entity_from_text(m_details.group(1)):
            return {"intent": "customer_details", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # "find Gok", "show me Gok", "do we have a customer named Gok" —
        # only when the target is a name (never 'show me the invoices').
        if not self._entity_from_text(normalized) or re.search(r"\b(customer|client)\b", normalized):
            m_search = re.search(
                r"\b(find|search for|search|look for|look up|lookup|locate|get|show me|show|view|check|pull up|bring up|open)\s+"
                r"(?:a|an|the|my|our)?\s*(?:customer|client)?\s*(?:named|called\s+)?([A-Za-z][\w@.' -]*?)\s*$",
                normalized,
            )
            if m_search and not self._entity_from_text(m_search.group(2)) \
                    and m_search.group(2).split()[0].lower() not in ("everything", "all", "it", "this", "that", "them", "me", "us", "your", "my", "our", "his", "her", "their", "its") \
                    and not self._looks_like_domain_term(m_search.group(2).split()[0].lower()) \
                    and not re.search(r"\b(guardrail|specification|spec|policy|policies|documentation|architecture|schema|frs|prd|wireframe)\b", normalized):
                return {"intent": "customer_search", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # "find a customer", "look for a customer", "search for a customer"
        # (no name yet — the handler will ask which customer)
        if re.search(r"\b(find|look for|search for|locate|look up|lookup)\s+(?:a|an|the|any)?\s*(?:customer|client)\b", normalized):
            return {"intent": "customer_search", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        if re.search(r"\b(do we have|is there|are there|have we got)\s+(?:a|an|any)?\s*(?:customer|client)\b", normalized):
            return {"intent": "customer_search", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        if re.search(r"\b(customer|client)\s+(?:named|called)\s+\S+", normalized) or \
           re.search(r"\bwhat do you know about\s+\S+", normalized):
            return {"intent": "customer_search", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # ── INVOICE LIST / SEARCH ───────────────────────────────────────
        invoice_list_patterns = (
            "list invoices", "list all invoices", "list the invoices", "list out invoices",
            "show invoices", "show all invoices", "show me invoices", "show me the invoices",
            "display invoices", "display all invoices", "get invoices", "view invoices",
            "see invoices", "my invoices", "all invoices", "invoices list",
            "unpaid invoices", "pending invoices", "overdue invoices", "past due invoices",
            "open invoices", "outstanding invoices", "unpaid bills", "pending bills",
            "overdue bills", "bills that haven't been paid", "bills that have not been paid",
            "bills that are unpaid", "bills that are pending", "which invoices are overdue",
            "which invoices are unpaid", "which invoices are pending", "which bills are overdue",
            "which bills are unpaid", "which bills are pending", "show me the bills",
            "show bills", "list bills", "what invoices", "what bills do we have",
            "show the invoices", "display the invoices", "fetch invoices",
            "give me the invoices", "give me invoices",
        )
        if any(p in normalized for p in invoice_list_patterns):
            return {"intent": "invoice_list", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        if re.search(r"\binvoices\b", normalized) and not re.search(r"\b(count|how many|details?|info|information)\b", normalized):
            return {"intent": "invoice_list", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # Invoice by reference: "find INV-1001", "is INV-1001 paid?"
        invoice_ref = self._extract_reference(text, prefixes=("INV", "INVOICE"))
        if invoice_ref:
            return {"intent": "invoice_search", "domain": "billing", "risk_class": "R1", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # ── PAYMENT LIST / SEARCH ───────────────────────────────────────
        payment_list_patterns = (
            "list payments", "list all payments", "show payments", "show all payments",
            "show me payments", "show me the payments", "display payments",
            "get payments", "view payments", "see payments", "all payments",
            "my payments", "payments list", "unpaid payments", "pending payments",
            "unallocated payments", "waiting to be processed",
            "are there any payments", "show the payments", "list transactions",
            "show transactions", "show me transactions", "list the payments",
            "payments made by", "payment made by", "payments received from",
            "payment received from", "payments from", "payments by",
            "payments for", "payment from", "payment by",
        )
        if any(p in normalized for p in payment_list_patterns):
            return {"intent": "payment_list", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        payment_ref = self._extract_reference(text, prefixes=("PAY", "PMT", "PAYMENT"))
        if payment_ref:
            return {"intent": "payment_search", "domain": "billing", "risk_class": "R1", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # ── SUBSCRIPTION LIST / SEARCH ──────────────────────────────────
        subscription_list_patterns = (
            "list subscriptions", "list all subscriptions", "show subscriptions",
            "show all subscriptions", "show me subscriptions", "display subscriptions",
            "get subscriptions", "view subscriptions", "all subscriptions",
            "subscriptions list", "active subscriptions", "inactive subscriptions",
            "show active subscriptions", "which subscriptions are active",
            "which subscriptions are inactive", "list active subscriptions",
            "show the subscriptions", "my subscriptions",
        )
        if any(p in normalized for p in subscription_list_patterns):
            return {"intent": "subscription_list", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # Bare plural — mirrors the invoices/customers precedent: a lone
        # "subscriptions" mention is a list request, not a knowledge question.
        if re.search(r"\bsubscriptions\b", normalized) and not re.search(r"\b(count|how many|details?|info|information)\b", normalized):
            return {"intent": "subscription_list", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # ── CONTRACT LIST / SEARCH ──────────────────────────────────────
        contract_list_patterns = (
            "list contracts", "list all contracts", "show contracts", "show all contracts",
            "show me contracts", "display contracts", "get contracts", "view contracts",
            "all contracts", "contracts list", "active contracts", "expired contracts",
            "show active contracts", "which contracts are active", "list active contracts",
            "show the contracts", "my contracts", "list agreements", "show agreements",
            "what contracts do we have", "which contracts do we have",
            "what agreements do we have", "which agreements do we have",
        )
        if any(p in normalized for p in contract_list_patterns):
            return {"intent": "contract_list", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # ── PRODUCT LIST / SEARCH ───────────────────────────────────────
        product_list_patterns = (
            "list products", "list all products", "show products", "show all products",
            "show me products", "display products", "get products", "view products",
            "all products", "products list", "show the catalog", "show the catalogue",
            "show catalog", "show catalogue", "list catalog", "list catalogue",
            "product catalog", "product catalogue", "catalog list", "catalogue list",
            "show me the catalog", "show me the catalogue", "what products do we have",
            "which products do we have", "available products", "list items",
            "show items", "product list", "our products", "products please",
        )
        if any(p in normalized for p in product_list_patterns):
            return {"intent": "product_list", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # ── Definitional questions about financial metrics ───────────────
        # "Explain me about Revenue" / "What is Outstanding?" ask WHAT the
        # metric means. Intercept BEFORE the entity/metric keyword rules so
        # the answer is definition-first (composed with the live figure in
        # _handle_help) — never a bare-number hijack and never an abstention.
        # Non-metric subjects (documents, statuses, possessives) fall through
        # to their existing rules unchanged.
        metric_code = self._match_definitional_metric(normalized)
        if metric_code:
            return {"intent": "metric_definition", "domain": "help", "risk_class": "R0", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES, "metric": metric_code}

        # ── FIX #4: Single-metric revenue queries ────────────────────────
        # "Total Revenue" / "How much revenue?" must return ONLY the figure,
        # not the full dashboard dump. Checked BEFORE balance keywords
        # ("how much revenue" contains "how much") and before the generic
        # dashboard keyword list.
        revenue_terms = ("revenue", "income", "earnings", "top line", "topline", "sales figure")
        summary_terms = (
            "summary", "overview", "report", "breakdown", "dashboard",
            "everything", "full", "detail", "kpi", "metric", "trend",
            "history", "by month", "monthly report", "how are we doing",
        )
        if any(t in normalized for t in revenue_terms) and not any(s in normalized for s in summary_terms):
            return {"intent": "metric_revenue", "domain": "dashboard", "risk_class": "R1", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # ── Protected: invoice status vocabulary question ─────────────────
        # "What are the valid invoice statuses?" is a deterministic help
        # answer — never let a model hijack route it to audit logs.
        if re.search(r"\b(valid|possible|allowed|available|supported|all)\s+(invoice\s+)?statuses\b", normalized) or \
                (re.search(r"\bstatuses\b", normalized) and re.search(r"\b(what|which|list|name|tell|explain|are)\b", normalized)):
            return {"intent": "explain_statuses", "domain": "help", "risk_class": "R0", "confidence": 0.9, "classified_by": IntentClassifiedBy.RULES}

        # ── FIX #2: Balance / financial summary queries (M1 Inspect) ─────
        balance_keywords = ("balance", "how much", "owe", "owed", "total due", "amount due", "what do i owe", "what do we owe", "outstanding amount", "unpaid amount", "amount outstanding", "money owed", "pending amount")
        if any(kw in normalized for kw in balance_keywords):
            return {"intent": "account_balance", "domain": "billing", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # ── Context fallbacks ───────────────────────────────────────────
        # "show me everything" — list whatever entity was last discussed.
        if "show me everything" in normalized or "show everything" in normalized or "give me everything" in normalized:
            if last_entity:
                intent_code, domain = self._list_intent_for_entity(last_entity)
                return {"intent": intent_code, "domain": domain, "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}
            return {"intent": "ambiguous_general", "domain": "billing", "risk_class": "R0", "confidence": 0.6, "classified_by": IntentClassifiedBy.RULES}

        # ── Fuzzy token rescue (typos / tokenization drift) ──────────────
        # Every specific rule had its chance; if a token is within one edit
        # of a core billing noun ("dashbord summary", "invoce list"), route
        # to that noun's surface instead of the generic lookup / loose RAG.
        # Tokens that ARE exact billing nouns are skipped: an unmatched
        # knowledge query mentioning them ("What is an invoice?") must stay
        # with RAG.
        for tok in dict.fromkeys(_tokenize(normalized)):
            if len(tok) < 5 or tok in FUZZY_INTENT_KEYWORDS:
                continue
            for term, (fz_intent, fz_domain) in FUZZY_INTENT_KEYWORDS.items():
                if _within_edit_distance_1(tok, term):
                    return {"intent": fz_intent, "domain": fz_domain, "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # ── FIX #3: Direct DB lookups — generic billing commands ─────────
        # An UNQUALIFIED dashboard mention is the financial summary even
        # under a command verb ("show me the dashboard"); qualified forms
        # ("customer dashboard") were resolved earlier by the D-11 block.
        if re.search(r"\bdashboard\b", normalized) and not re.search(r"\b(count|how many|export|csv)\b", normalized):
            return {"intent": "dashboard_summary", "domain": "dashboard", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        has_ref = bool(re.search(r'\b(inv|pay|pmt|invoice|payment|cust|ref)[-\s]?\d', normalized))
        is_lookup_command = any(normalized.startswith(w) for w in ("show", "find", "search", "look up", "list", "display", "get"))
        is_direct_entity = any(kw in normalized for kw in ("overdue", "past due"))
        if has_ref or is_lookup_command or is_direct_entity:
            return {"intent": "general_billing_lookup", "domain": "billing", "risk_class": "R1", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # ── Dashboard / revenue summary queries (M1 Inspect) ────────────
        dashboard_keywords = ("dashboard", "revenue", "financial overview", "financial summary", "total revenue", "monthly revenue", "yearly revenue", "earnings", "income summary", "billing overview")
        if any(kw in normalized for kw in dashboard_keywords):
            return {"intent": "dashboard_summary", "domain": "dashboard", "risk_class": "R1", "confidence": 0.85, "classified_by": IntentClassifiedBy.RULES}

        # Help/capabilities keywords
        help_keywords = ("what can you do", "capabilities")
        if any(kw in normalized for kw in help_keywords):
            return {"intent": "help_general", "domain": "help", "risk_class": "R0", "confidence": 0.8, "classified_by": IntentClassifiedBy.RULES}

        # ── §6.0 Topic screening: OUT_OF_DOMAIN final gate ──────────────
        # Defense-in-depth before the catch-all: an informational question
        # with a substantive subject and no domain evidence is refused here
        # rather than answered with loosely-related knowledge chunks.
        # Filler-only utterances ("hmm interesting") and gibberish without an
        # informational shape still fall through to help_general/abstention.
        if _GATE_SHAPE_RE.search(normalized) and not topic_screen(normalized):
            if _gate_substantive_tokens(normalized):
                logger.info("topic_screen: OUT_OF_DOMAIN short-circuit (final gate): %r", text)
                return {"intent": "out_of_scope", "domain": "out_of_scope", "risk_class": "R0", "confidence": 0.95, "classified_by": IntentClassifiedBy.RULES}

        # Everything else: knowledge question — use retrieval
        return {"intent": "help_general", "domain": "help", "risk_class": "R0", "confidence": 0.7, "classified_by": IntentClassifiedBy.RULES}

    def _abstention_response(self) -> dict:
        """D-11 / KB guardrail: retrieval found only weak matches — say so and
        offer escalation instead of confidently quoting unrelated content."""
        return {
            "answer": (
                "I don't have specific information on that in my knowledge base yet, "
                "and I'd rather not guess.\n\n"
                "Would you like me to connect you to a team member? In the meantime, "
                "I can help with invoices, payments, customers, subscriptions, or your billing dashboard."
            ),
            "mode": "M5_ESCALATE",
            "risk_class": "R0",
            "evidence": [],
            "qualification": "No strong knowledge-base match for this question; no unrelated content substituted.",
            "next_actions": [],
            "suggested_prompts": ["Dashboard summary", "Show overdue invoices", "What can this assistant do?"],
        }

    # ── Conversation Context Resolution ──────────────────────────────

    @staticmethod
    def _entity_from_text(text: str) -> str | None:
        """Detect the billing entity a message refers to (canonical name)."""
        n = text.lower()
        if re.search(r"\b(customer|customers|client|clients|account|accounts)\b", n):
            return "customer"
        if re.search(r"\b(invoice|invoices|bill|bills)\b", n):
            return "invoice"
        if re.search(r"\b(payment|payments|transaction|transactions)\b", n):
            return "payment"
        if re.search(r"\b(subscription|subscriptions|subscriber|subscribers|recurring|plan)\b", n):
            return "subscription"
        if re.search(r"\b(contract|contracts|agreement|agreements)\b", n):
            return "contract"
        if re.search(r"\b(product|products|item|items|catalog|catalogue)\b", n):
            return "product"
        return None

    @staticmethod
    def _looks_like_domain_term(token: str) -> bool:
        """True when `token` is (or is within one edit of) a core billing
        surface noun — such words are never customer NAMES ("show me the
        dashboard" must not become a customer search for 'dashboard')."""
        if len(token) < 5:
            return False
        return any(_within_edit_distance_1(token, term) for term in FUZZY_INTENT_KEYWORDS)

    @staticmethod
    def _count_intent_for_entity(entity: str) -> tuple[str, str]:
        """Return (intent_code, domain) for a count question on an entity."""
        return {
            "customer": ("customer_count", "dashboard"),
            "invoice": ("invoice_count", "billing"),
            "payment": ("payment_count", "billing"),
            "subscription": ("subscription_count", "billing"),
            "contract": ("contract_count", "billing"),
            "product": ("product_count", "billing"),
        }[entity]

    @staticmethod
    def _list_intent_for_entity(entity: str) -> tuple[str, str]:
        """Return (intent_code, domain) for a list question on an entity."""
        return {
            "customer": ("customer_list", "billing"),
            "invoice": ("invoice_list", "billing"),
            "payment": ("payment_list", "billing"),
            "subscription": ("subscription_list", "billing"),
            "contract": ("contract_list", "billing"),
            "product": ("product_list", "billing"),
        }[entity]

    @staticmethod
    def _entity_plural(entity: str) -> str:
        """Plural display noun for an entity ('customers', 'invoices', ...)."""
        return {
            "customer": "customers",
            "invoice": "invoices",
            "payment": "payments",
            "subscription": "subscriptions",
            "contract": "contracts",
            "product": "products",
        }[entity]

    def _customer_from_text(self, text: str, ctx: AIContext) -> str | None:
        """Resolve a customer name mentioned in a message (company_name)."""
        text = text.strip().strip(".")
        if not text:
            return None
        ref = self._extract_reference(text, prefixes=("CUST", "CUSTOMER"))
        if ref:
            customer = (
                self.db.query(BillingCustomer)
                .filter(
                    BillingCustomer.organization_id == ctx.organization_id,
                    BillingCustomer.deleted_at.is_(None),
                    func.lower(BillingCustomer.customer_code) == ref.lower(),
                )
                .first()
            )
            return customer.company_name if customer else None
        customer = self._resolve_customer(text, ctx)
        return customer.company_name if customer else None

    def _load_conversation_context(self, conv: AIConversation, ctx: AIContext, current_text: str | None = None) -> dict:
        """Reconstruct entity context from prior user messages so follow-ups
        like 'how many are there?' or 'show his details' resolve correctly.

        Financial facts are never taken from memory — this only resolves
        WHICH entity/record the current question refers to.
        """
        try:
            messages = (
                self.db.query(AIConversationMessage)
                .filter(
                    AIConversationMessage.conversation_id == conv.id,
                    AIConversationMessage.sender_type == SenderType.USER,
                )
                .order_by(AIConversationMessage.id.asc())
                .all()
            )
        except Exception:
            return {}
        user_texts = [m.message_text or "" for m in messages]
        if current_text and user_texts and user_texts[-1] == current_text:
            user_texts = user_texts[:-1]

        context: dict = {
            "last_entity": None,
            "last_customer_name": None,
            "last_invoice_ref": None,
            "last_payment_ref": None,
            "last_entity_text": None,
        }
        for t in reversed(user_texts):
            entity = self._entity_from_text(t)
            if entity and context["last_entity"] is None:
                context["last_entity"] = entity
                context["last_entity_text"] = t
            if context["last_customer_name"] is None and entity == "customer":
                context["last_customer_name"] = self._customer_from_text(t, ctx)
            if context["last_invoice_ref"] is None:
                context["last_invoice_ref"] = self._extract_reference(t, prefixes=("INV", "INVOICE"))
            if context["last_payment_ref"] is None:
                context["last_payment_ref"] = self._extract_reference(t, prefixes=("PAY", "PMT", "PAYMENT"))
            if context["last_entity"] and (context["last_customer_name"] or context["last_invoice_ref"] or context["last_payment_ref"]):
                break
        return context

    def _resolve_references(self, text: str, conv: AIConversation, ctx: AIContext, context: dict | None = None) -> str:
        """Replace pronouns/demonstratives with the referenced entity so the
        classifier and handlers can act on them ('show his details' →
        'show GOk details', 'count them' → 'count customers')."""
        if context is None:
            context = self._load_conversation_context(conv, ctx, current_text=text)
        entity = context.get("last_entity")
        if entity is None:
            return text
        plural = self._entity_plural(entity)

        if entity == "customer":
            name = context.get("last_customer_name")
            if name:
                text = re.sub(r"\bhis\b", name, text, flags=re.IGNORECASE)
                text = re.sub(r"\bhim\b", name, text, flags=re.IGNORECASE)
                text = re.sub(r"\bher\b", name, text, flags=re.IGNORECASE)
                text = re.sub(r"\btheirs\b", name, text, flags=re.IGNORECASE)
                text = re.sub(r"\btheir\b", name, text, flags=re.IGNORECASE)
                text = re.sub(r"\bthis customer\b|\bthat customer\b|\bthe customer\b", name, text, flags=re.IGNORECASE)
            text = re.sub(r"\bthem\b|\bthose customers\b|\bthese customers\b", plural, text, flags=re.IGNORECASE)
            text = re.sub(r"\bwhich one\b|\bwhich of them\b", "which customer", text, flags=re.IGNORECASE)
        elif entity == "invoice":
            ref = context.get("last_invoice_ref")
            if ref:
                text = re.sub(r"\bthis invoice\b|\bthat invoice\b|\bthe invoice\b", ref, text, flags=re.IGNORECASE)
                text = re.sub(r"\bis it\b|\bwas it\b|\bshow it\b|\bopen it\b|\bwhat about it\b", f"is {ref}", text, flags=re.IGNORECASE)
            text = re.sub(r"\bthem\b|\bthose invoices\b|\bthese invoices\b", plural, text, flags=re.IGNORECASE)
        elif entity == "payment":
            ref = context.get("last_payment_ref")
            if ref:
                text = re.sub(r"\bthis payment\b|\bthat payment\b|\bthe payment\b", ref, text, flags=re.IGNORECASE)
                text = re.sub(r"\bis it\b|\bwas it\b|\bshow it\b|\bopen it\b|\bwhat about it\b", f"is {ref}", text, flags=re.IGNORECASE)
            text = re.sub(r"\bthem\b|\bthose payments\b|\bthese payments\b", plural, text, flags=re.IGNORECASE)
        else:
            text = re.sub(
                rf"\bthis {entity}\b|\bthat {entity}\b|\bthe {entity}\b|\bthem\b|\bthose {plural}\b|\bthese {plural}\b",
                plural, text, flags=re.IGNORECASE,
            )
        return text

    # ── Domain Handlers (M0/M1 only) ───────────────────────────────────

    def _get_handler(self, domain: str):
        handlers = {
            "help": self._handle_help,
            "dashboard": self._handle_dashboard,
            "billing": self._handle_billing,
            "action": self._handle_action,
            "reconciliation": self._handle_reconciliation,
            "out_of_scope": self._handle_out_of_scope,
            "clarify": self._handle_clarify,
        }
        return handlers.get(domain, self._handle_billing)

    # ── Clarification follow-through (D-11 loop prevention) ────────────

    def _get_pending_clarification(self, conv: AIConversation) -> dict | None:
        """Return the structured clarify state from the LAST assistant message,
        if that message asked a disambiguation question."""
        last = (
            self.db.query(AIConversationMessage)
            .filter(
                AIConversationMessage.conversation_id == conv.id,
                AIConversationMessage.sender_type == SenderType.ASSISTANT,
            )
            .order_by(AIConversationMessage.id.desc())
            .first()
        )
        if not last or not last.structured_payload:
            return None
        state = last.structured_payload.get("clarify")
        if state and state.get("options"):
            return state
        return None

    def _match_clarify_option(self, text: str, pending: dict) -> dict | None:
        """Match a user's reply against the options a clarification just
        offered. Keyword-based (not exact-phrase): 'customer Dashboard
        summary' matches the option carrying the 'customer' keyword."""
        normalized = text.strip().lower()
        options = pending.get("options") or []

        # Affirmative replies ("yes") accept the option just offered —
        # for single-option clarifies this always moves forward.
        if options and re.fullmatch(
            r"(?:yes|yeah|yep|yup|sure|ok(?:ay)?|correct|right|exactly|confirm|please(?:\s+do)?|go\s+ahead)[!. ]*",
            normalized,
        ):
            return options[0]

        # Ordinal replies: "the second one", "1st", "option 2"
        if len(options) >= 2 and re.search(r"\b(second|2nd|option\s*2|two)\b", normalized):
            return options[1]
        if options and re.search(r"\b(first|1st|option\s*1|one)\b", normalized):
            return options[0]

        tokens = set(re.findall(r"[a-z]+", normalized)) - set(QUERY_STOPWORDS)

        # Primary keywords are decisive: a reply naming the entity ("customer")
        # resolves to that option even when it also contains generic words
        # ("summary") that appear in the other option's keyword list.
        primary_hits = [
            o for o in options if set(o.get("primary", [])) & tokens
        ]
        if len(primary_hits) == 1:
            return primary_hits[0]

        best, best_score = None, 0
        for opt in options:
            score = len(tokens & set(opt.get("keywords", [])))
            if score > best_score:
                best, best_score = opt, score
        return best if best is not None and best_score >= 1 else None

    def _choose_clarification_fallback(self, pending: dict, page_path: str | None) -> tuple[dict, str]:
        """Max one round-trip: when a reply would trigger the SAME clarify
        again, commit to the most likely option instead of re-asking."""
        options = pending.get("options") or []
        if not options:
            return {"label": "your billing dashboard", "route": {"intent": "dashboard_summary", "domain": "dashboard"}}, \
                "I'll assume you mean your billing dashboard — let me know if that's wrong."
        if pending.get("kind") == "dashboard_scope" and len(options) > 1:
            qualifier = (pending.get("qualifier") or "").rstrip("s")
            if qualifier and page_path and f"/{qualifier}" in str(page_path).lower():
                return options[1], (
                    f"I'll assume you mean the {qualifier} view, since you're on that page — "
                    "let me know if that's wrong."
                )
            return options[0], "I'll assume you mean your billing dashboard — let me know if that's wrong."
        chosen = options[0]
        return chosen, f"I'll assume you meant: {chosen['label']} — let me know if that's wrong."

    def _handle_clarify(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        """D-11 Safe uncertainty: when classification is ambiguous, ASK which
        of the candidate intents the user meant — never guess (PRD §06)."""
        options = intent.get("options") or [
            DOMAIN_LABELS.get("billing", "Billing records"),
            DOMAIN_LABELS.get("help", "Product guidance"),
        ]
        bullets = "\n".join(f"- {opt}" for opt in options)
        # Persist machine-actionable option routes so the NEXT user message
        # can be matched against what we just asked (breaks clarification
        # loops). dashboard_scope clarifies carry their own structured state.
        state = intent.get("clarify_state")
        if not state:
            reverse = {v: k for k, v in DOMAIN_LABELS.items()}
            state_options = []
            for lbl in options:
                dom = reverse.get(lbl, "billing")
                toks = sorted({
                    t for t in re.findall(r"[a-z]+", lbl.lower())
                    if t not in QUERY_STOPWORDS
                    and t not in ("view", "records", "things", "work", "mean")
                }) or [lbl.split()[0].lower()]
                default_route = {
                    "help": {"intent": "help_general", "domain": "help"},
                    "dashboard": {"intent": "dashboard_summary", "domain": "dashboard"},
                }.get(dom, {"intent": "general_billing_lookup", "domain": "billing"})
                state_options.append({
                    "label": lbl,
                    "primary": [dom] if dom else [],
                    "keywords": toks,
                    "route": default_route,
                })
            state = {"kind": "domain_choice", "asked_count": 1, "options": state_options}
        return {
            "answer": (
                "I want to make sure I answer the right question. Did you mean:\n\n"
                f"{bullets}\n\n"
                "Reply with the one you meant (or rephrase), and I'll take it from there."
            ),
            "mode": "M0_EXPLAIN",
            "risk_class": "R0",
            "evidence": [],
            "qualification": "The request was ambiguous, so I asked instead of guessing (safe-uncertainty policy).",
            "next_actions": list(options),
            "suggested_prompts": list(options),
            "clarify_state": state,
        }

    def _handle_help(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        # Definitional metric questions ("explain me about Revenue") compose
        # the definition-first answer with the live figure.
        if intent.get("intent") == "metric_definition":
            return self._metric_definition_response(conv, text, ctx, metric_code=intent.get("metric"))

        # Self-identification: "who are you", "what are you", etc.
        normalized = text.strip().lower()
        self_id_keywords = ("who are you", "who are u", "what are you", "what are u",
                            "who am i talking to", "who am i speaking to", "who is this",
                            "what is your name", "tell me about yourself", "introduce yourself",
                            "what do you do", "what is your purpose", "describe yourself")
        if any(kw in normalized for kw in self_id_keywords):
            return {
                "answer": (
                    "I am the Zoiko Billing AI Assistant — a governed billing operations helper.\n\n"
                    "**What I can do (M0 Explain / M1 Inspect):**\n"
                    "- Look up invoices, payments, customers, subscriptions, contracts, products, and quotations\n"
                    "- Explain invoice balances, payment allocations, overdue status, and aging\n"
                    "- Summarize your financial dashboard and KPIs\n"
                    "- Explain billing workflows, policies, and dunning processes\n\n"
                    "**Governed by design:**\n"
                    "- Every answer grounded in authoritative Zoiko Billing records\n"
                    "- Your tenant context is enforced — no cross-organization data access\n"
                    "- Full audit trail for every interaction"
                ),
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": [{"source": "Zoiko Billing Knowledge Base", "summary": "Capability overview"}],
                "qualification": "This is product guidance, not tax, legal, or accounting advice.",
                "next_actions": [],
                "suggested_prompts": ["Dashboard summary", "Show overdue invoices", "Look up customer details"],
            }

        # Invoice/status definition questions: "what does X mean for invoice status?"
        # NOTE: "what are the valid invoice statuses?"-style questions are NOT
        # answered from canned text — they fall through to the KB retrieval
        # path below so answers stay grounded in the approved knowledge base
        # and citations point at real documents. Only per-status meaning
        # validation stays hardcoded, because "'Delivered' is not a valid
        # status" is a live-enum fact no KB document can state.
        status_match = self._STATUS_MEANING_RE.search(normalized)
        if status_match and any(w in normalized for w in ("invoice", "status", "billing")):
            asked_status = status_match.group(1).strip("'\"")
            valid_statuses = {
                "draft": "Draft — Invoice has been created but not yet sent to the customer.",
                "sent": "Sent — Invoice has been delivered to the customer and is awaiting payment.",
                "paid": "Paid — Full payment has been received and applied.",
                "overdue": "Overdue — Payment due date has passed and balance remains unpaid.",
                "cancelled": "Cancelled — Invoice has been voided before any collection effort.",
                "partially_paid": "Partially Paid — A partial payment has been received but balance remains.",
                "refunded": "Refunded — Payment has been returned to the customer.",
                "written_off": "Written Off — Remaining balance has been written off as uncollectable.",
            }
            if asked_status in valid_statuses:
                answer = f"**{asked_status.title()}** means: {valid_statuses[asked_status]}"
            else:
                status_list = "\n".join(f"- **{s.title()}**" for s in valid_statuses)
                answer = (
                    f"**{asked_status.title()}** is not a valid invoice status in Zoiko Billing.\n\n"
                    f"Valid invoice statuses are:\n{status_list}"
                )
            return {
                "answer": answer,
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": [{"source": "Zoiko Billing invoice status model", "type": "invoice_status_definition"}],
                "qualification": "This is product guidance, not tax, legal, or accounting advice.",
                "next_actions": [],
                "suggested_prompts": ["Show overdue invoices", "Dashboard summary"],
            }

        # Try retrieval first — but only answer from CONFIDENT matches. Weak
        # matches must abstain, never quote loosely-related chunks (this is
        # what previously served invoice content for a permissions question).
        retrieval = self._retrieve(text, ctx, top_k=3)
        if retrieval.get("low_confidence"):
            floor = self._fuzzy_domain_suggestion(normalized)
            if floor:
                return floor
            return self._abstention_response()
        if retrieval["answer"]:
            return {
                "answer": retrieval["answer"],
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": retrieval["evidence"],
                "qualification": "This is product guidance, not tax, legal, or accounting advice.",
                "next_actions": [],
                "suggested_prompts": ["Show overdue invoices", "Look up customer details", "Dashboard summary"],
            }
        # Fallback: explicit capability/meta asks get the capabilities dump;
        # anything else that reaches here had no confident KB match, so it
        # must abstain rather than dump unrelated marketing copy.
        capability_ask = any(kw in normalized for kw in (
            "what can you do", "what can i ask", "what do you do",
            "capabilities", "features", "how can you help",
            "how can i use you", "your purpose",
        ))
        if capability_ask:
            return {
                "answer": (
                    "I am the Zoiko Billing AI Assistant — a governed billing operations helper.\n\n"
                    "**What I can do (M0 Explain / M1 Inspect):**\n"
                    "- Look up invoices, payments, customers, subscriptions, contracts, products, and quotations\n"
                    "- Explain invoice balances, payment allocations, overdue status, and aging\n"
                    "- Summarize your financial dashboard and KPIs\n"
                    "- Explain billing workflows, policies, and dunning processes\n\n"
                    "**Governed by design:**\n"
                    "- Every answer grounded in authoritative Zoiko Billing records\n"
                    "- Your tenant context is enforced — no cross-organization data access\n"
                    "- Full audit trail for every interaction"
                ),
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": [{"source": "Zoiko Billing Knowledge Base", "summary": "Capability overview"}],
                "qualification": "This is product guidance, not tax, legal, or accounting advice.",
                "next_actions": [],
                "suggested_prompts": ["Show overdue invoices", "Look up customer details", "Dashboard summary"],
            }
        floor = self._fuzzy_domain_suggestion(normalized)
        if floor:
            return floor
        return self._abstention_response()

    def _metric_definition_response(self, conv: AIConversation, text: str, ctx: AIContext,
                                    metric_code: str | None = None) -> dict:
        """Definition-first answer for a financial metric, composed with the
        live figure from the same BillingDashboardService the dashboard page
        uses (so numbers always agree). MRR/ARR are definition-only — no live
        KPI exists yet."""
        from app.modules.billing.services.dashboard_service import BillingDashboardService

        norm = normalize_domain_text((text or "").strip().lower())
        code = metric_code or self._match_definitional_metric(norm)
        spec = METRIC_DEFINITIONS.get(code or "")
        if not spec:
            return self._handle_help(conv, text, {"intent": "help_general", "domain": "help", "risk_class": "R0"}, ctx)

        answer = f"**{spec['label']}** — {spec['definition']}\n\nIt is calculated by {spec['formula']}."
        evidence = [{"source": "Zoiko Billing Dashboard", "type": f"metric_definition_{code}"}]

        if spec.get("live"):
            svc = BillingDashboardService(self.db)
            kpis = svc.get_kpis(organization_id=ctx.organization_id)
            value = kpis.get(spec["kpi_key"], 0)
            if code == "overdue":
                overdue_count = self.db.query(func.count(Invoice.id)).filter(
                    Invoice.organization_id == ctx.organization_id,
                    Invoice.deleted_at.is_(None),
                    Invoice.is_active == True,
                    Invoice.status.notin_(["draft", "cancelled"]),
                    Invoice.balance_due > 0,
                    Invoice.due_date < date.today(),
                ).scalar() or 0
                answer += (f"\n\nRight now: **{money(value)}** is overdue across "
                           f"**{overdue_count} invoice(s)**.")
                evidence[0].update({"value": str(value), "overdue_count": overdue_count})
            else:
                answer += f"\n\nYour current {spec['label'].lower()}: **{money(value)}**."
                evidence[0]["value"] = str(value)
            evidence[0]["as_of"] = datetime.now(timezone.utc).isoformat()
            answer += "\n\nAsk for the **dashboard summary** to see all figures together."
        else:
            answer += ("\n\nI don't report a live figure for this metric yet — "
                       "ask for the **dashboard summary** for the numbers I track today.")

        return {
            "answer": answer,
            "mode": "M0_EXPLAIN",
            "risk_class": "R0",
            "evidence": evidence,
            "qualification": (
                "Definition per Zoiko Billing product semantics"
                + ("; figure is a live aggregate identical to the dashboard page." if spec.get("live") else ".")
            ),
            "next_actions": ["Dashboard summary"],
            "suggested_prompts": ["Dashboard summary", "Show overdue invoices"],
        }

    def _match_definitional_metric(self, normalized: str) -> str | None:
        """Return a METRIC_DEFINITIONS key when `normalized` is a definitional
        question about that metric; None when it is not definitional, or its
        subject is not a financial metric (those keep their existing routes).
        """
        if not normalized or _DEF_GUARD_SKIP_RE.search(normalized):
            return None
        # Document references ("What is INV-2024-0001?") are lookups.
        if re.search(r"\b(?:inv|pay|pmt|invoice|payment|cust|ref)[-\s]?\d", normalized):
            return None
        subject = None
        for pattern in _DEF_SHAPE_RES:
            m = pattern.match(normalized)
            if m:
                subject = m.group(1)
                break
        if not subject:
            return None
        subject = subject.strip(" \"'?.!")
        # Possessive subjects are live-data lookups ("What's my outstanding balance?").
        if not subject or _DEF_POSSESSIVE_RE.match(subject):
            return None
        for code, rx in _METRIC_SUBJECT_RULES:
            if rx.search(subject):
                return code
        return None

    def _fuzzy_domain_suggestion(self, normalized: str) -> dict | None:
        """D-11 safety floor: retrieval was NOT confident, but the user's
        wording nearly names a core billing surface ("dashbord summery",
        "subscribtions"). Offer a one-option clarify instead of serving
        loosely-related knowledge chunks or a bare abstention."""
        seen: set[str] = set()
        for tok in _tokenize(normalized):
            if tok in seen or len(tok) < 5 or tok in FUZZY_INTENT_KEYWORDS:
                continue
            seen.add(tok)
            for term, route in FUZZY_INTENT_KEYWORDS.items():
                if not _within_edit_distance_1(tok, term):
                    continue
                singular = term.rstrip("s") if term.endswith("s") and term[:-1] in FUZZY_INTENT_KEYWORDS else term
                label = (
                    "Your billing dashboard (financial summary)"
                    if singular == "dashboard"
                    else f"Your {singular}s list"
                )
                option = {
                    "label": label,
                    "primary": [singular],
                    "keywords": [term],
                    "route": {"intent": route[0], "domain": route[1]},
                }
                return {
                    "answer": (
                        f"I couldn't find an exact match for that, but it looks like you're asking about **{label}**.\n\n"
                        f"Did you mean: {label}?\n\n"
                        "Reply yes to continue, or rephrase your question."
                    ),
                    "mode": "M0_EXPLAIN",
                    "risk_class": "R0",
                    "evidence": [],
                    "qualification": "Low-confidence match — asked instead of guessing (safe-uncertainty policy).",
                    "next_actions": [label],
                    "suggested_prompts": [label],
                    "clarify_state": {
                        "kind": "fuzzy_domain",
                        "asked_count": 1,
                        "options": [option],
                    },
                }
        return None

    def _handle_dashboard(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        org_id = ctx.organization_id

        # Use the same BillingDashboardService as the billing page so numbers always match
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        svc = BillingDashboardService(self.db)
        kpis = svc.get_kpis(organization_id=org_id)

        total_invoices = kpis.get("total_invoices", 0)
        total_revenue = kpis.get("total_revenue", 0)
        outstanding = kpis.get("outstanding_amount", 0)
        total_customers = kpis.get("active_customers", 0)

        # FIX #6 (Issue 3): "How many customers are there?" must return the
        # live customer count — never route to RAG retrieval.
        if intent.get("intent") == "customer_count":
            return {
                "answer": f"There are **{total_customers} customer(s)** in your organization.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [{
                    "source": "Zoiko Billing Customers",
                    "type": "customer_count",
                    "as_of": datetime.now(timezone.utc).isoformat(),
                    "customer_count": total_customers,
                }],
                "qualification": "Count is a live aggregate from the customer records.",
                "next_actions": ["Look up customer details", "Show customers with outstanding balances"],
                "suggested_prompts": ["Look up customer details", "Dashboard summary"],
            }

        # FIX #4 (Issue 2): single-metric questions return ONLY the figure —
        # never the full overview dump. Reads the same get_kpis source as the
        # dashboard page so the numbers always agree.
        if intent.get("intent") == "metric_revenue":
            return {
                "answer": f"Total revenue is **{money(total_revenue)}**.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [{
                    "source": "Zoiko Billing Dashboard",
                    "type": "metric_total_revenue",
                    "as_of": datetime.now(timezone.utc).isoformat(),
                    "value": str(total_revenue),
                }],
                "qualification": (
                    "Billed revenue: sum of issued invoice totals (drafts and "
                    "cancelled invoices excluded). Ask for the 'dashboard summary' "
                    "for the full financial overview."
                ),
                "next_actions": ["Dashboard summary", "Show outstanding balances"],
                "suggested_prompts": ["Dashboard summary", "How much is outstanding?", "Show overdue invoices"],
            }

        overdue_count = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == org_id, Invoice.deleted_at.is_(None),
            Invoice.is_active == True,
            Invoice.status.notin_(["draft", "cancelled"]),
            Invoice.balance_due > 0, Invoice.due_date < date.today()
        ).scalar() or 0

        answer = (
            f"Financial overview for **{ctx.tenant_name or 'your organization'}**:\n\n"
            f"**Invoices:** {total_invoices} total | **Revenue:** {money(total_revenue)} | "
            f"**Outstanding:** {money(outstanding)} | **Overdue:** {overdue_count}\n\n"
            f"**Customers:** {total_customers}"
        )
        if overdue_count > 0:
            answer += f"\n\n**Attention:** {overdue_count} invoice(s) are overdue."

        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Dashboard",
                "type": "dashboard_summary",
                "as_of": datetime.now(timezone.utc).isoformat(),
                "fields": {
                    "total_invoices": total_invoices,
                    "total_revenue": str(total_revenue),
                    "outstanding": str(outstanding),
                    "overdue_count": overdue_count,
                    "total_customers": total_customers,
                },
            }],
            "qualification": "Figures are current aggregates from authoritative records.",
            "next_actions": ["Drill into overdue invoices", "Review customer aging"],
            "suggested_prompts": ["Show overdue invoices", "List recent payments"],
        }

    def _handle_out_of_scope(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        """FIX #4 + §6.0: Explicit out-of-scope refusal."""
        normalized = text.strip().lower()
        topic = None
        for kw in ("payroll", "salary", "hr", "human resources", "inventory", "stock",
                     "marketing", "seo", "advertising", "crm", "project management",
                     "task management", "time tracking", "timesheet", "travel", "expense report"):
            if kw in normalized:
                topic = kw.strip().title()
                break
        if not topic:
            # Generic frame-stripping: "What is machine learning?" ->
            # "Machine Learning"; "Explain me about python" -> "Python".
            m = re.match(
                r"^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?"
                r"(?:explain|describe|define|tell\s+me\s+about|elaborate(?:\s+on)?"
                r"|what\s+(?:is|are)|what's|whats|how\s+(?:does|do)"
                r"|give\s+me\s+(?:a|an|the)?)\s+"
                r"(?:me\s+)?(?:about\s+)?(.+?)[?.!]*$",
                normalized,
            )
            if m and m.group(1).strip():
                topic = m.group(1).strip().title()
        if not topic:
            topic = "that topic"
        return {
            "answer": (
                f"I'm the Zoiko Billing AI Assistant, and **{topic}** is outside my scope.\n\n"
                "I can help with invoices, payments, customers, subscriptions, "
                "credit notes, refunds, dunning, contracts, and billing workflows.\n\n"
                "How can I help you with billing today?"
            ),
            "mode": "M0_EXPLAIN",
            "risk_class": "R0",
            "evidence": [],
            "qualification": "Out-of-scope refusal per governance policy.",
            "next_actions": ["Ask about billing, payments, invoices, or subscriptions."],
            "suggested_prompts": ["Show overdue invoices", "Dashboard summary", "What can you do?"],
        }

    def _handle_reconciliation(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        """Handle reconciliation queries — unmatched payments, allocation status, bank matching."""
        normalized = text.strip().lower()
        org_id = ctx.organization_id

        # Inspect mode: query real payment/allocation data
        unmatched_payments = (
            self.db.query(Payment)
            .filter(
                Payment.organization_id == org_id,
                Payment.is_active == True,
                Payment.deleted_at.is_(None),
                Payment.status.in_(["cleared", "pending"]),
            )
            .all()
        )

        # A payment is "unmatched" if it has zero allocations or total allocation < payment amount
        unmatched = []
        for p in unmatched_payments:
            alloc_total = sum(a.amount for a in p.allocations) if p.allocations else 0
            if alloc_total < p.amount:
                unmatched.append({
                    "payment_number": p.payment_number,
                    "amount": str(p.amount),
                    "currency": p.currency,
                    "status": p.status.value if hasattr(p.status, 'value') else str(p.status),
                    "allocated": str(alloc_total),
                    "unallocated": str(p.amount - alloc_total),
                    "payment_date": str(p.payment_date),
                })

        if unmatched:
            lines = [f"**{len(unmatched)} unallocated payment(s)** found:\n"]
            for u in unmatched[:10]:
                lines.append(
                    f"- **{u['payment_number']}**: {u['currency']} {u['unallocated']} unallocated "
                    f"(of {u['currency']} {u['amount']}, paid {u['payment_date']})"
                )
            if len(unmatched) > 10:
                lines.append(f"\n...and {len(unmatched) - 10} more.")
            answer = "\n".join(lines)
            qualification = "Payment allocation data is current. Unallocated amounts may need matching to invoices."
        else:
            answer = (
                "No unallocated payments found for your organisation. "
                "All cleared and pending payments are fully allocated to invoices."
            )
            qualification = "Payment allocation data is current."

        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Payments & Allocations", "type": "reconciliation_summary", "as_of": datetime.now(timezone.utc).isoformat(), "summary": f"Found {len(unmatched)} unallocated payment(s)"}],
            "qualification": qualification,
            "next_actions": [],
            "suggested_prompts": ["Show overdue invoices", "Dashboard summary"],
        }

    def _handle_action(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        """Route action-intent messages to the governed action lifecycle (M2/M3)."""
        from ..actions.action_engine import ActionEngine, ActionEngineError

        normalized = text.strip().lower()
        logger.error("[CHATBOT-DIAG] _handle_action: intent=%s text=%r", intent.get("intent"), normalized[:120])

        # Guided PRD §09 flows (Correct / Communicate / Export) are handled by
        # dedicated responses in the billing handler — they must never fall
        # through into the draft/preview lifecycle.
        if intent.get("intent") in ("correct_request", "communicate_request", "export_request"):
            return self._handle_billing(conv, text, intent, ctx)

        # ── M3 Preview: "Preview action {uid}" ────────────────────────────
        if intent.get("intent") == "action_preview":
            uid_match = re.search(r'preview\s+action\s+(\S+)', normalized)
            if not uid_match:
                return {
                    "answer": "Please specify the action to preview, e.g. **Preview action <uid>**.",
                    "mode": "M3_PREVIEW",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Could not parse action UID.",
                    "next_actions": [],
                    "suggested_prompts": [],
                }

            action_uid = uid_match.group(1)
            try:
                engine = ActionEngine(self.db)
                preview_result = engine.generate_preview(ctx=ctx, action_uid=action_uid, commit=False)
            except ActionEngineError as e:
                return {
                    "answer": f"Could not generate preview: {e}",
                    "mode": "M3_PREVIEW",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Preview generation failed.",
                    "next_actions": [],
                    "suggested_prompts": [],
                }
            except Exception as exc:
                import traceback as _tb
                import sys
                tb_str = _tb.format_exc()
                sys.stderr.write(f"\n[FATAL] Preview generation FAILED for action_uid={action_uid}\n")
                sys.stderr.write(f"[FATAL] Exception type: {type(exc).__name__}\n")
                sys.stderr.write(f"[FATAL] Exception message: {exc}\n")
                sys.stderr.write(f"[FATAL] Full traceback:\n{tb_str}\n")
                sys.stderr.flush()
                logger.exception("Unexpected error generating preview for %s", action_uid)
                return {
                    "answer": "An unexpected error occurred while generating the preview. Please try again.",
                    "mode": "M3_PREVIEW",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Preview generation failed due to an unexpected error.",
                    "next_actions": [],
                    "suggested_prompts": [],
                }

            payload = preview_result.get("preview_payload", {})
            money = preview_result.get("money_summary", {})
            warnings = preview_result.get("warnings", [])

            answer_parts = [
                f"**Preview — {payload.get('action_type', 'action').replace('_', ' ').title()}**\n",
                f"**Customer:** {payload.get('customer_name', 'N/A')}",
            ]
            if payload.get("line_items"):
                answer_parts.append("**Line items:**")
                for item in payload["line_items"]:
                    answer_parts.append(
                        f"  - {item.get('description', 'N/A')} × {item.get('quantity', 1)} "
                        f"@ {item.get('unit_price', '0')} = {item.get('total', '0')}"
                    )
            if money:
                answer_parts.append(f"\n**Subtotal:** {money.get('subtotal', '0')}")
                if money.get("tax") and money["tax"] != "0":
                    answer_parts.append(f"**Tax:** {money['tax']}")
                answer_parts.append(f"**Total:** {money.get('total', '0')}")
            if warnings:
                answer_parts.append(f"\n**Warnings:** {'; '.join(warnings)}")
            answer_parts.append(
                f"\n**Preview hash:** `{preview_result.get('preview_hash', '')}`\n"
                f"Use **Confirm and execute** to finalize this action."
            )

            return {
                "answer": "\n".join(answer_parts),
                "mode": "M3_PREVIEW",
                "risk_class": "R2",
                "evidence": [{
                    "source": "Zoiko Billing Action Engine",
                    "type": "action_preview",
                    "action_uid": action_uid,
                    "preview_uid": preview_result.get("preview_uid"),
                    "created_at": preview_result.get("created_at"),
                    "expires_at": preview_result.get("expires_at"),
                }],
                "qualification": "Deterministic preview — no mutation has occurred.",
                "next_actions": [
                    f"Confirm and execute action {action_uid}",
                    f"Cancel action {action_uid}",
                ],
                "suggested_prompts": [
                    f"Confirm and execute action {action_uid}",
                    f"Cancel action {action_uid}",
                ],
            }

        # ── M4 Confirm+Execute: "Confirm and execute action {uid}" ─────────
        if intent.get("intent") == "action_confirm_execute":
            uid_match = re.search(r'action\s+(\S+)', normalized)
            if not uid_match:
                return {
                    "answer": "Please specify the action to execute, e.g. **Confirm and execute action <uid>**.",
                    "mode": "M4_EXECUTE",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Could not parse action UID.",
                    "next_actions": [],
                    "suggested_prompts": [],
                }

            action_uid = uid_match.group(1)
            engine = ActionEngine(self.db)

            # Find the draft and its latest valid preview
            draft = engine._get_draft(action_uid, ctx)
            if not draft:
                return {
                    "answer": f"Action **{action_uid}** not found. It may have expired or been cancelled.",
                    "mode": "M4_EXECUTE",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Action draft not found.",
                    "next_actions": [],
                    "suggested_prompts": [],
                }

            preview = (
                self.db.query(AIActionPreview)
                .filter(
                    AIActionPreview.action_draft_id == draft.id,
                    AIActionPreview.preview_status == PreviewStatus.VALID,
                )
                .order_by(AIActionPreview.id.desc())
                .first()
            )
            if not preview:
                return {
                    "answer": (
                        f"No valid preview found for action **{action_uid}**. "
                        f"Please generate a preview first."
                    ),
                    "mode": "M4_EXECUTE",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Preview required before execution.",
                    "next_actions": [f"Preview action {action_uid}"],
                    "suggested_prompts": [f"Preview action {action_uid}"],
                }

            # Confirm the action (binds to preview hash)
            import uuid as _uuid
            idempotency_key = str(_uuid.uuid4())
            logger.error("[CHATBOT-DIAG] confirm: action_uid=%s preview_uid=%s preview_hash=%s", action_uid, preview.preview_uid, preview.preview_hash)
            try:
                confirm_result = engine.confirm_action(
                    ctx=ctx,
                    action_uid=action_uid,
                    preview_uid=preview.preview_uid,
                    preview_hash=preview.preview_hash,
                )
            except ActionEngineError as e:
                logger.error("[CHATBOT-DIAG] confirm FAILED: %s", e)
                return {
                    "answer": f"Could not confirm action: {e}",
                    "mode": "M4_EXECUTE",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Confirmation failed.",
                    "next_actions": [f"Preview action {action_uid}"],
                    "suggested_prompts": [f"Preview action {action_uid}"],
                }

            logger.error("[CHATBOT-DIAG] confirm OK: %s", confirm_result)

            # Execute the confirmed action
            try:
                exec_result = engine.execute_action(
                    ctx=ctx,
                    action_uid=action_uid,
                    idempotency_key=idempotency_key,
                )
            except ActionEngineError as e:
                logger.error("[CHATBOT-DIAG] execute FAILED: %s", e)
                return {
                    "answer": f"Execution failed: {e}",
                    "mode": "M4_EXECUTE",
                    "risk_class": "R2",
                    "evidence": [],
                    "qualification": "Action execution failed after confirmation.",
                    "next_actions": [f"Preview action {action_uid}"],
                    "suggested_prompts": [f"Preview action {action_uid}"],
                }

            # Build success response with created resource details
            result_data = exec_result.get("result", {})
            invoice_id = result_data.get("invoice_id")
            answer_parts = [
                f"**Action executed successfully.**\n",
                f"**Execution UID:** {exec_result.get('execution_uid', 'N/A')}",
                f"**Status:** {exec_result.get('status', 'N/A')}",
            ]
            if invoice_id:
                answer_parts.append(f"**Invoice ID:** {invoice_id}")
            if result_data.get("invoice_number"):
                answer_parts.append(f"**Invoice Number:** {result_data['invoice_number']}")
            if result_data.get("status"):
                answer_parts.append(f"**Invoice Status:** {result_data['status']}")

            return {
                "answer": "\n".join(answer_parts),
                "mode": "M4_EXECUTE",
                "risk_class": "R2",
                "evidence": [{
                    "source": "Zoiko Billing Action Engine",
                    "type": "action_executed",
                    "action_uid": action_uid,
                    "execution_uid": exec_result.get("execution_uid"),
                    "invoice_id": invoice_id,
                    "executed_at": exec_result.get("completed_at"),
                }],
                "qualification": "Action has been executed. The mutation is now live.",
                "next_actions": [
                    f"Preview action {action_uid}" if invoice_id else "Create a new draft",
                ],
                "suggested_prompts": [
                    f"Preview action {action_uid}" if invoice_id else "Create a new draft",
                ],
            }

        # ── M2 Draft: create a new action draft ───────────────────────────
        action_type = "invoice_draft"
        if "credit note" in normalized or "credit" in normalized:
            action_type = "credit_note"
        elif "payment" in normalized:
            action_type = "payment_allocation"
        elif "refund" in normalized:
            action_type = "refund"

        proposed_params = self._extract_action_params(text, action_type, ctx)

        # Handle customer ambiguity — ask user to clarify which customer
        if proposed_params.get("customer_ambiguous"):
            candidates = proposed_params.get("customer_candidates", [])
            candidate_list = "\n".join(
                f"  {i+1}. **{c['name']}** (ID: {c['id']})"
                for i, c in enumerate(candidates)
            )
            return {
                "answer": (
                    f"Multiple customers match **{proposed_params.get('customer_name', '')}**. "
                    f"Please specify which one:\n\n{candidate_list}\n\n"
                    f"Reply with the customer name or number, e.g. "
                    f"Create an invoice for {candidates[0]['name']} for {proposed_params.get('amount', '0')}"
                ),
                "mode": "M2_PREPARE",
                "risk_class": "R2",
                "evidence": [],
                "qualification": "Customer clarification needed before draft creation.",
                "next_actions": [
                    f"Create an invoice for {c['name']}"
                    for c in candidates[:5]
                ],
                "suggested_prompts": [
                    f"Create an invoice for {c['name']}"
                    for c in candidates[:5]
                ],
            }

        # Handle customer not found — fail before draft creation
        if action_type in ("invoice_draft", "credit_note", "refund") and not proposed_params.get("customer_id"):
            customer_name = proposed_params.get("customer_name", text.strip())
            return {
                "answer": (
                    f"I couldn't find a customer named **\"{customer_name}\"** in your billing records.\n\n"
                    f"Please check the exact customer name and try again, e.g.:\n"
                    f"  *Create an invoice for [exact customer name] for [service] at [amount]*"
                ),
                "mode": "M2_PREPARE",
                "risk_class": "R2",
                "evidence": [],
                "qualification": "Customer not found. Draft cannot be created.",
                "next_actions": ["Search customers", "List all customers"],
                "suggested_prompts": ["List all customers"],
            }

        # Handle incomplete line items — ask user for missing details
        if proposed_params.get("line_items_incomplete"):
            missing = proposed_params.get("line_items_missing", [])
            customer_name = proposed_params.get("customer_name", "")
            customer_ref = f" for {customer_name}" if customer_name else ""

            # Check if there are products in the catalog we can suggest
            products = (
                self.db.query(Product)
                .filter(Product.organization_id == ctx.organization_id, Product.is_active == True)
                .limit(5)
                .all()
            )

            if products:
                product_list = "\n".join(
                    f"  - **{p.name}** — {p.unit_price}" if hasattr(p, 'unit_price') and p.unit_price
                    else f"  - **{p.name}**"
                    for p in products
                )
                answer = (
                    f"**What product/service and amount should this invoice{customer_ref} include?**\n\n"
                    f"Your available products:\n{product_list}\n\n"
                    f"For example: Create an invoice{customer_ref} for {products[0].name} at $500"
                )
            else:
                answer = (
                    f"**What product/service and amount should this invoice{customer_ref} include?**\n\n"
                    f"No products are set up in your catalog yet. Please specify a description and amount, e.g.\n"
                    f"Create an invoice{customer_ref} for Consulting services at $500"
                )

            return {
                "answer": answer,
                "mode": "M2_PREPARE",
                "risk_class": "R2",
                "evidence": [],
                "qualification": "Line item details needed before draft creation.",
                "next_actions": [
                    f"Create an invoice{customer_ref} for {products[0].name}" if products
                    else f"Create an invoice{customer_ref} for [service] at $[amount]"
                ],
                "suggested_prompts": [
                    f"Create an invoice{customer_ref} for {p.name}" for p in products
                ] if products else [
                    f"Create an invoice{customer_ref} for [service] at $[amount]"
                ],
            }

        try:
            engine = ActionEngine(self.db)
            draft_result = engine.create_draft(
                ctx=ctx,
                action_type=action_type,
                proposed_params=proposed_params,
                conversation_id=conv.id,
                risk_class="R2",
            )
        except ActionEngineError as e:
            return {
                "answer": f"Could not create draft: {e}",
                "mode": "M2_PREPARE",
                "risk_class": "R2",
                "evidence": [],
                "qualification": "Draft creation failed validation.",
                "next_actions": ["Try a different action with valid parameters."],
                "suggested_prompts": [],
            }

        return {
            "answer": (
                f"I've prepared a **{action_type.replace('_', ' ').title()}** draft for your review.\n\n"
                f"**Action UID:** {draft_result['action_uid']}\n"
                f"**Status:** {draft_result['status']}\n"
                f"**Expires:** {draft_result['expires_at']}\n\n"
                f"Use the **Preview** button to see the full preview before confirming."
            ),
            "mode": "M2_PREPARE",
            "risk_class": "R2",
            "evidence": [{
                "source": "Zoiko Billing Action Engine",
                "type": "action_draft",
                "action_uid": draft_result["action_uid"],
                "action_type": action_type,
                "status": draft_result["status"],
                "created_at": draft_result.get("created_at"),
                "expires_at": draft_result.get("expires_at"),
            }],
            "qualification": "Draft created. No mutation has occurred yet.",
            "next_actions": [
                f"Preview action {draft_result['action_uid']}",
                "Confirm and execute after preview",
            ],
            "suggested_prompts": [f"Preview action {draft_result['action_uid']}", "Cancel draft"],
        }

    def _extract_action_params(self, text: str, action_type: str, ctx: AIContext) -> dict:
        """Extract proposed parameters from natural language for action drafting."""
        params = {"description": text.strip()}

        # Try to extract a customer name — terminate at "for" (when followed by more text),
        # "with", comma, or end-of-string.  This handles:
        #   "Draft an invoice for Go"
        #   "Create an invoice for Go for ₹5000"
        #   "Create an invoice for Go for a Consulting Service, ₹5000"
        customer_match = re.search(
            r'(?:for|to|bill)\s+([\w][\w\s]*?)(?:\s+for\s|\s+with\s|\s*,|\s*$)',
            text, flags=re.IGNORECASE,
        )
        if customer_match:
            raw_name = customer_match.group(1).strip().rstrip(".")
            if raw_name:
                # Use shared customer resolution — searches display_name,
                # company_name, customer_code, and email (case-insensitive).
                customer = self._resolve_customer(raw_name, ctx)

                if customer:
                    params["customer_id"] = customer.id
                    params["customer_name"] = customer.company_name
                else:
                    # Check for multiple partial matches to offer ambiguity
                    pattern = f"%{raw_name}%"
                    candidates = self.db.query(BillingCustomer).filter(
                        BillingCustomer.organization_id == ctx.organization_id,
                        BillingCustomer.deleted_at.is_(None),
                        or_(
                            BillingCustomer.display_name.ilike(pattern),
                            BillingCustomer.company_name.ilike(pattern),
                            BillingCustomer.customer_code.ilike(pattern),
                            BillingCustomer.email.ilike(pattern),
                        ),
                    ).all()

                    if len(candidates) > 1:
                        params["customer_name"] = raw_name
                        params["customer_ambiguous"] = True
                        params["customer_candidates"] = [
                            {"id": c.id, "name": c.company_name} for c in candidates
                        ]
                    else:
                        params["customer_name"] = raw_name

        # Try to extract an amount
        amount_match = re.search(r'[\$₹]\s*(\d[\d,]*\.?\d*)', text)
        if not amount_match:
            amount_match = re.search(r'(\d[\d,]*\.?\d*)\s*(?:rs|inr|usd)?', text, flags=re.IGNORECASE)
        if amount_match:
            params["amount"] = amount_match.group(1).replace(",", "")

        # Build line_items (required by validation)
        if action_type in ("invoice_draft", "credit_note", "refund"):
            # Extract the product/service description — strip trigger phrase,
            # customer reference, and amount so the line item shows just the
            # service name (e.g. "Consulting Service") not the full raw message.
            desc = text
            desc = re.sub(
                r'^(?:draft|create|issue|prepare|send|raise|generate|new|make|set up|setup)\s+'
                r'(?:an?\s+)?(?:invoice|payment|credit note|credit|refund)\s+',
                '', desc, flags=re.IGNORECASE,
            )
            desc = re.sub(
                r'(?:for|to|bill)\s+[\w][\w\s]*?(?:\s+for\s|\s+with\s|\s*,|\s*$)',
                '', desc, flags=re.IGNORECASE,
            )
            desc = re.sub(r'[\$₹]\s*[\d,]+\.?\d*', '', desc)
            desc = re.sub(r'[\d,]+\.?\d*\s*(?:rs|inr|usd)?\b', '', desc, flags=re.IGNORECASE)
            desc = re.sub(r'^(?:for|with|a|an|the|of)\s+', '', desc, flags=re.IGNORECASE)
            desc = re.sub(r'\s+(?:for|with|a|an|the|of)\s*$', '', desc, flags=re.IGNORECASE)
            desc = re.sub(r'\s+', ' ', desc).strip().rstrip(',').strip()

            params["line_items"] = [{
                "description": desc[:200] if desc else params.get("description", text)[:200],
                "quantity": 1,
                "unit_price": params.get("amount", "0") or "0",
            }]

        # Detect incomplete line items: no amount provided
        # A unit_price of "0" means the user didn't specify a value
        if action_type in ("invoice_draft", "credit_note", "refund"):
            first_item = params["line_items"][0]
            try:
                price = float(first_item.get("unit_price", 0))
            except (TypeError, ValueError):
                price = 0
            if price <= 0:
                params["line_items_incomplete"] = True
                params["line_items_missing"] = ["amount"]

        return params

    def _handle_billing(self, conv: AIConversation, text: str, intent: dict, ctx: AIContext) -> dict:
        """Handle billing lookups — invoices, payments, customers."""
        normalized = normalize_domain_text(text.strip().lower())
        org_id = ctx.organization_id

        # ── Status questions are knowledge questions, not DB lookups ─────
        # Route them to the help handler: list-questions ("what are the
        # valid invoice statuses?") ground against the approved KB via its
        # retrieval path; per-status meaning validation lives there too.
        # Canned responses with fabricated citations were removed — they
        # bypassed the KB entirely and mislabeled their evidence source.
        if self._STATUS_LIST_RE.search(normalized) or (
            self._STATUS_MEANING_RE.search(normalized)
            and any(w in normalized for w in ("invoice", "status", "billing"))
        ):
            return self._handle_help(conv, text, intent, ctx)

        # ── Intent dispatch (specific intents from rules / model) ─────────
        intent_code = intent.get("intent")
        if intent_code == "customer_list":
            return self._list_customers(normalized, conv, ctx)
        if intent_code == "customer_outstanding":
            return self._list_customers(normalized, conv, ctx, only_outstanding=True)
        if intent_code in ("customer_search", "customer_details"):
            return self._lookup_customer(text, normalized, conv, ctx)
        if intent_code == "customer_count":
            return self._handle_dashboard(conv, text, {"intent": "customer_count", "domain": "dashboard", "risk_class": "R1"}, ctx)
        if intent_code == "invoice_count":
            return self._count_invoices(normalized, conv, ctx)
        if intent_code == "invoice_list":
            return self._list_invoices(normalized, conv, ctx)
        if intent_code == "invoice_search":
            return self._lookup_invoice(text, normalized, conv, ctx)
        if intent_code == "payment_count":
            return self._count_payments(normalized, conv, ctx)
        if intent_code == "payment_list":
            cust = self._resolve_payment_customer(text, ctx)
            return self._list_payments(normalized, conv, ctx, customer=cust)
        if intent_code == "payment_search":
            return self._lookup_payment(text, normalized, conv, ctx)
        if intent_code == "subscription_count":
            return self._count_subscriptions(normalized, conv, ctx)
        if intent_code == "subscription_list":
            return self._list_subscriptions(normalized, conv, ctx)
        if intent_code == "contract_count":
            return self._count_contracts(normalized, conv, ctx)
        if intent_code == "contract_list":
            return self._list_contracts(normalized, conv, ctx)
        if intent_code == "product_count":
            return self._count_products(normalized, conv, ctx)
        if intent_code == "product_list":
            return self._list_products(normalized, conv, ctx)
        # ── PRD §09 families: guided flows instead of silent mis-answers ──
        if intent_code == "product_dashboard":
            return self._product_overview(conv, ctx)
        if intent_code == "correct_request":
            return {
                "answer": (
                    "I can help correct a billing error. To keep this safe and auditable:\n\n"
                    "1. Tell me the invoice or payment reference (e.g. INV-1042)\n"
                    "2. Describe what's wrong (amount, line item, customer)\n"
                    "3. I'll prepare a **credit note or draft correction** for your review — nothing is changed until you approve it\n\n"
                    "Which invoice needs correcting?"
                ),
                "mode": "M2_ACT",
                "risk_class": "R2",
                "evidence": [],
                "qualification": "Corrections require explicit approval before any record changes.",
                "next_actions": ["Give the invoice reference", "Describe the error"],
                "suggested_prompts": ["Draft a credit note for INV-1042", "Show recent invoices"],
            }
        if intent_code == "communicate_request":
            return {
                "answer": (
                    "I can draft that communication for you.\n\n"
                    "- For an overdue reminder, tell me the customer or invoice (e.g. \"remind Acme about INV-1042\")\n"
                    "- I'll prepare the message text for you to review and send from your own email — I don't contact customers directly\n\n"
                    "Who should I draft it for?"
                ),
                "mode": "M0_EXPLAIN",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "Outbound communication is drafted only; sending stays with you.",
                "next_actions": ["Name the customer/invoice"],
                "suggested_prompts": ["Show overdue invoices", "Show customers with outstanding balances"],
            }
        if intent_code == "export_request":
            return {
                "answer": (
                    "I can scope an export for you, but for data safety I don't generate bulk files directly in chat.\n\n"
                    "- Invoices/payments: use **Billing → Invoices → Export** with the filters you need\n"
                    "- Reports: the **Dashboard → Reports** section has CSV/PDF downloads\n\n"
                    "Tell me the filters you had in mind and I'll list exactly which records would match."
                ),
                "mode": "M0_EXPLAIN",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "Bulk exports run through the product UI so permissions and audit logging apply.",
                "next_actions": ["Describe the filters", "List matching records first"],
                "suggested_prompts": ["Show overdue invoices", "Dashboard summary"],
            }
        if intent_code == "ambiguous_count":
            return {
                "answer": "Which would you like me to count — customers, invoices, payments, subscriptions, contracts, or products?",
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": [],
                "qualification": "The reference was unclear.",
                "next_actions": [],
                "suggested_prompts": ["How many customers?", "How many invoices?", "Dashboard summary"],
            }
        if intent_code == "ambiguous_general":
            return {
                "answer": "What would you like to see — customers, invoices, payments, subscriptions, contracts, or products?",
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": [],
                "qualification": "The request was too broad.",
                "next_actions": [],
                "suggested_prompts": ["Show customers", "Show invoices", "Dashboard summary"],
            }

        # ── FIX #2: Balance / financial summary queries (M1 Inspect) ──────
        balance_keywords = ("balance", "how much", "outstanding", "owe", "owed", "due", "total due", "amount due", "what do i owe", "what do we owe")
        if any(kw in normalized for kw in balance_keywords):
            return self._lookup_account_balance(conv, ctx)

        # Try overdue FIRST (before invoice, since "overdue invoices" contains "invoice")
        if "overdue" in normalized or "past due" in normalized:
            return self._lookup_overdue(conv, ctx)

        # ── FIX #3: List queries vs single lookup ──────────────────────────
        invoice_ref = self._extract_reference(text, prefixes=("INV", "INVOICE"))
        if invoice_ref or "invoice" in normalized:
            is_list = (
                any(w in normalized for w in ("show", "list", "my", "all", "outstanding", "overdue"))
                or "invoices" in normalized
            )
            if is_list and not invoice_ref:
                return self._list_invoices(normalized, conv, ctx)
            return self._lookup_invoice(text, normalized, conv, ctx)

        # Try payment lookup
        payment_ref = self._extract_reference(text, prefixes=("PAY", "PMT", "PAYMENT"))
        if payment_ref or "payment" in normalized:
            is_list = any(w in normalized for w in ("show", "list", "my", "all")) or "payments" in normalized
            if is_list and not payment_ref:
                return self._list_payments(normalized, conv, ctx)
            return self._lookup_payment(text, normalized, conv, ctx)

        # Try customer lookup — detect list intent first (FIX: 'list customers'
        # / 'show customers' must return the customer list, not a failed single
        # lookup or RAG snippets). Plural 'customers'/'clients' or an explicit
        # list phrase → list; singular 'customer' + name → single lookup.
        if "customer" in normalized or "client" in normalized:
            is_list = (
                "customers" in normalized or "clients" in normalized
                or "customer list" in normalized or "client list" in normalized
                or "list of customers" in normalized or "list of clients" in normalized
                or "all my customers" in normalized or "all my clients" in normalized
            )
            if is_list:
                return self._list_customers(normalized, conv, ctx)
            return self._lookup_customer(text, normalized, conv, ctx)

        # Try subscription
        if "subscription" in normalized or "plan" in normalized:
            return self._lookup_subscription(text, normalized, conv, ctx)

        # Fallback: try knowledge retrieval for general billing questions —
        # confident matches only; weak matches abstain (see _handle_help).
        retrieval = self._retrieve(text, ctx, top_k=3)
        if retrieval.get("low_confidence"):
            return self._abstention_response()
        if retrieval["answer"]:
            return {
                "answer": retrieval["answer"],
                "mode": "M0_EXPLAIN",
                "risk_class": "R0",
                "evidence": retrieval["evidence"],
                "qualification": "This is product guidance based on Zoiko Billing documentation.",
                "next_actions": [],
                "suggested_prompts": ["Show overdue invoices", "Look up customer details", "Dashboard summary"],
            }
        return {
            "answer": "I can help with invoices, payments, customers, subscriptions, and more. Could you be more specific about what you'd like to look up?",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [],
            "qualification": None,
            "next_actions": [],
            "suggested_prompts": ["Show overdue invoices", "Look up customer details", "Dashboard summary"],
        }

    # ── FIX #2: Account balance lookup ────────────────────────────────

    def _lookup_account_balance(self, conv: AIConversation, ctx: AIContext) -> dict:
        """Return the total outstanding balance across all invoices for the org.

        Uses the SAME aggregation as the billing dashboard
        (BillingDashboardService.get_kpis) so this answer can never diverge
        from the 'Dashboard summary' answer or the dashboard page itself:
        outstanding = sum of balance_due for sent/overdue/partially_paid
        invoices, converted to the org's base currency. Drafts are excluded.
        """
        org_id = ctx.organization_id
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        svc = BillingDashboardService(self.db)
        kpis = svc.get_kpis(organization_id=org_id)

        total_outstanding = kpis.get("outstanding_amount", 0)
        total_overdue = kpis.get("overdue_amount", 0)

        invoice_count = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == org_id,
            Invoice.deleted_at.is_(None),
            Invoice.balance_due > 0,
            Invoice.status.in_(["sent", "overdue", "partially_paid"]),
        ).scalar() or 0

        if not total_outstanding:
            return {
                "answer": "Your account is in good standing — **no outstanding balance** across all invoices.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [{"source": "Zoiko Billing Invoices", "type": "balance_summary", "outstanding": "0"}],
            "qualification": (
                "Live aggregates from authoritative records — identical to the "
                "dashboard page. Revenue = issued invoice totals (drafts and "
                "cancelled excluded); outstanding = balance due on sent/overdue/"
                "partially-paid invoices."
            ),
                "next_actions": ["View dashboard summary"],
                "suggested_prompts": ["Dashboard summary", "Show all invoices"],
            }

        answer = f"**Account balance:** {money(total_outstanding)} outstanding across **{invoice_count} invoice(s)**."
        if total_overdue:
            answer += f"\n\n**Overdue:** {money(total_overdue)} — immediate attention recommended."
        else:
            answer += "\n\nAll invoices are within their payment terms."

        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Invoices",
                "type": "balance_summary",
                "as_of": datetime.now(timezone.utc).isoformat(),
                "outstanding": str(total_outstanding),
                "overdue": str(total_overdue),
                "invoice_count": invoice_count,
            }],
            "qualification": "Figures are current aggregates from authoritative records.",
            "next_actions": ["Drill into overdue invoices", "Review customer aging"],
            "suggested_prompts": ["Show overdue invoices", "Dashboard summary"],
        }

    # ── FIX #3: List queries ─────────────────────────────────────────

    def _list_invoices(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        """Return a list of invoices matching the query."""
        org_id = ctx.organization_id
        query = (
            self.db.query(Invoice)
            .options(selectinload(Invoice.customer))
            .filter(Invoice.organization_id == org_id, Invoice.deleted_at.is_(None))
        )

        if "outstanding" in normalized or "unpaid" in normalized or "pending" in normalized:
            query = query.filter(Invoice.balance_due > 0)
        elif "overdue" in normalized or "past due" in normalized:
            query = query.filter(Invoice.balance_due > 0, Invoice.due_date < date.today())

        invoices = query.order_by(Invoice.created_at.desc()).limit(10).all()

        if not invoices:
            return {
                "answer": "No invoices found matching that criteria.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Create an invoice"],
                "suggested_prompts": ["Draft an invoice", "Show overdue invoices"],
            }

        lines = []
        for inv in invoices:
            customer_name = inv.customer.company_name if inv.customer else "—"
            status = enum_value(inv.status)
            lines.append(f"- **{inv.invoice_number}** — {customer_name} — {status} — {money(inv.balance_due, inv.currency)} due")

        total = sum(Decimal(str(inv.balance_due or 0)) for inv in invoices)
        answer = f"Found **{len(invoices)} invoice(s)** (total outstanding: {money(total)}):\n\n" + "\n".join(lines)

        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Invoices",
                "type": "invoice_list",
                "count": len(invoices),
                "total_outstanding": str(total),
            }],
            "qualification": "Invoice data from authoritative records.",
            "next_actions": ["Drill into overdue invoices", "Draft a new invoice"],
            "suggested_prompts": ["Show overdue invoices", "Draft an invoice"],
        }

    def _list_payments(self, normalized: str, conv: AIConversation, ctx: AIContext, customer: BillingCustomer | None = None) -> dict:
        """Return a list of recent payments (optionally for a specific customer)."""
        org_id = ctx.organization_id
        query = (
            self.db.query(Payment)
            .options(selectinload(Payment.customer))
            .filter(Payment.organization_id == org_id, Payment.deleted_at.is_(None))
        )
        if customer is not None:
            query = query.filter(Payment.customer_id == customer.id)
        payments = query.order_by(Payment.created_at.desc()).limit(10).all()

        if not payments:
            target = f" for {customer.company_name}" if customer is not None else ""
            return {
                "answer": f"No payments found{target}.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Record a payment"],
                "suggested_prompts": [],
            }

        lines = []
        for p in payments:
            customer_name = p.customer.company_name if p.customer else "—"
            lines.append(f"- **{p.payment_number}** — {customer_name} — {money(p.amount, p.currency)} — {enum_value(p.status)}")

        total = sum(Decimal(str(p.amount or 0)) for p in payments)
        target = f" made by {customer.company_name}" if customer is not None else ""
        answer = f"Found **{len(payments)} payment(s){target}** (total: {money(total)}):\n\n" + "\n".join(lines)

        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Payments",
                "type": "payment_list",
                "count": len(payments),
                "total": str(total),
            }],
            "qualification": "Payment data from authoritative records.",
            "next_actions": ["Record a new payment"],
            "suggested_prompts": ["Show overdue invoices", "Dashboard summary"],
        }

    # ── Single-entity lookups ────────────────────────────────────────

    def _lookup_invoice(self, text: str, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        invoice_ref = self._extract_reference(text, prefixes=("INV", "INVOICE"))
        query = (
            self.db.query(Invoice)
            .options(selectinload(Invoice.customer))
            .filter(Invoice.organization_id == ctx.organization_id, Invoice.deleted_at.is_(None))
        )

        if invoice_ref:
            invoice = query.filter(func.lower(Invoice.invoice_number) == invoice_ref.lower()).first()
        else:
            invoice = query.order_by(Invoice.created_at.desc()).first()

        if not invoice:
            return {
                "answer": "No invoice found matching that reference. Please try an exact invoice number (e.g., INV-1001).",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "The assistant does not guess financial state.",
                "next_actions": ["Search by invoice number or customer name."],
                "suggested_prompts": [],
            }

        customer_name = invoice.customer.company_name if invoice.customer else "the customer"
        return {
            "answer": (
                f"**Invoice {invoice.invoice_number}** for {customer_name} — **{enum_value(invoice.status)}**\n\n"
                f"Total: {money(invoice.total_amount, invoice.currency)} | "
                f"Paid: {money(invoice.paid_amount, invoice.currency)} | "
                f"Balance Due: {money(invoice.balance_due, invoice.currency)}"
                + (f"\n\n**{ (date.today() - invoice.due_date).days } days overdue**" if invoice.due_date and invoice.balance_due and invoice.due_date < date.today() else "")
            ),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Invoices",
                "type": "invoice",
                "resource_id": invoice.id,
                "reference": invoice.invoice_number,
                "fields": {
                    "status": enum_value(invoice.status),
                    "customer_name": customer_name,
                    "total": str(invoice.total_amount or 0),
                    "paid": str(invoice.paid_amount or 0),
                    "balance": str(invoice.balance_due or 0),
                    "currency": invoice.currency,
                    "due_date": iso(invoice.due_date),
                },
            }],
            "qualification": "Financial state from authoritative Zoiko Billing invoice record.",
            "next_actions": [f"Open invoice /billing/invoices/{invoice.id}"],
            "suggested_prompts": ["Show overdue invoices", "Look up payment"],
        }

    def _lookup_payment(self, text: str, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        payment_ref = self._extract_reference(text, prefixes=("PAY", "PMT", "PAYMENT"))
        query = (
            self.db.query(Payment)
            .options(selectinload(Payment.customer), selectinload(Payment.allocations))
            .filter(Payment.organization_id == ctx.organization_id, Payment.deleted_at.is_(None))
        )

        if payment_ref:
            payment = query.filter(func.lower(Payment.payment_number) == payment_ref.lower()).first()
        else:
            payment = query.order_by(Payment.created_at.desc()).first()

        if not payment:
            return {
                "answer": "No payment found. Please try a payment number or transaction ID.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "The assistant does not guess.",
                "next_actions": ["Search by payment number or transaction ID."],
                "suggested_prompts": [],
            }

        allocated = sum(Decimal(str(a.amount or 0)) for a in payment.allocations)
        unallocated = Decimal(str(payment.amount or 0)) - allocated
        customer_name = payment.customer.company_name if payment.customer else "the customer"

        return {
            "answer": (
                f"**Payment {payment.payment_number}** for {customer_name} — **{enum_value(payment.status)}**\n\n"
                f"Amount: {money(payment.amount, payment.currency)} | "
                f"Allocated: {money(allocated, payment.currency)} | "
                f"Unallocated: {money(unallocated, payment.currency)}"
            ),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Payments",
                "type": "payment",
                "resource_id": payment.id,
                "reference": payment.payment_number,
                "fields": {
                    "status": enum_value(payment.status),
                    "amount": str(payment.amount or 0),
                    "allocated": str(allocated),
                    "unallocated": str(unallocated),
                    "currency": payment.currency,
                },
            }],
            "qualification": "Payment data from authoritative records.",
            "next_actions": [f"Open payment /billing/payments/{payment.id}"],
            "suggested_prompts": ["Show unapplied payments", "Explain payment allocations"],
        }

    def _resolve_customer(self, search_text: str, ctx: AIContext) -> BillingCustomer | None:
        """Resolve a customer from free-text search. Shared by lookup and draft creation.

        Searches display_name, company_name, customer_code, and email —
        case-insensitive, scoped to the tenant. Tries keyword-extracted
        terms first, then falls back to the raw search text for short names
        that may be stripped as stop-words (e.g. "Go", "Lo").
        """
        base_q = (
            self.db.query(BillingCustomer)
            .filter(
                BillingCustomer.organization_id == ctx.organization_id,
                BillingCustomer.deleted_at.is_(None),
            )
        )

        # Try meaningful keywords first
        terms = self._search_terms(search_text)
        if terms:
            pattern = f"%{terms}%"
            customer = base_q.filter(or_(
                BillingCustomer.display_name.ilike(pattern),
                BillingCustomer.company_name.ilike(pattern),
                BillingCustomer.customer_code.ilike(pattern),
                BillingCustomer.email.ilike(pattern),
            )).order_by(BillingCustomer.company_name.asc()).first()
            if customer:
                return customer

        # Fallback: try the raw customer name directly (handles short names
        # like "Go" that get stripped as stop-words by _search_terms).
        raw_name = search_text.strip().strip(".")
        if raw_name and raw_name.lower() != (terms or "").lower():
            pattern = f"%{raw_name}%"
            return base_q.filter(or_(
                BillingCustomer.display_name.ilike(pattern),
                BillingCustomer.company_name.ilike(pattern),
                BillingCustomer.customer_code.ilike(pattern),
                BillingCustomer.email.ilike(pattern),
            )).order_by(BillingCustomer.company_name.asc()).first()

        return None

    def _resolve_payment_customer(self, text: str, ctx: AIContext) -> BillingCustomer | None:
        """Resolve a customer mentioned after by/from/for/to in a payment
        question ('show payments made by Gok' -> GOk)."""
        m = re.search(
            r"\b(?:by|from|for|to)\s+([A-Za-z][\w@.' -]*?)\s*(?:on\b|for\b|in\b|with\b|\s*$)",
            text, flags=re.IGNORECASE,
        )
        if not m:
            return None
        name = m.group(1).strip().rstrip(".").strip()
        if not name or name.lower() in ("me", "my", "us", "them", "invoice", "payment", "the"):
            return None
        return self._resolve_customer(name, ctx)

    # ── List customers ───────────────────────────────────────────────

    def _list_customers(self, normalized: str, conv: AIConversation, ctx: AIContext, only_outstanding: bool = False) -> dict:
        """Return the list of customers for the org (FIX: 'list customers' /
        'show customers' previously returned 'No customer found' or RAG junk).
        When only_outstanding is True, returns customers with a live positive
        outstanding balance ('customers who owe money')."""
        org_id = ctx.organization_id
        customers = (
            self.db.query(BillingCustomer)
            .filter(
                BillingCustomer.organization_id == org_id,
                BillingCustomer.deleted_at.is_(None),
            )
            .order_by(BillingCustomer.company_name.asc())
            .limit(20)
            .all()
        )

        # Live per-customer outstanding (same aggregation as the dashboard
        # aggregate — never the stale cached column, Issue 1 consistency).
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        svc = BillingDashboardService(self.db)
        by_customer = {r["customer_id"]: r["outstanding"] for r in svc.get_outstanding_by_customer(org_id)}

        if only_outstanding:
            customers = [c for c in customers if by_customer.get(c.id, 0.0) > 0]
            if not customers:
                return {
                    "answer": "No customers have an outstanding balance — all customers are in good standing.",
                    "mode": "M1_INSPECT",
                    "risk_class": "R1",
                    "evidence": [],
                    "qualification": "No guess made.",
                    "next_actions": [],
                    "suggested_prompts": ["List all customers", "Dashboard summary"],
                }

        if not customers:
            return {
                "answer": "No customers found in your organization.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Create a customer"],
                "suggested_prompts": [],
            }

        lines = []
        for c in customers:
            outstanding = by_customer.get(c.id, 0.0)
            lines.append(
                f"- **{c.company_name}** ({c.customer_code}) — "
                f"Outstanding: {money(outstanding)} — {enum_value(c.status)}"
            )

        if only_outstanding:
            answer = f"Found **{len(customers)} customer(s) with an outstanding balance**:\n\n" + "\n".join(lines)
        else:
            answer = f"Found **{len(customers)} customer(s)** in your organization:\n\n" + "\n".join(lines)

        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Customers",
                "type": "customer_list",
                "count": len(customers),
            }],
            "qualification": "Customer data from authoritative records.",
            "next_actions": ["Look up a customer", "Show customers with outstanding balances"],
            "suggested_prompts": ["Look up customer details", "Dashboard summary"],
        }

    def _lookup_customer(self, text: str, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        terms = self._search_terms(text)
        query = self.db.query(BillingCustomer).filter(
            BillingCustomer.organization_id == ctx.organization_id,
            BillingCustomer.deleted_at.is_(None),
        )

        customer = None
        if terms:
            pattern = f"%{terms}%"
            customer = query.filter(or_(
                BillingCustomer.display_name.ilike(pattern),
                BillingCustomer.company_name.ilike(pattern),
                BillingCustomer.customer_code.ilike(pattern),
                BillingCustomer.email.ilike(pattern),
            )).first()

        # Fallback: try the raw text directly for short names stripped as stop-words
        if not customer:
            raw_name = text.strip()
            # Strip conversational fillers and command words to isolate the name
            raw_name = re.sub(
                r'^(do we have|do you have|is there|are there|have we got|is it)\s+(?:a|an|any)?\s+'
                r'(?:customer|client)?\s*(?:named|called|by the name of)?\s*', '', raw_name, flags=re.IGNORECASE,
            ).strip()
            raw_name = re.sub(
                r'^(show|find|search|lookup|look\s*up|list|get|check|view|see|details?\s*(?:for|of)?)\s+',
                '', raw_name, flags=re.IGNORECASE,
            ).strip()
            # Strip trailing command words
            raw_name = re.sub(
                r'\s+(details?|info|information|search|specific|open|check|view|see|record|profile)\s*$',
                '', raw_name, flags=re.IGNORECASE,
            ).strip()
            # Strip trailing "named/called" qualifiers left over
            raw_name = re.sub(r'\s*(?:named|called)\s*$', '', raw_name, flags=re.IGNORECASE).strip()
            # "what do you know about X" -> X
            raw_name = re.sub(r'^what do you know about\s+', '', raw_name, flags=re.IGNORECASE).strip()
            # "Gok's details" -> "Gok"
            raw_name = raw_name.replace("'s", "").replace("’s", "")
            if raw_name and raw_name.lower() != (terms or "").lower():
                pattern = f"%{raw_name}%"
                customer = query.filter(or_(
                    BillingCustomer.display_name.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                    BillingCustomer.customer_code.ilike(pattern),
                    BillingCustomer.email.ilike(pattern),
                )).first()

        if not customer:
            # "find a customer" with no name — ask for a name, don't guess.
            if not terms and not self._has_name_hint(text):
                return {
                    "answer": "I'd be happy to look up a customer. Which customer name, customer code, or email would you like me to search for?",
                    "mode": "M1_INSPECT",
                    "risk_class": "R1",
                    "evidence": [],
                    "qualification": "No customer identifier provided.",
                    "next_actions": [],
                    "suggested_prompts": ["Show customer GOk", "Find Acme Corp"],
                }
            return {
                "answer": "No customer found matching that name.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "The assistant does not guess.",
                "next_actions": ["Search by customer name or code."],
                "suggested_prompts": [],
            }

        # Live outstanding (same aggregation as dashboard — never the stale
        # cached column, Issue 1 consistency).
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        svc = BillingDashboardService(self.db)
        by_customer = {r["customer_id"]: r["outstanding"] for r in svc.get_outstanding_by_customer(ctx.organization_id)}
        outstanding = by_customer.get(customer.id, 0.0)

        return {
            "answer": (
                f"**Customer: {customer.company_name}** ({enum_value(customer.status)})\n\n"
                f"Outstanding: {money(outstanding)} | "
                f"Credit: {money(customer.credit_balance, customer.currency)}"
            ),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Customers",
                "type": "customer",
                "resource_id": customer.id,
                "reference": customer.customer_code,
                "fields": {
                    "status": enum_value(customer.status),
                    "outstanding": str(outstanding),
                    "credit": str(customer.credit_balance or 0),
                },
            }],
            "qualification": "Customer data from authoritative records.",
            "next_actions": [f"Open customer /billing/customers/{customer.id}"],
            "suggested_prompts": ["Show customer invoices", "Show customer payments"],
        }

    # ── Count handlers (live aggregates from authoritative records) ─────

    def _count_invoices(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        """Return the invoice count for the org (drafts excluded, matching the
        dashboard aggregate)."""
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        svc = BillingDashboardService(self.db)
        kpis = svc.get_kpis(organization_id=ctx.organization_id)
        total = kpis.get("total_invoices", 0)
        return {
            "answer": f"You currently have **{total} invoice(s)**.",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Invoices",
                "type": "invoice_count",
                "count": total,
            }],
            "qualification": "Count is a live aggregate from the invoice records.",
            "next_actions": ["Show invoices", "Show overdue invoices"],
            "suggested_prompts": ["Show invoices", "Show overdue invoices", "Dashboard summary"],
        }

    def _count_payments(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        total = self.db.query(func.count(Payment.id)).filter(
            Payment.organization_id == ctx.organization_id,
            Payment.deleted_at.is_(None),
        ).scalar() or 0
        return {
            "answer": f"You currently have **{total} payment(s)**.",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Payments", "type": "payment_count", "count": total}],
            "qualification": "Count is a live aggregate from the payment records.",
            "next_actions": ["Show payments", "Show unallocated payments"],
            "suggested_prompts": ["Show payments", "Dashboard summary"],
        }

    def _count_subscriptions(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        query = self.db.query(func.count(Subscription.id)).filter(Subscription.organization_id == ctx.organization_id)
        active = "active" in normalized or "active" in (normalized or "")
        if active:
            query = query.filter(Subscription.status == "active")
        total = query.scalar() or 0
        label = "active subscription(s)" if active else "subscription(s)"
        return {
            "answer": f"You currently have **{total} {label}**.",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Subscriptions", "type": "subscription_count", "count": total}],
            "qualification": "Count is a live aggregate from the subscription records.",
            "next_actions": ["Show subscriptions", "Show active subscriptions"],
            "suggested_prompts": ["Show subscriptions", "Show active subscriptions"],
        }

    def _count_contracts(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        total = self.db.query(func.count(Contract.id)).filter(
            Contract.organization_id == ctx.organization_id,
            Contract.deleted_at.is_(None),
        ).scalar() or 0
        return {
            "answer": f"You currently have **{total} contract(s)**.",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Contracts", "type": "contract_count", "count": total}],
            "qualification": "Count is a live aggregate from the contract records.",
            "next_actions": ["Show contracts", "Show active contracts"],
            "suggested_prompts": ["Show contracts", "Show active contracts"],
        }

    def _count_products(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        total = self.db.query(func.count(Product.id)).filter(
            Product.organization_id == ctx.organization_id,
            Product.deleted_at.is_(None),
        ).scalar() or 0
        return {
            "answer": f"You currently have **{total} product(s)** in your catalog.",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Products", "type": "product_count", "count": total}],
            "qualification": "Count is a live aggregate from the product records.",
            "next_actions": ["Show the catalog", "List products"],
            "suggested_prompts": ["Show the catalog", "List products"],
        }

    def _product_overview(self, conv: AIConversation, ctx: AIContext) -> dict:
        """Entity-qualified dashboard request ("product Dashboard"): summarize
        the product catalog instead of silently returning the generic billing
        financial summary (PRD §09 — Find/lookup family)."""
        total = self.db.query(func.count(Product.id)).filter(
            Product.organization_id == ctx.organization_id,
            Product.deleted_at.is_(None),
        ).scalar() or 0
        products = (
            self.db.query(Product)
            .filter(Product.organization_id == ctx.organization_id, Product.deleted_at.is_(None))
            .order_by(Product.created_at.desc())
            .limit(10)
            .all()
        )
        lines = []
        for p in products:
            price = money(p.unit_price, p.currency) if p.unit_price is not None else "—"
            lines.append(f"- **{p.name}** — {price}")
        answer = (
            f"Here's your **product catalog** ({total} product(s)):\n\n" + "\n".join(lines)
            if lines else "Your product catalog is currently empty."
        )
        return {
            "answer": answer,
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Products",
                "type": "product_overview",
                "as_of": datetime.now(timezone.utc).isoformat(),
                "count": total,
            }],
            "qualification": "Live product records. For the financial overview, ask for the 'billing dashboard'.",
            "next_actions": ["Billing dashboard summary", "Add a product"],
            "suggested_prompts": ["Dashboard summary", "Show invoices"],
        }

    # ── Subscription / Contract / Product lists ────────────────────────

    def _list_subscriptions(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        query = (
            self.db.query(Subscription)
            .options(selectinload(Subscription.customer))
            .filter(Subscription.organization_id == ctx.organization_id)
        )
        if "active" in normalized:
            query = query.filter(Subscription.status == "active")
        elif "inactive" in normalized or "cancelled" in normalized or "canceled" in normalized:
            query = query.filter(Subscription.status != "active")
        subs = query.order_by(Subscription.created_at.desc()).limit(20).all()
        if not subs:
            return {
                "answer": "No subscriptions found.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Create a subscription"],
                "suggested_prompts": [],
            }
        lines = []
        for s in subs:
            cust = s.customer.company_name if s.customer else "—"
            lines.append(f"- **{s.subscription_number}** — {cust} — {enum_value(s.status)} — {money(s.unit_price, s.currency)}/period")
        return {
            "answer": f"Found **{len(subs)} subscription(s)**:\n\n" + "\n".join(lines),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Subscriptions", "type": "subscription_list", "count": len(subs)}],
            "qualification": "Subscription data from authoritative records.",
            "next_actions": ["Show active subscriptions", "Look up subscription details"],
            "suggested_prompts": ["Show active subscriptions", "Dashboard summary"],
        }

    def _list_contracts(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        query = self.db.query(Contract).filter(
            Contract.organization_id == ctx.organization_id,
            Contract.deleted_at.is_(None),
        )
        if "active" in normalized:
            query = query.filter(Contract.status == "active")
        elif "expired" in normalized:
            query = query.filter(Contract.status == "expired")
        contracts = query.order_by(Contract.id.desc()).limit(20).all()
        if not contracts:
            return {
                "answer": "No contracts found.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Create a contract"],
                "suggested_prompts": [],
            }
        lines = []
        for c in contracts:
            cust_name = c.customer.company_name if c.customer else "—"
            lines.append(
                f"- **{c.contract_name}** ({c.contract_number}) — {cust_name} — "
                f"{enum_value(c.status)} — {money(c.value, c.currency)}"
            )
        return {
            "answer": f"Found **{len(contracts)} contract(s)**:\n\n" + "\n".join(lines),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Contracts", "type": "contract_list", "count": len(contracts)}],
            "qualification": "Contract data from authoritative records.",
            "next_actions": ["Show active contracts", "Look up contract details"],
            "suggested_prompts": ["Show active contracts", "Dashboard summary"],
        }

    def _list_products(self, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        products = (
            self.db.query(Product)
            .filter(Product.organization_id == ctx.organization_id, Product.deleted_at.is_(None))
            .order_by(Product.name.asc())
            .limit(20)
            .all()
        )
        if not products:
            return {
                "answer": "No products found in your catalog.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Create a product"],
                "suggested_prompts": [],
            }
        lines = []
        for p in products:
            price = getattr(p, "default_price", None)
            state = "active" if p.is_active else "inactive"
            lines.append(
                f"- **{p.name}** ({p.code}) — "
                f"{money(price, p.currency) if price is not None else '—'} — {state}"
            )
        return {
            "answer": f"Found **{len(products)} product(s)** in your catalog:\n\n" + "\n".join(lines),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{"source": "Zoiko Billing Products", "type": "product_list", "count": len(products)}],
            "qualification": "Product data from authoritative records.",
            "next_actions": ["Show product details", "Create a product"],
            "suggested_prompts": ["Show the catalog", "Dashboard summary"],
        }

    @staticmethod
    def _has_name_hint(text: str) -> bool:
        """True if the text contains a likely name token (not just stopwords)."""
        t = text.lower()
        t = re.sub(
            r"\b(customer|client|the|a|an|for|of|to|named|called|please|me|my|show|find|search|list|get|view|see|look|up|check|open|details|info|information|about|what|do|you|know|any|some)\b",
            " ", t,
        )
        t = re.sub(r"[^a-z0-9]", " ", t)
        return any(len(w) >= 2 for w in t.split())

    def _lookup_overdue(self, conv: AIConversation, ctx: AIContext) -> dict:
        invoices = (
            self.db.query(Invoice)
            .options(selectinload(Invoice.customer))
            .filter(
                Invoice.organization_id == ctx.organization_id,
                Invoice.deleted_at.is_(None),
                Invoice.balance_due > 0,
                Invoice.due_date < date.today(),
            )
            .order_by(Invoice.due_date.asc())
            .limit(10)
            .all()
        )

        if not invoices:
            return {
                "answer": "No overdue invoices found. All invoices are current.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "Current invoice due dates only.",
                "next_actions": ["Open the invoice dashboard."],
                "suggested_prompts": [],
            }

        total = sum(Decimal(str(inv.balance_due or 0)) for inv in invoices)
        return {
            "answer": f"Found **{len(invoices)} overdue invoice(s)** totaling **{money(total)}**. Oldest due: {iso(invoices[0].due_date)}.",
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Invoices",
                "type": "overdue_summary",
                "as_of": datetime.now(timezone.utc).isoformat(),
                "count": len(invoices),
                "total": str(total),
            }],
            "qualification": "Read-only summary of overdue invoices.",
            "next_actions": ["Open /billing/collections-receivables for collections prioritization"],
            "suggested_prompts": ["Show dunning cases", "Explain dunning process"],
        }

    def _lookup_subscription(self, text: str, normalized: str, conv: AIConversation, ctx: AIContext) -> dict:
        terms = self._search_terms(text)
        query = self.db.query(Subscription).filter(Subscription.organization_id == ctx.organization_id)

        if terms:
            pattern = f"%{terms}%"
            sub = query.filter(Subscription.subscription_number.ilike(pattern)).first()
        else:
            sub = query.filter(Subscription.status == "active").first()

        if not sub:
            return {
                "answer": "No matching subscription found.",
                "mode": "M1_INSPECT",
                "risk_class": "R1",
                "evidence": [],
                "qualification": "No guess made.",
                "next_actions": ["Search by subscription number."],
                "suggested_prompts": [],
            }

        return {
            "answer": (
                f"**Subscription {sub.subscription_number}** — {enum_value(sub.status)}\n\n"
                f"Amount: {money(sub.unit_price, sub.currency)}/period | "
                f"Start: {iso(sub.start_date)} | End: {iso(sub.current_term_end)}"
            ),
            "mode": "M1_INSPECT",
            "risk_class": "R1",
            "evidence": [{
                "source": "Zoiko Billing Subscriptions",
                "type": "subscription",
                "resource_id": sub.id,
                "reference": sub.subscription_number,
                "fields": {"status": enum_value(sub.status), "amount": str(sub.unit_price or 0)},
            }],
            "qualification": "Subscription data from authoritative records.",
            "next_actions": [f"Open subscription /billing/subscriptions/{sub.id}"],
            "suggested_prompts": ["Show active subscriptions", "Subscription renewal dates"],
        }

    # ── Helpers ────────────────────────────────────────────────────────

    def _get_conversation(self, conversation_uid: str, ctx: AIContext) -> AIConversation | None:
        return (
            self.db.query(AIConversation)
            .filter(
                AIConversation.conversation_uid == conversation_uid,
                AIConversation.organization_id == ctx.organization_id,
                AIConversation.user_id == ctx.user_id,
            )
            .first()
        )

    def _extract_reference(self, text: str, *, prefixes: tuple[str, ...]) -> str | None:
        prefix_pattern = "|".join(re.escape(p) for p in prefixes)
        match = re.search(rf"\b({prefix_pattern})[-_ ]?([A-Za-z0-9][-A-Za-z0-9]*)\b", text, flags=re.IGNORECASE)
        if not match:
            return None
        raw = match.group(0)
        prefix = match.group(1).upper()
        value = match.group(2).upper()
        # FIX: reject plural words like "invoices"/"payments" which parse as
        # prefix+"S" (e.g. "show invoices" must be a LIST, not a reference
        # "INV-S"). A valid reference carries a digit or a separator.
        if value.isalpha() and not re.search(r"[-_ ]", raw):
            return None
        if prefix == "INVOICE":
            return f"INV-{value}"
        if prefix == "PAYMENT":
            return f"PAY-{value}"
        return f"{prefix}-{value}"

    def _search_terms(self, text: str) -> str:
        cleaned = re.sub(
            r"\b(invoice|payment|customer|client|account|balance|status|show|find|lookup|why|does|owe|paid|for|the|a|an|me|please|subscription|contract|product|quotation|credit|refund|dunning|overdue|number|code|name|list|all|any|some|what|about|get|give|tell|want|need|can|could|would|should|how|when|where|who|which|is|are|was|were|has|have|had|do|does|did|will|shall|may|might|must|there|here|this|that|these|those|it|its|my|your|our|their|details|look|up|info|information|search|specific|open|check|view|see|want|named|called|know|records?|profile)\b",
            " ", text, flags=re.IGNORECASE,
        )
        cleaned = re.sub(r"[^A-Za-z0-9@._ -]", " ", cleaned)
        return re.sub(r"\s+", " ", cleaned).strip()[:120]

    def _audit(self, event_type: AuditEventType, conv: AIConversation | None, ctx: AIContext, payload: dict) -> None:
        event = AIAuditEvent(
            event_uid=_uid(),
            conversation_id=conv.id if conv else None,
            tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            event_type=event_type,
            event_payload=payload,
            correlation_id=ctx.request_id,
        )
        self.db.add(event)

    def _escalation_response(self, *, conversation_uid: str, ctx: AIContext, answer: str) -> dict:
        return {
            "message_uid": _uid(),
            "answer": answer,
            "mode": "M5_ESCALATE",
            "risk_class": "R0",
            "evidence": [],
            "next_actions": ["Use an organization-scoped billing user."],
            "qualification": None,
            "suggested_prompts": [],
        }
