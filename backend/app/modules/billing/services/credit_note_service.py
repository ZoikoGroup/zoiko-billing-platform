import logging
from datetime import date, datetime
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
    CreditNote,
    CreditNoteApplication,
    CreditNoteStatus,
    CreditNoteStatusHistory,
    CreditNoteCommunication,
    InvoiceStatus,
)
from app.modules.billing.repositories.credit import (
    CreditNoteApplicationRepository,
    CreditNoteCommunicationRepository,
    CreditNoteRepository,
    CreditNoteStatusHistoryRepository,
)
from app.modules.billing.repositories.invoice import InvoiceRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import (
    filter_allowed, render_document_number, safe_commit_and_refresh, sequence_window_start,
)
from app.modules.billing.models import CreditNote as CreditNoteModel
from app.modules.billing.models import NumberFormat, SequenceReset
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.utils.currency_utils import round_money
from app.services.email_service import send_credit_note_email

logger = logging.getLogger("zoiko")

CREDIT_NOTE_ALLOWED_FIELDS = {
    "customer_id", "credit_note_number", "credit_note_type",
    "subtotal", "discount_amount", "tax_amount",
    "total_amount", "remaining_amount", "issue_date",
    "invoice_id", "reason", "status", "is_active",
    "currency", "exchange_rate",
}

# Amounts are entered/rounded independently (subtotal, discount, tax, total);
# this tolerance absorbs harmless client-side floating-point rounding without
# masking a genuinely wrong total.
_TOTALS_TOLERANCE = Decimal("0.01")


