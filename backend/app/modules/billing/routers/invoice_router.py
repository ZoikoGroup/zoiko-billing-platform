"""
modules/billing/routers/invoice_router.py
-----------------------------------------
"""

from typing import Optional
from datetime import date

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import InvoiceService
from app.modules.billing.schemas import (
    InvoiceCommunicationCreate,
    InvoiceCommunicationResponse,
    InvoiceCreate,
    InvoiceTimelineResponse,
    InvoiceUpdate,
    InvoiceResponse,
    InvoiceListResponse,
    InvoiceItemCreate,
    InvoiceItemBulkCreate,
    InvoiceItemResponse,
    InvoiceStatusHistoryResponse,
    InvoiceBulkDeleteRequest,
    SuccessResponse,
    TimelineEntry,
)

router = APIRouter(prefix="/invoices", tags=["🧾 Invoices"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=InvoiceResponse)
def create_invoice(
    body: InvoiceCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.create_invoice(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        customer_id=body.customer_id,
        invoice_number=body.invoice_number,
        **body.model_dump(exclude={"customer_id", "invoice_number"}),
    )


@router.get("", response_model=InvoiceListResponse)
def list_invoices(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    invoice_type: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    min_amount: Optional[float] = Query(None),
    max_amount: Optional[float] = Query(None),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query("desc"),
    contract_id: Optional[int] = Query(None),
    subscription_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.list_invoices(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_id=customer_id,
        status=status,
        invoice_type=invoice_type,
        date_from=date_from,
        date_to=date_to,
        currency=currency,
        min_amount=min_amount,
        max_amount=max_amount,
        sort_by=sort_by or "created_at",
        sort_order=sort_order,
        contract_id=contract_id,
        subscription_id=subscription_id,
    )


# ── Static paths MUST come before /{invoice_id} to avoid FastAPI matching them as int ──

@router.get("/overdue", response_model=list[InvoiceResponse])
def list_overdue(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.list_overdue(organization_id=current_user.organization_id)


@router.get("/outstanding-total", response_model=dict)
def get_outstanding_total(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    total = svc.get_outstanding_total(organization_id=current_user.organization_id)
    return {"total_outstanding": total}


@router.get("/dashboard-stats", response_model=dict)
def get_dashboard_stats(
    period: Optional[str] = Query(None, pattern="^(week|month|quarter|year)$"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_dashboard_stats(organization_id=current_user.organization_id, period=period)


@router.get("/enterprise-dashboard", response_model=dict)
def get_enterprise_dashboard(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_enterprise_dashboard_stats(
        organization_id=current_user.organization_id, date_from=date_from, date_to=date_to,
    )


@router.get("/invoice-trend", response_model=list)
def get_invoice_trend(
    months: int = Query(12, ge=1, le=24),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_invoice_trend(organization_id=current_user.organization_id, months=months)


@router.get("/revenue-trend", response_model=list)
def get_revenue_trend(
    months: int = Query(12, ge=1, le=24),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_revenue_trend(organization_id=current_user.organization_id, months=months)


@router.get("/payment-collection-trend", response_model=list)
def get_payment_collection_trend(
    months: int = Query(12, ge=1, le=24),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_payment_collection_trend(organization_id=current_user.organization_id, months=months)


@router.get("/status-distribution", response_model=list)
def get_status_distribution(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_status_distribution(organization_id=current_user.organization_id)


@router.get("/monthly-revenue", response_model=list)
def get_monthly_revenue(
    months: int = Query(12, ge=1, le=24),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_monthly_revenue_stats(organization_id=current_user.organization_id, months=months)


@router.get("/recent-activity", response_model=list)
def get_recent_activity(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_recent_activity(organization_id=current_user.organization_id, limit=limit)


@router.post("/bulk-delete", response_model=SuccessResponse)
def bulk_delete_invoices(
    body: InvoiceBulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    if not body.ids:
        from app.core.exceptions import BadRequestException
        raise BadRequestException("No invoice IDs provided")
    svc = InvoiceService(db)
    count = svc.bulk_delete_invoices(
        organization_id=current_user.organization_id,
        ids=body.ids,
        updated_by=current_user.id,
    )
    return SuccessResponse(message=f"Deleted {count} invoice(s)")


@router.get("/due-between", response_model=list[InvoiceResponse])
def list_due_between(
    start_date: date = Query(...),
    end_date: date = Query(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.list_due_between(
        organization_id=current_user.organization_id,
        start_date=start_date.isoformat() if isinstance(start_date, date) else start_date,
        end_date=end_date.isoformat() if isinstance(end_date, date) else end_date,
    )


@router.get("/{invoice_id}", response_model=InvoiceResponse)
def get_invoice(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.get_invoice(invoice_id=invoice_id, organization_id=current_user.organization_id)


@router.put("/{invoice_id}", response_model=InvoiceResponse)
def update_invoice(
    invoice_id: int,
    body: InvoiceUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.update_invoice(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_unset=True),
    )


@router.post("/{invoice_id}/finalize", response_model=InvoiceResponse)
def finalize_invoice(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.finalize_invoice(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{invoice_id}/send", response_model=InvoiceResponse)
def mark_sent(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.mark_sent(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post("/{invoice_id}/send-email")
def send_invoice_email(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.send_invoice_via_email(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        sent_by=current_user.id,
    )


@router.post("/{invoice_id}/cancel", response_model=InvoiceResponse)
def cancel_invoice(
    invoice_id: int,
    reason: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.cancel_invoice(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        reason=reason,
        updated_by=current_user.id,
    )


@router.post("/{invoice_id}/void", response_model=InvoiceResponse)
def void_invoice(
    invoice_id: int,
    reason: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.void_invoice(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        reason=reason,
        updated_by=current_user.id,
    )


@router.post("/{invoice_id}/recalculate", response_model=InvoiceResponse, dependencies=[Depends(get_current_billing_admin)])
def recalculate_invoice(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.recalculate_invoice(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
    )


@router.get("/{invoice_id}/items", response_model=list[InvoiceItemResponse])
def list_items(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.list_items(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
    )


@router.post("/{invoice_id}/items", status_code=status.HTTP_201_CREATED, response_model=InvoiceItemResponse)
def add_item(
    invoice_id: int,
    body: InvoiceItemCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.add_item(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        **body.model_dump(),
    )


@router.put("/{invoice_id}/items", response_model=list[InvoiceItemResponse])
def bulk_set_items(
    invoice_id: int,
    body: InvoiceItemBulkCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = InvoiceService(db)
    return svc.bulk_set_items(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        items=[item.model_dump() for item in body.items],
    )


@router.get("/{invoice_id}/status-history", response_model=list[InvoiceStatusHistoryResponse])
def list_status_history(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.list_status_history(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
    )


@router.get("/{invoice_id}/communications", response_model=list[InvoiceCommunicationResponse])
def list_communications(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.list_communications(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
    )


@router.post("/{invoice_id}/communications", response_model=InvoiceCommunicationResponse, dependencies=[Depends(get_current_billing_admin)])
def add_communication_note(
    invoice_id: int,
    body: InvoiceCommunicationCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    return svc.add_communication_note(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        note=body.body_preview or "",
        **body.model_dump(exclude={"body_preview"}),
    )


@router.get("/{invoice_id}/timeline", response_model=InvoiceTimelineResponse)
def get_invoice_timeline(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = InvoiceService(db)
    entries = svc.get_timeline(
        invoice_id=invoice_id,
        organization_id=current_user.organization_id,
    )
    return InvoiceTimelineResponse(invoice_id=invoice_id, entries=[TimelineEntry(**e) for e in entries])


# ── Public Invoice View / Payment (no auth — token in the emailed link) ────
# Mounted OUTSIDE billing_router (see main.py) because billing_router has a
# router-level subscription gate that would 401 the public link.

public_invoice_router = APIRouter(prefix="/invoices/public", tags=["🧾 Invoices (Public)"])


class PublicCheckoutCreate(BaseModel):
    success_url: str
    cancel_url: str


@public_invoice_router.get(
    "/{token}",
    summary="Publicly view an invoice and its payment options via signed link token",
)
def get_public_invoice(
    token: str,
    db: Session = Depends(get_db),
):
    svc = InvoiceService(db)
    return svc.get_public_invoice(token)


@public_invoice_router.post(
    "/{token}/checkout",
    summary="Create a checkout session for a public invoice via signed link token",
)
def create_public_checkout(
    token: str,
    body: PublicCheckoutCreate,
    db: Session = Depends(get_db),
):
    svc = InvoiceService(db)
    return svc.create_public_checkout_session(
        token=token,
        success_url=body.success_url,
        cancel_url=body.cancel_url,
    )
