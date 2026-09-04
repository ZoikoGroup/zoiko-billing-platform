from typing import Any, Dict, List, Optional

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.modules.billing.models import (
    PlanTier,
    PricingPlan,
    PriceList,
    PriceListItem,
    PricingRule,
    PricingRuleTier,
    Discount,
    DiscountUsage,
    CurrencyPricing,
    TaxPricing,
    TaxGroup,
    TaxGroupMember,
    Product,
    ProductCategory,
)
from app.modules.billing.repositories.base import BaseRepository
from app.core.exceptions import AlreadyExistsException, BadRequestException, NotFoundException


class ProductCategoryRepository(BaseRepository[ProductCategory]):
    def __init__(self, db):
        super().__init__(db, ProductCategory)

    def get_by_code(self, organization_id: int, code: str) -> Optional[ProductCategory]:
        return self.get_first(organization_id, code=code)

    def list_root(self, organization_id: int, active_only: bool = True) -> List[ProductCategory]:
        return self.list_all(organization_id, active_only=active_only, parent_id=None)

    def list_children(self, organization_id: int, parent_id: int, active_only: bool = True) -> List[ProductCategory]:
        return self.list_all(organization_id, active_only=active_only, parent_id=parent_id)

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
        **filters: Any,
    ) -> Dict[str, Any]:
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


