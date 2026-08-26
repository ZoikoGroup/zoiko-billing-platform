"""
modules/commercial/platform_invoice_service.py
----------------------------------------------
Plane 1 — Platform Invoice service (Zoiko-invoicing-an-org).

Invoice lifecycle:
  DRAFT → [ISSUED, VOIDED]
  ISSUED → [DELIVERED, DELIVERY_FAILED, DUE, VOIDED]
  DUE → [PARTIALLY_PAID, PAID, OVERDUE, VOIDED]
  PARTIALLY_PAID → [PAID, OVERDUE, VOIDED]
  OVERDUE → [PAID, DISPUTED, CREDITED, VOIDED]
  DISPUTED → [PAID, CREDITED, VOIDED]
  CREDITED → terminal
  VOIDED → terminal

Scope: operates ONLY on PlatformInvoice / PlatformInvoiceItem rows.
Never touches Plane 2 tables.

DOCTRINE:
  - calculate_totals is shared by preview AND finalize (prevent drift)
  - Invoice numbering uses PlatformInvoiceNumberSequence (SELECT FOR UPDATE)
  - No PUT/PATCH/DELETE on non-draft invoices (void + reissue only)
  - Every mutation writes PlatformAuditLog
"""

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.commercial.enums import (
    PlatformInvoiceDeliveryStatus,
    PlatformInvoiceDisputeStatus,
    PlatformInvoicePaymentStatus,
    PlatformInvoiceStatus,
)
from app.modules.commercial.models import (
    PlatformInvoice,
    PlatformInvoiceDeliveryAttempt,
    PlatformInvoiceItem,
    PlatformInvoiceNumberSequence,
)
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction

logger = logging.getLogger("zoiko_billing.commercial.platform_invoice")

