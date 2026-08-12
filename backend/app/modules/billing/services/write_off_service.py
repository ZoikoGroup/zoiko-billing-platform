import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    CommunicationEventStatus,
    CommunicationEventType,
    InvoiceStatus,
    NumberFormat,
    SequenceReset,
    WriteOff,
    WriteOffCommunication,
    WriteOffSource,
    WriteOffStatus,
    WriteOffStatusHistory,
)
from app.modules.billing.models import WriteOff as WriteOffModel
from app.modules.billing.repositories.customer import CustomerRepository
from app.modules.billing.repositories.invoice import InvoiceRepository
from app.modules.billing.repositories.write_off import (
    WriteOffCommunicationRepository,
    WriteOffRepository,
    WriteOffStatusHistoryRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import (
    filter_allowed, render_document_number, safe_commit_and_refresh, sequence_window_start,
)
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.utils.currency_utils import round_money
from app.services.email_service import send_write_off_email

logger = logging.getLogger("zoiko")

WRITE_OFF_ALLOWED_FIELDS = {
    "customer_id", "write_off_number", "write_off_type", "adjustment_type",
    "amount", "invoice_id", "write_off_source", "reason", "notes",
    "currency", "exchange_rate",
}


class WriteOffService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = WriteOffRepository(db)
        self.history_repo = WriteOffStatusHistoryRepository(db)
        self.comms_repo = WriteOffCommunicationRepository(db)
        self.invoice_repo = InvoiceRepository(db)
        self.customer_repo = CustomerRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)
        self.invoice_service = InvoiceService(db)

    # ── Status Machine ──────────────────────────────────────────────────────
    # Draft -> Pending Approval -> Approved -> Executed -> Reversed
    #                                                    (branches to Cancelled
    #                                                     from Draft/Pending
    #                                                     Approval/Approved)

    def _validate_status_transition(self, current: WriteOffStatus, target: WriteOffStatus) -> None:
        valid = {
            WriteOffStatus.DRAFT: [WriteOffStatus.PENDING_APPROVAL, WriteOffStatus.CANCELLED],
            WriteOffStatus.PENDING_APPROVAL: [WriteOffStatus.APPROVED, WriteOffStatus.CANCELLED],
            WriteOffStatus.APPROVED: [WriteOffStatus.EXECUTED, WriteOffStatus.CANCELLED],
            WriteOffStatus.EXECUTED: [WriteOffStatus.REVERSED],
            WriteOffStatus.REVERSED: [],
            WriteOffStatus.CANCELLED: [],
        }
        if target not in valid.get(current, []):
            raise BadRequestException(f"Cannot transition write-off from {current.value} to {target.value}")

    def _record_status_history(
        self, organization_id: int, write_off_id: int, from_status: Optional[str], to_status: str,
        changed_by: Optional[int] = None, reason: Optional[str] = None,
    ) -> WriteOffStatusHistory:
        return self.history_repo.log_status_change(organization_id, write_off_id, from_status, to_status, changed_by, reason)

    def _generate_write_off_number(self, organization_id: int) -> str:
        from app.modules.billing.services.settings_service import BillingConfigurationService
        from app.modules.billing.services.document_sequence import DocumentSequenceService
        config_svc = BillingConfigurationService(self.db)
        config = config_svc.get_configuration(organization_id)
        prefix = config.write_off_prefix or "WO-"
        fmt = config.write_off_number_format or NumberFormat.PREFIX_YYYY_SEQ
        reset = getattr(config, "write_off_sequence_reset", None) or SequenceReset.ANNUALLY

        return DocumentSequenceService(self.db).next_number(
            organization_id, "write_off", prefix, fmt, reset,
        )

    @staticmethod
    def _infer_source(invoice_id: Optional[int]) -> WriteOffSource:
        return WriteOffSource.INVOICE if invoice_id else WriteOffSource.ADJUSTMENT_ONLY

    @staticmethod
    def _validate_source_reference(source: WriteOffSource, invoice_id: Optional[int]) -> None:
        if source == WriteOffSource.INVOICE and not invoice_id:
            raise BadRequestException("invoice_id is required when write_off_source is 'invoice'")

    # ── Create ───────────────────────────────────────────────────────────────

    def create_write_off(
        self, organization_id: int, created_by: int,
        customer_id: int, write_off_number: str,
        write_off_type: str, amount: Decimal, **data: Any,
    ) -> WriteOff:
        from app.modules.billing.services.settings_service import BillingConfigurationService

        data = filter_allowed(data, WRITE_OFF_ALLOWED_FIELDS)

        if amount <= 0:
            raise BadRequestException("Write-off amount must be greater than zero")

        self.customer_service.get_customer(customer_id, organization_id)

        if not write_off_number or write_off_number.strip().lower() in ("auto", "auto-generated", ""):
            write_off_number = self._generate_write_off_number(organization_id)
        if self.repo.exists(organization_id, write_off_number=write_off_number):
            raise AlreadyExistsException("WriteOff", "write_off_number")

        invoice_id = data.get("invoice_id")

        raw_source = data.get("write_off_source")
        source = WriteOffSource(raw_source) if raw_source else self._infer_source(invoice_id)
        self._validate_source_reference(source, invoice_id)
        data["write_off_source"] = source.value

        # ── Row-locked source lookup (prevents concurrent over-write-off) ──
        invoice = None
        if invoice_id:
            invoice = self.invoice_repo.get_by_id_for_update(invoice_id, organization_id)
            if invoice.customer_id != customer_id:
                raise BadRequestException("Invoice does not belong to this customer")
            if invoice.status in (InvoiceStatus.CANCELLED, InvoiceStatus.PAID, InvoiceStatus.REFUNDED):
                raise BadRequestException(f"Cannot write off a {invoice.status.value} invoice")

        # ── Resolve currency ──────────────────────────────────────────────
        if not data.get("currency"):
            if invoice and invoice.currency:
                data["currency"] = invoice.currency
            else:
                config_svc = BillingConfigurationService(self.db)
                data["currency"] = config_svc.get_default_currency(organization_id)

        # ── Currency must match the invoice's currency, when sourced from one
        if invoice is not None and invoice.currency and data["currency"] != invoice.currency:
            raise BadRequestException(
                f"Write-off currency ({data['currency']}) must match the invoice's currency "
                f"({invoice.currency}). Cross-currency write-offs are not yet supported."
            )

        # ── Resolve exchange rate if not provided ─────────────────────────
        if not data.get("exchange_rate") and data.get("currency"):
            from app.modules.billing.services.exchange_rate_service import ExchangeRateService
            config_svc = BillingConfigurationService(self.db)
            org_config = config_svc.get_configuration(organization_id)
            base_currency = (
                org_config.base_currency.value if hasattr(org_config.base_currency, "value")
                else str(org_config.base_currency or "USD")
            )
            if data["currency"] != base_currency:
                rate_svc = ExchangeRateService(self.db)
                rate, _, _ = rate_svc.get_rate(organization_id, data["currency"], base_currency)
                data["exchange_rate"] = rate

        # ── Never allow a write-off to exceed the outstanding balance ─────
        # Both branches use a *reserved/committed* total rather than just the
        # raw balance field, so two write-offs against the same scope can't
        # each individually pass validation and later jointly exceed it. The
        # two branches count different status sets because only one of them
        # has an independent persisted record of an executed amount — see
        # the docstrings on get_total_reserved_for_invoice (excludes
        # EXECUTED; already reflected in balance_due) and
        # get_total_committed_for_customer_balance (includes EXECUTED; the
        # write-off row is the only record of that amount).
        if source == WriteOffSource.INVOICE:
            reserved = self.repo.get_total_reserved_for_invoice(organization_id, invoice.id)
            remaining = Decimal(str(invoice.balance_due or 0)) - reserved
            if amount > remaining:
                raise BadRequestException(
                    f"Write-off amount {amount} exceeds the invoice's outstanding balance {remaining} "
                    f"(balance due: {invoice.balance_due}, already committed: {reserved})"
                )
        elif source in (WriteOffSource.CUSTOMER_OUTSTANDING_BALANCE, WriteOffSource.RECEIVABLE):
            # Row-lock the customer so two concurrent creates against the same
            # customer's balance can't both read the same pre-commitment total
            # and jointly pass validation — mirrors the invoice row-lock above.
            locked_customer = self.customer_repo.get_by_id_for_update(customer_id, organization_id)
            committed = self.repo.get_total_committed_for_customer_balance(organization_id, customer_id)
            available = Decimal(str(locked_customer.outstanding_balance or 0)) - committed
            if amount > available:
                raise BadRequestException(
                    f"Write-off amount {amount} exceeds the customer's available outstanding balance {available} "
                    f"(outstanding: {locked_customer.outstanding_balance}, already committed: {committed})"
                )
        # ADJUSTMENT_ONLY is a pure accounting entry with no enforceable
        # collectible balance to check against — validated by amount > 0 only.

        write_off = self.repo.create(
            organization_id, customer_id=customer_id,
            write_off_number=write_off_number, write_off_type=write_off_type,
            amount=amount, status=WriteOffStatus.DRAFT, **data,
        )
        self._record_status_history(organization_id, write_off.id, None, WriteOffStatus.DRAFT.value, created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "WriteOff", write_off.id, new_values=data)
        return write_off

    def update_write_off(self, write_off_id: int, organization_id: int, updated_by: int, **data: Any) -> WriteOff:
        data = filter_allowed(data, WRITE_OFF_ALLOWED_FIELDS)
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        if write_off.status != WriteOffStatus.DRAFT:
            raise BadRequestException("Only draft write-offs can be edited")
        updated = self.repo.update(write_off_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "WriteOff", write_off_id)
        return updated

    def get_write_off(self, write_off_id: int, organization_id: int) -> WriteOff:
        return self.repo.get_by_id(write_off_id, organization_id)

    def get_by_number(self, organization_id: int, number: str) -> Optional[WriteOff]:
        return self.repo.get_by_number(organization_id, number)

    def list_write_offs(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, write_off_type: Optional[str] = None,
        adjustment_type: Optional[str] = None, write_off_source: Optional[str] = None,
        sort_by: str = "created_at", sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, write_off_type=write_off_type,
            adjustment_type=adjustment_type, write_off_source=write_off_source,
        )

    # ── Approval Workflow ────────────────────────────────────────────────────

    def submit_for_approval(self, write_off_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> WriteOff:
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        self._validate_status_transition(write_off.status, WriteOffStatus.PENDING_APPROVAL)
        old_status = write_off.status.value
        write_off.status = WriteOffStatus.PENDING_APPROVAL
        safe_commit_and_refresh(self.db, write_off)
        self._record_status_history(organization_id, write_off_id, old_status, WriteOffStatus.PENDING_APPROVAL.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "WriteOff", write_off_id)
        return write_off

    def approve_write_off(self, write_off_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> WriteOff:
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        self._validate_status_transition(write_off.status, WriteOffStatus.APPROVED)
        old_status = write_off.status.value
        write_off.status = WriteOffStatus.APPROVED
        write_off.approved_at = datetime.utcnow()
        write_off.approved_by = updated_by
        safe_commit_and_refresh(self.db, write_off)
        self._record_status_history(organization_id, write_off_id, old_status, WriteOffStatus.APPROVED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.APPROVE, "WriteOff", write_off_id)
        return write_off

    def cancel_write_off(self, write_off_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> WriteOff:
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        self._validate_status_transition(write_off.status, WriteOffStatus.CANCELLED)
        old_status = write_off.status.value
        write_off.status = WriteOffStatus.CANCELLED
        write_off.cancelled_at = datetime.utcnow()
        write_off.cancelled_by = updated_by
        write_off.cancellation_reason = reason
        safe_commit_and_refresh(self.db, write_off)
        self._record_status_history(organization_id, write_off_id, old_status, WriteOffStatus.CANCELLED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.CANCEL, "WriteOff", write_off_id)
        return write_off

    # ── Execution ────────────────────────────────────────────────────────────

    def execute_write_off(self, write_off_id: int, organization_id: int, updated_by: int) -> WriteOff:
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        self._validate_status_transition(write_off.status, WriteOffStatus.EXECUTED)

        # Re-validate against the current (mutable) balance under a fresh row
        # lock — it may have shifted between approval and execution (a
        # payment could have landed on the invoice; unrelated invoice/payment
        # activity could have moved the customer's outstanding_balance).
        invoice = None
        if write_off.write_off_source == WriteOffSource.INVOICE and write_off.invoice_id:
            invoice = self.invoice_repo.get_by_id_for_update(write_off.invoice_id, organization_id)
            if Decimal(str(write_off.amount)) > Decimal(str(invoice.balance_due or 0)):
                raise BadRequestException("Write-off amount exceeds the invoice's current outstanding balance")
        elif write_off.write_off_source in (WriteOffSource.CUSTOMER_OUTSTANDING_BALANCE, WriteOffSource.RECEIVABLE):
            locked_customer = self.customer_repo.get_by_id_for_update(write_off.customer_id, organization_id)
            # This write-off is currently APPROVED, which the committed-total
            # query already counts — so the total below already includes its
            # own amount and must not exceed the balance on its own.
            committed = self.repo.get_total_committed_for_customer_balance(organization_id, write_off.customer_id)
            if committed > Decimal(str(locked_customer.outstanding_balance or 0)):
                raise BadRequestException("Write-off amount exceeds the customer's current outstanding balance")

        old_status = write_off.status.value
        write_off.status = WriteOffStatus.EXECUTED
        write_off.executed_at = datetime.utcnow()
        write_off.executed_by = updated_by
        safe_commit_and_refresh(self.db, write_off)
        self._record_status_history(organization_id, write_off_id, old_status, WriteOffStatus.EXECUTED.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.WRITE_OFF, "WriteOff", write_off_id)

        # ── Source-specific balance sync. An executed write-off has already
        # been recorded as an accounting fact and must not be rolled back by a
        # downstream sync failure — failures are logged loudly instead for
        # manual reconciliation, mirroring the refund-completion best-effort
        # style.
        #
        # Only the INVOICE source touches a mutable, persisted balance
        # (Invoice.balance_due, which then flows into
        # BillingCustomer.outstanding_balance via sync_outstanding_balance).
        # CUSTOMER_OUTSTANDING_BALANCE/RECEIVABLE/ADJUSTMENT_ONLY write-offs
        # are deliberately NOT applied against BillingCustomer.outstanding_balance
        # directly: that field is a derived rollup of live invoice balances,
        # recomputed by sync_outstanding_balance on every unrelated
        # invoice/payment/credit-note operation for the customer — a direct
        # decrement here would be silently overwritten by the next sync. Those
        # write-off types are recorded as their own ledger entries and
        # reported separately (see get_customer_write_off_summary) rather than
        # folded into a field they can't durably affect.
        try:
            if invoice is not None:
                self.invoice_service.record_write_off(invoice.id, organization_id, Decimal(str(write_off.amount)), updated_by)
                self.customer_service.sync_outstanding_balance(invoice.customer_id, organization_id)
        except Exception as e:
            logger.error(
                "[BILLING] Balance sync failed for executed write-off %d (source=%s): %s",
                write_off_id, write_off.write_off_source, e,
            )

        email_result = self._send_email_best_effort(write_off, organization_id, updated_by, trigger="executed")
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "WriteOff", write_off_id,
            new_values=email_result,
        )
        return write_off

    # ── Reversal ─────────────────────────────────────────────────────────────

    def reverse_write_off(self, write_off_id: int, organization_id: int, updated_by: int, reason: str) -> WriteOff:
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        self._validate_status_transition(write_off.status, WriteOffStatus.REVERSED)

        old_status = write_off.status.value
        write_off.status = WriteOffStatus.REVERSED
        write_off.reversed_at = datetime.utcnow()
        write_off.reversed_by = updated_by
        write_off.reversal_reason = reason
        safe_commit_and_refresh(self.db, write_off)
        self._record_status_history(organization_id, write_off_id, old_status, WriteOffStatus.REVERSED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.REVERSE, "WriteOff", write_off_id)

        try:
            if write_off.write_off_source == WriteOffSource.INVOICE and write_off.invoice_id:
                self.invoice_service.reverse_write_off(
                    write_off.invoice_id, organization_id, Decimal(str(write_off.amount)), updated_by,
                )
                invoice = self.invoice_repo.get_by_id(write_off.invoice_id, organization_id)
                self.customer_service.sync_outstanding_balance(invoice.customer_id, organization_id)
        except Exception as e:
            logger.error(
                "[BILLING] Balance sync failed for reversed write-off %d (source=%s): %s",
                write_off_id, write_off.write_off_source, e,
            )

        return write_off

    # ── Email / PDF ─────────────────────────────────────────────────────────

    def send_write_off_via_email(self, write_off_id: int, organization_id: int, sent_by: int) -> Dict[str, Any]:
        write_off = self.repo.get_by_id(write_off_id, organization_id)
        if write_off.status != WriteOffStatus.EXECUTED:
            raise BadRequestException(
                f"Cannot email a write-off in '{write_off.status.value}' status. It must be executed first."
            )
        result = self._send_email_best_effort(write_off, organization_id, sent_by, trigger="manual_resend", raise_on_missing_email=True)
        self.audit.log(organization_id, sent_by, BillingAuditAction.SEND, "WriteOff", write_off_id, new_values=result)
        return {
            "write_off_id": write_off.id,
            "write_off_number": write_off.write_off_number,
            **result,
        }

    def _send_email_best_effort(
        self, write_off: WriteOff, organization_id: int, actor_id: int, trigger: str,
        raise_on_missing_email: bool = False,
    ) -> Dict[str, Any]:
        customer = self.customer_service.get_customer(write_off.customer_id, organization_id)
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
            from app.modules.billing.services.pdf_service import generate_write_off_pdf
            from app.modules.billing.services.settings_service import BillingConfigurationService
            org_config = BillingConfigurationService(self.db).get_configuration(organization_id)
            pdf_bytes = generate_write_off_pdf(write_off, customer, org_config)
        except Exception as e:
            logger.warning("Failed to generate PDF for write-off %d, sending without attachment: %s", write_off.id, e)

        email_delivered = False
        try:
            email_delivered = send_write_off_email(
                email=email,
                customer_name=customer.display_name or customer.company_name,
                write_off_number=write_off.write_off_number,
                write_off_date=str(write_off.executed_at.date()) if write_off.executed_at else "",
                amount=f"{round_money(write_off.amount or 0, write_off.currency):,.2f}",
                currency=write_off.currency or "USD",
                reason=write_off.reason or "",
                organization_id=organization_id,
                db=self.db,
                pdf_bytes=pdf_bytes,
                pdf_filename=f"{write_off.write_off_number or f'write-off-{write_off.id}'}.pdf",
            )
        except Exception as e:
            logger.warning("Failed to send write-off email for write-off %d: %s", write_off.id, e)

        comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
        event_type = CommunicationEventType.EMAIL_SENT if email_delivered else CommunicationEventType.EMAIL_FAILED
        self.comms_repo.record_event_safe(
            organization_id=organization_id,
            write_off_id=write_off.id,
            event_type=event_type,
            status=comm_status,
            recipient=email,
            subject=f"Write-off {write_off.write_off_number}",
            body_preview=f"Write-off {write_off.write_off_number} sent to {email}",
            event_metadata={"email_delivered": email_delivered, "trigger": trigger},
            created_by=actor_id,
        )
        return {"email_sent_to": email, "email_delivered": email_delivered}

    # ── Status History ─────────────────────────────────────────────────────

    def list_status_history(self, write_off_id: int, organization_id: int) -> List[WriteOffStatusHistory]:
        self.repo.get_by_id(write_off_id, organization_id)
        return self.history_repo.list_by_write_off(organization_id, write_off_id)

    # ── Communication History ─────────────────────────────────────────────

    def list_communications(self, write_off_id: int, organization_id: int) -> List[WriteOffCommunication]:
        self.repo.get_by_id(write_off_id, organization_id)
        return self.comms_repo.list_by_write_off_safe(organization_id, write_off_id)

    def add_communication_note(
        self, write_off_id: int, organization_id: int, created_by: int,
        note: str, **kwargs: Any,
    ) -> WriteOffCommunication:
        self.repo.get_by_id(write_off_id, organization_id)
        return self.comms_repo.record_event(
            organization_id=organization_id,
            write_off_id=write_off_id,
            event_type=CommunicationEventType.NOTE_ADDED,
            recipient=None,
            subject=None,
            body_preview=note[:500] if note else None,
            event_metadata={"note": note, **kwargs},
            created_by=created_by,
        )

    # ── Timeline ────────────────────────────────────────────────────────────

    def get_timeline(self, write_off_id: int, organization_id: int) -> List[Dict[str, Any]]:
        self.repo.get_by_id(write_off_id, organization_id)
        entries = []

        for sh in self.history_repo.list_by_write_off(organization_id, write_off_id):
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

        for comm in self.comms_repo.list_by_write_off_safe(organization_id, write_off_id):
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": {
                    CommunicationEventType.EMAIL_SENT: "Write-off notice emailed",
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

    # ── Customer Write-off History ──────────────────────────────────────────

    def list_customer_write_offs(
        self, organization_id: int, customer_id: int, page: int = 1, per_page: int = 20,
    ) -> Dict[str, Any]:
        self.customer_service.get_customer(customer_id, organization_id)
        return self.repo.list_paginated(organization_id=organization_id, page=page, per_page=per_page, customer_id=customer_id)

    def get_customer_write_off_summary(self, organization_id: int, customer_id: int) -> Dict[str, Any]:
        self.customer_service.get_customer(customer_id, organization_id)
        write_offs = self.repo.list_by_customer(organization_id, customer_id, active_only=True)
        executed = [w for w in write_offs if w.status == WriteOffStatus.EXECUTED]
        in_flight = [
            w for w in write_offs
            if w.status in (WriteOffStatus.DRAFT, WriteOffStatus.PENDING_APPROVAL, WriteOffStatus.APPROVED)
        ]
        total_written_off = sum((Decimal(str(w.amount)) for w in executed), Decimal("0"))
        outstanding = sum((Decimal(str(w.amount)) for w in in_flight), Decimal("0"))
        return {
            "customer_id": customer_id,
            "total_written_off": float(total_written_off),
            "outstanding_write_off_requests": float(outstanding),
            "write_off_count": len(write_offs),
            "executed_count": len(executed),
        }

    # ── Dashboard / Reporting ───────────────────────────────────────────────

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        return self.repo.get_dashboard_stats(organization_id)

    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_status_distribution(organization_id)

    def get_type_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_type_distribution(organization_id)

    def get_adjustment_type_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_adjustment_type_distribution(organization_id)

    def get_source_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_source_distribution(organization_id)

    def get_reason_distribution(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        return self.repo.get_reason_distribution(organization_id, limit)

    def get_customer_distribution(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        return self.repo.get_customer_distribution(organization_id, limit)

    def get_monthly_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        return self.repo.get_monthly_trend(organization_id, months)