class ProductRepository(BaseRepository[Product]):
    def __init__(self, db):
        super().__init__(db, Product)

    def get_by_code(self, organization_id: int, code: str) -> Optional[Product]:
        return self.get_first(organization_id, code=code)

    def get_by_name(self, organization_id: int, name: str) -> Optional[Product]:
        query = self.db.query(Product).filter(
            Product.organization_id == organization_id,
            Product.name == name,
        )
        if hasattr(Product, "deleted_at"):
            query = query.filter(Product.deleted_at.is_(None))
        return query.first()

    def list_matching_codes_or_names(
        self,
        organization_id: int,
        codes: Optional[List[str]] = None,
        names: Optional[List[str]] = None,
    ) -> List[Product]:
        """Load duplicate candidates in one organization-scoped query."""
        predicates = []
        if codes:
            predicates.append(Product.code.in_(set(codes)))
        if names:
            predicates.append(Product.name.in_(set(names)))
        if not predicates:
            return []

        query = self.db.query(Product).filter(
            Product.organization_id == organization_id,
            or_(*predicates),
        )
        if hasattr(Product, "deleted_at"):
            query = query.filter(Product.deleted_at.is_(None))
        return query.all()

    def get_archived_by_id(self, id: int, organization_id: int) -> Product:
        from app.core.exceptions import NotFoundException

        product = self.db.query(Product).filter(
            Product.id == id,
            Product.organization_id == organization_id,
            Product.deleted_at.isnot(None),
        ).first()
        if not product:
            raise NotFoundException("Product", id)
        return product

    def restore(self, id: int, organization_id: int) -> Product:
        product = self.get_archived_by_id(id, organization_id)
        product.deleted_at = None
        product.is_active = True
        self.db.commit()
        self.db.refresh(product)
        return product

    def get_deleted_by_code(self, organization_id: int, code: str) -> Optional[Product]:
        """Return a soft-deleted product matching this org + code, or None.

        `exists()`/`get_by_code()` deliberately exclude soft-deleted rows so a
        deleted product no longer counts as a live uniqueness collision, but
        the underlying row still occupies the (organization_id, code) unique
        constraint. Callers that need to *reuse* that code (e.g. re-importing a
        previously deleted catalog) must find and restore the archived row
        rather than attempt a conflicting insert."""
        return (
            self.db.query(Product)
            .filter(
                Product.organization_id == organization_id,
                Product.code == code,
                Product.deleted_at.isnot(None),
            )
            .first()
        )

    def count_by_category(self, organization_id: int, category_id: int) -> int:
        return self.count(organization_id, active_only=False, category_id=category_id)

    def list_by_category(
        self,
        organization_id: int,
        category_id: int,
        active_only: bool = True,
    ) -> List[Product]:
        return self.list_all(organization_id, active_only=active_only, category_id=category_id)

    def list_subscribable(self, organization_id: int, active_only: bool = True) -> List[Product]:
        return self.list_all(organization_id, active_only=active_only, is_subscribable=True)

    def list_usage_billable(self, organization_id: int, active_only: bool = True) -> List[Product]:
        return self.list_all(organization_id, active_only=active_only, is_usage_billable=True)

    def _paginated_products_query(
        self,
        organization_id: int,
        page: int,
        per_page: int,
        sort_by: Optional[str],
        sort_order: str,
        search_term: Optional[str],
        filters: Dict[str, Any],
        extra_filter: Any = None,
        include_deleted: bool = False,
    ) -> Dict[str, Any]:
        """
        Shared DB-level (LIMIT/OFFSET, no in-Python filtering) query builder for
        the list_paginated branches below that need a raw query outside the base
        repository's active_only toggle (e.g. "archived only" or "everything
        regardless of status") — was previously duplicated verbatim three times.

        include_deleted=False (the default) excludes soft-deleted/archived rows,
        matching every other listing path in this app. Only the two callers that
        explicitly want archived rows in the result (status="archived", which
        supplies its own deleted_at.isnot(None) extra_filter, and status="all",
        which deliberately means "literally everything") pass True -- every other
        caller of this bypass (e.g. active_only=False with no status filter) used
        to silently include archived products alongside active/inactive ones,
        which is what made GET /products?is_active=false return archived rows
        too instead of just inactive ones.
        """
        from app.modules.billing.models import Product as ProductModel, ProductCategory as CategoryModel
        from sqlalchemy import asc, desc

        per_page = min(max(per_page, 1), 200)
        page = max(page, 1)
        query = self.db.query(ProductModel).outerjoin(
            CategoryModel, ProductModel.category_id == CategoryModel.id
        ).filter(ProductModel.organization_id == organization_id)
        if not include_deleted:
            query = query.filter(ProductModel.deleted_at.is_(None))
        if extra_filter is not None:
            query = query.filter(extra_filter)
        for field, value in filters.items():
            if value is not None:
                query = self._apply_filter(query, field, value)
        if search_term:
            pattern = f"%{search_term}%"
            query = query.filter(
                ProductModel.name.ilike(pattern) | ProductModel.code.ilike(pattern)
                | ProductModel.description.ilike(pattern) | CategoryModel.name.ilike(pattern)
            )
        total = query.count()
        if sort_by and hasattr(ProductModel, sort_by):
            order_fn = asc if sort_order == "asc" else desc
            query = query.order_by(order_fn(getattr(ProductModel, sort_by)))
        items = query.offset((page - 1) * per_page).limit(per_page).all()
        # Matches BaseRepository.list_paginated's zero-result convention
        # (pages=0, not 1) so callers get a consistent answer regardless of
        # which internal path served the request.
        pages = (total + per_page - 1) // per_page if total else 0
        return {"items": items, "total": total, "page": page, "per_page": per_page, "pages": pages}

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        category_id: Optional[int] = None,
        product_type: Optional[str] = None,
        status: Optional[str] = None,
        currency: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if category_id:
            filters["category_id"] = category_id
        if product_type:
            filters["product_type"] = product_type
        if currency:
            filters["currency"] = currency
        filters.pop("search_fields", None)
        if not status and active_only is False:
            return self._paginated_products_query(organization_id, page, per_page, sort_by, sort_order, search_term, filters)
        if status:
            if status == "archived":
                from app.modules.billing.models import Product as ProductModel
                return self._paginated_products_query(
                    organization_id, page, per_page, sort_by, sort_order, search_term, filters,
                    extra_filter=ProductModel.deleted_at.isnot(None),
                    include_deleted=True,
                )
            if status == "inactive":
                filters["is_active"] = False
            elif status == "all":
                return self._paginated_products_query(
                    organization_id, page, per_page, sort_by, sort_order, search_term, filters,
                    include_deleted=True,
                )
            else:
                filters["is_active"] = True
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only if not status else False,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


