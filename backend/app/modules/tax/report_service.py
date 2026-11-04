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
   undiscounted base. Estimated over-collection = tax_amount x discount% / 100
   (exact for a single uniform rate; an estimate otherwise). Nothing is
   changed: legacy invoicing stays as-is pending the product owner and tax lead.

2. Duplicate legacy tax snapshot rows. Before Phase 3a fix (b), re-sending an
   already-issued invoice wrote its `taxes` rows again. A duplicate is any
   repeat of (invoice, tax_rate_id) among active rows. Reported, never deleted.
"""
from collections import defaultdict
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.modules.billing.models import Invoice, InvoiceStatus, Tax
from app.modules.billing.utils.currency_utils import round_money

#: Statuses of invoices that have been issued to the customer.
ISSUED_STATUSES = (
    InvoiceStatus.SENT, InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE,
    InvoiceStatus.WRITTEN_OFF, InvoiceStatus.REFUNDED,
)
HUNDRED = Decimal("100")


def _overcollection_rows(db: Session, organization_id=None):
    q = db.query(Invoice).filter(
        Invoice.status.in_(ISSUED_STATUSES), Invoice.tax_quote_id.is_(None),
        Invoice.discount_percentage > 0, Invoice.tax_amount > 0,
    )
    if organization_id is not None:
        q = q.filter(Invoice.organization_id == organization_id)
    for inv in q.order_by(Invoice.issue_date, Invoice.id):
        estimate = round_money(Decimal(str(inv.tax_amount)) * Decimal(str(inv.discount_percentage)) / HUNDRED,
                               inv.currency)
        yield inv, estimate


def _currency_totals(pairs) -> list:
    totals = defaultdict(lambda: {"invoice_count": 0, "tax_amount": Decimal("0"), "estimated_overcollected_tax": Decimal("0")})
    for inv, estimate in pairs:
        t = totals[inv.currency or "UNKNOWN"]
        t["invoice_count"] += 1
        t["tax_amount"] += Decimal(str(inv.tax_amount))
        t["estimated_overcollected_tax"] += estimate
    return [{"currency": c, **v} for c, v in sorted(totals.items())]


METHOD_NOTE = ("Estimate = tax_amount x document discount % / 100: legacy invoices charge tax on the base "
               "before the document discount. Exact for one uniform rate per invoice; an estimate otherwise. "
               "Read-only: no invoice is changed.")


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
                "tax_amount": inv.tax_amount, "estimated_overcollected_tax": estimate,
            } for inv, estimate in rows],
        }

    def platform_overcollection(self) -> dict:
        rows = list(_overcollection_rows(self.db))
        return {
            "method": METHOD_NOTE,
            "organizations_affected": len({inv.organization_id for inv, _ in rows}),
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