class CreditNoteService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = CreditNoteRepository(db)
        self.app_repo = CreditNoteApplicationRepository(db)
        self.history_repo = CreditNoteStatusHistoryRepository(db)
        self.comms_repo = CreditNoteCommunicationRepository(db)
        self.invoice_repo = InvoiceRepository(db)
        self.invoice_service = InvoiceService(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)

    # ── Status Machine ──────────────────────────────────────────────────────

    def _validate_status_transition(self, current: CreditNoteStatus, target: CreditNoteStatus) -> None:
        valid = {
            CreditNoteStatus.DRAFT: [CreditNoteStatus.APPROVED, CreditNoteStatus.VOIDED],
            CreditNoteStatus.APPROVED: [CreditNoteStatus.ISSUED, CreditNoteStatus.VOIDED],
            CreditNoteStatus.ISSUED: [CreditNoteStatus.PARTIALLY_APPLIED, CreditNoteStatus.FULLY_APPLIED, CreditNoteStatus.VOIDED],
            CreditNoteStatus.PARTIALLY_APPLIED: [CreditNoteStatus.FULLY_APPLIED, CreditNoteStatus.VOIDED],
            CreditNoteStatus.FULLY_APPLIED: [CreditNoteStatus.VOIDED],
            CreditNoteStatus.VOIDED: [],
        }
        if target not in valid.get(current, []):
            raise BadRequestException(f"Cannot transition credit note from {current.value} to {target.value}")

    def _record_status_history(
        self, organization_id: int, cn_id: int, from_status: Optional[str], to_status: str,
        changed_by: Optional[int] = None, reason: Optional[str] = None,
    ) -> CreditNoteStatusHistory:
        return self.history_repo.log_status_change(organization_id, cn_id, from_status, to_status, changed_by, reason)

    def _generate_credit_note_number(self, organization_id: int) -> str:
        from app.modules.billing.services.settings_service import BillingConfigurationService
        from app.modules.billing.services.document_sequence import DocumentSequenceService
        config_svc = BillingConfigurationService(self.db)
        config = config_svc.get_configuration(organization_id)
        prefix = config.credit_note_prefix or "CN-"
        fmt = config.credit_note_number_format or NumberFormat.PREFIX_YYYY_SEQ
        # Use credit_note_sequence_reset for correct numbering window;
        # fall back to invoice_sequence_reset if not configured.
        reset = getattr(config, "credit_note_sequence_reset", None) or getattr(config, "invoice_sequence_reset", SequenceReset.ANNUALLY)

        return DocumentSequenceService(self.db).next_number(
            organization_id, "credit_note", prefix, fmt, reset,
        )

    def _validate_totals(self, subtotal: Any, discount_amount: Any, tax_amount: Any, total_amount: Any, currency: Optional[str]) -> None:
        subtotal = Decimal(str(subtotal or 0))
        discount_amount = Decimal(str(discount_amount or 0))
        tax_amount = Decimal(str(tax_amount or 0))
        total_amount = Decimal(str(total_amount or 0))
        # Credit notes are a lump-sum document (no line items): a caller may
        # legitimately supply only total_amount and leave subtotal/tax/discount
        # at their zero defaults. Only enforce subtotal - discount + tax == total
        # once the caller actually opts into a breakdown by supplying one of
        # those three — otherwise this would reject every pre-existing
        # lump-sum-only caller.
        if subtotal == 0 and discount_amount == 0 and tax_amount == 0:
            return
        if discount_amount > subtotal:
            raise BadRequestException(f"discount_amount ({discount_amount}) cannot exceed subtotal ({subtotal})")
        expected = round_money(subtotal - discount_amount + tax_amount, currency)
        provided = round_money(total_amount, currency)
        if abs(expected - provided) > _TOTALS_TOLERANCE:
            raise BadRequestException(
                f"total_amount ({provided}) does not match subtotal - discount + tax ({expected})"
            )

    # ── CRUD ─────────────────────────────────────────────────────────────────

    def create_credit_note(
        self, organization_id: int, created_by: int,
        customer_id: int, credit_note_number: str,
        credit_note_type: str, total_amount: Decimal,
        issue_date: date, **data: Any,
    ) -> CreditNote:
        from app.modules.billing.services.settings_service import BillingConfigurationService

        data = filter_allowed(data, CREDIT_NOTE_ALLOWED_FIELDS)

        # Resolve currency from invoice if linked
        if not data.get("currency") and data.get("invoice_id"):
            invoice = self.invoice_service.get_invoice(data["invoice_id"], organization_id)
            if invoice:
                data["currency"] = invoice.currency

        # Fall back to org default
        if not data.get("currency"):
            config_svc = BillingConfigurationService(self.db)
            data["currency"] = config_svc.get_default_currency(organization_id)

        # Resolve exchange rate if not provided
        if not data.get("exchange_rate") and data.get("currency"):
            from app.modules.billing.services.exchange_rate_service import ExchangeRateService
            config_svc = BillingConfigurationService(self.db)
            org_config = config_svc.get_configuration(organization_id)
            base_currency = (
                org_config.base_currency.value
                if hasattr(org_config.base_currency, "value")
                else str(org_config.base_currency or "USD")
            )
            if data["currency"] != base_currency:
                rate_svc = ExchangeRateService(self.db)
                rate, _, _ = rate_svc.get_rate(organization_id, data["currency"], base_currency)
                data["exchange_rate"] = rate

        data.setdefault("discount_amount", Decimal("0"))
        self._validate_totals(
            data.get("subtotal", 0), data.get("discount_amount", 0), data.get("tax_amount", 0),
            total_amount, data["currency"],
        )

        self.customer_service.get_customer(customer_id, organization_id)
        if not credit_note_number or credit_note_number.strip().lower() in ("auto", "auto-generated", ""):
            credit_note_number = self._generate_credit_note_number(organization_id)
        if self.repo.exists(organization_id, credit_note_number=credit_note_number):
            raise AlreadyExistsException("CreditNote", "credit_note_number")

        cn = self.repo.create(
            organization_id, customer_id=customer_id,
            credit_note_number=credit_note_number,
            credit_note_type=credit_note_type,
            total_amount=total_amount, remaining_amount=total_amount,
            issue_date=issue_date, **data,
        )
        self._record_status_history(organization_id, cn.id, None, CreditNoteStatus.DRAFT.value, created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "CreditNote", cn.id, new_values=data)
        return cn

    def update_credit_note(self, cn_id: int, organization_id: int, updated_by: int, **data: Any) -> CreditNote:
        data = filter_allowed(data, CREDIT_NOTE_ALLOWED_FIELDS)
        cn = self.repo.get_by_id(cn_id, organization_id)
        if cn.status != CreditNoteStatus.DRAFT:
            raise BadRequestException("Only draft credit notes can be edited")

        if any(k in data for k in ("subtotal", "discount_amount", "tax_amount", "total_amount")):
            subtotal = data.get("subtotal", cn.subtotal)
            discount_amount = data.get("discount_amount", cn.discount_amount or 0)
            tax_amount = data.get("tax_amount", cn.tax_amount)
            total_amount = data.get("total_amount", cn.total_amount)
            self._validate_totals(subtotal, discount_amount, tax_amount, total_amount, cn.currency)
            # A draft can never have applications yet, so remaining_amount is
            # always exactly total_amount until issuance.
            data["remaining_amount"] = total_amount

        updated = self.repo.update(cn_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CreditNote", cn_id)
        return updated

    def get_credit_note(self, cn_id: int, organization_id: int) -> CreditNote:
        return self.repo.get_by_id(cn_id, organization_id)

    def list_credit_notes(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, credit_note_type: Optional[str] = None,
        sort_by: str = "created_at", sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, credit_note_type=credit_note_type,
        )

    def bulk_delete_credit_notes(self, organization_id: int, ids: List[int], updated_by: int) -> int:
        count = self.repo.bulk_delete(ids, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "CreditNote", None, new_values={"deleted_ids": ids})
        return count

    # ── Status Transitions ─────────────────────────────────────────────────

    def approve_credit_note(self, cn_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> CreditNote:
        cn = self.repo.get_by_id(cn_id, organization_id)
        self._validate_status_transition(cn.status, CreditNoteStatus.APPROVED)
        old_status = cn.status.value
        cn.status = CreditNoteStatus.APPROVED
        cn.approved_at = datetime.utcnow()
        cn.approved_by = updated_by
        safe_commit_and_refresh(self.db, cn)
        self._record_status_history(organization_id, cn_id, old_status, CreditNoteStatus.APPROVED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.APPROVE, "CreditNote", cn_id)
        return cn

    def issue_credit_note(self, cn_id: int, organization_id: int, updated_by: int) -> CreditNote:
        cn = self.repo.get_by_id(cn_id, organization_id)
        self._validate_status_transition(cn.status, CreditNoteStatus.ISSUED)
        old_status = cn.status.value
        cn.status = CreditNoteStatus.ISSUED
        safe_commit_and_refresh(self.db, cn)
        self._record_status_history(organization_id, cn_id, old_status, CreditNoteStatus.ISSUED.value, updated_by)

        email_result = self._send_email_best_effort(cn, organization_id, updated_by, trigger="issued")
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "CreditNote", cn_id,
            new_values=email_result,
        )
        return cn

    def send_credit_note_via_email(self, cn_id: int, organization_id: int, sent_by: int) -> Dict[str, Any]:
        """Explicit (re)send — mirrors InvoiceService.send_invoice_via_email.
        Unlike issue_credit_note's best-effort send, this raises if the
        customer has no usable email since the caller explicitly asked to email it."""
        cn = self.repo.get_by_id(cn_id, organization_id)
        if cn.status not in (
            CreditNoteStatus.ISSUED, CreditNoteStatus.PARTIALLY_APPLIED, CreditNoteStatus.FULLY_APPLIED,
        ):
            raise BadRequestException(
                f"Cannot email a credit note in '{cn.status.value}' status. Issue it first."
            )
        result = self._send_email_best_effort(cn, organization_id, sent_by, trigger="manual_resend", raise_on_missing_email=True)
        self.audit.log(organization_id, sent_by, BillingAuditAction.SEND, "CreditNote", cn_id, new_values=result)
        return {
            "credit_note_id": cn.id,
            "credit_note_number": cn.credit_note_number,
            **result,
        }

    def _send_email_best_effort(
        self, cn: CreditNote, organization_id: int, actor_id: int, trigger: str,
        raise_on_missing_email: bool = False,
    ) -> Dict[str, Any]:
        customer = self.customer_service.get_customer(cn.customer_id, organization_id)
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
            from app.modules.billing.services.pdf_service import generate_credit_note_pdf
            from app.modules.billing.services.settings_service import BillingConfigurationService
            org_config = BillingConfigurationService(self.db).get_configuration(organization_id)
            pdf_bytes = generate_credit_note_pdf(cn, customer, org_config)
        except Exception as e:
            logger.warning("Failed to generate PDF for credit note %d, sending without attachment: %s", cn.id, e)

        email_delivered = False
        try:
            email_delivered = send_credit_note_email(
                email=email,
                customer_name=customer.display_name or customer.company_name,
                credit_note_number=cn.credit_note_number,
                issue_date=str(cn.issue_date) if cn.issue_date else "",
                total_amount=f"{round_money(cn.total_amount or 0, cn.currency):,.2f}",
                currency=cn.currency or "USD",
                reason=cn.reason or "",
                organization_id=organization_id,
                db=self.db,
                pdf_bytes=pdf_bytes,
                pdf_filename=f"{cn.credit_note_number or f'credit-note-{cn.id}'}.pdf",
            )
        except Exception as e:
            logger.warning("Failed to send credit note email for credit note %d: %s", cn.id, e)

        comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
        event_type = CommunicationEventType.EMAIL_SENT if email_delivered else CommunicationEventType.EMAIL_FAILED
        self.comms_repo.record_event_safe(
            organization_id=organization_id,
            credit_note_id=cn.id,
            event_type=event_type,
            status=comm_status,
            recipient=email,
            subject=f"Credit Note {cn.credit_note_number}",
            body_preview=f"Credit note {cn.credit_note_number} sent to {email}",
            event_metadata={"email_delivered": email_delivered, "trigger": trigger},
            created_by=actor_id,
        )
        return {"email_sent_to": email, "email_delivered": email_delivered}

    def void_credit_note(self, cn_id: int, organization_id: int, reason: Optional[str] = None, updated_by: int = None) -> CreditNote:
        cn = self.repo.get_by_id(cn_id, organization_id)
        self._validate_status_transition(cn.status, CreditNoteStatus.VOIDED)
        old_status = cn.status.value
        cn.status = CreditNoteStatus.VOIDED
        cn.voided_at = datetime.utcnow()
        cn.voided_reason = reason
        safe_commit_and_refresh(self.db, cn)
        self._record_status_history(organization_id, cn_id, old_status, CreditNoteStatus.VOIDED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.VOID, "CreditNote", cn_id)
        return cn

    # ── Application ────────────────────────────────────────────────────────

    def apply_to_invoice(
        self, cn_id: int, organization_id: int, invoice_id: int,
        amount: Decimal, created_by: int,
    ) -> CreditNoteApplication:
        cn = self.repo.get_by_id(cn_id, organization_id)
        if cn.status not in (CreditNoteStatus.ISSUED, CreditNoteStatus.PARTIALLY_APPLIED):
            raise BadRequestException("Credit note cannot be applied in its current status")
        invoice = self.invoice_repo.get_by_id(invoice_id, organization_id)
        if invoice.status in (InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED):
            raise BadRequestException("Cannot apply credit to a cancelled/refunded invoice")
        if cn.currency and invoice.currency and cn.currency != invoice.currency:
            raise BadRequestException(
                f"Credit note currency ({cn.currency}) must match the invoice's currency "
                f"({invoice.currency}). Cross-currency credit application is not supported."
            )
        if amount > cn.remaining_amount:
            raise BadRequestException(f"Amount exceeds remaining credit of {cn.remaining_amount}")
        remaining_invoice = invoice.balance_due
        if amount > remaining_invoice:
            raise BadRequestException(
                f"Application amount {amount} exceeds remaining invoice balance {remaining_invoice}"
            )
        app = self.app_repo.create(organization_id, credit_note_id=cn_id, invoice_id=invoice_id, amount=amount, created_by=created_by)
        old_status = cn.status.value
        cn.remaining_amount -= amount
        if cn.remaining_amount <= 0:
            cn.status = CreditNoteStatus.FULLY_APPLIED
        else:
            cn.status = CreditNoteStatus.PARTIALLY_APPLIED
        self.invoice_service.record_payment(invoice_id, organization_id, amount, created_by)
        safe_commit_and_refresh(self.db, cn)
        self._record_status_history(organization_id, cn_id, old_status, cn.status.value, created_by, reason=f"Applied {amount} to invoice #{invoice_id}")
        self.audit.log(organization_id, created_by, BillingAuditAction.UPDATE, "CreditNoteApplication", app.id)
        self.customer_service.sync_outstanding_balance(invoice.customer_id, organization_id)
        return app

    def list_applications(self, cn_id: int, organization_id: int) -> List[CreditNoteApplication]:
        self.repo.get_by_id(cn_id, organization_id)
        return self.app_repo.list_by_credit_note(organization_id, cn_id)

    def get_total_applied(self, cn_id: int, organization_id: int) -> float:
        self.repo.get_by_id(cn_id, organization_id)
        return self.app_repo.get_total_applied(organization_id, cn_id)

    def get_remaining_balance(self, cn_id: int, organization_id: int) -> Decimal:
        cn = self.repo.get_by_id(cn_id, organization_id)
        return cn.remaining_amount

    def get_outstanding_credits(self, organization_id: int) -> float:
        return self.repo.get_outstanding_total(organization_id)

    # ── Customer Credit Balance ─────────────────────────────────────────────

    def get_customer_credit_balance(self, organization_id: int, customer_id: int) -> Dict[str, Any]:
        self.customer_service.get_customer(customer_id, organization_id)
        notes = self.repo.list_by_customer(organization_id, customer_id, active_only=True)
        outstanding = sum(
            (Decimal(str(cn.remaining_amount)) for cn in notes if cn.status in ("issued", "partially_applied")),
            Decimal("0"),
        )
        return {
            "customer_id": customer_id,
            "outstanding_credit_balance": float(outstanding),
            "credit_note_count": len(notes),
        }

    # ── Status History ─────────────────────────────────────────────────────

    def list_status_history(self, cn_id: int, organization_id: int) -> List[CreditNoteStatusHistory]:
        self.repo.get_by_id(cn_id, organization_id)
        return self.history_repo.list_by_credit_note(organization_id, cn_id)

    # ── Communication History ─────────────────────────────────────────────

    def list_communications(self, cn_id: int, organization_id: int) -> List[CreditNoteCommunication]:
        self.repo.get_by_id(cn_id, organization_id)
        return self.comms_repo.list_by_credit_note_safe(organization_id, cn_id)

    def add_communication_note(
        self, cn_id: int, organization_id: int, created_by: int,
        note: str, **kwargs: Any,
    ) -> CreditNoteCommunication:
        self.repo.get_by_id(cn_id, organization_id)
        return self.comms_repo.record_event(
            organization_id=organization_id,
            credit_note_id=cn_id,
            event_type=CommunicationEventType.NOTE_ADDED,
            recipient=None,
            subject=None,
            body_preview=note[:500] if note else None,
            event_metadata={"note": note, **kwargs},
            created_by=created_by,
        )

    # ── Timeline ────────────────────────────────────────────────────────────

    def get_timeline(self, cn_id: int, organization_id: int) -> List[Dict[str, Any]]:
        self.repo.get_by_id(cn_id, organization_id)
        entries = []

        for sh in self.history_repo.list_by_credit_note(organization_id, cn_id):
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

        for comm in self.comms_repo.list_by_credit_note_safe(organization_id, cn_id):
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": {
                    CommunicationEventType.EMAIL_SENT: "Credit note emailed",
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

        for app in self.app_repo.list_by_credit_note(organization_id, cn_id):
            entries.append({
                "timestamp": app.created_at,
                "event_type": "applied_to_invoice",
                "title": f"Applied {app.amount} to invoice #{app.invoice_id}",
                "description": None,
                "actor_id": app.created_by,
                "metadata": {
                    "amount": str(app.amount),
                    "invoice_id": app.invoice_id,
                    "application_id": app.id,
                },
            })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries

    # ── Dashboard / Reporting ───────────────────────────────────────────────

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        return self.repo.get_dashboard_stats(organization_id)

    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_status_distribution(organization_id)

    def get_type_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_type_distribution(organization_id)

    def get_monthly_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        return self.repo.get_monthly_trend(organization_id, months)
