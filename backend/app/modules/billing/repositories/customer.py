from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import func, and_, asc, desc, or_

from app.modules.billing.models import BillingCustomer, CustomerContact
from app.modules.billing.repositories.base import BaseRepository


class CustomerRepository(BaseRepository[BillingCustomer]):
    def __init__(self, db):
        super().__init__(db, BillingCustomer)

    def get_by_code(self, organization_id: int, code: str) -> Optional[BillingCustomer]:
        return self.get_first(organization_id, customer_code=code)

    def get_by_id_for_update(self, id: int, organization_id: int) -> BillingCustomer:
        """Row-level lock for preventing concurrent over-commitment against a
        customer's outstanding balance (e.g. two write-offs racing to reserve
        the same balance). Falls back to a plain read on SQLite (local dev)
        where FOR UPDATE is unsupported — mirrors CreditNoteRepository/
        InvoiceRepository/PaymentRepository.get_by_id_for_update."""
        query = self.db.query(BillingCustomer).filter(BillingCustomer.id == id)
        try:
            query = query.with_for_update(nowait=False)
        except NotImplementedError:
            pass  # SQLite does not support row-level locking
        query = self._org_filter(query, organization_id)
        obj = query.first()
        if not obj:
            from app.core.exceptions import NotFoundException
            raise NotFoundException("BillingCustomer", id)
        return obj

    def search_by_company(
        self,
        organization_id: int,
        term: str,
        active_only: bool = True,
        limit: int = 20,
    ) -> List[BillingCustomer]:
        from sqlalchemy import or_
        from sqlalchemy.orm import Query
        
        query: Query[BillingCustomer] = self.db.query(self.model)
        query = self._org_filter(query, organization_id)
        query = self._active_filter(query, active_only)
        query = query.filter(self.model.deleted_at.is_(None))
        
        conditions = []
        
        searchable_fields = [
            "display_name",
            "company_name",
            "customer_code",
            "email",
            "phone",
            "mobile",
            "gst_number",
            "vat_number",
            "pan",
            "tin",
            "tax_id",
        ]
        
        for field_name in searchable_fields:
            if hasattr(self.model, field_name):
                conditions.append(
                    getattr(self.model, field_name).ilike(f"%{term}%")
                )
        
        if not conditions:
            query = query.filter(self.model.company_name.ilike(f"%{term}%"))
        else:
            query = query.filter(or_(*conditions))
            
        return query.limit(limit).all()

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        customer_type: Optional[str] = None,
        status: Optional[str] = None,
        credit_limit_min: Optional[float] = None,
        credit_limit_max: Optional[float] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_type:
            filters["customer_type"] = customer_type
        if status:
            filters["status"] = status
        if search_fields:
            filters.pop("search_fields", None)
        else:
            search_fields = ["company_name", "display_name", "email", "customer_code", "phone", "mobile", "gst_number", "vat_number", "pan", "tin", "tax_id"]
        filters.pop("search_fields", None)

        # credit_limit range: handled here via extra_filters passed to base,
        # rather than post-DB Python filtering, so that total counts are accurate.
        extra_conditions = []
        if credit_limit_min is not None:
            extra_conditions.append(BillingCustomer.credit_limit >= Decimal(str(credit_limit_min)))
        if credit_limit_max is not None:
            extra_conditions.append(BillingCustomer.credit_limit <= Decimal(str(credit_limit_max)))

        result = super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "company_name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields,
            date_field="created_at" if (date_from or date_to) else None,
            date_from=date_from,
            date_to=date_to,
            **filters,
        )

        # Apply credit_limit range filter at DB level by post-filtering the
        # full un-paginated set. Since BaseRepository.list_paginated doesn't
        # support arbitrary SQLAlchemy expressions, we rebuild the count/page
        # here when credit_limit filters are active.
        if extra_conditions:
            from sqlalchemy import asc as _asc, desc as _desc
            per_page_clamped = min(max(per_page, 1), 200)
            page_clamped = max(page, 1)
            base_q = self.db.query(BillingCustomer).filter(
                BillingCustomer.organization_id == organization_id,
                BillingCustomer.deleted_at.is_(None),
                *extra_conditions,
            )
            if active_only:
                base_q = base_q.filter(BillingCustomer.is_active == True)
            total = base_q.count()
            _sort_col = getattr(BillingCustomer, sort_by or "company_name", BillingCustomer.company_name)
            _order_fn = _asc if sort_order == "asc" else _desc
            items = base_q.order_by(_order_fn(_sort_col)).offset((page_clamped - 1) * per_page_clamped).limit(per_page_clamped).all()
            return {
                "total": total,
                "page": page_clamped,
                "per_page": per_page_clamped,
                "pages": (total + per_page_clamped - 1) // per_page_clamped if total else 0,
                "items": items,
            }

        return result

    def count_by_status(self, organization_id: int) -> Dict[str, int]:
        from app.modules.billing.models import CustomerStatus
        query = self.db.query(
            BillingCustomer.status,
            func.count(BillingCustomer.id),
        ).filter(
            BillingCustomer.organization_id == organization_id,
            BillingCustomer.deleted_at.is_(None),
        ).group_by(BillingCustomer.status)
        rows = {row[0]: row[1] for row in query.all()}
        return {s.value: rows.get(s.value, 0) for s in CustomerStatus}


class CustomerContactRepository(BaseRepository[CustomerContact]):
    def __init__(self, db):
        super().__init__(db, CustomerContact)

    def get_primary(self, organization_id: int, customer_id: int) -> Optional[CustomerContact]:
        return self.get_first(
            organization_id,
            customer_id=customer_id,
            is_primary=True,
        )

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[CustomerContact]:
        return self.list_all(
            organization_id,
            active_only=active_only,
            customer_id=customer_id,
        )

    def set_primary(self, organization_id: int, contact_id: int) -> CustomerContact:
        contact = self.get_by_id(contact_id, organization_id)
        self.db.query(CustomerContact).filter(
            CustomerContact.customer_id == contact.customer_id,
            CustomerContact.organization_id == organization_id,
        ).update({"is_primary": False})
        contact.is_primary = True
        self.db.commit()
        self.db.refresh(contact)
        return contact

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        customer_id: Optional[int] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if search_fields:
            filters.pop("search_fields", None)
        else:
            search_fields = ["first_name", "last_name", "email", "phone"]
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "last_name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields,
            **filters,
        )
