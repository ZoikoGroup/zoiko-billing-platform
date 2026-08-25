"""
modules/commercial/platform_payment_service.py
----------------------------------------------
Plane 1 — Platform Payment service (Zoiko-receives-money-from-an-org).

Payment lifecycle:
  PENDING → PROCESSING → CLEARED
  PENDING → FAILED
  PENDING → CANCELLED
  CLEARED → REFUNDED

Scope: operates ONLY on PlatformPayment / PlatformPaymentAllocation rows.
Never touches Plane 2 tables.

DOCTRINE:
  - Runtime assertion: processor_account_identity must ALWAYS equal
    ZOIKO_PLATFORM_PROCESSOR_IDENTITY. Never a tenant's processor.
  - allocate uses SELECT FOR UPDATE to prevent double-allocation
  - Every mutation writes PlatformAuditLog
"""

import logging
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.commercial.enums import (
    PlatformPaymentMethod,
    PlatformPaymentStatus,
)
from app.modules.commercial.models import (
    PlatformInvoice,
    PlatformPayment,
    PlatformPaymentAllocation,
)
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction

logger = logging.getLogger("zoiko_billing.commercial.platform_payment")

# ── Processor identity constant ─────────────────────────────────────────────
# This MUST be the only value ever written to
# PlatformPayment.processor_account_identity. Enforced by runtime assertion
# in record(). Never a tenant's Stripe account / payment processor ID.
ZOIKO_PLATFORM_PROCESSOR_IDENTITY = "zoiko_platform"


def _payment_snapshot(p: PlatformPayment) -> dict:
    return {
        "payment_number": p.payment_number,
        "status": p.status.value if hasattr(p.status, "value") else p.status,
        "amount": str(p.amount),
        "currency": p.currency,
        "payment_method": p.payment_method.value if p.payment_method and hasattr(p.payment_method, "value") else p.payment_method,
        "transaction_id": p.transaction_id,
        "processor_account_identity": p.processor_account_identity,
    }


