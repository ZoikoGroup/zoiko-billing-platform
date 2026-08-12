from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import RevenueRecognitionService
from app.modules.billing.schemas import (
    RevenueRecognitionScheduleCreate,
    RevenueRecognitionScheduleUpdate,
    RevenueRecognitionScheduleResponse,
    RevenueRecognitionEntryResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/revenue", tags=["🧾 Revenue"])


@router.post(
    "/schedules",
    response_model=RevenueRecognitionScheduleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a revenue recognition schedule",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_schedule(
    data: RevenueRecognitionScheduleCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    return svc.create_schedule(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        invoice_id=data.invoice_id,
        recognition_method=data.recognition_method,
        total_amount=data.total_amount,
        start_date=data.start_date,
        end_date=data.end_date,
        **data.model_dump(exclude={"invoice_id", "recognition_method", "total_amount", "start_date", "end_date"}, exclude_unset=True),
    )


@router.get(
    "/schedules",
    response_model=dict,
    summary="List revenue recognition schedules",
)
def list_schedules(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    status: Optional[str] = Query(None),
    recognition_method: Optional[str] = Query(None),
):
    svc = RevenueRecognitionService(db)
    return svc.list_schedules(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        status=status,
        recognition_method=recognition_method,
    )


@router.get(
    "/schedules/{sched_id}",
    response_model=RevenueRecognitionScheduleResponse,
    summary="Get a revenue recognition schedule",
)
def get_schedule(
    sched_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    return svc.get_schedule(
        sched_id=sched_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/schedules/{sched_id}",
    response_model=RevenueRecognitionScheduleResponse,
    summary="Update a revenue recognition schedule",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_schedule(
    sched_id: int,
    data: RevenueRecognitionScheduleUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    return svc.update_schedule(
        sched_id=sched_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.post(
    "/schedules/{sched_id}/recognize",
    response_model=dict,
    summary="Recognize revenue for a schedule",
    dependencies=[Depends(get_current_billing_admin)],
)
def recognize_revenue(
    sched_id: int,
    as_of_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    return svc.recognize_revenue(
        sched_id=sched_id,
        organization_id=current_user.organization_id,
        as_of_date=as_of_date,
    )


@router.get(
    "/schedules/{sched_id}/entries",
    response_model=list[RevenueRecognitionEntryResponse],
    summary="Get revenue recognition entries",
)
def get_entries(
    sched_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    return svc.get_entries(
        schedule_id=sched_id,
        organization_id=current_user.organization_id,
    )


@router.get(
    "/deferred",
    response_model=dict,
    summary="Get total deferred revenue",
)
def get_total_deferred(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    total = svc.get_total_deferred(
        organization_id=current_user.organization_id,
    )
    return {"total_deferred": total}


@router.post(
    "/recognize-all",
    response_model=dict,
    summary="Recognize all pending revenue",
    dependencies=[Depends(get_current_billing_admin)],
)
def recognize_all_pending(
    as_of_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = RevenueRecognitionService(db)
    return svc.recognize_all_pending(
        organization_id=current_user.organization_id,
        as_of_date=as_of_date,
    )