class PricingPlanRepository(BaseRepository[PricingPlan]):
    def __init__(self, db):
        super().__init__(db, PricingPlan)

    def list_by_product(
        self,
        organization_id: int,
        product_id: int,
        active_only: bool = True,
    ) -> List[PricingPlan]:
        return self.list_all(organization_id, active_only=active_only, product_id=product_id)

    def get_active_at_date(
        self,
        organization_id: int,
        product_id: int,
        date_str: str,
    ) -> Optional[PricingPlan]:
        from sqlalchemy import or_
        return self.db.query(PricingPlan).filter(
            PricingPlan.organization_id == organization_id,
            PricingPlan.product_id == product_id,
            PricingPlan.is_active == True,
            PricingPlan.effective_from <= date_str,
            or_(
                PricingPlan.effective_to >= date_str,
                PricingPlan.effective_to.is_(None),
            ),
        ).first()

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        product_id: Optional[int] = None,
        billing_period: Optional[str] = None,
        pricing_model: Optional[str] = None,
        status: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if product_id:
            filters["product_id"] = product_id
        if billing_period:
            filters["billing_period"] = billing_period
        if pricing_model:
            filters["pricing_model"] = pricing_model
        if status:
            if status == "active":
                filters["is_active"] = True
                active_only = False
            elif status == "inactive":
                filters["is_active"] = False
                active_only = False
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name"],
            **filters,
        )


class PlanTierRepository(BaseRepository[PlanTier]):
    def __init__(self, db):
        super().__init__(db, PlanTier)

    def list_by_plan(self, organization_id: int, pricing_plan_id: int) -> List[PlanTier]:
        query = self.db.query(PlanTier).filter(
            PlanTier.pricing_plan_id == pricing_plan_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(PlanTier.from_quantity).all()

    def create(self, organization_id: int, **data: Any) -> PlanTier:
        return super().create(organization_id, **data)


# ═══════════════════════════════════════════════════════════════════════════════
# PRICE LIST REPOSITORIES
# ═══════════════════════════════════════════════════════════════════════════════


class PriceListRepository(BaseRepository[PriceList]):
    def __init__(self, db):
        super().__init__(db, PriceList)

    def get_by_code(self, organization_id: int, code: str) -> Optional[PriceList]:
        return self.get_first(organization_id, code=code)

    def get_default(self, organization_id: int) -> Optional[PriceList]:
        return self.get_first(organization_id, is_default=True, is_active=True)

    # ── Optimistic-lock version bump (CRIT-Q17b remediation) ───────────────
    # Every PriceList mutation must advance `version` explicitly at the repo/
    # service layer (NOT an ORM `onupdate` hook) — so a future bulk
    # Query.update()/raw-SQL path, or any direct field set, can never silently
    # skip the bump the way the original `default=1`-only column did. Any
    # content change invalidates a consumer that pinned the list's version.

    def _apply(self, obj: PriceList, **data: Any) -> PriceList:
        """Set fields AND bump the optimistic-lock version in the same
        transaction. `version` itself is never settable through this helper; it
        is always advanced here regardless of which fields change."""
        for field, value in data.items():
            if hasattr(obj, field) and field != "version":
                setattr(obj, field, value)
        obj.version = (obj.version or 0) + 1
        return obj

    def save(self, obj: PriceList, **data: Any) -> PriceList:
        """Persist a loaded row through _apply so the version bump lands in the
        same transaction as the field changes (used for parent bump on item
        add/update/remove and any service-layer direct mutation)."""
        self._apply(obj, **data)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, id: int, organization_id: int, **data: Any) -> PriceList:
        obj = self.get_by_id(id, organization_id)
        self._apply(obj, **data)
        try:
            self.db.commit()
        except IntegrityError as e:
            self.db.rollback()
            raise AlreadyExistsException(self.model.__name__, str(e))
        self.db.refresh(obj)
        return obj

    def bulk_update(self, items: List[Dict[str, Any]], organization_id: int) -> List[PriceList]:
        updated = []
        for item in items:
            obj_id = item.pop("id", None)
            if not obj_id:
                continue
            query = self.db.query(self.model).filter(self.model.id == obj_id)
            query = self._org_filter(query, organization_id)
            obj = query.first()
            if not obj:
                continue
            self._apply(obj, **item)
            updated.append(obj)
        try:
            self.db.commit()
        except IntegrityError as e:
            self.db.rollback()
            raise BadRequestException(f"Bulk update failed: {e}")
        for obj in updated:
            self.db.refresh(obj)
        return updated

    def soft_delete(self, id: int, organization_id: int) -> PriceList:
        obj = self.get_by_id(id, organization_id)
        self._apply(obj, is_active=False, deleted_at=func.now())
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def restore(self, id: int, organization_id: int) -> Optional[PriceList]:
        query = self.db.query(self.model)
        query = self._org_filter(query, organization_id)
        query = query.filter(self.model.id == id)
        obj = query.first()
        if obj is None:
            return None
        self._apply(obj, is_active=True, deleted_at=None)
        self.db.commit()
        self.db.refresh(obj)
        return obj


    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[PriceList]:
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
        status: Optional[str] = None,
        currency: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if status:
            filters["status"] = status
        if currency:
            filters["currency"] = currency
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


