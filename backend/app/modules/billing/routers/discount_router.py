from typing import List, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin, get_current_finance_approver
from app.modules.billing.services.pricing_service import DiscountService
from app.modules.billing.schemas import (
    DiscountApproveRequest, DiscountCreate, DiscountRejectRequest, DiscountUpdate,
    DiscountResponse, DiscountListResponse, DiscountUsageResponse, SuccessResponse,
)

router = APIRouter(prefix="/discounts", tags=["🏷️ Discounts"])


@router.post("", response_model=DiscountResponse, status_code=status.HTTP_201_CREATED, summary="Create a discount", dependencies=[Depends(get_current_billing_admin)])
def create_discount(data: DiscountCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    return svc.create(organization_id=current_user.organization_id, created_by=current_user.id, **data.model_dump())


@router.get("", response_model=DiscountListResponse, summary="List discounts")
def list_discounts(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    page: int = Query(1, ge=1), per_page: int = Query(20, ge=1),
    discount_type: Optional[str] = Query(None), status: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None), search_term: Optional[str] = Query(None),
    sort_by: Optional[str] = Query("name"), sort_order: str = Query("asc"),
):
    svc = DiscountService(db)
    return svc.list(
        organization_id=current_user.organization_id, page=page, per_page=per_page,
        discount_type=discount_type, status=status,
        customer_id=customer_id, search_term=search_term,
        sort_by=sort_by or "name", sort_order=sort_order,
    )


@router.get("/valid-for-order", response_model=list[DiscountResponse], summary="Get discounts valid for an order")
def get_valid_discounts(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    order_amount: float = Query(..., ge=0),
    customer_id: Optional[int] = Query(None),
    product_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
):
    svc = DiscountService(db)
    pid_list: Optional[List[int]] = None
    cid_list: Optional[List[int]] = None
    if product_ids:
        pid_list = [int(x) for x in product_ids.split(",") if x.strip().isdigit()]
    if category_ids:
        cid_list = [int(x) for x in category_ids.split(",") if x.strip().isdigit()]
    return svc.get_valid_for_order(
        organization_id=current_user.organization_id,
        order_amount=order_amount, customer_id=customer_id,
        product_ids=pid_list, category_ids=cid_list,
    )


@router.get("/{pk}", response_model=DiscountResponse, summary="Get a discount")
def get_discount(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    return svc.get(pk, organization_id=current_user.organization_id)


@router.put("/{pk}", response_model=DiscountResponse, summary="Update a discount", dependencies=[Depends(get_current_billing_admin)])
def update_discount(pk: int, data: DiscountUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/{pk}", response_model=SuccessResponse, summary="Deactivate a discount", dependencies=[Depends(get_current_billing_admin)])
def deactivate_discount(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    svc.deactivate(pk, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Discount deactivated successfully")


@router.post("/{pk}/submit", response_model=DiscountResponse, summary="Submit a discount for approval", dependencies=[Depends(get_current_billing_admin)])
def submit_discount_for_approval(pk: int, body: DiscountApproveRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    return svc.submit_for_approval(pk, organization_id=current_user.organization_id, updated_by=current_user.id, reason=body.reason)


@router.post("/{pk}/approve", response_model=DiscountResponse, summary="Approve a discount", dependencies=[Depends(get_current_finance_approver)])
def approve_discount(pk: int, body: DiscountApproveRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    return svc.approve_discount(pk, organization_id=current_user.organization_id, updated_by=current_user.id, reason=body.reason)


@router.post("/{pk}/reject", response_model=DiscountResponse, summary="Reject a discount", dependencies=[Depends(get_current_finance_approver)])
def reject_discount(pk: int, body: DiscountRejectRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    return svc.reject_discount(pk, organization_id=current_user.organization_id, updated_by=current_user.id, reason=body.reason)


@router.get("/{pk}/usage", response_model=dict, summary="Get discount usage")
def get_discount_usage(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user), page: int = Query(1, ge=1), per_page: int = Query(20, ge=1)):
    svc = DiscountService(db)
    svc.get(pk, organization_id=current_user.organization_id)
    return svc.get_usage(organization_id=current_user.organization_id, discount_id=pk, page=page, per_page=per_page)


@router.get("/{pk}/usage-count", response_model=dict, summary="Get discount usage count")
def get_discount_usage_count(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = DiscountService(db)
    svc.get(pk, organization_id=current_user.organization_id)
    count = svc.get_usage_count(organization_id=current_user.organization_id, discount_id=pk)
    return {"discount_id": pk, "usage_count": count}
