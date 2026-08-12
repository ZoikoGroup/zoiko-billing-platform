import logging
from typing import Any, Dict, List, Optional
from decimal import Decimal

from sqlalchemy import and_, func
from sqlalchemy.exc import SQLAlchemyError

from app.modules.billing.models import (
    WriteOff,
    WriteOffCommunication,
    WriteOffSource,
    WriteOffStatus,
    WriteOffStatusHistory,
)
from app.modules.billing.repositories.base import BaseRepository

logger = logging.getLogger("zoiko")

# In-flight, not-yet-executed write-offs — used wherever an *independent*
# persisted field (Invoice.balance_due) already reflects an EXECUTED
# write-off, so counting it again here would double-subtract it.
_IN_FLIGHT_STATUSES = (
    WriteOffStatus.DRAFT,
    WriteOffStatus.PENDING_APPROVAL,
    WriteOffStatus.APPROVED,
)
# Every write-off still capable of counting against a balance that has no
# other persisted representation of an executed amount (e.g. a customer's
# outstanding_balance for CUSTOMER_OUTSTANDING_BALANCE/RECEIVABLE sources,
# which execution deliberately never mutates — see WriteOffService.execute_write_off).
_COMMITTED_STATUSES = _IN_FLIGHT_STATUSES + (WriteOffStatus.EXECUTED,)


