import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
)
from app.modules.billing.models import (
    BillingAuditAction, PlanTier, PricingModel, PricingPlan,
    PriceList, PriceListItem, PricingRule, PricingRuleTier,
    Discount, DiscountStatus, DiscountUsage, CurrencyPricing, TaxPricing,
    TaxGroup, TaxGroupMember,
)
from app.modules.billing.repositories.catalog import (
    PlanTierRepository,
    PricingPlanRepository,
    PriceListRepository,
    PriceListItemRepository,
    PricingRuleRepository,
    PricingRuleTierRepository,
    DiscountRepository,
    DiscountUsageRepository,
    CurrencyPricingRepository,
    TaxPricingRepository,
    TaxGroupRepository,
    TaxGroupMemberRepository,
)
from app.modules.billing.repositories.catalog import ProductRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import filter_allowed, safe_commit_and_refresh

logger = logging.getLogger("zoiko")

PLAN_ALLOWED_FIELDS = {
    "name", "product_id", "billing_period",
    "billing_cycle_count", "trial_days", "unit_price", "setup_fee",
    "is_active", "pricing_model", "flat_fee",
    "min_quantity", "max_quantity", "effective_from", "effective_to",
}
PLAN_NULLABLE_FIELDS = {"unit_price", "max_quantity", "effective_to"}

TIER_ALLOWED_FIELDS = {
    "from_quantity", "to_quantity", "unit_price", "flat_fee",
}


