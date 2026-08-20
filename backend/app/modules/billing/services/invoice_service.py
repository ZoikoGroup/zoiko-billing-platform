import base64
import hashlib
import hmac
import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    NotFoundException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    CommunicationEventStatus,
    CommunicationEventType,
    Invoice,
    InvoiceCommunication,
    InvoiceItem,
    InvoiceStatus,
    InvoiceStatusHistory,
    NumberFormat,
    PaymentAllocation,
    PriceSource,
    Product,
    SequenceReset,
    TaxRate,
)
from app.modules.billing.services.price_resolver import PriceResolver
from app.modules.billing.services.document_sequence import DocumentSequenceService
from app.modules.billing.repositories.invoice import (
    InvoiceCommunicationRepository,
    InvoiceItemRepository,
    InvoiceRepository,
    InvoiceStatusHistoryRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import (
    filter_allowed, render_document_number, safe_commit_and_refresh, sequence_window_start,
)
from app.modules.billing.services.calculation_service import CalculationService
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.billing.services.exchange_rate_service import ExchangeRateService
from app.modules.billing.services.tax_service import TaxService
from app.modules.billing.utils.currency_utils import round_money, convert_amount

logger = logging.getLogger("zoiko_billing")


def _fmt_short_date(value) -> str:
    """Format a date like the ZB-INV-006 preview: e.g. 5 Aug 2026."""
    if not value:
        return ""
    if hasattr(value, "strftime"):
        return value.strftime("%d %b %Y").lstrip("0")
    return str(value)

INVOICE_ALLOWED_FIELDS = {
    "customer_id", "invoice_number", "invoice_type", "issue_date",
    "due_date", "discount_percentage", "shipping_amount", "round_off",
    "currency", "exchange_rate", "notes", "payment_terms", "po_number",
    "subscription_id", "quotation_id", "contract_id", "is_recurring",
}
# "status" is intentionally NOT an allowed field — invoice status may only
# change through the validated transition machine (finalize/mark_sent/cancel/
# void/payment/refund/write-off flows).
ITEM_ALLOWED_FIELDS = {
    "invoice_id", "line_number", "description", "quantity",
    "unit_price", "discount_percentage", "tax_percentage", "product_id",
    "original_currency", "original_amount", "exchange_rate",
    "is_tax_inclusive",
    "pricing_plan_id", "price_source", "base_price", "resolved_price",
    "resolved_price_type", "tax_rate_id",
}


class InvoiceService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = InvoiceRepository(db)
        self.item_repo = InvoiceItemRepository(db)
        self.history_repo = InvoiceStatusHistoryRepository(db)
        self.comms_repo = InvoiceCommunicationRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)
        self.config_service = BillingConfigurationService(db)
        self.exchange_rate_service = ExchangeRateService(db)
        self.tax_service = TaxService(self.db)
        self.sequence_service = DocumentSequenceService(db)

    def _validate_status_transition(self, current: InvoiceStatus, target: InvoiceStatus) -> None:
        valid = {
            InvoiceStatus.DRAFT: [InvoiceStatus.SENT, InvoiceStatus.CANCELLED],
            InvoiceStatus.SENT: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED, InvoiceStatus.WRITTEN_OFF],
            InvoiceStatus.PARTIALLY_PAID: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.CANCELLED, InvoiceStatus.WRITTEN_OFF],
            InvoiceStatus.OVERDUE: [InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.CANCELLED, InvoiceStatus.WRITTEN_OFF],
            InvoiceStatus.PAID: [InvoiceStatus.REFUNDED],
            InvoiceStatus.CANCELLED: [],
            InvoiceStatus.REFUNDED: [],
            InvoiceStatus.WRITTEN_OFF: [InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE],
        }
        if target not in valid.get(current, []):
            raise BadRequestException(f"Cannot transition invoice from {current.value} to {target.value}")

    def _record_status_history(self, organization_id: int, invoice_id: int, from_status: Optional[str], to_status: str, changed_by: Optional[int] = None, reason: Optional[str] = None) -> InvoiceStatusHistory:
        return self.history_repo.log_status_change(organization_id, invoice_id, from_status, to_status, changed_by, reason)

    def _record_invoice_tax_snapshots(self, invoice_id: int, organization_id: int, created_by: int) -> None:
        """Persist tax snapshot rows for a finalized invoice.

        Groups invoice line items by tax_rate_id (where available) and
        creates one Tax record per group. Items with no tax or no
        tax_rate_id are grouped into a single aggregate record when their
        combined tax amount is > 0.

        Called during finalize_invoice / send_invoice_via_email after the
        invoice status is set to SENT.  Failures are logged but never
        block the invoice from being issued — tax snapshots are an
        informational audit trail, not a gate.
        """
        try:
            from app.modules.billing.services.tax_service import TaxService

            items = self.item_repo.list_by_invoice(organization_id, invoice_id)
            if not items:
                return

            # Group line items by tax_rate_id for consolidated snapshots
            grouped: Dict[Optional[int], Dict[str, Any]] = {}
            for item in items:
                tax_pct = Decimal(str(item.tax_percentage or 0))
                tax_amt = Decimal(str(item.tax_amount or 0))
                if tax_pct <= 0 and tax_amt <= 0:
                    continue
                taxable = Decimal(str(item.quantity or 0)) * Decimal(str(item.unit_price or 0))
                taxable -= Decimal(str(item.discount_amount or 0))
                if item.is_tax_inclusive:
                    # Tax is already included in the line total; extract base
                    if tax_pct > 0:
                        taxable = (taxable * Decimal("100")) / (Decimal("100") + tax_pct)

                rate_key = getattr(item, "tax_rate_id", None)
                if rate_key not in grouped:
                    grouped[rate_key] = {
                        "taxable_amount": Decimal("0"),
                        "tax_amount": Decimal("0"),
                        "tax_percentage": tax_pct,
                        "invoice_id": invoice_id,
                        "tax_rate_id": rate_key,
                    }
                grouped[rate_key]["taxable_amount"] += taxable
                grouped[rate_key]["tax_amount"] += tax_amt

            if not grouped:
                return

            tax_svc = TaxService(self.db)
            snapshot_records = []
            for rate_key, data in grouped.items():
                # Resolve jurisdiction and tax_type from the TaxRate if available
                jurisdiction = None
                tax_type = None
                is_reverse_charge = False
                if rate_key:
                    try:
                        from app.modules.billing.models import TaxRate
                        rate_obj = self.db.query(TaxRate).filter(TaxRate.id == rate_key).first()
                        if rate_obj:
                            jurisdiction = rate_obj.jurisdiction
                            tax_type = rate_obj.tax_type.value if rate_obj.tax_type else None
                    except Exception:
                        pass

                snapshot_records.append({
                    "invoice_id": invoice_id,
                    "tax_rate_id": rate_key,
                    "taxable_amount": data["taxable_amount"],
                    "tax_amount": data["tax_amount"],
                    "tax_percentage": data["tax_percentage"],
                    "jurisdiction": jurisdiction,
                    "tax_type": tax_type,
                    "is_reverse_charge": is_reverse_charge,
                })

            if snapshot_records:
                tax_svc.record_taxes(organization_id, created_by, snapshot_records)
                logger.info(
                    "Recorded %d tax snapshot(s) for invoice %d",
                    len(snapshot_records), invoice_id,
                )
        except Exception as e:
            # Tax snapshot recording must never block invoice issuance
            logger.warning(
                "Failed to record tax snapshots for invoice %d: %s",
                invoice_id, e,
            )

    def _generate_invoice_number(self, organization_id: int) -> str:
        """Generate invoice number using billing configuration format.

        Uses the concurrency-safe per-org sequence table (SELECT FOR UPDATE)
        instead of count()+1, so concurrent issuance and voiding can never
        collide or reuse numbers.
        """
        config = self.config_service.get_configuration(organization_id)
        prefix = config.invoice_prefix or "INV-"
        fmt = config.invoice_number_format or NumberFormat.PREFIX_YYYY_SEQ
        reset = config.invoice_sequence_reset or SequenceReset.ANNUALLY

        return self.sequence_service.next_number(
            organization_id, "invoice", prefix, fmt, reset,
        )

    # ── Currency Conversion (Phase 1) ────────────────────────────────────────
    # NOTE (Phase 2): _get_exchange_rate, _convert_currency, and
    # _validate_exchange_rates were removed here — dead code confirmed via
    # repo-wide search (zero callers, including tests). _apply_currency_conversion
    # below is the live currency-conversion path actually used by bulk_set_items().

    def _apply_currency_conversion(self, item_data: Dict[str, Any], invoice_currency: str, organization_id: int) -> Dict[str, Any]:
        """Apply currency conversion to item data if currencies differ.
        
        Fetches the rate from ExchangeRateService (live API → cached → legacy) and
        stores the rate source and timestamp on the item for audit trail.
        """
        original_currency = item_data.get("original_currency")
        original_amount = item_data.get("original_amount")
        
        if not original_currency or not original_amount:
            return item_data
        
        # If currencies are the same, no conversion needed
        if original_currency == invoice_currency:
            item_data["invoice_currency"] = invoice_currency
            item_data["exchange_rate"] = Decimal("1")
            item_data["converted_amount"] = Decimal(str(original_amount))
            item_data["unit_price"] = Decimal(str(original_amount))
            item_data["exchange_rate_timestamp"] = datetime.utcnow()
            return item_data
        
        # Fetch rate from ExchangeRateService
        try:
            rate, source, timestamp = self.exchange_rate_service.get_rate(
                organization_id, original_currency, invoice_currency
            )
        except BadRequestException:
            raise
        
        converted_amount = convert_amount(original_amount, rate, invoice_currency)

        item_data["invoice_currency"] = invoice_currency
        item_data["exchange_rate"] = rate
        item_data["converted_amount"] = converted_amount
        item_data["unit_price"] = converted_amount
        item_data["exchange_rate_timestamp"] = timestamp or datetime.utcnow()
        
        return item_data

    def calculate_invoice_totals(self, items: List[Dict[str, Any]], discount_percentage: Decimal = Decimal("0"), currency: Optional[str] = None) -> Dict[str, Decimal]:
        # Delegates to CalculationService.summarize_document_totals — the single
        # source of truth shared with QuoteService.calculate_totals, so an invoice
        # and the quote it was generated from can never drift on totals math.
        totals = CalculationService.summarize_document_totals(items, discount_percentage, currency=currency)
        return {
            "subtotal": totals["subtotal"],
            "discount_amount": totals["discount_amount"],
            "tax_amount": totals["tax_amount"],
            "total_amount": totals["total_amount"],
        }

    def create_invoice(self, organization_id: int, created_by: int, customer_id: int, invoice_number: str, _skip_recalculate: bool = False, **data: Any) -> Invoice:
        data = filter_allowed(data, INVOICE_ALLOWED_FIELDS)
        customer = self.customer_service.get_customer(customer_id, organization_id)

        # Use customer's currency if not explicitly provided, else org default
        if "currency" not in data or not data["currency"]:
            data["currency"] = customer.currency or self.config_service.get_default_currency(organization_id)

        # Optional server-side tax resolution
        resolve_tax = data.pop("resolve_tax", False)
        items_data = data.get("items")
        if resolve_tax and items_data:
            taxable_amount = Decimal("0")
            for item in items_data:
                qty = Decimal(str(item.get("quantity", 1)))
                price = Decimal(str(item.get("unit_price", 0)))
                taxable_amount += qty * price

            resolved_taxes = self.tax_service.calculate_taxes(
                organization_id, taxable_amount,
                jurisdiction=data.get("jurisdiction"),
                tax_type_filter=data.get("tax_type_filter"),
                currency_code=data.get("currency"),
            )

            if resolved_taxes:
                total_tax_pct = sum(Decimal(str(t.get("tax_percentage", 0))) for t in resolved_taxes)
                for item in items_data:
                    item["tax_percentage"] = float(total_tax_pct)

        auto_numbering = not invoice_number or invoice_number.strip().lower() in ("auto", "auto-generated", "")

        if auto_numbering:
            # Auto-generated numbers must never fail on a collision. The
            # sequence can drift behind existing invoices (e.g. rows seeded
            # before document_sequences existed, or a stale counter), so if the
            # generated number is already taken, draw the next one instead of
            # erroring. Manual numbers keep the strict AlreadyExistsException.
            for _ in range(1000):
                invoice_number = self._generate_invoice_number(organization_id)
                if not self.repo.exists(organization_id, invoice_number=invoice_number):
                    break
            else:
                raise AlreadyExistsException(
                    "Invoice",
                    f"invoice_number '{invoice_number}'",
                )
        elif self.repo.exists(organization_id, invoice_number=invoice_number):
            raise AlreadyExistsException(
                "Invoice",
                f"invoice_number '{invoice_number}'",
            )

        try:
            inv = self.repo.create(organization_id, customer_id=customer_id, invoice_number=invoice_number, status=InvoiceStatus.DRAFT, **data)
        except AlreadyExistsException:
            if not auto_numbering:
                # Manual number: exists() passed but the DB unique constraint
                # (organization_id, invoice_number) fired between check and insert.
                raise AlreadyExistsException(
                    "Invoice",
                    f"invoice_number '{invoice_number}'",
                )
            # Auto-numbering race backstop: another request grabbed the number
            # between exists() and create(). Retry with the next sequence value.
            for _ in range(1000):
                invoice_number = self._generate_invoice_number(organization_id)
                if self.repo.exists(organization_id, invoice_number=invoice_number):
                    continue
                try:
                    inv = self.repo.create(organization_id, customer_id=customer_id, invoice_number=invoice_number, status=InvoiceStatus.DRAFT, **data)
                    break
                except AlreadyExistsException:
                    continue
            else:
                raise AlreadyExistsException(
                    "Invoice",
                    f"invoice_number '{invoice_number}'",
                )
        # Set balance_due = total_amount for new invoices (no payments yet).
        # This is a safety net; recalculate_invoice or the caller will set the authoritative value.
        total = Decimal(str(data.get("total_amount", 0)))
        inv.balance_due = total
        if _skip_recalculate:
            safe_commit_and_refresh(self.db, inv)
        # Recalculate invoice totals using CalculationService (backend authority)
        if not _skip_recalculate:
            try:
                self.recalculate_invoice(inv.id, organization_id)
            except Exception as e:
                logger.warning("Could not recalculate invoice %d during creation: %s", inv.id, e)
        self._record_status_history(organization_id, inv.id, None, InvoiceStatus.DRAFT, created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Invoice", inv.id, new_values=data)
        return inv

    def update_invoice(self, invoice_id: int, organization_id: int, updated_by: int, **data: Any) -> Invoice:
        data = filter_allowed(data, INVOICE_ALLOWED_FIELDS)
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status != InvoiceStatus.DRAFT:
            raise BadRequestException("Only draft invoices can be edited")
        updated = self.repo.update(invoice_id, organization_id, **data)
        # Recalculate after discount_percentage change
        try:
            self.recalculate_invoice(invoice_id, organization_id)
        except Exception as e:
            logger.warning("Could not recalculate invoice %d during update: %s", invoice_id, e)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Invoice", invoice_id)
        return updated

    def get_invoice(self, invoice_id: int, organization_id: int) -> Invoice:
        inv = self.repo.db.query(Invoice).options(
            joinedload(Invoice.customer)
        ).filter(
            Invoice.id == invoice_id,
            Invoice.organization_id == organization_id
        ).first()
        if not inv:
            return self.repo.get_by_id(invoice_id, organization_id)
        return inv

    def get_by_number(self, organization_id: int, number: str) -> Optional[Invoice]:
        return self.repo.get_by_number(organization_id, number)

    def list_invoices(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, invoice_type: Optional[str] = None,
        date_from: Optional[str] = None, date_to: Optional[str] = None,
        sort_by: str = "created_at", sort_order: str = "desc",
        currency: Optional[str] = None, min_amount: Optional[float] = None,
        max_amount: Optional[float] = None, payment_status: Optional[str] = None,
        is_overdue: Optional[bool] = None, owner_id: Optional[int] = None,
        contract_id: Optional[int] = None, subscription_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            status=status, invoice_type=invoice_type,
            date_from=date_from, date_to=date_to,
            currency=currency, min_amount=min_amount,
            max_amount=max_amount, is_overdue=is_overdue,
            owner_id=owner_id, contract_id=contract_id,
            subscription_id=subscription_id,
        )

    # ── Enterprise Dashboard ────────────────────────────────────────────────

    def get_enterprise_dashboard_stats(
        self, organization_id: int, date_from: Optional[str] = None, date_to: Optional[str] = None,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        return self.repo.get_enterprise_dashboard_stats(organization_id, date_from=date_from, date_to=date_to, currency_rates=currency_rates)

    def get_invoice_trend(self, organization_id: int, months: int = 12, currency_rates: Optional[Dict[str, float]] = None) -> List:
        return self.repo.get_invoice_trend(organization_id, months, currency_rates=currency_rates)

    def get_revenue_trend(self, organization_id: int, months: int = 12, currency_rates: Optional[Dict[str, float]] = None) -> List:
        return self.repo.get_revenue_trend(organization_id, months, currency_rates=currency_rates)

    def get_payment_collection_trend(self, organization_id: int, months: int = 12) -> List:
        return self.repo.get_payment_collection_trend(organization_id, months)

    def get_status_distribution(self, organization_id: int) -> List:
        return self.repo.get_status_distribution(organization_id)

    def get_monthly_revenue_stats(self, organization_id: int, months: int = 12, currency_rates: Optional[Dict[str, float]] = None) -> List:
        return self.repo.get_monthly_revenue_stats(organization_id, months, currency_rates=currency_rates)

    def get_recent_activity(self, organization_id: int, limit: int = 10) -> List:
        return self.repo.get_recent_activity(organization_id, limit)

    def bulk_delete_invoices(self, organization_id: int, ids: List[int], updated_by: int) -> int:
        count = self.repo.bulk_delete(ids, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "Invoice", None, new_values={"deleted_ids": ids})
        return count

    # ── Items ─────────────────────────────────────────────────────────────

    def _validate_tax_rate_ownership(self, organization_id: int, tax_rate_id: Optional[int]) -> None:
        """A client-supplied tax_rate_id must belong to this organization --
        never trust it blindly (same org-scoped-or-reject principle as every
        other cross-tenant guard in this codebase)."""
        if tax_rate_id is None:
            return
        owned = self.db.query(TaxRate).filter(
            TaxRate.id == tax_rate_id, TaxRate.organization_id == organization_id,
        ).first()
        if owned is None:
            raise BadRequestException("Invalid tax rate.")

    def add_item(self, invoice_id: int, organization_id: int, **data: Any) -> InvoiceItem:
        data = filter_allowed(data, ITEM_ALLOWED_FIELDS)
        self._validate_tax_rate_ownership(organization_id, data.get("tax_rate_id"))
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status != InvoiceStatus.DRAFT:
            raise BadRequestException("Cannot add items to a finalized invoice. Create a credit note or adjustment instead.")
        # Check for duplicate or missing line_number
        existing_items = self.item_repo.list_by_invoice(organization_id, invoice_id)
        if not data.get("line_number"):
            existing_lines = [item.line_number for item in existing_items if item.line_number is not None]
            data["line_number"] = (max(existing_lines) + 1) if existing_lines else 1
        elif any(item.line_number == data["line_number"] for item in existing_items):
            raise BadRequestException(f"Line number {data['line_number']} already exists on this invoice")
        product_id = data.get("product_id")
        if product_id is not None:
            price_source = (data.get("price_source") or "").lower()
            if price_source == PriceSource.NEGOTIATED.value:
                product = (
                    self.db.query(Product)
                    .filter(
                        Product.id == product_id,
                        Product.organization_id == organization_id,
                    )
                    .first()
                )
                if product:
                    data["base_price"] = Decimal(str(product.default_price or 0))
                data["resolved_price"] = Decimal(str(data.get("unit_price", 0)))
                data["pricing_plan_id"] = None
                data["resolved_price_type"] = data.get(
                    "resolved_price_type", "unit"
                )
            else:
                resolver = PriceResolver(self.db)
                result = resolver.resolve(
                    organization_id=organization_id,
                    product_id=product_id,
                    pricing_plan_id=data.get("pricing_plan_id"),
                    quantity=Decimal(str(data.get("quantity", 1))),
                )
                data["base_price"] = result.base_price
                data["resolved_price"] = result.resolved_price
                data["pricing_plan_id"] = result.pricing_plan_id
                data["price_source"] = result.price_source
                data["unit_price"] = result.resolved_price
                data["resolved_price_type"] = result.resolved_price_type
        # Recalculate financials server-side so unit_price/discount/tax/total
        # are 100% consistent with the price resolution semantics (unit vs
        # graduated/lump-sum), exactly like bulk_set_items does.
        data = self._calculate_populate_item_financials_or_use(data)
        return self.item_repo.create(organization_id, invoice_id=invoice_id, **data)

    def _calculate_line_total(self, item_data: Dict[str, Any]) -> Decimal:
        """Calculate line item total: (qty * unit_price) - discount + tax"""
        qty = Decimal(str(item_data.get("quantity", 1)))
        if item_data.get("original_amount") is not None:
            price = Decimal(str(item_data.get("original_amount")))
            rate = Decimal(str(item_data.get("exchange_rate", 1)))
        else:
            price = Decimal(str(item_data.get("unit_price", 0)))
            rate = Decimal("1.0")
        disc_pct = Decimal(str(item_data.get("discount_percentage", 0)))
        tax_pct = Decimal(str(item_data.get("tax_percentage", 0)))
        is_tax_inclusive = bool(item_data.get("is_tax_inclusive", False))
        res = CalculationService.calculate_line_item(qty, price, disc_pct, tax_percentage=tax_pct, exchange_rate=rate, is_tax_inclusive=is_tax_inclusive)
        return round_money(res["converted_line_total"])

    def bulk_set_items(self, invoice_id: int, organization_id: int, items: List[Dict[str, Any]]) -> List[InvoiceItem]:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status != InvoiceStatus.DRAFT:
            raise BadRequestException("Cannot modify items on a finalized invoice. Create a credit note or adjustment instead.")
        
        # Get invoice currency for conversion
        invoice_currency = inv.currency or self.config_service.get_default_currency(organization_id)
        
        self.item_repo.delete_by_invoice(organization_id, invoice_id)
        created_items = []
        for idx, it in enumerate(items):
            item_data = filter_allowed(it, ITEM_ALLOWED_FIELDS)
            self._validate_tax_rate_ownership(organization_id, item_data.get("tax_rate_id"))

            # Handle currency conversion if product currency differs from invoice currency
            if item_data.get("original_currency") and item_data.get("original_amount"):
                item_data = self._apply_currency_conversion(item_data, invoice_currency, organization_id)
            
            # Recalculate financials to be 100% correct in DB
            item_data = self._calculate_populate_item_financials_or_use(item_data)
            item_data["line_number"] = idx + 1
            created_items.append(self.item_repo.create(organization_id, invoice_id=invoice_id, **item_data))
        
        # Recalculate invoice totals after items are set
        self.recalculate_invoice(invoice_id, organization_id)
        return created_items

    def _calculate_populate_item_financials_or_use(self, item_data: Dict[str, Any]) -> Dict[str, Any]:
        qty = Decimal(str(item_data.get("quantity", 1)))
        if item_data.get("original_amount") is not None:
            price = Decimal(str(item_data.get("original_amount")))
            rate = Decimal(str(item_data.get("exchange_rate", 1)))
        else:
            price = Decimal(str(item_data.get("unit_price", 0)))
            rate = Decimal("1.0")
        disc_pct = Decimal(str(item_data.get("discount_percentage", 0)))
        tax_pct = Decimal(str(item_data.get("tax_percentage", 0)))
        is_tax_inclusive = bool(item_data.get("is_tax_inclusive", False))
        semantics = item_data.get("resolved_price_type") or "unit"
        res = CalculationService.calculate_line_item(
            qty, price, disc_pct, tax_percentage=tax_pct, exchange_rate=rate,
            is_tax_inclusive=is_tax_inclusive, price_semantics=semantics,
        )

        # We always populate these to keep DB correct
        item_data["converted_amount"] = round_money(res["converted_unit_price"])
        item_data["unit_price"] = round_money(res["converted_unit_price"])
        item_data["discount_amount"] = round_money(res["converted_discount"])
        item_data["tax_amount"] = round_money(res["converted_tax_amount"])
        item_data["total"] = round_money(res["converted_line_total"])
        return item_data

    def list_items(self, invoice_id: int, organization_id: int) -> List[InvoiceItem]:
        self.repo.get_by_id(invoice_id, organization_id)
        return self.item_repo.list_by_invoice(organization_id, invoice_id)

    def recalculate_invoice(self, invoice_id: int, organization_id: int) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status != InvoiceStatus.DRAFT:
            raise BadRequestException("Cannot recalculate a finalized invoice. Only draft invoices can be recalculated.")
        self.db.expire(inv)
        
        items_data = []
        for item in inv.items:
            qty = Decimal(str(item.quantity))
            if item.original_amount is not None:
                price = Decimal(str(item.original_amount))
                rate = Decimal(str(item.exchange_rate or 1))
            else:
                price = Decimal(str(item.unit_price))
                rate = Decimal("1.0")
            disc_pct = Decimal(str(item.discount_percentage or 0))
            tax_pct = Decimal(str(item.tax_percentage or 0))
            is_tax_inclusive = bool(getattr(item, "is_tax_inclusive", False))
            semantics = getattr(item, "resolved_price_type", None) or "unit"

            res = CalculationService.calculate_line_item(
                qty, price, disc_pct, tax_percentage=tax_pct, exchange_rate=rate,
                is_tax_inclusive=is_tax_inclusive, price_semantics=semantics,
            )

            # Sync individual item values in DB
            item.converted_amount = round_money(res["converted_unit_price"])
            item.unit_price = round_money(res["converted_unit_price"])
            item.discount_amount = round_money(res["converted_discount"])
            item.tax_amount = round_money(res["converted_tax_amount"])
            item.total = round_money(res["converted_line_total"])

            items_data.append({
                "quantity": qty,
                "unit_price": price,
                "discount_percentage": disc_pct,
                "tax_percentage": tax_pct,
                "exchange_rate": rate,
                "is_tax_inclusive": is_tax_inclusive,
                "price_semantics": semantics,
            })
            
        totals = self.calculate_invoice_totals(items_data, inv.discount_percentage, currency=inv.currency)
        inv.subtotal = totals["subtotal"]
        inv.discount_amount = totals["discount_amount"]
        inv.tax_amount = totals["tax_amount"]

        # Shipping and round-off are invoice-level adjustments applied after tax —
        # not part of CalculationService's line-item/document math, just added on
        # top of its result here, same as a formal invoice's "Shipping" and
        # "Round Off" lines. shipping_amount/round_off are not currency-converted
        # (they're entered directly in the invoice's own currency), only rounded.
        shipping = round_money(inv.shipping_amount or Decimal("0"), inv.currency)
        round_adjustment = round_money(inv.round_off or Decimal("0"), inv.currency)
        inv.shipping_amount = shipping
        inv.round_off = round_adjustment
        inv.total_amount = totals["total_amount"] + shipping + round_adjustment
        inv.balance_due = inv.total_amount - (inv.paid_amount or Decimal("0"))
        safe_commit_and_refresh(self.db, inv)
        return inv

    # ── Status Transitions ─────────────────────────────────────────────────

    def finalize_invoice(self, invoice_id: int, organization_id: int, updated_by: int) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        self._validate_status_transition(inv.status, InvoiceStatus.SENT)
        old_status = inv.status.value
        self.recalculate_invoice(invoice_id, organization_id)
        inv.status = InvoiceStatus.SENT
        inv.sent_at = datetime.utcnow()
        self._record_status_history(organization_id, invoice_id, old_status, InvoiceStatus.SENT, updated_by)
        self._record_invoice_tax_snapshots(invoice_id, organization_id, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.SEND, "Invoice", invoice_id)
        safe_commit_and_refresh(self.db, inv)
        return inv

    def mark_sent(self, invoice_id: int, organization_id: int, updated_by: int) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status == InvoiceStatus.SENT:
            return inv
        return self.finalize_invoice(invoice_id, organization_id, updated_by)

    def send_invoice_via_email(self, invoice_id: int, organization_id: int, sent_by: int) -> Dict[str, Any]:
        """Validate customer email, generate the PDF, deliver the email, and
        ONLY THEN update status to SENT.

        PDF generation and email delivery must both succeed before the
        invoice is marked sent — either failing leaves the invoice in its
        prior status untouched (no status mutation, no sent_at, no commit).
        Note: send_invoice_email/send_approval_email never raise on SMTP
        failure — they return False — so both an exception and a False
        return are treated as delivery failure here.
        """
        from app.services.email_service import send_invoice_email

        inv = self.repo.get_by_id(invoice_id, organization_id)

        if inv.status not in (InvoiceStatus.DRAFT, InvoiceStatus.SENT):
            raise BadRequestException(f"Cannot send invoice in '{inv.status.value}' status. Only draft or sent invoices can be emailed.")

        customer = self.customer_service.get_customer(inv.customer_id, organization_id)
        email = (customer.email or "").strip()
        if not email or "@" not in email:
            raise BadRequestException(
                f"Customer '{customer.company_name}' does not have a valid email address. "
                "Please update the customer profile before sending."
            )

        if inv.status == InvoiceStatus.DRAFT:
            self.recalculate_invoice(invoice_id, organization_id)
            inv = self.repo.get_by_id(invoice_id, organization_id)

        old_status = inv.status.value

        review_url = f"{settings.FRONTEND_URL.rstrip('/')}/invoice/{self._public_invoice_token(invoice_id)}"

        issue_date_str = _fmt_short_date(inv.issue_date or inv.created_at or datetime.utcnow())
        due_date_str = _fmt_short_date(inv.due_date or datetime.utcnow())
        total_str = f"{round_money(inv.total_amount or 0, inv.currency):,.2f}"
        balance_str = f"{round_money(inv.balance_due if inv.balance_due is not None else 0, inv.currency):,.2f}"
        subtotal_str = f"{round_money(inv.subtotal or 0, inv.currency):,.2f}"
        tax_str = f"{round_money(inv.tax_amount or 0, inv.currency):,.2f}"
        paid_str = f"{round_money(inv.paid_amount or 0, inv.currency):,.2f}"

        items = self.item_repo.list_by_invoice(organization_id, invoice_id)

        def _fmt_qty(q) -> str:
            if q is None:
                return ""
            if q == q.to_integral_value():
                return str(int(q))
            return f"{q:.2f}".rstrip("0").rstrip(".")

        line_items = [
            {
                "description": item.description,
                "quantity": _fmt_qty(item.quantity),
                "unit_price": f"{round_money(item.unit_price, inv.currency):,.2f}",
                "total_amount": f"{round_money(item.total, inv.currency):,.2f}",
            }
            for item in items
        ]

        # PDF generation must succeed before the invoice can be marked SENT —
        # a failed PDF is no longer silently downgraded to "send without
        # attachment". Nothing has been mutated on `inv` yet, so a plain
        # rollback (defensive — covers any DB-level error inside PDF
        # generation, not just Python-level ones) leaves the session clean.
        try:
            from app.modules.billing.services.pdf_service import generate_invoice_pdf
            org_config = self.config_service.get_configuration(organization_id)
            pdf_bytes = generate_invoice_pdf(inv, customer, items, org_config, db=self.db)
        except Exception as e:
            logger.warning("Failed to generate PDF for invoice %d, invoice was not sent: %s", invoice_id, e)
            self.db.rollback()
            raise BadRequestException("Failed to generate the invoice PDF. Invoice was not marked as sent.")

        try:
            email_sent = send_invoice_email(
                email=email,
                customer_name=customer.display_name or customer.company_name,
                recipient_first_name=customer.first_name or "",
                invoice_number=inv.invoice_number or f"#{inv.id}",
                issue_date=issue_date_str,
                due_date=due_date_str,
                total_amount=total_str,
                currency=inv.currency or self.config_service.get_default_currency(organization_id),
                status="Issued",
                balance_due=balance_str,
                subtotal=subtotal_str,
                tax_amount=tax_str,
                amount_paid=paid_str,
                reference=inv.po_number or "",
                notes=inv.notes or "",
                line_items=line_items,
                organization_id=organization_id,
                db=self.db,
                pdf_bytes=pdf_bytes,
                pdf_filename=f"{inv.invoice_number or f'invoice-{inv.id}'}.pdf",
                review_url=review_url,
            )
        except Exception as e:
            logger.warning("Failed to send invoice email for invoice %d: %s", invoice_id, e)
            email_sent = False

        if not email_sent:
            self.db.rollback()
            raise BadRequestException("Failed to send the invoice email. Invoice was not marked as sent.")

        # Both PDF generation and email delivery succeeded — only now is the
        # invoice actually transitioned to SENT and committed.
        inv.status = InvoiceStatus.SENT
        inv.sent_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(inv)

        self._record_status_history(organization_id, invoice_id, old_status, InvoiceStatus.SENT.value, sent_by, "Sent via email")
        self._record_invoice_tax_snapshots(invoice_id, organization_id, sent_by)
        self.audit.log(
            organization_id, sent_by, BillingAuditAction.SEND, "Invoice", invoice_id,
            new_values={"email_sent_to": email, "email_delivered": True},
        )
        # Snapshot everything the response needs now, before attempting the
        # communication log — a failure there rolls back and expires ORM
        # objects, and the response must not depend on `inv` staying loaded.
        response = {
            "invoice_id": inv.id,
            "invoice_number": inv.invoice_number,
            "status": inv.status.value,
            "email_sent_to": email,
            "email_delivered": True,
            "sent_at": inv.sent_at.isoformat() if inv.sent_at else None,
            "message": f"Invoice emailed to {email}",
        }

        # Logging the communication is a secondary side effect — its failure
        # (e.g. table unavailable) must never be reported to the caller as an
        # email delivery failure, since the email itself already went out.
        self.comms_repo.record_event_safe(
            organization_id=organization_id,
            invoice_id=invoice_id,
            event_type=CommunicationEventType.EMAIL_SENT,
            status=CommunicationEventStatus.DELIVERED,
            recipient=email,
            subject=f"Invoice {response['invoice_number']}",
            body_preview=f"Invoice {response['invoice_number']} sent to {email}",
            event_metadata={"email_delivered": True, "attempt_via": "manual"},
            created_by=sent_by,
        )

        return response

    # ── Public Invoice View / Payment (no auth — token in the emailed link) ──

    def _public_invoice_token(self, invoice_id: int) -> str:
        """Stateless, signed token for the public invoice/payment link. Nothing
        is stored in the DB — the token is `base64url(invoice_id.hmac(secret))`
        and recomputed on each request, so a leaked link cannot be forged and
        no migration is needed."""
        sig = hmac.new(
            settings.BILLING_SECRET_KEY.encode(),
            str(invoice_id).encode(),
            hashlib.sha256,
        ).hexdigest()
        return base64.urlsafe_b64encode(f"{invoice_id}.{sig}".encode()).decode().rstrip("=")

    def _resolve_public_invoice(self, token: str) -> Invoice:
        if not token:
            raise NotFoundException("Invoice", 0)
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
            invoice_id_str, _, sig = raw.partition(".")
            expected = hmac.new(
                settings.BILLING_SECRET_KEY.encode(),
                invoice_id_str.encode(),
                hashlib.sha256,
            ).hexdigest()
            if not invoice_id_str.isdigit() or not hmac.compare_digest(sig, expected):
                raise ValueError("bad signature")
            invoice_id = int(invoice_id_str)
        except Exception:
            raise NotFoundException("Invoice", 0)
        inv = self.db.query(Invoice).options(
            joinedload(Invoice.customer)
        ).filter(Invoice.id == invoice_id).first()
        if inv is None or inv.deleted_at is not None:
            raise NotFoundException("Invoice", invoice_id)
        return inv

    def get_public_invoice(self, token: str) -> Dict[str, Any]:
        """Public-safe snapshot of an invoice for the customer-facing view &
        payment page. Only fields the recipient should see are exposed — no
        internal pricing/tax-rate details, no org internals, no audit trail."""
        from app.services.email_service import _get_org_branding
        from app.modules.billing.services.stripe_service import StripeService

        inv = self._resolve_public_invoice(token)
        branding = _get_org_branding(inv.organization_id, db=self.db)
        config = self.config_service.get_configuration(inv.organization_id)
        customer = inv.customer
        items = sorted(inv.items or [], key=lambda i: i.line_number or 0)

        currency = inv.currency or "USD"

        def _money(v) -> str:
            return f"{round_money(v if v is not None else 0, currency):,.2f}"

        def _fmt_date(d) -> Optional[str]:
            return d.strftime("%d %b %Y") if d else None

        balance = Decimal(str(inv.balance_due if inv.balance_due is not None else inv.total_amount or 0))
        paid = Decimal(str(inv.paid_amount or 0))
        payable = balance > 0 and inv.status not in (
            InvoiceStatus.PAID, InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED,
        )
        if inv.status == InvoiceStatus.PAID or (balance <= 0 and inv.status in (InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID)):
            payment_status = "paid"
        elif paid > 0 and balance > 0:
            payment_status = "partially_paid"
        elif inv.status in (InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED, InvoiceStatus.WRITTEN_OFF):
            payment_status = "uncollectable"
        else:
            payment_status = "unpaid"

        gateways = []
        gateway_flags = {
            "stripe": config.gateway_stripe_enabled,
            "razorpay": config.gateway_razorpay_enabled,
            "paypal": config.gateway_paypal_enabled,
            "cash": config.gateway_cash_enabled,
            "bank_transfer": config.gateway_bank_transfer_enabled,
            "upi": config.gateway_upi_enabled,
            "offline": config.gateway_offline_enabled,
        }
        for name, enabled in gateway_flags.items():
            if enabled:
                gateways.append(name)

        return {
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "invoice_type": inv.invoice_type.value if inv.invoice_type else "standard",
            "status": inv.status.value if inv.status else "draft",
            "issue_date": _fmt_date(inv.issue_date),
            "due_date": _fmt_date(inv.due_date),
            "paid_at": inv.paid_at.strftime("%d %b %Y %H:%M") if inv.paid_at else None,
            "currency": currency,
            "subtotal": _money(inv.subtotal),
            "discount_percentage": str(inv.discount_percentage or 0),
            "discount_amount": _money(inv.discount_amount),
            "tax_amount": _money(inv.tax_amount),
            "shipping_amount": _money(inv.shipping_amount),
            "round_off": _money(inv.round_off),
            "total_amount": _money(inv.total_amount),
            "paid_amount": _money(paid),
            "balance_due": _money(balance),
            "notes": inv.notes,
            "po_number": inv.po_number,
            "payment_terms": inv.payment_terms or (config.default_payment_terms.value if config.default_payment_terms else None),
            "customer": {
                "name": (customer.display_name or customer.company_name) if customer else "",
                "email": (customer.email or "") if customer else "",
                "phone": (customer.phone or "") if customer else "",
                "mobile": (customer.mobile or "") if customer else "",
                "billing_address": (customer.billing_address or "") if customer else "",
                "shipping_address": (customer.shipping_address or "") if customer else "",
                "gst_number": (customer.gst_number or "") if customer else "",
                "vat_number": (customer.vat_number or "") if customer else "",
                "pan": (customer.pan or "") if customer else "",
            },
            "items": [
                {
                    "line_number": item.line_number,
                    "item_type": item.item_type.value if item.item_type else "product",
                    "description": item.description,
                    "quantity": str(item.quantity),
                    "unit_price": _money(item.unit_price),
                    "discount_percentage": str(item.discount_percentage or 0),
                    "discount_amount": _money(item.discount_amount),
                    "tax_percentage": str(item.tax_percentage or 0),
                    "tax_amount": _money(item.tax_amount),
                    "total_amount": _money(item.total),
                }
                for item in items
            ],
            "company": {
                "name": branding.get("company_name", "Zoiko Billing"),
                "logo_url": branding.get("logo_url", ""),
                "support_email": branding.get("support_email", ""),
                "website": branding.get("website", ""),
                "billing_address": branding.get("billing_address", ""),
            },
            "payment": {
                "payment_status": payment_status,
                "amount_paid": _money(paid),
                "balance_due": _money(balance),
                "payable": bool(payable),
                "due_date": _fmt_date(inv.due_date),
                "payment_terms": inv.payment_terms or (config.default_payment_terms.value if config.default_payment_terms else None),
                "gateways": gateways,
                "stripe": {
                    "configured": StripeService.is_configured(),
                    "publishable_key": StripeService.publishable_key(),
                },
            },
        }

    def create_public_checkout_session(self, token: str, success_url: str, cancel_url: str) -> Dict[str, Any]:
        """Create a Stripe Checkout session from the public invoice link.

        This is the hook the frontend "Pay now" button calls. When Stripe is
        not configured (STRIPE_SECRET_KEY unset) it returns a graceful
        placeholder so the payment UI can advertise "online payments coming
        soon" — the same contract the StripeService exposes once configured.
        """
        from app.modules.billing.services.stripe_service import StripeService

        inv = self._resolve_public_invoice(token)
        if not StripeService.is_configured():
            return {
                "configured": False,
                "checkout_url": None,
                "invoice_number": inv.invoice_number,
                "message": "Online card payments are not enabled yet. Please contact the sender to complete payment.",
            }
        svc = StripeService(self.db)
        result = svc.create_checkout_session(
            organization_id=inv.organization_id,
            invoice_id=inv.id,
            success_url=success_url,
            cancel_url=cancel_url,
            created_by=None,
        )
        result["configured"] = True
        return result

    def record_payment(self, invoice_id: int, organization_id: int, amount: Decimal, updated_by: int) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status in (InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED):
            raise BadRequestException(f"Cannot record payment on a {inv.status.value} invoice")
        if amount <= 0:
            raise BadRequestException("Payment amount must be positive")
        if inv.balance_due <= 0:
            raise BadRequestException("Invoice is already fully paid")
        if amount > inv.balance_due:
            raise BadRequestException(
                f"Payment amount {amount} exceeds remaining balance {inv.balance_due}"
            )
        old_status = inv.status.value
        # balance_due is decremented incrementally from its current
        # (already-correct) value, not recomputed as total_amount -
        # paid_amount, which would silently discard any write-off reduction
        # already applied to balance_due independently of paid_amount (see
        # record_write_off). This method is the credit-note settlement path
        # (CreditNoteService.apply_to_invoice) as well as any other direct
        # caller — a credit note is not cash, but it reduces the same
        # collectible balance_due that cash payments draw down.
        inv.paid_amount = (inv.paid_amount or Decimal("0")) + amount
        inv.balance_due = (inv.balance_due or Decimal("0")) - amount
        if inv.balance_due <= 0:
            inv.status = InvoiceStatus.PAID
            inv.paid_at = datetime.utcnow()
        else:
            inv.status = InvoiceStatus.PARTIALLY_PAID
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(organization_id, invoice_id, old_status, inv.status.value, updated_by)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.PAY, "Invoice", invoice_id,
            new_values={"amount": str(amount), "balance_due": str(inv.balance_due), "status": inv.status.value},
        )
        return inv

    def record_refund(self, invoice_id: int, organization_id: int, amount: Decimal, updated_by: int) -> Invoice:
        """Inverse of record_payment — reopens invoice balance when money is
        refunded back out. Called by RefundService.complete_refund for
        invoice-sourced refunds; never mutates a cancelled invoice."""
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status == InvoiceStatus.CANCELLED:
            raise BadRequestException("Cannot record a refund on a cancelled invoice")
        if amount <= 0:
            raise BadRequestException("Refund amount must be positive")
        if amount > (inv.paid_amount or Decimal("0")):
            raise BadRequestException(
                f"Refund amount {amount} exceeds the invoice's paid amount {inv.paid_amount}"
            )
        old_status = inv.status.value
        # balance_due is reopened incrementally, not recomputed as
        # total_amount - paid_amount, which would silently discard any
        # write-off reduction already applied to balance_due independently
        # of paid_amount (see record_write_off).
        inv.paid_amount = (inv.paid_amount or Decimal("0")) - amount
        inv.balance_due = (inv.balance_due or Decimal("0")) + amount
        if inv.paid_amount <= 0:
            inv.status = InvoiceStatus.REFUNDED
        elif inv.balance_due > 0:
            inv.status = InvoiceStatus.PARTIALLY_PAID
        else:
            inv.status = InvoiceStatus.PAID
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(
            organization_id, invoice_id, old_status, inv.status.value, updated_by,
            reason=f"Refunded {amount}",
        )
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.REFUND, "Invoice", invoice_id,
            new_values={"amount": str(amount), "balance_due": str(inv.balance_due), "status": inv.status.value},
        )
        return inv

    def record_write_off(self, invoice_id: int, organization_id: int, amount: Decimal, updated_by: int) -> Invoice:
        """Reduce an invoice's outstanding balance because collection has been
        given up on. Unlike record_payment/record_refund, no money moves and
        paid_amount is untouched — only balance_due shrinks. Called by
        WriteOffService.execute_write_off for invoice-sourced write-offs;
        never mutates a cancelled or already fully-paid invoice."""
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status in (InvoiceStatus.CANCELLED, InvoiceStatus.PAID, InvoiceStatus.REFUNDED):
            raise BadRequestException(f"Cannot write off a {inv.status.value} invoice")
        if amount <= 0:
            raise BadRequestException("Write-off amount must be positive")
        if amount > (inv.balance_due or Decimal("0")):
            raise BadRequestException(
                f"Write-off amount {amount} exceeds the invoice's outstanding balance {inv.balance_due}"
            )
        old_status = inv.status.value
        inv.balance_due = (inv.balance_due or Decimal("0")) - amount
        if inv.balance_due <= 0:
            inv.status = InvoiceStatus.WRITTEN_OFF
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(
            organization_id, invoice_id, old_status, inv.status.value, updated_by,
            reason=f"Written off {amount}",
        )
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.WRITE_OFF, "Invoice", invoice_id,
            new_values={"amount": str(amount), "balance_due": str(inv.balance_due), "status": inv.status.value},
        )
        return inv

    def reverse_write_off(self, invoice_id: int, organization_id: int, amount: Decimal, updated_by: int) -> Invoice:
        """Inverse of record_write_off — reopens invoice balance when a
        write-off is reversed. Called by WriteOffService.reverse_write_off;
        never mutates a cancelled invoice."""
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status == InvoiceStatus.CANCELLED:
            raise BadRequestException("Cannot reverse a write-off on a cancelled invoice")
        if amount <= 0:
            raise BadRequestException("Reversal amount must be positive")
        old_status = inv.status.value
        inv.balance_due = (inv.balance_due or Decimal("0")) + amount
        if inv.balance_due > 0:
            if (inv.paid_amount or Decimal("0")) > 0:
                inv.status = InvoiceStatus.PARTIALLY_PAID
            elif inv.due_date and inv.due_date < datetime.utcnow().date():
                inv.status = InvoiceStatus.OVERDUE
            else:
                inv.status = InvoiceStatus.SENT
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(
            organization_id, invoice_id, old_status, inv.status.value, updated_by,
            reason=f"Write-off reversed {amount}",
        )
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.REVERSE, "Invoice", invoice_id,
            new_values={"amount": str(amount), "balance_due": str(inv.balance_due), "status": inv.status.value},
        )
        return inv

    def cancel_invoice(self, invoice_id: int, organization_id: int, reason: Optional[str] = None, updated_by: int = None) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        self._validate_status_transition(inv.status, InvoiceStatus.CANCELLED)
        old_status = inv.status.value
        inv.status = InvoiceStatus.CANCELLED
        inv.cancelled_at = datetime.utcnow()
        inv.cancellation_reason = reason
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(organization_id, invoice_id, old_status, InvoiceStatus.CANCELLED.value, updated_by, reason)
        self.audit.log(organization_id, updated_by, BillingAuditAction.CANCEL, "Invoice", invoice_id)
        return inv

    def void_invoice(self, invoice_id: int, organization_id: int, reason: Optional[str] = None, updated_by: int = None) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        if inv.status in (InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED):
            raise BadRequestException("Invoice cannot be voided")
        if inv.status != InvoiceStatus.DRAFT:
            self._validate_status_transition(inv.status, InvoiceStatus.CANCELLED)
        old_status = inv.status.value
        inv.status = InvoiceStatus.CANCELLED
        inv.cancelled_at = datetime.utcnow()
        inv.cancellation_reason = reason or "Voided"
        inv.is_active = False
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(organization_id, invoice_id, old_status, InvoiceStatus.CANCELLED.value, updated_by, reason or "Voided")
        self.audit.log(organization_id, updated_by, BillingAuditAction.VOID, "Invoice", invoice_id)
        return inv

    def mark_overdue(self, invoice_id: int, organization_id: int, updated_by: int) -> Invoice:
        inv = self.repo.get_by_id(invoice_id, organization_id)
        self._validate_status_transition(inv.status, InvoiceStatus.OVERDUE)
        old_status = inv.status.value
        inv.status = InvoiceStatus.OVERDUE
        safe_commit_and_refresh(self.db, inv)
        self._record_status_history(organization_id, invoice_id, old_status, InvoiceStatus.OVERDUE.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Invoice", invoice_id)
        return inv

    # ── Queries ────────────────────────────────────────────────────────────

    def list_overdue(self, organization_id: int) -> List[Invoice]:
        return self.repo.list_overdue(organization_id)

    def list_due_between(self, organization_id: int, start_date: str, end_date: str) -> List[Invoice]:
        return self.repo.list_due_between(organization_id, start_date, end_date)

    def get_outstanding_total(self, organization_id: int) -> float:
        return self.repo.get_outstanding_total(organization_id)

    def get_dashboard_stats(self, organization_id: int, period: Optional[str] = None, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        return self.repo.get_dashboard_stats(organization_id, period=period, currency_rates=currency_rates)

    # ── Status History ─────────────────────────────────────────────────────

    def list_status_history(self, invoice_id: int, organization_id: int) -> List[InvoiceStatusHistory]:
        self.repo.get_by_id(invoice_id, organization_id)
        return self.history_repo.list_by_invoice(organization_id, invoice_id)

    # ── Communication History ─────────────────────────────────────────────

    def list_communications(self, invoice_id: int, organization_id: int) -> List[InvoiceCommunication]:
        self.repo.get_by_id(invoice_id, organization_id)
        return self.comms_repo.list_by_invoice_safe(organization_id, invoice_id)

    def add_communication_note(
        self, invoice_id: int, organization_id: int, created_by: int,
        note: str, **kwargs: Any,
    ) -> InvoiceCommunication:
        self.repo.get_by_id(invoice_id, organization_id)
        return self.comms_repo.record_event(
            organization_id=organization_id,
            invoice_id=invoice_id,
            event_type=CommunicationEventType.NOTE_ADDED,
            recipient=None,
            subject=None,
            body_preview=note[:500] if note else None,
            event_metadata={"note": note, **kwargs},
            created_by=created_by,
        )

    # ── Invoice Timeline ──────────────────────────────────────────────────

    def get_timeline(self, invoice_id: int, organization_id: int) -> List[Dict[str, Any]]:
        self.repo.get_by_id(invoice_id, organization_id)
        entries = []

        for sh in self.history_repo.list_by_invoice(organization_id, invoice_id):
            entries.append({
                "timestamp": sh.created_at,
                "event_type": "status_change",
                "title": f"Status changed to {sh.to_status}",
                "description": sh.reason,
                "actor_id": sh.changed_by,
                "metadata": {
                    "from_status": sh.from_status,
                    "to_status": sh.to_status,
                    "status_history_id": sh.id,
                },
            })

        for comm in self.comms_repo.list_by_invoice_safe(organization_id, invoice_id):
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": {
                    CommunicationEventType.EMAIL_SENT: "Invoice emailed",
                    CommunicationEventType.EMAIL_DELIVERED: "Email delivered",
                    CommunicationEventType.EMAIL_BOUNCED: "Email bounced",
                    CommunicationEventType.EMAIL_FAILED: "Email failed",
                    CommunicationEventType.REMINDER_SENT: "Reminder sent",
                    CommunicationEventType.SMS_SENT: "SMS sent",
                    CommunicationEventType.NOTE_ADDED: "Note added",
                    CommunicationEventType.MANUAL_RESEND: "Manual resend",
                    CommunicationEventType.PAYMENT_RECEIPT_SENT: "Payment receipt sent",
                }.get(comm.event_type, comm.event_type),
                "description": comm.subject or comm.body_preview,
                "actor_id": comm.created_by,
                "metadata": {
                    "recipient": comm.recipient,
                    "status": comm.status,
                    "communication_id": comm.id,
                    **(comm.event_metadata or {}),
                },
            })

        allocations = (
            self.db.query(PaymentAllocation)
            .filter(
                PaymentAllocation.invoice_id == invoice_id,
                PaymentAllocation.organization_id == organization_id,
            )
            .all()
        )
        for alloc in allocations:
            entries.append({
                "timestamp": alloc.created_at,
                "event_type": "payment_allocated",
                "title": f"Payment of {alloc.amount} allocated",
                "description": f"Payment #{alloc.payment_id}",
                "actor_id": alloc.created_by,
                "metadata": {
                    "amount": str(alloc.amount),
                    "payment_id": alloc.payment_id,
                    "allocation_id": alloc.id,
                },
            })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries
