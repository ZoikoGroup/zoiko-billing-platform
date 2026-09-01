"""
modules/billing/routers/subscription_router.py
------------------------------------------------
"""

from typing import Optional
from datetime import date

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin, get_organization_id
from app.modules.billing.services import SubscriptionService
from app.modules.billing.models import BillingSubscriptionStatus
from app.modules.billing.schemas import (
    SubscriptionPlanCreate,
    SubscriptionPlanUpdate,
    SubscriptionPlanResponse,
    SubscriptionCreate,
    SubscriptionUpdate,
    SubscriptionResponse,
    SubscriptionListResponse,
    SubscriptionEventResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/subscriptions", tags=["🧾 Subscriptions"])


# ── Plans ─────────────────────────────────────────────────────────────────────

@router.post("/plans", status_code=status.HTTP_201_CREATED, response_model=SubscriptionPlanResponse)
def create_plan(
    body: SubscriptionPlanCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.create_plan(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **body.model_dump(),
    )


@router.get("/plans")
def list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    active_only: Optional[bool] = Query(True, description="Filter to active plans only. The Plan Management view passes False to include inactive plans."),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.list_plans(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        category=category,
        active_only=active_only,
    )


@router.get("/plans/public", response_model=list[SubscriptionPlanResponse])
def list_public_plans(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.list_public_plans(organization_id=current_user.organization_id)


@router.get("/plans/{plan_id}", response_model=SubscriptionPlanResponse)
def get_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.get_plan(plan_id=plan_id, organization_id=current_user.organization_id)


@router.put("/plans/{plan_id}", response_model=SubscriptionPlanResponse)
def update_plan(
    plan_id: int,
    body: SubscriptionPlanUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.update_plan(
        plan_id=plan_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.post("/plans/{plan_id}/activate", response_model=SubscriptionPlanResponse)
def activate_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.activate_plan(
        plan_id=plan_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/plans/{plan_id}/deactivate", response_model=SubscriptionPlanResponse)
def deactivate_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.deactivate_plan(
        plan_id=plan_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


# ── Subscriptions ─────────────────────────────────────────────────────────────

@router.post("", status_code=status.HTTP_201_CREATED, response_model=SubscriptionResponse)
def create_subscription(
    body: SubscriptionCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.create_subscription(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        customer_id=body.customer_id,
        plan_id=body.plan_id,
        subscription_number=body.subscription_number,
        **body.model_dump(exclude={"customer_id", "plan_id", "subscription_number"}),
    )


@router.get("", response_model=SubscriptionListResponse)
def list_subscriptions(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    plan_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    contract_id: Optional[int] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.list_subscriptions(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        plan_id=plan_id,
        status=status,
        contract_id=contract_id,
        date_from=date_from,
        date_to=date_to,
    )


@router.get("/active", response_model=list[SubscriptionResponse])
def list_active(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.list_active(organization_id=current_user.organization_id)


@router.get(
    "/summary",
    summary="Get subscription summary and aggregate KPIs over full dataset",
)
def get_subscription_summary(
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    plan_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    contract_id: Optional[int] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.get_subscription_summary(
        organization_id=current_user.organization_id,
        search_term=search_term,
        customer_id=customer_id,
        plan_id=plan_id,
        status=status,
        contract_id=contract_id,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/invoice-schedules/summary",
    summary="Get invoice schedule summary and aggregate KPIs over full dataset",
)
def get_invoice_schedule_summary(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.get_invoice_schedule_summary(
        organization_id=current_user.organization_id,
    )


@router.get("/reporting", response_model=dict)
def get_subscription_reporting(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Return authoritatively computed MRR, ARR and per-currency breakdown
    for the organisation's active subscriptions.

    All amounts are expressed in the organisation's reporting/base currency.
    Subscriptions whose currency cannot be converted are excluded from
    aggregates but listed separately for transparency.
    """
    svc = SubscriptionService(db)
    return svc.get_subscription_reporting(organization_id=current_user.organization_id)


@router.post("/process-billing", response_model=dict)
def process_billing(
    billing_date: str,
    organization_id: Optional[int] = Query(None, alias="organization_id"),
    current_user=Depends(get_current_billing_admin),
    db: Session = Depends(get_db),
):
    """Process all subscriptions due for billing on a given date."""
    role_val = current_user.role.value if hasattr(current_user.role, 'value') else str(current_user.role)
    if role_val == "super_admin":
        if organization_id is None:
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException(
                "Super Admin must provide organization_id query parameter."
            )
        resolved_org = organization_id
    else:
        resolved_org = current_user.organization_id
    from app.modules.billing.services.subscription_service import SubscriptionService
    service = SubscriptionService(db)
    return service.process_due_subscriptions(resolved_org, billing_date, current_user.id)


@router.get("/{subscription_id}", response_model=SubscriptionResponse)
def get_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.get_subscription(sub_id=subscription_id, organization_id=current_user.organization_id)


@router.put("/{subscription_id}", response_model=SubscriptionResponse)
def update_subscription(
    subscription_id: int,
    body: SubscriptionUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.update_subscription(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.post("/{subscription_id}/activate", response_model=SubscriptionResponse)
def activate_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.activate_subscription(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{subscription_id}/pause", response_model=SubscriptionResponse)
def pause_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.pause_subscription(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{subscription_id}/resume", response_model=SubscriptionResponse)
def resume_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.resume_subscription(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{subscription_id}/cancel", response_model=SubscriptionResponse)
def cancel_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.cancel_subscription(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.put("/{subscription_id}/change-plan", response_model=SubscriptionResponse)
def change_plan(
    subscription_id: int,
    new_plan_id: int = Query(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.change_plan(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        new_plan_id=new_plan_id,
        updated_by=current_user.id,
    )


@router.get("/{subscription_id}/events", response_model=list[SubscriptionEventResponse])
def list_events(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = SubscriptionService(db)
    return svc.list_events(
        subscription_id=subscription_id,
        organization_id=current_user.organization_id,
    )


@router.post("/{subscription_id}/renew", response_model=SubscriptionResponse)
def renew_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = SubscriptionService(db)
    return svc.renew_subscription(
        sub_id=subscription_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{sub_id}/generate-invoice", response_model=dict)
def generate_subscription_invoice(
    sub_id: int,
    organization_id: Optional[int] = Query(None, alias="organization_id"),
    current_user=Depends(get_current_billing_admin),
    db: Session = Depends(get_db),
):
    """Generate an invoice for a specific subscription (manual generation)."""
    role_val = current_user.role.value if hasattr(current_user.role, 'value') else str(current_user.role)
    if role_val == "super_admin":
        if organization_id is None:
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException(
                "Super Admin must provide organization_id query parameter."
            )
        resolved_org = organization_id
    else:
        resolved_org = current_user.organization_id

    from app.modules.billing.services.subscription_service import SubscriptionService
    service = SubscriptionService(db)

    # Due-date guard for manual generation: only allow if subscription is currently due
    sub = service.repo.get_by_id(sub_id, resolved_org)
    if not sub:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("Subscription", sub_id)

    if sub.status != BillingSubscriptionStatus.ACTIVE:
        from app.core.exceptions import BadRequestException
        raise BadRequestException(f"Cannot generate invoice for {sub.status.value} subscription")

    today = date.today()
    if sub.next_billing_at and sub.next_billing_at > today:
        # Subscription is not yet due for billing
        return {
            "skipped": True,
            "reason": f"Subscription is not due for billing until {sub.next_billing_at}",
            "next_billing_at": sub.next_billing_at.isoformat()
        }

    return service.generate_invoice(sub_id, resolved_org, current_user.id)
