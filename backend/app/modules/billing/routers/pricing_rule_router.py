from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.pricing_service import PricingRuleService
from app.modules.billing.schemas import (
    PricingRuleCreate, PricingRuleUpdate, PricingRuleResponse, PricingRuleListResponse,
    PricingRuleTierCreate, PricingRuleTierResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/pricing-rules", tags=["📋 Pricing Rules"])


@router.post("", response_model=PricingRuleResponse, status_code=status.HTTP_201_CREATED, summary="Create a pricing rule", dependencies=[Depends(get_current_billing_admin)])
def create_pricing_rule(data: PricingRuleCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    return svc.create(organization_id=current_user.organization_id, created_by=current_user.id, **data.model_dump())


@router.get("", response_model=PricingRuleListResponse, summary="List pricing rules")
def list_pricing_rules(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    page: int = Query(1, ge=1), per_page: int = Query(20, ge=1),
    rule_type: Optional[str] = Query(None), scope: Optional[str] = Query(None),
    status: Optional[str] = Query(None), product_id: Optional[int] = Query(None),
    customer_id: Optional[int] = Query(None), search_term: Optional[str] = Query(None),
    sort_by: Optional[str] = Query("priority"), sort_order: str = Query("desc"),
    active_only: bool = Query(True, description="Set false to include deactivated pricing rules"),
):
    svc = PricingRuleService(db)
    return svc.list(
        organization_id=current_user.organization_id, page=page, per_page=per_page,
        rule_type=rule_type, scope=scope, status=status,
        product_id=product_id, customer_id=customer_id,
        search_term=search_term, sort_by=sort_by or "priority", sort_order=sort_order,
        active_only=active_only,
    )


@router.get("/applicable", response_model=list[PricingRuleResponse], summary="Get applicable pricing rules")
def get_applicable_rules(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    product_id: Optional[int] = Query(None), customer_id: Optional[int] = Query(None),
    customer_group: Optional[str] = Query(None), region: Optional[str] = Query(None),
    country: Optional[str] = Query(None), date: Optional[str] = Query(None),
):
    svc = PricingRuleService(db)
    return svc.get_applicable(
        organization_id=current_user.organization_id,
        product_id=product_id, customer_id=customer_id,
        customer_group=customer_group, region=region,
        country=country, dt=date,
    )


@router.get("/{pk}", response_model=PricingRuleResponse, summary="Get a pricing rule")
def get_pricing_rule(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    return svc.get(pk, organization_id=current_user.organization_id)


@router.put("/{pk}", response_model=PricingRuleResponse, summary="Update a pricing rule", dependencies=[Depends(get_current_billing_admin)])
def update_pricing_rule(pk: int, data: PricingRuleUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/{pk}", response_model=SuccessResponse, summary="Deactivate a pricing rule", dependencies=[Depends(get_current_billing_admin)])
def deactivate_pricing_rule(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    svc.deactivate(pk, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Pricing rule deactivated successfully")


@router.post("/{pk}/activate", response_model=PricingRuleResponse, summary="Reactivate a pricing rule", dependencies=[Depends(get_current_billing_admin)])
def activate_pricing_rule(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, is_active=True)


@router.post("/{pk}/tiers", response_model=PricingRuleTierResponse, status_code=status.HTTP_201_CREATED, summary="Add tier to pricing rule", dependencies=[Depends(get_current_billing_admin)])
def add_pricing_rule_tier(pk: int, data: PricingRuleTierCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    payload = data.model_dump(exclude_unset=True)
    payload.pop("pricing_rule_id", None)
    return svc.add_tier(organization_id=current_user.organization_id, pricing_rule_id=pk, created_by=current_user.id, **payload)


@router.get("/{pk}/tiers", response_model=list[PricingRuleTierResponse], summary="List tiers for a pricing rule")
def list_pricing_rule_tiers(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    return svc.list_tiers(organization_id=current_user.organization_id, pricing_rule_id=pk)


@router.delete("/{pk}/tiers/{tier_id}", response_model=SuccessResponse, summary="Remove tier from pricing rule", dependencies=[Depends(get_current_billing_admin)])
def remove_pricing_rule_tier(pk: int, tier_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PricingRuleService(db)
    svc.remove_tier(pricing_rule_id=pk, tier_id=tier_id, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Pricing rule tier removed successfully")
