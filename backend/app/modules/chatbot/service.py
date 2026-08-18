"""
chatbot/service.py
------------------
Enterprise chatbot service implementing governed orchestration for
the Zoiko Billing Platform.

Architecture per ZB-AI-ARCH-001:
  - Conversations persisted with full audit trail
  - Intent classification routes to domain-specific handlers
  - Every response grounded in authoritative billing data
  - Permission-scoped: organization_id from authenticated user
  - Risk classes enforced server-side (never delegated to model)
  - Read-only Phase A MVP with Phase B foundations (action drafts)

Domain handlers:
  - Help/knowledge: product guidance, workflows, billing concepts
  - Invoice: lookup, balance explanation, overdue analysis
  - Payment: lookup, allocation explanation, unapplied amounts
  - Customer: lookup, summary, relationship overview
  - Subscription: status, plan details, renewal
  - Product: catalog search, pricing lookup
  - Contract: terms, status, amendments
  - Dashboard: financial summary, aging, KPIs
  - Quotation: lookup, status, conversion
  - Credit/Refund: eligibility explanation (no execution)
"""

from __future__ import annotations

import hashlib
import re
import uuid
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, or_, and_, case
from sqlalchemy.orm import Session, selectinload

from app.modules.billing.models import (
    BillingCustomer,
    Invoice,
    InvoiceItem,
    Payment,
    PaymentAllocation,
    Subscription,
    SubscriptionPlan,
    Contract,
    ContractItem,
    Product,
    ProductCategory,
    Quotation,
    CreditNote,
    Refund,
    DunningCase,
    CollectionsCase,
    BillingAuditLog,
)
from app.modules.organizations.models import Organization

from .models import (
    Conversation,
    ConversationMessage,
    ActionDraft,
    ChatbotAuditEvent,
    ConversationStatus,
    SenderType,
    RiskClass,
    AuthorityMode,
    ActionDraftStatus,
    AuditEventType,
)
from .schemas import (
    ChatbotContext,
    ChatbotEvidence,
    ChatbotResponse,
    SessionSummary,
    SessionDetail,
    MessageResponse,
    Capability,
    CapabilitiesResponse,
)


# ── Constants ────────────────────────────────────────────────────────────────

ROLE_PERMISSIONS = {
    "org_admin": [
        "billing:read", "billing:draft", "billing:admin",
        "invoice:read", "payment:read", "customer:read",
        "contract:read", "subscription:read", "product:read",
        "quotation:read", "credit:read", "refund:read",
    ],
    "billing_admin": [
        "billing:read", "billing:draft",
        "invoice:read", "payment:read", "customer:read",
        "contract:read", "subscription:read", "product:read",
        "quotation:read", "credit:read", "refund:read",
    ],
    "super_admin": ["platform:read", "billing:read"],
}

