from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.pricing_service import TaxPricingService
from app.modules.billing.schemas import (
    TaxPricingCreate, TaxPricingUpdate, TaxPricingResponse,
    TaxPricingListResponse,
    TaxGroupCreate, TaxGroupUpdate, TaxGroupResponse,
    TaxGroupListResponse,
    TaxGroupMemberCreate, TaxGroupMemberResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/tax-pricing", tags=["🧾 Tax Pricing"])


# ── Static routes first (before /{pk}) ────────────────────────────────────────

@router.post("", response_model=TaxPricingResponse, status_code=status.HTTP_201_CREATED, summary="Create tax pricing", dependencies=[Depends(get_current_billing_admin)])
def create_tax_pricing(data: TaxPricingCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.create(organization_id=current_user.organization_id, created_by=current_user.id, **data.model_dump())


@router.get("", response_model=TaxPricingListResponse, summary="List tax pricing")
def list_tax_pricing(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    page: int = Query(1, ge=1), per_page: int = Query(20, ge=1),
    tax_type: Optional[str] = Query(None), country: Optional[str] = Query(None),
    is_default: Optional[bool] = Query(None), search_term: Optional[str] = Query(None),
    sort_by: Optional[str] = Query("name"), sort_order: str = Query("asc"),
):
    svc = TaxPricingService(db)
    return svc.list(
        organization_id=current_user.organization_id, page=page, per_page=per_page,
        tax_type=tax_type, country=country, is_default=is_default,
        search_term=search_term, sort_by=sort_by or "name", sort_order=sort_order,
    )


@router.get("/applicable", response_model=list[TaxPricingResponse], summary="Get applicable tax pricing")
def get_applicable_tax_pricing(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    country: Optional[str] = Query(None), region: Optional[str] = Query(None),
    state: Optional[str] = Query(None), city: Optional[str] = Query(None),
    postal_code: Optional[str] = Query(None), product_type: Optional[str] = Query(None),
    date: Optional[str] = Query(None),
):
    svc = TaxPricingService(db)
    return svc.get_applicable(
        organization_id=current_user.organization_id,
        country=country, region=region, state=state,
        city=city, postal_code=postal_code, product_type=product_type, dt=date,
    )


# ── Tax Groups ────────────────────────────────────────────────────────────────

@router.post("/groups", response_model=TaxGroupResponse, status_code=status.HTTP_201_CREATED, summary="Create tax group", dependencies=[Depends(get_current_billing_admin)])
def create_tax_group(data: TaxGroupCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.create_group(organization_id=current_user.organization_id, created_by=current_user.id, **data.model_dump())


@router.get("/groups", response_model=TaxGroupListResponse, summary="List tax groups")
def list_tax_groups(
    db: Session = Depends(get_db), current_user=Depends(get_current_user),
    page: int = Query(1, ge=1), per_page: int = Query(20, ge=1),
    country: Optional[str] = Query(None), is_default: Optional[bool] = Query(None),
    search_term: Optional[str] = Query(None), sort_by: Optional[str] = Query("name"), sort_order: str = Query("asc"),
):
    svc = TaxPricingService(db)
    return svc.list_groups(
        organization_id=current_user.organization_id, page=page, per_page=per_page,
        country=country, is_default=is_default, search_term=search_term,
        sort_by=sort_by or "name", sort_order=sort_order,
    )


@router.get("/groups/{pk}", response_model=TaxGroupResponse, summary="Get tax group")
def get_tax_group(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.get_group(pk, organization_id=current_user.organization_id)


@router.put("/groups/{pk}", response_model=TaxGroupResponse, summary="Update tax group", dependencies=[Depends(get_current_billing_admin)])
def update_tax_group(pk: int, data: TaxGroupUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.update_group(pk, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/groups/{pk}", response_model=SuccessResponse, summary="Deactivate tax group", dependencies=[Depends(get_current_billing_admin)])
def deactivate_tax_group(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    svc.deactivate_group(pk, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Tax group deactivated successfully")


@router.post("/groups/{pk}/members", response_model=TaxGroupMemberResponse, status_code=status.HTTP_201_CREATED, summary="Add member to tax group", dependencies=[Depends(get_current_billing_admin)])
def add_tax_group_member(pk: int, data: TaxGroupMemberCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    payload = data.model_dump()
    payload.pop("tax_group_id", None)
    return svc.add_group_member(organization_id=current_user.organization_id, tax_group_id=pk, **payload)


@router.get("/groups/{pk}/members", response_model=list[TaxGroupMemberResponse], summary="List members of tax group")
def list_tax_group_members(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.list_group_members(organization_id=current_user.organization_id, tax_group_id=pk)


@router.delete("/groups/members/{member_id}", response_model=SuccessResponse, summary="Remove member from tax group", dependencies=[Depends(get_current_billing_admin)])
def remove_tax_group_member(member_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    svc.remove_group_member(member_id, organization_id=current_user.organization_id)
    return SuccessResponse(message="Tax group member removed successfully")


# ── Parameterized routes (must come after static) ─────────────────────────────

@router.get("/{pk}", response_model=TaxPricingResponse, summary="Get tax pricing")
def get_tax_pricing(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.get(pk, organization_id=current_user.organization_id)


@router.put("/{pk}", response_model=TaxPricingResponse, summary="Update tax pricing", dependencies=[Depends(get_current_billing_admin)])
def update_tax_pricing(pk: int, data: TaxPricingUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    return svc.update(pk, organization_id=current_user.organization_id, updated_by=current_user.id, **data.model_dump(exclude_unset=True))


@router.delete("/{pk}", response_model=SuccessResponse, summary="Deactivate tax pricing", dependencies=[Depends(get_current_billing_admin)])
def deactivate_tax_pricing(pk: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    svc = TaxPricingService(db)
    svc.deactivate(pk, organization_id=current_user.organization_id, updated_by=current_user.id)
    return SuccessResponse(message="Tax pricing deactivated successfully")
