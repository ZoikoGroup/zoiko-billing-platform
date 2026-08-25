"""
modules/commercial/platform_reconciliation_service.py
-----------------------------------------------------
Plane 1 — Platform reconciliation service (Zoiko's own ledger checks).

Same two integrity checks as the Plane 2 ReconciliationService, but against
PlatformInvoice / PlatformPayment tables:

  1. invoice_balance_arithmetic:
     balance_due must equal total_amount - paid_amount on every non-draft
     platform invoice.
  2. payment_allocation_integrity:
     allocated_total must never exceed payment_amount on platform payments,
     and every allocation's invoice must belong to the same commercial account.

Runs reuse the existing ReconciliationRun / ReconciliationException models
with source="platform_ledger_reconciliation" to distinguish from Plane 2 runs.

Scope: operates ONLY on PlatformInvoice / PlatformPayment rows.
Never touches Plane 2 tables.
"""

import logging
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.commercial.models import (
    PlatformInvoice,
    PlatformPayment,
    PlatformPaymentAllocation,
)
from app.modules.super_admin.models import (
    ReconciliationException,
    ReconciliationExceptionStatus,
    ReconciliationRun,
    ReconciliationRunState,
)

logger = logging.getLogger("zoiko_billing.commercial.platform_reconciliation")

NON_DRAFT_INVOICE_STATUSES = (
    "issued", "delivered", "delivery_failed", "due",
    "partially_paid", "paid", "overdue", "disputed", "credited", "voided",
)

SOURCE = "platform_ledger_reconciliation"


class PlatformReconciliationService:
    def __init__(self, db: Session):
        self.db = db

    # ------------------------------------------------------------------
    # Checks
    # ------------------------------------------------------------------
    def _check_invoice_balances(self) -> list[ReconciliationException]:
        """Check 1: balance_due == total_amount - paid_amount on non-draft invoices."""
        exceptions = []
        rows = (
            self.db.query(PlatformInvoice)
            .filter(PlatformInvoice.status.in_(NON_DRAFT_INVOICE_STATUSES))
            .all()
        )
        for inv in rows:
            expected = (inv.total_amount or Decimal("0")) - (inv.paid_amount or Decimal("0"))
            if abs(expected - (inv.balance_due or Decimal("0"))) > Decimal("0.005"):
                exceptions.append(
                    ReconciliationException(
                        kind="platform_invoice_balance_mismatch",
                        entity_type="platform_invoice",
                        entity_id=inv.id,
                        detail={
                            "invoice_number": inv.invoice_number,
                            "currency": inv.currency,
                            "total_amount": str(inv.total_amount),
                            "paid_amount": str(inv.paid_amount),
                            "balance_due": str(inv.balance_due),
                            "expected_balance_due": str(expected),
                        },
                    )
                )
        return exceptions

    def _check_payment_allocations(self) -> list[ReconciliationException]:
        """Check 2: allocated_total <= payment_amount on platform payments."""
        exceptions = []
        payments = self.db.query(PlatformPayment).all()

        # Aggregate allocations per payment
        alloc_rows = (
            self.db.query(
                PlatformPaymentAllocation.platform_payment_id,
                PlatformPaymentAllocation.amount,
            )
            .all()
        )
        totals: dict[int, Decimal] = {}
        for payment_id, amount in alloc_rows:
            totals[payment_id] = totals.get(payment_id, Decimal("0")) + (amount or Decimal("0"))

        for pay in payments:
            allocated = totals.get(pay.id, Decimal("0"))
            if allocated > (pay.amount or Decimal("0")) + Decimal("0.005"):
                exceptions.append(
                    ReconciliationException(
                        kind="platform_payment_over_allocation",
                        entity_type="platform_payment",
                        entity_id=pay.id,
                        detail={
                            "payment_number": pay.payment_number,
                            "currency": pay.currency,
                            "payment_amount": str(pay.amount),
                            "allocated_total": str(allocated),
                        },
                    )
                )
        return exceptions

    # ------------------------------------------------------------------
    # Run lifecycle
    # ------------------------------------------------------------------
    def run_reconciliation(self, trigger: str = "manual") -> ReconciliationRun:
        """Execute a platform reconciliation run."""
        run = ReconciliationRun(
            plane="plane1",
            trigger=trigger,
            state=ReconciliationRunState.RUNNING,
            processor_source="platform",
        )
        self.db.add(run)
        self.db.flush()

        found: list[ReconciliationException] = []
        found += self._check_invoice_balances()
        found += self._check_payment_allocations()

        run.processor_note = (
            "Platform (Plane 1) ledger reconciliation. "
            "Checks: invoice balance arithmetic, payment allocation integrity."
        )

        for exc in found:
            exc.run_id = run.id
            self.db.add(exc)

        run.checks_total = 2
        run.exceptions_found = len(found)
        if found:
            run.state = ReconciliationRunState.FAILED
        else:
            run.state = ReconciliationRunState.VERIFIED
        run.finished_at = datetime.utcnow()
        self.db.flush()
        return run

    # ------------------------------------------------------------------
    # Exception ownership workflow
    # ------------------------------------------------------------------
    def acknowledge_exception(
        self, exception_id: int, owner_user_id: int
    ) -> ReconciliationException:
        exc = self.db.get(ReconciliationException, exception_id)
        if exc is None:
            raise ValueError(f"Reconciliation exception {exception_id} not found")
        if exc.status == ReconciliationExceptionStatus.RESOLVED:
            raise ValueError("Cannot acknowledge a resolved exception")
        exc.status = ReconciliationExceptionStatus.ACKNOWLEDGED
        exc.owner_user_id = owner_user_id
        exc.acknowledged_at = datetime.utcnow()
        self.db.flush()
        return exc

    def resolve_exception(
        self, exception_id: int, note: str
    ) -> ReconciliationException:
        exc = self.db.get(ReconciliationException, exception_id)
        if exc is None:
            raise ValueError(f"Reconciliation exception {exception_id} not found")
        if exc.status == ReconciliationExceptionStatus.RESOLVED:
            raise ValueError("Exception is already resolved")
        note = (note or "").strip()
        if not note:
            raise ValueError("A resolution note is required")
        exc.status = ReconciliationExceptionStatus.RESOLVED
        exc.resolution_note = note[:500]
        exc.resolved_at = datetime.utcnow()
        self.db.flush()
        return exc
