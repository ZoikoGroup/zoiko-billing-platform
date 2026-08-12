"""
modules/billing/routers/refund_router.py
-----------------------------------------
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import RefundService
from app.modules.billing.schemas import (
    RefundApproveRequest,
    RefundCancelRequest,
    RefundCommunicationCreate,
    RefundCommunicationResponse,
    RefundCreate,
    RefundCustomerSummaryResponse,
    RefundFailRequest,
    RefundListResponse,
    RefundProcessRequest,
    RefundRejectRequest,
    RefundResponse,
    RefundStatusHistoryResponse,
    RefundTimelineResponse,
    RefundUpdate,
)

router = APIRouter(prefix="/refunds", tags=["🧾 Refunds"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=RefundResponse)
def create_refund(
    body: RefundCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.create_refund(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        customer_id=body.customer_id,
        refund_number=body.refund_number,
        refund_type=body.refund_type,
        amount=body.amount,
        **body.model_dump(exclude={
            "customer_id", "refund_number", "refund_type", "amount",
        }),
    )


@router.get("", response_model=RefundListResponse)
def list_refunds(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    refund_type: Optional[str] = Query(None),
    refund_source: Optional[str] = Query(None),
    refund_method: Optional[str] = Query(None),
    sort_by: str = Query("created_at"),
    sort_order: str = Query("desc"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.list_refunds(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
        refund_type=refund_type,
        refund_source=refund_source,
        refund_method=refund_method,
        sort_by=sort_by,
        sort_order=sort_order,
    )


@router.get("/dashboard-stats", response_model=dict)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_dashboard_stats(current_user.organization_id)


@router.get("/status-distribution", response_model=list)
def get_status_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_status_distribution(current_user.organization_id)


@router.get("/type-distribution", response_model=list)
def get_type_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_type_distribution(current_user.organization_id)


@router.get("/method-distribution", response_model=list)
def get_method_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_method_distribution(current_user.organization_id)


@router.get("/source-distribution", response_model=list)
def get_source_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_source_distribution(current_user.organization_id)


@router.get("/reason-distribution", response_model=list)
def get_reason_distribution(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_reason_distribution(current_user.organization_id, limit)


@router.get("/monthly-trend", response_model=list)
def get_monthly_trend(
    months: int = Query(12, ge=1, le=36),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_monthly_trend(current_user.organization_id, months)


@router.get("/customer/{customer_id}", response_model=RefundListResponse)
def list_customer_refunds(
    customer_id: int,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.list_customer_refunds(
        organization_id=current_user.organization_id, customer_id=customer_id,
        page=page, per_page=per_page,
    )


@router.get("/customer/{customer_id}/summary", response_model=RefundCustomerSummaryResponse)
def get_customer_refund_summary(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_customer_refund_summary(current_user.organization_id, customer_id)


@router.get("/{refund_id}", response_model=RefundResponse)
def get_refund(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.get_refund(refund_id=refund_id, organization_id=current_user.organization_id)


@router.put("/{refund_id}", response_model=RefundResponse)
def update_refund(
    refund_id: int,
    body: RefundUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.update_refund(
        refund_id=refund_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.post("/{refund_id}/submit", response_model=RefundResponse)
def submit_refund_for_approval(
    refund_id: int,
    body: RefundApproveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.submit_for_approval(
        refund_id=refund_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{refund_id}/approve", response_model=RefundResponse)
def approve_refund(
    refund_id: int,
    body: RefundApproveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.approve_refund(
        refund_id=refund_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{refund_id}/reject", response_model=RefundResponse)
def reject_refund(
    refund_id: int,
    body: RefundRejectRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.reject_refund(
        refund_id=refund_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{refund_id}/cancel", response_model=RefundResponse)
def cancel_refund(
    refund_id: int,
    body: RefundCancelRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.cancel_refund(
        refund_id=refund_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{refund_id}/process", response_model=RefundResponse)
def process_refund(
    refund_id: int,
    body: RefundProcessRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.process_refund(
        refund_id=refund_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        gateway_refund_id=body.gateway_refund_id,
        reference_number=body.reference_number,
    )


@router.post("/{refund_id}/complete", response_model=RefundResponse)
def complete_refund(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.complete_refund(
        refund_id=refund_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{refund_id}/fail", response_model=RefundResponse)
def fail_refund(
    refund_id: int,
    body: RefundFailRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = RefundService(db)
    return svc.fail_refund(
        refund_id=refund_id,
        organization_id=current_user.organization_id,
        failure_reason=body.failure_reason,
        updated_by=current_user.id,
    )


@router.post("/{refund_id}/send-email")
def send_refund_email_endpoint(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.send_refund_via_email(
        refund_id=refund_id, organization_id=current_user.organization_id, sent_by=current_user.id,
    )


@router.get("/{refund_id}/status-history", response_model=list[RefundStatusHistoryResponse])
def list_refund_status_history(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.list_status_history(refund_id, current_user.organization_id)


@router.get("/{refund_id}/communications", response_model=list[RefundCommunicationResponse])
def list_refund_communications(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.list_communications(refund_id, current_user.organization_id)


@router.post(
    "/{refund_id}/communications", response_model=RefundCommunicationResponse,
    dependencies=[Depends(get_current_billing_admin)],
)
def add_refund_communication_note(
    refund_id: int,
    body: RefundCommunicationCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    return svc.add_communication_note(
        refund_id=refund_id, organization_id=current_user.organization_id,
        created_by=current_user.id, note=body.body_preview or "",
        event_type=body.event_type, recipient=body.recipient, subject=body.subject,
    )


@router.get("/{refund_id}/timeline", response_model=RefundTimelineResponse)
def get_refund_timeline(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RefundService(db)
    entries = svc.get_timeline(refund_id, current_user.organization_id)
    return {"refund_id": refund_id, "entries": entries}
