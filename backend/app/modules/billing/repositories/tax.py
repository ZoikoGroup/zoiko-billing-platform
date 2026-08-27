from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, or_

from app.modules.billing.models import Tax, TaxRate
from app.modules.billing.repositories.base import BaseRepository


class TaxRateRepository(BaseRepository[TaxRate]):
    def __init__(self, db):
        super().__init__(db, TaxRate)

    def get_by_code(self, organization_id: int, code: str) -> Optional[TaxRate]:
        return self.get_first(organization_id, code=code)

    def list_active_at_date(
        self,
        organization_id: int,
        date_str: str,
    ) -> List[TaxRate]:
        return self.db.query(TaxRate).filter(
            TaxRate.organization_id == organization_id,
            TaxRate.is_active == True,
            TaxRate.effective_from <= date_str,
            and_(
                TaxRate.effective_to >= date_str,
                TaxRate.effective_to.is_(None),
            ),
        ).all()

    def list_by_tax_type(
        self,
        organization_id: int,
        tax_type: str,
        active_only: bool = True,
    ) -> List[TaxRate]:
        return self.list_all(organization_id, active_only=active_only, tax_type=tax_type)

    def list_by_currency(
        self,
        organization_id: int,
        currency_code: str,
        active_only: bool = True,
    ) -> List[TaxRate]:
        query = self.db.query(TaxRate).filter(
            TaxRate.organization_id == organization_id,
            TaxRate.currency_code == currency_code.upper(),
        )
        if active_only:
            query = query.filter(TaxRate.is_active == True)
        return query.order_by(TaxRate.priority.desc(), TaxRate.rate.asc()).all()

    def get_default(self, organization_id: int) -> Optional[TaxRate]:
        return self.db.query(TaxRate).filter(
            TaxRate.organization_id == organization_id,
            TaxRate.is_active == True,
            TaxRate.is_default == True,
        ).order_by(TaxRate.priority.desc()).first()

    def get_default_by_currency(
        self,
        organization_id: int,
        currency_code: str,
    ) -> Optional[TaxRate]:
        return self.db.query(TaxRate).filter(
            TaxRate.organization_id == organization_id,
            TaxRate.is_active == True,
            TaxRate.currency_code == currency_code.upper(),
            TaxRate.is_default == True,
        ).order_by(TaxRate.priority.desc()).first()

    def list_matching_codes(
        self,
        organization_id: int,
        codes: List[str],
    ) -> List[TaxRate]:
        """Load duplicate-code candidates in one organization-scoped query."""
        if not codes:
            return []
        return self.db.query(TaxRate).filter(
            TaxRate.organization_id == organization_id,
            TaxRate.code.in_(set(codes)),
        ).all()

    def unset_default_for_currency(
        self,
        organization_id: int,
        currency_code: Optional[str],
        exclude_id: Optional[int] = None,
    ) -> int:
        """Clear is_default on every other active rate in this org+currency
        bucket. currency_code=None is its own bucket (IS NULL), so a rate
        with no currency set never gets treated as sharing a "default" slot
        with rates that do have one. Does not commit -- the caller's own
        create()/update() commit covers this atomically."""
        query = self.db.query(TaxRate).filter(
            TaxRate.organization_id == organization_id,
            TaxRate.is_active == True,
            TaxRate.is_default == True,
        )
        if currency_code:
            query = query.filter(TaxRate.currency_code == currency_code.upper())
        else:
            query = query.filter(TaxRate.currency_code.is_(None))
        if exclude_id is not None:
            query = query.filter(TaxRate.id != exclude_id)
        # "fetch" (not False) so any already-loaded TaxRate objects in this
        # session's identity map (e.g. a row the caller queried moments ago)
        # get their in-memory is_default flipped too, matching
        # BaseRepository.bulk_hard_delete's same synchronize_session choice.
        return query.update({"is_default": False}, synchronize_session="fetch")

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        tax_type: Optional[str] = None,
        currency_code: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if tax_type:
            filters["tax_type"] = tax_type
        if currency_code:
            filters["currency_code"] = currency_code.upper()
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "jurisdiction"],
            **filters,
        )


