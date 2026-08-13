import logging
from typing import Any, Dict, List, Optional
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError

from app.modules.billing.models import (
    CreditNote,
    CreditNoteApplication,
    CreditNoteCommunication,
    CreditNoteStatus,
    CreditNoteStatusHistory,
    Refund,
    RefundCommunication,
    RefundStatusHistory,
)
from app.modules.billing.repositories.base import BaseRepository

logger = logging.getLogger("zoiko")


class CreditNoteRepository(BaseRepository[CreditNote]):
    def __init__(self, db):
        super().__init__(db, CreditNote)

    def get_by_number(self, organization_id: int, number: str) -> Optional[CreditNote]:
        return self.get_first(organization_id, credit_note_number=number)

    def get_by_id_for_update(self, id: int, organization_id: int) -> CreditNote:
        """Row-level lock for preventing concurrent over-refund of a credit note.
        Falls back to plain read on SQLite (local dev) where FOR UPDATE is unsupported."""
        query = self.db.query(CreditNote).filter(CreditNote.id == id)
        try:
            query = query.with_for_update(nowait=False)
        except NotImplementedError:
            pass  # SQLite does not support row-level locking
        query = self._org_filter(query, organization_id)
        obj = query.first()
        if not obj:
            from app.core.exceptions import NotFoundException
            raise NotFoundException("CreditNote", id)
        return obj

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[CreditNote]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_invoice(
        self,
        organization_id: int,
        invoice_id: int,
        active_only: bool = True,
    ) -> List[CreditNote]:
        return self.list_all(organization_id, active_only=active_only, invoice_id=invoice_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[CreditNote]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def bulk_delete(self, ids: List[int], organization_id: int) -> int:
        """Hard-delete credit notes in one atomic operation. Only draft or
        voided credit notes may be deleted — draft notes have no financial
        impact and voided notes are already inert. Resolve the requested ids
        within this organization first (silently excludes ids that don't
        exist or belong to another org) and validate status BEFORE any
        mutation; if any selected note is not deletable, the whole batch is
        rejected so a bulk operation never deletes some notes while
        discovering a protected one partway through."""
        from app.core.exceptions import BadRequestException

        notes = self.get_by_ids(ids, organization_id)
        protected = [
            cn for cn in notes
            if cn.status not in (CreditNoteStatus.DRAFT, CreditNoteStatus.VOIDED)
        ]
        if protected:
            raise BadRequestException("Only draft or voided credit notes can be deleted.")

        query = self.db.query(CreditNote).filter(
            CreditNote.id.in_(ids),
            CreditNote.organization_id == organization_id,
        )
        deleted = query.delete(synchronize_session="fetch")
        self.db.commit()
        return deleted

    def get_outstanding_total(self, organization_id: int) -> float:
        result = self.db.query(
            func.coalesce(func.sum(CreditNote.remaining_amount), 0)
        ).filter(
            CreditNote.organization_id == organization_id,
            CreditNote.is_active == True,
            CreditNote.status.in_(["issued", "partially_applied"]),
        ).scalar()
        return float(result)

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
        credit_note_type: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if credit_note_type:
            filters["credit_note_type"] = credit_note_type
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["credit_note_number", "reason"],
            **filters,
        )


    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(CreditNote.status, func.count(CreditNote.id), func.coalesce(func.sum(CreditNote.total_amount), 0))
            .filter(CreditNote.organization_id == organization_id, CreditNote.is_active == True)
            .group_by(CreditNote.status)
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
            self.db.query(CreditNote.credit_note_type, func.count(CreditNote.id), func.coalesce(func.sum(CreditNote.total_amount), 0))
            .filter(CreditNote.organization_id == organization_id, CreditNote.is_active == True)
            .group_by(CreditNote.credit_note_type)
            .all()
        )
        return [
            {
                "credit_note_type": t.value if hasattr(t, "value") else str(t),
                "count": count,
                "total_amount": float(total),
            }
            for t, count, total in rows
        ]

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        base = self.db.query(CreditNote).filter(
            CreditNote.organization_id == organization_id,
            CreditNote.is_active == True,
        )
        total_count = base.count()
        total_value = self.db.query(func.coalesce(func.sum(CreditNote.total_amount), 0)).filter(
            CreditNote.organization_id == organization_id, CreditNote.is_active == True,
        ).scalar()
        outstanding = self.get_outstanding_total(organization_id)
        draft_count = base.filter(CreditNote.status == "draft").count()
        issued_count = base.filter(CreditNote.status.in_(["issued", "partially_applied"])).count()
        applied_count = base.filter(CreditNote.status == "fully_applied").count()
        voided_count = base.filter(CreditNote.status == "voided").count()
        return {
            "total_count": total_count,
            "total_value": float(total_value),
            "outstanding_credits": outstanding,
            "draft_count": draft_count,
            "issued_count": issued_count,
            "fully_applied_count": applied_count,
            "voided_count": voided_count,
        }

    def get_monthly_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(
                func.date_trunc("month", CreditNote.issue_date).label("month"),
                func.count(CreditNote.id),
                func.coalesce(func.sum(CreditNote.total_amount), 0),
            )
            .filter(CreditNote.organization_id == organization_id, CreditNote.is_active == True)
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


