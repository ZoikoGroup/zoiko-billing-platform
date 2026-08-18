from __future__ import annotations

import re
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from app.modules.billing.models import BillingCustomer, Invoice, Payment
from app.modules.organizations.models import Organization

from .schemas import ChatbotContext, ChatbotEvidence, ChatbotResponse


READ_PERMISSIONS = {
    "org_admin": ["billing:read", "billing:draft", "billing:admin"],
    "billing_admin": ["billing:read", "billing:draft"],
    "super_admin": ["platform:read"],
}

HELP_TOPICS = [
    {
        "keywords": ("partial payment", "partially paid", "partially allocated"),
        "answer": "A partial payment means approved payment evidence has been recorded for less than the invoice total. The invoice should remain open until allocations, credits, or write-offs reduce the balance due to zero.",
        "summary": "Partial-payment guidance from the Zoiko Billing chatbot PRD/guardrail doctrine.",
        "next_actions": ["Open the invoice record to review allocations.", "Use the Payments area to inspect payment evidence and unallocated amounts."],
    },
    {
        "keywords": ("payment evidence", "i paid", "paid claim", "remittance"),
        "answer": "A message or remittance claim is not payment state by itself. Payment status must come from approved Zoiko Billing payment records, processor evidence, and allocations.",
        "summary": "Payment-evidence rule from the Zoiko Billing chatbot PRD and guardrails.",
        "next_actions": ["Search for the payment record or transaction ID.", "Review allocations before treating an invoice as paid."],
    },
    {
        "keywords": ("change issued invoice", "edit issued invoice", "overcharged", "correction", "correct invoice"),
        "answer": "Issued invoices should not be silently rewritten. Corrections must use governed credit, void, debit, replacement, or adjustment workflows according to the invoice state and policy.",
        "summary": "Issued-record integrity rule from the Zoiko Billing chatbot PRD and guardrails.",
        "next_actions": ["Open the issued invoice and choose the applicable correction workflow.", "Prepare a credit or adjustment only after reviewing the authoritative invoice state."],
    },
    {
        "keywords": ("what can you do", "help", "assistant", "chatbot"),
        "answer": "I can answer Zoiko Billing workflow questions and inspect authorized customer, invoice, payment, balance, and overdue state. This MVP is read-only and will not issue invoices, record payments, send reminders, create refunds, or mutate financial records.",
        "summary": "MVP capability boundary derived from P0 chatbot requirements.",
        "next_actions": ["Ask for an invoice number, customer name, payment number, outstanding balance, or overdue invoices."],
    },
]


def role_value(user) -> str:
    role = getattr(user, "role", "") or ""
    return role.value if hasattr(role, "value") else str(role)


def enum_value(value) -> str | None:
    if value is None:
        return None
    return value.value if hasattr(value, "value") else str(value)


def money(value, currency: str | None = None) -> str:
    amount = Decimal(value or 0)
    rendered = f"{amount:,.2f}"
    return f"{currency or ''} {rendered}".strip()


def iso(value) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


