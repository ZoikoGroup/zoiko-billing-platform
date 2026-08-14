"""
modules/billing/routers/customer_router.py
------------------------------------------
"""

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, status, UploadFile
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import CustomerService
from app.modules.billing.schemas import (
    BulkDeleteRequest,
    BulkStatusRequest,
    CreditBalanceAdjustmentRequest,
    CreditBalanceAdjustmentResponse,
    CustomerCreate,
    CustomerUpdate,
    CustomerResponse,
    CustomerListResponse,
    CustomerContactCreate,
    CustomerContactUpdate,
    CustomerContactResponse,
    CustomerDocumentCreate,
    CustomerDocumentResponse,
    CustomerImportResponse,
    CustomerNoteCreate,
    CustomerNoteUpdate,
    CustomerNoteResponse,
    CustomerKPIResponse,
    CustomerAnalyticsResponse,
    CustomerStatementResponse,
    BillingAuditLogResponse,
    SuccessResponse,
    ImportPreviewResult,
    ImportConfirmRequest,
    ImportSummaryResult,
)
from fastapi.responses import Response as HTTPResponse
import json as _json
from app.modules.billing.services.customer_import_service import CustomerImportService

router = APIRouter(prefix="/customers", tags=["🧾 Customers"])


@router.post(
    "",
    response_model=CustomerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a billing customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_customer(
    data: CustomerCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.create_customer(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.get(
    "",
    response_model=CustomerListResponse,
    summary="List billing customers",
)
def list_customers(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=200),
    search_term: Optional[str] = Query(None),
    customer_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    industry: Optional[str] = Query(None),
    credit_limit_min: Optional[float] = Query(None),
    credit_limit_max: Optional[float] = Query(None),
    payment_terms: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    sort_by: str = Query("company_name"),
    sort_order: str = Query("asc"),
):
    svc = CustomerService(db)
    return svc.list_customers(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        customer_type=customer_type,
        status=status,
        country=country,
        currency=currency,
        industry=industry,
        credit_limit_min=credit_limit_min,
        credit_limit_max=credit_limit_max,
        payment_terms=payment_terms,
        date_from=date_from,
        date_to=date_to,
        sort_by=sort_by,
        sort_order=sort_order,
    )


@router.get(
    "/search",
    response_model=list[CustomerResponse],
    summary="Search billing customers",
)
def search_customers(
    term: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.search_customers(
        organization_id=current_user.organization_id,
        term=term,
        limit=limit,
    )


@router.get(
    "/export",
    response_model=list[CustomerResponse],
    summary="Export all customers (JSON)",
)
def export_customers(
    fmt: str = Query("json", alias="format"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.export_customers(
        organization_id=current_user.organization_id,
        fmt=fmt,
    )


@router.post(
    "/bulk-delete",
    response_model=SuccessResponse,
    summary="Hard-delete multiple customers",
    dependencies=[Depends(get_current_billing_admin)],
)
def bulk_delete_customers(
    data: BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    count = svc.bulk_delete_customers(
        organization_id=current_user.organization_id,
        ids=data.ids,
    )
    return SuccessResponse(message=f"{count} customer(s) deleted")


@router.post(
    "/bulk-status",
    response_model=SuccessResponse,
    summary="Bulk update customer status",
    dependencies=[Depends(get_current_billing_admin)],
)
def bulk_update_status(
    data: BulkStatusRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    count = svc.bulk_update_status(
        organization_id=current_user.organization_id,
        ids=data.ids,
        status=data.status,
        updated_by=current_user.id,
    )
    return SuccessResponse(message=f"{count} customer(s) status updated to '{data.status}'")


@router.get(
    "/kpi",
    response_model=CustomerKPIResponse,
    summary="Get customer KPI data",
)
def get_customer_kpi(
    period: str = Query(
        default="all_time",
        description="Period filter: today, last_7_days, last_30_days, this_month, this_quarter, this_year, all_time",
    ),
    date_from: Optional[str] = Query(None, description="Custom range start (ISO date), overrides period"),
    date_to: Optional[str] = Query(None, description="Custom range end (ISO date), overrides period"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.get_kpi_data(
        organization_id=current_user.organization_id,
        period=period,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/{customer_id}/analytics",
    response_model=CustomerAnalyticsResponse,
    summary="Get customer analytics",
)
def get_customer_analytics(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.get_customer_analytics(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


@router.post(
    "/import",
    response_model=CustomerImportResponse,
    summary="Import customers from CSV/JSON",
)
def import_customers(
    items: list[dict],
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    return svc.import_customers(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        items=items,
    )


@router.post(
    "/import/file",
    response_model=CustomerImportResponse,
    summary="Import customers from uploaded file (CSV/JSON)",
)
def import_customers_file(
    file: UploadFile,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    # UploadFile.read() is async; access the underlying SpooledTemporaryFile
    # synchronously via file.file so we get real bytes, not a coroutine object.
    try:
        raw_content = file.file.read()
    finally:
        file.file.seek(0)

    import io as _io
    file_like = _io.BytesIO(raw_content)
    file_like.name = file.filename or "import"

    svc = CustomerService(db)
    return svc.import_customers(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        items=[file_like],
    )


# ══════════════════════════════════════════════════════════════════════════════
# IMPORT WIZARD (preview → confirm → template) — mirrors the product import flow
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/import/preview",
    response_model=ImportPreviewResult,
    summary="Upload + validate a customer import file (CSV or XLSX). Returns a session token for confirm step.",
    dependencies=[Depends(get_current_billing_admin)],
)
async def customer_import_preview(
    file: UploadFile = File(..., description="CSV or XLSX file"),
    column_map: str = Form(
        "{}",
        description="JSON object mapping file column names to customer fields. Leave empty for auto-detection.",
    ),
    duplicate_strategy: str = Form(
        "skip",
        description="How to handle duplicates: skip | overwrite | create_copy | review",
    ),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Step 1 of the customer import wizard:
    - Accepts a CSV or XLSX file.
    - Parses, validates, and detects duplicates (customer_code / email).
    - Returns a session_id (valid 30 min) + per-row preview.
    - No records are written at this stage.
    """
    file_bytes = await file.read()
    filename = file.filename or "import.csv"

    try:
        col_map = _json.loads(column_map) if column_map else {}
    except Exception:
        raise HTTPException(status_code=400, detail="column_map must be a valid JSON object.")

    if duplicate_strategy not in {"skip", "overwrite", "create_copy", "review"}:
        raise HTTPException(
            status_code=400,
            detail="duplicate_strategy must be one of: skip, overwrite, create_copy, review",
        )

    try:
        svc = CustomerImportService(db)
        result = svc.preview_import(
            file_bytes=file_bytes,
            filename=filename,
            column_map=col_map,
            organization_id=current_user.organization_id,
            duplicate_strategy=duplicate_strategy,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Import preview failed: {exc}")

    return result


@router.post(
    "/import/confirm",
    response_model=ImportSummaryResult,
    summary="Commit a previewed customer import using the session token returned by /import/preview.",
    dependencies=[Depends(get_current_billing_admin)],
)
def customer_import_confirm(
    data: ImportConfirmRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Step 2 of the customer import wizard:
    - Consumes the session from the preview step.
    - Commits valid rows using existing CustomerService.create_customer().
    - Partial-success model: failures are reported but do not abort the batch.
    - For large imports, pass `batch_size` to process the cached rows in
      slices across multiple calls (e.g. offset=0/batch_size=500, then
      offset=500/batch_size=500, ...) — each response's `next_offset` and
      `is_complete` tell the caller whether to keep going. The session is
      only invalidated once `is_complete` is true.
    - All operations are audit-logged.
    """
    try:
        svc = CustomerImportService(db)
        result = svc.confirm_import(
            session_id=data.session_id,
            organization_id=current_user.organization_id,
            user_id=current_user.id,
            duplicate_strategy=data.duplicate_strategy,
            per_row_actions=data.per_row_actions,
            offset=data.offset,
            batch_size=data.batch_size,
        )
    except ValueError as exc:
        raise HTTPException(status_code=410, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Import confirmation failed: {exc}")

    return result


@router.get(
    "/import/template",
    summary="Download a CSV or XLSX customer import template with required/optional fields and accepted values.",
    dependencies=[Depends(get_current_billing_admin)],
)
def customer_import_template(
    format: str = Query("csv", description="Template format: csv or xlsx"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Returns a downloadable template file.
    The template includes:
    - Required + optional columns
    - Example rows
    - Accepted values for enumerated fields (type, status, payment terms, etc.)
    """
    if format not in {"csv", "xlsx"}:
        raise HTTPException(status_code=400, detail="format must be 'csv' or 'xlsx'")
    try:
        svc = CustomerImportService(db)
        content, mimetype = svc.generate_template(fmt=format)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Template generation failed: {exc}")

    ext = "xlsx" if format == "xlsx" else "csv"
    return HTTPResponse(
        content=content,
        media_type=mimetype,
        headers={
            "Content-Disposition": f"attachment; filename=customer_import_template.{ext}",
        },
    )


@router.get(
    "/{customer_id}",
    response_model=CustomerResponse,
    summary="Get a billing customer",
)
def get_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.get_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/{customer_id}",
    response_model=CustomerResponse,
    summary="Update a billing customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_customer(
    customer_id: int,
    data: CustomerUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.update_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.put(
    "/{customer_id}/activate",
    response_model=CustomerResponse,
    summary="Activate a customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def activate_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.activate_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.put(
    "/{customer_id}/deactivate",
    response_model=CustomerResponse,
    summary="Deactivate a customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def deactivate_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.deactivate_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.put(
    "/{customer_id}/suspend",
    response_model=CustomerResponse,
    summary="Suspend a customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def suspend_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.suspend_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.get(
    "/{customer_id}/contacts",
    response_model=list[CustomerContactResponse],
    summary="List customer contacts",
)
def list_contacts(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.list_contacts(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


@router.post(
    "/{customer_id}/contacts",
    response_model=CustomerContactResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a customer contact",
    dependencies=[Depends(get_current_billing_admin)],
)
def add_contact(
    customer_id: int,
    data: CustomerContactCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.add_contact(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
        created_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.put(
    "/{customer_id}/contacts/{contact_id}",
    response_model=CustomerContactResponse,
    summary="Update a customer contact",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_contact(
    customer_id: int,
    contact_id: int,
    data: CustomerContactUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.update_contact(
        customer_id=customer_id,
        contact_id=contact_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.delete(
    "/{customer_id}/contacts/{contact_id}",
    response_model=SuccessResponse,
    summary="Remove a customer contact",
    dependencies=[Depends(get_current_billing_admin)],
)
def remove_contact(
    customer_id: int,
    contact_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    svc.remove_contact(
        customer_id=customer_id,
        contact_id=contact_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Contact removed successfully")


@router.put(
    "/{customer_id}/contacts/{contact_id}/primary",
    response_model=CustomerContactResponse,
    summary="Set primary contact",
    dependencies=[Depends(get_current_billing_admin)],
)
def set_primary_contact(
    customer_id: int,
    contact_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.set_primary_contact(
        customer_id=customer_id,
        contact_id=contact_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.delete(
    "/{customer_id}/hard-delete",
    response_model=SuccessResponse,
    summary="Permanently delete a customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def hard_delete_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    svc.hard_delete_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
    )
    return SuccessResponse(message="Customer permanently deleted")


@router.put(
    "/{customer_id}/restore",
    response_model=CustomerResponse,
    summary="Restore a soft-deleted customer",
    dependencies=[Depends(get_current_billing_admin)],
)
def restore_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.restore_customer(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.get(
    "/{customer_id}/activity",
    response_model=list[BillingAuditLogResponse],
    summary="Get customer audit activity",
)
def get_customer_activity(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.get_customer_activity(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


# ── Credit Balance ────────────────────────────────────────────────────────


@router.post(
    "/{customer_id}/credit-balance",
    response_model=CreditBalanceAdjustmentResponse,
    summary="Adjust customer credit balance",
)
def adjust_credit_balance(
    customer_id: int,
    body: CreditBalanceAdjustmentRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    return svc.adjust_credit_balance(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        amount=body.amount,
        adj_type=body.type,
        reason=body.reason,
        updated_by=current_user.id,
    )


@router.get(
    "/{customer_id}/statement",
    response_model=CustomerStatementResponse,
    summary="Generate customer statement",
)
def get_customer_statement(
    customer_id: int,
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.generate_statement(
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        date_from=date_from,
        date_to=date_to,
    )


# ── Customer Documents ────────────────────────────────────────────────────


@router.get(
    "/{customer_id}/documents",
    response_model=list[CustomerDocumentResponse],
    summary="List customer documents",
)
def list_documents(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.list_documents(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


@router.post(
    "/{customer_id}/documents",
    response_model=CustomerDocumentResponse,
    summary="Add customer document",
    status_code=status.HTTP_201_CREATED,
)
def add_document(
    customer_id: int,
    body: CustomerDocumentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    return svc.add_document(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
        uploaded_by=current_user.id,
        **body.model_dump(),
    )


@router.delete(
    "/{customer_id}/documents/{document_id}",
    response_model=SuccessResponse,
    summary="Delete customer document",
)
def delete_document(
    customer_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    svc.delete_document(
        document_id=document_id,
        customer_id=customer_id,
        organization_id=current_user.organization_id,
    )
    return SuccessResponse(message="Document deleted")


# ── Customer Notes ────────────────────────────────────────────────────────


@router.get(
    "/{customer_id}/notes",
    response_model=list[CustomerNoteResponse],
    summary="List customer notes",
)
def list_notes(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = CustomerService(db)
    return svc.list_notes(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


@router.post(
    "/{customer_id}/notes",
    response_model=CustomerNoteResponse,
    summary="Add customer note",
    status_code=status.HTTP_201_CREATED,
)
def add_note(
    customer_id: int,
    body: CustomerNoteCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    return svc.add_note(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
        created_by=current_user.id,
        **body.model_dump(),
    )


@router.put(
    "/{customer_id}/notes/{note_id}",
    response_model=CustomerNoteResponse,
    summary="Update customer note",
)
def update_note(
    customer_id: int,
    note_id: int,
    body: CustomerNoteUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    return svc.update_note(
        note_id=note_id,
        customer_id=customer_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **body.model_dump(exclude_none=True),
    )


@router.delete(
    "/{customer_id}/notes/{note_id}",
    response_model=SuccessResponse,
    summary="Delete customer note",
)
def delete_note(
    customer_id: int,
    note_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    svc = CustomerService(db)
    svc.delete_note(
        note_id=note_id,
        customer_id=customer_id,
        organization_id=current_user.organization_id,
    )
    return SuccessResponse(message="Note deleted")
