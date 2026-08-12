from datetime import date as date_cls
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import case, func

from app.modules.billing.models import (
    Payment,
    PaymentAllocation,
    PaymentAttempt,
    PaymentMethod,
)
from app.modules.billing.repositories.base import BaseRepository


class PaymentMethodRepository(BaseRepository[PaymentMethod]):
    def __init__(self, db):
        super().__init__(db, PaymentMethod)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[PaymentMethod]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def get_default(self, organization_id: int, customer_id: int) -> Optional[PaymentMethod]:
        return self.get_first(
            organization_id,
            customer_id=customer_id,
            is_default=True,
        )

    def set_default(self, organization_id: int, method_id: int) -> PaymentMethod:
        method = self.get_by_id(method_id, organization_id)
        self.db.query(PaymentMethod).filter(
            PaymentMethod.customer_id == method.customer_id,
            PaymentMethod.organization_id == organization_id,
        ).update({"is_default": False})
        method.is_default = True
        self.db.commit()
        self.db.refresh(method)
        return method

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
        payment_type: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if payment_type:
            filters["payment_type"] = payment_type
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order or "desc",
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["card_brand", "bank_name", "gateway"],
            **filters,
        )


class PaymentRepository(BaseRepository[Payment]):
    def __init__(self, db):
        super().__init__(db, Payment)

    @staticmethod
    def _rate_case(column, currency_rates):
        """Build a CASE expression to convert amounts by currency rate.
        
        currency_rates: {currency_code: multiplier_to_base, ...}
        Returns an expression that can be multiplied with an amount column.
        """
        if not currency_rates:
            return 1
        clauses = [(column == curr, rate) for curr, rate in currency_rates.items() if rate != 1.0]
        if not clauses:
            return 1
        return case(*clauses, else_=1.0)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Payment]:
        return self.get_first(organization_id, payment_number=number)

    def get_by_transaction_id(self, organization_id: int, transaction_id: str) -> Optional[Payment]:
        return self.get_first(organization_id, transaction_id=transaction_id)

    def get_by_id_for_update(self, id: int, organization_id: int) -> Payment:
        """Row-level lock for preventing concurrent over-refund/over-allocation.
        Falls back to plain read on SQLite (local dev) where FOR UPDATE is unsupported."""
        query = self.db.query(Payment).filter(Payment.id == id)
        try:
            query = query.with_for_update(nowait=False)
        except NotImplementedError:
            pass  # SQLite does not support row-level locking
        query = self._org_filter(query, organization_id)
        obj = query.first()
        if not obj:
            from app.core.exceptions import NotFoundException
            raise NotFoundException("Payment", id)
        return obj

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Payment]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[Payment]:
        return self.list_all(organization_id, active_only=active_only, status=status)

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
        payment_type: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if payment_type:
            filters["payment_type"] = payment_type
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "payment_date",
            sort_order=sort_order or "desc",
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["payment_number", "transaction_id", "notes"],
            date_field="payment_date",
            date_from=date_from,
            date_to=date_to,
            **filters,
        )

    def get_total_collected(
        self,
        organization_id: int,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> float:
        rate = self._rate_case(Payment.currency, currency_rates)
        query = self.db.query(
            func.coalesce(func.sum(Payment.amount * rate), 0)
        ).filter(
            Payment.organization_id == organization_id,
            Payment.status == "cleared",
        )
        if date_from:
            date_from = date_cls.fromisoformat(date_from) if isinstance(date_from, str) else date_from
            query = query.filter(Payment.payment_date >= date_from)
        if date_to:
            date_to = date_cls.fromisoformat(date_to) if isinstance(date_to, str) else date_to
            query = query.filter(Payment.payment_date <= date_to)
        return float(query.scalar())

    def get_daily_payment_trend(
        self,
        organization_id: int,
        start_date,
        end_date,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> List:
        """Return daily aggregated cleared payments between start_date and end_date."""
        from datetime import timedelta as td
        rate = self._rate_case(Payment.currency, currency_rates)
        rows = (
            self.db.query(
                Payment.payment_date.label("day"),
                func.coalesce(func.sum(Payment.amount * rate), 0).label("amount"),
                func.count(Payment.id).label("count"),
            )
            .filter(
                Payment.organization_id == organization_id,
                Payment.status == "cleared",
                Payment.payment_date >= start_date,
                Payment.payment_date <= end_date,
            )
            .group_by(Payment.payment_date)
            .order_by(Payment.payment_date)
            .all()
        )
        lookup = {r.day: (float(r.amount), r.count) for r in rows}
        result = []
        current = start_date
        while current <= end_date:
            amt, cnt = lookup.get(current, (0.0, 0))
            result.append({
                "date": current.strftime("%b %d"),
                "period": current.strftime("%b %d"),
                "amount": amt,
                "count": cnt,
            })
            current += td(days=1)
        return result

    def get_monthly_payment_trend(
        self,
        organization_id: int,
        start_date,
        end_date,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> List:
        """Return monthly aggregated cleared payments between start_date and end_date."""
        from datetime import timedelta as td
        from sqlalchemy import extract as sa_extract
        rate = self._rate_case(Payment.currency, currency_rates)
        rows = (
            self.db.query(
                sa_extract("year", Payment.payment_date).label("yr"),
                sa_extract("month", Payment.payment_date).label("mo"),
                func.coalesce(func.sum(Payment.amount * rate), 0).label("amount"),
                func.count(Payment.id).label("count"),
            )
            .filter(
                Payment.organization_id == organization_id,
                Payment.status == "cleared",
                Payment.payment_date >= start_date,
                Payment.payment_date <= end_date,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        lookup = {(int(r.yr), int(r.mo)): (float(r.amount), r.count) for r in rows}
        from app.modules.billing.utils.date_utils import MONTH_NAMES
        result = []
        current = start_date.replace(day=1)
        end_month = end_date.replace(day=1)
        while current <= end_month:
            amt, cnt = lookup.get((current.year, current.month), (0.0, 0))
            result.append({
                "month": MONTH_NAMES[current.month - 1],
                "period": f"{MONTH_NAMES[current.month - 1]} {current.year}",
                "amount": amt,
                "count": cnt,
            })
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1)
            else:
                current = current.replace(month=current.month + 1)
        return result

    def list_unallocated(
        self, organization_id: int, page: int = 1, per_page: int = 20,
    ) -> Dict[str, Any]:
        from sqlalchemy import select, func as sa_func
        subq = (
            select(PaymentAllocation.payment_id, sa_func.coalesce(sa_func.sum(PaymentAllocation.amount), 0).label("total_alloc"))
            .group_by(PaymentAllocation.payment_id)
            .subquery()
        )
        query = (
            self.db.query(Payment)
            .outerjoin(subq, Payment.id == subq.c.payment_id)
            .filter(
                Payment.organization_id == organization_id,
                Payment.status == "cleared",
                Payment.is_active == True,
                sa_func.coalesce(subq.c.total_alloc, 0) < Payment.amount,
            )
            .order_by(Payment.created_at.desc())
        )
        total = query.count()
        items = query.offset((page - 1) * per_page).limit(per_page).all()
        pages = max(1, (total + per_page - 1) // per_page)
        return {
            "items": items,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": pages,
        }


class PaymentAllocationRepository(BaseRepository[PaymentAllocation]):
    def __init__(self, db):
        super().__init__(db, PaymentAllocation)

    def list_by_payment(self, organization_id: int, payment_id: int) -> List[PaymentAllocation]:
        query = self.db.query(PaymentAllocation).filter(
            PaymentAllocation.payment_id == payment_id,
        )
        query = self._org_filter(query, organization_id)
        return query.all()

    def list_by_invoice(self, organization_id: int, invoice_id: int) -> List[PaymentAllocation]:
        query = self.db.query(PaymentAllocation).filter(
            PaymentAllocation.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        return query.all()

    def get_total_allocated_to_invoice(self, organization_id: int, invoice_id: int) -> Decimal:
        query = self.db.query(
            func.coalesce(func.sum(PaymentAllocation.amount), 0)
        ).filter(
            PaymentAllocation.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        result = query.scalar()
        return Decimal(str(result))


class PaymentAttemptRepository(BaseRepository[PaymentAttempt]):
    def __init__(self, db):
        super().__init__(db, PaymentAttempt)

    def list_by_payment(self, organization_id: int, payment_id: int) -> List[PaymentAttempt]:
        query = self.db.query(PaymentAttempt).filter(
            PaymentAttempt.payment_id == payment_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(PaymentAttempt.attempt_number.asc()).all()

    def get_latest_attempt(self, organization_id: int, payment_id: int) -> Optional[PaymentAttempt]:
        query = self.db.query(PaymentAttempt).filter(
            PaymentAttempt.payment_id == payment_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(PaymentAttempt.attempt_number.desc()).first()

    def count_failed_attempts(self, organization_id: int, payment_id: int) -> int:
        query = self.db.query(PaymentAttempt).filter(
            PaymentAttempt.payment_id == payment_id,
            PaymentAttempt.status == "failed",
        )
        query = self._org_filter(query, organization_id)
        return query.count()
