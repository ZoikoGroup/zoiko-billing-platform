from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import DunningService
from app.modules.commercial.entitlement_enforcement import require_entitlement
from app.modules.billing.schemas import (
    DunningLevelCreate,
    DunningLevelUpdate,
    DunningLevelResponse,
    DunningCaseCreate,
    DunningCaseResponse,
    DunningCaseListResponse,
    DunningCaseStatusHistoryResponse,
    DunningCaseTimelineResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/dunning", tags=["🧾 Dunning"])


@router.post(
    "/levels",
    response_model=DunningLevelResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a dunning level",
    # AC-01 (ZB-COM-ENT-001 Part 2): collections.dunning — unconditional
    # BOOLEAN gate, pure dependency injection (no route-body changes needed).
    dependencies=[Depends(get_current_billing_admin), Depends(require_entitlement("collections.dunning"))],
)
def create_level(
    data: DunningLevelCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.create_level(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.get(
    "/levels",
    response_model=list[DunningLevelResponse],
    summary="List dunning levels",
)
def list_levels(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.list_levels(
        organization_id=current_user.organization_id,
    )


@router.get(
    "/levels/{level_id}",
    response_model=DunningLevelResponse,
    summary="Get a dunning level",
)
def get_level(
    level_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.get_level(
        level_id=level_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/levels/{level_id}",
    response_model=DunningLevelResponse,
    summary="Update a dunning level",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_level(
    level_id: int,
    data: DunningLevelUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.update_level(
        level_id=level_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.delete(
    "/levels/{level_id}",
    response_model=SuccessResponse,
    summary="Delete a dunning level",
    dependencies=[Depends(get_current_billing_admin)],
)
def delete_level(
    level_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    svc.delete_level(
        level_id=level_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Dunning level deleted successfully")


@router.post(
    "/cases",
    response_model=DunningCaseResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Open a dunning case",
    dependencies=[Depends(get_current_billing_admin)],
)
def open_dunning_case(
    data: DunningCaseCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.open_dunning_case(
        organization_id=current_user.organization_id,
        customer_id=data.customer_id,
        invoice_id=data.invoice_id,
        created_by=current_user.id,
        **data.model_dump(exclude={"customer_id", "invoice_id"}, exclude_unset=True),
    )


@router.get(
    "/cases",
    response_model=DunningCaseListResponse,
    summary="List dunning cases",
)
def list_cases(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
):
    svc = DunningService(db)
    return svc.list_cases(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
    )


@router.get(
    "/cases/active",
    response_model=list[DunningCaseResponse],
    summary="List active dunning cases",
)
def list_active_cases(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.list_active_cases(
        organization_id=current_user.organization_id,
    )


@router.get(
    "/cases/{case_id}",
    response_model=DunningCaseResponse,
    summary="Get a dunning case",
)
def get_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.get_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
    )


@router.post(
    "/cases/{case_id}/escalate",
    response_model=DunningCaseResponse,
    summary="Escalate a dunning case",
    dependencies=[Depends(get_current_billing_admin)],
)
def escalate_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.escalate_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post(
    "/cases/{case_id}/resolve",
    response_model=DunningCaseResponse,
    summary="Resolve a dunning case",
    dependencies=[Depends(get_current_billing_admin)],
)
def resolve_case(
    case_id: int,
    resolution_note: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.resolve_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        resolution_note=resolution_note,
        updated_by=current_user.id,
    )


@router.post(
    "/cases/{case_id}/close",
    response_model=DunningCaseResponse,
    summary="Close a dunning case",
    dependencies=[Depends(get_current_billing_admin)],
)
def close_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.close_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.get(
    "/schedule",
    response_model=list[dict],
    summary="Get dunning reminder schedule",
    dependencies=[Depends(get_current_billing_admin)],
)
def get_reminder_schedule(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.get_reminder_schedule(
        organization_id=current_user.organization_id,
    )


@router.post(
    "/process",
    response_model=list[dict],
    summary="Process dunning for overdue invoices",
    dependencies=[Depends(get_current_billing_admin)],
)
def process_dunning(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.process_dunning(
        organization_id=current_user.organization_id,
    )


@router.get(
    "/dashboard-stats",
    response_model=dict,
    summary="Get dunning dashboard stats",
)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.get_dashboard_stats(current_user.organization_id)


@router.get(
    "/level-distribution",
    response_model=list,
    summary="Get dunning case distribution by level",
)
def get_level_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.get_level_distribution(current_user.organization_id)


@router.get(
    "/cases/{case_id}/status-history",
    response_model=list[DunningCaseStatusHistoryResponse],
    summary="Get status history for a dunning case",
)
def list_case_status_history(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.list_status_history(case_id, current_user.organization_id)


@router.get(
    "/cases/{case_id}/timeline",
    response_model=DunningCaseTimelineResponse,
    summary="Get the full timeline for a dunning case",
)
def get_case_timeline(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    entries = svc.get_timeline(case_id, current_user.organization_id)
    return {"dunning_case_id": case_id, "entries": entries}


@router.get(
    "/cases/{case_id}/communications",
    response_model=list[dict],
    summary="Get communications logged for a dunning case's invoice",
)
def get_case_communications(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.list_communications(case_id, current_user.organization_id)


@router.get(
    "/cases/{case_id}/preview-reminder",
    response_model=dict,
    summary="Preview the next automated reminder for a dunning case",
)
def preview_reminder(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.preview_reminder(case_id, current_user.organization_id)


@router.post(
    "/cases/{case_id}/send-reminder",
    response_model=DunningCaseResponse,
    summary="Manually send a reminder for a dunning case",
    dependencies=[Depends(get_current_billing_admin)],
)
def send_reminder(
    case_id: int,
    channel: str = Query("email"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.send_reminder(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        channel=channel,
    )


@router.post(
    "/process-due-reminders",
    response_model=list[dict],
    summary="Send pre-due payment reminders for upcoming invoices",
    dependencies=[Depends(get_current_billing_admin)],
)
def process_due_reminders(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = DunningService(db)
    return svc.process_due_reminders(current_user.organization_id)
