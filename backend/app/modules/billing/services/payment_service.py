import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    Invoice,
    InvoiceStatus,
    InvoiceStatusHistory,
    Payment,
    PaymentAllocation,
    PaymentAttempt,
    PaymentMethod,
    PaymentStatus,
    PaymentType,
)
from app.modules.billing.utils.currency_utils import VALID_CURRENCY_CODES
from app.modules.billing.repositories.payment import (
    PaymentAllocationRepository,
    PaymentAttemptRepository,
    PaymentMethodRepository,
    PaymentRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import safe_commit, safe_commit_and_refresh, filter_allowed
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.services.email_service import send_payment_receipt_email

logger = logging.getLogger("zoiko_billing")

VALID_PAYMENT_STATUS_TRANSITIONS: Dict[PaymentStatus, set[PaymentStatus]] = {
    PaymentStatus.PENDING: {PaymentStatus.PROCESSING, PaymentStatus.CLEARED, PaymentStatus.FAILED, PaymentStatus.CANCELLED},
    PaymentStatus.PROCESSING: {PaymentStatus.CLEARED, PaymentStatus.FAILED, PaymentStatus.CANCELLED},
    PaymentStatus.CLEARED: {PaymentStatus.CANCELLED, PaymentStatus.REFUNDED},
    PaymentStatus.FAILED: {PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.CANCELLED},
    PaymentStatus.CANCELLED: set(),
}

# Invoice statuses that can never receive a new payment allocation.
# PAID is intentionally excluded here: a fully paid invoice already has
# remaining_invoice == 0, so the existing remaining-balance check below
# rejects it on amount grounds without needing a separate status rule.
NON_ALLOCATABLE_INVOICE_STATUSES: Dict[InvoiceStatus, str] = {
    InvoiceStatus.DRAFT: "draft",
    InvoiceStatus.CANCELLED: "cancelled",
    InvoiceStatus.REFUNDED: "refunded",
    InvoiceStatus.WRITTEN_OFF: "written-off",
}

# Invoice statuses reached through their own guarded workflow (cancel,
# refund, write-off) that must not be silently reopened. A PARTIALLY_PAID
# invoice can be written off or refunded while its original PaymentAllocation
# row is still on record (see InvoiceService.record_write_off /
# record_refund, which only touch balance_due/paid_amount, not existing
# allocations) — reversing that allocation afterward would recompute status
# from balance math alone and resurrect the closed invoice back to
# SENT/PARTIALLY_PAID/PAID. DRAFT is intentionally excluded: it is not a
# closed disposition reachable from this class of bug.
NON_REVERSIBLE_INVOICE_STATUSES: Dict[InvoiceStatus, str] = {
    InvoiceStatus.CANCELLED: "cancelled",
    InvoiceStatus.REFUNDED: "refunded",
    InvoiceStatus.WRITTEN_OFF: "written-off",
}

METHOD_ALLOWED_FIELDS = {
    "payment_type", "gateway", "gateway_customer_id", "gateway_payment_method_id",
    "last_four", "card_brand", "card_expiry_month", "card_expiry_year",
    "bank_name", "account_last_four", "is_default",
    "billing_address", "status", "verified_at", "is_active",
}
PAYMENT_ALLOWED_FIELDS = {
    "payment_number", "customer_id", "amount", "net_amount",
    "payment_date", "payment_method_id", "transaction_id",
    "payment_type", "status", "notes", "currency",
    "exchange_rate", "gateway", "gateway_charge_id", "gateway_fee",
    "failure_reason", "failure_code", "receipt_sent",
}


class PaymentService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = PaymentRepository(db)
        self.method_repo = PaymentMethodRepository(db)
        self.allocation_repo = PaymentAllocationRepository(db)
        self.attempt_repo = PaymentAttemptRepository(db)
        self.customer_service = CustomerService(db)
        self.invoice_service = InvoiceService(db)
        self.config_service = BillingConfigurationService(db)
        self.audit = BillingAuditService(db)

    # ── Payment Methods ────────────────────────────────────────────────────

    def add_payment_method(self, organization_id: int, customer_id: int, created_by: int, **data: Any) -> PaymentMethod:
        data = filter_allowed(data, METHOD_ALLOWED_FIELDS)
        self.customer_service.get_customer(customer_id, organization_id)
        method = self.method_repo.create(organization_id, customer_id=customer_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PaymentMethod", method.id)
        return method

    def update_payment_method(self, method_id: int, organization_id: int, updated_by: int, **data: Any) -> PaymentMethod:
        data = filter_allowed(data, METHOD_ALLOWED_FIELDS)
        self.method_repo.get_by_id(method_id, organization_id)
        updated = self.method_repo.update(method_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PaymentMethod", method_id)
        return updated

    def remove_payment_method(self, method_id: int, organization_id: int, updated_by: int) -> None:
        self.method_repo.soft_delete(method_id, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "PaymentMethod", method_id)

    def set_default_payment_method(self, organization_id: int, method_id: int, updated_by: int) -> PaymentMethod:
        method = self.method_repo.set_default(organization_id, method_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PaymentMethod", method_id)
        return method

    def list_payment_methods(
        self, organization_id: int, customer_id: int, active_only: bool = True,
    ) -> List[PaymentMethod]:
        self.customer_service.get_customer(customer_id, organization_id)
        return self.method_repo.list_by_customer(organization_id, customer_id, active_only)

    def get_default_payment_method(self, organization_id: int, customer_id: int) -> Optional[PaymentMethod]:
        return self.method_repo.get_default(organization_id, customer_id)

    # ── Payments ───────────────────────────────────────────────────────────

    def record_payment(
        self, organization_id: int, customer_id: int, payment_number: str,
        amount: Decimal, payment_date: date, created_by: int,
        idempotency_key: Optional[str] = None, **data: Any,
    ) -> Payment:
        data = filter_allowed(data, PAYMENT_ALLOWED_FIELDS)
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if self.repo.exists(organization_id, payment_number=payment_number):
            raise AlreadyExistsException("Payment", "payment_number")
        # Normalize empty transaction ids to NULL so the unique
        # (organization_id, transaction_id) constraint stays clean.
        idempotency_key = (idempotency_key or "").strip() or None
        if idempotency_key:
            existing = self.repo.get_first(organization_id, transaction_id=idempotency_key)
            if existing:
                return existing
        # Check for duplicate transaction_id when provided in data
        tx_id = data.get("transaction_id")
        if tx_id:
            tx_id = str(tx_id).strip() or None
            if tx_id:
                existing = self.repo.get_first(organization_id, transaction_id=tx_id)
                if existing:
                    raise AlreadyExistsException("Payment", "transaction_id")
        # Currency: explicit > customer's own currency > org default -- same
        # precedence already used for invoices/contracts/subscriptions.
        # Never silently falls through to the Payment.currency column's own
        # USD default when the client omits it.
        currency = data.get("currency") or customer.currency or self.config_service.get_default_currency(organization_id)
        if currency and currency.upper() not in VALID_CURRENCY_CODES:
            raise BadRequestException(f"Unsupported currency code: {currency}")
        data["currency"] = currency
        data.pop("transaction_id", None)
        # This method backs the manual "Record Payment" flow, where the funds have
        # already been collected — default to cleared so it can be allocated
        # immediately, unless a caller explicitly supplies a different status.
        if not data.get("payment_type"):
            data["payment_type"] = PaymentType.MANUAL
        if not data.get("status"):
            data["status"] = PaymentStatus.CLEARED
        cleared_at = datetime.utcnow() if data["status"] == PaymentStatus.CLEARED else None
        try:
            payment = self.repo.create(
                organization_id, customer_id=customer_id,
                payment_number=payment_number, amount=amount,
                payment_date=payment_date, net_amount=amount,
                transaction_id=idempotency_key, cleared_at=cleared_at,
                **data,
            )
        except IntegrityError:
            # Race-safe duplicate detection: the unique constraint on
            # (organization_id, transaction_id) is the source of truth, not the
            # pre-check above.
            self.db.rollback()
            existing = self.repo.get_first(organization_id, transaction_id=idempotency_key or tx_id)
            if existing:
                return existing
            raise AlreadyExistsException("Payment", "transaction_id")
        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                email_delivered = send_payment_receipt_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    payment_number=payment_number,
                    payment_date=str(payment_date),
                    amount=str(amount),
                    currency=data.get("currency") or self.config_service.get_default_currency(organization_id),
                    payment_method=data.get("payment_method_type", ""),
                    organization_id=organization_id,
                    db=self.db,
                )
        except Exception as e:
            logger.warning("Failed to send payment receipt email for payment %s: %s", payment_number, e)

        self.audit.log(
            organization_id, created_by, BillingAuditAction.PAY, "Payment", payment.id,
            new_values={**data, "email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return payment

    def update_payment_status(self, payment_id: int, organization_id: int, status: str, updated_by: int, **data: Any) -> Payment:
        data = filter_allowed(data, PAYMENT_ALLOWED_FIELDS)
        payment = (
            self.db.query(Payment)
            .filter(Payment.id == payment_id, Payment.organization_id == organization_id)
            .with_for_update()
            .first()
        )
        if payment is None:
            raise BadRequestException(f"Payment {payment_id} not found in organization {organization_id}")
        old_status = payment.status
        if status not in VALID_PAYMENT_STATUS_TRANSITIONS.get(old_status, set()):
            raise BadRequestException(
                f"Cannot transition payment status from {old_status.value} to {status}"
            )
        has_allocations = (
            self.db.query(PaymentAllocation.id)
            .filter(
                PaymentAllocation.payment_id == payment_id,
                PaymentAllocation.organization_id == organization_id,
            )
            .first()
        ) is not None
        if has_allocations and status != old_status.value:
            # Money has already been moved to invoices — mutating the payment
            # record after allocation would silently desync the ledger.
            raise BadRequestException(
                f"Cannot change status of payment {payment.payment_number} after it has been allocated"
            )
        if status == PaymentStatus.CLEARED:
            payment.cleared_at = datetime.utcnow()
        payment.status = status
        for k, v in data.items():
            if hasattr(payment, k) and v is not None:
                setattr(payment, k, v)
        safe_commit_and_refresh(self.db, payment)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE, "Payment", payment_id,
            old_values={"status": old_status.value},
            new_values={"status": status},
        )
        return payment

    def get_payment(self, payment_id: int, organization_id: int) -> Payment:
        return self.repo.get_by_id(payment_id, organization_id)

    def get_by_transaction_id(self, organization_id: int, transaction_id: str) -> Optional[Payment]:
        return self.repo.get_by_transaction_id(organization_id, transaction_id)

    def list_payments(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, payment_type: Optional[str] = None,
        sort_by: str = "payment_date", sort_order: str = "desc",
        date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, payment_type=payment_type,
            date_from=date_from, date_to=date_to,
        )

    def get_total_collected(
        self, organization_id: int, date_from: Optional[str] = None, date_to: Optional[str] = None,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> float:
        return self.repo.get_total_collected(organization_id, date_from, date_to, currency_rates=currency_rates)

    # ── Payment Allocation ─────────────────────────────────────────────────

    def allocate_payment(
        self, payment_id: int, organization_id: int, invoice_id: int,
        amount: Decimal, created_by: int,
    ) -> PaymentAllocation:
        """Allocate a cleared payment to an invoice.

        Runs in a single transaction with row locks (SELECT FOR UPDATE on both
        the payment and the invoice) so concurrent allocations can never
        over-allocate a payment or an invoice, and the payment, allocation,
        invoice amounts, status history and audit trail are committed together
        or not at all. On Postgres this is the race-free path; the old flow
        committed the allocation before touching the invoice (orphan window).
        """
        if amount is None:
            raise BadRequestException("Allocation amount is required")
        try:
            amount = Decimal(str(amount))
        except Exception:
            raise BadRequestException("Allocation amount must be a valid number")
        if amount <= 0:
            raise BadRequestException("Allocation amount must be greater than zero")

        payment = (
            self.db.query(Payment)
            .filter(Payment.id == payment_id, Payment.organization_id == organization_id)
            .with_for_update()
            .first()
        )
        if payment is None:
            raise BadRequestException(f"Payment {payment_id} not found in organization {organization_id}")

        invoice = (
            self.db.query(Invoice)
            .filter(Invoice.id == invoice_id, Invoice.organization_id == organization_id)
            .with_for_update()
            .first()
        )
        if invoice is None:
            raise BadRequestException(f"Invoice {invoice_id} not found in organization {organization_id}")
        if invoice.status in NON_ALLOCATABLE_INVOICE_STATUSES:
            raise BadRequestException(
                f"Payment cannot be allocated to a {NON_ALLOCATABLE_INVOICE_STATUSES[invoice.status]} invoice."
            )

        if payment.status != PaymentStatus.CLEARED:
            raise BadRequestException("Payment must be cleared before allocation")
        if payment.customer_id != invoice.customer_id:
            raise BadRequestException(
                "Payment customer does not match invoice customer"
            )
        if payment.currency != invoice.currency:
            raise BadRequestException(
                f"Payment currency ({payment.currency}) does not match "
                f"invoice currency ({invoice.currency})"
            )
        # Amount checks are recomputed from the locked rows, so two racing
        # allocations cannot both pass based on stale unallocated balances.
        existing_allocations = (
            self.db.query(PaymentAllocation)
            .filter(
                PaymentAllocation.payment_id == payment_id,
                PaymentAllocation.organization_id == organization_id,
            )
            .all()
        )
        total_allocated_to_payment = sum(Decimal(str(a.amount)) for a in existing_allocations)
        remaining_payment = Decimal(str(payment.amount)) - total_allocated_to_payment
        if amount > remaining_payment:
            raise BadRequestException(
                f"Allocation amount {amount} exceeds remaining payment balance {remaining_payment}"
            )

        # invoice.balance_due (not a fresh sum of PaymentAllocation rows) is
        # the correct source of truth for the collectible remainder: it is
        # already reduced by any applied credit notes and write-offs, which
        # never create PaymentAllocation rows. Summing only PaymentAllocation
        # rows against total_amount would ignore those reductions and permit
        # cash allocations beyond what is actually still owed. invoice was
        # fetched with_for_update() above, so this read is already race-safe.
        remaining_invoice = Decimal(str(invoice.balance_due if invoice.balance_due is not None else invoice.total_amount))
        if amount > remaining_invoice:
            raise BadRequestException(
                f"Allocation amount {amount} exceeds remaining invoice balance {remaining_invoice}"
            )

        allocation = PaymentAllocation(
            organization_id=organization_id,
            payment_id=payment_id,
            invoice_id=invoice_id,
            amount=amount,
            created_by=created_by,
        )
        self.db.add(allocation)
        try:
            self.db.flush()
        except IntegrityError:
            # Unique (payment_id, invoice_id) — a second allocation for the
            # same payment+invoice pair is not allowed.
            self.db.rollback()
            raise AlreadyExistsException("PaymentAllocation", "payment_id/invoice_id")

        self._apply_payment_to_invoice(
            invoice, payment, amount, organization_id, created_by,
        )
        try:
            safe_commit(self.db)
        except Exception:
            # Commit failed (e.g. concurrent unique violation) — nothing was
            # persisted; the whole allocation is rolled back atomically.
            raise
        self.db.refresh(allocation)
        self.audit.log(
            organization_id, created_by, BillingAuditAction.UPDATE, "PaymentAllocation", allocation.id,
            new_values={"amount": str(amount), "payment_id": payment_id, "invoice_id": invoice_id},
        )
        self._sync_customer_balance(invoice.customer_id, organization_id)
        return allocation

    def _apply_payment_to_invoice(
        self, invoice, payment, amount: Decimal, organization_id: int, changed_by: int,
    ) -> None:
        """Update invoice paid amounts/status within the caller's transaction.

        balance_due is decremented incrementally from its current
        (already-correct) value rather than recomputed as
        total_amount - paid_amount, which would silently discard any
        write-off reduction already applied to balance_due independently of
        paid_amount (see InvoiceService.record_write_off)."""
        old_status = invoice.status
        invoice.paid_amount = Decimal(str(invoice.paid_amount or 0)) + amount
        invoice.balance_due = Decimal(str(invoice.balance_due or 0)) - amount
        if invoice.balance_due <= 0:
            invoice.balance_due = Decimal("0")
            invoice.status = InvoiceStatus.PAID
            invoice.paid_at = datetime.utcnow()
        else:
            invoice.status = InvoiceStatus.PARTIALLY_PAID
        if old_status != invoice.status:
            history = InvoiceStatusHistory(
                organization_id=organization_id,
                invoice_id=invoice.id,
                from_status=old_status,
                to_status=invoice.status,
                changed_by=changed_by,
                reason=f"Payment {payment.payment_number} allocated {amount}",
            )
            self.db.add(history)

    def allocate_to_multiple(
        self, payment_id: int, organization_id: int,
        allocations: List[Dict[str, Any]], created_by: int,
    ) -> List[PaymentAllocation]:
        results = []
        for alloc in allocations:
            result = self.allocate_payment(
                payment_id, organization_id,
                alloc["invoice_id"], Decimal(str(alloc["amount"])), created_by,
            )
            results.append(result)
        return results

    def list_allocations_by_payment(self, payment_id: int, organization_id: int) -> List[PaymentAllocation]:
        self.repo.get_by_id(payment_id, organization_id)
        return self.allocation_repo.list_by_payment(organization_id, payment_id)

    def list_allocations_by_invoice(self, invoice_id: int, organization_id: int) -> List[PaymentAllocation]:
        self.invoice_service.get_invoice(invoice_id, organization_id)
        return self.allocation_repo.list_by_invoice(organization_id, invoice_id)

    def get_total_allocated(self, invoice_id: int, organization_id: int) -> float:
        self.invoice_service.get_invoice(invoice_id, organization_id)
        return self.allocation_repo.get_total_allocated_to_invoice(organization_id, invoice_id)

    def get_unallocated_amount(self, payment_id: int, organization_id: int) -> Decimal:
        payment = self.repo.get_by_id(payment_id, organization_id)
        total_allocated = sum(
            Decimal(str(a.amount)) for a in self.allocation_repo.list_by_payment(organization_id, payment_id)
        )
        return payment.amount - total_allocated

    def deallocate_payment(
        self, allocation_id: int, organization_id: int, updated_by: int,
    ) -> Dict[str, Any]:
        allocation = (
            self.db.query(PaymentAllocation)
            .filter(
                PaymentAllocation.id == allocation_id,
                PaymentAllocation.organization_id == organization_id,
            )
            .first()
        )
        if allocation is None:
            raise BadRequestException(f"Allocation {allocation_id} not found in organization {organization_id}")
        payment_id = allocation.payment_id
        invoice_id = allocation.invoice_id
        amount = Decimal(str(allocation.amount))
        payment = (
            self.db.query(Payment)
            .filter(Payment.id == payment_id, Payment.organization_id == organization_id)
            .with_for_update()
            .first()
        )
        invoice = (
            self.db.query(Invoice)
            .filter(Invoice.id == invoice_id, Invoice.organization_id == organization_id)
            .with_for_update()
            .first()
        )
        if payment is None or invoice is None:
            raise BadRequestException("Payment or invoice for allocation no longer exists")
        if invoice.status in NON_REVERSIBLE_INVOICE_STATUSES:
            raise BadRequestException(
                f"Cannot reverse a payment allocation on a {NON_REVERSIBLE_INVOICE_STATUSES[invoice.status]} invoice."
            )
        if payment.status != PaymentStatus.CLEARED:
            raise BadRequestException("Cannot reverse allocation on a non-cleared payment")
        old_status = invoice.status
        # balance_due is reopened incrementally, not recomputed as
        # total_amount - paid_amount, which would silently discard any
        # write-off reduction already applied to balance_due independently
        # of paid_amount. "Back to SENT" is likewise detected from
        # paid_amount returning to zero, not from balance_due reaching
        # total_amount, since a write-off can leave balance_due below
        # total_amount even with no cash payment applied at all.
        invoice.paid_amount = Decimal(str(invoice.paid_amount or 0)) - amount
        invoice.balance_due = Decimal(str(invoice.balance_due or 0)) + amount
        if invoice.paid_amount <= 0:
            invoice.paid_amount = Decimal("0")
            invoice.status = InvoiceStatus.SENT
        elif invoice.balance_due > 0:
            invoice.status = InvoiceStatus.PARTIALLY_PAID
        else:
            invoice.status = InvoiceStatus.PAID
        if old_status != invoice.status:
            history = InvoiceStatusHistory(
                organization_id=organization_id,
                invoice_id=invoice_id,
                from_status=old_status,
                to_status=invoice.status,
                changed_by=updated_by,
                reason=f"Deallocated payment {payment.payment_number}",
            )
            self.db.add(history)
        self.db.delete(allocation)
        try:
            safe_commit(self.db)
        except Exception:
            raise
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE, "PaymentAllocation", allocation_id,
            old_values={"amount": str(amount), "payment_id": payment_id, "invoice_id": invoice_id},
            new_values={"status": "deleted"},
        )
        self._sync_customer_balance(invoice.customer_id, organization_id)
        return {"id": allocation_id, "payment_id": payment_id, "invoice_id": invoice_id, "amount": amount}

    def _sync_customer_balance(self, customer_id: int, organization_id: int) -> None:
        self.customer_service.sync_outstanding_balance(customer_id, organization_id)

    # ── Payment Attempts ───────────────────────────────────────────────────

    def record_attempt(self, payment_id: int, organization_id: int, attempt_number: int, status: str, **data: Any) -> PaymentAttempt:
        self.repo.get_by_id(payment_id, organization_id)
        attempt = self.attempt_repo.create(organization_id, payment_id=payment_id, attempt_number=attempt_number, status=status, **data)
        return attempt

    def list_attempts(self, payment_id: int, organization_id: int) -> List[PaymentAttempt]:
        self.repo.get_by_id(payment_id, organization_id)
        return self.attempt_repo.list_by_payment(organization_id, payment_id)

    def get_latest_attempt(self, payment_id: int, organization_id: int) -> Optional[PaymentAttempt]:
        self.repo.get_by_id(payment_id, organization_id)
        return self.attempt_repo.get_latest_attempt(organization_id, payment_id)

    def count_failed_attempts(self, payment_id: int, organization_id: int) -> int:
        self.repo.get_by_id(payment_id, organization_id)
        return self.attempt_repo.count_failed_attempts(organization_id, payment_id)

    # ── Reconciliation ─────────────────────────────────────────────────────

    def reconcile_payment(self, payment_id: int, organization_id: int, updated_by: int) -> Payment:
        payment = self.repo.get_by_id(payment_id, organization_id)
        if payment.status != PaymentStatus.CLEARED:
            raise BadRequestException("Only cleared payments can be reconciled")
        allocations = self.allocation_repo.list_by_payment(organization_id, payment_id)
        total_allocated = sum(Decimal(str(a.amount)) for a in allocations)
        if total_allocated > payment.amount:
            raise BadRequestException("Allocated amount exceeds payment amount")
        if total_allocated < payment.amount:
            logger.info(f"[BILLING] Payment {payment_id} under-allocated: {total_allocated} of {payment.amount}")
        return payment

    # ── Unallocated Payments ──────────────────────────────────────────────

    def list_unallocated_payments(
        self, organization_id: int, page: int = 1, per_page: int = 20,
    ) -> Dict[str, Any]:
        return self.repo.list_unallocated(organization_id, page=page, per_page=per_page)
