"""
modules/billing/routers/payment_router.py
------------------------------------------
"""

from typing import Optional
from datetime import date

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.models import PaymentStatus
from app.modules.billing.services import PaymentService
from app.modules.billing.schemas import (
    PaymentMethodCreate,
    PaymentMethodUpdate,
    PaymentMethodResponse,
    PaymentCreate,
    PaymentUpdate,
    PaymentResponse,
    PaymentListResponse,
    PaymentAllocationCreate,
    PaymentAllocationResponse,
    PaymentAttemptResponse,
    UnallocatedPaymentListResponse,
    DeallocationResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/payments", tags=["🧾 Payments"])


# ── Payment Methods ───────────────────────────────────────────────────────────

@router.post("/methods", status_code=status.HTTP_201_CREATED, response_model=PaymentMethodResponse)
def add_payment_method(
    body: PaymentMethodCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.add_payment_method(
        organization_id=current_user.organization_id,
        customer_id=body.customer_id,
        created_by=current_user.id,
        **body.model_dump(exclude={"customer_id"}),
    )


@router.get("/methods/customer/{customer_id}", response_model=list[PaymentMethodResponse])
def list_payment_methods(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    return svc.list_payment_methods(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


@router.put("/methods/{method_id}", response_model=PaymentMethodResponse)
def update_payment_method(
    method_id: int,
    body: PaymentMethodUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.update_payment_method(
        method_id=method_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.delete("/methods/{method_id}", response_model=SuccessResponse)
def remove_payment_method(
    method_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    svc.remove_payment_method(
        method_id=method_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Payment method removed successfully")


@router.put("/methods/{method_id}/default", response_model=PaymentMethodResponse)
def set_default_payment_method(
    method_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.set_default_payment_method(
        organization_id=current_user.organization_id,
        method_id=method_id,
        updated_by=current_user.id,
    )


# ── Payments ──────────────────────────────────────────────────────────────────

@router.post("", status_code=status.HTTP_201_CREATED, response_model=PaymentResponse)
def record_payment(
    body: PaymentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.record_payment(
        organization_id=current_user.organization_id,
        customer_id=body.customer_id,
        payment_number=body.payment_number,
        amount=body.amount,
        payment_date=body.payment_date,
        created_by=current_user.id,
        **body.model_dump(exclude={"customer_id", "payment_number", "amount", "payment_date"}),
    )


@router.get("", response_model=PaymentListResponse)
def list_payments(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    payment_type: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    return svc.list_payments(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
        payment_type=payment_type,
        date_from=date_from,
        date_to=date_to,
    )


@router.get("/total-collected", response_model=dict)
def get_total_collected(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    total = svc.get_total_collected(organization_id=current_user.organization_id)
    return {"total_collected": total}


@router.get("/unallocated", response_model=UnallocatedPaymentListResponse)
def list_unallocated_payments(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    return svc.list_unallocated_payments(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
    )


@router.get("/{payment_id}", response_model=PaymentResponse)
def get_payment(
    payment_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    return svc.get_payment(payment_id=payment_id, organization_id=current_user.organization_id)


@router.put("/{payment_id}/status", response_model=PaymentResponse)
def update_payment_status(
    payment_id: int,
    status: PaymentStatus = Query(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.update_payment_status(
        payment_id=payment_id,
        organization_id=current_user.organization_id,
        status=status,
        updated_by=current_user.id,
    )


@router.post("/{payment_id}/allocate", status_code=status.HTTP_201_CREATED, response_model=PaymentAllocationResponse)
def allocate_payment(
    payment_id: int,
    body: PaymentAllocationCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.allocate_payment(
        payment_id=payment_id,
        organization_id=current_user.organization_id,
        invoice_id=body.invoice_id,
        amount=body.amount,
        created_by=current_user.id,
    )


@router.get("/{payment_id}/allocations", response_model=list[PaymentAllocationResponse])
def list_allocations_by_payment(
    payment_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    return svc.list_allocations_by_payment(
        payment_id=payment_id,
        organization_id=current_user.organization_id,
    )


@router.get("/{payment_id}/attempts", response_model=list[PaymentAttemptResponse])
def list_attempts(
    payment_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    return svc.list_attempts(
        payment_id=payment_id,
        organization_id=current_user.organization_id,
    )


@router.post("/{payment_id}/reconcile", response_model=PaymentResponse)
def reconcile_payment(
    payment_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    return svc.reconcile_payment(
        payment_id=payment_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.get("/{payment_id}/unallocated-amount", response_model=dict)
def get_unallocated_amount(
    payment_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PaymentService(db)
    amount = svc.get_unallocated_amount(
        payment_id=payment_id,
        organization_id=current_user.organization_id,
    )
    return {"payment_id": payment_id, "unallocated_amount": float(amount)}


@router.delete("/allocations/{allocation_id}", response_model=DeallocationResponse)
def deallocate_payment(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PaymentService(db)
    result = svc.deallocate_payment(
        allocation_id=allocation_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return DeallocationResponse(**result)
