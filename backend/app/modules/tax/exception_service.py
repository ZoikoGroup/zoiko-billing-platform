"""
app/modules/tax/exception_service.py
------------------------------------
Read models for the governed-tax UX (ZB-TAX-ARCH-001 §11, Phase 3b):

  * invoice_tax_summary — what the invoice editor shows: net, tax per
    component, gross, tax date, legal treatment, engine and source labels,
    quote freshness and the reasons issuance is blocked.
  * list_exceptions — Taxes → Exceptions: every governed draft that cannot be
    issued, with the specific reason, the missing facts, who resolves it and
    how. Re-quoting is POST /api/v1/tax/quotes.

Read-only and tenant-scoped. Freshness uses the same checks as the issuance
gate (expiry, context fingerprint, document hash), so what the editor shows
is what issuing would decide. Nothing here changes a quote's status.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import NotFoundException
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.tax.determination_service import TaxDeterminationService, view_quote
from app.modules.tax.enums import COMMITTABLE_QUOTE_STATUSES, EngineKind, EntityTaxRegime, TaxQuoteStatus
from app.modules.tax.issuance_gate import is_governed
from app.modules.tax.models import SellerLegalEntity
from app.modules.tax.quote_models import TaxQuote
from app.modules.tax.registry_models import TaxRateVersion
from app.modules.tax.tenant_tax_service import TENANT_CONFIG_LABEL

#: Freshness of the latest quote as the issuance gate would judge it now.
FRESH, STALE, EXPIRED, COMMITTED, REFUSED, NONE = "FRESH", "STALE", "EXPIRED", "COMMITTED", "REFUSED", "NONE"

#: Who resolves an issue, and how. Owners are tenant roles, except where only
#: Zoiko can extend coverage. Unknown codes fall back to the billing admin.
OWNERS = {
    "PRODUCT_CLASSIFICATION_MISSING": ("billing_admin", "Propose a tax code for the product; a finance approver approves it."),
    "LINE_PRODUCT_MISSING": ("billing_admin", "Link each line to a product so it can be classified."),
    "CUSTOMER_MISSING": ("billing_admin", "Choose a customer for the invoice."),
    "BUYER_COUNTRY_MISSING": ("billing_admin", "Record the customer's billing address with its country."),
    "BUYER_STATUS_UNRESOLVED": ("billing_admin", "Record and verify the customer's tax ID, or confirm consumer treatment."),
    "JURISDICTION_NOT_IN_REGISTRY": ("zoiko_tax_team", "The buyer's country is not in the tax registry yet."),
    "SELLER_ENTITY_MISSING": ("org_admin", "Set the issuing seller legal entity on the invoice."),
    "SELLER_ENTITY_INACTIVE": ("org_admin", "Reactivate the seller entity or issue from another one."),
    "TAX_DATE_MISSING": ("billing_admin", "Set the invoice's tax date."),
    "CURRENCY_MISSING": ("billing_admin", "Set the invoice currency."),
    "NO_LINES": ("billing_admin", "Add at least one line."),
    "PRICING_MODE_MIXED": ("billing_admin", "Use either tax-inclusive or tax-exclusive prices on every line."),
    "NOT_DETERMINED": ("org_admin", "Check the entity's registrations and activations for this market; a "
                                    "finance approver approves changes."),
    "NO_EFFECTIVE_ACTIVATION": ("org_admin", "Propose a tax activation for this market; a finance approver approves it."),
    "NO_APPROVED_RATE": ("zoiko_tax_team", "No published rate covers the tax date; Zoiko's tax team must publish one."),
    "OUTSIDE_PACK_COVERAGE": ("zoiko_tax_team", "This supply is outside governed coverage; it cannot be issued in "
                                                "governed mode yet."),
    "CURRENCY_MINOR_UNITS_UNSUPPORTED": ("billing_admin", "Invoice in a supported currency (ISO 4217, at most 2 decimals)."),
    "SHIPPING_OR_ROUND_OFF_UNSUPPORTED": ("billing_admin", "Remove shipping or round-off from the governed invoice."),
    "MIXED_ENGINES": ("billing_admin", "Split the invoice so every line uses the same tax engine."),
    "ROUNDING_MODE_UNDECLARED": ("zoiko_tax_team", "The tax engine does not declare a rounding mode."),
    "REQUIRED_FACTS_MISSING": ("billing_admin", "Complete the missing facts listed below."),
    "NO_TAX_QUOTE": ("billing_admin", "Request a tax quote."),
    "QUOTE_STALE": ("billing_admin", "The invoice or its tax facts changed: request a new tax quote."),
    "QUOTE_EXPIRED": ("billing_admin", "The tax quote expired: request a new tax quote."),
}


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _owner(code: str) -> dict:
    owner, resolution = OWNERS.get(code, ("billing_admin", "Review the reason and request a new tax quote."))
    return {"owner": owner, "resolution": resolution}


def engine_label(quote: TaxQuote) -> Optional[str]:
    if quote.engine_kind is None:
        return None
    if quote.engine_kind == EngineKind.TENANT_CONFIG:
        return f"Tenant rate ({TENANT_CONFIG_LABEL})"
    if quote.engine_kind == EngineKind.NATIVE_RULE_PACK:
        return f"Zoiko rule pack {quote.engine_name} v{quote.engine_version}"
    return f"Tax provider {quote.engine_name} v{quote.engine_version}"


class TaxExceptionService:
    def __init__(self, db: Session, now=None):
        self.db = db
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.determination = TaxDeterminationService(db, now=self.now)

    # ── shared ──
    def _latest_quote(self, organization_id: int, invoice_id: int) -> Optional[TaxQuote]:
        return (self.db.query(TaxQuote)
                .filter(TaxQuote.organization_id == organization_id, TaxQuote.document_type == "invoice",
                        TaxQuote.document_id == invoice_id)
                .order_by(TaxQuote.id.desc()).first())

    def freshness(self, invoice: Invoice, quote: Optional[TaxQuote]) -> dict:
        """(status, blocking reasons), judged exactly as the issuance gate would."""
        if quote is None:
            return {"status": NONE, "code": "NO_TAX_QUOTE",
                    "reasons": ["No tax quote yet: tax is NOT_DETERMINED until one is requested."]}
        if quote.status == TaxQuoteStatus.COMMITTED:
            return {"status": COMMITTED, "code": None, "reasons": []}
        if quote.status not in COMMITTABLE_QUOTE_STATUSES:
            code = quote.refusal_code or ("QUOTE_EXPIRED" if quote.status == TaxQuoteStatus.EXPIRED else "QUOTE_STALE")
            status = {TaxQuoteStatus.EXPIRED: EXPIRED, TaxQuoteStatus.STALE: STALE}.get(quote.status, REFUSED)
            return {"status": status, "code": code,
                    "reasons": [quote.refusal_reason or quote.stale_reason or f"The tax quote is {quote.status.name}."]}
        if quote.expires_at is not None and _aware(quote.expires_at) <= self.now():
            return {"status": EXPIRED, "code": "QUOTE_EXPIRED", "reasons": ["The tax quote has expired."]}
        fingerprint, doc_hash = self.determination.current_fingerprints(invoice.organization_id, "invoice", invoice.id)
        if fingerprint != quote.context_fingerprint:
            return {"status": STALE, "code": "QUOTE_STALE",
                    "reasons": ["Tax facts changed since the quote (registrations, activations, buyer evidence, "
                                "classification or availability)."]}
        if doc_hash != quote.document_hash:
            return {"status": STALE, "code": "QUOTE_STALE",
                    "reasons": ["The invoice lines, prices, discounts, currency or tax date changed since the quote."]}
        return {"status": FRESH, "code": None, "reasons": []}

    def _sources(self, quote: TaxQuote) -> dict:
        ids = {c.rate_version_id for line in quote.lines for c in line.components if c.rate_version_id}
        out = {}
        for version in self.db.query(TaxRateVersion).filter(TaxRateVersion.id.in_(ids or [0])):
            src = version.source_revision
            out[version.id] = {
                "rate_version_id": version.id, "rate_percent": version.rate_percent,
                "valid_from": version.valid_from, "valid_to": version.valid_to,
                "source_ref": src.handoff_ref if src else None, "source_title": src.title if src else None,
                "source_citation": src.citation if src else None, "source_url": src.permanent_url if src else None,
            }
        return out

    # ── invoice editor ──
    def invoice_tax_summary(self, organization_id: int, invoice_id: int) -> dict:
        invoice = self.db.query(Invoice).filter(Invoice.id == invoice_id,
                                                Invoice.organization_id == organization_id).first()
        if invoice is None:
            raise NotFoundException("Invoice", invoice_id)
        governed = is_governed(self.db, invoice)
        if not governed:
            return {"invoice_id": invoice.id, "governed": False, "tax_regime": "LEGACY_MANUAL"}
        quote = (self.db.get(TaxQuote, invoice.tax_quote_id) if invoice.tax_quote_id
                 else self._latest_quote(organization_id, invoice.id))
        fresh = self.freshness(invoice, quote)
        blocking = [] if fresh["status"] in (FRESH, COMMITTED) else [
            {"code": fresh["code"], "reason": r, **_owner(fresh["code"])} for r in fresh["reasons"]]
        if quote is not None and fresh["status"] == REFUSED:
            blocking += [{"code": i.get("code"), "reason": i.get("message"), "path": i.get("path"),
                          **_owner(i.get("code") or "")} for i in (quote.issues or [])]
        view = view_quote(quote) if quote is not None and quote.engine_kind is not None else None
        sources = self._sources(quote) if view else {}
        if view:
            for line in view["lines"]:
                for comp in line["components"]:
                    comp["source"] = sources.get(comp["rate_version_id"])
        return {
            "invoice_id": invoice.id, "governed": True, "tax_regime": EntityTaxRegime.GOVERNED.name,
            "status": invoice.status.name, "tax_date": invoice.tax_date, "currency": invoice.currency,
            "quote_id": quote.id if quote else None,
            "quote_status": quote.status.name if quote else None,
            "freshness": {"status": fresh["status"], "expires_at": quote.expires_at if quote else None,
                          "quoted_at": quote.created_at if quote else None},
            "engine_label": engine_label(quote) if quote else None,
            "totals": view["totals"] if view else None,
            "lines": view["lines"] if view else [],
            "warnings": (quote.warnings or []) if quote else [],
            "blocking_reasons": blocking,
            "can_issue": fresh["status"] == FRESH and invoice.status == InvoiceStatus.DRAFT,
        }

    # ── Taxes → Exceptions ──
    def list_exceptions(self, organization_id: int, limit: int = 200) -> dict:
        governed_entities = [e.id for e in self.db.query(SellerLegalEntity.id).filter(
            SellerLegalEntity.organization_id == organization_id,
            SellerLegalEntity.tax_regime == EntityTaxRegime.GOVERNED)]
        drafts = (self.db.query(Invoice)
                  .filter(Invoice.organization_id == organization_id, Invoice.status == InvoiceStatus.DRAFT,
                          Invoice.seller_entity_id.in_(governed_entities or [0]))
                  .order_by(Invoice.id).limit(limit).all())
        items = []
        for invoice in drafts:
            quote = self._latest_quote(organization_id, invoice.id)
            fresh = self.freshness(invoice, quote)
            if fresh["status"] == FRESH:
                continue
            missing = [{"code": i.get("code"), "path": i.get("path"), "message": i.get("message"),
                        **_owner(i.get("code") or "")} for i in ((quote.issues or []) if quote else [])]
            items.append({
                "invoice_id": invoice.id, "invoice_number": invoice.invoice_number, "customer_id": invoice.customer_id,
                "currency": invoice.currency, "tax_date": invoice.tax_date,
                "quote_id": quote.id if quote else None, "quote_status": quote.status.name if quote else None,
                "freshness": fresh["status"], "code": fresh["code"], "reason": "; ".join(fresh["reasons"]),
                "missing": missing, **_owner(fresh["code"] or ""),
                "requote": {"method": "POST", "path": "/api/v1/tax/quotes",
                            "body": {"document_type": "invoice", "document_id": invoice.id}},
            })
        return {"items": items, "count": len(items), "checked": len(drafts)}
