"""
modules/billing/services/price_resolver.py
-------------------------------------------
Deterministic price resolution service.

Single backend boundary for resolving the authoritative unit_price
and provenance metadata for any billing line item.

Responsibilities:
  - Load Product, snapshot Product.default_price
  - If an explicit valid PricingPlan is supplied, resolve via that plan
  - For tiered/volume/graduated plans, evaluate PlanTier records by quantity
  - Return provenance metadata: base_price, resolved_price, pricing_plan_id,
    price_source, currency, pricing_model, tier_info

NOT responsible for:
  - Tax calculation
  - Discount calculation
  - Currency conversion
  - Invoice total calculation
"""

import logging
from decimal import Decimal
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import (
    PriceSource, PricingModel, PricingPlan, PlanTier, Product, ResolvedPriceType,
)

logger = logging.getLogger("zoiko")


@dataclass
class PriceResolution:
    """Result of a price resolution."""
    base_price: Decimal
    resolved_price: Decimal
    pricing_plan_id: Optional[int]
    price_source: str
    currency: Optional[str] = None
    pricing_model: Optional[str] = None
    tier_info: Optional[dict] = field(default=None)
    resolved_price_type: str = ResolvedPriceType.UNIT.value


class PriceResolver:
    """
    Resolves the authoritative unit_price for a billing line item.

    Resolution precedence:
      1. Load Product within organization/tenant scope
      2. Snapshot Product.default_price as base_price
      3. If an EXPLICIT valid PricingPlan is supplied:
         - Validate plan belongs to product and organization
         - For FLAT plans: use plan.unit_price
         - For TIERED/VOLUME/GRADUATED plans: evaluate PlanTier by quantity
         - price_source = PRICING_PLAN
      4. If no plan is supplied:
         - resolved_price = base_price
         - price_source = CATALOG
    """

    def __init__(self, db: Session):
        self.db = db

    def resolve(
        self,
        organization_id: int,
        product_id: int,
        pricing_plan_id: Optional[int] = None,
        quantity: Optional[Decimal] = None,
    ) -> PriceResolution:
        """
        Resolve price for a line item.

        Args:
            organization_id: Tenant/organization scope
            product_id: The product being priced
            pricing_plan_id: Optional explicit pricing plan
            quantity: Optional quantity for tiered pricing evaluation

        Returns:
            PriceResolution with base_price, resolved_price, pricing_plan_id,
            price_source, currency, pricing_model, tier_info

        Raises:
            NotFoundException: If product not found
            BadRequestException: If plan not found, not active, or mismatched
        """
        product = self._load_product(organization_id, product_id)
        base_price = Decimal(str(product.default_price or 0))
        currency = product.currency or "USD"

        if pricing_plan_id is not None:
            return self._resolve_with_plan(
                organization_id, product, base_price, pricing_plan_id, quantity
            )

        return PriceResolution(
            base_price=base_price,
            resolved_price=base_price,
            pricing_plan_id=None,
            price_source=PriceSource.CATALOG.value,
            currency=currency,
        )

    def _load_product(self, organization_id: int, product_id: int) -> Product:
        """Load and validate product within tenant scope."""
        product = (
            self.db.query(Product)
            .filter(
                Product.id == product_id,
                Product.organization_id == organization_id,
                Product.is_active == True,
            )
            .first()
        )
        if not product:
            raise NotFoundException("Product", product_id)
        return product

    def _resolve_with_plan(
        self,
        organization_id: int,
        product: Product,
        base_price: Decimal,
        pricing_plan_id: int,
        quantity: Optional[Decimal] = None,
    ) -> PriceResolution:
        """Resolve price using an explicit pricing plan."""
        plan = (
            self.db.query(PricingPlan)
            .filter(
                PricingPlan.id == pricing_plan_id,
                PricingPlan.organization_id == organization_id,
                PricingPlan.is_active == True,
            )
            .first()
        )
        if not plan:
            raise NotFoundException("PricingPlan", pricing_plan_id)

        if plan.product_id != product.id:
            raise BadRequestException(
                f"PricingPlan {pricing_plan_id} does not belong to Product {product.id}"
            )

        currency = product.currency or "USD"
        pricing_model = plan.pricing_model.value if plan.pricing_model else PricingModel.FLAT.value

        if pricing_model in (
            PricingModel.TIERED.value,
            PricingModel.VOLUME.value,
            PricingModel.GRADUATED.value,
        ):
            return self._resolve_tiered(
                plan, base_price, pricing_plan_id, currency,
                pricing_model, quantity,
            )

        if plan.unit_price is None:
            logger.warning(
                "PricingPlan %d has NULL unit_price, falling back to Product base price",
                pricing_plan_id,
            )
            return PriceResolution(
                base_price=base_price,
                resolved_price=base_price,
                pricing_plan_id=pricing_plan_id,
                price_source=PriceSource.CATALOG.value,
                currency=currency,
                pricing_model=pricing_model,
            )

        resolved_price = Decimal(str(plan.unit_price))

        return PriceResolution(
            base_price=base_price,
            resolved_price=resolved_price,
            pricing_plan_id=pricing_plan_id,
            price_source=PriceSource.PRICING_PLAN.value,
            currency=currency,
            pricing_model=pricing_model,
        )

    def _resolve_tiered(
        self,
        plan: PricingPlan,
        base_price: Decimal,
        pricing_plan_id: int,
        currency: str,
        pricing_model: str,
        quantity: Optional[Decimal] = None,
    ) -> PriceResolution:
        """
        Resolve price for tiered/volume/graduated pricing plans.

        For VOLUME pricing: one tier price applies to the entire quantity.
        For GRADUATED pricing: each tier's price applies to the quantity range.
        For TIERED pricing: treated same as VOLUME (entire quantity at one tier).

        If quantity is None or tiers are empty, returns the plan's unit_price
        as a fallback (which may be 0 for tiered plans).
        """
        tiers = (
            self.db.query(PlanTier)
            .filter(PlanTier.pricing_plan_id == plan.id)
            .order_by(PlanTier.from_quantity)
            .all()
        )

        plan_flat_fee = Decimal(str(plan.flat_fee or 0))

        if not tiers:
            unit_price = Decimal(str(plan.unit_price or 0))
            if quantity is not None and quantity > 0 and plan_flat_fee > 0:
                resolved_price = unit_price * Decimal(str(quantity)) + plan_flat_fee
                return PriceResolution(
                    base_price=base_price,
                    resolved_price=resolved_price,
                    pricing_plan_id=pricing_plan_id,
                    price_source=PriceSource.PRICING_PLAN.value,
                    currency=currency,
                    pricing_model=pricing_model,
                    resolved_price_type=ResolvedPriceType.LUMP_SUM.value,
                    tier_info={
                        "model": pricing_model, "tier_count": 0,
                        "message": "No tiers configured",
                        "plan_flat_fee": float(plan_flat_fee),
                    },
                )
            return PriceResolution(
                base_price=base_price,
                resolved_price=unit_price,
                pricing_plan_id=pricing_plan_id,
                price_source=PriceSource.PRICING_PLAN.value,
                currency=currency,
                pricing_model=pricing_model,
                tier_info={"model": pricing_model, "tier_count": 0, "message": "No tiers configured"},
            )

        if quantity is None or quantity <= 0:
            min_price = min(
                (t.unit_price for t in tiers if t.unit_price is not None),
                default=Decimal("0"),
            )
            max_price = max(
                (t.unit_price for t in tiers if t.unit_price is not None),
                default=Decimal("0"),
            )
            return PriceResolution(
                base_price=base_price,
                resolved_price=min_price,
                pricing_plan_id=pricing_plan_id,
                price_source=PriceSource.PRICING_PLAN.value,
                currency=currency,
                pricing_model=pricing_model,
                # Advisory preview price only — treated as a per-unit price;
                # never used as the authoritative line total.
                resolved_price_type=ResolvedPriceType.UNIT.value,
                tier_info={
                    "model": pricing_model,
                    "tier_count": len(tiers),
                    "price_range": {"min": float(min_price), "max": float(max_price)},
                    "message": "Select a quantity to see the exact price",
                },
            )

        qty = int(quantity)

        if pricing_model in (PricingModel.VOLUME.value, PricingModel.TIERED.value):
            matching_tier = self._find_tier(tiers, qty)
            in_range = self._is_quantity_in_range(tiers, qty)
            if matching_tier and matching_tier.unit_price is not None:
                tier_flat_fee = Decimal(str(matching_tier.flat_fee or 0))
                total_flat_fee = tier_flat_fee + plan_flat_fee
                tier_info = {
                    "model": pricing_model,
                    "tier_count": len(tiers),
                    "applied_tier": {
                        "from": matching_tier.from_quantity,
                        "to": matching_tier.to_quantity,
                        "unit_price": float(matching_tier.unit_price),
                        "flat_fee": float(tier_flat_fee),
                    },
                }
                if not in_range:
                    tier_info["out_of_range"] = True
                    tier_info["message"] = (
                        f"Quantity {qty} exceeds defined tier range. "
                        f"Using highest tier price."
                    )
                if total_flat_fee > 0:
                    tier_info["plan_flat_fee"] = float(plan_flat_fee)
                    resolved_price = Decimal(str(matching_tier.unit_price)) * Decimal(qty) + total_flat_fee
                    return PriceResolution(
                        base_price=base_price,
                        resolved_price=resolved_price,
                        pricing_plan_id=pricing_plan_id,
                        price_source=PriceSource.PRICING_PLAN.value,
                        currency=currency,
                        pricing_model=pricing_model,
                        # resolved_price already includes qty * unit_price + flat fees —
                        # callers must NOT multiply by quantity again.
                        resolved_price_type=ResolvedPriceType.LUMP_SUM.value,
                        tier_info=tier_info,
                    )
                return PriceResolution(
                    base_price=base_price,
                    resolved_price=Decimal(str(matching_tier.unit_price)),
                    pricing_plan_id=pricing_plan_id,
                    price_source=PriceSource.PRICING_PLAN.value,
                    currency=currency,
                    pricing_model=pricing_model,
                    tier_info=tier_info,
                )

        if pricing_model == PricingModel.GRADUATED.value:
            total = Decimal("0")
            remaining = qty
            applied_tiers = []
            for tier in tiers:
                if remaining <= 0:
                    break
                tier_start = tier.from_quantity
                tier_end = tier.to_quantity
                if tier_end is None:
                    tier_qty = remaining
                else:
                    tier_qty = min(remaining, tier_end - tier_start + 1)
                if tier.unit_price is not None:
                    tier_flat_fee = Decimal(str(tier.flat_fee or 0))
                    total += tier_qty * Decimal(str(tier.unit_price)) + tier_flat_fee
                    applied_tiers.append({
                        "from": tier.from_quantity,
                        "to": tier.to_quantity,
                        "unit_price": float(tier.unit_price),
                        "quantity_in_tier": tier_qty,
                        "flat_fee": float(tier_flat_fee),
                    })
                remaining -= tier_qty
            total += plan_flat_fee
            return PriceResolution(
                base_price=base_price,
                resolved_price=total,
                pricing_plan_id=pricing_plan_id,
                price_source=PriceSource.PRICING_PLAN.value,
                currency=currency,
                pricing_model=pricing_model,
                # resolved_price is the FULL line total for the given quantity.
                # Callers must NOT multiply by quantity again (that was the old
                # double-counting bug).
                resolved_price_type=ResolvedPriceType.GRADUATED_TOTAL.value,
                tier_info={
                    "model": pricing_model,
                    "tier_count": len(tiers),
                    "applied_tiers": applied_tiers,
                    "plan_flat_fee": float(plan_flat_fee),
                    "total_for_quantity": float(total),
                    "effective_per_unit": float(total / qty) if qty > 0 else 0,
                },
            )

        resolved_price = Decimal(str(plan.unit_price or 0))
        return PriceResolution(
            base_price=base_price,
            resolved_price=resolved_price,
            pricing_plan_id=pricing_plan_id,
            price_source=PriceSource.PRICING_PLAN.value,
            currency=currency,
            pricing_model=pricing_model,
            tier_info={"model": pricing_model, "tier_count": len(tiers)},
        )

    @staticmethod
    def _find_tier(tiers: list, quantity: int) -> Optional[PlanTier]:
        """Find the matching tier for a given quantity (volume pricing).

        Returns the first tier whose range includes the quantity.
        If no tier matches (quantity exceeds all defined ranges),
        returns the last tier as a fallback — standard volume pricing behavior.
        """
        for tier in tiers:
            to_qty = tier.to_quantity
            if to_qty is None or tier.from_quantity <= quantity <= to_qty:
                return tier
        return tiers[-1] if tiers else None

    @staticmethod
    def _is_quantity_in_range(tiers: list, quantity: int) -> bool:
        """Check if quantity falls within any defined tier range."""
        for tier in tiers:
            to_qty = tier.to_quantity
            if to_qty is None:
                return True
            if tier.from_quantity <= quantity <= to_qty:
                return True
        return False


