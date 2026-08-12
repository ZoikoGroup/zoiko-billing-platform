from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import TaxService
from app.modules.billing.schemas import (
    TaxRateCreate,
    TaxRateUpdate,
    TaxRateResponse,
    TaxRateListResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/tax-rates", tags=["🧾 Tax"])


@router.post(
    "",
    response_model=TaxRateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a tax rate",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_tax_rate(
    data: TaxRateCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.create_tax_rate(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **data.model_dump(),
    )


@router.get(
    "",
    response_model=TaxRateListResponse,
    summary="List tax rates",
)
def list_tax_rates(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    tax_type: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    country_code: Optional[str] = Query(None, min_length=2, max_length=2, description="ISO 3166-1 alpha-2 country code"),
    is_active: Optional[bool] = Query(None, description="Filter by active status; omit for all rates"),
):
    svc = TaxService(db)
    if tax_type and tax_type.lower() in ("both", "all"):
        tax_type = None
    return svc.list_tax_rates(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        tax_type=tax_type,
        currency_code=currency,
        country_code=country_code,
        is_active=is_active,
    )


# ── Static paths MUST come before /{rate_id} to avoid FastAPI matching them as int ──

@router.get(
    "/summary",
    response_model=dict,
    summary="Get tax summary",
    dependencies=[Depends(get_current_billing_admin)],
)
def get_tax_summary(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_tax_summary(
        organization_id=current_user.organization_id,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/default",
    response_model=Optional[TaxRateResponse],
    summary="Get default tax rate for a currency",
)
def get_default_tax_rate(
    currency: str = Query(..., min_length=3, max_length=3),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_default_tax_rate_by_currency(
        organization_id=current_user.organization_id,
        currency_code=currency,
    )


@router.get(
    "/applicable",
    response_model=list[TaxRateResponse],
    summary="Get applicable tax rates",
)
def get_applicable_rates(
    taxable_type: str = Query("both"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_applicable_rates(
        organization_id=current_user.organization_id,
        taxable_type=taxable_type,
    )


@router.get(
    "/{rate_id}",
    response_model=TaxRateResponse,
    summary="Get a tax rate",
)
def get_tax_rate(
    rate_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_tax_rate(
        rate_id=rate_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/{rate_id}",
    response_model=TaxRateResponse,
    summary="Update a tax rate",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_tax_rate(
    rate_id: int,
    data: TaxRateUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.update_tax_rate(
        rate_id=rate_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.delete(
    "/{rate_id}",
    response_model=SuccessResponse,
    summary="Delete a tax rate",
    dependencies=[Depends(get_current_billing_admin)],
)
def delete_tax_rate(
    rate_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    svc.delete_tax_rate(
        rate_id=rate_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Tax rate deleted successfully")


@router.post(
    "/calculate",
    response_model=list[dict],
    summary="Calculate taxes",
)
def calculate_taxes(
    taxable_amount: float = Query(...),
    jurisdiction: Optional[str] = Query(None),
    tax_type_filter: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    if tax_type_filter and tax_type_filter.lower() in ("both", "all"):
        tax_type_filter = None
    return svc.calculate_taxes(
        organization_id=current_user.organization_id,
        taxable_amount=Decimal(str(taxable_amount)),
        jurisdiction=jurisdiction,
        tax_type_filter=tax_type_filter,
    )