class WriteOffRepository(BaseRepository[WriteOff]):
    def __init__(self, db):
        super().__init__(db, WriteOff)

    def _sum_amount_where(self, organization_id: int, statuses, *extra_filters: Any) -> Decimal:
        """Shared guard-total primitive: sum WriteOff.amount for active rows
        in this org matching the given status set and any extra filters.
        Both the per-invoice and per-customer-balance ceilings are expressed
        as calls into this one query shape — the only thing that differs
        between them is which statuses count and which extra scope filter
        applies, not the guard logic itself."""
        result = self.db.query(
            func.coalesce(func.sum(WriteOff.amount), 0)
        ).filter(
            and_(
                WriteOff.organization_id == organization_id,
                WriteOff.is_active == True,
                WriteOff.status.in_(statuses),
                *extra_filters,
            )
        ).scalar()
        return Decimal(str(result))

    def get_by_number(self, organization_id: int, number: str) -> Optional[WriteOff]:
        return self.get_first(organization_id, write_off_number=number)

    def get_by_id_for_update(self, id: int, organization_id: int) -> WriteOff:
        """Row-level lock for preventing concurrent over-write-off of the same
        invoice. Falls back to a plain read on SQLite (local dev) where FOR
        UPDATE is unsupported."""
        query = self.db.query(WriteOff).filter(WriteOff.id == id)
        try:
            query = query.with_for_update(nowait=False)
        except NotImplementedError:
            pass  # SQLite does not support row-level locking
        query = self._org_filter(query, organization_id)
        obj = query.first()
        if not obj:
            from app.core.exceptions import NotFoundException
            raise NotFoundException("WriteOff", id)
        return obj

    def list_by_customer(
        self, organization_id: int, customer_id: int, active_only: bool = True,
    ) -> List[WriteOff]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_invoice(
        self, organization_id: int, invoice_id: int, active_only: bool = True,
    ) -> List[WriteOff]:
        return self.list_all(organization_id, active_only=active_only, invoice_id=invoice_id)

    def list_by_status(
        self, organization_id: int, status: str, active_only: bool = True,
    ) -> List[WriteOff]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def get_total_reserved_for_invoice(self, organization_id: int, invoice_id: int) -> Decimal:
        """Sum of write-offs still *in flight* (not yet executed, not yet
        terminated) against this invoice — draft, pending approval, or
        approved. Used at write-off-creation and write-off-execution time so
        concurrent/sequential write-offs against the same invoice can't
        jointly reserve amounts that together exceed the invoice's
        outstanding balance.

        Deliberately excludes EXECUTED write-offs: unlike a customer's
        outstanding_balance (see get_total_committed_for_customer_balance
        below), Invoice.balance_due is itself mutated the moment a write-off
        executes (see InvoiceService.record_write_off). Counting executed
        write-offs here as well as via the already-reduced balance_due would
        double-subtract them."""
        return self._sum_amount_where(
            organization_id, _IN_FLIGHT_STATUSES, WriteOff.invoice_id == invoice_id,
        )

    def get_total_committed_for_customer_balance(self, organization_id: int, customer_id: int) -> Decimal:
        """Sum of write-offs — draft, pending approval, approved, *or
        executed* — sourced from this customer's outstanding_balance or
        receivable position (the two non-invoice, balance-bearing sources).
        Used at write-off-creation and write-off-execution time so no
        combination of in-flight and already-executed write-offs can jointly
        exceed the customer's outstanding balance.

        Unlike get_total_reserved_for_invoice, this deliberately *includes*
        EXECUTED write-offs: executing a CUSTOMER_OUTSTANDING_BALANCE/
        RECEIVABLE write-off never mutates BillingCustomer.outstanding_balance
        (that field is a derived rollup of live invoice balances, recomputed
        by CustomerService.sync_outstanding_balance on unrelated operations —
        see WriteOffService.execute_write_off) — so the write-off row itself
        is the *only* persisted record of the amount having been committed.
        REVERSED/CANCELLED write-offs are excluded, freeing their amount back
        up automatically once reversed/cancelled."""
        return self._sum_amount_where(
            organization_id,
            _COMMITTED_STATUSES,
            WriteOff.customer_id == customer_id,
            WriteOff.write_off_source.in_([
                WriteOffSource.CUSTOMER_OUTSTANDING_BALANCE,
                WriteOffSource.RECEIVABLE,
            ]),
        )

    def get_total_executed_for_invoice(self, organization_id: int, invoice_id: int) -> Decimal:
        """Sum of write-offs that have actually reduced the invoice's balance
        (executed, and not yet reversed)."""
        result = self.db.query(
            func.coalesce(func.sum(WriteOff.amount), 0)
        ).filter(
            and_(
                WriteOff.organization_id == organization_id,
                WriteOff.invoice_id == invoice_id,
                WriteOff.is_active == True,
                WriteOff.status == WriteOffStatus.EXECUTED,
            )
        ).scalar()
        return Decimal(str(result))

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        status: Optional[str] = None,
        write_off_type: Optional[str] = None,
        adjustment_type: Optional[str] = None,
        write_off_source: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if write_off_type:
            filters["write_off_type"] = write_off_type
        if adjustment_type:
            filters["adjustment_type"] = adjustment_type
        if write_off_source:
            filters["write_off_source"] = write_off_source
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["write_off_number", "reason"],
            **filters,
        )

    def get_outstanding_total(self, organization_id: int) -> float:
        """Sum of write-offs not yet resolved (in flight — awaiting approval/execution)."""
        result = self.db.query(
            func.coalesce(func.sum(WriteOff.amount), 0)
        ).filter(
            WriteOff.organization_id == organization_id,
            WriteOff.is_active == True,
            WriteOff.status.in_(["draft", "pending_approval", "approved"]),
        ).scalar()
        return float(result)

    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(WriteOff.status, func.count(WriteOff.id), func.coalesce(func.sum(WriteOff.amount), 0))
            .filter(WriteOff.organization_id == organization_id, WriteOff.is_active == True)
            .group_by(WriteOff.status)
            .all()
        )
        return [
            {
                "status": status.value if hasattr(status, "value") else str(status),
                "count": count,
                "total_amount": float(total),
            }
            for status, count, total in rows
        ]

    def get_type_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(WriteOff.write_off_type, func.count(WriteOff.id), func.coalesce(func.sum(WriteOff.amount), 0))
            .filter(WriteOff.organization_id == organization_id, WriteOff.is_active == True)
            .group_by(WriteOff.write_off_type)
            .all()
        )
        return [
            {
                "write_off_type": t.value if hasattr(t, "value") else str(t),
                "count": count,
                "total_amount": float(total),
            }
            for t, count, total in rows
        ]

    def get_adjustment_type_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(WriteOff.adjustment_type, func.count(WriteOff.id), func.coalesce(func.sum(WriteOff.amount), 0))
            .filter(
                WriteOff.organization_id == organization_id, WriteOff.is_active == True,
                WriteOff.adjustment_type.isnot(None),
            )
            .group_by(WriteOff.adjustment_type)
            .all()
        )
        return [
            {
                "adjustment_type": t.value if hasattr(t, "value") else str(t),
                "count": count,
                "total_amount": float(total),
            }
            for t, count, total in rows
        ]

    def get_source_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(WriteOff.write_off_source, func.count(WriteOff.id), func.coalesce(func.sum(WriteOff.amount), 0))
            .filter(WriteOff.organization_id == organization_id, WriteOff.is_active == True)
            .group_by(WriteOff.write_off_source)
            .all()
        )
        return [
            {
                "write_off_source": s.value if hasattr(s, "value") else str(s),
                "count": count,
                "total_amount": float(total),
            }
            for s, count, total in rows
        ]

    def get_reason_distribution(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(WriteOff.reason, func.count(WriteOff.id), func.coalesce(func.sum(WriteOff.amount), 0))
            .filter(WriteOff.organization_id == organization_id, WriteOff.is_active == True, WriteOff.reason.isnot(None))
            .group_by(WriteOff.reason)
            .order_by(func.count(WriteOff.id).desc())
            .limit(limit)
            .all()
        )
        return [
            {"reason": reason, "count": count, "total_amount": float(total)}
            for reason, count, total in rows
        ]

    def get_customer_distribution(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(WriteOff.customer_id, func.count(WriteOff.id), func.coalesce(func.sum(WriteOff.amount), 0))
            .filter(WriteOff.organization_id == organization_id, WriteOff.is_active == True)
            .group_by(WriteOff.customer_id)
            .order_by(func.coalesce(func.sum(WriteOff.amount), 0).desc())
            .limit(limit)
            .all()
        )
        return [
            {"customer_id": customer_id, "count": count, "total_amount": float(total)}
            for customer_id, count, total in rows
        ]

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        base = self.db.query(WriteOff).filter(
            WriteOff.organization_id == organization_id,
            WriteOff.is_active == True,
        )
        total_count = base.count()
        total_value = self.db.query(func.coalesce(func.sum(WriteOff.amount), 0)).filter(
            WriteOff.organization_id == organization_id, WriteOff.is_active == True,
        ).scalar()
        executed_value = self.db.query(func.coalesce(func.sum(WriteOff.amount), 0)).filter(
            WriteOff.organization_id == organization_id, WriteOff.is_active == True,
            WriteOff.status == "executed",
        ).scalar()
        reversed_value = self.db.query(func.coalesce(func.sum(WriteOff.amount), 0)).filter(
            WriteOff.organization_id == organization_id, WriteOff.is_active == True,
            WriteOff.status == "reversed",
        ).scalar()
        draft_count = base.filter(WriteOff.status == "draft").count()
        pending_approval_count = base.filter(WriteOff.status == "pending_approval").count()
        approved_count = base.filter(WriteOff.status == "approved").count()
        executed_count = base.filter(WriteOff.status == "executed").count()
        reversed_count = base.filter(WriteOff.status == "reversed").count()
        cancelled_count = base.filter(WriteOff.status == "cancelled").count()
        return {
            "total_count": total_count,
            "total_value": float(total_value),
            "executed_value": float(executed_value),
            "reversed_value": float(reversed_value),
            "outstanding_value": self.get_outstanding_total(organization_id),
            "draft_count": draft_count,
            "pending_approval_count": pending_approval_count,
            "approved_count": approved_count,
            "executed_count": executed_count,
            "reversed_count": reversed_count,
            "cancelled_count": cancelled_count,
        }

    def get_monthly_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(
                func.date_trunc("month", WriteOff.created_at).label("month"),
                func.count(WriteOff.id),
                func.coalesce(func.sum(WriteOff.amount), 0),
            )
            .filter(WriteOff.organization_id == organization_id, WriteOff.is_active == True)
            .group_by("month")
            .order_by("month")
            .all()
        )
        return [
            {
                "month": month.strftime("%Y-%m") if month else None,
                "count": count,
                "total_amount": float(total),
            }
            for month, count, total in rows[-months:]
        ]