def resolve_from_context(
    db: Session,
    organization_id: int,
    product_id: Optional[int],
    pricing_plan_id: Optional[int] = None,
    unit_price: Optional[Decimal] = None,
    quantity: Optional[Decimal] = None,
    existing_base_price: Optional[Decimal] = None,
    existing_resolved_price: Optional[Decimal] = None,
    existing_price_source: Optional[str] = None,
) -> dict:
    """
    Convenience function: resolve price or preserve existing provenance.

    Used by services when adding items. Behavior:
      - If product_id is provided and no existing provenance: resolve from catalog/plan
      - If existing provenance is already set: preserve it
      - If unit_price is provided but no product_id: use unit_price as-is, no provenance

    Returns dict with keys: base_price, resolved_price, pricing_plan_id, price_source,
    currency, pricing_model, tier_info, resolved_price_type
    """
    if existing_price_source is not None:
        return {
            "base_price": existing_base_price,
            "resolved_price": existing_resolved_price,
            "pricing_plan_id": pricing_plan_id,
            "price_source": existing_price_source,
            "currency": None,
            "pricing_model": None,
            "tier_info": None,
        }

    if product_id is not None:
        resolver = PriceResolver(db)
        result = resolver.resolve(
            organization_id=organization_id,
            product_id=product_id,
            pricing_plan_id=pricing_plan_id,
            quantity=quantity,
        )
        return {
            "base_price": result.base_price,
            "resolved_price": result.resolved_price,
            "pricing_plan_id": result.pricing_plan_id,
            "price_source": result.price_source,
            "currency": result.currency,
            "pricing_model": result.pricing_model,
            "tier_info": result.tier_info,
            "resolved_price_type": result.resolved_price_type,
        }

    return {
        "base_price": None,
        "resolved_price": None,
        "pricing_plan_id": None,
        "price_source": None,
        "currency": None,
        "pricing_model": None,
        "tier_info": None,
        "resolved_price_type": ResolvedPriceType.UNIT.value,
    }
