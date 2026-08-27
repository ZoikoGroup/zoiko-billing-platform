from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import TaxService
from app.modules.billing.schemas import (
    TaxRateCreate,
    TaxRateUpdate,
    TaxRateResponse,
    TaxRateListResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/tax-rates", tags=["🧾 Tax"])


@router.post(
    "",
    response_model=TaxRateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a tax rate",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_tax_rate(
    data: TaxRateCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.create_tax_rate(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **data.model_dump(),
    )


@router.get(
    "",
    response_model=TaxRateListResponse,
    summary="List tax rates",
)
def list_tax_rates(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    tax_type: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    country_code: Optional[str] = Query(None, min_length=2, max_length=2, description="ISO 3166-1 alpha-2 country code"),
    is_active: Optional[bool] = Query(None, description="Filter by active status; omit for all rates"),
):
    svc = TaxService(db)
    if tax_type and tax_type.lower() in ("both", "all"):
        tax_type = None
    return svc.list_tax_rates(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        tax_type=tax_type,
        currency_code=currency,
        country_code=country_code,
        is_active=is_active,
    )


# ── Static paths MUST come before /{rate_id} to avoid FastAPI matching them as int ──

@router.get(
    "/summary",
    response_model=dict,
    summary="Get tax summary",
    dependencies=[Depends(get_current_billing_admin)],
)
def get_tax_summary(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_tax_summary(
        organization_id=current_user.organization_id,
        date_from=date_from,
        date_to=date_to,
    )


@router.get(
    "/summary/trend",
    response_model=list[dict],
    summary="Get trailing-months tax collected, grouped by month",
    dependencies=[Depends(get_current_billing_admin)],
)
def get_tax_monthly_trend(
    months: int = Query(6, ge=1, le=24),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_monthly_tax_trend(
        organization_id=current_user.organization_id,
        months=months,
    )


@router.get(
    "/default",
    response_model=Optional[TaxRateResponse],
    summary="Get default tax rate for a currency",
)
def get_default_tax_rate(
    currency: str = Query(..., min_length=3, max_length=3),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_default_tax_rate_by_currency(
        organization_id=current_user.organization_id,
        currency_code=currency,
    )


@router.get(
    "/applicable",
    response_model=list[TaxRateResponse],
    summary="Get applicable tax rates",
)
def get_applicable_rates(
    taxable_type: str = Query("both"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_applicable_rates(
        organization_id=current_user.organization_id,
        taxable_type=taxable_type,
    )


# ══════════════════════════════════════════════════════════════════════════════
# IMPORT — Bulk Tax Rate Import
# ══════════════════════════════════════════════════════════════════════════════

from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import Response as HTTPResponse
import json as _json
from app.modules.billing.schemas import (
    ImportPreviewResult,
    ImportConfirmRequest,
    ImportSummaryResult,
)
from app.modules.billing.services.tax_rate_import_service import TaxRateImportService


@router.post(
    "/import/preview",
    response_model=ImportPreviewResult,
    summary="Upload + validate a tax rate import file (CSV or XLSX). Returns a session token for confirm step.",
    dependencies=[Depends(get_current_billing_admin)],
)
async def tax_rate_import_preview(
    file: UploadFile = File(..., description="CSV or XLSX file"),
    column_map: str = Form(
        "{}",
        description="JSON object mapping file column names to tax rate fields. Leave empty for auto-detection.",
    ),
    duplicate_strategy: str = Form(
        "skip",
        description="How to handle duplicates: skip | overwrite | create_copy | review",
    ),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Step 1 of the import wizard:
    - Accepts a CSV or XLSX file.
    - Parses, validates, and detects duplicates (by tax rate code).
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
        svc = TaxRateImportService(db)
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
    summary="Commit a previewed tax rate import using the session token returned by /import/preview.",
    dependencies=[Depends(get_current_billing_admin)],
)
def tax_rate_import_confirm(
    data: ImportConfirmRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Step 2 of the import wizard:
    - Consumes the session from the preview step.
    - Commits valid rows using TaxService.create_tax_rate()/update_tax_rate()
      (so is_default-per-currency uniqueness and audit logging apply exactly
      as they do for a manually created/edited rate).
    - Partial-success model: failures are reported but do not abort the batch.
    - Pass batch_size to process the cached rows in slices across multiple
      calls for large imports; omit it to process every remaining row at once.
    """
    try:
        svc = TaxRateImportService(db)
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
    summary="Download a CSV or XLSX tax rate import template with required/optional fields and accepted values.",
    dependencies=[Depends(get_current_billing_admin)],
)
def tax_rate_import_template(
    format: str = Query("csv", description="Template format: csv or xlsx"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if format not in {"csv", "xlsx"}:
        raise HTTPException(status_code=400, detail="format must be 'csv' or 'xlsx'")
    try:
        svc = TaxRateImportService(db)
        content, mimetype = svc.generate_template(fmt=format)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Template generation failed: {exc}")

    ext = "xlsx" if format == "xlsx" else "csv"
    return HTTPResponse(
        content=content,
        media_type=mimetype,
        headers={
            "Content-Disposition": f"attachment; filename=tax_rate_import_template.{ext}",
        },
    )


@router.get(
    "/{rate_id}",
    response_model=TaxRateResponse,
    summary="Get a tax rate",
)
def get_tax_rate(
    rate_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.get_tax_rate(
        rate_id=rate_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/{rate_id}",
    response_model=TaxRateResponse,
    summary="Update a tax rate",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_tax_rate(
    rate_id: int,
    data: TaxRateUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    return svc.update_tax_rate(
        rate_id=rate_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.delete(
    "/{rate_id}",
    response_model=SuccessResponse,
    summary="Delete a tax rate",
    dependencies=[Depends(get_current_billing_admin)],
)
def delete_tax_rate(
    rate_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    svc.delete_tax_rate(
        rate_id=rate_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Tax rate deleted successfully")


@router.post(
    "/calculate",
    response_model=list[dict],
    summary="Calculate taxes",
)
def calculate_taxes(
    taxable_amount: float = Query(...),
    jurisdiction: Optional[str] = Query(None),
    tax_type_filter: Optional[str] = Query(None),
    currency_code: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = TaxService(db)
    if tax_type_filter and tax_type_filter.lower() in ("both", "all"):
        tax_type_filter = None
    return svc.calculate_taxes(
        organization_id=current_user.organization_id,
        taxable_amount=Decimal(str(taxable_amount)),
        jurisdiction=jurisdiction,
        tax_type_filter=tax_type_filter,
        currency_code=currency_code,
    )
