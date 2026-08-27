"""
modules/billing/routers/contract_router.py
"""

from datetime import date
from typing import Optional, List

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import ContractService
from app.modules.commercial.entitlement_enforcement import EntitlementEnforcementService
from app.modules.billing.schemas import (
    ContractCreate,
    ContractUpdate,
    ContractResponse,
    ContractListResponse,
    ContractItemCreate,
    ContractItemBulkCreate,
    ContractItemResponse,
    ConvertQuotationRequest,
    SuccessResponse,
    InvoiceResponse,
    ContractAmendmentCreate,
    ContractAmendmentResponse,
    ContractTerminateRequest,
)

router = APIRouter(prefix="/contracts", tags=["🧾 Contracts"])


@router.post(
    "",
    response_model=ContractResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_contract(
    data: ContractCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.create_contract(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        customer_id=data.customer_id,
        contract_number=data.contract_number,
        **data.model_dump(exclude={"customer_id", "contract_number"}, exclude_unset=True),
    )


@router.get(
    "",
    response_model=ContractListResponse,
    summary="List contracts",
)
def list_contracts(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    quotation_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    sort_by: Optional[str] = Query("created_at"),
    sort_order: str = Query("desc"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
):
    svc = ContractService(db)
    return svc.list_contracts(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        quotation_id=quotation_id,
        status=status,
        sort_by=sort_by or "created_at",
        sort_order=sort_order,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/active",
    response_model=List[ContractResponse],
    summary="List active contracts",
)
def list_active_contracts(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.list_active_contracts(organization_id=current_user.organization_id)


@router.get(
    "/expiring",
    response_model=List[ContractResponse],
    summary="List expiring contracts",
)
def list_expiring_contracts(
    within_days: int = Query(30, ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.list_expiring_contracts(
        organization_id=current_user.organization_id,
        within_days=within_days,
    )


@router.get(
    "/summary",
    summary="Get contract summary and aggregate KPIs over full dataset",
)
def get_contract_summary(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
):
    svc = ContractService(db)
    return svc.get_contract_summary(
        organization_id=current_user.organization_id,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/{contract_id}",
    response_model=ContractResponse,
    summary="Get a contract",
)
def get_contract(
    contract_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.get_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/{contract_id}",
    response_model=ContractResponse,
    summary="Update a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_contract(
    contract_id: int,
    data: ContractUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.update_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.delete(
    "/{contract_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete/soft-delete a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def delete_contract(
    contract_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    svc.soft_delete_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        deleted_by=current_user.id,
    )


@router.put(
    "/{contract_id}/activate",
    response_model=ContractResponse,
    summary="Activate a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def activate_contract(
    contract_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.activate_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.put(
    "/{contract_id}/terminate",
    response_model=ContractResponse,
    summary="Terminate a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def terminate_contract(
    contract_id: int,
    payload: Optional[ContractTerminateRequest] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    reason = payload.reason if payload else None
    return svc.terminate_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        reason=reason,
    )


@router.put(
    "/{contract_id}/cancel",
    response_model=ContractResponse,
    summary="Cancel a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def cancel_contract(
    contract_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.cancel_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.put(
    "/{contract_id}/renew",
    response_model=ContractResponse,
    summary="Renew a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def renew_contract(
    contract_id: int,
    new_end_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.renew_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        new_end_date=new_end_date,
    )


# ── Contract Items ──────────────────────────────────────────────


@router.get(
    "/{contract_id}/items",
    response_model=List[ContractItemResponse],
    summary="Get contract line items",
)
def get_contract_items(
    contract_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.get_contract_items(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/{contract_id}/items",
    response_model=List[ContractItemResponse],
    summary="Set contract line items (replaces all)",
    dependencies=[Depends(get_current_billing_admin)],
)
def set_contract_items(
    contract_id: int,
    data: ContractItemBulkCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    # AC-01 (ZB-COM-ENT-001 Part 2): billing.usage_metering — gates setting
    # contract line items only when a submitted item's Product is USAGE-type,
    # since that's the action that actually establishes usage-based billing
    # on a contract (Contract/ContractCreate itself has no usage-type field).
    product_ids = {item.product_id for item in data.items if item.product_id}
    if product_ids:
        from app.modules.billing.models import Product, ProductType

        has_usage_product = (
            db.query(Product.id)
            .filter(Product.id.in_(product_ids), Product.product_type == ProductType.USAGE)
            .first()
            is not None
        )
        if has_usage_product:
            EntitlementEnforcementService(db).assert_boolean(
                organization_id=current_user.organization_id,
                key="billing.usage_metering",
                actor_id=current_user.id,
            )

    svc = ContractService(db)
    return svc.set_contract_items(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        items_data=[item.model_dump() for item in data.items],
    )


# ── Quotation → Contract Conversion ────────────────────────────


@router.post(
    "/convert-from-quotation",
    response_model=ContractResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Convert an accepted quotation to a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def convert_quotation_to_contract(
    data: ConvertQuotationRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.convert_quotation_to_contract(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        quotation_id=data.quotation_id,
        **data.model_dump(exclude={"quotation_id"}, exclude_unset=True),
    )


# ── Contract → Invoice ──────────────────────────────────────────


@router.post(
    "/{contract_id}/generate-invoice",
    response_model=InvoiceResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Generate an invoice from an active contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def generate_invoice_from_contract(
    contract_id: int,
    invoice_number: Optional[str] = Query(None),
    issue_date: Optional[date] = Query(None),
    due_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    invoice = svc.generate_invoice_from_contract(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        invoice_number=invoice_number,
        issue_date=issue_date,
        due_date=due_date,
    )
    return invoice


# ── Contract Amendments ──────────────────────────────────────────


@router.post(
    "/{contract_id}/amendments",
    response_model=ContractAmendmentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an amendment for a contract",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_contract_amendment(
    contract_id: int,
    data: ContractAmendmentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.create_amendment(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
        changed_by=current_user.id,
        amendment_date=data.amendment_date,
        effective_date=data.effective_date,
        reason=data.reason,
        previous_values=data.previous_values,
        new_values=data.new_values,
    )


@router.get(
    "/{contract_id}/amendments",
    response_model=List[ContractAmendmentResponse],
    summary="List all amendments for a contract",
)
def list_contract_amendments(
    contract_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ContractService(db)
    return svc.list_amendments(
        contract_id=contract_id,
        organization_id=current_user.organization_id,
    )
