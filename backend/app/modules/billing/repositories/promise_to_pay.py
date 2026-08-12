from typing import Any, Dict, List, Optional

from sqlalchemy import func

from app.modules.billing.models import PromiseToPay, PromiseToPayStatus
from app.modules.billing.repositories.base import BaseRepository

_OPEN_STATUSES = (PromiseToPayStatus.PENDING.value, PromiseToPayStatus.OVERDUE.value)
_TERMINAL_STATUSES = (
    PromiseToPayStatus.FULFILLED.value,
    PromiseToPayStatus.BROKEN.value,
    PromiseToPayStatus.CANCELLED.value,
)


class PromiseToPayRepository(BaseRepository[PromiseToPay]):
    def __init__(self, db):
        super().__init__(db, PromiseToPay)

    def list_by_customer(self, organization_id: int, customer_id: int, active_only: bool = True) -> List[PromiseToPay]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_invoice(self, organization_id: int, invoice_id: int, active_only: bool = True) -> List[PromiseToPay]:
        return self.list_all(organization_id, active_only=active_only, invoice_id=invoice_id)

    def list_by_dunning_case(self, organization_id: int, dunning_case_id: int) -> List[PromiseToPay]:
        return self.list_all(organization_id, active_only=True, dunning_case_id=dunning_case_id)

    def list_by_collections_case(self, organization_id: int, collections_case_id: int) -> List[PromiseToPay]:
        return self.list_all(organization_id, active_only=True, collections_case_id=collections_case_id)

    def get_latest_for_customer(self, organization_id: int, customer_id: int) -> Optional[PromiseToPay]:
        query = self.db.query(PromiseToPay).filter(
            PromiseToPay.organization_id == organization_id,
            PromiseToPay.customer_id == customer_id,
            PromiseToPay.is_active == True,
        ).order_by(PromiseToPay.created_at.desc())
        return query.first()

    def list_open(self, organization_id: int) -> List[PromiseToPay]:
        """Every promise not yet in a terminal state — the working set for
        the automatic status-check scheduler task."""
        query = self.db.query(PromiseToPay).filter(
            PromiseToPay.organization_id == organization_id,
            PromiseToPay.is_active == True,
            PromiseToPay.status.in_(_OPEN_STATUSES),
        )
        return query.all()

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
        invoice_id: Optional[int] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if invoice_id:
            filters["invoice_id"] = invoice_id
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "promise_date",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["notes"],
            **filters,
        )

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        base = self.db.query(PromiseToPay).filter(
            PromiseToPay.organization_id == organization_id,
            PromiseToPay.is_active == True,
        )
        total_promised = self.db.query(func.coalesce(func.sum(PromiseToPay.promise_amount), 0)).filter(
            PromiseToPay.organization_id == organization_id, PromiseToPay.is_active == True,
        ).scalar()
        return {
            "total_count": base.count(),
            "total_promised_amount": float(total_promised),
            "pending_count": base.filter(PromiseToPay.status == "pending").count(),
            "overdue_count": base.filter(PromiseToPay.status == "overdue").count(),
            "fulfilled_count": base.filter(PromiseToPay.status == "fulfilled").count(),
            "broken_count": base.filter(PromiseToPay.status == "broken").count(),
            "cancelled_count": base.filter(PromiseToPay.status == "cancelled").count(),
        }

    def get_success_rate(self, organization_id: int) -> Dict[str, Any]:
        """Fulfilled vs. broken among *resolved* promises — pending/overdue
        (still in flight) and cancelled (withdrawn, not a collection outcome)
        are excluded from the denominator."""
        fulfilled = self.db.query(func.count(PromiseToPay.id)).filter(
            PromiseToPay.organization_id == organization_id, PromiseToPay.is_active == True,
            PromiseToPay.status == "fulfilled",
        ).scalar() or 0
        broken = self.db.query(func.count(PromiseToPay.id)).filter(
            PromiseToPay.organization_id == organization_id, PromiseToPay.is_active == True,
            PromiseToPay.status == "broken",
        ).scalar() or 0
        resolved = fulfilled + broken
        success_rate = (fulfilled / resolved * 100) if resolved else 0.0
        return {
            "fulfilled_count": fulfilled,
            "broken_count": broken,
            "resolved_count": resolved,
            "success_rate_percentage": round(success_rate, 2),
        }