# Intent classification patterns — ordered by specificity
INTENT_PATTERNS = [
    {
        "intent": "help_what_can_you_do",
        "keywords": ("what can you do", "help", "capabilities", "features", "how do you work", "what are you"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "help_partial_payment",
        "keywords": ("partial payment", "partially paid", "partially allocated"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "help_payment_evidence",
        "keywords": ("payment evidence", "i paid", "paid claim", "remittance"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "help_issued_invoice",
        "keywords": ("change issued invoice", "edit issued invoice", "overcharged", "correct invoice", "invoice correction"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "help_refund_policy",
        "keywords": ("refund policy", "how to refund", "refund process", "refund eligibility"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "help_reconciliation",
        "keywords": ("reconcile", "reconciliation", "matching", "bank match"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "help_dunning",
        "keywords": ("dunning", "collection", "overdue process", "payment reminder", "late payment"),
        "domain": "help",
        "risk_class": RiskClass.R0,
    },
    {
        "intent": "dashboard_summary",
        "keywords": ("summary", "overview", "dashboard", "financial overview", "how are we doing", "kpi", "metrics"),
        "domain": "dashboard",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "overdue_summary",
        "keywords": ("overdue", "past due", "due this week", "aging", "outstanding balance"),
        "domain": "invoice",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "invoice_lookup",
        "keywords": ("invoice", "balance", "owe", "billed", "billing"),
        "domain": "invoice",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "payment_lookup",
        "keywords": ("payment", "transaction", "allocation", "paid", "received"),
        "domain": "payment",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "customer_lookup",
        "keywords": ("customer", "client", "account", "company"),
        "domain": "customer",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "subscription_lookup",
        "keywords": ("subscription", "plan", "renewal", "subscriber", "recurring"),
        "domain": "subscription",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "contract_lookup",
        "keywords": ("contract", "agreement", "terms", "amendment", "retainer"),
        "domain": "contract",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "product_lookup",
        "keywords": ("product", "catalog", "pricing plan", "item", "sku"),
        "domain": "product",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "quotation_lookup",
        "keywords": ("quotation", "quote", "estimate", "proposal"),
        "domain": "quotation",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "credit_note_lookup",
        "keywords": ("credit note", "credit", "adjustment"),
        "domain": "credit",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "refund_lookup",
        "keywords": ("refund", "reimburse", "return payment"),
        "domain": "refund",
        "risk_class": RiskClass.R1,
    },
    {
        "intent": "dunning_lookup",
        "keywords": ("dunning case", "collections case", "dunning level"),
        "domain": "collections",
        "risk_class": RiskClass.R1,
    },
]

# Suggested prompts per domain for follow-up guidance
DOMAIN_SUGGESTIONS = {
    "help": [
        "Show overdue invoices",
        "Look up customer details",
        "What is the payment allocation policy?",
    ],
    "dashboard": [
        "Show overdue invoices",
        "List recent payments",
        "What customers have outstanding balances?",
    ],
    "invoice": [
        "Show overdue invoices",
        "Look up invoice by number",
        "Explain invoice balances",
    ],
    "payment": [
        "Find payment by transaction ID",
        "Show unapplied payments",
        "Explain payment allocations",
    ],
    "customer": [
        "Show customer invoices",
        "List active customers",
        "Customer payment history",
    ],
    "subscription": [
        "Show active subscriptions",
        "Subscription renewal dates",
        "Plan details",
    ],
    "contract": [
        "Show active contracts",
        "Contract terms and conditions",
        "Contract amendments",
    ],
    "product": [
        "List product catalog",
        "Product pricing details",
        "Product categories",
    ],
    "quotation": [
        "Show pending quotations",
        "Quotation conversion rate",
        "Create quotation estimate",
    ],
    "credit": [
        "Credit note policy",
        "Show recent credit notes",
        "Credit vs refund",
    ],
    "refund": [
        "Refund eligibility criteria",
        "Show recent refunds",
        "Refund process overview",
    ],
    "collections": [
        "Show dunning cases",
        "Collections priority list",
        "Dunning level policy",
    ],
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def role_value(user) -> str:
    role = getattr(user, "role", "") or ""
    return role.value if hasattr(role, "value") else str(role)


def enum_value(value) -> str | None:
    if value is None:
        return None
    return value.value if hasattr(value, "value") else str(value)


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


def _uid() -> str:
    return str(uuid.uuid4())


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ── Service ──────────────────────────────────────────────────────────────────

class ChatbotService:
    def __init__(self, db: Session):
        self.db = db

    # ── Session Management ───────────────────────────────────────────────

    def create_session(self, *, current_user, title: str | None = None, initial_message: str | None = None, request_id: str | None = None) -> SessionDetail:
        context = self._context(current_user=current_user, request_id=request_id)
        conversation = Conversation(
            conversation_uid=_uid(),
            organization_id=context.organization_id,
            user_id=context.user_id,
            title=title or "New Conversation",
            status=ConversationStatus.OPEN,
        )
        self.db.add(conversation)
        self.db.flush()

        self._audit(AuditEventType.SESSION_CREATED, conversation, context, {"title": title})

        messages = []
        if initial_message:
            msg_response = self._process_message(
                conversation=conversation,
                text=initial_message,
                context=context,
            )
            # Store the assistant response as a message
            messages.append(MessageResponse(
                message_uid=msg_response.message_uid,
                sender_type="assistant",
                message_text=msg_response.answer,
                mode=msg_response.mode,
                risk_class=msg_response.risk_class,
                structured_payload={
                    "evidence": [e.model_dump() for e in msg_response.evidence],
                    "next_actions": msg_response.next_actions,
                    "qualification": msg_response.qualification,
                    "suggested_prompts": msg_response.suggested_prompts,
                },
                created_at=conversation.updated_at,
            ))

        self.db.commit()
        self.db.refresh(conversation)

        return SessionDetail(
            conversation_uid=conversation.conversation_uid,
            title=conversation.title,
            status=enum_value(conversation.status),
            primary_domain=conversation.primary_domain,
            highest_risk_class=enum_value(conversation.highest_risk_class),
            messages=messages,
            created_at=conversation.created_at,
            updated_at=conversation.updated_at,
        )

    def list_sessions(self, *, current_user, limit: int = 20, offset: int = 0) -> list[SessionSummary]:
        context = self._context(current_user=current_user, request_id=None)
        conversations = (
            self.db.query(Conversation)
            .filter(
                Conversation.organization_id == context.organization_id,
                Conversation.user_id == context.user_id,
                Conversation.status != ConversationStatus.ARCHIVED,
            )
            .order_by(Conversation.updated_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        return [
            SessionSummary(
                conversation_uid=c.conversation_uid,
                title=c.title,
                status=enum_value(c.status),
                primary_domain=c.primary_domain,
                highest_risk_class=enum_value(c.highest_risk_class),
                message_count=c.message_count or 0,
                created_at=c.created_at,
                updated_at=c.updated_at,
            )
            for c in conversations
        ]

    def get_session(self, *, conversation_uid: str, current_user, request_id: str | None = None) -> SessionDetail | None:
        context = self._context(current_user=current_user, request_id=request_id)
        conversation = self._get_conversation(conversation_uid, context)
        if not conversation:
            return None

        db_messages = (
            conversation.messages
            .order_by(ConversationMessage.created_at.asc())
            .all()
        )
        messages = [
            MessageResponse(
                message_uid=m.message_uid,
                sender_type=enum_value(m.sender_type),
                message_text=m.message_text,
                mode=m.mode,
                risk_class=enum_value(m.risk_class),
                structured_payload=m.structured_payload,
                created_at=m.created_at,
            )
            for m in db_messages
        ]

        return SessionDetail(
            conversation_uid=conversation.conversation_uid,
            title=conversation.title,
            status=enum_value(conversation.status),
            primary_domain=conversation.primary_domain,
            highest_risk_class=enum_value(conversation.highest_risk_class),
            messages=messages,
            created_at=conversation.created_at,
            updated_at=conversation.updated_at,
        )

    def close_session(self, *, conversation_uid: str, current_user, request_id: str | None = None) -> bool:
        context = self._context(current_user=current_user, request_id=request_id)
        conversation = self._get_conversation(conversation_uid, context)
        if not conversation:
            return False
        conversation.status = ConversationStatus.RESOLVED
        self._audit(AuditEventType.SESSION_CLOSED, conversation, context, {})
        self.db.commit()
        return True

    # ── Message Processing ───────────────────────────────────────────────

    def respond(self, *, conversation_uid: str, message: str, current_user, request_id: str | None = None) -> ChatbotResponse:
        context = self._context(current_user=current_user, request_id=request_id)

        if not context.organization_id:
            return self._escalation_response(
                conversation_uid=conversation_uid,
                context=context,
                answer="I can explain Zoiko Billing concepts, but I cannot inspect tenant billing records until an organization context is explicitly selected.",
                qualification="No tenant context is bound to this authenticated user.",
            )

        conversation = self._get_conversation(conversation_uid, context)
        if not conversation:
            return self._escalation_response(
                conversation_uid=conversation_uid,
                context=context,
                answer="Conversation not found or access denied.",
                qualification="The conversation may have been closed or belongs to another organization.",
            )

        # Store user message
        user_msg = ConversationMessage(
            conversation_id=conversation.id,
            message_uid=_uid(),
            sender_type=SenderType.USER,
            message_text=message,
        )
        self.db.add(user_msg)
        self.db.flush()

        self._audit(AuditEventType.MESSAGE_SENT, conversation, context, {
            "sender": "user", "message_length": len(message)
        })

        # Process and generate response
        response = self._process_message(
            conversation=conversation,
            text=message,
            context=context,
        )

        # Update conversation metadata
        conversation.message_count = (conversation.message_count or 0) + 2
        if response.risk_class in ("R1", "R2", "R3", "R4"):
            current_risk = enum_value(conversation.highest_risk_class) or "R0"
            risk_order = {"R0": 0, "R1": 1, "R2": 2, "R3": 3, "R4": 4, "RX": 5}
            if risk_order.get(response.risk_class, 0) > risk_order.get(current_risk, 0):
                conversation.highest_risk_class = RiskClass(response.risk_class)

        self.db.commit()

        return response

    def _process_message(self, *, conversation: Conversation, text: str, context: ChatbotContext) -> ChatbotResponse:
        normalized = text.strip().lower()

        # Classify intent
        intent = self._classify_intent(normalized, text)

        # Route to domain handler
        if intent["domain"] == "help":
            result = self._handle_help(intent, text, normalized, conversation, context)
        elif intent["domain"] == "dashboard":
            result = self._handle_dashboard(text, normalized, conversation, context)
        elif intent["domain"] == "invoice":
            result = self._handle_invoice(text, normalized, conversation, context)
        elif intent["domain"] == "payment":
            result = self._handle_payment(text, normalized, conversation, context)
        elif intent["domain"] == "customer":
            result = self._handle_customer(text, normalized, conversation, context)
        elif intent["domain"] == "subscription":
            result = self._handle_subscription(text, normalized, conversation, context)
        elif intent["domain"] == "contract":
            result = self._handle_contract(text, normalized, conversation, context)
        elif intent["domain"] == "product":
            result = self._handle_product(text, normalized, conversation, context)
        elif intent["domain"] == "quotation":
            result = self._handle_quotation(text, normalized, conversation, context)
        elif intent["domain"] == "credit":
            result = self._handle_credit(text, normalized, conversation, context)
        elif intent["domain"] == "refund":
            result = self._handle_refund(text, normalized, conversation, context)
        elif intent["domain"] == "collections":
            result = self._handle_collections(text, normalized, conversation, context)
        else:
            result = self._handle_fallback(text, normalized, conversation, context)

        # Store assistant message
        assistant_msg = ConversationMessage(
            conversation_id=conversation.id,
            message_uid=_uid(),
            sender_type=SenderType.ASSISTANT,
            message_text=result.answer,
            mode=result.mode,
            risk_class=RiskClass(result.risk_class),
            contains_financial_data=result.risk_class in ("R1", "R2", "R3", "R4"),
            structured_payload={
                "evidence_count": len(result.evidence),
                "next_actions_count": len(result.next_actions),
                "qualification": result.qualification,
            },
        )
        self.db.add(assistant_msg)
        self.db.flush()

        self._audit(AuditEventType.INTENT_CLASSIFIED, conversation, context, {
            "intent": intent["intent"],
            "domain": intent["domain"],
            "risk_class": result.risk_class,
        })

        return result

    # ── Intent Classification ────────────────────────────────────────────

    def _classify_intent(self, normalized: str, text: str) -> dict:
        for pattern in INTENT_PATTERNS:
            if any(kw in normalized for kw in pattern["keywords"]):
                return {
                    "intent": pattern["intent"],
                    "domain": pattern["domain"],
                    "risk_class": pattern["risk_class"],
                }

        # Fallback: if we have a reference pattern, use it
        if self._extract_reference(text, prefixes=("INV", "INVOICE")):
            return {"intent": "invoice_lookup", "domain": "invoice", "risk_class": RiskClass.R1}
        if self._extract_reference(text, prefixes=("PAY", "PMT", "PAYMENT")):
            return {"intent": "payment_lookup", "domain": "payment", "risk_class": RiskClass.R1}
        if self._extract_reference(text, prefixes=("QTE", "QUOTE")):
            return {"intent": "quotation_lookup", "domain": "quotation", "risk_class": RiskClass.R1}
        if self._extract_reference(text, prefixes=("CN", "CREDIT")):
            return {"intent": "credit_note_lookup", "domain": "credit", "risk_class": RiskClass.R1}
        if self._extract_reference(text, prefixes=("CTR", "CONTRACT")):
            return {"intent": "contract_lookup", "domain": "contract", "risk_class": RiskClass.R1}

        # Generic: try customer lookup as last resort
        return {"intent": "customer_lookup", "domain": "customer", "risk_class": RiskClass.R1}

    # ── Domain Handlers ──────────────────────────────────────────────────

    def _handle_help(self, intent: dict, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        topic = intent["intent"]

        help_data = {
            "help_what_can_you_do": {
                "answer": (
                    "I am the Zoiko Billing AI Assistant — a governed billing operations helper. "
                    "Here is what I can do:\n\n"
                    "**Read & Explain (Phase A):**\n"
                    "- Look up invoices, payments, customers, subscriptions, contracts, products, and quotations\n"
                    "- Explain invoice balances, payment allocations, overdue status, and aging\n"
                    "- Summarize your financial dashboard and KPIs\n"
                    "- Explain billing workflows, policies, and dunning processes\n"
                    "- Guide you through credit note, refund, and collections procedures\n\n"
                    "**Prepare & Preview (Phase B foundations):**\n"
                    "- Prepare invoice drafts with line items and totals\n"
                    "- Preview the financial impact of proposed actions\n"
                    "- Generate quotation estimates from conversations\n\n"
                    "**Governed by design:**\n"
                    "- Every answer is grounded in authoritative Zoiko Billing records\n"
                    "- Your tenant context is enforced — I never cross organization boundaries\n"
                    "- No financial action executes without explicit confirmation\n"
                    "- Full audit trail for every interaction"
                ),
                "summary": "Comprehensive capability overview from Zoiko Billing chatbot doctrine.",
                "next_actions": [
                    "Try: 'Show overdue invoices' for aging summary",
                    "Try: 'Look up customer Acme Corp' for customer details",
                    "Try: 'Dashboard summary' for financial overview",
                    "Try: 'Invoice INV-1001' for specific record lookup",
                ],
            },
            "help_partial_payment": {
                "answer": (
                    "A **partial payment** means approved payment evidence has been recorded for less than "
                    "the invoice total. The invoice remains open until allocations, credits, or write-offs "
                    "reduce the balance due to zero.\n\n"
                    "**Key rules:**\n"
                    "- Payment status must come from authorized Zoiko Billing payment records\n"
                    "- A payment message or remittance claim is not payment state by itself\n"
                    "- Partial allocations reduce balance but do not close the invoice\n"
                    "- Unallocated amounts appear as credit on the customer account"
                ),
                "summary": "Partial-payment guidance from Zoiko Billing PRD and guardrail doctrine.",
                "next_actions": [
                    "Open the invoice record to review allocations",
                    "Use the Payments area to inspect payment evidence and unallocated amounts",
                ],
            },
            "help_payment_evidence": {
                "answer": (
                    "A message or remittance claim is **not** payment state by itself. "
                    "Payment status must come from approved Zoiko Billing payment records, "
                    "processor evidence, and allocations.\n\n"
                    "**What counts as evidence:**\n"
                    "- Stripe/payment processor transaction confirmation\n"
                    "- Bank transfer with matching reference\n"
                    "- Cash receipt recorded through Zoiko Billing\n"
                    "- Allocated payment records with transaction IDs"
                ),
                "summary": "Payment-evidence rule from Zoiko Billing PRD and guardrails.",
                "next_actions": [
                    "Search for the payment record or transaction ID",
                    "Review allocations before treating an invoice as paid",
                ],
            },
            "help_issued_invoice": {
                "answer": (
                    "Issued invoices should **not** be silently rewritten. Corrections must use "
                    "governed credit, void, debit, replacement, or adjustment workflows according "
                    "to the invoice state and policy.\n\n"
                    "**Correction workflows:**\n"
                    "- **Credit Note:** For overcharges or billing errors on issued invoices\n"
                    "- **Void:** For invoices that should never have been issued (if state allows)\n"
                    "- **Debit Note:** For additional charges that need to be added\n"
                    "- **Replacement:** Issue a new invoice and void the original"
                ),
                "summary": "Issued-record integrity rule from Zoiko Billing PRD and guardrails.",
                "next_actions": [
                    "Open the issued invoice and choose the applicable correction workflow",
                    "Prepare a credit or adjustment only after reviewing the authoritative invoice state",
                ],
            },
            "help_refund_policy": {
                "answer": (
                    "**Refund eligibility** depends on several factors:\n"
                    "- The payment must have been recorded and allocated in Zoiko Billing\n"
                    "- Refunds require authorized approval (typically org_admin or higher)\n"
                    "- Partial refunds are supported for partially allocated payments\n"
                    "- Refunds create an audit trail and cannot be reversed from chat\n\n"
                    "**Process:**\n"
                    "1. Verify payment exists and is refund-eligible\n"
                    "2. Calculate refund amount (full or partial)\n"
                    "3. Submit for approval with reason\n"
                    "4. Execute through the governed refund workflow"
                ),
                "summary": "Refund policy guidance from Zoiko Billing guardrails.",
                "next_actions": [
                    "Look up the specific payment to verify refund eligibility",
                    "Review the refund workflow in billing settings",
                ],
            },
            "help_reconciliation": {
                "answer": (
                    "**Reconciliation** in Zoiko Billing matches payment records against invoices "
                    "to ensure accurate financial state.\n\n"
                    "**Types:**\n"
                    "- **Payment allocation:** Match payments to specific invoices\n"
                    "- **Bank reconciliation:** Match bank statements to recorded payments\n"
                    "- **Credit application:** Apply credit notes to open invoices\n\n"
                    "**Rules:**\n"
                    "- Only authorized users can commit reconciliation\n"
                    "- Each match requires evidence (transaction reference, amount, date)\n"
                    "- Reconciliation creates an immutable audit trail"
                ),
                "summary": "Reconciliation process guidance from Zoiko Billing knowledge base.",
                "next_actions": [
                    "Review unallocated payments for matching opportunities",
                    "Check the reconciliation dashboard for pending matches",
                ],
            },
            "help_dunning": {
                "answer": (
                    "**Dunning** is the process of pursuing overdue payments. "
                    "Zoiko Billing automates escalation through configurable dunning levels.\n\n"
                    "**How it works:**\n"
                    "- Invoices past due date enter the dunning pipeline\n"
                    "- Escalation levels (1-4) with increasing urgency\n"
                    "- Each level can trigger reminders, fee application, or suspension\n"
                    "- Promise-to-pay agreements pause escalation\n\n"
                    "**Collections** is the final stage for seriously overdue accounts."
                ),
                "summary": "Dunning and collections guidance from Zoiko Billing knowledge base.",
                "next_actions": [
                    "View dunning cases in the collections dashboard",
                    "Review dunning level configuration in billing settings",
                ],
            },
        }

        data = help_data.get(topic, help_data["help_what_can_you_do"])
        return self._build_response(
            conv=conv,
            ctx=ctx,
            mode="M0_EXPLAIN",
            risk_class="R0",
            answer=data["answer"],
            evidence=[ChatbotEvidence(source="Zoiko Billing Knowledge Base", resource_type="knowledge", summary=data["summary"])],
            qualification="This is product guidance, not tax, legal, or accounting advice.",
            next_actions=data["next_actions"],
        )

    def _handle_dashboard(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        org_id = ctx.organization_id

        # Aggregate metrics
        total_invoices = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == org_id, Invoice.deleted_at.is_(None)
        ).scalar() or 0

        total_revenue = self.db.query(func.coalesce(func.sum(Invoice.total_amount), 0)).filter(
            Invoice.organization_id == org_id, Invoice.deleted_at.is_(None), Invoice.status == "paid"
        ).scalar() or 0

        outstanding = self.db.query(func.coalesce(func.sum(Invoice.balance_due), 0)).filter(
            Invoice.organization_id == org_id, Invoice.deleted_at.is_(None), Invoice.balance_due > 0
        ).scalar() or 0

        overdue_count = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == org_id, Invoice.deleted_at.is_(None),
            Invoice.balance_due > 0, Invoice.due_date < date.today()
        ).scalar() or 0

        total_customers = self.db.query(func.count(BillingCustomer.id)).filter(
            BillingCustomer.organization_id == org_id, BillingCustomer.deleted_at.is_(None)
        ).scalar() or 0

        active_subscriptions = self.db.query(func.count(Subscription.id)).filter(
            Subscription.organization_id == org_id,
            Subscription.status == "active"
        ).scalar() or 0

        total_payments = self.db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
            Payment.organization_id == ctx.organization_id, Payment.deleted_at.is_(None), Payment.status == "cleared"
        ).scalar() or 0

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Dashboard",
                resource_type="dashboard_summary",
                summary="Aggregated financial metrics for the current tenant.",
                fields={
                    "total_invoices": total_invoices,
                    "total_revenue": str(total_revenue),
                    "outstanding_balance": str(outstanding),
                    "overdue_invoices": overdue_count,
                    "total_customers": total_customers,
                    "active_subscriptions": active_subscriptions,
                    "total_payments_received": str(total_payments),
                },
            )
        ]

        answer = (
            f"Here is your financial overview for **{ctx.tenant_name or 'your organization'}**:\n\n"
            f"**Invoices:** {total_invoices} total | **Revenue:** {money(total_revenue)} | "
            f"**Outstanding:** {money(outstanding)} | **Overdue:** {overdue_count}\n\n"
            f"**Customers:** {total_customers} | **Active Subscriptions:** {active_subscriptions} | "
            f"**Payments Received:** {money(total_payments)}"
        )

        if overdue_count > 0:
            answer += f"\n\n**Attention needed:** {overdue_count} invoice(s) are overdue with outstanding balance."

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Figures are current aggregates from authoritative Zoiko Billing records.",
            next_actions=[
                "Drill into overdue invoices for collections prioritization",
                "Review customer aging for credit risk assessment",
                "Check the detailed reports for trend analysis",
            ],
        )

    def _handle_invoice(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        # Check for overdue summary intent
        if "overdue" in normalized or "past due" in normalized or "aging" in normalized:
            return self._overdue_summary(conv, ctx)

        invoice_ref = self._extract_reference(text, prefixes=("INV", "INVOICE"))

        query = (
            self.db.query(Invoice)
            .options(selectinload(Invoice.customer), selectinload(Invoice.payment_allocations))
            .filter(Invoice.organization_id == ctx.organization_id, Invoice.deleted_at.is_(None))
        )

        if invoice_ref:
            invoice_refs = {invoice_ref.lower(), invoice_ref.replace("-", "").lower()}
            invoice = query.filter(func.lower(Invoice.invoice_number).in_(invoice_refs)).first()
        else:
            terms = self._search_terms(text)
            if not terms:
                return self._overdue_summary(conv, ctx)
            pattern = f"%{terms}%"
            invoice = (
                query.join(BillingCustomer, BillingCustomer.id == Invoice.customer_id)
                .filter(or_(
                    Invoice.invoice_number.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                    BillingCustomer.display_name.ilike(pattern),
                ))
                .order_by(Invoice.created_at.desc())
                .first()
            )

        if not invoice:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="I could not find an invoice matching that reference. Please try an exact invoice number (e.g., INV-1001) or customer name.",
                evidence=[], qualification="The assistant does not guess financial state.",
                next_actions=["Search by invoice number, customer name, or try 'Show overdue invoices'."],
            )

        evidence = self._invoice_evidence(invoice)
        customer_name = invoice.customer.company_name if invoice.customer else "the customer"
        status = enum_value(invoice.status)
        balance = money(invoice.balance_due, invoice.currency)
        total = money(invoice.total_amount, invoice.currency)
        paid = money(invoice.paid_amount, invoice.currency)

        answer = (
            f"**Invoice {invoice.invoice_number}** for {customer_name} is **{status}**.\n\n"
            f"Total: {total} | Paid: {paid} | Balance Due: {balance}"
        )
        if invoice.due_date and invoice.balance_due and invoice.due_date < date.today():
            days_overdue = (date.today() - invoice.due_date).days
            answer += f"\n\nThis invoice is **{days_overdue} days overdue** (due {iso(invoice.due_date)})."

        if invoice.issue_date:
            answer += f"\nIssued: {iso(invoice.issue_date)}"

        next_actions = [f"Open invoice /billing/invoices/{invoice.id} to review the full record."]
        if Decimal(str(invoice.balance_due or 0)) > 0:
            next_actions.append("Review payment allocations before treating this invoice as paid.")

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Financial state read from the current Zoiko Billing invoice record. No action was executed.",
            next_actions=next_actions,
        )

    def _overdue_summary(self, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
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
            return self._build_response(
                conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
                answer="No overdue invoices found in this tenant. All invoices are current.",
                evidence=[ChatbotEvidence(source="Zoiko Billing Invoices", resource_type="invoice_search", summary="Overdue invoice query returned no results.")],
                qualification="This checks current invoice due dates and balances only.",
                next_actions=["Open the invoice dashboard for broader aging views."],
            )

        evidence = []
        total_by_currency: dict[str, Decimal] = {}
        for inv in invoices:
            evidence.extend(self._invoice_evidence(inv))
            cur = inv.currency or "USD"
            total_by_currency[cur] = total_by_currency.get(cur, Decimal("0")) + Decimal(str(inv.balance_due or 0))

        if len(total_by_currency) == 1:
            cur, total = next(iter(total_by_currency.items()))
            answer = f"Found **{len(invoices)} overdue invoice(s)** totaling **{money(total, cur)}**. Oldest due date: {iso(invoices[0].due_date)}."
        else:
            parts = [f"{cur}: {money(total, cur)}" for cur, total in total_by_currency.items()]
            answer = f"Found **{len(invoices)} overdue invoice(s)** across multiple currencies: {', '.join(parts)}. Oldest due date: {iso(invoices[0].due_date)}."

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Capped read-only summary of overdue invoices, not a collections action.",
            next_actions=[
                "Open /billing/collections-receivables for collections prioritization",
                "Review each invoice before sending any reminder",
            ],
        )

    def _handle_payment(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        payment_ref = self._extract_reference(text, prefixes=("PAY", "PMT", "PAYMENT"))

        query = (
            self.db.query(Payment)
            .options(selectinload(Payment.customer), selectinload(Payment.allocations))
            .filter(Payment.organization_id == ctx.organization_id, Payment.deleted_at.is_(None))
        )

        if payment_ref:
            payment_refs = {payment_ref.lower(), payment_ref.replace("-", "").lower()}
            payment = query.filter(func.lower(Payment.payment_number).in_(payment_refs)).first()
        else:
            terms = self._search_terms(text)
            if not terms:
                return self._build_response(
                    conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                    answer="Please provide a payment number (e.g., PAY-1001), transaction ID, or customer name to look up a payment.",
                    evidence=[], qualification="The assistant does not guess financial state.",
                    next_actions=["Search by payment number, transaction ID, or customer name."],
                )
            pattern = f"%{terms}%"
            payment = (
                query.join(BillingCustomer, BillingCustomer.id == Payment.customer_id)
                .filter(or_(
                    Payment.payment_number.ilike(pattern),
                    Payment.transaction_id.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                    BillingCustomer.display_name.ilike(pattern),
                ))
                .order_by(Payment.created_at.desc())
                .first()
            )

        if not payment:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="I could not find a payment matching that reference. Please try an exact payment number or transaction ID.",
                evidence=[], qualification="The assistant does not guess financial state.",
                next_actions=["Search by payment number, transaction ID, or customer name."],
            )

        allocated = sum(Decimal(str(a.amount or 0)) for a in payment.allocations)
        unallocated = Decimal(str(payment.amount or 0)) - allocated
        customer_name = payment.customer.company_name if payment.customer else "the customer"

        answer = (
            f"**Payment {payment.payment_number}** for {customer_name} is **{enum_value(payment.status)}**.\n\n"
            f"Amount: {money(payment.amount, payment.currency)} | "
            f"Allocated: {money(allocated, payment.currency)} | "
            f"Unallocated: {money(unallocated, payment.currency)}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Payments",
                resource_type="payment",
                resource_id=payment.id,
                reference=payment.payment_number,
                summary=f"Payment {payment.payment_number} authoritative status and allocation summary.",
                fields={
                    "status": enum_value(payment.status),
                    "amount": str(payment.amount or 0),
                    "currency": payment.currency,
                    "payment_date": iso(payment.payment_date),
                    "transaction_id": payment.transaction_id,
                    "allocated_amount": str(allocated),
                    "unallocated_amount": str(unallocated),
                },
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Payment claims require authorized payment records and allocations for confirmation.",
            next_actions=[f"Open payment /billing/payments/{payment.id} to review attempts, evidence, and allocations."],
        )

    def _handle_customer(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        terms = self._search_terms(text)
        if not terms:
            # Show customer summary
            customers = (
                self.db.query(BillingCustomer)
                .filter(BillingCustomer.organization_id == ctx.organization_id, BillingCustomer.deleted_at.is_(None))
                .order_by(BillingCustomer.company_name.asc())
                .limit(5)
                .all()
            )
            if not customers:
                return self._build_response(
                    conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
                    answer="No customers found in this tenant.",
                    evidence=[], qualification="Empty customer directory.",
                    next_actions=["Create a customer in the billing customers section."],
                )
            answer = f"**Top {len(customers)} customers** by name:\n\n"
            evidence = []
            for c in customers:
                answer += f"- **{c.company_name}** ({enum_value(c.status)}) — Outstanding: {money(c.outstanding_balance, c.currency)}\n"
                evidence.append(ChatbotEvidence(
                    source="Zoiko Billing Customers", resource_type="customer",
                    resource_id=c.id, reference=c.customer_code,
                    summary=f"Customer {c.company_name} summary.",
                    fields={"status": enum_value(c.status), "outstanding": str(c.outstanding_balance or 0), "currency": c.currency},
                ))
            return self._build_response(
                conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
                answer=answer, evidence=evidence,
                qualification="Customer list is current stored Zoiko Billing data.",
                next_actions=["Look up a specific customer by name for detailed information."],
            )

        pattern = f"%{terms}%"
        customer = (
            self.db.query(BillingCustomer)
            .filter(
                BillingCustomer.organization_id == ctx.organization_id,
                BillingCustomer.deleted_at.is_(None),
                or_(
                    BillingCustomer.customer_code.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                    BillingCustomer.display_name.ilike(pattern),
                    BillingCustomer.email.ilike(pattern),
                ),
            )
            .order_by(BillingCustomer.company_name.asc())
            .first()
        )
        if not customer:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer=f"I could not find a customer matching '{terms}'. Please try a different name or customer code.",
                evidence=[], qualification="The assistant does not guess.",
                next_actions=["Search by customer name, code, or email."],
            )

        # Get customer invoices and payments count
        invoice_count = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == ctx.organization_id, Invoice.customer_id == customer.id, Invoice.deleted_at.is_(None)
        ).scalar() or 0

        payment_count = self.db.query(func.count(Payment.id)).filter(
            Payment.organization_id == ctx.organization_id, Payment.customer_id == customer.id, Payment.deleted_at.is_(None)
        ).scalar() or 0

        answer = (
            f"**Customer: {customer.company_name}** ({enum_value(customer.status)})\n\n"
            f"Outstanding Balance: {money(customer.outstanding_balance, customer.currency)} | "
            f"Credit Balance: {money(customer.credit_balance, customer.currency)}\n"
            f"Invoices: {invoice_count} | Payments: {payment_count} | "
            f"Lifetime Value: {money(customer.lifetime_value, customer.currency)}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Customers", resource_type="customer",
                resource_id=customer.id, reference=customer.customer_code,
                summary=f"Customer {customer.company_name} authoritative billing summary.",
                fields={
                    "customer_code": customer.customer_code,
                    "status": enum_value(customer.status),
                    "currency": customer.currency,
                    "outstanding_balance": str(customer.outstanding_balance or 0),
                    "credit_balance": str(customer.credit_balance or 0),
                    "total_invoices": invoice_count,
                    "total_payments": payment_count,
                },
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Customer financial values are current stored aggregates; inspect invoices/payments for detailed reconciliation.",
            next_actions=[
                f"Open customer /billing/customers/{customer.id} for full profile",
                f"Show invoices for {customer.company_name}",
                f"Show payments for {customer.company_name}",
            ],
        )

    def _handle_subscription(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        terms = self._search_terms(text)
        query = (
            self.db.query(Subscription)
            .options(selectinload(Subscription.customer), selectinload(Subscription.plan))
            .filter(Subscription.organization_id == ctx.organization_id)
        )
        if terms:
            pattern = f"%{terms}%"
            sub = (
                query.join(BillingCustomer, BillingCustomer.id == Subscription.customer_id, isouter=True)
                .filter(or_(
                    Subscription.subscription_number.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                ))
                .order_by(Subscription.created_at.desc())
                .first()
            )
        else:
            sub = query.filter(Subscription.status == "active").order_by(Subscription.created_at.desc()).first()

        if not sub:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="No matching subscription found. Try a subscription number or customer name.",
                evidence=[], qualification="No guess made.",
                next_actions=["Search by subscription number or customer name."],
            )

        customer_name = sub.customer.company_name if sub.customer else "Unknown"
        plan_name = sub.plan.plan_name if sub.plan else "N/A"

        answer = (
            f"**Subscription {sub.subscription_number}** — {customer_name}\n\n"
            f"Plan: {plan_name} | Status: {enum_value(sub.status)} | "
            f"Amount: {money(sub.unit_price, sub.currency)}/period\n"
            f"Start: {iso(sub.start_date)} | End: {iso(sub.current_term_end)}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Subscriptions", resource_type="subscription",
                resource_id=sub.id, reference=sub.subscription_number,
                summary=f"Subscription {sub.subscription_number} details.",
                fields={
                    "status": enum_value(sub.status),
                    "plan": plan_name,
                    "amount": str(sub.unit_price or 0),
                    "currency": sub.currency,
                    "start_date": iso(sub.start_date),
                    "end_date": iso(sub.current_term_end),
                },
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Subscription data from authoritative Zoiko Billing records.",
            next_actions=[f"Open subscription /billing/subscriptions/{sub.id} for full details."],
        )

    def _handle_contract(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        terms = self._search_terms(text)
        query = self.db.query(Contract).filter(Contract.organization_id == ctx.organization_id, Contract.deleted_at.is_(None))
        if terms:
            pattern = f"%{terms}%"
            contract = (
                query.join(BillingCustomer, BillingCustomer.id == Contract.customer_id, isouter=True)
                .filter(or_(
                    Contract.contract_number.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                ))
                .order_by(Contract.created_at.desc())
                .first()
            )
        else:
            contract = query.filter(Contract.status == "active").order_by(Contract.created_at.desc()).first()

        if not contract:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="No matching contract found. Try a contract number or customer name.",
                evidence=[], qualification="No guess made.",
                next_actions=["Search by contract number or customer name."],
            )

        customer = self.db.query(BillingCustomer).filter(BillingCustomer.id == contract.customer_id).first()
        customer_name = customer.company_name if customer else "Unknown"

        answer = (
            f"**Contract {contract.contract_number}** — {customer_name}\n\n"
            f"Status: {enum_value(contract.status)} | Name: {contract.contract_name}\n"
            f"Start: {iso(contract.start_date)} | End: {iso(contract.end_date)}\n"
            f"Total Value: {money(contract.value, contract.currency)}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Contracts", resource_type="contract",
                resource_id=contract.id, reference=contract.contract_number,
                summary=f"Contract {contract.contract_number} details.",
                fields={
                    "status": enum_value(contract.status),
                    "name": contract.contract_name,
                    "total_value": str(contract.value or 0),
                    "currency": contract.currency,
                    "start_date": iso(contract.start_date),
                    "end_date": iso(contract.end_date),
                },
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Contract data from authoritative Zoiko Billing records.",
            next_actions=[f"Open contract /billing/contracts/{contract.id} for full details."],
        )

    def _handle_product(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        terms = self._search_terms(text)
        query = self.db.query(Product).filter(Product.organization_id == ctx.organization_id, Product.deleted_at.is_(None))
        if terms:
            pattern = f"%{terms}%"
            product = query.filter(or_(
                Product.name.ilike(pattern),
                Product.code.ilike(pattern),
            )).first()
        else:
            product = query.order_by(Product.created_at.desc()).first()

        if not product:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="No matching product found. Try a product name or code.",
                evidence=[], qualification="No guess made.",
                next_actions=["Search by product name or code."],
            )

        answer = (
            f"**Product: {product.name}** ({product.code})\n\n"
            f"Type: {enum_value(product.product_type)} | Active: {'Yes' if product.is_active else 'No'}\n"
            f"Unit Price: {money(product.default_price, product.currency)} | "
            f"Cost: {money(product.cost_price, product.currency)}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Products", resource_type="product",
                resource_id=product.id, reference=product.code,
                summary=f"Product {product.name} details.",
                fields={
                    "product_code": product.code,
                    "type": enum_value(product.product_type),
                    "is_active": product.is_active,
                    "unit_price": str(product.default_price or 0),
                    "currency": product.currency,
                },
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Product data from authoritative Zoiko Billing catalog.",
            next_actions=[f"Open product /billing/products/{product.id} for full details."],
        )

    def _handle_quotation(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        terms = self._search_terms(text)
        query = self.db.query(Quotation).filter(Quotation.organization_id == ctx.organization_id, Quotation.is_active == True)
        if terms:
            pattern = f"%{terms}%"
            quote = (
                query.join(BillingCustomer, BillingCustomer.id == Quotation.customer_id, isouter=True)
                .filter(or_(
                    Quotation.quote_number.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                ))
                .order_by(Quotation.created_at.desc())
                .first()
            )
        else:
            quote = query.order_by(Quotation.created_at.desc()).first()

        if not quote:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="No matching quotation found. Try a quotation number or customer name.",
                evidence=[], qualification="No guess made.",
                next_actions=["Search by quotation number or customer name."],
            )

        customer = self.db.query(BillingCustomer).filter(BillingCustomer.id == quote.customer_id).first()
        customer_name = customer.company_name if customer else "Unknown"

        answer = (
            f"**Quotation {quote.quote_number}** — {customer_name}\n\n"
            f"Status: {enum_value(quote.status)} | Total: {money(quote.total_amount, quote.currency)}\n"
            f"Valid Until: {iso(quote.valid_until)}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Quotations", resource_type="quotation",
                resource_id=quote.id, reference=quote.quote_number,
                summary=f"Quotation {quote.quote_number} details.",
                fields={
                    "status": enum_value(quote.status),
                    "total": str(quote.total_amount or 0),
                    "currency": quote.currency,
                    "valid_until": iso(quote.valid_until),
                },
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Quotation data from authoritative Zoiko Billing records.",
            next_actions=[f"Open quotation /billing/quotations/{quote.id} for full details."],
        )

    def _handle_credit(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        credit_ref = self._extract_reference(text, prefixes=("CN", "CREDIT"))
        query = self.db.query(CreditNote).filter(CreditNote.organization_id == ctx.organization_id, CreditNote.deleted_at.is_(None))
        if credit_ref:
            credit_refs = {credit_ref.lower(), credit_ref.replace("-", "").lower()}
            cn = query.filter(func.lower(CreditNote.credit_note_number).in_(credit_refs)).first()
        else:
            cn = query.order_by(CreditNote.created_at.desc()).first()

        if not cn:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="No matching credit note found. Try a credit note number or check the credit notes dashboard.",
                evidence=[], qualification="No guess made.",
                next_actions=["Search by credit note number."],
            )

        answer = (
            f"**Credit Note {cn.credit_note_number}**\n\n"
            f"Status: {enum_value(cn.status)} | Amount: {money(cn.total_amount, cn.currency)}\n"
            f"Reason: {cn.reason or 'N/A'}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Credit Notes", resource_type="credit_note",
                resource_id=cn.id, reference=cn.credit_note_number,
                summary=f"Credit Note {cn.credit_note_number} details.",
                fields={"status": enum_value(cn.status), "amount": str(cn.total_amount or 0), "currency": cn.currency},
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Credit note data from authoritative Zoiko Billing records.",
            next_actions=[f"Open credit note /billing/credit-notes/{cn.id} for full details."],
        )

    def _handle_refund(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        refund_ref = self._extract_reference(text, prefixes=("REF", "REFUND"))
        query = self.db.query(Refund).filter(Refund.organization_id == ctx.organization_id, Refund.deleted_at.is_(None))
        if refund_ref:
            refund_refs = {refund_ref.lower(), refund_ref.replace("-", "").lower()}
            ref = query.filter(func.lower(Refund.refund_number).in_(refund_refs)).first()
        else:
            ref = query.order_by(Refund.created_at.desc()).first()

        if not ref:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
                answer="No matching refund found. Try a refund number or check the refunds dashboard.",
                evidence=[], qualification="No guess made.",
                next_actions=["Search by refund number."],
            )

        answer = (
            f"**Refund {ref.refund_number}**\n\n"
            f"Status: {enum_value(ref.status)} | Amount: {money(ref.amount, ref.currency)}\n"
            f"Reason: {ref.reason or 'N/A'}"
        )

        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing Refunds", resource_type="refund",
                resource_id=ref.id, reference=ref.refund_number,
                summary=f"Refund {ref.refund_number} details.",
                fields={"status": enum_value(ref.status), "amount": str(ref.amount or 0), "currency": ref.currency},
            )
        ]

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Refund data from authoritative Zoiko Billing records.",
            next_actions=[f"Open refund /billing/refunds/{ref.id} for full details."],
        )

    def _handle_collections(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        dunning_cases = (
            self.db.query(DunningCase)
            .filter(DunningCase.organization_id == ctx.organization_id)
            .order_by(DunningCase.created_at.desc())
            .limit(5)
            .all()
        )

        if not dunning_cases:
            return self._build_response(
                conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
                answer="No active dunning cases found in this tenant.",
                evidence=[], qualification="Current dunning state only.",
                next_actions=["Check the collections dashboard for more details."],
            )

        answer = f"**{len(dunning_cases)} Active Dunning Case(s):**\n\n"
        evidence = []
        for dc in dunning_cases:
            answer += f"- Case {dc.id}: Level {dc.current_level}, Status {enum_value(dc.status)}\n"
            evidence.append(ChatbotEvidence(
                source="Zoiko Billing Dunning", resource_type="dunning_case",
                resource_id=dc.id, summary=f"Dunning case {dc.id} at level {dc.current_level}.",
                fields={"level": dc.current_level, "status": enum_value(dc.status)},
            ))

        return self._build_response(
            conv=conv, ctx=ctx, mode="M1_INSPECT", risk_class="R1",
            answer=answer, evidence=evidence,
            qualification="Dunning data from authoritative Zoiko Billing records.",
            next_actions=["Open /billing/dunning for full dunning management."],
        )

    def _handle_fallback(self, text: str, normalized: str, conv: Conversation, ctx: ChatbotContext) -> ChatbotResponse:
        return self._build_response(
            conv=conv, ctx=ctx, mode="M5_ESCALATE", risk_class="R0",
            answer=(
                "I am not sure how to help with that request. I work best with specific billing questions.\n\n"
                "**Try asking about:**\n"
                "- Invoices (lookup, balance, overdue status)\n"
                "- Payments (lookup, allocation, unapplied amounts)\n"
                "- Customers (details, balances, history)\n"
                "- Subscriptions (status, plans, renewals)\n"
                "- Contracts (terms, status, amendments)\n"
                "- Products (catalog, pricing)\n"
                "- Quotations (status, conversion)\n"
                "- Credit notes and refunds\n"
                "- Dunning and collections"
            ),
            evidence=[], qualification="The assistant does not guess financial state.",
            next_actions=[
                "Try: 'Show overdue invoices'",
                "Try: 'Look up customer [name]'",
                "Try: 'Dashboard summary'",
            ],
        )

    # ── Capabilities ─────────────────────────────────────────────────────

    def get_capabilities(self, *, current_user, request_id: str | None = None) -> CapabilitiesResponse:
        context = self._context(current_user=current_user, request_id=request_id)
        role = context.role

        capabilities = [
            Capability(id="read_invoices", label="Read Invoices", description="Look up and explain invoice state", enabled="invoice:read" in context.permissions, risk_class="R1"),
            Capability(id="read_payments", label="Read Payments", description="Look up and explain payment state", enabled="payment:read" in context.permissions, risk_class="R1"),
            Capability(id="read_customers", label="Read Customers", description="Look up customer billing data", enabled="customer:read" in context.permissions, risk_class="R1"),
            Capability(id="read_subscriptions", label="Read Subscriptions", description="Look up subscription details", enabled="subscription:read" in context.permissions, risk_class="R1"),
            Capability(id="read_contracts", label="Read Contracts", description="Look up contract terms and status", enabled="contract:read" in context.permissions, risk_class="R1"),
            Capability(id="read_products", label="Read Products", description="Search product catalog", enabled="product:read" in context.permissions, risk_class="R1"),
            Capability(id="read_quotations", label="Read Quotations", description="Look up quotation status", enabled="quotation:read" in context.permissions, risk_class="R1"),
            Capability(id="read_credit_notes", label="Read Credit Notes", description="Look up credit note state", enabled="credit:read" in context.permissions, risk_class="R1"),
            Capability(id="read_refunds", label="Read Refunds", description="Look up refund status", enabled="refund:read" in context.permissions, risk_class="R1"),
            Capability(id="knowledge_help", label="Knowledge Help", description="Billing workflow guidance", enabled=True, risk_class="R0"),
            Capability(id="dashboard_summary", label="Dashboard Summary", description="Financial overview and KPIs", enabled="billing:read" in context.permissions, risk_class="R1"),
        ]

        return CapabilitiesResponse(
            effective_mode="explain_inspect",
            risk_classes_allowed=["R0", "R1"],
            capabilities=capabilities,
            tenant_context=context,
        )

    # ── Internal Helpers ─────────────────────────────────────────────────

    def _context(self, *, current_user, request_id: str | None) -> ChatbotContext:
        role = role_value(current_user)
        organization_id = getattr(current_user, "organization_id", None)
        org_name = None
        if organization_id:
            org = self.db.query(Organization).filter(Organization.id == organization_id).first()
            org_name = getattr(org, "organization_name", None) if org else None
        return ChatbotContext(
            request_id=request_id,
            user_id=current_user.id,
            organization_id=organization_id,
            tenant_name=org_name,
            role=role,
            permissions=ROLE_PERMISSIONS.get(role, ["billing:read"]),
        )

    def _get_conversation(self, conversation_uid: str, ctx: ChatbotContext) -> Conversation | None:
        return (
            self.db.query(Conversation)
            .filter(
                Conversation.conversation_uid == conversation_uid,
                Conversation.organization_id == ctx.organization_id,
                Conversation.user_id == ctx.user_id,
            )
            .first()
        )

    def _build_response(self, *, conv: Conversation, ctx: ChatbotContext, mode: str, risk_class: str, answer: str, evidence: list[ChatbotEvidence], qualification: str | None, next_actions: list[str]) -> ChatbotResponse:
        domain = conv.primary_domain or "help"
        suggestions = DOMAIN_SUGGESTIONS.get(domain, DOMAIN_SUGGESTIONS["help"])

        return ChatbotResponse(
            conversation_uid=conv.conversation_uid,
            message_uid=_uid(),
            mode=mode,
            risk_class=risk_class,
            answer=answer,
            evidence=evidence,
            qualification=qualification,
            next_actions=next_actions,
            suggested_prompts=suggestions,
            context=ctx,
        )

    def _escalation_response(self, *, conversation_uid: str, ctx: ChatbotContext, answer: str, qualification: str | None) -> ChatbotResponse:
        return ChatbotResponse(
            conversation_uid=conversation_uid,
            message_uid=_uid(),
            mode="M5_ESCALATE",
            risk_class="R0",
            answer=answer,
            evidence=[],
            qualification=qualification,
            next_actions=["Use an organization-scoped billing user for tenant record inspection."],
            context=ctx,
        )

    def _invoice_evidence(self, invoice: Invoice) -> list[ChatbotEvidence]:
        return [
            ChatbotEvidence(
                source="Zoiko Billing Invoices",
                resource_type="invoice",
                resource_id=invoice.id,
                reference=invoice.invoice_number,
                summary=f"Invoice {invoice.invoice_number} authoritative state and balance.",
                fields={
                    "status": enum_value(invoice.status),
                    "customer_id": invoice.customer_id,
                    "customer_name": invoice.customer.company_name if invoice.customer else None,
                    "issue_date": iso(invoice.issue_date),
                    "due_date": iso(invoice.due_date),
                    "currency": invoice.currency,
                    "total_amount": str(invoice.total_amount or 0),
                    "paid_amount": str(invoice.paid_amount or 0),
                    "balance_due": str(invoice.balance_due or 0),
                },
            )
        ]

    def _extract_reference(self, text: str, *, prefixes: tuple[str, ...]) -> str | None:
        prefix_pattern = "|".join(re.escape(p) for p in prefixes)
        match = re.search(rf"\b({prefix_pattern})[-_ ]?([A-Za-z0-9][-A-Za-z0-9]*)\b", text, flags=re.IGNORECASE)
        if not match:
            return None
        prefix = match.group(1).upper()
        value = match.group(2).upper()
        if prefix == "INVOICE":
            return f"INV-{value}"
        if prefix == "PAYMENT":
            return f"PAY-{value}"
        if prefix == "QUOTE":
            return f"QTE-{value}"
        if prefix == "CONTRACT":
            return f"CTR-{value}"
        if prefix == "REFUND":
            return f"REF-{value}"
        return f"{prefix}-{value}" if "-" not in match.group(0) else match.group(0).upper().replace("_", "-").replace(" ", "-")

    def _search_terms(self, text: str) -> str:
        cleaned = re.sub(
            r"\b(invoice|payment|customer|client|account|balance|status|show|find|lookup|why|does|owe|paid|for|the|a|an|me|please|subscription|contract|product|quotation|credit|refund|dunning|overdue|number|code|name|list|all|any|some|what|about|get|give|tell|want|need|can|could|would|should|how|when|where|who|which|is|are|was|were|has|have|had|do|does|did|will|shall|may|might|must|there|here|this|that|these|those|it|its|my|your|our|their)\b",
            " ", text, flags=re.IGNORECASE,
        )
        cleaned = re.sub(r"[^A-Za-z0-9@._ -]", " ", cleaned)
        return re.sub(r"\s+", " ", cleaned).strip()[:120]

    def _audit(self, event_type: AuditEventType, conversation: Conversation, ctx: ChatbotContext, payload: dict[str, Any]) -> None:
        event = ChatbotAuditEvent(
            event_uid=_uid(),
            conversation_id=conversation.id if conversation else None,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            event_type=event_type,
            event_payload=payload,
            correlation_id=ctx.request_id,
        )
        self.db.add(event)
