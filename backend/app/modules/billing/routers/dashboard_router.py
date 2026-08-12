from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import BillingDashboardService
from app.modules.billing.schemas import BillingDashboardResponse

router = APIRouter(prefix="/dashboard", tags=["🧾 Dashboard"])


DATE_QUERY_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


@router.get(
    "",
    response_model=BillingDashboardResponse,
    summary="Get full billing dashboard",
)
def get_full_dashboard(
    period: Optional[str] = Query(None, pattern="^(today|week|month|quarter|year)$"),
    date_from: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range start (YYYY-MM-DD); takes precedence over `period` when set with date_to."),
    date_to: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range end (YYYY-MM-DD)."),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = BillingDashboardService(db)
    return svc.get_full_dashboard(
        organization_id=current_user.organization_id,
        period=period,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/kpis",
    response_model=dict,
    summary="Get billing KPIs",
)
def get_kpis(
    period: Optional[str] = Query(None, pattern="^(today|week|month|quarter|year)$"),
    date_from: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range start (YYYY-MM-DD); takes precedence over `period` when set with date_to."),
    date_to: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range end (YYYY-MM-DD)."),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = BillingDashboardService(db)
    return svc.get_kpis(
        organization_id=current_user.organization_id,
        period=period,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/revenue",
    response_model=dict,
    summary="Get monthly revenue data",
)
def get_monthly_revenue(
    months: int = Query(12, ge=1, le=60),
    period: Optional[str] = Query(None, pattern="^(today|week|month|quarter|year)$"),
    date_from: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range start (YYYY-MM-DD); takes precedence over `period` when set with date_to."),
    date_to: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range end (YYYY-MM-DD)."),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = BillingDashboardService(db)
    return svc.get_monthly_revenue(
        organization_id=current_user.organization_id,
        months=months,
        period=period,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/payment-trend",
    response_model=dict,
    summary="Get period-filtered payment trend",
)
def get_payment_trend(
    period: Optional[str] = Query(None, pattern="^(today|week|month|quarter|year)$"),
    date_from: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range start (YYYY-MM-DD); takes precedence over `period` when set with date_to."),
    date_to: Optional[str] = Query(None, pattern=DATE_QUERY_PATTERN, description="Custom range end (YYYY-MM-DD)."),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = BillingDashboardService(db)
    return svc.get_payment_trend(
        organization_id=current_user.organization_id,
        period=period,
        date_from=date_from,
        date_to=date_to,
    )