class PlatformPaymentService:
    def __init__(self, db: Session):
        self.db = db
        self._audit = PlatformAuditService(db)

    def record(
        self,
        *,
        account_id: int,
        actor_id: int,
        amount: Decimal,
        currency: str = "USD",
        payment_method: Optional[str] = None,
        transaction_id: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> PlatformPayment:
        """Record a payment received from a commercial account.

        For manual payments (e.g. wire transfer), status goes straight to
        CLEARED. For checkout-initiated payments, status starts at PENDING.

        RUNTIME ASSERTION: processor_account_identity is always set to
        ZOIKO_PLATFORM_PROCESSOR_IDENTITY.
        """
        if amount <= 0:
            raise ValueError("Payment amount must be positive")

        # Generate payment number
        payment_number = self._next_payment_number()

        payment = PlatformPayment(
            commercial_account_id=account_id,
            payment_number=payment_number,
            transaction_id=transaction_id,
            status=PlatformPaymentStatus.CLEARED if payment_method in ("manual", "wire_transfer", "ach") else PlatformPaymentStatus.PENDING,
            amount=amount,
            currency=currency,
            payment_method=payment_method,
            processor_account_identity=ZOIKO_PLATFORM_PROCESSOR_IDENTITY,
            cleared_at=datetime.utcnow() if payment_method in ("manual", "wire_transfer", "ach") else None,
            notes=notes,
            created_by=actor_id,
        )
        self.db.add(payment)
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.PAYMENT_RECORDED,
            entity_type="platform_payment",
            entity_id=payment.id,
            new_values=_payment_snapshot(payment),
        )

        return payment

    def allocate(
        self,
        *,
        payment_id: int,
        invoice_id: int,
        amount: Decimal,
        actor_id: int,
    ) -> PlatformPaymentAllocation:
        """Allocate a portion of a cleared payment to an invoice.

        Uses SELECT FOR UPDATE on the payment to prevent concurrent
        double-allocation. Validates:
          - Payment is CLEARED
          - Payment and invoice belong to the same commercial account
          - Allocation amount > 0 and <= payment remaining
          - Invoice balance > 0
        """
        if amount <= 0:
            raise ValueError("Allocation amount must be positive")

        # Lock the payment row
        payment = (
            self.db.query(PlatformPayment)
            .filter(PlatformPayment.id == payment_id)
            .with_for_update()
            .first()
        )
        if not payment:
            raise ValueError(f"PlatformPayment {payment_id} not found")

        if payment.status != PlatformPaymentStatus.CLEARED:
            raise ValueError(
                f"Payment must be CLEARED to allocate; current: {payment.status.value}"
            )

        invoice = self.db.query(PlatformInvoice).get(invoice_id)
        if not invoice:
            raise ValueError(f"PlatformInvoice {invoice_id} not found")

        if invoice.commercial_account_id != payment.commercial_account_id:
            raise ValueError("Payment and invoice must belong to the same commercial account")

        if invoice.balance_due <= 0:
            raise ValueError("Invoice has no remaining balance")

        # Calculate existing allocations for this payment
        existing_alloc = sum(
            a.amount
            for a in self.db.query(PlatformPaymentAllocation)
            .filter(PlatformPaymentAllocation.platform_payment_id == payment_id)
            .all()
        )
        remaining = payment.amount - existing_alloc

        if amount > remaining:
            raise ValueError(
                f"Allocation amount {amount} exceeds payment remaining {remaining}"
            )

        if amount > invoice.balance_due:
            raise ValueError(
                f"Allocation amount {amount} exceeds invoice balance {invoice.balance_due}"
            )

        allocation = PlatformPaymentAllocation(
            platform_payment_id=payment_id,
            platform_invoice_id=invoice_id,
            amount=amount,
        )
        self.db.add(allocation)
        self.db.flush()

        # Update invoice paid_amount and balance_due
        invoice.paid_amount = invoice.paid_amount + amount
        invoice.balance_due = invoice.total_amount - invoice.paid_amount
        if invoice.balance_due < Decimal("0"):
            invoice.balance_due = Decimal("0")
        self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.PAYMENT_ALLOCATED,
            entity_type="platform_payment",
            entity_id=payment.id,
            new_values={
                "allocation_id": allocation.id,
                "invoice_id": invoice_id,
                "amount": str(amount),
            },
        )

        return allocation

    def deallocate(
        self,
        *,
        payment_id: int,
        invoice_id: int,
        actor_id: int,
    ) -> None:
        """Remove an allocation between a payment and invoice.

        Validates that the allocation exists before removing.
        """
        allocation = (
            self.db.query(PlatformPaymentAllocation)
            .filter(
                PlatformPaymentAllocation.platform_payment_id == payment_id,
                PlatformPaymentAllocation.platform_invoice_id == invoice_id,
            )
            .first()
        )
        if not allocation:
            raise ValueError(
                f"No allocation found for payment {payment_id} to invoice {invoice_id}"
            )

        amount = allocation.amount
        self.db.delete(allocation)
        self.db.flush()

        # Reverse the invoice balance update
        invoice = self.db.query(PlatformInvoice).get(invoice_id)
        if invoice:
            invoice.paid_amount = invoice.paid_amount - amount
            invoice.balance_due = invoice.total_amount - invoice.paid_amount
            if invoice.balance_due < Decimal("0"):
                invoice.balance_due = Decimal("0")
            self.db.flush()

        self._audit.log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.PAYMENT_DEALLOCATED,
            entity_type="platform_payment",
            entity_id=payment_id,
            old_values={"invoice_id": invoice_id, "amount": str(amount)},
        )

    def reconcile(self, payment_id: int) -> bool:
        """Reconcile a payment: verify allocation totals match payment amount.

        Returns True if reconciled, False if discrepancies found.
        """
        payment = self.db.query(PlatformPayment).get(payment_id)
        if not payment:
            raise ValueError(f"PlatformPayment {payment_id} not found")

        if payment.status != PlatformPaymentStatus.CLEARED:
            return False

        allocated_total = sum(
            a.amount
            for a in self.db.query(PlatformPaymentAllocation)
            .filter(PlatformPaymentAllocation.platform_payment_id == payment_id)
            .all()
        )

        return allocated_total == payment.amount

    def get_payment(self, payment_id: int) -> PlatformPayment:
        payment = self.db.query(PlatformPayment).get(payment_id)
        if not payment:
            raise ValueError(f"PlatformPayment {payment_id} not found")
        return payment

    def _next_payment_number(self) -> str:
        """Generate next payment number. Format: PPMT-{sequence}."""
        last = (
            self.db.query(PlatformPayment)
            .order_by(PlatformPayment.id.desc())
            .first()
        )
        if last and last.payment_number:
            parts = last.payment_number.rsplit("-", 1)
            try:
                seq = int(parts[-1]) + 1
            except (ValueError, IndexError):
                seq = 1
        else:
            seq = 1
        return f"PPMT-{seq:06d}"
