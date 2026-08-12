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
