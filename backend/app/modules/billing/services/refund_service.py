import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    ForbiddenException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    CommunicationEventStatus,
    CommunicationEventType,
    CreditNoteStatus,
    InvoiceStatus,
    Refund,
    RefundCommunication,
    RefundSource,
    RefundStatus,
    RefundStatusHistory,
)
from app.modules.billing.repositories.credit import (
    CreditNoteRepository,
    RefundCommunicationRepository,
    RefundRepository,
    RefundStatusHistoryRepository,
)
from app.modules.billing.repositories.invoice import InvoiceRepository
from app.modules.billing.repositories.payment import PaymentRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import (
    filter_allowed, render_document_number, safe_commit_and_refresh, sequence_window_start,
)
from app.modules.billing.models import Refund as RefundModel
from app.modules.billing.models import NumberFormat, SequenceReset
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.payment_service import PaymentService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.billing.utils.currency_utils import round_money
from app.services.email_service import send_refund_email

logger = logging.getLogger("zoiko_billing")

REFUND_ALLOWED_FIELDS = {
    "customer_id", "refund_number", "refund_type", "amount",
    "payment_id", "invoice_id", "credit_note_id",
    "refund_source", "refund_method", "reason", "notes",
    "gateway", "gateway_refund_id", "reference_number",
    "currency", "exchange_rate", "idempotency_key",
}