class TaxRepository(BaseRepository[Tax]):
    def __init__(self, db):
        super().__init__(db, Tax)

    def list_by_invoice(
        self,
        organization_id: int,
        invoice_id: int,
        active_only: bool = True,
    ) -> List[Tax]:
        return self.list_all(organization_id, active_only=active_only, invoice_id=invoice_id)

    def list_by_credit_note(
        self,
        organization_id: int,
        credit_note_id: int,
        active_only: bool = True,
    ) -> List[Tax]:
        return self.list_all(organization_id, active_only=active_only, credit_note_id=credit_note_id)

    def get_total_tax_for_invoice(self, organization_id: int, invoice_id: int) -> float:
        result = self.db.query(
            func.coalesce(func.sum(Tax.tax_amount), 0)
        ).filter(
            Tax.organization_id == organization_id,
            Tax.invoice_id == invoice_id,
            Tax.is_active == True,
        ).scalar()
        return float(result)

    def get_summary(
        self,
        organization_id: int,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Aggregated total + per-type breakdown in 2 grouped SQL queries,
        filtered server-side by date range — replaces the previous pattern
        of loading every active Tax row for the org into Python and summing
        there (a full-table load repeated on every call)."""
        base_filters = [Tax.organization_id == organization_id, Tax.is_active == True]
        if date_from:
            base_filters.append(func.date(Tax.created_at) >= func.date(date_from))
        if date_to:
            base_filters.append(func.date(Tax.created_at) <= func.date(date_to))

        total_tax, total_records = self.db.query(
            func.coalesce(func.sum(Tax.tax_amount), 0),
            func.count(Tax.id),
        ).filter(*base_filters).one()

        breakdown_rows = (
            self.db.query(Tax.tax_type, func.coalesce(func.sum(Tax.tax_amount), 0))
            .filter(*base_filters)
            .group_by(Tax.tax_type)
            .all()
        )
        breakdown_by_type = {
            (t.value if hasattr(t, "value") else (t or "unknown")): float(amount)
            for t, amount in breakdown_rows
        }

        return {
            "total_tax": float(total_tax),
            "total_records": total_records,
            "breakdown_by_type": breakdown_by_type,
        }

    def get_monthly_trend(self, organization_id: int, months: int = 6) -> List[Dict[str, Any]]:
        """Single grouped-by-month query for the trailing `months` months of
        tax collected — same GROUP BY month pattern used by
        CollectionsCaseRepository.get_recovery_trend / InvoiceRepository.get_invoice_trend.
        Replaces calling get_summary() once per month window."""
        rows = (
            self.db.query(
                func.date_trunc("month", Tax.created_at).label("month"),
                func.coalesce(func.sum(Tax.tax_amount), 0),
            )
            .filter(Tax.organization_id == organization_id, Tax.is_active == True)
            .group_by("month")
            .order_by("month")
            .all()
        )
        by_month = {month.strftime("%Y-%m"): float(total) for month, total in rows if month}

        now = datetime.now(timezone.utc)
        result = []
        for i in range(months - 1, -1, -1):
            anchor_year = now.year
            anchor_month = now.month - i
            while anchor_month <= 0:
                anchor_month += 12
                anchor_year -= 1
            key = f"{anchor_year:04d}-{anchor_month:02d}"
            label = datetime(anchor_year, anchor_month, 1).strftime("%b %y")
            result.append({"month": label, "tax": by_month.get(key, 0.0)})
        return result

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        invoice_id: Optional[int] = None,
        credit_note_id: Optional[int] = None,
        tax_type: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if invoice_id:
            filters["invoice_id"] = invoice_id
        if credit_note_id:
            filters["credit_note_id"] = credit_note_id
        if tax_type:
            filters["tax_type"] = tax_type
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["jurisdiction"],
            **filters,
        )