class PriceListItemRepository(BaseRepository[PriceListItem]):
    def __init__(self, db):
        super().__init__(db, PriceListItem)

    def get_by_id_and_price_list(
        self,
        item_id: int,
        organization_id: int,
        price_list_id: int,
    ) -> PriceListItem:
        """Phase 5.10: child-resource parent validation. Load a price list
        item scoped to BOTH its organization and its parent price list, so an
        item belonging to a different price list (or tenant) is
        indistinguishable from a non-existent one."""
        item = self.db.query(PriceListItem).filter(
            PriceListItem.id == item_id,
            PriceListItem.organization_id == organization_id,
            PriceListItem.price_list_id == price_list_id,
        ).first()
        if not item:
            raise NotFoundException("PriceListItem", item_id)
        return item

    def list_by_price_list(
        self,
        organization_id: int,
        price_list_id: int,
        active_only: bool = True,
    ) -> List[PriceListItem]:
        return self.list_all(organization_id, active_only=active_only, price_list_id=price_list_id)

    def get_by_product(
        self,
        organization_id: int,
        price_list_id: int,
        product_id: int,
    ) -> Optional[PriceListItem]:
        return self.get_first(organization_id, price_list_id=price_list_id, product_id=product_id)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        price_list_id: Optional[int] = None,
        product_id: Optional[int] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if price_list_id:
            filters["price_list_id"] = price_list_id
        if product_id:
            filters["product_id"] = product_id
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "product_id",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["product_id"],
            **filters,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# PRICING RULE REPOSITORIES
# ═══════════════════════════════════════════════════════════════════════════════