class RefundService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = RefundRepository(db)
        self.history_repo = RefundStatusHistoryRepository(db)
        self.comms_repo = RefundCommunicationRepository(db)
        self.payment_repo = PaymentRepository(db)
        self.invoice_repo = InvoiceRepository(db)
        self.credit_note_repo = CreditNoteRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)
        self.invoice_service = InvoiceService(db)
        self.payment_service = PaymentService(db)

    # ── Status Machine ──────────────────────────────────────────────────────
    # Draft -> Pending Approval -> Approved -> Processing -> Completed
    #                                                      -> Failed
    # Draft/Pending Approval/Approved -> Cancelled; Pending Approval -> Rejected
    # RefundStatus.PENDING is a legacy pre-RC2-Phase-2 value kept only so
    # rows created before this migration can still be progressed/cancelled.

    def _validate_status_transition(self, current: RefundStatus, target: RefundStatus) -> None:
        valid = {
            RefundStatus.DRAFT: [RefundStatus.PENDING_APPROVAL, RefundStatus.CANCELLED],
            RefundStatus.PENDING: [RefundStatus.PROCESSING, RefundStatus.CANCELLED],
            RefundStatus.PENDING_APPROVAL: [RefundStatus.APPROVED, RefundStatus.REJECTED, RefundStatus.CANCELLED],
            RefundStatus.APPROVED: [RefundStatus.PROCESSING, RefundStatus.CANCELLED],
            RefundStatus.PROCESSING: [RefundStatus.COMPLETED, RefundStatus.FAILED],
            RefundStatus.COMPLETED: [],
            RefundStatus.FAILED: [RefundStatus.PROCESSING, RefundStatus.CANCELLED],
            RefundStatus.REJECTED: [],
            RefundStatus.CANCELLED: [],
        }
        if target not in valid.get(current, []):
            raise BadRequestException(f"Cannot transition refund from {current.value} to {target.value}")

    def _record_status_history(
        self, organization_id: int, refund_id: int, from_status: Optional[str], to_status: str,
        changed_by: Optional[int] = None, reason: Optional[str] = None,
    ) -> RefundStatusHistory:
        return self.history_repo.log_status_change(organization_id, refund_id, from_status, to_status, changed_by, reason)

    def _generate_refund_number(self, organization_id: int) -> str:
        from app.modules.billing.services.settings_service import BillingConfigurationService
        from app.modules.billing.services.document_sequence import DocumentSequenceService
        config_svc = BillingConfigurationService(self.db)
        config = config_svc.get_configuration(organization_id)
        prefix = config.refund_prefix or "RF-"
        fmt = config.refund_number_format or NumberFormat.PREFIX_YYYY_SEQ
        reset = getattr(config, "refund_sequence_reset", None) or getattr(config, "invoice_sequence_reset", SequenceReset.ANNUALLY)

        return DocumentSequenceService(self.db).next_number(
            organization_id, "refund", prefix, fmt, reset,
        )

    @staticmethod
    def _infer_source(payment_id: Optional[int], invoice_id: Optional[int], credit_note_id: Optional[int]) -> RefundSource:
        if payment_id:
            return RefundSource.PAYMENT
        if credit_note_id:
            return RefundSource.CREDIT_NOTE
        if invoice_id:
            return RefundSource.INVOICE
        return RefundSource.CUSTOMER_CREDIT_BALANCE

    @staticmethod
    def _validate_source_reference(
        source: RefundSource, payment_id: Optional[int], invoice_id: Optional[int], credit_note_id: Optional[int],
    ) -> None:
        if source == RefundSource.PAYMENT and not payment_id:
            raise BadRequestException("payment_id is required when refund_source is 'payment'")
        if source == RefundSource.INVOICE and not invoice_id:
            raise BadRequestException("invoice_id is required when refund_source is 'invoice'")
        if source == RefundSource.CREDIT_NOTE and not credit_note_id:
            raise BadRequestException("credit_note_id is required when refund_source is 'credit_note'")

    # ── Create ───────────────────────────────────────────────────────────────

    def create_refund(
        self, organization_id: int, created_by: int,
        customer_id: int, refund_number: str,
        refund_type: str, amount: Decimal, **data: Any,
    ) -> Refund:
        from app.modules.billing.services.settings_service import BillingConfigurationService

        data = filter_allowed(data, REFUND_ALLOWED_FIELDS)

        if amount <= 0:
            raise BadRequestException("Refund amount must be greater than zero")

        # Idempotent replay: a retried "create refund" request (e.g. a
        # network timeout on the original call) with the same caller-
        # supplied key returns the existing refund instead of creating a
        # second one — checked before any locking/validation work below.
        idempotency_key = (data.get("idempotency_key") or "").strip() or None
        data["idempotency_key"] = idempotency_key
        if idempotency_key:
            existing = self.repo.get_first(organization_id, idempotency_key=idempotency_key)
            if existing:
                return existing

        customer = self.customer_service.get_customer(customer_id, organization_id)

        if not refund_number or refund_number.strip().lower() in ("auto", "auto-generated", ""):
            refund_number = self._generate_refund_number(organization_id)
        if self.repo.exists(organization_id, refund_number=refund_number):
            raise AlreadyExistsException("Refund", "refund_number")

        payment_id = data.get("payment_id")
        invoice_id = data.get("invoice_id")
        credit_note_id = data.get("credit_note_id")

        raw_source = data.get("refund_source")
        source = RefundSource(raw_source) if raw_source else self._infer_source(payment_id, invoice_id, credit_note_id)
        self._validate_source_reference(source, payment_id, invoice_id, credit_note_id)
        data["refund_source"] = source.value

        # ── Row-locked source lookups (prevents concurrent over-refund) ──
        payment = invoice = credit_note = None
        if payment_id:
            payment = self.payment_repo.get_by_id_for_update(payment_id, organization_id)
            if payment.customer_id != customer_id:
                raise BadRequestException("Payment does not belong to this customer")
        if invoice_id:
            invoice = self.invoice_repo.get_by_id_for_update(invoice_id, organization_id)
            if invoice.customer_id != customer_id:
                raise BadRequestException("Invoice does not belong to this customer")
            if invoice.status == InvoiceStatus.CANCELLED:
                raise BadRequestException("Cannot refund a cancelled invoice")
        if credit_note_id:
            credit_note = self.credit_note_repo.get_by_id_for_update(credit_note_id, organization_id)
            if credit_note.customer_id != customer_id:
                raise BadRequestException("Credit note does not belong to this customer")

        # ── Resolve currency ──────────────────────────────────────────────
        if not data.get("currency"):
            if payment and payment.currency:
                data["currency"] = payment.currency
            elif invoice and invoice.currency:
                data["currency"] = invoice.currency
            elif credit_note and credit_note.currency:
                data["currency"] = credit_note.currency
            else:
                config_svc = BillingConfigurationService(self.db)
                data["currency"] = config_svc.get_default_currency(organization_id)

        # ── Currency must match the source entity's currency ──────────────
        for label, entity in (("payment", payment), ("invoice", invoice), ("credit note", credit_note)):
            if entity is not None and getattr(entity, "currency", None) and data["currency"] != entity.currency:
                raise BadRequestException(
                    f"Refund currency ({data['currency']}) must match the {label}'s currency "
                    f"({entity.currency}). Cross-currency refunds are not yet supported."
                )

        # ── Resolve exchange rate if not provided ─────────────────────────
        if not data.get("exchange_rate") and data.get("currency"):
            from app.modules.billing.services.exchange_rate_service import ExchangeRateService
            config_svc = BillingConfigurationService(self.db)
            org_config = config_svc.get_configuration(organization_id)
            if not org_config.base_currency:
                raise ValueError("Base currency is not configured for the organization.")
            base_currency = (
                org_config.base_currency.value if hasattr(org_config.base_currency, "value")
                else str(org_config.base_currency)
            )
            if data["currency"] != base_currency:
                rate_svc = ExchangeRateService(self.db)
                rate, _, _ = rate_svc.get_rate(organization_id, data["currency"], base_currency)
                data["exchange_rate"] = rate

        # ── Refundable-amount guard, per source — never exceed what's left.
        # Uses the *reserved* total (every non-terminal-negative refund —
        # draft, pending approval, approved, processing, or completed), not
        # just money that has already moved: otherwise two draft refunds
        # against the same payment could each individually pass validation
        # and later both be approved/completed, jointly exceeding the
        # refundable amount. ──
        if source == RefundSource.PAYMENT:
            reserved = self.repo.get_total_reserved_for_payment(organization_id, payment.id)
            remaining = Decimal(str(payment.amount)) - reserved
            if amount > remaining:
                raise BadRequestException(
                    f"Refund amount {amount} exceeds remaining refundable amount {remaining} "
                    f"(payment: {payment.amount}, already committed: {reserved})"
                )
        elif source == RefundSource.INVOICE:
            reserved = self.repo.get_total_reserved_for_invoice(organization_id, invoice.id)
            remaining = Decimal(str(invoice.paid_amount or 0)) - reserved
            if amount > remaining:
                raise BadRequestException(
                    f"Refund amount {amount} exceeds the invoice's refundable paid amount {remaining} "
                    f"(paid: {invoice.paid_amount}, already committed: {reserved})"
                )
        elif source == RefundSource.CREDIT_NOTE:
            if credit_note.status not in (CreditNoteStatus.ISSUED, CreditNoteStatus.PARTIALLY_APPLIED):
                raise BadRequestException("Credit note must be issued (and not fully applied/voided) to be refunded")
            reserved = self.repo.get_total_reserved_for_credit_note(organization_id, credit_note.id)
            remaining = Decimal(str(credit_note.remaining_amount)) - reserved
            if amount > remaining:
                raise BadRequestException(f"Refund amount {amount} exceeds the credit note's remaining balance {remaining}")
        else:  # CUSTOMER_CREDIT_BALANCE
            available = Decimal(str(customer.credit_balance or 0))
            if amount > available:
                raise BadRequestException(
                    f"Refund amount {amount} exceeds the customer's available credit balance {available}"
                )

        refund = self.repo.create(
            organization_id, customer_id=customer_id,
            refund_number=refund_number, refund_type=refund_type,
            amount=amount, status=RefundStatus.DRAFT, created_by=created_by, **data,
        )
        self._record_status_history(organization_id, refund.id, None, RefundStatus.DRAFT.value, created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Refund", refund.id, new_values=data)
        return refund

    def update_refund(self, refund_id: int, organization_id: int, updated_by: int, **data: Any) -> Refund:
        data = filter_allowed(data, REFUND_ALLOWED_FIELDS)
        refund = self.repo.get_by_id(refund_id, organization_id)
        if refund.status != RefundStatus.DRAFT:
            raise BadRequestException("Only draft refunds can be edited")
        updated = self.repo.update(refund_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Refund", refund_id)
        return updated

    def get_refund(self, refund_id: int, organization_id: int) -> Refund:
        return self.repo.get_by_id(refund_id, organization_id)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Refund]:
        return self.repo.get_by_number(organization_id, number)

    def list_refunds(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, refund_type: Optional[str] = None,
        refund_source: Optional[str] = None, refund_method: Optional[str] = None,
        sort_by: str = "created_at", sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, refund_type=refund_type,
            refund_source=refund_source, refund_method=refund_method,
        )

    # ── Approval Workflow ────────────────────────────────────────────────────

    def submit_for_approval(self, refund_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        self._validate_status_transition(refund.status, RefundStatus.PENDING_APPROVAL)
        old_status = refund.status.value
        refund.status = RefundStatus.PENDING_APPROVAL
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.PENDING_APPROVAL.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Refund", refund_id)
        return refund

    def approve_refund(self, refund_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        # §25 SoD: the user who requested/submitted a refund cannot approve
        # it, even if they hold a role that could approve someone else's.
        if refund.created_by == updated_by:
            raise ForbiddenException(
                "You cannot approve a refund you submitted yourself. "
                "Ask another Finance Approver to review it."
            )
        self._validate_status_transition(refund.status, RefundStatus.APPROVED)
        old_status = refund.status.value
        refund.status = RefundStatus.APPROVED
        refund.approved_at = datetime.utcnow()
        refund.approved_by = updated_by
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.APPROVED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.APPROVE, "Refund", refund_id)
        return refund

    def reject_refund(self, refund_id: int, organization_id: int, updated_by: int, reason: str) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        self._validate_status_transition(refund.status, RefundStatus.REJECTED)
        old_status = refund.status.value
        refund.status = RefundStatus.REJECTED
        refund.cancellation_reason = reason
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.REJECTED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.REJECT, "Refund", refund_id)
        return refund

    def cancel_refund(self, refund_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        self._validate_status_transition(refund.status, RefundStatus.CANCELLED)
        old_status = refund.status.value
        refund.status = RefundStatus.CANCELLED
        refund.cancelled_at = datetime.utcnow()
        refund.cancelled_by = updated_by
        refund.cancellation_reason = reason
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.CANCELLED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.CANCEL, "Refund", refund_id)
        return refund

    # ── Processing ───────────────────────────────────────────────────────────

    def process_refund(
        self, refund_id: int, organization_id: int, updated_by: int,
        gateway_refund_id: Optional[str] = None, reference_number: Optional[str] = None,
    ) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        self._validate_status_transition(refund.status, RefundStatus.PROCESSING)
        old_status = refund.status.value
        refund.status = RefundStatus.PROCESSING
        refund.processing_started_at = datetime.utcnow()
        refund.processed_by = updated_by
        if gateway_refund_id:
            refund.gateway_refund_id = gateway_refund_id
        if reference_number:
            refund.reference_number = reference_number
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.PROCESSING.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Refund", refund_id)
        return refund

    def complete_refund(self, refund_id: int, organization_id: int, updated_by: int) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        self._validate_status_transition(refund.status, RefundStatus.COMPLETED)

        # Pre-validate the one source whose "remaining balance" is a mutable,
        # persisted field (credit_note.remaining_amount) — payment/invoice
        # refundable amounts are derived from immutable, already-validated
        # figures, so re-checking here would be redundant.
        credit_note = None
        if refund.refund_source == RefundSource.CREDIT_NOTE and refund.credit_note_id:
            credit_note = self.credit_note_repo.get_by_id_for_update(refund.credit_note_id, organization_id)
            if Decimal(str(refund.amount)) > Decimal(str(credit_note.remaining_amount)):
                raise BadRequestException("Refund amount exceeds the credit note's remaining balance")

        old_status = refund.status.value
        refund.status = RefundStatus.COMPLETED
        refund.completed_at = datetime.utcnow()
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.COMPLETED.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.REFUND, "Refund", refund_id)

        # ── Source-specific balance sync. A completed refund has already
        # moved money and must not be rolled back by a downstream sync
        # failure — failures are logged loudly instead for manual
        # reconciliation, mirroring the credit-note/email best-effort style. ──
        try:
            source = refund.refund_source
            if source == RefundSource.PAYMENT and refund.payment_id:
                # Phase 1 audit BROKEN bug fix: update_payment_status blocks
                # any status change once a payment has PaymentAllocation rows,
                # which is always the case for a normal completed refund flow.
                # reverse_allocations_for_refund is the authorized path: it
                # removes the allocations, restores invoice balances, and sets
                # payment.status = REFUNDED when total refunded >= payment.amount.
                payment = self.payment_service.reverse_allocations_for_refund(
                    organization_id=organization_id,
                    payment_id=refund.payment_id,
                    amount=Decimal(str(refund.amount)),
                    updated_by=updated_by,
                )
                logger.info("[BILLING] Payment %d allocation reversed for refund %d (payment.status=%s)", payment.id, refund_id, payment.status)
            elif source == RefundSource.INVOICE and refund.invoice_id:
                self.invoice_service.record_refund(refund.invoice_id, organization_id, Decimal(str(refund.amount)), updated_by)
                invoice = self.invoice_repo.get_by_id(refund.invoice_id, organization_id)
                self.customer_service.sync_outstanding_balance(invoice.customer_id, organization_id)
            elif source == RefundSource.CREDIT_NOTE and credit_note is not None:
                old_cn_status = credit_note.status.value
                credit_note.remaining_amount = Decimal(str(credit_note.remaining_amount)) - Decimal(str(refund.amount))
                if credit_note.remaining_amount <= 0:
                    credit_note.status = CreditNoteStatus.FULLY_APPLIED
                safe_commit_and_refresh(self.db, credit_note)
                self.audit.log(
                    organization_id, updated_by, BillingAuditAction.UPDATE, "CreditNote", credit_note.id,
                    old_values={"status": old_cn_status},
                    new_values={"status": credit_note.status.value, "refunded_amount": str(refund.amount)},
                )
            elif source == RefundSource.CUSTOMER_CREDIT_BALANCE:
                self.customer_service.adjust_credit_balance(
                    refund.customer_id, organization_id, Decimal(str(refund.amount)), "decrease",
                    reason=f"Refund {refund.refund_number}", updated_by=updated_by,
                )
        except Exception as e:
            logger.error(
                "[BILLING] Balance sync failed for completed refund %d (source=%s): %s",
                refund_id, refund.refund_source, e,
            )

        email_result = self._send_email_best_effort(refund, organization_id, updated_by, trigger="completed")
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Refund", refund_id,
            new_values=email_result,
        )
        return refund

    def fail_refund(self, refund_id: int, organization_id: int, failure_reason: str, updated_by: int) -> Refund:
        refund = self.repo.get_by_id(refund_id, organization_id)
        self._validate_status_transition(refund.status, RefundStatus.FAILED)
        old_status = refund.status.value
        refund.status = RefundStatus.FAILED
        refund.failure_reason = failure_reason
        safe_commit_and_refresh(self.db, refund)
        self._record_status_history(organization_id, refund_id, old_status, RefundStatus.FAILED.value, updated_by, failure_reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Refund", refund_id)
        return refund

    # ── Email / PDF Receipt ─────────────────────────────────────────────────

    def send_refund_via_email(self, refund_id: int, organization_id: int, sent_by: int) -> Dict[str, Any]:
        """Explicit (re)send — mirrors CreditNoteService.send_credit_note_via_email.
        Raises if the customer has no usable email since the caller explicitly
        asked to email it (unlike the best-effort send after completion)."""
        refund = self.repo.get_by_id(refund_id, organization_id)
        if refund.status != RefundStatus.COMPLETED:
            raise BadRequestException(
                f"Cannot email a refund in '{refund.status.value}' status. It must be completed first."
            )
        result = self._send_email_best_effort(refund, organization_id, sent_by, trigger="manual_resend", raise_on_missing_email=True)
        self.audit.log(organization_id, sent_by, BillingAuditAction.SEND, "Refund", refund_id, new_values=result)
        return {
            "refund_id": refund.id,
            "refund_number": refund.refund_number,
            **result,
        }

    def _send_email_best_effort(
        self, refund: Refund, organization_id: int, actor_id: int, trigger: str,
        raise_on_missing_email: bool = False,
    ) -> Dict[str, Any]:
        customer = self.customer_service.get_customer(refund.customer_id, organization_id)
        email = (customer.email or "").strip()
        if not email or "@" not in email:
            if raise_on_missing_email:
                raise BadRequestException(
                    f"Customer '{customer.company_name}' does not have a valid email address. "
                    "Please update the customer profile before sending."
                )
            return {"email_sent_to": None, "email_delivered": False}

        pdf_bytes = None
        try:
            from app.modules.billing.services.pdf_service import generate_refund_pdf
            from app.modules.billing.services.settings_service import BillingConfigurationService
            org_config = BillingConfigurationService(self.db).get_configuration(organization_id)
            pdf_bytes = generate_refund_pdf(refund, customer, org_config)
        except Exception as e:
            logger.warning("Failed to generate PDF for refund %d, sending without attachment: %s", refund.id, e)

        email_delivered = False
        try:
            email_delivered = send_refund_email(
                email=email,
                customer_name=customer.display_name or customer.company_name,
                refund_number=refund.refund_number,
                refund_date=str(refund.completed_at.date()) if refund.completed_at else "",
                amount=f"{round_money(refund.amount or 0, refund.currency):,.2f}",
                currency=refund.currency or BillingConfigurationService(self.db).get_default_currency(organization_id),
                reason=refund.reason or "",
                organization_id=organization_id,
                db=self.db,
                pdf_bytes=pdf_bytes,
                pdf_filename=f"{refund.refund_number or f'refund-{refund.id}'}.pdf",
            )
        except Exception as e:
            logger.warning("Failed to send refund email for refund %d: %s", refund.id, e)

        comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
        event_type = CommunicationEventType.EMAIL_SENT if email_delivered else CommunicationEventType.EMAIL_FAILED
        self.comms_repo.record_event_safe(
            organization_id=organization_id,
            refund_id=refund.id,
            event_type=event_type,
            status=comm_status,
            recipient=email,
            subject=f"Refund {refund.refund_number}",
            body_preview=f"Refund {refund.refund_number} sent to {email}",
            event_metadata={"email_delivered": email_delivered, "trigger": trigger},
            created_by=actor_id,
        )
        return {"email_sent_to": email, "email_delivered": email_delivered}

    # ── Status History ─────────────────────────────────────────────────────

    def list_status_history(self, refund_id: int, organization_id: int) -> List[RefundStatusHistory]:
        self.repo.get_by_id(refund_id, organization_id)
        return self.history_repo.list_by_refund(organization_id, refund_id)

    # ── Communication History ─────────────────────────────────────────────

    def list_communications(self, refund_id: int, organization_id: int) -> List[RefundCommunication]:
        self.repo.get_by_id(refund_id, organization_id)
        return self.comms_repo.list_by_refund_safe(organization_id, refund_id)

    def add_communication_note(
        self, refund_id: int, organization_id: int, created_by: int,
        note: str, **kwargs: Any,
    ) -> RefundCommunication:
        self.repo.get_by_id(refund_id, organization_id)
        return self.comms_repo.record_event(
            organization_id=organization_id,
            refund_id=refund_id,
            event_type=CommunicationEventType.NOTE_ADDED,
            recipient=None,
            subject=None,
            body_preview=note[:500] if note else None,
            event_metadata={"note": note, **kwargs},
            created_by=created_by,
        )

    # ── Timeline ────────────────────────────────────────────────────────────

    def get_timeline(self, refund_id: int, organization_id: int) -> List[Dict[str, Any]]:
        self.repo.get_by_id(refund_id, organization_id)
        entries = []

        for sh in self.history_repo.list_by_refund(organization_id, refund_id):
            entries.append({
                "timestamp": sh.created_at,
                "event_type": "status_change",
                "title": f"Status changed to {sh.to_status}",
                "description": sh.reason,
                "actor_id": sh.changed_by,
                "metadata": {
                    "from_status": sh.from_status,
                    "to_status": sh.to_status,
                    "status_history_id": sh.id,
                },
            })

        for comm in self.comms_repo.list_by_refund_safe(organization_id, refund_id):
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": {
                    CommunicationEventType.EMAIL_SENT: "Refund receipt emailed",
                    CommunicationEventType.EMAIL_DELIVERED: "Email delivered",
                    CommunicationEventType.EMAIL_BOUNCED: "Email bounced",
                    CommunicationEventType.EMAIL_FAILED: "Email failed",
                    CommunicationEventType.NOTE_ADDED: "Note added",
                    CommunicationEventType.MANUAL_RESEND: "Manual resend",
                }.get(comm.event_type, comm.event_type),
                "description": comm.subject or comm.body_preview,
                "actor_id": comm.created_by,
                "metadata": {
                    "recipient": comm.recipient,
                    "status": comm.status,
                    "communication_id": comm.id,
                    **(comm.event_metadata or {}),
                },
            })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries

    # ── Customer Refund History ─────────────────────────────────────────────

    def list_customer_refunds(
        self, organization_id: int, customer_id: int, page: int = 1, per_page: int = 20,
    ) -> Dict[str, Any]:
        self.customer_service.get_customer(customer_id, organization_id)
        return self.repo.list_paginated(organization_id=organization_id, page=page, per_page=per_page, customer_id=customer_id)

    def get_customer_refund_summary(self, organization_id: int, customer_id: int) -> Dict[str, Any]:
        self.customer_service.get_customer(customer_id, organization_id)
        refunds = self.repo.list_by_customer(organization_id, customer_id, active_only=True)
        completed = [r for r in refunds if r.status == RefundStatus.COMPLETED]
        in_flight = [
            r for r in refunds
            if r.status in (
                RefundStatus.DRAFT, RefundStatus.PENDING_APPROVAL, RefundStatus.APPROVED,
                RefundStatus.PROCESSING, RefundStatus.PENDING,
            )
        ]
        total_refunded = sum((Decimal(str(r.amount)) for r in completed), Decimal("0"))
        outstanding = sum((Decimal(str(r.amount)) for r in in_flight), Decimal("0"))
        return {
            "customer_id": customer_id,
            "total_refunded": float(total_refunded),
            "outstanding_refund_requests": float(outstanding),
            "refund_count": len(refunds),
            "completed_count": len(completed),
        }

    # ── Dashboard / Reporting ───────────────────────────────────────────────

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        return self.repo.get_dashboard_stats(organization_id)

    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_status_distribution(organization_id)

    def get_type_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_type_distribution(organization_id)

    def get_method_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_method_distribution(organization_id)

    def get_source_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_source_distribution(organization_id)

    def get_reason_distribution(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        return self.repo.get_reason_distribution(organization_id, limit)

    def get_monthly_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        return self.repo.get_monthly_trend(organization_id, months)
