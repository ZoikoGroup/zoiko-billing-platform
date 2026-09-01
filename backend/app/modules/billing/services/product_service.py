import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import AlreadyExistsException, BadRequestException
from app.modules.billing.models import BillingAuditAction, Product, ProductCategory
from app.modules.billing.repositories.catalog import (
    ProductCategoryRepository,
    ProductRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import filter_allowed

PRODUCT_ALLOWED_FIELDS = {
    "name", "code", "description", "category_id",
    "default_price", "original_price", "currency", "product_type",
    "is_subscribable", "is_usage_billable", "is_active",
    "cost_price", "unit_label", "tax_percentage", "tax_inclusive",
    "image_url", "brand", "billing_frequency", "default_discount",
    "invoice_description", "tax_category_id", "country", "gst_vat_group",
}
CATEGORY_ALLOWED_FIELDS = {
    "name", "code", "description", "parent_id",
    "sort_order", "icon", "color", "is_active",
}
PRODUCT_NULLABLE_FIELDS = {
    "description", "category_id", "cost_price", "unit_label",
    "tax_percentage", "image_url", "brand", "invoice_description",
    "tax_category_id", "country", "gst_vat_group",
    "default_discount", "original_price",
}
CATEGORY_NULLABLE_FIELDS = {"description", "parent_id", "icon", "color"}

logger = logging.getLogger("zoiko_billing")


def _resolve_org_currency(db: Session, organization_id: int) -> str:
    """Return the organization's base currency code.

    Delegates to BillingConfigurationService, the single authoritative
    source for this lookup (base_currency -> default_currency -> "USD"),
    instead of reimplementing the same resolution independently. This used
    to check Organization.currency first and only fall back to
    BillingConfiguration -- a different precedence than every other caller
    of "the org's currency" -- but organizations/router.py already keeps
    Organization.currency and BillingConfiguration.base_currency in
    lockstep on every change, so the two never actually disagreed in
    practice; unifying removes a second, independently-diverging
    implementation without changing the resolved value.
    """
    from app.modules.billing.services.settings_service import BillingConfigurationService
    try:
        return BillingConfigurationService(db).get_default_currency(organization_id)
    except Exception:
        return "USD"


class ProductService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = ProductRepository(db)
        self.cat_repo = ProductCategoryRepository(db)
        self.audit = BillingAuditService(db)

    def create_product(self, organization_id: int, created_by: int, **data: Any) -> Product:
        data = filter_allowed(data, PRODUCT_ALLOWED_FIELDS)
        code = data.get("code")
        name = data.get("name")
        # A soft-deleted product no longer counts as a live uniqueness
        # collision (get_by_code/exists exclude it), but its row still holds
        # the (organization_id, code) unique constraint. Re-importing or
        # re-creating a previously deleted catalog would otherwise fail with
        # 409 on the underlying unique index. Restore and refresh the archived
        # row instead, so a re-import surfaces the product again rather than
        # erroring.
        if code:
            archived = self.repo.get_deleted_by_code(organization_id, code)
            if archived:
                return self._restore_from_data(
                    archived, data, organization_id, created_by,
                )
        if self.repo.exists(organization_id, code=code):
            raise AlreadyExistsException("Product", "code")
        if name and self.repo.get_by_name(organization_id, name):
            raise AlreadyExistsException("Product", "name")
        if data.get("category_id"):
            self.cat_repo.get_by_id(data["category_id"], organization_id)
        if not data.get("currency"):
            data["currency"] = _resolve_org_currency(self.db, organization_id)
        product = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Product", product.id, new_values=data)
        return product

    def _restore_from_data(
        self, product: Product, data: Dict[str, Any], organization_id: int, user_id: int
    ) -> Product:
        """Rehydrate a soft-deleted product from new data and restore it."""
        for field, value in data.items():
            if field in ("created_by", "updated_by", "organization_id"):
                continue
            setattr(product, field, value)
        product.deleted_at = None
        if "is_active" not in data:
            product.is_active = True
        product.updated_by = user_id
        self.db.commit()
        self.db.refresh(product)
        self.audit.log(
            organization_id, user_id,
            BillingAuditAction.CREATE, "Product", product.id,
            new_values={**data, "restored_from_archive": True},
        )
        return product

    def update_product(self, product_id: int, organization_id: int, updated_by: int, **data: Any) -> Product:
        raw_data = data
        data = filter_allowed(data, PRODUCT_ALLOWED_FIELDS)
        for field in PRODUCT_NULLABLE_FIELDS:
            if field in raw_data and raw_data[field] is None:
                data[field] = None
        product = self.repo.get_by_id(product_id, organization_id)
        if data.get("code") and data["code"] != product.code:
            if self.repo.exists(organization_id, code=data["code"]):
                raise AlreadyExistsException("Product", "code")
        if data.get("name") and data["name"] != product.name:
            existing = self.repo.get_by_name(organization_id, data["name"])
            if existing and existing.id != product_id:
                raise AlreadyExistsException("Product", "name")
        if data.get("category_id") and data["category_id"] != product.category_id:
            self.cat_repo.get_by_id(data["category_id"], organization_id)
        updated = self.repo.update(product_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Product", product_id, new_values=data)
        return updated

    def get_product(self, product_id: int, organization_id: int) -> Product:
        return self.repo.get_by_id(product_id, organization_id)

    def get_product_by_code(self, organization_id: int, code: str) -> Optional[Product]:
        return self.repo.get_by_code(organization_id, code)

    def list_products(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, category_id: Optional[int] = None,
        product_type: Optional[str] = None, status: Optional[str] = None,
        currency: Optional[str] = None,
        sort_by: str = "name", sort_order: str = "asc", active_only: bool = False,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order, active_only=active_only,
            search_term=search_term, category_id=category_id, product_type=product_type,
            status=status, currency=currency,
        )

    def list_subscribable(self, organization_id: int, active_only: bool = True) -> List[Product]:
        return self.repo.list_subscribable(organization_id, active_only=active_only)

    def list_usage_billable(self, organization_id: int, active_only: bool = True) -> List[Product]:
        return self.repo.list_usage_billable(organization_id, active_only=active_only)

    def delete_product(self, product_id: int, organization_id: int, updated_by: int) -> None:
        self.repo.soft_delete(product_id, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "Product", product_id)

    def restore_product(self, product_id: int, organization_id: int, updated_by: int) -> Product:
        product = self.repo.restore(product_id, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Product", product_id, new_values={"restored": True})
        return product

    def duplicate_product(self, product_id: int, organization_id: int, created_by: int) -> Product:
        product = self.repo.get_by_id(product_id, organization_id)
        base_code = f"{product.code}-COPY"
        code = base_code
        suffix = 1
        while self.repo.exists(organization_id, code=code):
            suffix += 1
            code = f"{base_code}-{suffix}"

        base_name = f"{product.name} Copy"
        name = base_name
        suffix = 1
        while self.repo.get_by_name(organization_id, name):
            suffix += 1
            name = f"{base_name} {suffix}"

        data = {
            "category_id": product.category_id,
            "name": name,
            "code": code,
            "description": product.description,
            "product_type": product.product_type,
            "unit_label": product.unit_label,
            "currency": product.currency,
            "default_price": product.default_price,
            "original_price": product.original_price,
            "cost_price": product.cost_price,
            "tax_percentage": product.tax_percentage,
            "tax_category_id": product.tax_category_id,
            "country": product.country,
            "gst_vat_group": product.gst_vat_group,
            "tax_inclusive": product.tax_inclusive,
            "is_subscribable": product.is_subscribable,
            "is_usage_billable": product.is_usage_billable,
            "is_active": product.is_active,
            "image_url": product.image_url,
            "brand": product.brand,
            "billing_frequency": product.billing_frequency,
            "default_discount": product.default_discount,
            "invoice_description": product.invoice_description,
        }
        duplicated = self.repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Product", duplicated.id, new_values=data)
        return duplicated

    def bulk_status(self, product_ids: List[int], organization_id: int, updated_by: int, status: str) -> Dict[str, Any]:
        updated: List[int] = []
        failed: List[Dict[str, Any]] = []
        for product_id in product_ids:
            try:
                if status == "active":
                    self.update_product(product_id, organization_id, updated_by, is_active=True)
                elif status == "inactive":
                    self.update_product(product_id, organization_id, updated_by, is_active=False)
                elif status == "archived":
                    self.delete_product(product_id, organization_id, updated_by)
                elif status == "restored":
                    self.restore_product(product_id, organization_id, updated_by)
                else:
                    raise BadRequestException("Unsupported product status")
                updated.append(product_id)
            except Exception as exc:
                failed.append({"id": product_id, "error": str(exc)})
        return {"updated": updated, "failed": failed, "total": len(product_ids)}

    # ── Categories ──────────────────────────────────────────────────────

    def _is_category_descendant(self, category_id: int, possible_descendant_id: int, organization_id: int) -> bool:
        current = self.cat_repo.get_by_id(possible_descendant_id, organization_id)
        visited = set()
        while current.parent_id:
            if current.parent_id == category_id:
                return True
            if current.parent_id in visited:
                return True
            visited.add(current.parent_id)
            current = self.cat_repo.get_by_id(current.parent_id, organization_id)
        return False

    def _attach_product_count(self, cat: ProductCategory, organization_id: int) -> ProductCategory:
        cat.product_count = self.repo.count_by_category(organization_id, cat.id)
        return cat

    def _attach_product_counts(self, cats: List[ProductCategory], organization_id: int) -> List[ProductCategory]:
        if not cats:
            return cats
        from app.modules.billing.models import Product as ProductModel
        from sqlalchemy import func
        ids = [c.id for c in cats]
        counts = dict(
            self.db.query(ProductModel.category_id, func.count(ProductModel.id))
            .filter(
                ProductModel.category_id.in_(ids),
                ProductModel.organization_id == organization_id,
                ProductModel.deleted_at.is_(None),
            )
            .group_by(ProductModel.category_id)
            .all()
        )
        for c in cats:
            c.product_count = counts.get(c.id, 0)
        return cats

    def create_category(self, organization_id: int, created_by: int, **data: Any) -> ProductCategory:
        data = filter_allowed(data, CATEGORY_ALLOWED_FIELDS)
        if self.cat_repo.exists(organization_id, code=data.get("code")):
            raise AlreadyExistsException("ProductCategory", "code")
        if data.get("parent_id"):
            self.cat_repo.get_by_id(data["parent_id"], organization_id)
        cat = self.cat_repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "ProductCategory", cat.id)
        return self._attach_product_count(cat, organization_id)

    def update_category(self, category_id: int, organization_id: int, updated_by: int, **data: Any) -> ProductCategory:
        raw_data = data
        data = filter_allowed(data, CATEGORY_ALLOWED_FIELDS)
        for field in CATEGORY_NULLABLE_FIELDS:
            if field in raw_data and raw_data[field] is None:
                data[field] = None
        cat = self.cat_repo.get_by_id(category_id, organization_id)
        if data.get("code") and data["code"] != cat.code:
            if self.cat_repo.exists(organization_id, code=data["code"]):
                raise AlreadyExistsException("ProductCategory", "code")
        if "parent_id" in data:
            parent_id = data["parent_id"]
            if parent_id == category_id:
                raise BadRequestException("Category cannot be its own parent")
            if parent_id is not None:
                self.cat_repo.get_by_id(parent_id, organization_id)
                if self._is_category_descendant(category_id, parent_id, organization_id):
                    raise BadRequestException("Category parent cannot be a descendant category")
        updated = self.cat_repo.update(category_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "ProductCategory", category_id)
        return self._attach_product_count(updated, organization_id)

    def get_category(self, category_id: int, organization_id: int) -> ProductCategory:
        cat = self.cat_repo.get_by_id(category_id, organization_id)
        return self._attach_product_count(cat, organization_id)

    def list_all_categories(self, organization_id: int) -> List[ProductCategory]:
        return self._attach_product_counts(self.cat_repo.list_all(organization_id), organization_id)

    def list_root_categories(self, organization_id: int) -> List[ProductCategory]:
        return self._attach_product_counts(self.cat_repo.list_root(organization_id), organization_id)

    def list_child_categories(self, organization_id: int, parent_id: int) -> List[ProductCategory]:
        self.cat_repo.get_by_id(parent_id, organization_id)
        return self._attach_product_counts(self.cat_repo.list_children(organization_id, parent_id), organization_id)

    def delete_category(self, category_id: int, organization_id: int, updated_by: int) -> None:
        # active_only=False: an inactive (but not yet deleted) child category
        # or product must still block deletion -- otherwise deactivating a
        # product/subcategory first, then deleting its parent category,
        # silently orphans it (the category is gone, the row still points
        # at it) without ever tripping this guard.
        children = self.cat_repo.list_children(organization_id, category_id, active_only=False)
        if children:
            raise BadRequestException("Cannot delete category with child categories")
        products = self.repo.list_by_category(organization_id, category_id, active_only=False)
        if products:
            raise BadRequestException("Cannot delete category with associated products")
        self.cat_repo.soft_delete(category_id, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "ProductCategory", category_id)
