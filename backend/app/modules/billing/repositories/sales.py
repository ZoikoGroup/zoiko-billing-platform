from datetime import date
from typing import Any, Dict, List, Optional

from sqlalchemy import case, func

from app.modules.billing.models import (
    Contract,
    Quotation,
    QuotationItem,
)
from app.modules.billing.repositories.base import BaseRepository


class QuotationRepository(BaseRepository[Quotation]):
    def __init__(self, db):
        super().__init__(db, Quotation)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Quotation]:
        return self.get_first(organization_id, quote_number=number)

    def get_summary_stats(self, organization_id: int) -> Dict[str, Any]:
        """Full-org-dataset KPI aggregate for the quotations list page tiles.

        Single grouped-aggregate query instead of 9 separate round trips (1
        count + 1 sum + 7 status-filtered counts) -- each round trip costs
        real, measurable network latency in this environment (same pattern
        as CreditNoteRepository/RefundRepository.get_dashboard_stats).

        Deliberately NOT paginated and NOT date-restricted: this is a
        snapshot of how many quotations are CURRENTLY in each status (an
        inventory count) and their lifetime total value, not a "created
        within this period" metric -- same rationale as
        InvoiceRepository.get_enterprise_dashboard_stats' status_counts
        query, which is also intentionally left unfiltered by date.
        """
        def _count_if(condition):
            return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)

        row = self.db.query(
            func.count(Quotation.id),
            func.coalesce(func.sum(Quotation.total_amount), 0),
            _count_if(Quotation.status == "draft"),
            _count_if(Quotation.status == "sent"),
            _count_if(Quotation.status == "accepted"),
            _count_if(Quotation.status == "rejected"),
            _count_if(Quotation.status == "cancelled"),
            _count_if(Quotation.status == "converted"),
            _count_if(Quotation.status == "expired"),
        ).filter(
            Quotation.organization_id == organization_id,
            Quotation.is_active == True,
        ).one()

        (total, total_value, draft_count, sent_count, accepted_count,
         rejected_count, cancelled_count, converted_count, expired_count) = row

        return {
            "total": total,
            "total_value": float(total_value),
            "draft_count": draft_count,
            "sent_count": sent_count,
            "accepted_count": accepted_count,
            "rejected_count": rejected_count,
            "cancelled_count": cancelled_count,
            "converted_count": converted_count,
            "expired_count": expired_count,
        }

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Quotation]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[Quotation]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        status: Optional[str] = None,
        date_from=None,
        date_to=None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        filters.pop("search_fields", None)
        result = super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order or "desc",
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["quote_number", "subject", "notes"],
            **filters,
        )
        if (date_from or date_to) and result.get("items"):
            # date_from/date_to normally arrive as `date` objects (FastAPI query
            # parsing), but accept ISO strings too so a str caller compares
            # cleanly against created_at.date() instead of raising a TypeError.
            df = date_from if not isinstance(date_from, str) else date.fromisoformat(date_from)
            dt_to = date_to if not isinstance(date_to, str) else date.fromisoformat(date_to)
            filtered = result["items"]
            if df:
                filtered = [q for q in filtered if q.created_at and q.created_at.date() >= df]
            if dt_to:
                filtered = [q for q in filtered if q.created_at and q.created_at.date() <= dt_to]
            result["items"] = filtered
        return result


class QuotationItemRepository(BaseRepository[QuotationItem]):
    def __init__(self, db):
        super().__init__(db, QuotationItem)

    def list_by_quotation(self, organization_id: int, quotation_id: int) -> List[QuotationItem]:
        query = self.db.query(QuotationItem).filter(
            QuotationItem.quotation_id == quotation_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(QuotationItem.line_number).all()

    def bulk_create_for_quotation(
        self,
        organization_id: int,
        quotation_id: int,
        items: List[Dict[str, Any]],
    ) -> List[QuotationItem]:
        objs = [QuotationItem(organization_id=organization_id, quotation_id=quotation_id, **item) for item in items]
        self.db.add_all(objs)
        self.db.commit()
        for obj in objs:
            self.db.refresh(obj)
        return objs

    def delete_by_quotation(self, organization_id: int, quotation_id: int) -> int:
        query = self.db.query(QuotationItem).filter(
            QuotationItem.quotation_id == quotation_id,
        )
        query = self._org_filter(query, organization_id)
        deleted = query.delete(synchronize_session="fetch")
        self.db.commit()
        return deleted


class ContractRepository(BaseRepository[Contract]):
    def __init__(self, db):
        super().__init__(db, Contract)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Contract]:
        return self.get_first(organization_id, contract_number=number)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Contract]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[Contract]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_active(self, organization_id: int) -> List[Contract]:
        return self.list_all(organization_id, active_only=True, status="active")

    def list_expiring(
        self,
        organization_id: int,
        within_days: int = 30,
    ) -> List[Contract]:
        from datetime import timedelta
        today = date.today()
        cutoff = today + timedelta(days=within_days)
        return self.db.query(Contract).filter(
            Contract.organization_id == organization_id,
            Contract.is_active == True,
            Contract.status == "active",
            Contract.end_date.isnot(None),
            Contract.end_date >= today,
            Contract.end_date <= cutoff,
        ).all()

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        status: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order or "desc",
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["contract_number", "contract_name", "notes"],
            date_field="created_at",
            date_from=date_from,
            date_to=date_to,
            **filters,
        )
