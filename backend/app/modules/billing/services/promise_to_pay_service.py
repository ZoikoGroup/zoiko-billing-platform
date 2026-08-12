import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.modules.billing.models import (
    BillingAuditAction,
    CommunicationEventType,
    PromiseToPay,
    PromiseToPayStatus,
)
from app.modules.billing.repositories.collection import (
    CollectionsCaseRepository,
    DunningCaseRepository,
)
from app.modules.billing.repositories.invoice import InvoiceCommunicationRepository, InvoiceRepository
from app.modules.billing.repositories.promise_to_pay import PromiseToPayRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import filter_allowed, safe_commit_and_refresh
from app.modules.billing.services.customer_service import CustomerService

logger = logging.getLogger("zoiko")

PROMISE_ALLOWED_FIELDS = {
    "customer_id", "invoice_id", "dunning_case_id", "collections_case_id",
    "promise_amount", "promise_date", "notes",
}

_TERMINAL_STATUSES = (PromiseToPayStatus.FULFILLED, PromiseToPayStatus.BROKEN, PromiseToPayStatus.CANCELLED)


class PromiseToPayService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = PromiseToPayRepository(db)
        self.invoice_repo = InvoiceRepository(db)
        self.comms_repo = InvoiceCommunicationRepository(db)
        self.dunning_case_repo = DunningCaseRepository(db)
        self.collections_case_repo = CollectionsCaseRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)

    # ── Create / Update ─────────────────────────────────────────────────────

    def create_promise(self, organization_id: int, created_by: int, customer_id: int, **data: Any) -> PromiseToPay:
        data = filter_allowed(data, PROMISE_ALLOWED_FIELDS)
        self.customer_service.get_customer(customer_id, organization_id)

        invoice_id = data.get("invoice_id")
        if invoice_id:
            invoice = self.invoice_repo.get_by_id(invoice_id, organization_id)
            if invoice.customer_id != customer_id:
                raise BadRequestException("Invoice does not belong to this customer")

        dunning_case_id = data.get("dunning_case_id")
        if dunning_case_id:
            case = self.dunning_case_repo.get_by_id(dunning_case_id, organization_id)
            if case.customer_id != customer_id:
                raise BadRequestException("Dunning case does not belong to this customer")

        collections_case_id = data.get("collections_case_id")
        if collections_case_id:
            case = self.collections_case_repo.get_by_id(collections_case_id, organization_id)
            if case.customer_id != customer_id:
                raise BadRequestException("Collections case does not belong to this customer")

        promise = self.repo.create(
            organization_id, customer_id=customer_id,
            status=PromiseToPayStatus.PENDING, **data,
        )
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PromiseToPay", promise.id, new_values=data)
        return promise

    def update_promise(self, promise_id: int, organization_id: int, updated_by: int, **data: Any) -> PromiseToPay:
        data = filter_allowed(data, {"promise_amount", "promise_date", "notes", "is_active"})
        promise = self.repo.get_by_id(promise_id, organization_id)
        if promise.status in _TERMINAL_STATUSES:
            raise BadRequestException(f"Cannot edit a promise in '{promise.status.value}' status")
        updated = self.repo.update(promise_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PromiseToPay", promise_id)
        return updated

    def get_promise(self, promise_id: int, organization_id: int) -> PromiseToPay:
        return self.repo.get_by_id(promise_id, organization_id)

    def list_promises(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, invoice_id: Optional[int] = None,
        sort_by: str = "promise_date", sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, invoice_id=invoice_id,
        )

    def list_customer_promises(self, organization_id: int, customer_id: int) -> List[PromiseToPay]:
        self.customer_service.get_customer(customer_id, organization_id)
        return self.repo.list_by_customer(organization_id, customer_id)

    def list_communications(self, promise_id: int, organization_id: int) -> List[Dict[str, Any]]:
        """Communications logged against the promise's linked invoice (if any)."""
        promise = self.repo.get_by_id(promise_id, organization_id)
        if not promise.invoice_id:
            return []
        return [
            {
                "id": c.id,
                "invoice_id": c.invoice_id,
                "event_type": c.event_type.value if hasattr(c.event_type, "value") else str(c.event_type),
                "recipient": c.recipient,
                "subject": c.subject,
                "body_preview": c.body_preview,
                "status": c.status.value if hasattr(c.status, "value") else str(c.status),
                "event_metadata": c.event_metadata,
                "created_by": c.created_by,
                "created_at": c.created_at,
            }
            for c in self.comms_repo.list_by_invoice_safe(organization_id, promise.invoice_id)
        ]

    def get_timeline(self, promise_id: int, organization_id: int) -> List[Dict[str, Any]]:
        """Chronological history for a single promise: lifecycle audit-log
        entries (create/update/fulfilled/broken/cancelled + auto-detected
        transitions) merged with any email communications on the linked
        invoice, newest first — same TimelineEntry shape used by the dunning
        and collections case timelines."""
        promise = self.repo.get_by_id(promise_id, organization_id)
        entries = []

        for log in self.audit.list_by_entity(organization_id, "PromiseToPay", promise_id):
            action = log.action.value if hasattr(log.action, "value") else str(log.action or "")
            old_status = (log.old_values or {}).get("status")
            new_status = (log.new_values or {}).get("status")
            if new_status and new_status != old_status:
                title = f"Status changed to {new_status}"
                event_type = f"promise_to_pay_{new_status}" if new_status in ("fulfilled", "broken", "cancelled", "overdue") else "status_change"
                description = "Detected automatically" if (log.new_values or {}).get("detected") == "auto" else None
            else:
                title = {
                    "create": "Promise to pay created",
                    "update": "Promise to pay updated",
                    "cancel": "Promise to pay cancelled",
                }.get(action, f"Promise to pay {action.replace('_', ' ')}")
                event_type = f"promise_to_pay_{action}"
                description = None
            entries.append({
                "timestamp": log.timestamp,
                "event_type": event_type,
                "title": title,
                "description": description,
                "actor_id": log.actor_id,
                "metadata": {
                    "audit_id": log.id,
                    "action": action,
                    "old_values": log.old_values,
                    "new_values": log.new_values,
                },
            })

        for comm in self.comms_repo.list_by_invoice_safe(organization_id, promise.invoice_id) if promise.invoice_id else []:
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": "Reminder emailed" if comm.event_type == CommunicationEventType.REMINDER_SENT else str(comm.event_type),
                "description": comm.subject or comm.body_preview,
                "actor_id": comm.created_by,
                "metadata": {"recipient": comm.recipient, "status": comm.status, "communication_id": comm.id, **(comm.event_metadata or {})},
            })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries

    # ── Manual Overrides ─────────────────────────────────────────────────────

    def mark_fulfilled(self, promise_id: int, organization_id: int, updated_by: int, notes: Optional[str] = None) -> PromiseToPay:
        promise = self.repo.get_by_id(promise_id, organization_id)
        if promise.status in _TERMINAL_STATUSES:
            raise BadRequestException(f"Promise is already in a terminal '{promise.status.value}' status")
        old_status = promise.status.value
        promise.status = PromiseToPayStatus.FULFILLED
        promise.fulfilled_at = datetime.utcnow()
        if notes:
            promise.notes = notes
        safe_commit_and_refresh(self.db, promise)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE, "PromiseToPay", promise_id,
            old_values={"status": old_status}, new_values={"status": PromiseToPayStatus.FULFILLED.value},
        )
        return promise

    def mark_broken(self, promise_id: int, organization_id: int, updated_by: int, notes: Optional[str] = None) -> PromiseToPay:
        promise = self.repo.get_by_id(promise_id, organization_id)
        if promise.status in _TERMINAL_STATUSES:
            raise BadRequestException(f"Promise is already in a terminal '{promise.status.value}' status")
        old_status = promise.status.value
        promise.status = PromiseToPayStatus.BROKEN
        promise.broken_at = datetime.utcnow()
        if notes:
            promise.notes = notes
        safe_commit_and_refresh(self.db, promise)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE, "PromiseToPay", promise_id,
            old_values={"status": old_status}, new_values={"status": PromiseToPayStatus.BROKEN.value},
        )
        return promise

    def cancel_promise(self, promise_id: int, organization_id: int, updated_by: int, notes: Optional[str] = None) -> PromiseToPay:
        promise = self.repo.get_by_id(promise_id, organization_id)
        if promise.status in _TERMINAL_STATUSES:
            raise BadRequestException(f"Promise is already in a terminal '{promise.status.value}' status")
        old_status = promise.status.value
        promise.status = PromiseToPayStatus.CANCELLED
        promise.cancelled_at = datetime.utcnow()
        if notes:
            promise.notes = notes
        safe_commit_and_refresh(self.db, promise)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.CANCEL, "PromiseToPay", promise_id,
            old_values={"status": old_status}, new_values={"status": PromiseToPayStatus.CANCELLED.value},
        )
        return promise

    # ── Automatic Status Detection ──────────────────────────────────────────
    # PENDING -> OVERDUE once promise_date passes (grace window still open)
    #         -> BROKEN once the grace window (BillingConfiguration.grace_days,
    #            reused as-is rather than inventing a promise-specific field)
    #            elapses without payment.
    # Any non-terminal status -> FULFILLED as soon as the linked invoice's
    # balance_due reaches zero. Promises with no linked invoice can only be
    # auto-detected as OVERDUE/BROKEN by date — there is nothing to check
    # payment against, so fulfilment for those must be set manually via
    # mark_fulfilled.

    def check_and_update_status(self, promise_id: int, organization_id: int, grace_days: int = 0) -> PromiseToPay:
        promise = self.repo.get_by_id(promise_id, organization_id)
        if promise.status in _TERMINAL_STATUSES:
            return promise

        if promise.invoice_id:
            invoice = self.invoice_repo.get_by_id(promise.invoice_id, organization_id)
            if Decimal(str(invoice.balance_due or 0)) <= 0:
                old_status = promise.status.value
                promise.status = PromiseToPayStatus.FULFILLED
                promise.fulfilled_at = datetime.utcnow()
                safe_commit_and_refresh(self.db, promise)
                self.audit.log(
                    organization_id, None, BillingAuditAction.UPDATE, "PromiseToPay", promise_id,
                    old_values={"status": old_status}, new_values={"status": PromiseToPayStatus.FULFILLED.value, "detected": "auto"},
                )
                return promise

        today = date.today()
        broken_after = promise.promise_date + timedelta(days=max(grace_days, 0))
        old_status = promise.status.value
        if today > broken_after:
            new_status = PromiseToPayStatus.BROKEN
        elif today > promise.promise_date:
            new_status = PromiseToPayStatus.OVERDUE
        else:
            new_status = PromiseToPayStatus.PENDING

        if new_status.value != old_status:
            promise.status = new_status
            if new_status == PromiseToPayStatus.BROKEN:
                promise.broken_at = datetime.utcnow()
            safe_commit_and_refresh(self.db, promise)
            self.audit.log(
                organization_id, None, BillingAuditAction.UPDATE, "PromiseToPay", promise_id,
                old_values={"status": old_status}, new_values={"status": new_status.value, "detected": "auto"},
            )
        return promise

    def process_promise_to_pay(self, organization_id: int, grace_days: int = 0) -> List[Dict[str, Any]]:
        """Batch entry point for the scheduler task — re-checks every open
        (non-terminal) promise for this org and returns the ones whose status
        changed, mirroring DunningService.process_dunning's return shape."""
        results = []
        for promise in self.repo.list_open(organization_id):
            old_status = promise.status.value
            updated = self.check_and_update_status(promise.id, organization_id, grace_days=grace_days)
            if updated.status.value != old_status:
                results.append({
                    "promise_id": updated.id,
                    "customer_id": updated.customer_id,
                    "from_status": old_status,
                    "to_status": updated.status.value,
                })
        return results

    # ── Reporting ────────────────────────────────────────────────────────────

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        return self.repo.get_dashboard_stats(organization_id)

    def get_success_rate(self, organization_id: int) -> Dict[str, Any]:
        return self.repo.get_success_rate(organization_id)
