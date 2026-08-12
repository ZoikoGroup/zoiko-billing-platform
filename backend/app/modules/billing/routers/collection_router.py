from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import CollectionService
from app.modules.billing.schemas import (
    CollectionsCaseCreate,
    CollectionsCaseUpdate,
    CollectionsCaseResponse,
    CollectionsCaseListResponse,
    CollectionActionCreate,
    CollectionActionResponse,
    CollectionsCaseStatusHistoryResponse,
    CollectionsCaseTimelineResponse,
    CollectionsCustomerSummaryResponse,
)

router = APIRouter(prefix="/collections", tags=["🧾 Collections"])


@router.post(
    "/cases",
    response_model=CollectionsCaseResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Open a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def open_case(
    data: CollectionsCaseCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.open_case(
        organization_id=current_user.organization_id,
        customer_id=data.customer_id,
        invoice_id=data.invoice_id,
        case_number=data.case_number,
        created_by=current_user.id,
        **data.model_dump(exclude={"customer_id", "invoice_id", "case_number"}, exclude_unset=True),
    )


@router.get(
    "/cases",
    response_model=CollectionsCaseListResponse,
    summary="List collections cases",
)
def list_cases(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    assigned_to: Optional[int] = Query(None),
    priority: Optional[str] = Query(None),
):
    svc = CollectionService(db)
    return svc.list_cases(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
        assigned_to=assigned_to,
        priority=priority,
    )


@router.get(
    "/cases/{case_id}",
    response_model=CollectionsCaseResponse,
    summary="Get a collections case",
)
def get_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/cases/{case_id}",
    response_model=CollectionsCaseResponse,
    summary="Update a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_case(
    case_id: int,
    data: CollectionsCaseUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.update_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.post(
    "/cases/{case_id}/assign",
    response_model=CollectionsCaseResponse,
    summary="Assign a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def assign_case(
    case_id: int,
    assigned_to: int = Query(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.assign_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        assigned_to=assigned_to,
        updated_by=current_user.id,
    )


@router.post(
    "/cases/{case_id}/resolve",
    response_model=CollectionsCaseResponse,
    summary="Resolve a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def resolve_case(
    case_id: int,
    resolution: str = Query(...),
    amount_collected: Optional[Decimal] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.resolve_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        resolution=resolution,
        updated_by=current_user.id,
        amount_collected=amount_collected,
    )


@router.post(
    "/cases/{case_id}/close",
    response_model=CollectionsCaseResponse,
    summary="Close a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def close_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.close_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post(
    "/cases/{case_id}/escalate",
    response_model=CollectionsCaseResponse,
    summary="Escalate a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def escalate_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.escalate_case(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post(
    "/cases/{case_id}/actions",
    response_model=CollectionActionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Log an action on a collections case",
    dependencies=[Depends(get_current_billing_admin)],
)
def log_action(
    case_id: int,
    data: CollectionActionCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.log_action(
        case_id=case_id,
        organization_id=current_user.organization_id,
        action_type=data.action_type,
        description=data.description,
        outcome=data.outcome,
        follow_up_date=str(data.follow_up_date) if data.follow_up_date else None,
        performed_by=current_user.id,
    )


@router.get(
    "/aging",
    response_model=dict,
    summary="Get aging buckets",
)
def get_aging_buckets(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_aging_buckets(
        organization_id=current_user.organization_id,
    )


@router.get(
    "/queue",
    response_model=list[dict],
    summary="Get collections queue",
)
def get_collections_queue(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_collections_queue(
        organization_id=current_user.organization_id,
    )


@router.get("/dashboard-stats", response_model=dict, summary="Get collections dashboard stats")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_dashboard_stats(current_user.organization_id)


@router.get("/priority-distribution", response_model=list, summary="Get collections case distribution by priority")
def get_priority_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_priority_distribution(current_user.organization_id)


@router.get("/customers/{customer_id}/summary", response_model=CollectionsCustomerSummaryResponse, summary="Get a customer's collection summary")
def get_customer_collection_summary(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_customer_collection_summary(current_user.organization_id, customer_id)


@router.get("/reports/overdue-by-customer", response_model=list, summary="Top customers by overdue balance")
def get_overdue_by_customer(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_overdue_by_customer(current_user.organization_id, limit=limit)


@router.get("/reports/dunning-performance", response_model=dict, summary="Dunning resolution/escalation performance")
def get_dunning_performance(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_dunning_performance(current_user.organization_id)


@router.get("/reports/collection-effectiveness", response_model=dict, summary="Collection effectiveness ratio")
def get_collection_effectiveness(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_collection_effectiveness(current_user.organization_id)


@router.get("/reports/recovery-trend", response_model=list, summary="Monthly amount-collected trend")
def get_recovery_trend(
    months: int = Query(12, ge=1, le=36),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.get_recovery_trend(current_user.organization_id, months)


@router.post(
    "/escalate-overdue",
    response_model=dict,
    summary="Manually trigger dunning-to-collections escalation for this org",
    dependencies=[Depends(get_current_billing_admin)],
)
def escalate_overdue_now(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from app.modules.billing.tasks.escalation_to_collections import _escalate_org_cases
    from app.modules.billing.services.settings_service import BillingConfigurationService

    config = BillingConfigurationService(db).get_configuration(current_user.organization_id)
    wait_days = getattr(config, "collections_wait_days", 30) or 30
    escalated = _escalate_org_cases(db, current_user.organization_id, wait_days)
    return {"cases_escalated": escalated}


@router.get(
    "/cases/{case_id}/status-history",
    response_model=list[CollectionsCaseStatusHistoryResponse],
    summary="Get status history for a collections case",
)
def list_case_status_history(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.list_status_history(case_id, current_user.organization_id)


@router.get(
    "/cases/{case_id}/timeline",
    response_model=CollectionsCaseTimelineResponse,
    summary="Get the full timeline for a collections case",
)
def get_case_timeline(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    entries = svc.get_timeline(case_id, current_user.organization_id)
    return {"collections_case_id": case_id, "entries": entries}


@router.get(
    "/cases/{case_id}/communications",
    response_model=list[dict],
    summary="Get communications logged for a collections case's invoice",
)
def get_case_communications(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.list_communications(case_id, current_user.organization_id)


@router.post(
    "/cases/{case_id}/send-past-due-notice",
    response_model=CollectionsCaseResponse,
    summary="Send the final collections notice email for a case",
    dependencies=[Depends(get_current_billing_admin)],
)
def send_past_due_notice(
    case_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CollectionService(db)
    return svc.send_past_due_notice(
        case_id=case_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
