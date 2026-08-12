from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.pricing_service import PriceListService
from app.modules.billing.schemas import (
    PriceListCreate, PriceListUpdate, PriceListResponse, PriceListListResponse,
    PriceListItemCreate, PriceListItemUpdate, PriceListItemResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/price-lists", tags=["💰 Price Lists"])


@router.post("", response_model=PriceListResponse, status_code=status.HTTP_201_CREATED, summary="Create a price list", dependencies=[Depends(get_current_billing_admin)])
def create_price_list(data: PriceListCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    return svc.create(organization_id=current_user.organization_id, created_by=current_user.id, **data.model_dump())


@router.get("", response_model=PriceListListResponse, summary="List price lists")
def list_price_lists(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    page: int = Query(1, ge=1), per_page: int = Query(20, ge=1),
    status: Optional[str] = Query(None), currency: Optional[str] = Query(None),
    search_term: Optional[str] = Query(None), sort_by: Optional[str] = Query("name"), sort_order: str = Query("asc"),
    active_only: bool = Query(True, description="Set false to include deactivated price lists"),
):
    svc = PriceListService(db)
    return svc.list(organization_id=current_user.organization_id, page=page, per_page=per_page, status=status, currency=currency, search_term=search_term, sort_by=sort_by or "name", sort_order=sort_order, active_only=active_only)


@router.get("/default", response_model=PriceListResponse, summary="Get default price list")
def get_default_price_list(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    result = svc.get_default(organization_id=current_user.organization_id)
    if not result:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("PriceList", "default")
    return result


@router.get("/{pk}", response_model=PriceListResponse, summary="Get a price list")
def get_price_list(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    return svc.get(pk, organization_id=current_user.organization_id)


@router.put("/{pk}", response_model=PriceListResponse, summary="Update a price list", dependencies=[Depends(get_current_billing_admin)])
def update_price_list(pk: int, data: PriceListUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/{pk}", response_model=SuccessResponse, summary="Deactivate a price list", dependencies=[Depends(get_current_billing_admin)])
def deactivate_price_list(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    svc.deactivate(pk, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Price list deactivated successfully")


@router.post("/{pk}/activate", response_model=PriceListResponse, summary="Reactivate a price list", dependencies=[Depends(get_current_billing_admin)])
def activate_price_list(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, is_active=True)


@router.post("/{pk}/items", response_model=PriceListItemResponse, status_code=status.HTTP_201_CREATED, summary="Add item to price list", dependencies=[Depends(get_current_billing_admin)])
def add_price_list_item(pk: int, data: PriceListItemCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    payload = data.model_dump(exclude_unset=True)
    payload.pop("price_list_id", None)
    return svc.add_item(organization_id=current_user.organization_id, price_list_id=pk, created_by=current_user.id, **payload)


@router.get("/{pk}/items", response_model=list[PriceListItemResponse], summary="List items in a price list")
def list_price_list_items(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    return svc.list_items(organization_id=current_user.organization_id, price_list_id=pk)


@router.put("/{pk}/items/{item_id}", response_model=PriceListItemResponse, summary="Update price list item", dependencies=[Depends(get_current_billing_admin)])
def update_price_list_item(pk: int, item_id: int, data: PriceListItemUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    return svc.update_item(item_id, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/{pk}/items/{item_id}", response_model=SuccessResponse, summary="Remove price list item", dependencies=[Depends(get_current_billing_admin)])
def remove_price_list_item(pk: int, item_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = PriceListService(db)
    svc.remove_item(item_id, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Price list item removed successfully")
