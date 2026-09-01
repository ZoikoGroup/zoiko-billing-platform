"""
modules/commercial/quote_service.py
------------------------------------
Plane 1 — Commercial Quote service (Zoiko-to-org quoting).

Quote lifecycle:
  DRAFT → SENT → [ACCEPTED | REJECTED | EXPIRED] → CONVERTED (→ PlatformInvoice)

Scope: operates ONLY on CommercialQuote / CommercialQuoteItem rows.
Never touches Plane 2 tables (Invoice, Quotation, etc.).

Every mutation writes a PlatformAuditLog entry via PlatformAuditService.

DOCTRINE:
  - No FK to Plane 2 tables
  - No import from billing/services/
  - Approver != Creator enforced on discount approval and quote acceptance
"""

import logging
import secrets
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.commercial.enums import (
    CommercialQuoteStatus,
    PlatformInvoiceStatus,
    PlatformInvoiceType,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialQuote,
    CommercialQuoteItem,
    PlatformInvoice,
    PlatformInvoiceItem,
)
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction

logger = logging.getLogger("zoiko_billing.commercial.quote")

# ── Quote numbering prefix ─────────────────────────────────────────────────
QUOTE_PREFIX = "CQT-"


def _quote_snapshot(quote: CommercialQuote) -> dict:
    """Auditable snapshot of a quote's key fields."""
    return {
        "quote_number": quote.quote_number,
        "status": quote.status.value if hasattr(quote.status, "value") else quote.status,
        "subject": quote.subject,
        "subtotal": str(quote.subtotal),
        "discount_amount": str(quote.discount_amount),
        "tax_amount": str(quote.tax_amount),
        "total_amount": str(quote.total_amount),
        "currency": quote.currency,
        "valid_until": quote.valid_until.isoformat() if quote.valid_until else None,
    }


def _next_quote_number(db: Session, account_id: int) -> str:
    """Generate next quote number scoped to the commercial account.

    Format: CQT-{account_id}-{sequence}. Sequence is per-account, starting at 1.
    """
    last = (
        db.query(CommercialQuote)
        .filter(CommercialQuote.commercial_account_id == account_id)
        .order_by(CommercialQuote.id.desc())
        .first()
    )
    if last and last.quote_number:
        # Extract sequence number from last quote
        parts = last.quote_number.rsplit("-", 1)
        try:
            seq = int(parts[-1]) + 1
        except (ValueError, IndexError):
            seq = 1
    else:
        seq = 1
    return f"{QUOTE_PREFIX}{account_id}-{seq:04d}"