class CreditNoteApplicationRepository(BaseRepository[CreditNoteApplication]):
    def __init__(self, db):
        super().__init__(db, CreditNoteApplication)

    def list_by_credit_note(self, organization_id: int, credit_note_id: int) -> List[CreditNoteApplication]:
        query = self.db.query(CreditNoteApplication).filter(
            CreditNoteApplication.credit_note_id == credit_note_id,
        )
        query = self._org_filter(query, organization_id)
        return query.all()

    def list_by_invoice(self, organization_id: int, invoice_id: int) -> List[CreditNoteApplication]:
        query = self.db.query(CreditNoteApplication).filter(
            CreditNoteApplication.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        return query.all()

    def get_total_applied(self, organization_id: int, credit_note_id: int) -> float:
        query = self.db.query(
            func.coalesce(func.sum(CreditNoteApplication.amount), 0)
        ).filter(
            CreditNoteApplication.credit_note_id == credit_note_id,
        )
        query = self._org_filter(query, organization_id)
        result = query.scalar()
        return float(result)


class RefundRepository(BaseRepository[Refund]):
    def __init__(self, db):
        super().__init__(db, Refund)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Refund]:
        return self.get_first(organization_id, refund_number=number)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Refund]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[Refund]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def get_by_payment(
        self,
        organization_id: int,
        payment_id: int,
    ) -> Optional[Refund]:
        return self.get_first(organization_id, payment_id=payment_id)

    def _get_total_refunded(self, organization_id: int, field: str, entity_id: int) -> Decimal:
        """Sum of refunds that have actually moved money against the given
        source entity (completed + processing). Used to decide when a
        payment/invoice/credit note has been made financially whole again
        (e.g. flipping Payment.status to REFUNDED) — failed/rejected/
        cancelled/draft/pending-approval refunds do NOT count here since
        they haven't moved money yet."""
        from sqlalchemy import and_
        from app.modules.billing.models import RefundStatus
        result = self.db.query(
            func.coalesce(func.sum(Refund.amount), 0)
        ).filter(
            and_(
                Refund.organization_id == organization_id,
                getattr(Refund, field) == entity_id,
                Refund.is_active == True,
                Refund.status.in_([
                    RefundStatus.COMPLETED,
                    RefundStatus.PROCESSING,
                ]),
            )
        ).scalar()
        return Decimal(str(result))

    def _get_total_reserved(self, organization_id: int, field: str, entity_id: int) -> Decimal:
        """Sum of refunds still capable of moving money against the given
        source entity — i.e. every refund that hasn't reached a terminal
        negative state (failed/rejected/cancelled). Used at refund-creation
        time so a refund amount can never be accepted if it would push the
        entity's *total committed* refunds (draft, pending approval,
        approved, processing, or already completed) past what's refundable —
        this is stricter than `_get_total_refunded`, which only tracks money
        that has already moved, because two draft refunds against the same
        payment must not both be allowed to reserve overlapping amounts."""
        from sqlalchemy import and_
        from app.modules.billing.models import RefundStatus
        result = self.db.query(
            func.coalesce(func.sum(Refund.amount), 0)
        ).filter(
            and_(
                Refund.organization_id == organization_id,
                getattr(Refund, field) == entity_id,
                Refund.is_active == True,
                ~Refund.status.in_([
                    RefundStatus.FAILED,
                    RefundStatus.REJECTED,
                    RefundStatus.CANCELLED,
                ]),
            )
        ).scalar()
        return Decimal(str(result))

    def get_total_refunded_for_payment(
        self, organization_id: int, payment_id: int,
    ) -> Decimal:
        return self._get_total_refunded(organization_id, "payment_id", payment_id)

    def get_total_refunded_for_invoice(
        self, organization_id: int, invoice_id: int,
    ) -> Decimal:
        return self._get_total_refunded(organization_id, "invoice_id", invoice_id)

    def get_total_refunded_for_credit_note(
        self, organization_id: int, credit_note_id: int,
    ) -> Decimal:
        return self._get_total_refunded(organization_id, "credit_note_id", credit_note_id)

    def get_total_reserved_for_payment(
        self, organization_id: int, payment_id: int,
    ) -> Decimal:
        return self._get_total_reserved(organization_id, "payment_id", payment_id)

    def get_total_reserved_for_invoice(
        self, organization_id: int, invoice_id: int,
    ) -> Decimal:
        return self._get_total_reserved(organization_id, "invoice_id", invoice_id)

    def get_total_reserved_for_credit_note(
        self, organization_id: int, credit_note_id: int,
    ) -> Decimal:
        return self._get_total_reserved(organization_id, "credit_note_id", credit_note_id)

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
        refund_type: Optional[str] = None,
        refund_source: Optional[str] = None,
        refund_method: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if refund_type:
            filters["refund_type"] = refund_type
        if refund_source:
            filters["refund_source"] = refund_source
        if refund_method:
            filters["refund_method"] = refund_method
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["refund_number", "reason"],
            **filters,
        )

    def get_outstanding_total(self, organization_id: int) -> float:
        """Sum of refunds not yet resolved (in flight — awaiting approval/processing)."""
        result = self.db.query(
            func.coalesce(func.sum(Refund.amount), 0)
        ).filter(
            Refund.organization_id == organization_id,
            Refund.is_active == True,
            Refund.status.in_(["draft", "pending_approval", "approved", "processing", "pending"]),
        ).scalar()
        return float(result)

    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(Refund.status, func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0))
            .filter(Refund.organization_id == organization_id, Refund.is_active == True)
            .group_by(Refund.status)
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
            self.db.query(Refund.refund_type, func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0))
            .filter(Refund.organization_id == organization_id, Refund.is_active == True)
            .group_by(Refund.refund_type)
            .all()
        )
        return [
            {
                "refund_type": t.value if hasattr(t, "value") else str(t),
                "count": count,
                "total_amount": float(total),
            }
            for t, count, total in rows
        ]

    def get_method_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(Refund.refund_method, func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0))
            .filter(Refund.organization_id == organization_id, Refund.is_active == True)
            .group_by(Refund.refund_method)
            .all()
        )
        return [
            {
                "refund_method": (m.value if hasattr(m, "value") else str(m)) if m is not None else "unspecified",
                "count": count,
                "total_amount": float(total),
            }
            for m, count, total in rows
        ]

    def get_source_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(Refund.refund_source, func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0))
            .filter(Refund.organization_id == organization_id, Refund.is_active == True)
            .group_by(Refund.refund_source)
            .all()
        )
        return [
            {
                "refund_source": s.value if hasattr(s, "value") else str(s),
                "count": count,
                "total_amount": float(total),
            }
            for s, count, total in rows
        ]

    def get_reason_distribution(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(Refund.reason, func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0))
            .filter(Refund.organization_id == organization_id, Refund.is_active == True, Refund.reason.isnot(None))
            .group_by(Refund.reason)
            .order_by(func.count(Refund.id).desc())
            .limit(limit)
            .all()
        )
        return [
            {"reason": reason, "count": count, "total_amount": float(total)}
            for reason, count, total in rows
        ]

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        base = self.db.query(Refund).filter(
            Refund.organization_id == organization_id,
            Refund.is_active == True,
        )
        total_count = base.count()
        total_value = self.db.query(func.coalesce(func.sum(Refund.amount), 0)).filter(
            Refund.organization_id == organization_id, Refund.is_active == True,
        ).scalar()
        completed_value = self.db.query(func.coalesce(func.sum(Refund.amount), 0)).filter(
            Refund.organization_id == organization_id, Refund.is_active == True,
            Refund.status == "completed",
        ).scalar()
        pending_approval_count = base.filter(Refund.status == "pending_approval").count()
        approved_count = base.filter(Refund.status == "approved").count()
        processing_count = base.filter(Refund.status == "processing").count()
        completed_count = base.filter(Refund.status == "completed").count()
        failed_count = base.filter(Refund.status == "failed").count()
        cancelled_count = base.filter(Refund.status.in_(["cancelled", "rejected"])).count()
        return {
            "total_count": total_count,
            "total_value": float(total_value),
            "completed_value": float(completed_value),
            "outstanding_value": self.get_outstanding_total(organization_id),
            "pending_approval_count": pending_approval_count,
            "approved_count": approved_count,
            "processing_count": processing_count,
            "completed_count": completed_count,
            "failed_count": failed_count,
            "cancelled_count": cancelled_count,
        }

    def get_monthly_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(
                func.date_trunc("month", Refund.created_at).label("month"),
                func.count(Refund.id),
                func.coalesce(func.sum(Refund.amount), 0),
            )
            .filter(Refund.organization_id == organization_id, Refund.is_active == True)
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


