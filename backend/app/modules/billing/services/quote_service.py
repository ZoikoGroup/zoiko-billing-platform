import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    NotFoundException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    InvoiceType,
    PriceSource,
    PricingPlan,
    Product,
    QuoteStatus,
    Quotation,
    QuotationItem,
)
from app.modules.billing.repositories.sales import (
    QuotationItemRepository,
    QuotationRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.calculation_service import CalculationService
from app.modules.billing.services.base import safe_commit_and_refresh, filter_allowed
from app.modules.billing.services.price_resolver import PriceResolver
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.billing.services.exchange_rate_service import ExchangeRateService
from app.modules.billing.utils.currency_utils import round_money, convert_amount
from app.services.email_service import send_quote_email

logger = logging.getLogger("zoiko")

QUOTE_ALLOWED_FIELDS = {
    "customer_id", "quote_number", "valid_until",
    "discount_percentage", "currency", "notes",
    "terms", "status", "quote_version", "subject",
}
ITEM_ALLOWED_FIELDS = {
    "quotation_id", "line_number", "description", "quantity",
    "unit_price", "discount_percentage", "tax_percentage",
    "total_amount", "discount_amount", "tax_amount", "product_id",
    "is_tax_inclusive",
    "pricing_plan_id", "price_source", "base_price", "resolved_price",
    "original_currency", "original_amount", "exchange_rate",
    "quote_currency", "converted_amount",
}


class QuoteService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = QuotationRepository(db)
        self.item_repo = QuotationItemRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)
        self.config_service = BillingConfigurationService(db)
        self.exchange_rate_service = ExchangeRateService(db)

    def create_quote(
        self, organization_id: int, created_by: int, customer_id: int,
        quote_number: str, **data: Any,
    ) -> Quotation:
        data = filter_allowed(data, QUOTE_ALLOWED_FIELDS)
        self.customer_service.get_customer(customer_id, organization_id)
        if self.repo.exists(organization_id, quote_number=quote_number):
            raise AlreadyExistsException("Quotation", "quote_number")
        quote = self.repo.create(
            organization_id,
            customer_id=customer_id, quote_number=quote_number,
            status=QuoteStatus.DRAFT, **data,
        )
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Quotation", quote.id, new_values=data)
        return quote

    def update_quote(self, quote_id: int, organization_id: int, updated_by: int, **data: Any) -> Quotation:
        data = filter_allowed(data, QUOTE_ALLOWED_FIELDS)
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.DRAFT:
            raise BadRequestException("Only draft quotes can be edited")
        updated = self.repo.update(quote_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Quotation", quote_id)
        return updated

    def get_quote(self, quote_id: int, organization_id: int) -> Quotation:
        return self.repo.get_by_id(quote_id, organization_id)

    def get_quote_by_number(self, organization_id: int, number: str) -> Optional[Quotation]:
        return self.repo.get_by_number(organization_id, number)

    def list_quotes(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, sort_by: Optional[str] = None,
        sort_order: str = "desc", date_from=None, date_to=None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id, status=status,
            date_from=date_from, date_to=date_to,
        )

    # ── Items ─────────────────────────────────────────────────────────────

    def add_item(self, quote_id: int, organization_id: int, **data: Any) -> QuotationItem:
        data = filter_allowed(data, ITEM_ALLOWED_FIELDS)
        quote = self.repo.get_by_id(quote_id, organization_id)
        price_semantics = "unit"
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
                data["price_source"] = PriceSource.NEGOTIATED.value
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
                price_semantics = result.resolved_price_type or "unit"

                quote_currency = quote.currency or "USD"
                product_currency = result.currency or "USD"
                if product_currency != quote_currency:
                    data["original_currency"] = product_currency
                    data["original_amount"] = result.resolved_price
                    data["quote_currency"] = quote_currency
                    rate, source, timestamp = self.exchange_rate_service.get_rate(
                        organization_id, product_currency, quote_currency,
                    )
                    converted = convert_amount(result.resolved_price, rate, quote_currency)
                    data["exchange_rate"] = rate
                    data["converted_amount"] = converted
                    data["unit_price"] = converted
        if not data.get("line_number"):
            existing_lines = [item.line_number for item in (quote.items or []) if item.line_number is not None]
            data["line_number"] = (max(existing_lines) + 1) if existing_lines else 1
        qty = Decimal(str(data.get("quantity", 1)))
        price = Decimal(str(data.get("unit_price", 0)))
        disc_pct = Decimal(str(data.get("discount_percentage", 0)))
        tax_pct = Decimal(str(data.get("tax_percentage", 0)))
        calc = CalculationService.calculate_line_item(qty, price, disc_pct, Decimal("0"), tax_pct, Decimal("1.0"), is_tax_inclusive=data.get("is_tax_inclusive", False), price_semantics=price_semantics)
        quote_currency = quote.currency or "USD"
        data["discount_amount"] = round_money(calc["original_discount"], quote_currency)
        data["tax_amount"] = round_money(calc["original_tax_amount"], quote_currency)
        data["total_amount"] = round_money(calc["original_line_total"], quote_currency)
        return self.item_repo.create(organization_id, quotation_id=quote_id, **data)

    def update_item(self, quote_id: int, item_id: int, organization_id: int, **data: Any) -> QuotationItem:
        data = filter_allowed(data, ITEM_ALLOWED_FIELDS - {"quotation_id", "total_amount", "discount_amount", "tax_amount"})
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.DRAFT:
            raise BadRequestException("Only draft quotes can have items modified")
        item = self.item_repo.get_by_id(item_id, organization_id)
        if item.quotation_id != quote_id:
            raise NotFoundException("QuotationItem", item_id)
        updated = self.item_repo.update(item_id, organization_id, **data)
        self.recalculate_quote(quote_id, organization_id)
        return updated

    def remove_item(self, quote_id: int, item_id: int, organization_id: int) -> None:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.DRAFT:
            raise BadRequestException("Only draft quotes can have items removed")
        item = self.item_repo.get_by_id(item_id, organization_id)
        if item.quotation_id != quote_id:
            raise NotFoundException("QuotationItem", item_id)
        self.item_repo.hard_delete(item_id, organization_id)
        self.recalculate_quote(quote_id, organization_id)

    def bulk_set_items(self, quote_id: int, organization_id: int, items: List[Dict[str, Any]]) -> List[QuotationItem]:
        self.repo.get_by_id(quote_id, organization_id)
        self.item_repo.delete_by_quotation(organization_id, quote_id)
        cleaned = [filter_allowed(item, ITEM_ALLOWED_FIELDS) for item in items]
        result = self.item_repo.bulk_create_for_quotation(organization_id, quote_id, cleaned)
        self.recalculate_quote(quote_id, organization_id)
        return result

    def duplicate_quote(self, quote_id: int, organization_id: int, created_by: int) -> Quotation:
        source = self.repo.get_by_id(quote_id, organization_id)
        new_number = f"{source.quote_number}-COPY"
        n = 1
        while self.repo.exists(organization_id, quote_number=new_number):
            n += 1
            new_number = f"{source.quote_number}-COPY-{n}"
        new_quote = self.repo.create(
            organization_id,
            customer_id=source.customer_id,
            quote_number=new_number,
            status=QuoteStatus.DRAFT,
            quote_version=1,
            subject=source.subject,
            currency=source.currency,
            discount_percentage=source.discount_percentage,
            notes=source.notes,
            terms=source.terms,
            valid_until=source.valid_until,
        )
        for item in source.items:
            self.item_repo.create(
                organization_id,
                quotation_id=new_quote.id,
                line_number=item.line_number,
                product_id=item.product_id,
                description=item.description,
                quantity=item.quantity,
                unit_price=item.unit_price,
                discount_percentage=item.discount_percentage,
                tax_percentage=item.tax_percentage,
                is_tax_inclusive=item.is_tax_inclusive,
                total_amount=item.total_amount,
                discount_amount=item.discount_amount,
                tax_amount=item.tax_amount,
                pricing_plan_id=getattr(item, "pricing_plan_id", None),
                price_source=getattr(item, "price_source", None),
                base_price=getattr(item, "base_price", None),
                resolved_price=getattr(item, "resolved_price", None),
                original_currency=getattr(item, "original_currency", None),
                original_amount=getattr(item, "original_amount", None),
                exchange_rate=getattr(item, "exchange_rate", None),
                quote_currency=getattr(item, "quote_currency", None),
                converted_amount=getattr(item, "converted_amount", None),
            )
        self.recalculate_quote(new_quote.id, organization_id)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Quotation", new_quote.id,
                       new_values={"duplicated_from": quote_id})
        return self.repo.get_by_id(new_quote.id, organization_id)

    def list_items(self, quote_id: int, organization_id: int) -> List[QuotationItem]:
        self.repo.get_by_id(quote_id, organization_id)
        return self.item_repo.list_by_quotation(organization_id, quote_id)

    # ── Calculations ───────────────────────────────────────────────────────
    #
    # Quotes are calculated through the same CalculationService used by
    # contracts, subscriptions and invoices, so a quote and the invoice
    # generated from it always agree on tax-inclusive pricing and totals.

    def calculate_totals(
        self, items: List[Dict[str, Any]],
        discount_percentage: Decimal = Decimal("0"),
        currency: Optional[str] = None,
    ) -> Dict[str, Any]:
        # Delegates to CalculationService.summarize_document_totals — the single
        # source of truth shared with InvoiceService.calculate_invoice_totals, so a
        # quote and the invoice generated from it always agree on totals math.
        return CalculationService.summarize_document_totals(items, discount_percentage, currency=currency)

    def recalculate_quote(self, quote_id: int, organization_id: int) -> Quotation:
        quote = self.repo.get_by_id(quote_id, organization_id)
        items_data = []
        for item in quote.items:
            entry = {
                "quantity": item.quantity,
                "discount_percentage": item.discount_percentage,
                "tax_percentage": item.tax_percentage,
                "is_tax_inclusive": bool(item.is_tax_inclusive),
            }
            if item.original_amount is not None:
                entry["unit_price"] = item.original_amount
                entry["exchange_rate"] = item.exchange_rate or Decimal("1")
            else:
                entry["unit_price"] = item.unit_price
                entry["exchange_rate"] = Decimal("1")
            items_data.append(entry)
        totals = self.calculate_totals(items_data, quote.discount_percentage, currency=quote.currency)
        quote.subtotal = totals["subtotal"]
        quote.discount_amount = totals["discount_amount"]
        quote.tax_amount = totals["tax_amount"]
        quote.total_amount = totals["total_amount"]
        for ci in totals.get("items", []):
            idx = ci["index"]
            if idx < len(quote.items):
                quote.items[idx].total_amount = ci["total_amount"]
                quote.items[idx].discount_amount = ci["discount_amount"]
                quote.items[idx].tax_amount = ci["tax_amount"]
        safe_commit_and_refresh(self.db, quote)
        return quote

    # ── Status Transitions ─────────────────────────────────────────────────

    def send_quote(self, quote_id: int, organization_id: int, updated_by: int) -> Quotation:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.DRAFT:
            raise BadRequestException("Only draft quotes can be sent")
        quote.status = QuoteStatus.SENT
        safe_commit_and_refresh(self.db, quote)

        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(quote.customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                currency = quote.currency or "USD"
                items = quote.items or []

                def _fmt_money(amount) -> str:
                    return f"{round_money(amount or 0, currency):,.2f}"

                def _fmt_date(d) -> str:
                    return d.strftime("%d %b %Y").lstrip("0") if d else "N/A"

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
                        "unit_price": _fmt_money(item.unit_price),
                        "total_amount": _fmt_money(item.total_amount),
                    }
                    for item in items
                ]

                pdf_bytes = None
                try:
                    from app.modules.billing.services.pdf_service import generate_quote_pdf
                    org_config = self.config_service.get_configuration(organization_id)
                    pdf_bytes = generate_quote_pdf(quote, customer, items, org_config, db=self.db)
                except Exception as e:
                    logger.warning("Failed to generate PDF for quote %d, sending without attachment: %s", quote_id, e)

                status_label = quote.status.value if hasattr(quote.status, "value") else str(quote.status)
                email_delivered = send_quote_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    recipient_first_name=customer.first_name or "",
                    quote_number=quote.quote_number,
                    issue_date=_fmt_date(quote.created_at.date()) if quote.created_at else _fmt_date(date.today()),
                    valid_until=_fmt_date(quote.valid_until),
                    total_amount=_fmt_money(quote.total_amount),
                    currency=currency,
                    status=status_label.replace("_", " ").title(),
                    notes=quote.notes or "",
                    line_items=line_items,
                    subtotal=_fmt_money(quote.subtotal),
                    discount_amount=_fmt_money(quote.discount_amount) if quote.discount_amount else "",
                    tax_amount=_fmt_money(quote.tax_amount),
                    reference=quote.subject or "",
                    organization_id=organization_id,
                    db=self.db,
                    pdf_bytes=pdf_bytes,
                    pdf_filename=f"{quote.quote_number}.pdf",
                )
        except Exception as e:
            logger.warning("Failed to send quote email for quote %d: %s", quote_id, e)

        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Quotation", quote_id,
            new_values={"email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return quote

    def accept_quote(self, quote_id: int, organization_id: int, updated_by: int) -> Quotation:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.SENT:
            raise BadRequestException("Only sent quotes can be accepted")
        quote.status = QuoteStatus.ACCEPTED
        quote.accepted_at = datetime.utcnow()
        safe_commit_and_refresh(self.db, quote)
        self.audit.log(organization_id, updated_by, BillingAuditAction.APPROVE, "Quotation", quote_id)
        return quote

    def reject_quote(self, quote_id: int, organization_id: int, reason: str, updated_by: int) -> Quotation:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status not in (QuoteStatus.SENT, QuoteStatus.DRAFT):
            raise BadRequestException("Quote cannot be rejected in its current status")
        quote.status = QuoteStatus.REJECTED
        quote.rejected_reason = reason
        safe_commit_and_refresh(self.db, quote)
        self.audit.log(organization_id, updated_by, BillingAuditAction.REJECT, "Quotation", quote_id)
        return quote

    def cancel_quote(self, quote_id: int, organization_id: int, updated_by: int) -> Quotation:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status in (QuoteStatus.CONVERTED, QuoteStatus.CANCELLED):
            raise BadRequestException("Quote cannot be cancelled")
        quote.status = QuoteStatus.CANCELLED
        safe_commit_and_refresh(self.db, quote)
        self.audit.log(organization_id, updated_by, BillingAuditAction.CANCEL, "Quotation", quote_id)
        return quote

    def check_expired(self, quote_id: int, organization_id: int) -> bool:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.SENT:
            return False
        if quote.valid_until and quote.valid_until < date.today():
            quote.status = QuoteStatus.EXPIRED
            safe_commit_and_refresh(self.db, quote)
            return True
        return False

    # ── Convert to Invoice ─────────────────────────────────────────────────

    def convert_to_invoice(
        self, quote_id: int, organization_id: int, created_by: int,
        invoice_number: str, issue_date: date, due_date: date,
    ) -> Invoice:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.ACCEPTED:
            raise BadRequestException("Only accepted quotes can be converted to invoices")
        from app.modules.billing.services.invoice_service import InvoiceService
        inv_service = InvoiceService(self.db)
        inv = inv_service.create_invoice(
            organization_id=organization_id, created_by=created_by,
            customer_id=quote.customer_id, invoice_number=invoice_number,
            _skip_recalculate=True,
            invoice_type=InvoiceType.STANDARD, issue_date=issue_date,
            due_date=due_date,
            discount_percentage=quote.discount_percentage,
            currency=quote.currency, quotation_id=quote_id,
        )
        for item in quote.items:
            inv_service.add_item(
                invoice_id=inv.id, organization_id=organization_id,
                line_number=item.line_number,
                description=item.description, quantity=item.quantity,
                unit_price=item.unit_price,
                discount_percentage=item.discount_percentage,
                discount_amount=item.discount_amount,
                tax_percentage=item.tax_percentage, tax_amount=item.tax_amount,
                is_tax_inclusive=item.is_tax_inclusive,
                total=item.total_amount,
                product_id=item.product_id,
                pricing_plan_id=getattr(item, "pricing_plan_id", None),
                price_source=getattr(item, "price_source", None),
                base_price=getattr(item, "base_price", None),
                resolved_price=getattr(item, "resolved_price", None),
                original_currency=getattr(item, "original_currency", None),
                original_amount=getattr(item, "original_amount", None),
                exchange_rate=getattr(item, "exchange_rate", None),
            )
        inv_service.recalculate_invoice(inv.id, organization_id)
        quote.status = QuoteStatus.CONVERTED
        quote.converted_to_invoice_id = inv.id
        safe_commit_and_refresh(self.db, quote)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Invoice", inv.id)
        return inv