class PricingRuleRepository(BaseRepository[PricingRule]):
    def __init__(self, db):
        super().__init__(db, PricingRule)

    def get_by_code(self, organization_id: int, code: str) -> Optional[PricingRule]:
        return self.get_first(organization_id, code=code)

    def list_by_type(
        self,
        organization_id: int,
        rule_type: str,
        active_only: bool = True,
    ) -> List[PricingRule]:
        return self.list_all(organization_id, active_only=active_only, rule_type=rule_type)

    def list_by_scope(
        self,
        organization_id: int,
        scope: str,
        active_only: bool = True,
    ) -> List[PricingRule]:
        return self.list_all(organization_id, active_only=active_only, scope=scope)

    def list_by_product(
        self,
        organization_id: int,
        product_id: int,
        active_only: bool = True,
    ) -> List[PricingRule]:
        return self.list_all(organization_id, active_only=active_only, product_id=product_id)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[PricingRule]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def get_applicable_rules(
        self,
        organization_id: int,
        product_id: Optional[int] = None,
        customer_id: Optional[int] = None,
        customer_group: Optional[str] = None,
        region: Optional[str] = None,
        country: Optional[str] = None,
        date: Optional[str] = None,
        active_only: bool = True,
    ) -> List[PricingRule]:
        from sqlalchemy import or_
        query = self.db.query(PricingRule).filter(
            PricingRule.organization_id == organization_id,
        )
        if active_only:
            query = query.filter(PricingRule.is_active == True)
            query = query.filter(PricingRule.status == "active")
        query = query.filter(PricingRule.effective_from <= (date or "9999-12-31"))
        query = query.filter(
            or_(
                PricingRule.effective_to >= (date or "9999-12-31"),
                PricingRule.effective_to.is_(None),
            )
        )
        # Filter by product
        if product_id:
            query = query.filter(
                or_(
                    PricingRule.product_id == product_id,
                    PricingRule.product_id.is_(None),
                )
            )
        # Filter by customer
        if customer_id:
            query = query.filter(
                or_(
                    PricingRule.customer_id == customer_id,
                    PricingRule.customer_id.is_(None),
                )
            )
        # Filter by customer group
        if customer_group:
            query = query.filter(
                or_(
                    PricingRule.customer_group == customer_group,
                    PricingRule.customer_group.is_(None),
                )
            )
        # Filter by region
        if region:
            query = query.filter(
                or_(
                    PricingRule.region == region,
                    PricingRule.region.is_(None),
                )
            )
        # Filter by country
        if country:
            query = query.filter(
                or_(
                    PricingRule.country == country,
                    PricingRule.country.is_(None),
                )
            )
        return query.order_by(PricingRule.priority.desc(), PricingRule.created_at).all()

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        rule_type: Optional[str] = None,
        scope: Optional[str] = None,
        status: Optional[str] = None,
        product_id: Optional[int] = None,
        customer_id: Optional[int] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if rule_type:
            filters["rule_type"] = rule_type
        if scope:
            filters["scope"] = scope
        if status:
            filters["status"] = status
        if product_id:
            filters["product_id"] = product_id
        if customer_id:
            filters["customer_id"] = customer_id
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "priority",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


class PricingRuleTierRepository(BaseRepository[PricingRuleTier]):
    def __init__(self, db):
        super().__init__(db, PricingRuleTier)

    def list_by_rule(self, organization_id: int, pricing_rule_id: int) -> List[PricingRuleTier]:
        query = self.db.query(PricingRuleTier).filter(
            PricingRuleTier.pricing_rule_id == pricing_rule_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(PricingRuleTier.from_quantity).all()

    def create(self, organization_id: int, **data: Any) -> PricingRuleTier:
        return super().create(organization_id, **data)


# ═══════════════════════════════════════════════════════════════════════════════
# DISCOUNT REPOSITORIES
# ═══════════════════════════════════════════════════════════════════════════════


class DiscountRepository(BaseRepository[Discount]):
    def __init__(self, db):
        super().__init__(db, Discount)

    def get_by_code(self, organization_id: int, code: str) -> Optional[Discount]:
        return self.get_first(organization_id, code=code)

    def list_by_type(
        self,
        organization_id: int,
        discount_type: str,
        active_only: bool = True,
    ) -> List[Discount]:
        return self.list_all(organization_id, active_only=active_only, discount_type=discount_type)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Discount]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_valid_for_order(
        self,
        organization_id: int,
        order_amount: float,
        customer_id: Optional[int] = None,
        product_ids: Optional[List[int]] = None,
        category_ids: Optional[List[int]] = None,
        active_only: bool = True,
    ) -> List[Discount]:
        from sqlalchemy import or_, and_
        from datetime import datetime
        now = datetime.utcnow()
        query = self.db.query(Discount).filter(
            Discount.organization_id == organization_id,
            Discount.is_active == True,
            Discount.status == "active",
            Discount.valid_from <= now,
            or_(
                Discount.valid_to >= now,
                Discount.valid_to.is_(None),
            ),
        )
        if active_only:
            query = query.filter(Discount.is_active == True)
        if order_amount is not None:
            query = query.filter(
                or_(
                    Discount.min_order_amount.is_(None),
                    Discount.min_order_amount <= order_amount,
                )
            )
        if customer_id:
            query = query.filter(
                or_(
                    Discount.customer_id == customer_id,
                    Discount.customer_id.is_(None),
                )
            )
        # Get all matching discounts first, then apply product/category scope
        # matching in Python (the product_ids/category_ids columns are JSON
        # arrays, so membership can't be expressed portably across the
        # SQLite/Postgres dialects this app runs on via a SQL filter).
        discounts = query.all()

        if product_ids or category_ids:
            requested_products = {str(pid) for pid in (product_ids or [])}
            requested_categories = {str(cid) for cid in (category_ids or [])}
            scoped_discounts = []
            for discount in discounts:
                d_products = {str(pid) for pid in (discount.product_ids or [])}
                d_categories = {str(cid) for cid in (discount.category_ids or [])}
                if not d_products and not d_categories:
                    # Unscoped discount — applies regardless of product/category.
                    scoped_discounts.append(discount)
                    continue
                if (d_products and requested_products & d_products) or (
                    d_categories and requested_categories & d_categories
                ):
                    scoped_discounts.append(discount)
            discounts = scoped_discounts

        # Apply per-customer limit filtering
        if customer_id:
            valid_discounts = []
            for discount in discounts:
                if discount.per_customer_limit is not None:
                    usage_count = self.get_customer_usage(organization_id, discount.id, customer_id)
                    if usage_count >= discount.per_customer_limit:
                        continue  # Skip this discount for this customer
                valid_discounts.append(discount)
            return valid_discounts

        return discounts

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        discount_type: Optional[str] = None,
        status: Optional[str] = None,
        customer_id: Optional[int] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if discount_type:
            filters["discount_type"] = discount_type
        if status:
            filters["status"] = status
        if customer_id:
            filters["customer_id"] = customer_id
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


