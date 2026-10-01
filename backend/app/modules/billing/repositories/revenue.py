from typing import Any, Dict, List, Optional

from sqlalchemy import func

from app.modules.billing.models import (
    Invoice,
    RevenueRecognitionEntry,
    RevenueRecognitionSchedule,
)
from app.modules.billing.repositories.base import BaseRepository


class RevenueRecognitionScheduleRepository(BaseRepository[RevenueRecognitionSchedule]):
    def __init__(self, db):
        super().__init__(db, RevenueRecognitionSchedule)

    def list_by_invoice(
        self,
        organization_id: int,
        invoice_id: int,
        active_only: bool = True,
    ) -> List[RevenueRecognitionSchedule]:
        return self.list_all(organization_id, active_only=active_only, invoice_id=invoice_id)

    def list_by_subscription(
        self,
        organization_id: int,
        subscription_id: int,
        active_only: bool = True,
    ) -> List[RevenueRecognitionSchedule]:
        return self.list_all(organization_id, active_only=active_only, subscription_id=subscription_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[RevenueRecognitionSchedule]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_pending(self, organization_id: int) -> List[RevenueRecognitionSchedule]:
        return self.list_all(organization_id, active_only=True, status="pending")

    def get_total_deferred_by_currency(self, organization_id: int) -> List[Dict[str, Any]]:
        """Deferred revenue summed per currency -- a schedule's currency is
        whatever its linked invoice was issued in, which varies by customer/
        contract, so a single cross-currency SUM() would silently add e.g.
        INR and USD amounts together into one meaningless number. Never
        fabricates a single blended total."""
        rows = self.db.query(
            Invoice.currency,
            func.coalesce(func.sum(RevenueRecognitionSchedule.deferred_amount), 0),
        ).join(
            Invoice, Invoice.id == RevenueRecognitionSchedule.invoice_id,
        ).filter(
            RevenueRecognitionSchedule.organization_id == organization_id,
            RevenueRecognitionSchedule.is_active == True,
        ).group_by(Invoice.currency).all()
        return [{"currency": currency, "total_deferred": float(total)} for currency, total in rows]

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        status: Optional[str] = None,
        recognition_method: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if status:
            filters["status"] = status
        if recognition_method:
            filters["recognition_method"] = recognition_method
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or [],
            **filters,
        )


class RevenueRecognitionEntryRepository(BaseRepository[RevenueRecognitionEntry]):
    def __init__(self, db):
        super().__init__(db, RevenueRecognitionEntry)

    def list_by_schedule(
        self,
        organization_id: int,
        schedule_id: int,
    ) -> List[RevenueRecognitionEntry]:
        query = self.db.query(RevenueRecognitionEntry).filter(
            RevenueRecognitionEntry.schedule_id == schedule_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(RevenueRecognitionEntry.entry_date).all()

    def list_unreleased(self, organization_id: int, schedule_id: int) -> List[RevenueRecognitionEntry]:
        query = self.db.query(RevenueRecognitionEntry).filter(
            RevenueRecognitionEntry.schedule_id == schedule_id,
            RevenueRecognitionEntry.is_released == False,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(RevenueRecognitionEntry.entry_date).all()

    def get_total_released(self, organization_id: int, schedule_id: int) -> float:
        query = self.db.query(
            func.coalesce(func.sum(RevenueRecognitionEntry.amount), 0)
        ).filter(
            RevenueRecognitionEntry.schedule_id == schedule_id,
            RevenueRecognitionEntry.is_released == True,
        )
        query = self._org_filter(query, organization_id)
        result = query.scalar()
        return float(result)