class ChatbotService:
    def __init__(self, db: Session):
        self.db = db

    def respond(self, *, message: str, conversation_id: str | None, current_user, request_id: str | None) -> ChatbotResponse:
        text = message.strip()
        normalized = text.lower()
        context = self._context(current_user=current_user, request_id=request_id)

        if not context.organization_id:
            return self._response(
                conversation_id=conversation_id,
                mode="M5_ESCALATE",
                risk_class="R0",
                answer="I can explain Zoiko Billing concepts, but I cannot inspect tenant billing records until an organization context is explicitly selected.",
                evidence=[],
                qualification="No tenant context is bound to this authenticated user.",
                next_actions=["Use an organization-scoped billing user for tenant record inspection."],
                context=context,
            )

        help_response = self._help_response(normalized, conversation_id, context)
        if help_response:
            return help_response

        if self._mentions_overdue(normalized):
            return self._overdue_summary(conversation_id, context)

        invoice_ref = self._extract_reference(text, prefixes=("INV", "INVOICE"))
        if invoice_ref or "invoice" in normalized or "balance" in normalized or "owe" in normalized:
            invoice_response = self._invoice_response(text, normalized, invoice_ref, conversation_id, context)
            if invoice_response:
                return invoice_response

        payment_ref = self._extract_reference(text, prefixes=("PAY", "PMT", "PAYMENT"))
        if payment_ref or "payment" in normalized or "transaction" in normalized or "allocation" in normalized:
            payment_response = self._payment_response(text, payment_ref, conversation_id, context)
            if payment_response:
                return payment_response

        if "customer" in normalized or "client" in normalized or "account" in normalized or len(text) >= 2:
            customer_response = self._customer_response(text, conversation_id, context)
            if customer_response:
                return customer_response

        return self._response(
            conversation_id=conversation_id,
            mode="M5_ESCALATE",
            risk_class="R0",
            answer="I could not find authoritative Zoiko Billing evidence for that request.",
            evidence=[],
            qualification="The assistant does not guess financial state. Try an exact invoice number, customer name, payment number, or transaction ID.",
            next_actions=["Search by invoice number, payment number, transaction ID, or customer name."],
            context=context,
        )

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
            permissions=READ_PERMISSIONS.get(role, ["billing:read"]),
        )

    def _help_response(self, normalized: str, conversation_id: str | None, context: ChatbotContext) -> ChatbotResponse | None:
        for topic in HELP_TOPICS:
            if any(keyword in normalized for keyword in topic["keywords"]):
                return self._response(
                    conversation_id=conversation_id,
                    mode="M0_EXPLAIN",
                    risk_class="R0",
                    answer=topic["answer"],
                    evidence=[ChatbotEvidence(source="Zoiko Billing chatbot documentation", resource_type="knowledge", summary=topic["summary"])],
                    qualification="This is product guidance, not tax, legal, or accounting advice.",
                    next_actions=topic["next_actions"],
                    context=context,
                )
        return None

    def _invoice_response(self, text: str, normalized: str, invoice_ref: str | None, conversation_id: str | None, context: ChatbotContext) -> ChatbotResponse | None:
        query = self.db.query(Invoice).options(selectinload(Invoice.customer), selectinload(Invoice.payment_allocations)).filter(
            Invoice.organization_id == context.organization_id,
            Invoice.deleted_at.is_(None),
        )
        if invoice_ref:
            invoice_refs = {invoice_ref.lower(), invoice_ref.replace("-", "").lower()}
            invoice = query.filter(func.lower(Invoice.invoice_number).in_(invoice_refs)).first()
        else:
            terms = self._search_terms(text)
            if not terms:
                return None
            pattern = f"%{terms}%"
            invoice = query.join(BillingCustomer, BillingCustomer.id == Invoice.customer_id).filter(
                or_(
                    Invoice.invoice_number.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                    BillingCustomer.display_name.ilike(pattern),
                )
            ).order_by(Invoice.created_at.desc()).first()

        if not invoice:
            return None

        evidence = self._invoice_evidence(invoice)
        customer_name = invoice.customer.company_name if invoice.customer else "the customer"
        status = enum_value(invoice.status)
        balance = money(invoice.balance_due, invoice.currency)
        total = money(invoice.total_amount, invoice.currency)
        paid = money(invoice.paid_amount, invoice.currency)
        answer = f"Invoice {invoice.invoice_number} for {customer_name} is {status}. Total is {total}, paid is {paid}, and balance due is {balance}."
        if invoice.due_date and invoice.balance_due and invoice.due_date < date.today():
            answer += f" It is overdue since {iso(invoice.due_date)}."

        next_actions = [f"Open invoice /billing/invoices/{invoice.id} to review the full record."]
        if Decimal(invoice.balance_due or 0) > 0:
            next_actions.append("Review payment allocations before treating this invoice as paid.")
        if "send" in normalized or "issue" in normalized or "refund" in normalized or "credit" in normalized:
            next_actions.append("Use the governed invoice/payment workflow; this assistant response did not execute any action.")

        return self._response(
            conversation_id=conversation_id,
            mode="M1_INSPECT",
            risk_class="R1",
            answer=answer,
            evidence=evidence,
            qualification="Financial state is read from the current Zoiko Billing invoice record. No action was executed.",
            next_actions=next_actions,
            context=context,
        )

    def _payment_response(self, text: str, payment_ref: str | None, conversation_id: str | None, context: ChatbotContext) -> ChatbotResponse | None:
        query = self.db.query(Payment).options(selectinload(Payment.customer), selectinload(Payment.allocations)).filter(
            Payment.organization_id == context.organization_id,
            Payment.deleted_at.is_(None),
        )
        if payment_ref:
            payment_refs = {payment_ref.lower(), payment_ref.replace("-", "").lower()}
            payment = query.filter(func.lower(Payment.payment_number).in_(payment_refs)).first()
        else:
            terms = self._search_terms(text)
            if not terms:
                return None
            pattern = f"%{terms}%"
            payment = query.join(BillingCustomer, BillingCustomer.id == Payment.customer_id).filter(
                or_(
                    Payment.payment_number.ilike(pattern),
                    Payment.transaction_id.ilike(pattern),
                    BillingCustomer.company_name.ilike(pattern),
                    BillingCustomer.display_name.ilike(pattern),
                )
            ).order_by(Payment.created_at.desc()).first()

        if not payment:
            return None

        allocated = sum(Decimal(a.amount or 0) for a in payment.allocations)
        unallocated = Decimal(payment.amount or 0) - allocated
        customer_name = payment.customer.company_name if payment.customer else "the customer"
        answer = f"Payment {payment.payment_number} for {customer_name} is {enum_value(payment.status)}. Amount is {money(payment.amount, payment.currency)}, allocated is {money(allocated, payment.currency)}, and unallocated is {money(unallocated, payment.currency)}."
        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing payments",
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
        return self._response(
            conversation_id=conversation_id,
            mode="M1_INSPECT",
            risk_class="R1",
            answer=answer,
            evidence=evidence,
            qualification="Payment claims are not treated as paid status unless reflected in authorized payment records and allocations.",
            next_actions=[f"Open payment /billing/payments/{payment.id} to review attempts, evidence, and allocations."],
            context=context,
        )

    def _customer_response(self, text: str, conversation_id: str | None, context: ChatbotContext) -> ChatbotResponse | None:
        terms = self._search_terms(text)
        if not terms:
            return None
        pattern = f"%{terms}%"
        customer = self.db.query(BillingCustomer).filter(
            BillingCustomer.organization_id == context.organization_id,
            BillingCustomer.deleted_at.is_(None),
            or_(
                BillingCustomer.customer_code.ilike(pattern),
                BillingCustomer.company_name.ilike(pattern),
                BillingCustomer.display_name.ilike(pattern),
                BillingCustomer.email.ilike(pattern),
            ),
        ).order_by(BillingCustomer.company_name.asc()).first()
        if not customer:
            return None

        answer = f"Customer {customer.company_name} is {enum_value(customer.status)}. Outstanding balance is {money(customer.outstanding_balance, customer.currency)}, credit balance is {money(customer.credit_balance, customer.currency)}, and lifetime revenue is {money(customer.lifetime_value, customer.currency)}."
        evidence = [
            ChatbotEvidence(
                source="Zoiko Billing customers",
                resource_type="customer",
                resource_id=customer.id,
                reference=customer.customer_code,
                summary=f"Customer {customer.company_name} authoritative billing summary.",
                fields={
                    "customer_code": customer.customer_code,
                    "status": enum_value(customer.status),
                    "currency": customer.currency,
                    "outstanding_balance": str(customer.outstanding_balance or 0),
                    "credit_balance": str(customer.credit_balance or 0),
                    "total_invoices": customer.total_invoices,
                    "total_payments": customer.total_payments,
                },
            )
        ]
        return self._response(
            conversation_id=conversation_id,
            mode="M1_INSPECT",
            risk_class="R1",
            answer=answer,
            evidence=evidence,
            qualification="Customer financial values are current stored Zoiko Billing customer aggregates; inspect invoices/payments for detailed reconciliation.",
            next_actions=[f"Open customer /billing/customers/{customer.id} to review profile, invoices, and payment history."],
            context=context,
        )

    def _overdue_summary(self, conversation_id: str | None, context: ChatbotContext) -> ChatbotResponse:
        invoices = self.db.query(Invoice).options(selectinload(Invoice.customer)).filter(
            Invoice.organization_id == context.organization_id,
            Invoice.deleted_at.is_(None),
            Invoice.balance_due > 0,
            Invoice.due_date < date.today(),
        ).order_by(Invoice.due_date.asc()).limit(5).all()
        currencies = {inv.currency for inv in invoices if inv.currency}
        total = sum(Decimal(inv.balance_due or 0) for inv in invoices) if len(currencies) == 1 else None
        if not invoices:
            return self._response(
                conversation_id=conversation_id,
                mode="M1_INSPECT",
                risk_class="R1",
                answer="I did not find overdue invoices with a positive balance in this tenant.",
                evidence=[ChatbotEvidence(source="Zoiko Billing invoices", resource_type="invoice_search", summary="Overdue invoice query returned no positive-balance records.")],
                qualification="This checks current invoice due dates and balances only.",
                next_actions=["Open the invoice dashboard for broader aging and collections views."],
                context=context,
            )

        evidence = [self._invoice_evidence(inv)[0] for inv in invoices]
        if total is None:
            answer = f"I found {len(invoices)} overdue invoice(s) in the first result set across multiple currencies, so I am not summing them into one total. Oldest due date is {iso(invoices[0].due_date)}."
        else:
            answer = f"I found {len(invoices)} overdue invoice(s) in the first result set, totaling {money(total, invoices[0].currency)} across those shown. Oldest due date is {iso(invoices[0].due_date)}."
        return self._response(
            conversation_id=conversation_id,
            mode="M1_INSPECT",
            risk_class="R1",
            answer=answer,
            evidence=evidence,
            qualification="This is a capped read-only summary of the first five overdue invoices, not a collections action.",
            next_actions=["Open /billing/collections-receivables for collections prioritization.", "Review each invoice before sending any reminder."],
            context=context,
        )

    def _invoice_evidence(self, invoice: Invoice) -> list[ChatbotEvidence]:
        return [
            ChatbotEvidence(
                source="Zoiko Billing invoices",
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

    def _response(self, *, conversation_id: str | None, mode: str, risk_class: str, answer: str, evidence: list[ChatbotEvidence], qualification: str | None, next_actions: list[str], context: ChatbotContext) -> ChatbotResponse:
        return ChatbotResponse(
            conversation_id=conversation_id or str(uuid.uuid4()),
            mode=mode,
            risk_class=risk_class,
            answer=answer,
            evidence=evidence,
            qualification=qualification,
            next_actions=next_actions,
            context=context,
        )

    def _extract_reference(self, text: str, *, prefixes: tuple[str, ...]) -> str | None:
        prefix_pattern = "|".join(re.escape(prefix) for prefix in prefixes)
        match = re.search(rf"\b({prefix_pattern})[-_ ]?([A-Za-z0-9][-A-Za-z0-9]*)\b", text, flags=re.IGNORECASE)
        if not match:
            return None
        prefix = match.group(1).upper()
        value = match.group(2).upper()
        if prefix == "INVOICE":
            return f"INV-{value}"
        if prefix == "PAYMENT":
            return f"PAY-{value}"
        return f"{prefix}-{value}" if "-" not in match.group(0) else match.group(0).upper().replace("_", "-").replace(" ", "-")

    def _search_terms(self, text: str) -> str:
        cleaned = re.sub(r"\b(invoice|payment|customer|client|account|balance|status|show|find|lookup|why|does|owe|paid|for|the|a|an|me|please)\b", " ", text, flags=re.IGNORECASE)
        cleaned = re.sub(r"[^A-Za-z0-9@._ -]", " ", cleaned)
        return re.sub(r"\s+", " ", cleaned).strip()[:120]

    def _mentions_overdue(self, normalized: str) -> bool:
        return "overdue" in normalized or "past due" in normalized or "due this week" in normalized