class DiscountUsageRepository(BaseRepository[DiscountUsage]):
    def __init__(self, db):
        super().__init__(db, DiscountUsage)

    def get_usage_count(self, organization_id: int, discount_id: int) -> int:
        return self.count(organization_id, discount_id=discount_id)

    def get_customer_usage(
        self,
        organization_id: int,
        discount_id: int,
        customer_id: int,
    ) -> int:
        return self.count(organization_id, discount_id=discount_id, customer_id=customer_id)

    def list_by_discount(
        self,
        organization_id: int,
        discount_id: int,
        page: int = 1,
        per_page: int = 20,
    ) -> Dict[str, Any]:
        return self.list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by="used_at",
            sort_order="desc",
            discount_id=discount_id,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# CURRENCY PRICING REPOSITORY
# ═══════════════════════════════════════════════════════════════════════════════


class CurrencyPricingRepository(BaseRepository[CurrencyPricing]):
    def __init__(self, db):
        super().__init__(db, CurrencyPricing)

    def get_by_product_currency(
        self,
        organization_id: int,
        product_id: int,
        currency: str,
    ) -> Optional[CurrencyPricing]:
        return self.get_first(organization_id, product_id=product_id, currency=currency)

    def list_by_product(
        self,
        organization_id: int,
        product_id: int,
        active_only: bool = True,
    ) -> List[CurrencyPricing]:
        return self.list_all(organization_id, active_only=active_only, product_id=product_id)

    def list_by_currency(
        self,
        organization_id: int,
        currency: str,
        active_only: bool = True,
    ) -> List[CurrencyPricing]:
        return self.list_all(organization_id, active_only=active_only, currency=currency)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        product_id: Optional[int] = None,
        currency: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if product_id:
            filters["product_id"] = product_id
        if currency:
            filters["currency"] = currency
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "product_id",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["product_id", "currency"],
            **filters,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# TAX PRICING REPOSITORY
# ═══════════════════════════════════════════════════════════════════════════════


