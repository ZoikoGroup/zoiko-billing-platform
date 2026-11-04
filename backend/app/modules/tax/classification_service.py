"""
app/modules/tax/classification_service.py
-----------------------------------------
Product tax classification (ZB-TAX-ARCH-001 Phase 2, §07, §11 "Product
Classification"): tenant products mapped to platform tax codes, with a
maker-checker review workflow, full history, a bulk impact preview, and a
per-organization classification version.

Approving a mapping change:
  1. supersedes the product's previous APPROVED mapping (never edits it);
  2. bumps the organization's classification version atomically
     (UPDATE ... SET version = version + 1 RETURNING version), so concurrent
     approvals each get a distinct version;
  3. marks every open quote (DRAFT/SENT) containing the product STALE.
Phase 3 tax quotes will also store the context fingerprint, the general
staleness mechanism (see context_builder.py).
"""
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.billing.models import (
    BillingAuditAction,
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    Product,
    QuotationItem,
    Quotation,
    QuoteStatus,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.tax.enums import PlatformVersionStatus, TaxContextStatus, TenantApprovalStatus
from app.modules.tax.models import ProductTaxClassification, TaxClassificationCounter
from app.modules.tax.policy_models import TaxCode

OPEN_QUOTE_STATUSES = (QuoteStatus.DRAFT, QuoteStatus.SENT)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def bump_classification_version(db: Session, organization_id: int) -> int:
    """Atomically increment and return the organization's classification
    version. The UPDATE takes a row lock on Postgres, so concurrent approvals
    serialize and never reuse a version."""
    now = _now()
    stmt = (update(TaxClassificationCounter)
            .where(TaxClassificationCounter.organization_id == organization_id)
            .values(version=TaxClassificationCounter.version + 1, updated_at=now)
            .returning(TaxClassificationCounter.version))
    version = db.execute(stmt).scalar()
    if version is not None:
        return version
    try:
        with db.begin_nested():
            db.add(TaxClassificationCounter(organization_id=organization_id, version=1, updated_at=now))
        return 1
    except IntegrityError:
        # Another transaction created the counter first; increment that one.
        return db.execute(stmt).scalar()


def current_classification_version(db: Session, organization_id: int) -> int:
    counter = db.get(TaxClassificationCounter, organization_id)
    return counter.version if counter else 0


class ClassificationService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    def _product(self, product_id: int, organization_id: int) -> Product:
        product = self.db.query(Product).filter(Product.id == product_id,
                                                Product.organization_id == organization_id).first()
        if product is None:
            raise NotFoundException("Product", product_id)
        return product

    def _get(self, classification_id: int, organization_id: int) -> ProductTaxClassification:
        row = self.db.query(ProductTaxClassification).filter(
            ProductTaxClassification.id == classification_id,
            ProductTaxClassification.organization_id == organization_id,
        ).first()
        if row is None:
            raise NotFoundException("Product tax classification", classification_id)
        return row

    def current(self, organization_id: int, product_id: int) -> Optional[ProductTaxClassification]:
        return self.db.query(ProductTaxClassification).filter(
            ProductTaxClassification.organization_id == organization_id,
            ProductTaxClassification.product_id == product_id,
            ProductTaxClassification.status == TenantApprovalStatus.APPROVED,
        ).first()

    def list_classifications(self, organization_id: int, product_id: Optional[int] = None, status=None):
        q = self.db.query(ProductTaxClassification).filter(ProductTaxClassification.organization_id == organization_id)
        if product_id:
            q = q.filter(ProductTaxClassification.product_id == product_id)
        if status is not None:
            q = q.filter(ProductTaxClassification.status == status)
        return q.order_by(ProductTaxClassification.id).all()

    def propose(self, organization_id: int, actor_id: int, *, product_id: int, tax_code_id: int,
                reason: Optional[str] = None) -> ProductTaxClassification:
        self._product(product_id, organization_id)
        code = self.db.get(TaxCode, tax_code_id)
        if code is None or code.code_set_version.status != PlatformVersionStatus.ACTIVE:
            raise BadRequestException("Choose a tax code from the currently published tax-code set.")
        row = ProductTaxClassification(
            organization_id=organization_id, product_id=product_id, tax_code_id=tax_code_id, reason=reason,
            status=TenantApprovalStatus.PROPOSED, proposed_by=actor_id, created_at=_now(),
        )
        self.db.add(row)
        self.db.flush()
        self.audit.log_no_commit(organization_id, actor_id, BillingAuditAction.CREATE, "ProductTaxClassification",
                                 row.id, new_values={"product_id": product_id, "tax_code": code.code})
        self.db.commit()
        return row

    def impact_preview(self, organization_id: int, product_ids: Iterable[int]) -> dict:
        """Draft invoices and open quotes that contain any of the products —
        what a mapping change would affect, before anyone approves it."""
        ids = sorted({int(p) for p in product_ids})
        for pid in ids:
            self._product(pid, organization_id)
        invoices = (self.db.query(Invoice.id, Invoice.invoice_number, InvoiceItem.product_id)
                    .join(InvoiceItem, InvoiceItem.invoice_id == Invoice.id)
                    .filter(Invoice.organization_id == organization_id, Invoice.status == InvoiceStatus.DRAFT,
                            InvoiceItem.product_id.in_(ids)).distinct().all()) if ids else []
        quotes = (self.db.query(Quotation.id, Quotation.quote_number, Quotation.status, QuotationItem.product_id)
                  .join(QuotationItem, QuotationItem.quotation_id == Quotation.id)
                  .filter(Quotation.organization_id == organization_id, Quotation.status.in_(OPEN_QUOTE_STATUSES),
                          QuotationItem.product_id.in_(ids)).distinct().all()) if ids else []
        draft_invoices = {}
        for inv_id, number, pid in invoices:
            draft_invoices.setdefault(inv_id, {"id": inv_id, "invoice_number": number, "product_ids": []})["product_ids"].append(pid)
        open_quotes = {}
        for q_id, number, status, pid in quotes:
            open_quotes.setdefault(q_id, {"id": q_id, "quote_number": number, "status": status.name,
                                          "product_ids": []})["product_ids"].append(pid)
        return {
            "product_ids": ids,
            "draft_invoices": sorted(draft_invoices.values(), key=lambda x: x["id"]),
            "open_quotes": sorted(open_quotes.values(), key=lambda x: x["id"]),
            "current_classification_version": current_classification_version(self.db, organization_id),
        }

    def decide(self, organization_id: int, actor_id: int, classification_id: int, *, approve: bool,
               reason: Optional[str] = None) -> ProductTaxClassification:
        row = self._get(classification_id, organization_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Classification {row.id} is {row.status.name}, not PROPOSED.")
        if row.proposed_by is not None and row.proposed_by == actor_id:
            raise ForbiddenException("You proposed this classification; a different user must approve or reject it.")
        now = _now()
        stale_quotes = []
        if approve:
            if row.tax_code.code_set_version.status != PlatformVersionStatus.ACTIVE:
                raise BadRequestException("The proposed tax code is no longer in the published tax-code set.")
            prior = self.current(organization_id, row.product_id)
            if prior is not None:
                prior.status = TenantApprovalStatus.SUPERSEDED
                prior.superseded_at = now
                self.db.flush()
                row.predecessor_id = prior.id
            row.classification_version = bump_classification_version(self.db, organization_id)
        # The whole decision is recorded before any further query: with
        # autoflush on, a query between the status change and the approver
        # would flush APPROVED alone, and the retention guard (rightly)
        # refuses to change a decided record's approver afterwards.
        row.status = TenantApprovalStatus.APPROVED if approve else TenantApprovalStatus.REJECTED
        row.approved_by = actor_id
        row.approved_at = now
        row.decision_reason = reason
        self.db.flush()
        if approve:
            stale_quotes = self._mark_quotes_stale(organization_id, row.product_id)
        self.audit.log_no_commit(
            organization_id, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
            "ProductTaxClassification", row.id,
            new_values={"status": row.status.name, "classification_version": row.classification_version,
                        "stale_quote_ids": stale_quotes},
        )
        self.db.commit()
        return row

    def _mark_quotes_stale(self, organization_id: int, product_id: int) -> list[int]:
        quote_ids = [qid for (qid,) in self.db.query(Quotation.id)
                     .join(QuotationItem, QuotationItem.quotation_id == Quotation.id)
                     .filter(Quotation.organization_id == organization_id,
                             Quotation.status.in_(OPEN_QUOTE_STATUSES),
                             QuotationItem.product_id == product_id).distinct()]
        if quote_ids:
            for quote in self.db.query(Quotation).filter(Quotation.id.in_(quote_ids)):
                quote.tax_context_status = TaxContextStatus.STALE
        return sorted(quote_ids)


def view_classification(row: ProductTaxClassification) -> dict:
    return {
        "id": row.id, "product_id": row.product_id, "tax_code_id": row.tax_code_id,
        "tax_code": row.tax_code.code if row.tax_code else None,
        "supply_category": row.tax_code.supply_category.name if row.tax_code else None,
        "reason": row.reason, "status": row.status.name, "proposed_by": row.proposed_by,
        "approved_by": row.approved_by, "approved_at": row.approved_at, "decision_reason": row.decision_reason,
        "classification_version": row.classification_version, "predecessor_id": row.predecessor_id,
        "created_at": row.created_at, "superseded_at": row.superseded_at,
    }
