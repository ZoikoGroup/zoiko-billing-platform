"""
modules/billing/routers/promise_to_pay_router.py
---------------------------------------------------
RC2 Phase 4: Collections & Dunning Automation — Promise-to-Pay tracking.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.promise_to_pay_service import PromiseToPayService
from app.modules.billing.schemas import (
    PromiseToPayActionRequest,
    PromiseToPayCreate,
    PromiseToPayListResponse,
    PromiseToPayResponse,
    PromiseToPaySuccessRateResponse,
    PromiseToPayTimelineResponse,
    PromiseToPayUpdate,
)

router = APIRouter(prefix="/promise-to-pay", tags=["🧾 Promise to Pay"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=PromiseToPayResponse)
def create_promise(
    body: PromiseToPayCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PromiseToPayService(db)
    return svc.create_promise(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        customer_id=body.customer_id,
        **body.model_dump(exclude={"customer_id"}),
    )


@router.get("", response_model=PromiseToPayListResponse)
def list_promises(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    invoice_id: Optional[int] = Query(None),
    sort_by: str = Query("promise_date"),
    sort_order: str = Query("desc"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    return svc.list_promises(
        organization_id=current_user.organization_id,
        page=page, per_page=per_page, search_term=search_term,
        customer_id=customer_id, status=status, invoice_id=invoice_id,
        sort_by=sort_by, sort_order=sort_order,
    )


@router.get("/success-rate", response_model=PromiseToPaySuccessRateResponse)
def get_success_rate(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    return svc.get_success_rate(current_user.organization_id)


@router.get("/dashboard-stats", response_model=dict)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    return svc.get_dashboard_stats(current_user.organization_id)


@router.get("/customer/{customer_id}", response_model=list[PromiseToPayResponse])
def list_customer_promises(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    return svc.list_customer_promises(current_user.organization_id, customer_id)


@router.post(
    "/process",
    response_model=list[dict],
    summary="Manually trigger promise-to-pay auto status detection for this org",
    dependencies=[Depends(get_current_billing_admin)],
)
def process_promise_to_pay(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from app.modules.billing.services.settings_service import BillingConfigurationService

    config = BillingConfigurationService(db).get_configuration(current_user.organization_id)
    grace_days = getattr(config, "grace_days", 0) or 0
    svc = PromiseToPayService(db)
    return svc.process_promise_to_pay(current_user.organization_id, grace_days=grace_days)


@router.get("/{promise_id}", response_model=PromiseToPayResponse)
def get_promise(
    promise_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    return svc.get_promise(promise_id, current_user.organization_id)


@router.put("/{promise_id}", response_model=PromiseToPayResponse)
def update_promise(
    promise_id: int,
    body: PromiseToPayUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PromiseToPayService(db)
    return svc.update_promise(
        promise_id=promise_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.post("/{promise_id}/mark-fulfilled", response_model=PromiseToPayResponse)
def mark_fulfilled(
    promise_id: int,
    body: PromiseToPayActionRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PromiseToPayService(db)
    return svc.mark_fulfilled(promise_id, current_user.organization_id, current_user.id, notes=body.notes)


@router.post("/{promise_id}/mark-broken", response_model=PromiseToPayResponse)
def mark_broken(
    promise_id: int,
    body: PromiseToPayActionRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PromiseToPayService(db)
    return svc.mark_broken(promise_id, current_user.organization_id, current_user.id, notes=body.notes)


@router.post("/{promise_id}/cancel", response_model=PromiseToPayResponse)
def cancel_promise(
    promise_id: int,
    body: PromiseToPayActionRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = PromiseToPayService(db)
    return svc.cancel_promise(promise_id, current_user.organization_id, current_user.id, notes=body.notes)


@router.get("/{promise_id}/timeline", response_model=PromiseToPayTimelineResponse)
def get_promise_timeline(
    promise_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    entries = svc.get_timeline(promise_id, current_user.organization_id)
    return {"promise_id": promise_id, "entries": entries}


@router.get("/{promise_id}/communications", response_model=list[dict])
def get_promise_communications(
    promise_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = PromiseToPayService(db)
    return svc.list_communications(promise_id, current_user.organization_id)