# ── Valid state transitions ─────────────────────────────────────────────────
_TRANSITIONS = {
    PlatformInvoiceStatus.DRAFT: {
        PlatformInvoiceStatus.ISSUED,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.ISSUED: {
        PlatformInvoiceStatus.DELIVERED,
        PlatformInvoiceStatus.DELIVERY_FAILED,
        PlatformInvoiceStatus.DUE,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.DELIVERED: {
        PlatformInvoiceStatus.DUE,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.DELIVERY_FAILED: {
        PlatformInvoiceStatus.ISSUED,  # retry
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.DUE: {
        PlatformInvoiceStatus.PARTIALLY_PAID,
        PlatformInvoiceStatus.PAID,
        PlatformInvoiceStatus.OVERDUE,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.PARTIALLY_PAID: {
        PlatformInvoiceStatus.PAID,
        PlatformInvoiceStatus.OVERDUE,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.PAID: set(),  # terminal
    PlatformInvoiceStatus.OVERDUE: {
        PlatformInvoiceStatus.PAID,
        PlatformInvoiceStatus.DISPUTED,
        PlatformInvoiceStatus.CREDITED,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.DISPUTED: {
        PlatformInvoiceStatus.PAID,
        PlatformInvoiceStatus.CREDITED,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.CREDITED: set(),  # terminal
    PlatformInvoiceStatus.VOIDED: set(),  # terminal
    PlatformInvoiceStatus.REVIEW_REQUIRED: {
        PlatformInvoiceStatus.APPROVED,
        PlatformInvoiceStatus.VOIDED,
    },
    PlatformInvoiceStatus.APPROVED: {
        PlatformInvoiceStatus.ISSUED,
        PlatformInvoiceStatus.VOIDED,
    },
}


def _invoice_snapshot(inv: PlatformInvoice) -> dict:
    return {
        "invoice_number": inv.invoice_number,
        "status": inv.status.value if hasattr(inv.status, "value") else inv.status,
        "invoice_type": inv.invoice_type.value if hasattr(inv.invoice_type, "value") else inv.invoice_type,
        "subtotal": str(inv.subtotal),
        "discount_amount": str(inv.discount_amount),
        "tax_amount": str(inv.tax_amount),
        "total_amount": str(inv.total_amount),
        "paid_amount": str(inv.paid_amount),
        "balance_due": str(inv.balance_due),
        "currency": inv.currency,
        "issue_date": inv.issue_date.isoformat() if inv.issue_date else None,
        "due_date": inv.due_date.isoformat() if inv.due_date else None,
    }


class PlatformInvoiceService:
    def __init__(self, db: Session):
        self.db = db
        self._audit = PlatformAuditService(db)

    def create_draft(
        self,
        *,
        account_id: int,
        actor_id: int,
        invoice_type: str = "standard",
        subscription_id: Optional[int] = None,
        issue_date: Optional[date] = None,
        due_date: Optional[date] = None,
        notes: Optional[str] = None,
        currency: str = "USD",
    ) -> PlatformInvoice:
        """Create a DRAFT platform invoice."""
        invoice = PlatformInvoice(
            commercial_account_id=account_id,
            commercial_subscription_id=subscription_id,
            status=PlatformInvoiceStatus.DRAFT,
            invoice_type=invoice_type,
            issue_date=issue_date or date.today(),
            due_date=due_date,
            notes=notes,
            currency=currency,
            created_by=actor_id,
        )
        self.db.add(invoice)
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.INVOICE_CREATED,
            entity_type="platform_invoice",
            entity_id=invoice.id,
            new_values=_invoice_snapshot(invoice),
        )

        return invoice

    def add_item(
        self,
        *,
        invoice_id: int,
        actor_id: int,
        line_number: int,
        description: str,
        quantity: Decimal = Decimal("1"),
        unit_price: Decimal,
        discount_amount: Decimal = Decimal("0"),
        tax_amount: Decimal = Decimal("0"),
    ) -> PlatformInvoiceItem:
        """Add a line item to a DRAFT invoice."""
        invoice = self._get_invoice(invoice_id)
        self._require_status(invoice, PlatformInvoiceStatus.DRAFT)

        total = (quantity * unit_price) - discount_amount + tax_amount

        item = PlatformInvoiceItem(
            platform_invoice_id=invoice_id,
            line_number=line_number,
            description=description,
            quantity=quantity,
            unit_price=unit_price,
            discount_amount=discount_amount,
            tax_amount=tax_amount,
            total=total,
        )
        self.db.add(item)
        self.db.flush()

        self.calculate_totals(invoice)
        return item

    def calculate_totals(self, invoice: PlatformInvoice):
        """Recalculate invoice totals from line items.

        subtotal = sum(qty * unit_price) — the net-before-discount-and-tax.
        total_amount = subtotal - discount_amount + tax_amount.
        Shared by preview AND finalize to prevent drift. The rule is:
        the same formula runs at both preview and finalize; if items change
        after preview, finalize recalculates (never trusts a cached total).
        """
        items = (
            self.db.query(PlatformInvoiceItem)
            .filter(PlatformInvoiceItem.platform_invoice_id == invoice.id)
            .all()
        )

        invoice.subtotal = sum(
            (i.quantity or Decimal("0")) * (i.unit_price or Decimal("0"))
            for i in items
        ) if items else Decimal("0")
        invoice.discount_amount = sum(i.discount_amount for i in items) if items else Decimal("0")
        invoice.tax_amount = sum(i.tax_amount for i in items) if items else Decimal("0")
        invoice.total_amount = invoice.subtotal - invoice.discount_amount + invoice.tax_amount
        invoice.balance_due = invoice.total_amount - invoice.paid_amount
        self.db.flush()

    def finalize(self, *, invoice_id: int, actor_id: int) -> PlatformInvoice:
        """Finalize a DRAFT invoice: allocate invoice_number and transition to ISSUED.

        Invoice number is allocated atomically from PlatformInvoiceNumberSequence
        using SELECT FOR UPDATE. This is the ONLY place invoice numbers are
        allocated — never at draft creation.
        """
        invoice = self._get_invoice(invoice_id)
        self._require_status(invoice, PlatformInvoiceStatus.DRAFT)

        # Recalculate totals one final time (prevent drift)
        self.calculate_totals(invoice)

        if not invoice.items:
            raise ValueError("Cannot finalize invoice with no line items")

        # Allocate invoice number atomically
        invoice_number = self._allocate_invoice_number()

        old = _invoice_snapshot(invoice)
        invoice.invoice_number = invoice_number
        invoice.status = PlatformInvoiceStatus.ISSUED
        invoice.issue_date = invoice.issue_date or date.today()
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.INVOICE_FINALIZED,
            entity_type="platform_invoice",
            entity_id=invoice.id,
            old_values=old,
            new_values=_invoice_snapshot(invoice),
        )

        return invoice

    def send(self, *, invoice_id: int, actor_id: int) -> PlatformInvoice:
        """Mark an ISSUED invoice as sent and email it to the org's admin.

        Mirrors Plane 2's rule (invoice_service.send_invoice_via_email): the
        email must succeed before any DB mutation is committed. No PDF this
        pass — the public link carries full detail.
        """
        invoice = self._get_invoice(invoice_id)
        self._require_status(
            invoice,
            PlatformInvoiceStatus.ISSUED,
        )

        if not invoice.public_token:
            import secrets

            invoice.public_token = secrets.token_urlsafe(32)
            self.db.flush()

        recipient = self._resolve_recipient(invoice)
        if recipient is None:
            raise ValueError(
                f"No org_admin found for commercial_account {invoice.commercial_account_id}; "
                "cannot send invoice email"
            )

        sent = self._send_invoice_email(invoice, recipient)
        if not sent:
            self.db.rollback()
            # Recorded in its own commit — the rollback above discarded the
            # invoice-mutation attempt, but delivery evidence (§E5) must
            # survive a failed send, not just a successful one.
            self.db.add(PlatformInvoiceDeliveryAttempt(
                platform_invoice_id=invoice.id,
                channel="email",
                provider="smtp",
                result="failure",
                error_detail=f"Failed to email invoice {invoice.invoice_number} to {recipient.email}",
            ))
            self.db.commit()
            raise ValueError(f"Failed to email invoice {invoice.invoice_number} to {recipient.email}")

        old = _invoice_snapshot(invoice)
        invoice.delivery_status = PlatformInvoiceDeliveryStatus.SENT
        invoice.sent_at = datetime.utcnow()
        self.db.add(PlatformInvoiceDeliveryAttempt(
            platform_invoice_id=invoice.id,
            channel="email",
            provider="smtp",
            result="success",
        ))
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.INVOICE_SENT,
            entity_type="platform_invoice",
            entity_id=invoice.id,
            old_values=old,
            new_values=_invoice_snapshot(invoice),
        )

        return invoice

    def _resolve_recipient(self, invoice: PlatformInvoice):
        """The org's admin — Plane 1's "accept-and-pay only" recipient."""
        from app.modules.auth.models import User

        account = invoice.account
        if account is None:
            return None
        return (
            self.db.query(User)
            .filter(User.organization_id == account.organization_id, User.role == "org_admin")
            .first()
        )

    def _send_invoice_email(self, invoice: PlatformInvoice, recipient) -> bool:
        from app.config import settings as _settings
        from app.services.email_service import send_platform_invoice_email

        org_name = (
            invoice.account.organization.organization_name
            if invoice.account and invoice.account.organization
            else "your organization"
        )
        review_url = f"{_settings.FRONTEND_URL.rstrip('/')}/platform-invoice/{invoice.public_token}"
        line_items = [
            {
                "description": item.description,
                "quantity": str(item.quantity),
                "unit_price": str(item.unit_price),
                "total_amount": str(item.total),
            }
            for item in sorted(invoice.items, key=lambda i: i.line_number)
        ]
        return send_platform_invoice_email(
            recipient.email,
            org_name,
            invoice.invoice_number,
            str(invoice.issue_date or ""),
            str(invoice.due_date or ""),
            str(invoice.total_amount),
            currency=invoice.currency,
            status=invoice.status.value,
            balance_due=str(invoice.balance_due),
            notes=invoice.notes or "",
            db=self.db,
            recipient_first_name=recipient.first_name,
            line_items=line_items,
            subtotal=str(invoice.subtotal),
            tax_amount=str(invoice.tax_amount),
            amount_paid=str(invoice.paid_amount),
            review_url=review_url,
        )

    def mark_delivered(self, *, invoice_id: int) -> PlatformInvoice:
        """Mark an invoice as delivered (called by delivery callback)."""
        invoice = self._get_invoice(invoice_id)
        invoice.delivery_status = PlatformInvoiceDeliveryStatus.DELIVERED
        invoice.delivered_at = datetime.utcnow()
        invoice.status = PlatformInvoiceStatus.DELIVERED
        self.db.flush()
        return invoice

    def mark_delivery_failed(self, *, invoice_id: int) -> PlatformInvoice:
        """Mark an invoice delivery as failed."""
        invoice = self._get_invoice(invoice_id)
        invoice.delivery_status = PlatformInvoiceDeliveryStatus.FAILED
        invoice.delivery_failed_at = datetime.utcnow()
        invoice.status = PlatformInvoiceStatus.DELIVERY_FAILED
        self.db.flush()
        return invoice

    def void(self, *, invoice_id: int, actor_id: int, reason: str) -> PlatformInvoice:
        """Void a non-DRAFT invoice. No PUT/PATCH/DELETE on issued invoices."""
        invoice = self._get_invoice(invoice_id)

        if invoice.status == PlatformInvoiceStatus.DRAFT:
            raise ValueError("Use delete for draft invoices; void is for issued invoices")

        allowed = _TRANSITIONS.get(invoice.status, set())
        if PlatformInvoiceStatus.VOIDED not in allowed:
            raise ValueError(
                f"Cannot void invoice in status {invoice.status.value}"
            )

        old = _invoice_snapshot(invoice)
        invoice.status = PlatformInvoiceStatus.VOIDED
        invoice.voided_at = datetime.utcnow()
        invoice.voided_reason = reason
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.INVOICE_VOIDED,
            entity_type="platform_invoice",
            entity_id=invoice.id,
            old_values=old,
            new_values=_invoice_snapshot(invoice),
            reason=reason,
        )

        return invoice

    def record_payment(
        self, *, invoice_id: int, amount: Decimal, actor_id: int
    ) -> PlatformInvoice:
        """Record a payment against an invoice. Updates paid_amount, balance_due, status."""
        invoice = self._get_invoice(invoice_id)

        if invoice.status in (PlatformInvoiceStatus.VOIDED, PlatformInvoiceStatus.CREDITED):
            raise ValueError(f"Cannot record payment on {invoice.status.value} invoice")

        if amount <= 0:
            raise ValueError("Payment amount must be positive")

        old = _invoice_snapshot(invoice)
        invoice.paid_amount = invoice.paid_amount + amount
        invoice.balance_due = invoice.total_amount - invoice.paid_amount

        if invoice.balance_due <= 0:
            invoice.balance_due = Decimal("0")
            invoice.paid_at = datetime.utcnow()
            invoice.status = PlatformInvoiceStatus.PAID
            invoice.payment_status = PlatformInvoicePaymentStatus.FULL
        else:
            invoice.status = PlatformInvoiceStatus.PARTIALLY_PAID
            invoice.payment_status = PlatformInvoicePaymentStatus.PARTIAL

        self.db.flush()
        return invoice

    def record_refund(
        self, *, invoice_id: int, amount: Decimal, actor_id: int
    ) -> PlatformInvoice:
        """Record a refund against an invoice (inverse of payment)."""
        invoice = self._get_invoice(invoice_id)

        if invoice.status in (PlatformInvoiceStatus.VOIDED,):
            raise ValueError(f"Cannot record refund on {invoice.status.value} invoice")

        if amount <= 0:
            raise ValueError("Refund amount must be positive")

        old = _invoice_snapshot(invoice)
        invoice.paid_amount = invoice.paid_amount - amount
        invoice.balance_due = invoice.total_amount - invoice.paid_amount

        if invoice.balance_due <= 0:
            invoice.balance_due = Decimal("0")

        if invoice.paid_amount <= 0:
            invoice.paid_amount = Decimal("0")
            invoice.payment_status = PlatformInvoicePaymentStatus.NONE
            if invoice.status == PlatformInvoiceStatus.PAID:
                invoice.status = PlatformInvoiceStatus.DUE
        else:
            invoice.payment_status = PlatformInvoicePaymentStatus.PARTIAL

        self.db.flush()
        return invoice

    def record_write_off(
        self, *, invoice_id: int, amount: Decimal, actor_id: int
    ) -> PlatformInvoice:
        """Write off a portion of the balance (collection abandoned)."""
        invoice = self._get_invoice(invoice_id)

        if invoice.status in (PlatformInvoiceStatus.VOIDED, PlatformInvoiceStatus.CREDITED):
            raise ValueError(f"Cannot write off {invoice.status.value} invoice")

        if amount <= 0:
            raise ValueError("Write-off amount must be positive")

        old = _invoice_snapshot(invoice)
        invoice.balance_due = invoice.balance_due - amount
        if invoice.balance_due < Decimal("0"):
            invoice.balance_due = Decimal("0")

        if invoice.balance_due == Decimal("0"):
            invoice.status = PlatformInvoiceStatus.CREDITED

        self.db.flush()
        return invoice

    # ── Helpers ─────────────────────────────────────────────────────────────

    def get_public_invoice(self, token: str) -> PlatformInvoice:
        """Publicly view an invoice via its token. No auth required."""
        invoice = (
            self.db.query(PlatformInvoice)
            .filter(PlatformInvoice.public_token == token)
            .first()
        )
        if not invoice:
            raise ValueError("Invoice not found or link expired")
        return invoice

    def _get_invoice(self, invoice_id: int) -> PlatformInvoice:
        invoice = self.db.query(PlatformInvoice).get(invoice_id)
        if not invoice:
            raise ValueError(f"PlatformInvoice {invoice_id} not found")
        return invoice

    def _require_status(self, invoice: PlatformInvoice, expected: PlatformInvoiceStatus):
        if invoice.status != expected:
            raise ValueError(
                f"Invoice must be {expected.value}; current: {invoice.status.value}"
            )

    def _allocate_invoice_number(self) -> str:
        """Allocate next invoice number atomically via SELECT FOR UPDATE."""
        seq = (
            self.db.query(PlatformInvoiceNumberSequence)
            .with_for_update()
            .first()
        )
        if not seq:
            # Seed the sequence row
            seq = PlatformInvoiceNumberSequence(prefix="PINV-", next_number=1)
            self.db.add(seq)
            self.db.flush()
            # Re-fetch with lock
            seq = (
                self.db.query(PlatformInvoiceNumberSequence)
                .with_for_update()
                .first()
            )

        number = seq.next_number
        seq.next_number = number + 1
        self.db.flush()

        return f"{seq.prefix}{number:06d}"


# ── First-invoice generation (registration → PENDING subscription) ─────────
# provision_default_subscription() creates a PENDING self-serve subscription
# but never invented a price for it, so nothing ever produced the invoice
# the org needs to pay to activate it. This closes that gap: called once,
# right after provisioning, from register_enterprise().

INITIAL_INVOICE_NET_DAYS = 7


def generate_initial_invoice_for_subscription(
    db: Session, subscription, *, actor_id: Optional[int] = None,
) -> Optional[PlatformInvoice]:
    """Create + finalize (DRAFT -> ISSUED) the first invoice for a newly
    provisioned PENDING CommercialSubscription. Returns None (never invents
    a price) if the subscription's plan has no resolvable price. Does NOT
    send/email the invoice — callers decide sync vs background (see
    send_invoice_in_background below), so this stays fast and DB-only.
    """
    from app.modules.commercial.service import CommercialSubscriptionService

    priced = CommercialSubscriptionService(db).resolve_price(subscription)
    if priced is None:
        logger.info(
            "No resolvable price for subscription %s's plan — skipping initial invoice.",
            subscription.id,
        )
        return None
    price_amount, currency, _interval = priced

    plan_name = subscription.plan.plan_name if subscription.plan else "Subscription"
    svc = PlatformInvoiceService(db)
    issue = date.today()
    invoice = svc.create_draft(
        account_id=subscription.commercial_account_id,
        actor_id=actor_id,
        invoice_type="standard",
        subscription_id=subscription.id,
        issue_date=issue,
        due_date=issue + timedelta(days=INITIAL_INVOICE_NET_DAYS),
        notes=f"Initial invoice for {plan_name} - pay to activate your subscription.",
        currency=currency or "USD",
    )
    svc.add_item(
        invoice_id=invoice.id,
        actor_id=actor_id,
        line_number=1,
        description=f"{plan_name} - subscription (first period)",
        unit_price=price_amount,
    )
    svc.finalize(invoice_id=invoice.id, actor_id=actor_id)
    return invoice


def send_invoice_email_with_session(db: Session, invoice_id: int) -> None:
    """Send a PlatformInvoice email using WHATEVER session the caller gives
    it. A transient SMTP failure is logged, never raised — the invoice
    itself already exists and is valid regardless of whether this email
    succeeds. Use this (not send_invoice_in_background) for a synchronous
    caller sharing a session (e.g. register_enterprise's no-BackgroundTasks
    fallback) — a fresh SessionLocal() can't see an invoice created in an
    uncommitted/test-transactional session."""
    try:
        PlatformInvoiceService(db).send(invoice_id=invoice_id, actor_id=None)
        db.commit()
    except Exception as exc:
        logger.warning("[invoice] Send failed for invoice %s: %s", invoice_id, exc)
        db.rollback()


def send_invoice_in_background(invoice_id: int) -> None:
    """FastAPI BackgroundTasks entry point — opens its OWN DB session, safe
    to call after the request's session has already closed (the invoice is
    guaranteed committed by then — created_initial_invoice_for_subscription
    runs inside the same transaction register_enterprise commits before
    scheduling this)."""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        send_invoice_email_with_session(db, invoice_id)
    finally:
        db.close()
