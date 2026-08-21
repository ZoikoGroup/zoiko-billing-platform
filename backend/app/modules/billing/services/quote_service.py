import base64
import hashlib
import hmac
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.config import settings
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
    TaxRate,
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

logger = logging.getLogger("zoiko_billing")

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
    "resolved_price_type",
    "original_currency", "original_amount", "exchange_rate",
    "quote_currency", "converted_amount", "tax_rate_id",
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
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if self.repo.exists(organization_id, quote_number=quote_number):
            raise AlreadyExistsException("Quotation", "quote_number")
        # Currency: explicit > customer's own currency > org default -- same
        # precedence already used for invoices/contracts/subscriptions. Never
        # silently falls through to the Quotation.currency column's own USD
        # default when the client omits it.
        data["currency"] = data.get("currency") or customer.currency or self.config_service.get_default_currency(organization_id)
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

    def _resolve_item_fields(
        self, quote: Quotation, organization_id: int, data: Dict[str, Any]
    ) -> str:
        """Apply product pricing resolution to one item payload and return the
        effective price semantics. Shared by add_item and bulk_add_items so
        single and batched adds stay byte-for-byte identical."""
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
                data["resolved_price_type"] = price_semantics

                quote_currency = quote.currency or self.config_service.get_default_currency(organization_id)
                product_currency = result.currency or self.config_service.get_default_currency(organization_id)
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
        return price_semantics

    def _compute_item_amounts(
        self, quote: Quotation, data: Dict[str, Any], price_semantics: str,
    ) -> Dict[str, Any]:
        qty = Decimal(str(data.get("quantity", 1)))
        price = Decimal(str(data.get("unit_price", 0)))
        disc_pct = Decimal(str(data.get("discount_percentage", 0)))
        tax_pct = Decimal(str(data.get("tax_percentage", 0)))
        calc = CalculationService.calculate_line_item(qty, price, disc_pct, Decimal("0"), tax_pct, Decimal("1.0"), is_tax_inclusive=data.get("is_tax_inclusive", False), price_semantics=price_semantics)
        quote_currency = quote.currency or self.config_service.get_default_currency(organization_id)
        data["discount_amount"] = round_money(calc["original_discount"], quote_currency)
        data["tax_amount"] = round_money(calc["original_tax_amount"], quote_currency)
        data["total_amount"] = round_money(calc["original_line_total"], quote_currency)
        return data

    def add_item(self, quote_id: int, organization_id: int, **data: Any) -> QuotationItem:
        data = filter_allowed(data, ITEM_ALLOWED_FIELDS)
        self._validate_tax_rate_ownership(organization_id, data.get("tax_rate_id"))
        quote = self.repo.get_by_id(quote_id, organization_id)
        price_semantics = self._resolve_item_fields(quote, organization_id, data)
        self._compute_item_amounts(quote, data, price_semantics)
        return self.item_repo.create(organization_id, quotation_id=quote_id, **data)

    def bulk_add_items(
        self, quote_id: int, organization_id: int, items: List[Dict[str, Any]],
    ) -> List[QuotationItem]:
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.DRAFT:
            raise BadRequestException("Only draft quotes can have items added")
        if not items:
            return []
        prepared: List[Dict[str, Any]] = []
        for item in items:
            data = filter_allowed(item, ITEM_ALLOWED_FIELDS)
            self._validate_tax_rate_ownership(organization_id, data.get("tax_rate_id"))
            price_semantics = self._resolve_item_fields(quote, organization_id, data)
            self._compute_item_amounts(quote, data, price_semantics)
            prepared.append(data)
        result = self.item_repo.bulk_create_for_quotation(organization_id, quote_id, prepared)
        self.recalculate_quote(quote_id, organization_id)
        return result
        price = Decimal(str(data.get("unit_price", 0)))
        disc_pct = Decimal(str(data.get("discount_percentage", 0)))
        tax_pct = Decimal(str(data.get("tax_percentage", 0)))
        calc = CalculationService.calculate_line_item(qty, price, disc_pct, Decimal("0"), tax_pct, Decimal("1.0"), is_tax_inclusive=data.get("is_tax_inclusive", False), price_semantics=price_semantics)
        quote_currency = quote.currency or self.config_service.get_default_currency(organization_id)
        data["discount_amount"] = round_money(calc["original_discount"], quote_currency)
        data["tax_amount"] = round_money(calc["original_tax_amount"], quote_currency)
        data["total_amount"] = round_money(calc["original_line_total"], quote_currency)
        return self.item_repo.create(organization_id, quotation_id=quote_id, **data)

    def update_item(self, quote_id: int, item_id: int, organization_id: int, **data: Any) -> QuotationItem:
        data = filter_allowed(data, ITEM_ALLOWED_FIELDS - {"quotation_id", "total_amount", "discount_amount", "tax_amount"})
        self._validate_tax_rate_ownership(organization_id, data.get("tax_rate_id"))
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
        for item_data in cleaned:
            self._validate_tax_rate_ownership(organization_id, item_data.get("tax_rate_id"))
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
            entry["price_semantics"] = getattr(item, "resolved_price_type", None) or "unit"
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
        """Validate customer email, generate the PDF, deliver the email, and
        ONLY THEN update status to SENT.

        PDF generation and email delivery must both succeed before the quote
        is marked sent — either failing leaves the quote in its prior status
        untouched (no status mutation, no commit). Note: send_quote_email/
        send_approval_email never raise on SMTP failure — they return False —
        so both an exception and a False return are treated as delivery
        failure here.
        """
        quote = self.repo.get_by_id(quote_id, organization_id)
        if quote.status != QuoteStatus.DRAFT:
            raise BadRequestException("Only draft quotes can be sent")

        customer = self.customer_service.get_customer(quote.customer_id, organization_id)
        email = (customer.email or "").strip() if customer else ""
        if not email or "@" not in email:
            raise BadRequestException(
                f"Customer '{customer.company_name if customer else quote.customer_id}' does not have a valid email address. "
                "Please update the customer profile before sending."
            )

        currency = quote.currency or self.config_service.get_default_currency(organization_id)
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

        # PDF generation must succeed before the quote can be marked SENT —
        # a failed PDF is no longer silently downgraded to "send without
        # attachment". Nothing has been mutated on `quote` yet, so a plain
        # rollback leaves the session clean.
        try:
            from app.modules.billing.services.pdf_service import generate_quote_pdf
            org_config = self.config_service.get_configuration(organization_id)
            pdf_bytes = generate_quote_pdf(quote, customer, items, org_config, db=self.db)
        except Exception as e:
            logger.warning("Failed to generate PDF for quote %d, quote was not sent: %s", quote_id, e)
            self.db.rollback()
            raise BadRequestException("Failed to generate the quote PDF. Quote was not marked as sent.")

        # Displayed status reflects the target state (what the recipient is
        # being told), independent of `quote.status`, which is deliberately
        # not mutated until delivery is confirmed below.
        status_label = QuoteStatus.SENT.value.replace("_", " ").title()
        review_url = f"{settings.FRONTEND_URL.rstrip('/')}/estimate/{self._public_quote_token(quote.id)}"
        try:
            email_sent = send_quote_email(
                email=email,
                customer_name=customer.display_name or customer.company_name,
                recipient_first_name=customer.first_name or "",
                quote_number=quote.quote_number,
                issue_date=_fmt_date(quote.created_at.date()) if quote.created_at else _fmt_date(date.today()),
                valid_until=_fmt_date(quote.valid_until),
                total_amount=_fmt_money(quote.total_amount),
                currency=currency,
                status=status_label,
                notes=quote.notes or "",
                line_items=line_items,
                subtotal=_fmt_money(quote.subtotal),
                discount_amount=_fmt_money(quote.discount_amount) if quote.discount_amount else "",
                tax_amount=_fmt_money(quote.tax_amount),
                reference=quote.subject or "",
                review_url=review_url,
                organization_id=organization_id,
                db=self.db,
                pdf_bytes=pdf_bytes,
                pdf_filename=f"{quote.quote_number}.pdf",
            )
        except Exception as e:
            logger.warning("Failed to send quote email for quote %d: %s", quote_id, e)
            email_sent = False

        if not email_sent:
            self.db.rollback()
            raise BadRequestException("Failed to send the quote email. Quote was not marked as sent.")

        # Both PDF generation and email delivery succeeded — only now is the
        # quote actually transitioned to SENT and committed.
        quote.status = QuoteStatus.SENT
        safe_commit_and_refresh(self.db, quote)

        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Quotation", quote_id,
            new_values={"email_sent_to": email, "email_delivered": True},
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

    # ── Public Estimate Review (token-signed) ─────────────────────────────

    def _public_quote_token(self, quote_id: int) -> str:
        """Stateless, signed token for the public estimate link. Nothing is
        stored in the DB — the token is `base64url(quote_id.hmac(secret))` and
        recomputed on each request, so a leaked link cannot be forged and no
        migration is needed."""
        sig = hmac.new(
            settings.BILLING_SECRET_KEY.encode(),
            str(quote_id).encode(),
            hashlib.sha256,
        ).hexdigest()
        return base64.urlsafe_b64encode(f"{quote_id}.{sig}".encode()).decode().rstrip("=")

    def _resolve_public_quote(self, token: str) -> Quotation:
        if not token:
            raise NotFoundException("Quotation", 0)
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
            quote_id_str, _, sig = raw.partition(".")
            expected = hmac.new(
                settings.BILLING_SECRET_KEY.encode(),
                quote_id_str.encode(),
                hashlib.sha256,
            ).hexdigest()
            if not quote_id_str.isdigit() or not hmac.compare_digest(sig, expected):
                raise ValueError("bad signature")
            quote_id = int(quote_id_str)
        except Exception:
            raise NotFoundException("Quotation", 0)
        quote = self.db.query(Quotation).filter(Quotation.id == quote_id).first()
        if quote is None:
            raise NotFoundException("Quotation", quote_id)
        return quote

    def get_public_quote(self, token: str) -> Dict[str, Any]:
        """Public-safe snapshot of a quote for the customer-facing estimate
        page. Only fields the recipient should see are exposed — no internal
        pricing plan / tax-rate details, no org internals."""
        quote = self._resolve_public_quote(token)
        if quote.status == QuoteStatus.SENT:
            self.check_expired(quote.id, quote.organization_id)
            quote = self.repo.get_by_id(quote.id, quote.organization_id)

        from app.services.email_service import _get_org_branding
        branding = _get_org_branding(quote.organization_id, db=self.db)
        customer = quote.customer
        items = sorted(quote.items or [], key=lambda i: i.line_number or 0)

        def _fmt_date(d) -> Optional[str]:
            return d.strftime("%d %b %Y") if d else None

        return {
            "id": quote.id,
            "quote_number": quote.quote_number,
            "subject": quote.subject,
            "status": quote.status.value if quote.status else "draft",
            "issue_date": _fmt_date(quote.created_at.date()) if quote.created_at else None,
            "valid_until": _fmt_date(quote.valid_until),
            "currency": quote.currency or self.config_service.get_default_currency(quote.organization_id),
            "subtotal": str(quote.subtotal or 0),
            "discount_percentage": str(quote.discount_percentage or 0),
            "discount_amount": str(quote.discount_amount or 0),
            "tax_amount": str(quote.tax_amount or 0),
            "total_amount": str(quote.total_amount or 0),
            "notes": quote.notes,
            "terms": quote.terms,
            "accepted_at": quote.accepted_at.strftime("%d %b %Y %H:%M") if quote.accepted_at else None,
            "rejected_reason": quote.rejected_reason,
            "customer": {
                "name": (customer.display_name or customer.company_name) if customer else "",
                "email": (customer.email or "") if customer else "",
                "phone": (customer.phone or "") if customer else "",
                "billing_address": (customer.billing_address or "") if customer else "",
            },
            "items": [
                {
                    "line_number": item.line_number,
                    "description": item.description,
                    "quantity": str(item.quantity),
                    "unit_price": str(item.unit_price),
                    "discount_percentage": str(item.discount_percentage or 0),
                    "tax_percentage": str(item.tax_percentage or 0),
                    "total_amount": str(item.total_amount),
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
        }

    def _quote_response_admin_emails(self, organization_id: int) -> List[str]:
        from app.modules.auth.models import User, UserRole
        users = self.db.query(User).filter(
            User.organization_id == organization_id,
            User.role.in_([UserRole.ORG_ADMIN, UserRole.BILLING_ADMIN]),
            User.is_active.is_(True),
        ).all()
        emails = []
        for user in users:
            email = (user.email or "").strip()
            if email and "@" in email and email not in emails:
                emails.append(email)
        return emails

    def _notify_admins_quote_response(self, quote: Quotation, action: str, reason: str = "") -> int:
        from app.services.email_service import send_quote_response_notification_email
        emails = self._quote_response_admin_emails(quote.organization_id)
        if not emails:
            return 0
        customer = quote.customer
        customer_name = (customer.display_name or customer.company_name) if customer else ""
        currency = quote.currency or self.config_service.get_default_currency(quote.organization_id)
        total = f"{round_money(quote.total_amount or 0, currency):,.2f}"
        sent = 0
        for email in emails:
            try:
                if send_quote_response_notification_email(
                    email,
                    quote_number=quote.quote_number,
                    action=action,
                    reason=reason,
                    customer_name=customer_name,
                    total_amount=total,
                    currency=currency,
                    organization_id=quote.organization_id,
                    db=self.db,
                ):
                    sent += 1
            except Exception as exc:
                logger.warning("Failed to notify admin %s about quote %s: %s", email, quote.quote_number, exc)
        return sent

    def accept_quote_public(self, token: str) -> Quotation:
        """Accept a quote from the public estimate page. Sends the
        org-admins the accepted notification email."""
        quote = self._resolve_public_quote(token)
        if quote.status != QuoteStatus.SENT:
            raise BadRequestException("This estimate can no longer be accepted.")
        self.check_expired(quote.id, quote.organization_id)
        quote = self.repo.get_by_id(quote.id, quote.organization_id)
        if quote.status != QuoteStatus.SENT:
            raise BadRequestException("This estimate has expired and can no longer be accepted.")
        quote.status = QuoteStatus.ACCEPTED
        quote.accepted_at = datetime.utcnow()
        safe_commit_and_refresh(self.db, quote)
        self.audit.log(
            quote.organization_id, quote.created_by or 1,
            BillingAuditAction.APPROVE, "Quotation", quote.id,
        )
        self._notify_admins_quote_response(quote, "accepted")
        return quote

    def reject_quote_public(self, token: str, reason: str) -> Quotation:
        quote = self._resolve_public_quote(token)
        if quote.status not in (QuoteStatus.SENT, QuoteStatus.DRAFT):
            raise BadRequestException("This estimate can no longer be rejected.")
        quote.status = QuoteStatus.REJECTED
        quote.rejected_reason = reason
        safe_commit_and_refresh(self.db, quote)
        self.audit.log(
            quote.organization_id, quote.created_by or 1,
            BillingAuditAction.REJECT, "Quotation", quote.id,
        )
        self._notify_admins_quote_response(quote, "rejected", reason)
        return quote

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
