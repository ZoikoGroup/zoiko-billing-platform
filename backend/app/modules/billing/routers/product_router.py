"""
modules/billing/routers/product_router.py
-----------------------------------------
"""

from typing import Optional

from fastapi import APIRouter, Body, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services import ProductService
from app.modules.billing.schemas import (
    ProductCategoryCreate,
    ProductCategoryUpdate,
    ProductCategoryResponse,
    ProductCreate,
    ProductUpdate,
    ProductResponse,
    ProductListResponse,
    SuccessResponse,
)

router = APIRouter(prefix="/products", tags=["🧾 Products"])


@router.post(
    "/categories",
    response_model=ProductCategoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a product category",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_category(
    data: ProductCategoryCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.create_category(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.get(
    "/categories",
    response_model=list[ProductCategoryResponse],
    summary="List product categories",
)
def list_categories(
    root_only: bool = Query(True),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    if root_only:
        return svc.list_root_categories(organization_id=current_user.organization_id)
    else:
        return svc.list_all_categories(organization_id=current_user.organization_id)


@router.get(
    "/categories/{category_id}",
    response_model=ProductCategoryResponse,
    summary="Get a product category",
)
def get_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.get_category(
        category_id=category_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/categories/{category_id}",
    response_model=ProductCategoryResponse,
    summary="Update a product category",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_category(
    category_id: int,
    data: ProductCategoryUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.update_category(
        category_id=category_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.delete(
    "/categories/{category_id}",
    response_model=SuccessResponse,
    summary="Delete a product category",
    dependencies=[Depends(get_current_billing_admin)],
)
def delete_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    svc.delete_category(
        category_id=category_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Category deleted successfully")


@router.get(
    "/categories/{parent_id}/children",
    response_model=list[ProductCategoryResponse],
    summary="List child categories",
)
def list_child_categories(
    parent_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.list_child_categories(
        organization_id=current_user.organization_id,
        parent_id=parent_id,
    )


# ══════════════════════════════════════════════════════════════════════════════
# IMPORT / EXPORT — Phase 5B
# ══════════════════════════════════════════════════════════════════════════════

from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import Response as HTTPResponse
import json as _json
from app.modules.billing.schemas import (
    ImportPreviewResult,
    ImportConfirmRequest,
    ImportSummaryResult,
    ExportRequest,
)
from app.modules.billing.services.product_import_service import ProductImportService


@router.post(
    "/import/preview",
    response_model=ImportPreviewResult,
    summary="Upload + validate a product import file (CSV or XLSX). Returns a session token for confirm step.",
    dependencies=[Depends(get_current_billing_admin)],
)
async def import_preview(
    file: UploadFile = File(..., description="CSV or XLSX file"),
    column_map: str = Form(
        "{}",
        description="JSON object mapping file column names to product fields. Leave empty for auto-detection.",
    ),
    duplicate_strategy: str = Form(
        "skip",
        description="How to handle duplicates: skip | overwrite | create_copy | review",
    ),
    auto_create_categories: bool = Form(
        True,
        description="Automatically create missing categories found in the import file.",
    ),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Step 1 of the import wizard:
    - Accepts a CSV or XLSX file.
    - Parses, validates, and detects duplicates.
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
        svc = ProductImportService(db)
        result = svc.preview_import(
            file_bytes=file_bytes,
            filename=filename,
            column_map=col_map,
            organization_id=current_user.organization_id,
            duplicate_strategy=duplicate_strategy,
            auto_create_categories=auto_create_categories,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Import preview failed: {exc}")

    return result


@router.post(
    "/import/confirm",
    response_model=ImportSummaryResult,
    summary="Commit a previewed import using the session token returned by /import/preview.",
    dependencies=[Depends(get_current_billing_admin)],
)
def import_confirm(
    data: ImportConfirmRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Step 2 of the import wizard:
    - Consumes the session from the preview step.
    - Commits valid rows using existing ProductService.create_product().
    - Partial-success model: failures are reported but do not abort the batch.
    - For large imports, pass `batch_size` to process the cached rows in
      slices across multiple calls (e.g. offset=0/batch_size=500, then
      offset=500/batch_size=500, ...) — each response's `next_offset` and
      `is_complete` tell the caller whether to keep going. The session is
      only invalidated once `is_complete` is true. Omitting `batch_size`
      processes every remaining row in a single call.
    - All operations are audit-logged.
    """
    try:
        svc = ProductImportService(db)
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
    summary="Download a CSV or XLSX import template with required/optional fields and accepted values.",
    dependencies=[Depends(get_current_billing_admin)],
)
def import_template(
    format: str = Query("csv", description="Template format: csv or xlsx"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Returns a downloadable template file.
    The template includes:
    - Required + optional columns
    - Example rows
    - Accepted values for enumerated fields (type, status, currency, etc.)
    """
    if format not in {"csv", "xlsx"}:
        raise HTTPException(status_code=400, detail="format must be 'csv' or 'xlsx'")
    try:
        svc = ProductImportService(db)
        content, mimetype = svc.generate_template(fmt=format)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Template generation failed: {exc}")

    ext = "xlsx" if format == "xlsx" else "csv"
    return HTTPResponse(
        content=content,
        media_type=mimetype,
        headers={
            "Content-Disposition": f"attachment; filename=product_import_template.{ext}",
        },
    )


@router.post(
    "/export",
    summary="Export the product catalog (CSV or XLSX). Respects scope: all | filtered | selected.",
    dependencies=[Depends(get_current_billing_admin)],
)
def export_catalog(
    data: ExportRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Export the current organization's product catalog.
    - scope=all: export everything
    - scope=filtered: apply filter dict
    - scope=selected: only export the specified ids list
    Multi-tenancy enforced: only records belonging to the current org are exported.
    """
    if data.format not in {"csv", "xlsx"}:
        raise HTTPException(status_code=400, detail="format must be 'csv' or 'xlsx'")
    if data.scope not in {"all", "filtered", "selected"}:
        raise HTTPException(status_code=400, detail="scope must be 'all', 'filtered', or 'selected'")

    try:
        svc = ProductImportService(db)
        content, mimetype = svc.export_catalog(
            organization_id=current_user.organization_id,
            fmt=data.format,
            filters=data.filters if data.scope == "filtered" else None,
            ids=data.ids if data.scope == "selected" else None,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Export failed: {exc}")

    from datetime import date as _date
    ext = "xlsx" if data.format == "xlsx" else "csv"
    filename = f"products-{_date.today().isoformat()}.{ext}"
    return HTTPResponse(
        content=content,
        media_type=mimetype,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ══════════════════════════════════════════════════════════════════════════════
# PRODUCT CRUD
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "",
    response_model=ProductResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a product",
    dependencies=[Depends(get_current_billing_admin)],
)
def create_product(
    data: ProductCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.create_product(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        **data.model_dump(exclude_none=True),
    )


@router.get(
    "",
    response_model=ProductListResponse,
    summary="List products",
)
def list_products(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1),
    search_term: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    product_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(True, description="Filter by active status. Defaults to True for product selector compatibility."),
    sort_by: Optional[str] = Query("name"),
    sort_order: str = Query("asc"),
):
    svc = ProductService(db)
    return svc.list_products(
        organization_id=current_user.organization_id,
        page=page,
        per_page=per_page,
        search_term=search_term,
        category_id=category_id,
        product_type=product_type,
        status=status,
        currency=currency,
        active_only=is_active if is_active is not None else False,
        sort_by=sort_by or "name",
        sort_order=sort_order,
    )


@router.get(
    "/subscribable",
    response_model=list[ProductResponse],
    summary="List subscribable products",
)
def list_subscribable(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.list_subscribable(
        organization_id=current_user.organization_id,
    )


@router.get(
    "/usage-billable",
    response_model=list[ProductResponse],
    summary="List usage-billable products",
)
def list_usage_billable(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.list_usage_billable(
        organization_id=current_user.organization_id,
    )


@router.post(
    "/bulk-status",
    summary="Bulk update product status",
    dependencies=[Depends(get_current_billing_admin)],
)
def bulk_status_products(
    ids: list[int] = Body(...),
    status_value: str = Body(..., alias="status"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.bulk_status(
        product_ids=ids,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        status=status_value,
    )


@router.post(
    "/bulk-delete",
    summary="Bulk archive products",
    dependencies=[Depends(get_current_billing_admin)],
)
def bulk_delete_products(
    ids: list[int] = Body(..., embed=True),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.bulk_status(
        product_ids=ids,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        status="archived",
    )


@router.get(
    "/{product_id}",
    response_model=ProductResponse,
    summary="Get a product",
)
def get_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.get_product(
        product_id=product_id,
        organization_id=current_user.organization_id,
    )


@router.put(
    "/{product_id}",
    response_model=ProductResponse,
    summary="Update a product",
    dependencies=[Depends(get_current_billing_admin)],
)
def update_product(
    product_id: int,
    data: ProductUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.update_product(
        product_id=product_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
        **data.model_dump(exclude_unset=True),
    )


@router.post(
    "/{product_id}/restore",
    response_model=ProductResponse,
    summary="Restore an archived product",
    dependencies=[Depends(get_current_billing_admin)],
)
def restore_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.restore_product(
        product_id=product_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )


@router.post(
    "/{product_id}/duplicate",
    response_model=ProductResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate a product",
    dependencies=[Depends(get_current_billing_admin)],
)
def duplicate_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    return svc.duplicate_product(
        product_id=product_id,
        organization_id=current_user.organization_id,
        created_by=current_user.id,
    )


@router.delete(
    "/{product_id}",
    response_model=SuccessResponse,
    summary="Delete a product",
    dependencies=[Depends(get_current_billing_admin)],
)
def delete_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = ProductService(db)
    svc.delete_product(
        product_id=product_id,
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return SuccessResponse(message="Product deleted successfully")
