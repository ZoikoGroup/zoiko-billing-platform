"""
app/modules/tax/report_service.py
---------------------------------
Read-only findings reports (ZB-TAX-ARCH-001 Phase 3a). Two visibility levels
(T13): a tenant sees its own invoice-level detail; platform tax roles see
aggregate counts and totals only — no organization names or ids, customers or
invoice numbers.

1. Legacy discount-after-tax over-collection. Legacy (LEGACY_MANUAL) invoices
   compute tax per line BEFORE the document-level discount and then subtract
   the discount from the tax-inclusive total, so tax is charged on the
   undiscounted base. The document discount is the invoice's discount_amount
   minus its line discounts (line discounts are applied before tax and do not
   over-collect), so it covers both a discount_percentage and a fixed
   document discount. Estimated over-collection = tax_amount x document
   discount / pre-discount subtotal (exact for a single uniform rate; an
   estimate otherwise). Nothing is changed: legacy invoicing stays as-is
   pending the product owner and tax lead.

2. Duplicate legacy tax snapshot rows. Before Phase 3a fix (b), re-sending an
   already-issued invoice wrote its `taxes` rows again. A duplicate is any
   repeat of (invoice, tax_rate_id) among active rows. Reported, never deleted.
"""
from collections import defaultdict
from decimal import Decimal

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.modules.billing.models import Invoice, InvoiceItem, InvoiceStatus, Tax
from app.modules.billing.utils.currency_utils import round_money

#: Statuses of invoices that have been issued to the customer.
ISSUED_STATUSES = (
    InvoiceStatus.SENT, InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE,
    InvoiceStatus.WRITTEN_OFF, InvoiceStatus.REFUNDED,
)
HUNDRED = Decimal("100")


def _discount_share(inv: Invoice, line_discounts: Decimal):
    """(document discount, its share of the pre-discount subtotal), or None.

    The document discount is the invoice discount minus its line discounts,
    which covers a fixed document discount as well as a percentage. Rows whose
    stored discount_amount does not carry the document discount (written
    outside the recalculation path) fall back to discount_percentage."""
    subtotal = Decimal(str(inv.subtotal or 0))
    doc_discount = Decimal(str(inv.discount_amount or 0)) - line_discounts
    if doc_discount > 0 and subtotal > 0:
        return doc_discount, min(doc_discount / subtotal, Decimal("1"))
    pct = Decimal(str(inv.discount_percentage or 0))
    if pct > 0:
        return round_money(subtotal * pct / HUNDRED, inv.currency), min(pct / HUNDRED, Decimal("1"))
    return None


def _overcollection_rows(db: Session, organization_id=None):
    line_discounts = (db.query(InvoiceItem.invoice_id.label("invoice_id"),
                               func.coalesce(func.sum(InvoiceItem.discount_amount), 0).label("total"))
                      .group_by(InvoiceItem.invoice_id).subquery())
    q = (db.query(Invoice, func.coalesce(line_discounts.c.total, 0))
         .outerjoin(line_discounts, line_discounts.c.invoice_id == Invoice.id)
         .filter(Invoice.status.in_(ISSUED_STATUSES), Invoice.tax_quote_id.is_(None), Invoice.tax_amount > 0,
                 or_(Invoice.discount_percentage > 0, Invoice.discount_amount > 0)))
    if organization_id is not None:
        q = q.filter(Invoice.organization_id == organization_id)
    for inv, lines in q.order_by(Invoice.issue_date, Invoice.id):
        found = _discount_share(inv, Decimal(str(lines)))
        if found is None:
            continue
        doc_discount, share = found
        estimate = round_money(Decimal(str(inv.tax_amount)) * share, inv.currency)
        yield inv, doc_discount, estimate


def _currency_totals(pairs) -> list:
    totals = defaultdict(lambda: {"invoice_count": 0, "tax_amount": Decimal("0"), "estimated_overcollected_tax": Decimal("0")})
    for inv, _doc_discount, estimate in pairs:
        t = totals[inv.currency or "UNKNOWN"]
        t["invoice_count"] += 1
        t["tax_amount"] += Decimal(str(inv.tax_amount))
        t["estimated_overcollected_tax"] += estimate
    return [{"currency": c, **v} for c, v in sorted(totals.items())]


METHOD_NOTE = ("Estimate = tax_amount x document discount / pre-discount subtotal: legacy invoices charge tax "
               "on the base before the document discount. The document discount is the invoice discount minus "
               "line discounts, so percentage and fixed document discounts are both included. Exact for one "
               "uniform rate per invoice; an estimate otherwise. Read-only: no invoice is changed.")


class TaxFindingsReportService:
    def __init__(self, db: Session):
        self.db = db

    # ── over-collection ──
    def tenant_overcollection(self, organization_id: int) -> dict:
        rows = list(_overcollection_rows(self.db, organization_id))
        return {
            "method": METHOD_NOTE,
            "totals_by_currency": _currency_totals(rows),
            "invoices": [{
                "invoice_id": inv.id, "invoice_number": inv.invoice_number, "issue_date": inv.issue_date,
                "status": inv.status.name, "currency": inv.currency, "discount_percentage": inv.discount_percentage,
                "document_discount": doc_discount, "subtotal": inv.subtotal,
                "tax_amount": inv.tax_amount, "estimated_overcollected_tax": estimate,
            } for inv, doc_discount, estimate in rows],
        }

    def platform_overcollection(self) -> dict:
        rows = list(_overcollection_rows(self.db))
        return {
            "method": METHOD_NOTE,
            "organizations_affected": len({inv.organization_id for inv, _d, _e in rows}),
            "invoice_count": len(rows),
            "totals_by_currency": _currency_totals(rows),
        }

    # ── duplicate snapshot rows ──
    def _duplicate_groups(self, organization_id=None):
        q = (self.db.query(Tax.organization_id, Tax.invoice_id, Tax.tax_rate_id, func.count(Tax.id))
             .filter(Tax.is_active.is_(True), Tax.invoice_id.isnot(None))
             .group_by(Tax.organization_id, Tax.invoice_id, Tax.tax_rate_id)
             .having(func.count(Tax.id) > 1))
        if organization_id is not None:
            q = q.filter(Tax.organization_id == organization_id)
        return q.all()

    def tenant_duplicates(self, organization_id: int) -> dict:
        per_invoice = defaultdict(int)
        for _org, invoice_id, _rate, count in self._duplicate_groups(organization_id):
            per_invoice[invoice_id] += count - 1
        numbers = dict(self.db.query(Invoice.id, Invoice.invoice_number).filter(
            Invoice.organization_id == organization_id, Invoice.id.in_(list(per_invoice) or [0])))
        return {
            "duplicate_rows": sum(per_invoice.values()),
            "invoices": [{"invoice_id": i, "invoice_number": numbers.get(i), "duplicate_rows": n}
                         for i, n in sorted(per_invoice.items())],
            "note": "Rows are reported only; cleanup is a separate approved step.",
        }

    def platform_duplicates(self) -> dict:
        groups = self._duplicate_groups()
        return {
            "organizations_affected": len({g[0] for g in groups}),
            "invoices_affected": len({(g[0], g[1]) for g in groups}),
            "duplicate_rows": sum(g[3] - 1 for g in groups),
            "note": "Aggregate only. Rows are reported, never deleted; cleanup is a separate approved step.",
        }
