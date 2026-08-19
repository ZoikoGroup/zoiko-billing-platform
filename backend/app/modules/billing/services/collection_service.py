import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    CollectionAction,
    CollectionsCase,
    CollectionsCaseStatusHistory,
    CollectionsPriority,
    CollectionsStatus,
    CommunicationEventStatus,
    CommunicationEventType,
    Invoice,
    InvoiceStatus,
)
from app.modules.billing.repositories.collection import (
    CollectionActionRepository,
    CollectionsCaseRepository,
    CollectionsCaseStatusHistoryRepository,
    DunningCaseRepository,
)
from app.modules.billing.repositories.invoice import InvoiceCommunicationRepository, InvoiceRepository
from app.modules.billing.repositories.promise_to_pay import PromiseToPayRepository
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import safe_commit_and_refresh, filter_allowed
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.utils.date_utils import days_overdue as compute_days_overdue
from app.services.email_service import send_collections_notice_email

COLLECTION_ALLOWED_FIELDS = {
    "case_number", "customer_id", "invoice_id", "total_outstanding",
    "days_overdue", "status", "assigned_to", "priority", "resolution",
    "notes", "amount_collected", "last_contact_at", "next_action_date",
}

logger = logging.getLogger("zoiko_billing")


class CollectionService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = CollectionsCaseRepository(db)
        self.action_repo = CollectionActionRepository(db)
        self.history_repo = CollectionsCaseStatusHistoryRepository(db)
        self.dunning_case_repo = DunningCaseRepository(db)
        self.promise_repo = PromiseToPayRepository(db)
        self.invoice_repo = InvoiceRepository(db)
        self.comms_repo = InvoiceCommunicationRepository(db)
        self.config_repo = BillingConfigurationRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)

    def _record_status_history(
        self, organization_id: int, case_id: int, from_status: Optional[str], to_status: str,
        changed_by: Optional[int] = None, reason: Optional[str] = None,
    ) -> CollectionsCaseStatusHistory:
        return self.history_repo.log_status_change(organization_id, case_id, from_status, to_status, changed_by, reason)

    def open_case(
        self, organization_id: int, customer_id: int,
        invoice_id: int, case_number: str, created_by: int, **data: Any,
    ) -> CollectionsCase:
        data = filter_allowed(data, COLLECTION_ALLOWED_FIELDS)
        # total_outstanding/days_overdue are always derived from the invoice
        # itself below, never taken from caller input — pre-existing pattern
        # elsewhere in this call, but COLLECTION_ALLOWED_FIELDS includes both
        # names, so leaving them in `data` collided with the explicit kwargs
        # below (self.repo.create() got multiple values for the same keyword)
        # any time a caller supplied them, which CollectionsCaseCreate's
        # schema always does since both fields are required there.
        data.pop("total_outstanding", None)
        data.pop("days_overdue", None)
        self.customer_service.get_customer(customer_id, organization_id)
        invoice = self.invoice_repo.get_by_id(invoice_id, organization_id)
        if self.repo.exists(organization_id, case_number=case_number):
            raise AlreadyExistsException("CollectionsCase", "case_number")
        case = self.repo.create(
            organization_id, customer_id=customer_id,
            invoice_id=invoice_id, case_number=case_number,
            total_outstanding=invoice.balance_due,
            days_overdue=compute_days_overdue(invoice.due_date),
            status=CollectionsStatus.OPEN,
            **data,
        )
        self._record_status_history(organization_id, case.id, None, CollectionsStatus.OPEN.value, created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "CollectionsCase", case.id)
        return case

    def update_case(self, case_id: int, organization_id: int, updated_by: int, **data: Any) -> CollectionsCase:
        data = filter_allowed(data, COLLECTION_ALLOWED_FIELDS)
        self.repo.get_by_id(case_id, organization_id)
        updated = self.repo.update(case_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CollectionsCase", case_id)
        return updated

    def get_case(self, case_id: int, organization_id: int) -> CollectionsCase:
        return self.repo.get_by_id(case_id, organization_id)

    def list_cases(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, assigned_to: Optional[int] = None,
        priority: Optional[str] = None, sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, assigned_to=assigned_to, priority=priority,
        )

    def assign_case(self, case_id: int, organization_id: int, assigned_to: int, updated_by: int) -> CollectionsCase:
        case = self.repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.assigned_to = assigned_to
        case.status = CollectionsStatus.IN_PROGRESS
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, CollectionsStatus.IN_PROGRESS.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CollectionsCase", case_id)
        return case

    def resolve_case(
        self, case_id: int, organization_id: int, resolution: str, updated_by: int,
        amount_collected: Optional[Decimal] = None,
    ) -> CollectionsCase:
        case = self.repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.status = CollectionsStatus.RESOLVED
        case.resolution = resolution
        case.resolved_at = datetime.utcnow()
        if amount_collected is not None:
            case.amount_collected = (case.amount_collected or 0) + amount_collected
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, CollectionsStatus.RESOLVED.value, updated_by, resolution)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CollectionsCase", case_id)
        return case

    def close_case(self, case_id: int, organization_id: int, updated_by: int) -> CollectionsCase:
        case = self.repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.status = CollectionsStatus.CLOSED
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, CollectionsStatus.CLOSED.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CollectionsCase", case_id)
        return case

    def escalate_case(self, case_id: int, organization_id: int, updated_by: int) -> CollectionsCase:
        case = self.repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.status = CollectionsStatus.ESCALATED
        case.priority = CollectionsPriority.URGENT
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, CollectionsStatus.ESCALATED.value, updated_by)
        self.action_repo.log_action(
            organization_id, case_id, action_type="escalate_collections",
            description="Case escalated to urgent priority", performed_by=updated_by,
        )
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CollectionsCase", case_id)
        return case

    def log_action(
        self, case_id: int, organization_id: int, action_type: str,
        description: Optional[str] = None, performed_by: Optional[int] = None,
        outcome: Optional[str] = None, follow_up_date: Optional[str] = None,
    ) -> CollectionAction:
        self.repo.get_by_id(case_id, organization_id)
        return self.action_repo.log_action(
            organization_id, case_id, action_type, description,
            performed_by, outcome, follow_up_date,
        )

    def list_communications(self, case_id: int, organization_id: int) -> List[Dict[str, Any]]:
        """All communications logged against the case's invoice."""
        case = self.repo.get_by_id(case_id, organization_id)
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
            for c in self.comms_repo.list_by_invoice_safe(organization_id, case.invoice_id)
        ]

    def send_past_due_notice(self, case_id: int, organization_id: int, updated_by: int) -> CollectionsCase:
        """Send the final collections notice email for a case's invoice and
        record it in the communication history + audit trail. The email body
        is the org's final_notice_template when configured, otherwise the
        standard collections notice layout."""
        case = self.repo.get_by_id(case_id, organization_id)
        invoice = self.invoice_repo.get_by_id(case.invoice_id, organization_id)
        config = self.config_repo.get_by_organization(organization_id)

        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(case.customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                email_delivered = send_collections_notice_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    invoice_number=invoice.invoice_number,
                    days_overdue=str(case.days_overdue or compute_days_overdue(invoice.due_date)),
                    overdue_amount=str(invoice.balance_due or 0),
                    currency=invoice.currency or "USD",
                    late_fee="0",
                    organization_id=organization_id,
                    db=self.db,
                    custom_body=getattr(config, "final_notice_template", None),
                )
        except Exception as e:
            logger.warning("Failed to send past-due notice for collections case %d: %s", case.id, e)

        comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
        self.comms_repo.record_event_safe(
            organization_id=organization_id,
            invoice_id=case.invoice_id,
            event_type=CommunicationEventType.EMAIL_SENT,
            status=comm_status,
            recipient=email_sent_to,
            subject=f"Collections Notice - Invoice {invoice.invoice_number}",
            body_preview=f"Collections notice sent to {email_sent_to}" if email_sent_to else None,
            event_metadata={
                "case_id": case.id,
                "collections_notice": True,
                "email_delivered": email_delivered,
            },
        )
        self.action_repo.log_action(
            organization_id, case.id, action_type="email_reminder",
            description=f"Past-due collections notice sent to {email_sent_to}" if email_sent_to else "Past-due collections notice send attempted",
            performed_by=updated_by,
            outcome="delivered" if email_delivered else "failed",
        )
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "CollectionsCase", case.id,
            new_values={"email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return case

    # ── Outstanding Invoices ──────────────────────────────────────────────

    def list_outstanding_invoices(self, organization_id: int) -> List[Invoice]:
        return self.invoice_repo.list_all(
            organization_id,
            status=InvoiceStatus.SENT,
            active_only=True,
        ) + self.invoice_repo.list_all(
            organization_id,
            status=InvoiceStatus.OVERDUE,
            active_only=True,
        ) + self.invoice_repo.list_all(
            organization_id,
            status=InvoiceStatus.PARTIALLY_PAID,
            active_only=True,
        )

    # ── Aging Buckets ─────────────────────────────────────────────────────

    def get_aging_buckets(self, organization_id: int, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        """AR aging buckets — computed via a single SQL aggregate in
        InvoiceRepository.get_aging_buckets() rather than loading every
        invoice into Python (see that method for why)."""
        return self.invoice_repo.get_aging_buckets(organization_id, currency_rates=currency_rates)

    # ── Collections Queue ─────────────────────────────────────────────────

    def get_collections_queue(self, organization_id: int) -> List[Dict[str, Any]]:
        overdue = self.invoice_repo.list_overdue_with_customer(organization_id)
        queue = []
        for inv in overdue:
            existing_case = self.repo.get_by_invoice_open(organization_id, inv.id)
            queue.append({
                "invoice_id": inv.id,
                "invoice_number": inv.invoice_number,
                "customer_id": inv.customer_id,
                "customer_name": inv.customer.company_name if inv.customer else None,
                "balance_due": float(inv.balance_due or 0),
                "due_date": inv.due_date,
                "days_overdue": compute_days_overdue(inv.due_date),
                "has_open_case": existing_case is not None,
                "case_id": existing_case.id if existing_case else None,
                "case_status": existing_case.status.value if existing_case else None,
            })
        return sorted(queue, key=lambda x: x["days_overdue"], reverse=True)

    # ── Status History / Timeline ────────────────────────────────────────────

    def list_status_history(self, case_id: int, organization_id: int) -> List[CollectionsCaseStatusHistory]:
        self.repo.get_by_id(case_id, organization_id)
        return self.history_repo.list_by_case(organization_id, case_id)

    def get_timeline(self, case_id: int, organization_id: int) -> List[Dict[str, Any]]:
        case = self.repo.get_by_id(case_id, organization_id)
        entries = []

        for sh in self.history_repo.list_by_case(organization_id, case_id):
            entries.append({
                "timestamp": sh.created_at,
                "event_type": "status_change",
                "title": f"Status changed to {sh.to_status}",
                "description": sh.reason,
                "actor_id": sh.changed_by,
                "metadata": {"from_status": sh.from_status, "to_status": sh.to_status, "status_history_id": sh.id},
            })

        for action in self.action_repo.list_by_case(organization_id, case_id):
            entries.append({
                "timestamp": action.performed_at,
                "event_type": action.action_type,
                "title": (action.action_type.value if hasattr(action.action_type, "value") else str(action.action_type)).replace("_", " ").title(),
                "description": action.description or action.outcome,
                "actor_id": action.performed_by,
                "metadata": {"action_id": action.id, "outcome": action.outcome, "follow_up_date": action.follow_up_date.isoformat() if action.follow_up_date else None},
            })

        for comm in self.comms_repo.list_by_invoice_safe(organization_id, case.invoice_id):
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": "Collections notice emailed" if comm.event_type == CommunicationEventType.EMAIL_SENT and (comm.event_metadata or {}).get("collections_notice") else "Reminder emailed" if comm.event_type == CommunicationEventType.REMINDER_SENT else str(comm.event_type),
                "description": comm.subject or comm.body_preview,
                "actor_id": comm.created_by,
                "metadata": {"recipient": comm.recipient, "status": comm.status, "communication_id": comm.id, **(comm.event_metadata or {})},
            })

        for promise in self.promise_repo.list_by_collections_case(organization_id, case_id):
            entries.append({
                "timestamp": promise.created_at,
                "event_type": "promise_to_pay_created",
                "title": f"Promise to pay {promise.promise_amount} by {promise.promise_date}",
                "description": promise.notes,
                "actor_id": promise.created_by,
                "metadata": {"promise_id": promise.id, "status": promise.status.value},
            })
            if promise.fulfilled_at:
                entries.append({
                    "timestamp": promise.fulfilled_at, "event_type": "promise_to_pay_fulfilled",
                    "title": "Promise to pay fulfilled", "description": None,
                    "actor_id": None, "metadata": {"promise_id": promise.id},
                })
            if promise.broken_at:
                entries.append({
                    "timestamp": promise.broken_at, "event_type": "promise_to_pay_broken",
                    "title": "Promise to pay broken", "description": None,
                    "actor_id": None, "metadata": {"promise_id": promise.id},
                })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries

    # ── Dashboard ─────────────────────────────────────────────────────────────

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        return self.repo.get_dashboard_stats(organization_id)

    def get_priority_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.repo.get_priority_distribution(organization_id)

    # ── Reports ───────────────────────────────────────────────────────────────

    def get_overdue_by_customer(self, organization_id: int, limit: int = 20) -> List[Dict[str, Any]]:
        return self.invoice_repo.get_overdue_by_customer(organization_id, limit=limit)

    def get_recovery_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        return self.repo.get_recovery_trend(organization_id, months)

    def get_collection_effectiveness(self, organization_id: int) -> Dict[str, Any]:
        """Simple, defensible effectiveness metric: of everything that has
        ever been outstanding on a collections case (still outstanding +
        already collected), what fraction was actually recovered."""
        stats = self.repo.get_dashboard_stats(organization_id)
        collected = stats["amount_collected"]
        outstanding = stats["total_outstanding"]
        denominator = collected + outstanding
        effectiveness = (collected / denominator * 100) if denominator else 0.0
        return {
            "amount_collected": collected,
            "total_outstanding": outstanding,
            "effectiveness_percentage": round(effectiveness, 2),
        }

    def get_dunning_performance(self, organization_id: int) -> Dict[str, Any]:
        """Aggregate resolution/escalation rates across all dunning cases —
        reuses DunningCaseRepository directly rather than duplicating the
        underlying query in a second repository."""
        stats = self.dunning_case_repo.get_dashboard_stats(organization_id)
        total = stats["total_count"] or 1
        return {
            **stats,
            "resolution_rate_percentage": round(stats["resolved_count"] / total * 100, 2),
            "escalation_rate_percentage": round(stats["escalated_count"] / total * 100, 2),
        }

    # ── Customer Collection Summary (Customer Dashboard) ─────────────────────

    def get_customer_collection_summary(self, organization_id: int, customer_id: int) -> Dict[str, Any]:
        self.customer_service.get_customer(customer_id, organization_id)

        overdue_invoices = [
            inv for inv in self.invoice_repo.list_all(organization_id, active_only=True, customer_id=customer_id)
            if inv.status in (InvoiceStatus.SENT, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIALLY_PAID) and inv.due_date and inv.due_date < date.today()
        ]
        total_overdue = sum((inv.balance_due or Decimal("0")) for inv in overdue_invoices)
        oldest = min(overdue_invoices, key=lambda i: i.due_date) if overdue_invoices else None

        dunning_cases = self.dunning_case_repo.list_by_customer(organization_id, customer_id)
        active_dunning = [c for c in dunning_cases if c.status.value == "active"]
        top_dunning = max(active_dunning, key=lambda c: c.current_level) if active_dunning else None

        collections_cases = self.repo.list_by_customer(organization_id, customer_id)
        open_collections = [c for c in collections_cases if c.status.value not in ("resolved", "closed")]
        top_collections = open_collections[0] if open_collections else None

        latest_promise = self.promise_repo.get_latest_for_customer(organization_id, customer_id)

        if top_collections:
            collection_stage = "collections"
        elif top_dunning:
            collection_stage = f"dunning_level_{top_dunning.current_level}"
        elif total_overdue > 0:
            collection_stage = "overdue"
        else:
            collection_stage = "current"

        return {
            "customer_id": customer_id,
            "total_overdue": float(total_overdue),
            "overdue_invoice_count": len(overdue_invoices),
            "oldest_due_date": oldest.due_date.isoformat() if oldest and oldest.due_date else None,
            "oldest_days_overdue": compute_days_overdue(oldest.due_date) if oldest else 0,
            "collection_stage": collection_stage,
            "dunning_level": top_dunning.current_level if top_dunning else None,
            "dunning_case_status": top_dunning.status.value if top_dunning else None,
            "collections_case_status": top_collections.status.value if top_collections else None,
            "promise_to_pay_status": latest_promise.status.value if latest_promise else None,
            "promise_to_pay_amount": float(latest_promise.promise_amount) if latest_promise else None,
            "promise_to_pay_date": latest_promise.promise_date.isoformat() if latest_promise else None,
        }