class CommercialQuoteService:
    def __init__(self, db: Session):
        self.db = db
        self._audit = PlatformAuditService(db)

    def create_quote(
        self,
        *,
        account_id: int,
        actor_id: int,
        subject: Optional[str] = None,
        notes: Optional[str] = None,
        terms: Optional[str] = None,
        valid_until: Optional[date] = None,
        currency: str = "USD",
        subscription_id: Optional[int] = None,
    ) -> CommercialQuote:
        """Create a new DRAFT quote for a commercial account."""
        quote_number = _next_quote_number(self.db, account_id)

        quote = CommercialQuote(
            commercial_account_id=account_id,
            commercial_subscription_id=subscription_id,
            quote_number=quote_number,
            status=CommercialQuoteStatus.DRAFT,
            subject=subject,
            notes=notes,
            terms=terms,
            valid_until=valid_until,
            currency=currency,
            created_by=actor_id,
        )
        self.db.add(quote)
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.QUOTE_CREATED,
            entity_type="commercial_quote",
            entity_id=quote.id,
            new_values=_quote_snapshot(quote),
        )

        return quote

    def add_item(
        self,
        *,
        quote_id: int,
        actor_id: int,
        line_number: int,
        description: str,
        quantity: Decimal = Decimal("1"),
        unit_price: Decimal,
        discount_amount: Decimal = Decimal("0"),
        tax_amount: Decimal = Decimal("0"),
    ) -> CommercialQuoteItem:
        """Add a line item to a DRAFT quote."""
        quote = self._get_quote(quote_id)
        self._require_status(quote, CommercialQuoteStatus.DRAFT)

        total = (quantity * unit_price) - discount_amount + tax_amount

        item = CommercialQuoteItem(
            quote_id=quote_id,
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

        self._recalculate_totals(quote)
        return item

    def set_discount(
        self,
        *,
        quote_id: int,
        actor_id: int,
        discount_amount: Decimal,
        reason: Optional[str] = None,
        approver_id: Optional[int] = None,
    ) -> CommercialQuote:
        """Set a quote-level discount on a DRAFT quote, with its approver/reason.

        This is distinct from per-item discount_amount (which rolls up into
        quote.discount_amount via _recalculate_totals): a quote-level
        discount above COMMERCIAL_QUOTE_DISCOUNT_APPROVAL_THRESHOLD_PERCENT
        of subtotal is enforced at send_quote() time (§B7) — approver must
        differ from the quote's creator.
        """
        quote = self._get_quote(quote_id)
        self._require_status(quote, CommercialQuoteStatus.DRAFT)

        if discount_amount < 0:
            raise ValueError("Discount amount cannot be negative")

        old = _quote_snapshot(quote)
        quote.discount_amount = discount_amount
        quote.discount_reason = reason
        quote.discount_approver_id = approver_id
        quote.total_amount = quote.subtotal - quote.discount_amount + quote.tax_amount
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.UPDATE,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
        )

        return quote

    def send_quote(self, *, quote_id: int, actor_id: int) -> CommercialQuote:
        """Send a DRAFT quote to the org's admin by email. Generates
        public_token. Mirrors PlatformInvoiceService.send(): the email must
        succeed before any DB mutation is committed.

        Enforces §B7 discount approval: a quote-level discount at or above
        COMMERCIAL_QUOTE_DISCOUNT_APPROVAL_THRESHOLD_PERCENT of subtotal
        requires discount_reason set and discount_approver_id set to a user
        other than the quote's creator.
        """
        quote = self._get_quote(quote_id)
        self._require_status(quote, CommercialQuoteStatus.DRAFT)
        self._enforce_discount_approval(quote)

        if not quote.public_token:
            quote.public_token = secrets.token_urlsafe(32)
            self.db.flush()

        recipient = self._resolve_recipient(quote)
        if recipient is None:
            raise ValueError(
                f"No org_admin found for commercial_account {quote.commercial_account_id}; "
                "cannot send quote email"
            )

        sent = self._send_quote_email(quote, recipient)
        if not sent:
            self.db.rollback()
            raise ValueError(f"Failed to email quote {quote.quote_number} to {recipient.email}")

        old = _quote_snapshot(quote)
        quote.status = CommercialQuoteStatus.SENT
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.QUOTE_SENT,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
        )

        return quote

    def _resolve_recipient(self, quote: CommercialQuote):
        """The org's admin — Plane 1's "accept-and-pay only" recipient."""
        from app.modules.auth.models import User

        account = quote.account
        if account is None:
            return None
        return (
            self.db.query(User)
            .filter(User.organization_id == account.organization_id, User.role == "org_admin")
            .first()
        )

    def _send_quote_email(self, quote: CommercialQuote, recipient) -> bool:
        from app.config import settings as _settings
        from app.services.email_service import send_platform_quote_email

        org_name = (
            quote.account.organization.organization_name
            if quote.account and quote.account.organization
            else "your organization"
        )
        review_url = f"{_settings.FRONTEND_URL.rstrip('/')}/platform-quote/{quote.public_token}"
        line_items = [
            {
                "description": item.description,
                "quantity": str(item.quantity),
                "unit_price": str(item.unit_price),
                "total_amount": str(item.total),
            }
            for item in sorted(quote.items, key=lambda i: i.line_number)
        ]
        return send_platform_quote_email(
            recipient.email,
            org_name,
            quote.quote_number,
            str(quote.total_amount),
            currency=quote.currency,
            valid_until=str(quote.valid_until or ""),
            notes=quote.notes or "",
            terms=quote.terms or "",
            db=self.db,
            recipient_first_name=recipient.first_name,
            line_items=line_items,
            subtotal=str(quote.subtotal),
            discount_amount=str(quote.discount_amount),
            tax_amount=str(quote.tax_amount),
            review_url=review_url,
        )

    def approve_quote(self, *, quote_id: int, actor_id: int) -> CommercialQuote:
        """Approve (accept) a SENT quote. Enforces actor != creator.

        This is the authenticated Super Admin approve path. The public accept
        path (accept_public_quote) is separate and unauthenticated.
        """
        quote = self._get_quote(quote_id)
        self._require_status(quote, CommercialQuoteStatus.SENT)

        if quote.created_by and quote.created_by == actor_id:
            from app.modules.super_admin.approval_service import SelfApprovalError
            raise SelfApprovalError(
                "Quote approver must be different from the quote creator"
            )

        old = _quote_snapshot(quote)
        quote.status = CommercialQuoteStatus.ACCEPTED
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.QUOTE_ACCEPTED,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
        )

        return quote

    def reject_quote(
        self, *, quote_id: int, actor_id: int, reason: str = ""
    ) -> CommercialQuote:
        """Reject a SENT quote."""
        quote = self._get_quote(quote_id)
        self._require_status(quote, CommercialQuoteStatus.SENT)

        old = _quote_snapshot(quote)
        quote.status = CommercialQuoteStatus.REJECTED
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.QUOTE_REJECTED,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
            reason=reason,
        )

        return quote

    def expire_quotes(self, *, actor_id: Optional[int] = None) -> int:
        """Bulk-expire all SENT quotes past their valid_until date.

        Returns count of expired quotes. Typically called by a scheduled job.
        """
        today = date.today()
        expired = (
            self.db.query(CommercialQuote)
            .filter(
                CommercialQuote.status == CommercialQuoteStatus.SENT,
                CommercialQuote.valid_until.isnot(None),
                CommercialQuote.valid_until < today,
            )
            .all()
        )

        for quote in expired:
            old = _quote_snapshot(quote)
            quote.status = CommercialQuoteStatus.EXPIRED
            self._audit.log_no_commit(
                actor_id=actor_id,
                action=PlatformAuditAction.QUOTE_EXPIRED,
                entity_type="commercial_quote",
                entity_id=quote.id,
                old_values=old,
                new_values=_quote_snapshot(quote),
            )

        return len(expired)

    def convert_to_invoice(
        self,
        *,
        quote_id: int,
        actor_id: int,
        due_date: Optional[date] = None,
    ) -> PlatformInvoice:
        """Convert an ACCEPTED quote to a PlatformInvoice (DRAFT).

        Creates the invoice + line items from quote items. The invoice starts
        as DRAFT; finalize is a separate action.
        """
        quote = self._get_quote(quote_id)
        self._require_status(quote, CommercialQuoteStatus.CONVERTED, invert=True)

        if quote.status not in (
            CommercialQuoteStatus.ACCEPTED,
            CommercialQuoteStatus.CONVERTED,
        ):
            raise ValueError(
                f"Quote must be ACCEPTED to convert; current status: {quote.status.value}"
            )

        if quote.status == CommercialQuoteStatus.CONVERTED and quote.converted_platform_invoice_id:
            # Already converted — return existing invoice
            return self.db.query(PlatformInvoice).get(quote.converted_platform_invoice_id)

        # Create PlatformInvoice from quote totals
        invoice = PlatformInvoice(
            commercial_account_id=quote.commercial_account_id,
            commercial_subscription_id=quote.commercial_subscription_id,
            status=PlatformInvoiceStatus.DRAFT,
            invoice_type=PlatformInvoiceType.STANDARD,
            issue_date=date.today(),
            due_date=due_date,
            subtotal=quote.subtotal,
            discount_amount=quote.discount_amount,
            tax_amount=quote.tax_amount,
            total_amount=quote.total_amount,
            balance_due=quote.total_amount,
            currency=quote.currency,
            notes=f"Converted from quote {quote.quote_number}",
            created_by=actor_id,
        )
        self.db.add(invoice)
        self.db.flush()

        # Copy line items
        for qi in quote.items:
            item = PlatformInvoiceItem(
                platform_invoice_id=invoice.id,
                line_number=qi.line_number,
                description=qi.description,
                quantity=qi.quantity,
                unit_price=qi.unit_price,
                discount_amount=qi.discount_amount,
                tax_amount=qi.tax_amount,
                total=qi.total,
            )
            self.db.add(item)

        # Mark quote as converted
        old = _quote_snapshot(quote)
        quote.status = CommercialQuoteStatus.CONVERTED
        quote.converted_platform_invoice_id = invoice.id
        quote.converted_subscription_id = quote.commercial_subscription_id
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.QUOTE_CONVERTED,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
            metadata={"platform_invoice_id": invoice.id},
        )

        return invoice

    # ── Public (unauthenticated) quote actions ──────────────────────────────

    def get_public_quote(self, token: str) -> CommercialQuote:
        """Publicly view a quote via its token. No auth required."""
        quote = (
            self.db.query(CommercialQuote)
            .filter(CommercialQuote.public_token == token)
            .first()
        )
        if not quote:
            raise ValueError("Quote not found or link expired")
        return quote

    def accept_public_quote(self, token: str) -> CommercialQuote:
        """Publicly accept a quote via its token. No auth required."""
        quote = self.get_public_quote(token)
        if quote.status != CommercialQuoteStatus.SENT:
            raise ValueError(f"Quote cannot be accepted in status: {quote.status.value}")

        old = _quote_snapshot(quote)
        quote.status = CommercialQuoteStatus.ACCEPTED
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=None,
            action=PlatformAuditAction.QUOTE_ACCEPTED,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
            metadata={"via": "public_token"},
        )

        return quote

    def reject_public_quote(self, token: str, reason: str = "") -> CommercialQuote:
        """Publicly reject a quote via its token. No auth required."""
        quote = self.get_public_quote(token)
        if quote.status != CommercialQuoteStatus.SENT:
            raise ValueError(f"Quote cannot be rejected in status: {quote.status.value}")

        old = _quote_snapshot(quote)
        quote.status = CommercialQuoteStatus.REJECTED
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=None,
            action=PlatformAuditAction.QUOTE_REJECTED,
            entity_type="commercial_quote",
            entity_id=quote.id,
            old_values=old,
            new_values=_quote_snapshot(quote),
            reason=reason,
            metadata={"via": "public_token"},
        )

        return quote

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _get_quote(self, quote_id: int) -> CommercialQuote:
        quote = self.db.query(CommercialQuote).get(quote_id)
        if not quote:
            raise ValueError(f"Quote {quote_id} not found")
        return quote

    def _enforce_discount_approval(self, quote: CommercialQuote) -> None:
        """§B7: a discount at/above the configured % of subtotal requires a
        reason and an approver different from the quote's creator."""
        from app.config import settings as _settings

        if quote.subtotal <= 0 or quote.discount_amount <= 0:
            return

        threshold = Decimal(str(_settings.COMMERCIAL_QUOTE_DISCOUNT_APPROVAL_THRESHOLD_PERCENT))
        discount_pct = (quote.discount_amount / quote.subtotal) * Decimal("100")
        if discount_pct < threshold:
            return

        if not quote.discount_reason:
            raise ValueError(
                f"Discount of {discount_pct:.1f}% requires discount_reason "
                f"(threshold: {threshold}%)"
            )
        if not quote.discount_approver_id:
            raise ValueError(
                f"Discount of {discount_pct:.1f}% requires a discount_approver_id "
                f"(threshold: {threshold}%)"
            )
        if quote.discount_approver_id == quote.created_by:
            from app.modules.super_admin.approval_service import SelfApprovalError
            raise SelfApprovalError("Discount approver must be different from the quote creator")

    def _require_status(
        self, quote: CommercialQuote, expected: CommercialQuoteStatus, *, invert: bool = False
    ):
        current = quote.status
        if invert:
            if current == expected:
                raise ValueError(
                    f"Quote must NOT be {expected.value}; current: {current.value}"
                )
        else:
            if current != expected:
                raise ValueError(
                    f"Quote must be {expected.value}; current: {current.value}"
                )

    def _recalculate_totals(self, quote: CommercialQuote):
        """Recalculate quote totals from line items.

        subtotal = sum(qty * unit_price) — the net-before-discount-and-tax.
        total_amount = subtotal - discount_amount + tax_amount.
        Same formula used at invoice-finalize to prevent drift.
        """
        items = (
            self.db.query(CommercialQuoteItem)
            .filter(CommercialQuoteItem.quote_id == quote.id)
            .all()
        )
        quote.subtotal = sum(
            (i.quantity or Decimal("0")) * (i.unit_price or Decimal("0"))
            for i in items
        ) if items else Decimal("0")
        quote.discount_amount = sum(i.discount_amount for i in items) if items else Decimal("0")
        quote.tax_amount = sum(i.tax_amount for i in items) if items else Decimal("0")
        quote.total_amount = quote.subtotal - quote.discount_amount + quote.tax_amount
        self.db.flush()


# ── Background-safe email dispatch ──────────────────────────────────────────
# Mirrors platform_invoice_service.send_invoice_email_with_session /
# send_invoice_in_background: a real SMTP send must never run inline in a
# latency-sensitive request/response cycle (e.g. registration).

def send_quote_email_with_session(db: Session, quote_id: int) -> None:
    """Send a CommercialQuote email using WHATEVER session the caller gives
    it. A transient SMTP failure is logged, never raised — the quote itself
    already exists and is valid regardless of whether this email succeeds."""
    try:
        CommercialQuoteService(db).send_quote(quote_id=quote_id, actor_id=None)
        db.commit()
    except Exception as exc:
        logger.warning("[quote] Send failed for quote %s: %s", quote_id, exc)
        db.rollback()


def send_quote_in_background(quote_id: int) -> None:
    """FastAPI BackgroundTasks entry point — opens its OWN DB session, safe
    to call after the request's session has already closed (the quote is
    guaranteed committed by then)."""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        send_quote_email_with_session(db, quote_id)
    finally:
        db.close()