class CreditNoteStatusHistoryRepository(BaseRepository[CreditNoteStatusHistory]):
    def __init__(self, db):
        super().__init__(db, CreditNoteStatusHistory)

    def list_by_credit_note(self, organization_id: int, credit_note_id: int) -> List[CreditNoteStatusHistory]:
        query = self.db.query(CreditNoteStatusHistory).filter(
            CreditNoteStatusHistory.credit_note_id == credit_note_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(CreditNoteStatusHistory.created_at.desc()).all()

    def log_status_change(
        self,
        organization_id: int,
        credit_note_id: int,
        from_status: Optional[str],
        to_status: str,
        changed_by: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> CreditNoteStatusHistory:
        entry = CreditNoteStatusHistory(
            organization_id=organization_id,
            credit_note_id=credit_note_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry


class CreditNoteCommunicationRepository(BaseRepository[CreditNoteCommunication]):
    def __init__(self, db):
        super().__init__(db, CreditNoteCommunication)

    def list_by_credit_note(self, organization_id: int, credit_note_id: int) -> List[CreditNoteCommunication]:
        query = self.db.query(CreditNoteCommunication).filter(
            CreditNoteCommunication.credit_note_id == credit_note_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(CreditNoteCommunication.created_at.desc()).all()

    def record_event(
        self,
        organization_id: int,
        credit_note_id: int,
        event_type: str,
        status: str = "sent",
        recipient: Optional[str] = None,
        subject: Optional[str] = None,
        body_preview: Optional[str] = None,
        event_metadata: Optional[Dict[str, Any]] = None,
        created_by: Optional[int] = None,
    ) -> CreditNoteCommunication:
        entry = CreditNoteCommunication(
            organization_id=organization_id,
            credit_note_id=credit_note_id,
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

    def list_by_credit_note_safe(self, organization_id: int, credit_note_id: int) -> List[CreditNoteCommunication]:
        """Best-effort read — communication history must never break credit
        note/timeline rendering if it can't be loaded."""
        try:
            return self.list_by_credit_note(organization_id, credit_note_id)
        except SQLAlchemyError as e:
            logger.warning("Could not load communication history for credit note %d: %s", credit_note_id, e)
            self.db.rollback()
            return []

    def record_event_safe(self, *args: Any, **kwargs: Any) -> Optional[CreditNoteCommunication]:
        """Best-effort write — logging a communication event must never fail
        the operation (e.g. sending an email) that triggered it."""
        try:
            return self.record_event(*args, **kwargs)
        except SQLAlchemyError as e:
            credit_note_id = kwargs.get("credit_note_id", args[1] if len(args) > 1 else None)
            logger.warning("Could not record communication event for credit note %s: %s", credit_note_id, e)
            self.db.rollback()
            return None


class RefundStatusHistoryRepository(BaseRepository[RefundStatusHistory]):
    def __init__(self, db):
        super().__init__(db, RefundStatusHistory)

    def list_by_refund(self, organization_id: int, refund_id: int) -> List[RefundStatusHistory]:
        query = self.db.query(RefundStatusHistory).filter(
            RefundStatusHistory.refund_id == refund_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(RefundStatusHistory.created_at.desc()).all()

    def log_status_change(
        self,
        organization_id: int,
        refund_id: int,
        from_status: Optional[str],
        to_status: str,
        changed_by: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> RefundStatusHistory:
        entry = RefundStatusHistory(
            organization_id=organization_id,
            refund_id=refund_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry


class RefundCommunicationRepository(BaseRepository[RefundCommunication]):
    def __init__(self, db):
        super().__init__(db, RefundCommunication)

    def list_by_refund(self, organization_id: int, refund_id: int) -> List[RefundCommunication]:
        query = self.db.query(RefundCommunication).filter(
            RefundCommunication.refund_id == refund_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(RefundCommunication.created_at.desc()).all()

    def record_event(
        self,
        organization_id: int,
        refund_id: int,
        event_type: str,
        status: str = "sent",
        recipient: Optional[str] = None,
        subject: Optional[str] = None,
        body_preview: Optional[str] = None,
        event_metadata: Optional[Dict[str, Any]] = None,
        created_by: Optional[int] = None,
    ) -> RefundCommunication:
        entry = RefundCommunication(
            organization_id=organization_id,
            refund_id=refund_id,
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

    def list_by_refund_safe(self, organization_id: int, refund_id: int) -> List[RefundCommunication]:
        """Best-effort read — communication history must never break refund/
        timeline rendering if it can't be loaded."""
        try:
            return self.list_by_refund(organization_id, refund_id)
        except SQLAlchemyError as e:
            logger.warning("Could not load communication history for refund %d: %s", refund_id, e)
            self.db.rollback()
            return []

    def record_event_safe(self, *args: Any, **kwargs: Any) -> Optional[RefundCommunication]:
        """Best-effort write — logging a communication event must never fail
        the operation (e.g. sending an email) that triggered it."""
        try:
            return self.record_event(*args, **kwargs)
        except SQLAlchemyError as e:
            refund_id = kwargs.get("refund_id", args[1] if len(args) > 1 else None)
            logger.warning("Could not record communication event for refund %s: %s", refund_id, e)
            self.db.rollback()
            return None