class WriteOffStatusHistoryRepository(BaseRepository[WriteOffStatusHistory]):
    def __init__(self, db):
        super().__init__(db, WriteOffStatusHistory)

    def list_by_write_off(self, organization_id: int, write_off_id: int) -> List[WriteOffStatusHistory]:
        query = self.db.query(WriteOffStatusHistory).filter(
            WriteOffStatusHistory.write_off_id == write_off_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(WriteOffStatusHistory.created_at.desc()).all()

    def log_status_change(
        self,
        organization_id: int,
        write_off_id: int,
        from_status: Optional[str],
        to_status: str,
        changed_by: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> WriteOffStatusHistory:
        entry = WriteOffStatusHistory(
            organization_id=organization_id,
            write_off_id=write_off_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry


class WriteOffCommunicationRepository(BaseRepository[WriteOffCommunication]):
    def __init__(self, db):
        super().__init__(db, WriteOffCommunication)

    def list_by_write_off(self, organization_id: int, write_off_id: int) -> List[WriteOffCommunication]:
        query = self.db.query(WriteOffCommunication).filter(
            WriteOffCommunication.write_off_id == write_off_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(WriteOffCommunication.created_at.desc()).all()

    def record_event(
        self,
        organization_id: int,
        write_off_id: int,
        event_type: str,
        status: str = "sent",
        recipient: Optional[str] = None,
        subject: Optional[str] = None,
        body_preview: Optional[str] = None,
        event_metadata: Optional[Dict[str, Any]] = None,
        created_by: Optional[int] = None,
    ) -> WriteOffCommunication:
        entry = WriteOffCommunication(
            organization_id=organization_id,
            write_off_id=write_off_id,
            event_type=event_type,
            status=status,
            recipient=recipient,
            subject=subject,
            body_preview=body_preview,
            event_metadata=event_metadata,
            created_by=created_by,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def list_by_write_off_safe(self, organization_id: int, write_off_id: int) -> List[WriteOffCommunication]:
        """Best-effort read — communication history must never break write-off/
        timeline rendering if it can't be loaded."""
        try:
            return self.list_by_write_off(organization_id, write_off_id)
        except SQLAlchemyError as e:
            logger.warning("Could not load communication history for write-off %d: %s", write_off_id, e)
            self.db.rollback()
            return []

    def record_event_safe(self, *args: Any, **kwargs: Any) -> Optional[WriteOffCommunication]:
        """Best-effort write — logging a communication event must never fail
        the operation (e.g. sending an email) that triggered it."""
        try:
            return self.record_event(*args, **kwargs)
        except SQLAlchemyError as e:
            write_off_id = kwargs.get("write_off_id", args[1] if len(args) > 1 else None)
            logger.warning("Could not record communication event for write-off %s: %s", write_off_id, e)
            self.db.rollback()
            return None
