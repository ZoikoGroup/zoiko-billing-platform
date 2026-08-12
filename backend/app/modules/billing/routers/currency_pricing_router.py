from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.pricing_service import CurrencyPricingService
from app.modules.billing.schemas import (
    CurrencyPricingCreate, CurrencyPricingUpdate, CurrencyPricingResponse,
    CurrencyPricingListResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/currency-pricing", tags=["💱 Currency Pricing"])


@router.post("", response_model=CurrencyPricingResponse, status_code=status.HTTP_201_CREATED, summary="Create currency pricing", dependencies=[Depends(get_current_billing_admin)])
def create_currency_pricing(data: CurrencyPricingCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = CurrencyPricingService(db)
    return svc.create(organization_id=current_user.organization_id, created_by=current_user.id, **data.model_dump())


@router.get("", response_model=CurrencyPricingListResponse, summary="List currency pricing")
def list_currency_pricing(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    page: int = Query(1, ge=1), per_page: int = Query(20, ge=1),
    product_id: Optional[int] = Query(None), currency: Optional[str] = Query(None),
    search_term: Optional[str] = Query(None),
    sort_by: Optional[str] = Query("product_id"), sort_order: str = Query("asc"),
):
    svc = CurrencyPricingService(db)
    return svc.list(
        organization_id=current_user.organization_id, page=page, per_page=per_page,
        product_id=product_id, currency=currency,
        search_term=search_term, sort_by=sort_by or "product_id", sort_order=sort_order,
    )


@router.get("/by-product/{product_id}", response_model=list[CurrencyPricingResponse], summary="List currency pricing by product")
def list_currency_pricing_by_product(product_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = CurrencyPricingService(db)
    return svc.list_by_product(organization_id=current_user.organization_id, product_id=product_id)


@router.get("/{pk}", response_model=CurrencyPricingResponse, summary="Get currency pricing")
def get_currency_pricing(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = CurrencyPricingService(db)
    return svc.get(pk, organization_id=current_user.organization_id)


@router.put("/{pk}", response_model=CurrencyPricingResponse, summary="Update currency pricing", dependencies=[Depends(get_current_billing_admin)])
def update_currency_pricing(pk: int, data: CurrencyPricingUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = CurrencyPricingService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/{pk}", response_model=SuccessResponse, summary="Deactivate currency pricing", dependencies=[Depends(get_current_billing_admin)])
def deactivate_currency_pricing(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = CurrencyPricingService(db)
    svc.deactivate(pk, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Currency pricing deactivated successfully")