class TaxPricingRepository(BaseRepository[TaxPricing]):
    def __init__(self, db):
        super().__init__(db, TaxPricing)

    def get_by_code(self, organization_id: int, code: str) -> Optional[TaxPricing]:
        return self.get_first(organization_id, code=code)

    def get_default(self, organization_id: int) -> Optional[TaxPricing]:
        return self.get_first(organization_id, is_default=True, is_active=True)

    def list_by_type(
        self,
        organization_id: int,
        tax_type: str,
        active_only: bool = True,
    ) -> List[TaxPricing]:
        return self.list_all(organization_id, active_only=active_only, tax_type=tax_type)

    def list_by_country(
        self,
        organization_id: int,
        country: str,
        active_only: bool = True,
    ) -> List[TaxPricing]:
        return self.list_all(organization_id, active_only=active_only, country=country)

    def get_applicable_taxes(
        self,
        organization_id: int,
        country: Optional[str] = None,
        region: Optional[str] = None,
        state: Optional[str] = None,
        city: Optional[str] = None,
        postal_code: Optional[str] = None,
        product_type: Optional[str] = None,
        date: Optional[str] = None,
        active_only: bool = True,
    ) -> List[TaxPricing]:
        from sqlalchemy import or_
        query = self.db.query(TaxPricing).filter(
            TaxPricing.organization_id == organization_id,
        )
        if active_only:
            query = query.filter(TaxPricing.is_active == True)
        if date:
            query = query.filter(TaxPricing.effective_from <= date)
            query = query.filter(
                or_(
                    TaxPricing.effective_to >= date,
                    TaxPricing.effective_to.is_(None),
                )
            )
        if country:
            query = query.filter(
                or_(
                    TaxPricing.country == country,
                    TaxPricing.country.is_(None),
                )
            )
        if region:
            query = query.filter(
                or_(
                    TaxPricing.region == region,
                    TaxPricing.region.is_(None),
                )
            )
        if state:
            query = query.filter(
                or_(
                    TaxPricing.state == state,
                    TaxPricing.state.is_(None),
                )
            )
        if city:
            query = query.filter(
                or_(
                    TaxPricing.city == city,
                    TaxPricing.city.is_(None),
                )
            )
        if postal_code:
            query = query.filter(
                or_(
                    TaxPricing.postal_code == postal_code,
                    TaxPricing.postal_code.is_(None),
                )
            )
        if product_type:
            if product_type == "product":
                query = query.filter(TaxPricing.applies_to_products == True)
            elif product_type == "service":
                query = query.filter(TaxPricing.applies_to_services == True)
        return query.order_by(TaxPricing.compound_order, TaxPricing.rate).all()

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
        country: Optional[str] = None,
        is_default: Optional[bool] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if tax_type:
            filters["tax_type"] = tax_type
        if country:
            filters["country"] = country
        if is_default is not None:
            filters["is_default"] = is_default
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# TAX GROUP REPOSITORIES
# ═══════════════════════════════════════════════════════════════════════════════


class TaxGroupRepository(BaseRepository[TaxGroup]):
    def __init__(self, db):
        super().__init__(db, TaxGroup)

    def get_by_code(self, organization_id: int, code: str) -> Optional[TaxGroup]:
        return self.get_first(organization_id, code=code)

    def get_default(self, organization_id: int) -> Optional[TaxGroup]:
        return self.get_first(organization_id, is_default=True, is_active=True)

    def list_by_country(
        self,
        organization_id: int,
        country: str,
        active_only: bool = True,
    ) -> List[TaxGroup]:
        return self.list_all(organization_id, active_only=active_only, country=country)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        country: Optional[str] = None,
        is_default: Optional[bool] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if country:
            filters["country"] = country
        if is_default is not None:
            filters["is_default"] = is_default
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "name",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["name", "code", "description"],
            **filters,
        )


class TaxGroupMemberRepository(BaseRepository[TaxGroupMember]):
    def __init__(self, db):
        super().__init__(db, TaxGroupMember)

    def list_by_group(self, organization_id: int, tax_group_id: int) -> List[TaxGroupMember]:
        query = self.db.query(TaxGroupMember).filter(
            TaxGroupMember.tax_group_id == tax_group_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(TaxGroupMember.display_order).all()

    def list_by_tax(self, organization_id: int, tax_pricing_id: int) -> List[TaxGroupMember]:
        query = self.db.query(TaxGroupMember).filter(
            TaxGroupMember.tax_pricing_id == tax_pricing_id,
        )
        query = self._org_filter(query, organization_id)
        return query.all()

    def create(self, organization_id: int, **data: Any) -> TaxGroupMember:
        return super().create(organization_id, **data)
