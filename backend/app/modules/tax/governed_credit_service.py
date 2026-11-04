"""
app/modules/tax/governed_credit_service.py
------------------------------------------
Credit notes for governed invoices (ZB-TAX-ARCH-001 Phase 3a, T15, T18).

A governed invoice's tax was committed as an immutable quote snapshot. A
credit note against it reverses amounts FROM THAT SNAPSHOT — the original
components, rates and rounding — never recomputed at today's rates. Each
credited component is recorded in credit_note_tax_lines with signed amounts
(negative = reversal of a positive charge), so charge direction survives
negative lines and refunds (T18).

Credits are requested per invoice line as a fraction (0 < f <= 1). The
cumulative credited fraction per line never exceeds 1, and the credit that
completes a line takes exactly what remains of each rounded amount, so the
original plus all its credits reconcile to the cent (T09).

Legacy invoices are unaffected: their credit notes keep the existing
free-amount flow. The generic flow refuses governed invoices.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import CreditNote, CreditNoteStatus, CreditNoteType, Invoice, InvoiceStatus
from app.modules.tax.determination_service import _q6, _round
from app.modules.tax.enums import TaxQuoteStatus
from app.modules.tax.quote_models import CreditNoteTaxLine, TaxQuote, TaxQuoteLine

ONE = Decimal("1")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _one_per_credit_note(rows: list) -> list:
    """A line's component rows on one credit note share the same credited
    base; count it once per credit note."""
    first = {}
    for r in rows:
        first.setdefault(r.credit_note_id, r)
    return list(first.values())


class GovernedCreditService:
    def __init__(self, db: Session):
        self.db = db

    def _invoice(self, organization_id: int, invoice_id: int) -> Invoice:
        inv = self.db.query(Invoice).filter(Invoice.id == invoice_id, Invoice.organization_id == organization_id).first()
        if inv is None:
            raise NotFoundException("Invoice", invoice_id)
        return inv

    def _prior(self, quote_line_id: int) -> list:
        """Credited rows for a quote line on credit notes that still count."""
        return (self.db.query(CreditNoteTaxLine)
                .join(CreditNote, CreditNote.id == CreditNoteTaxLine.credit_note_id)
                .filter(CreditNoteTaxLine.tax_quote_line_id == quote_line_id,
                        CreditNote.status != CreditNoteStatus.VOIDED).all())

    def create(self, organization_id: int, actor_id: int, invoice_id: int, *, lines: list,
               credit_note_type: CreditNoteType = CreditNoteType.PARTIAL_CREDIT, reason: Optional[str] = None,
               issue_date: Optional[date] = None) -> CreditNote:
        from app.modules.billing.services.credit_note_service import CreditNoteService

        inv = self._invoice(organization_id, invoice_id)
        if inv.tax_quote_id is None:
            raise BadRequestException("This invoice has no governed tax snapshot; use the standard credit-note flow.")
        if inv.status in (InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED):
            raise BadRequestException(f"A {inv.status.name} invoice cannot be credited.")
        quote = self.db.get(TaxQuote, inv.tax_quote_id)
        if quote is None or quote.status != TaxQuoteStatus.COMMITTED:
            raise BadRequestException("The invoice's tax snapshot is not committed.")
        if not lines:
            raise BadRequestException("Choose at least one invoice line to credit.")

        by_item = {l.document_line_id: l for l in quote.lines}
        decimals = quote.currency_decimals
        planned, seen = [], set()
        for request in lines:
            item_id = int(request["invoice_item_id"])
            fraction = Decimal(str(request.get("fraction", 1)))
            if item_id in seen:
                raise BadRequestException(f"Invoice line {item_id} is listed twice.")
            seen.add(item_id)
            qline: Optional[TaxQuoteLine] = by_item.get(item_id)
            if qline is None:
                raise BadRequestException(f"Invoice line {item_id} is not part of this invoice's tax snapshot.")
            if fraction <= 0 or fraction > ONE:
                raise BadRequestException("Each credited fraction must be greater than 0 and at most 1.")
            prior = self._prior(qline.id)
            base_u = Decimal(qline.taxable_base_unrounded)
            credited_before = Decimal("0")
            if base_u != 0:
                credited_before = sum((-Decimal(r.credited_base_unrounded) for r in _one_per_credit_note(prior)),
                                      Decimal("0")) / base_u
            if credited_before + fraction > ONE + Decimal("0.0000001"):
                raise BadRequestException(f"Invoice line {item_id} would be credited beyond 100%.")
            completes = credited_before + fraction >= ONE - Decimal("0.0000001")
            planned.append((qline, fraction, prior, completes))

        rows, subtotal, tax = [], Decimal("0"), Decimal("0")
        for qline, fraction, prior, completes in planned:
            base_u = -Decimal(qline.taxable_base_unrounded) * fraction
            prior_base_rounded = sum((Decimal(r.credited_base) for r in _one_per_credit_note(prior)), Decimal("0"))
            base_r = (-Decimal(qline.taxable_base) - prior_base_rounded) if completes else _round(base_u, decimals)
            subtotal += base_r
            for comp in qline.components:
                tax_u = -Decimal(comp.tax_unrounded) * fraction
                prior_tax_rounded = sum((Decimal(r.credited_tax) for r in prior if r.tax_quote_component_id == comp.id),
                                        Decimal("0"))
                tax_r = (-Decimal(comp.tax_amount) - prior_tax_rounded) if completes else _round(tax_u, decimals)
                tax += tax_r
                rows.append(dict(invoice_id=inv.id, tax_quote_id=quote.id, tax_quote_line_id=qline.id,
                                 tax_quote_component_id=comp.id, credited_base_unrounded=_q6(base_u),
                                 credited_tax_unrounded=_q6(tax_u), credited_base=base_r, credited_tax=tax_r))

        # Credit-note headers carry positive magnitudes; direction lives on the lines.
        total = -(subtotal + tax)
        if total <= 0:
            raise BadRequestException("The selected lines net to no credit.")
        credit_note = CreditNoteService(self.db).create_credit_note(
            organization_id, actor_id, customer_id=inv.customer_id, credit_note_number="auto",
            credit_note_type=credit_note_type, total_amount=total, issue_date=issue_date or _now().date(),
            subtotal=-subtotal, discount_amount=Decimal("0"), tax_amount=-tax, invoice_id=inv.id,
            reason=reason, currency=inv.currency, _governed_snapshot=True,
        )
        now = _now()
        for row in rows:
            self.db.add(CreditNoteTaxLine(organization_id=organization_id, credit_note_id=credit_note.id,
                                          created_by=actor_id, created_at=now, **row))
        self.db.commit()
        return credit_note


def view_credit_lines(db: Session, credit_note_id: int) -> list:
    return [{
        "tax_quote_line_id": r.tax_quote_line_id, "tax_quote_component_id": r.tax_quote_component_id,
        "credited_base": r.credited_base, "credited_tax": r.credited_tax,
        "credited_base_unrounded": r.credited_base_unrounded, "credited_tax_unrounded": r.credited_tax_unrounded,
    } for r in db.query(CreditNoteTaxLine).filter(CreditNoteTaxLine.credit_note_id == credit_note_id)
                                          .order_by(CreditNoteTaxLine.id)]