class PricingService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = PricingPlanRepository(db)
        self.tier_repo = PlanTierRepository(db)
        self.product_repo = ProductRepository(db)
        self.audit = BillingAuditService(db)

    def create_plan(self, organization_id: int, created_by: int, **data: Any) -> PricingPlan:
        data = filter_allowed(data, PLAN_ALLOWED_FIELDS)
        product_id = data.get("product_id")
        if product_id:
            self.product_repo.get_by_id(product_id, organization_id)
        plan = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PricingPlan", plan.id, new_values=data)
        return plan

    def update_plan(self, plan_id: int, organization_id: int, updated_by: int, **data: Any) -> PricingPlan:
        raw_data = data
        data = filter_allowed(data, PLAN_ALLOWED_FIELDS)
        for field in PLAN_NULLABLE_FIELDS:
            if field in raw_data and raw_data[field] is None:
                data[field] = None
        current = self.repo.get_by_id(plan_id, organization_id)
        if data.get("product_id") and data["product_id"] != current.product_id:
            self.product_repo.get_by_id(data["product_id"], organization_id)
        min_quantity = data.get("min_quantity", current.min_quantity)
        max_quantity = data.get("max_quantity", current.max_quantity)
        if max_quantity is not None and max_quantity < min_quantity:
            raise BadRequestException("max_quantity must be greater than or equal to min_quantity")
        effective_from = data.get("effective_from", current.effective_from)
        effective_to = data.get("effective_to", current.effective_to)
        if effective_to is not None and effective_from is not None and effective_to < effective_from:
            raise BadRequestException("effective_to must be greater than or equal to effective_from")
        updated = self.repo.update(plan_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PricingPlan", plan_id, new_values=data)
        return updated

    def get_plan(self, plan_id: int, organization_id: int) -> PricingPlan:
        return self.repo.get_by_id(plan_id, organization_id)

    def list_plans(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        product_id: Optional[int] = None, billing_period: Optional[str] = None,
        sort_by: str = "name", sort_order: str = "asc", active_only: bool = False,
        search_term: Optional[str] = None, pricing_model: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order, active_only=active_only,
            product_id=product_id, billing_period=billing_period,
            search_term=search_term,
            pricing_model=pricing_model,
            status=status,
        )

    def list_plans_by_product(self, organization_id: int, product_id: int) -> List[PricingPlan]:
        self.product_repo.get_by_id(product_id, organization_id)
        return self.repo.list_by_product(organization_id, product_id)

    def get_active_plan_at_date(self, organization_id: int, product_id: int, date_str: str) -> Optional[PricingPlan]:
        self.product_repo.get_by_id(product_id, organization_id)
        return self.repo.get_active_at_date(organization_id, product_id, date_str)

    def deactivate_plan(self, plan_id: int, organization_id: int, updated_by: int) -> PricingPlan:
        self.repo.get_by_id(plan_id, organization_id)
        updated = self.repo.update(plan_id, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PricingPlan", plan_id)
        return updated

    # ── Tiers ───────────────────────────────────────────────────────────

    def add_tier(self, organization_id: int, pricing_plan_id: int, created_by: int, **data: Any) -> PlanTier:
        data = filter_allowed(data, TIER_ALLOWED_FIELDS)
        plan = self.repo.get_by_id(pricing_plan_id, organization_id)
        if plan.pricing_model not in (PricingModel.TIERED, PricingModel.VOLUME, PricingModel.GRADUATED):
            raise BadRequestException("Tiers can only be added to tiered, volume, or graduated pricing plans")
        tier = self.tier_repo.create(organization_id, pricing_plan_id=pricing_plan_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PlanTier", tier.id, new_values=data)
        return tier

    def list_tiers(self, pricing_plan_id: int, organization_id: int) -> List[PlanTier]:
        self.repo.get_by_id(pricing_plan_id, organization_id)
        return self.tier_repo.list_by_plan(organization_id, pricing_plan_id)

    def remove_tier(self, pricing_plan_id: int, tier_id: int, organization_id: int, updated_by: int) -> None:
        self.repo.get_by_id(pricing_plan_id, organization_id)
        tier = self.tier_repo.get_by_id(tier_id, organization_id)
        if tier.pricing_plan_id != pricing_plan_id:
            raise NotFoundException("PlanTier", tier_id)
        self.db.delete(tier)
        safe_commit_and_refresh(self.db)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "PlanTier", tier_id)


# ═══════════════════════════════════════════════════════════════════════════════
# PRICE LIST SERVICE
# ═══════════════════════════════════════════════════════════════════════════════


PRICE_LIST_ALLOWED = {
    "name", "code", "description", "currency", "is_default",
    "effective_from", "effective_to", "is_active", "status",
}


class PriceListService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = PriceListRepository(db)
        self.item_repo = PriceListItemRepository(db)
        self.product_repo = ProductRepository(db)
        self.audit = BillingAuditService(db)

    def create(self, organization_id: int, created_by: int, **data: Any) -> PriceList:
        data = filter_allowed(data, PRICE_LIST_ALLOWED)
        existing = self.repo.get_by_code(organization_id, data.get("code"))
        if existing:
            raise AlreadyExistsException("PriceList", data.get("code"))
        obj = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PriceList", obj.id, new_values=data)
        return obj

    def update(self, pk: int, organization_id: int, updated_by: int, **data: Any) -> PriceList:
        data = filter_allowed(data, PRICE_LIST_ALLOWED)
        current = self.repo.get_by_id(pk, organization_id)
        if data.get("code") and data["code"] != current.code:
            existing = self.repo.get_by_code(organization_id, data["code"])
            if existing:
                raise AlreadyExistsException("PriceList", data["code"])
        updated = self.repo.update(pk, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PriceList", pk, new_values=data)
        return updated

    def get(self, pk: int, organization_id: int) -> PriceList:
        return self.repo.get_by_id(pk, organization_id)

    def list(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        sort_by: str = "name", sort_order: str = "asc",
        status: Optional[str] = None, currency: Optional[str] = None,
        search_term: Optional[str] = None, active_only: bool = True,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order, active_only=active_only,
            status=status, currency=currency, search_term=search_term,
        )

    def deactivate(self, pk: int, organization_id: int, updated_by: int) -> PriceList:
        self.repo.get_by_id(pk, organization_id)
        updated = self.repo.update(pk, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PriceList", pk)
        return updated

    def get_default(self, organization_id: int) -> Optional[PriceList]:
        return self.repo.get_default(organization_id)

    # ── Items ────────────────────────────────────────────────────────────

    def _validate_item_product_ownership(self, organization_id: int, product_id: Optional[int]) -> None:
        if product_id is not None:
            self.product_repo.get_by_id(product_id, organization_id)

    def add_item(self, organization_id: int, price_list_id: int, created_by: int, **data: Any) -> PriceListItem:
        self.repo.get_by_id(price_list_id, organization_id)
        self._validate_item_product_ownership(organization_id, data.get("product_id"))
        item = self.item_repo.create(organization_id, price_list_id=price_list_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PriceListItem", item.id)
        return item

    def list_items(self, organization_id: int, price_list_id: int, active_only: bool = True) -> List[PriceListItem]:
        self.repo.get_by_id(price_list_id, organization_id)
        return self.item_repo.list_by_price_list(organization_id, price_list_id, active_only)

    def update_item(self, price_list_id: int, item_id: int, organization_id: int, updated_by: int, **data: Any) -> PriceListItem:
        self.repo.get_by_id(price_list_id, organization_id)
        self._validate_item_product_ownership(organization_id, data.get("product_id"))
        item = self.item_repo.get_by_id_and_price_list(item_id, organization_id, price_list_id)
        updated = self.item_repo.update(item.id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PriceListItem", item_id)
        return updated

    def remove_item(self, price_list_id: int, item_id: int, organization_id: int, updated_by: int) -> None:
        self.repo.get_by_id(price_list_id, organization_id)
        item = self.item_repo.get_by_id_and_price_list(item_id, organization_id, price_list_id)
        self.db.delete(item)
        safe_commit_and_refresh(self.db)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "PriceListItem", item_id)


# ═══════════════════════════════════════════════════════════════════════════════
# PRICING RULE SERVICE
# ═══════════════════════════════════════════════════════════════════════════════


PRICING_RULE_ALLOWED = {
    "name", "code", "description", "rule_type", "scope", "priority",
    "stackable", "max_stack_count", "value", "value_type",
    "min_quantity", "max_quantity", "buy_quantity", "get_quantity",
    "get_discount_percentage", "customer_id", "customer_group",
    "product_id", "product_category_id", "region", "country", "state",
    "currency", "effective_from", "effective_to",
    "valid_from_time", "valid_to_time", "days_of_week",
    "status", "is_active", "auto_apply", "requires_approval",
    "usage_limit", "per_customer_limit",
}


class PricingRuleService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = PricingRuleRepository(db)
        self.tier_repo = PricingRuleTierRepository(db)
        self.audit = BillingAuditService(db)

    def create(self, organization_id: int, created_by: int, **data: Any) -> PricingRule:
        data = filter_allowed(data, PRICING_RULE_ALLOWED)
        existing = self.repo.get_by_code(organization_id, data.get("code"))
        if existing:
            raise AlreadyExistsException("PricingRule", data.get("code"))
        obj = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PricingRule", obj.id, new_values=data)
        return obj

    def update(self, pk: int, organization_id: int, updated_by: int, **data: Any) -> PricingRule:
        data = filter_allowed(data, PRICING_RULE_ALLOWED)
        current = self.repo.get_by_id(pk, organization_id)
        if data.get("code") and data["code"] != current.code:
            existing = self.repo.get_by_code(organization_id, data["code"])
            if existing:
                raise AlreadyExistsException("PricingRule", data["code"])
        updated = self.repo.update(pk, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PricingRule", pk, new_values=data)
        return updated

    def get(self, pk: int, organization_id: int) -> PricingRule:
        return self.repo.get_by_id(pk, organization_id)

    def list(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        sort_by: str = "priority", sort_order: str = "desc",
        rule_type: Optional[str] = None, scope: Optional[str] = None,
        status: Optional[str] = None,
        product_id: Optional[int] = None, customer_id: Optional[int] = None,
        search_term: Optional[str] = None, active_only: bool = True,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order, active_only=active_only,
            rule_type=rule_type, scope=scope, status=status,
            product_id=product_id, customer_id=customer_id,
            search_term=search_term,
        )

    def deactivate(self, pk: int, organization_id: int, updated_by: int) -> PricingRule:
        self.repo.get_by_id(pk, organization_id)
        updated = self.repo.update(pk, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "PricingRule", pk)
        return updated

    def get_applicable(
        self, organization_id: int,
        product_id: Optional[int] = None, customer_id: Optional[int] = None,
        customer_group: Optional[str] = None, region: Optional[str] = None,
        country: Optional[str] = None, dt: Optional[str] = None,
    ) -> List[PricingRule]:
        return self.repo.get_applicable_rules(
            organization_id, product_id=product_id, customer_id=customer_id,
            customer_group=customer_group, region=region, country=country, date=dt,
        )

    # ── Tiers ────────────────────────────────────────────────────────────

    def add_tier(self, organization_id: int, pricing_rule_id: int, created_by: int, **data: Any) -> PricingRuleTier:
        self.repo.get_by_id(pricing_rule_id, organization_id)
        tier = self.tier_repo.create(organization_id, pricing_rule_id=pricing_rule_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "PricingRuleTier", tier.id)
        return tier

    def list_tiers(self, organization_id: int, pricing_rule_id: int) -> List[PricingRuleTier]:
        self.repo.get_by_id(pricing_rule_id, organization_id)
        return self.tier_repo.list_by_rule(organization_id, pricing_rule_id)

    def remove_tier(self, pricing_rule_id: int, tier_id: int, organization_id: int, updated_by: int) -> None:
        self.repo.get_by_id(pricing_rule_id, organization_id)
        tier = self.tier_repo.get_by_id(tier_id, organization_id)
        if tier.pricing_rule_id != pricing_rule_id:
            raise NotFoundException("PricingRuleTier", tier_id)
        self.db.delete(tier)
        safe_commit_and_refresh(self.db)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "PricingRuleTier", tier_id)


# ═══════════════════════════════════════════════════════════════════════════════
# DISCOUNT SERVICE
# ═══════════════════════════════════════════════════════════════════════════════


DISCOUNT_ALLOWED = {
    "name", "code", "description", "discount_type", "discount_value",
    "value_type", "min_order_amount", "max_discount_amount", "currency",
    "usage_limit", "per_customer_limit", "customer_id", "customer_group",
    "product_ids", "category_ids", "excluded_product_ids", "excluded_category_ids",
    "valid_from", "valid_to", "timezone", "stackable",
    "applies_to_sale_items", "applies_to_subscription", "first_order_only",
    "status", "is_active", "requires_approval", "auto_apply",
}


class DiscountService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = DiscountRepository(db)
        self.usage_repo = DiscountUsageRepository(db)
        self.audit = BillingAuditService(db)

    def create(self, organization_id: int, created_by: int, **data: Any) -> Discount:
        data = filter_allowed(data, DISCOUNT_ALLOWED)
        if data.get("code"):
            existing = self.repo.get_by_code(organization_id, data["code"])
            if existing:
                raise AlreadyExistsException("Discount", data["code"])
        obj = self.repo.create(organization_id, created_by=created_by, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Discount", obj.id, new_values=data)
        return obj

    def update(self, pk: int, organization_id: int, updated_by: int, **data: Any) -> Discount:
        data = filter_allowed(data, DISCOUNT_ALLOWED)
        current = self.repo.get_by_id(pk, organization_id)
        if data.get("code") and data["code"] != current.code:
            existing = self.repo.get_by_code(organization_id, data["code"])
            if existing:
                raise AlreadyExistsException("Discount", data["code"])
        updated = self.repo.update(pk, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Discount", pk, new_values=data)
        return updated

    def get(self, pk: int, organization_id: int) -> Discount:
        return self.repo.get_by_id(pk, organization_id)

    def list(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        sort_by: str = "name", sort_order: str = "asc",
        discount_type: Optional[str] = None, status: Optional[str] = None,
        customer_id: Optional[int] = None, search_term: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            discount_type=discount_type, status=status,
            customer_id=customer_id, search_term=search_term,
        )

    # ── Approval Workflow (§25 maker-checker) ───────────────────────────────
    # Draft -> Pending Approval -> Active
    #                           -> Rejected
    # Draft/Pending Approval -> Cancelled

    def _validate_status_transition(self, current: DiscountStatus, target: DiscountStatus) -> None:
        valid = {
            DiscountStatus.DRAFT: [DiscountStatus.PENDING_APPROVAL, DiscountStatus.CANCELLED],
            DiscountStatus.PENDING_APPROVAL: [DiscountStatus.ACTIVE, DiscountStatus.REJECTED, DiscountStatus.CANCELLED],
            DiscountStatus.ACTIVE: [DiscountStatus.PAUSED, DiscountStatus.CANCELLED, DiscountStatus.EXPIRED, DiscountStatus.EXHAUSTED],
            DiscountStatus.PAUSED: [DiscountStatus.ACTIVE, DiscountStatus.CANCELLED],
            DiscountStatus.REJECTED: [],
            DiscountStatus.CANCELLED: [],
            DiscountStatus.EXPIRED: [],
            DiscountStatus.EXHAUSTED: [],
        }
        if target not in valid.get(current, []):
            raise BadRequestException(f"Cannot transition discount from {current.value} to {target.value}")

    def submit_for_approval(self, pk: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> Discount:
        discount = self.repo.get_by_id(pk, organization_id)
        self._validate_status_transition(discount.status, DiscountStatus.PENDING_APPROVAL)
        old_status = discount.status.value
        discount.status = DiscountStatus.PENDING_APPROVAL
        safe_commit_and_refresh(self.db, discount)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE, "Discount", pk,
            old_values={"status": old_status}, new_values={"status": discount.status.value},
        )
        return discount

    def approve_discount(self, pk: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> Discount:
        discount = self.repo.get_by_id(pk, organization_id)
        # §25 SoD: the user who created a discount cannot approve it, even if
        # they hold a role that could approve someone else's.
        if discount.created_by == updated_by:
            raise ForbiddenException(
                "You cannot approve a discount you created yourself. "
                "Ask another Finance Approver to review it."
            )
        self._validate_status_transition(discount.status, DiscountStatus.ACTIVE)
        old_status = discount.status.value
        discount.status = DiscountStatus.ACTIVE
        discount.approved_by = updated_by
        discount.approved_at = datetime.utcnow()
        safe_commit_and_refresh(self.db, discount)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.APPROVE, "Discount", pk,
            old_values={"status": old_status}, new_values={"status": discount.status.value},
        )
        return discount

    def reject_discount(self, pk: int, organization_id: int, updated_by: int, reason: str) -> Discount:
        discount = self.repo.get_by_id(pk, organization_id)
        if discount.created_by == updated_by:
            raise ForbiddenException(
                "You cannot reject a discount you created yourself. "
                "Ask another Finance Approver to review it."
            )
        self._validate_status_transition(discount.status, DiscountStatus.REJECTED)
        old_status = discount.status.value
        discount.status = DiscountStatus.REJECTED
        safe_commit_and_refresh(self.db, discount)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.REJECT, "Discount", pk,
            old_values={"status": old_status}, new_values={"status": discount.status.value, "rejection_reason": reason},
        )
        return discount

    def deactivate(self, pk: int, organization_id: int, updated_by: int) -> Discount:
        self.repo.get_by_id(pk, organization_id)
        updated = self.repo.update(pk, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Discount", pk)
        return updated

    def get_valid_for_order(
        self, organization_id: int, order_amount: float,
        customer_id: Optional[int] = None,
        product_ids: Optional[List[int]] = None,
        category_ids: Optional[List[int]] = None,
    ) -> List[Discount]:
        return self.repo.list_valid_for_order(
            organization_id, order_amount=order_amount,
            customer_id=customer_id, product_ids=product_ids,
            category_ids=category_ids,
        )

    # ── Usage ────────────────────────────────────────────────────────────

    def log_usage(self, organization_id: int, discount_id: int, **data: Any) -> DiscountUsage:
        usage = self.usage_repo.create(organization_id, discount_id=discount_id, **data)
        return usage

    def get_usage(self, organization_id: int, discount_id: int, page: int = 1, per_page: int = 20) -> Dict[str, Any]:
        return self.usage_repo.list_by_discount(organization_id, discount_id, page=page, per_page=per_page)

    def get_usage_count(self, organization_id: int, discount_id: int) -> int:
        return self.usage_repo.get_usage_count(organization_id, discount_id)


# ═══════════════════════════════════════════════════════════════════════════════
# CURRENCY PRICING SERVICE
# ═══════════════════════════════════════════════════════════════════════════════


CURRENCY_PRICING_ALLOWED = {
    "product_id", "currency", "price", "cost_price", "price_list_id",
    "conversion_type", "exchange_rate", "exchange_rate_date", "is_active",
}


class CurrencyPricingService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = CurrencyPricingRepository(db)
        self.audit = BillingAuditService(db)

    def create(self, organization_id: int, created_by: int, **data: Any) -> CurrencyPricing:
        data = filter_allowed(data, CURRENCY_PRICING_ALLOWED)
        existing = self.repo.get_by_product_currency(
            organization_id, data.get("product_id"), data.get("currency")
        )
        if existing:
            raise AlreadyExistsException("CurrencyPricing", f"{data.get('product_id')}-{data.get('currency')}")
        obj = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "CurrencyPricing", obj.id, new_values=data)
        return obj

    def update(self, pk: int, organization_id: int, updated_by: int, **data: Any) -> CurrencyPricing:
        data = filter_allowed(data, CURRENCY_PRICING_ALLOWED)
        updated = self.repo.update(pk, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CurrencyPricing", pk, new_values=data)
        return updated

    def get(self, pk: int, organization_id: int) -> CurrencyPricing:
        return self.repo.get_by_id(pk, organization_id)

    def list(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        sort_by: str = "product_id", sort_order: str = "asc",
        product_id: Optional[int] = None, currency: Optional[str] = None,
        search_term: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            product_id=product_id, currency=currency, search_term=search_term,
        )

    def get_by_product_currency(self, organization_id: int, product_id: int, currency: str) -> Optional[CurrencyPricing]:
        return self.repo.get_by_product_currency(organization_id, product_id, currency)

    def list_by_product(self, organization_id: int, product_id: int) -> List[CurrencyPricing]:
        return self.repo.list_by_product(organization_id, product_id)

    def deactivate(self, pk: int, organization_id: int, updated_by: int) -> CurrencyPricing:
        self.repo.get_by_id(pk, organization_id)
        updated = self.repo.update(pk, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CurrencyPricing", pk)
        return updated


# ═══════════════════════════════════════════════════════════════════════════════
# TAX PRICING SERVICE
# ═══════════════════════════════════════════════════════════════════════════════


TAX_PRICING_ALLOWED = {
    "name", "code", "description", "tax_type", "tax_category_id",
    "country", "region", "state", "city", "postal_code",
    "rate", "pricing_type", "applies_to_products", "applies_to_services",
    "applies_to_shipping", "is_compound", "compound_order",
    "is_recoverable", "hsn_sac_code",
    "effective_from", "effective_to", "is_default", "is_active",
}


class TaxPricingService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = TaxPricingRepository(db)
        self.group_repo = TaxGroupRepository(db)
        self.member_repo = TaxGroupMemberRepository(db)
        self.audit = BillingAuditService(db)

    def create(self, organization_id: int, created_by: int, **data: Any) -> TaxPricing:
        data = filter_allowed(data, TAX_PRICING_ALLOWED)
        existing = self.repo.get_by_code(organization_id, data.get("code"))
        if existing:
            raise AlreadyExistsException("TaxPricing", data.get("code"))
        obj = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "TaxPricing", obj.id, new_values=data)
        return obj

    def update(self, pk: int, organization_id: int, updated_by: int, **data: Any) -> TaxPricing:
        data = filter_allowed(data, TAX_PRICING_ALLOWED)
        current = self.repo.get_by_id(pk, organization_id)
        if data.get("code") and data["code"] != current.code:
            existing = self.repo.get_by_code(organization_id, data["code"])
            if existing:
                raise AlreadyExistsException("TaxPricing", data["code"])
        updated = self.repo.update(pk, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "TaxPricing", pk, new_values=data)
        return updated

    def get(self, pk: int, organization_id: int) -> TaxPricing:
        return self.repo.get_by_id(pk, organization_id)

    def list(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        sort_by: str = "name", sort_order: str = "asc",
        tax_type: Optional[str] = None, country: Optional[str] = None,
        is_default: Optional[bool] = None, search_term: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            tax_type=tax_type, country=country, is_default=is_default,
            search_term=search_term,
        )

    def deactivate(self, pk: int, organization_id: int, updated_by: int) -> TaxPricing:
        self.repo.get_by_id(pk, organization_id)
        updated = self.repo.update(pk, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "TaxPricing", pk)
        return updated

    def get_applicable(
        self, organization_id: int,
        country: Optional[str] = None, region: Optional[str] = None,
        state: Optional[str] = None, city: Optional[str] = None,
        postal_code: Optional[str] = None, product_type: Optional[str] = None,
        dt: Optional[str] = None,
    ) -> List[TaxPricing]:
        return self.repo.get_applicable_taxes(
            organization_id, country=country, region=region, state=state,
            city=city, postal_code=postal_code, product_type=product_type, date=dt,
        )

    # ── Tax Groups ───────────────────────────────────────────────────────

    def create_group(self, organization_id: int, created_by: int, **data: Any) -> TaxGroup:
        existing = self.group_repo.get_by_code(organization_id, data.get("code"))
        if existing:
            raise AlreadyExistsException("TaxGroup", data.get("code"))
        obj = self.group_repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "TaxGroup", obj.id)
        return obj

    def update_group(self, pk: int, organization_id: int, updated_by: int, **data: Any) -> TaxGroup:
        current = self.group_repo.get_by_id(pk, organization_id)
        if data.get("code") and data["code"] != current.code:
            existing = self.group_repo.get_by_code(organization_id, data["code"])
            if existing:
                raise AlreadyExistsException("TaxGroup", data["code"])
        updated = self.group_repo.update(pk, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "TaxGroup", pk)
        return updated

    def get_group(self, pk: int, organization_id: int) -> TaxGroup:
        return self.group_repo.get_by_id(pk, organization_id)

    def deactivate_group(self, pk: int, organization_id: int, updated_by: int) -> TaxGroup:
        self.group_repo.get_by_id(pk, organization_id)
        updated = self.group_repo.update(pk, organization_id, is_active=False)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "TaxGroup", pk)
        return updated

    def list_groups(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        sort_by: str = "name", sort_order: str = "asc",
        country: Optional[str] = None, is_default: Optional[bool] = None,
        search_term: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.group_repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            country=country, is_default=is_default, search_term=search_term,
        )

    # ── Tax Group Members ────────────────────────────────────────────────

    def add_group_member(self, organization_id: int, tax_group_id: int, **data: Any) -> TaxGroupMember:
        self.group_repo.get_by_id(tax_group_id, organization_id)
        tax_pricing_id = data.get("tax_pricing_id")
        if tax_pricing_id is not None:
            self.repo.get_by_id(tax_pricing_id, organization_id)
        member = self.member_repo.create(organization_id, tax_group_id=tax_group_id, **data)
        return member

    def list_group_members(self, organization_id: int, tax_group_id: int) -> List[TaxGroupMember]:
        self.group_repo.get_by_id(tax_group_id, organization_id)
        return self.member_repo.list_by_group(organization_id, tax_group_id)

    def remove_group_member(self, pk: int, organization_id: int) -> None:
        member = self.member_repo.get_by_id(pk, organization_id)
        self.db.delete(member)
        safe_commit_and_refresh(self.db)
