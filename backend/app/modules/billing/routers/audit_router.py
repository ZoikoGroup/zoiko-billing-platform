from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import BillingAuditService
from app.modules.billing.schemas import (
    BillingAuditLogResponse,
    BillingAuditLogListResponse,
)

router = APIRouter(prefix="/audit-logs", tags=["🧾 Audit"])


@router.get(
    "",
    response_model=BillingAuditLogListResponse,
    summary="List audit logs",
    dependencies=[Depends(get_current_billing_admin)],
)
def list_logs(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    entity_type: Optional[str] = Query(None),
    entity_id: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    actor_id: Optional[int] = Query(None),
):
    svc = BillingAuditService(db)
    return svc.list_logs(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        actor_id=actor_id,
    )
