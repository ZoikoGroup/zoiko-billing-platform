"""
modules/billing/routers/write_off_router.py
---------------------------------------------
RC2 Phase 3: Write-off & Financial Adjustment.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin, get_current_finance_approver
from app.modules.billing.services.write_off_service import WriteOffService
from app.modules.billing.schemas import (
    WriteOffApproveRequest,
    WriteOffCancelRequest,
    WriteOffCommunicationCreate,
    WriteOffCommunicationResponse,
    WriteOffCreate,
    WriteOffCustomerSummaryResponse,
    WriteOffListResponse,
    WriteOffResponse,
    WriteOffReverseRequest,
    WriteOffStatusHistoryResponse,
    WriteOffTimelineResponse,
    WriteOffUpdate,
)

router = APIRouter(prefix="/write-offs", tags=["🧾 Write-offs"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=WriteOffResponse)
def create_write_off(
    body: WriteOffCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = WriteOffService(db)
    return svc.create_write_off(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        customer_id=body.customer_id,
        write_off_number=body.write_off_number,
        write_off_type=body.write_off_type,
        amount=body.amount,
        **body.model_dump(exclude={
            "customer_id", "write_off_number", "write_off_type", "amount",
        }),
    )


@router.get("", response_model=WriteOffListResponse)
def list_write_offs(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    write_off_type: Optional[str] = Query(None),
    adjustment_type: Optional[str] = Query(None),
    write_off_source: Optional[str] = Query(None),
    sort_by: str = Query("created_at"),
    sort_order: str = Query("desc"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.list_write_offs(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
        write_off_type=write_off_type,
        adjustment_type=adjustment_type,
        write_off_source=write_off_source,
        sort_by=sort_by,
        sort_order=sort_order,
    )


@router.get("/dashboard-stats", response_model=dict)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_dashboard_stats(current_user.organization_id)


@router.get("/status-distribution", response_model=list)
def get_status_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_status_distribution(current_user.organization_id)


@router.get("/type-distribution", response_model=list)
def get_type_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_type_distribution(current_user.organization_id)


@router.get("/adjustment-type-distribution", response_model=list)
def get_adjustment_type_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_adjustment_type_distribution(current_user.organization_id)


@router.get("/source-distribution", response_model=list)
def get_source_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_source_distribution(current_user.organization_id)


@router.get("/reason-distribution", response_model=list)
def get_reason_distribution(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_reason_distribution(current_user.organization_id, limit)


@router.get("/customer-distribution", response_model=list)
def get_customer_distribution(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_customer_distribution(current_user.organization_id, limit)


@router.get("/monthly-trend", response_model=list)
def get_monthly_trend(
    months: int = Query(12, ge=1, le=36),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_monthly_trend(current_user.organization_id, months)


@router.get("/customer/{customer_id}", response_model=WriteOffListResponse)
def list_customer_write_offs(
    customer_id: int,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.list_customer_write_offs(
        organization_id=current_user.organization_id, customer_id=customer_id,
        page=page, per_page=per_page,
    )


@router.get("/customer/{customer_id}/summary", response_model=WriteOffCustomerSummaryResponse)
def get_customer_write_off_summary(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_customer_write_off_summary(current_user.organization_id, customer_id)


@router.get("/{write_off_id}", response_model=WriteOffResponse)
def get_write_off(
    write_off_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.get_write_off(write_off_id=write_off_id, organization_id=current_user.organization_id)


@router.put("/{write_off_id}", response_model=WriteOffResponse)
def update_write_off(
    write_off_id: int,
    body: WriteOffUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = WriteOffService(db)
    return svc.update_write_off(
        write_off_id=write_off_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.post("/{write_off_id}/submit", response_model=WriteOffResponse)
def submit_write_off_for_approval(
    write_off_id: int,
    body: WriteOffApproveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = WriteOffService(db)
    return svc.submit_for_approval(
        write_off_id=write_off_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{write_off_id}/approve", response_model=WriteOffResponse)
def approve_write_off(
    write_off_id: int,
    body: WriteOffApproveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _approver=Depends(get_current_finance_approver),
):
    svc = WriteOffService(db)
    return svc.approve_write_off(
        write_off_id=write_off_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{write_off_id}/cancel", response_model=WriteOffResponse)
def cancel_write_off(
    write_off_id: int,
    body: WriteOffCancelRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = WriteOffService(db)
    return svc.cancel_write_off(
        write_off_id=write_off_id, organization_id=current_user.organization_id,
        updated_by=current_user.id, reason=body.reason,
    )


@router.post("/{write_off_id}/execute", response_model=WriteOffResponse)
def execute_write_off(
    write_off_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = WriteOffService(db)
    return svc.execute_write_off(
        write_off_id=write_off_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{write_off_id}/reverse", response_model=WriteOffResponse)
def reverse_write_off(
    write_off_id: int,
    body: WriteOffReverseRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = WriteOffService(db)
    return svc.reverse_write_off(
        write_off_id=write_off_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        reason=body.reason,
    )


@router.post("/{write_off_id}/send-email")
def send_write_off_email_endpoint(
    write_off_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.send_write_off_via_email(
        write_off_id=write_off_id, organization_id=current_user.organization_id, sent_by=current_user.id,
    )


@router.get("/{write_off_id}/status-history", response_model=list[WriteOffStatusHistoryResponse])
def list_write_off_status_history(
    write_off_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.list_status_history(write_off_id, current_user.organization_id)


@router.get("/{write_off_id}/communications", response_model=list[WriteOffCommunicationResponse])
def list_write_off_communications(
    write_off_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.list_communications(write_off_id, current_user.organization_id)


@router.post(
    "/{write_off_id}/communications", response_model=WriteOffCommunicationResponse,
    dependencies=[Depends(get_current_billing_admin)],
)
def add_write_off_communication_note(
    write_off_id: int,
    body: WriteOffCommunicationCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    return svc.add_communication_note(
        write_off_id=write_off_id, organization_id=current_user.organization_id,
        created_by=current_user.id, note=body.body_preview or "",
        event_type=body.event_type, recipient=body.recipient, subject=body.subject,
    )


@router.get("/{write_off_id}/timeline", response_model=WriteOffTimelineResponse)
def get_write_off_timeline(
    write_off_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = WriteOffService(db)
    entries = svc.get_timeline(write_off_id, current_user.organization_id)
    return {"write_off_id": write_off_id, "entries": entries}
