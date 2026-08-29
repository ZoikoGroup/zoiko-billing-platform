"""billing_adapter.py — Billing API Adapter (Architecture C-09 / §11.1).

Single read-side gateway through which the chatbot accesses authoritative
Billing ledger records (Invoice / Payment / CreditNote). Conversation handlers
MUST NOT issue self.db.query(...) directly against these models: the
architecture forbids "direct SQL access to Billing production ledgers"
(Architecture §2.1 forbidden shortcuts / §11.1 data-access pattern). Routing
every ledger read through this one adapter keeps org scoping, the exact-Decimal
money contract (§4.2) and per-currency grouping (§30 multi-currency P0 — no
silent cross-currency aggregation) in a single place instead of drifting per
handler.

This adapter is READ-ONLY: it never mutates the ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from app.modules.billing.models import (
    CreditNote,
    Invoice,
    InvoiceStatus,
    Payment,
    PaymentType,
)

_LEDGER_OPEN_STATUSES = (
    InvoiceStatus.SENT,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.PARTIALLY_PAID,
)


def group_by_currency(values: Iterable) -> dict[str, Decimal]:
    """Group (amount, currency) pairs per currency WITHOUT ever summing across
    currencies. Amounts land as exact Decimal; a missing/blank currency falls
    back to 'USD' so a ragged row can never change the breakdown shape."""
    totals: dict[str, Decimal] = {}
    for amount, ccy in values:
        key = (ccy or "USD").strip().upper() or "USD"
        try:
            amt = Decimal(str(amount or 0))
        except (InvalidOperation, ValueError):
            amt = Decimal("0")
        totals[key] = totals.get(key, Decimal("0")) + amt
    return totals


@dataclass(frozen=True)
class CurrencyTotals:
    count: int
    totals: dict[str, Decimal]


class BillingAdapter:
    """The only sanctioned path for chatbot reads of billing ledger tables."""

    def __init__(self, db: Session):
        self._db = db

    # ── Aggregates: refunds / credit notes / paid revenue ──────────────

    def refund_totals(self, organization_id: int) -> CurrencyTotals:
        """Cleared REFUND payments, per currency — the same records the
        dashboard's collections aggregate reads."""
        rows = (
            self._db.query(
                Payment.currency,
                func.count(Payment.id),
                func.coalesce(func.sum(Payment.amount), 0),
            )
            .filter(
                Payment.organization_id == organization_id,
                Payment.status == "cleared",
                Payment.payment_type == PaymentType.REFUND.value,
            )
            .group_by(Payment.currency)
            .all()
        )
        count = sum(int(r[1] or 0) for r in rows)
        return CurrencyTotals(count, group_by_currency((r[2], r[0]) for r in rows))

    def credit_note_totals(self, organization_id: int) -> CurrencyTotals:
        """Issued credit notes, per currency."""
        rows = (
            self._db.query(
                CreditNote.currency,
                func.count(CreditNote.id),
                func.coalesce(func.sum(CreditNote.total_amount), 0),
            )
            .filter(
                CreditNote.organization_id == organization_id,
                CreditNote.deleted_at.is_(None),
            )
            .group_by(CreditNote.currency)
            .all()
        )
        count = sum(int(r[1] or 0) for r in rows)
        return CurrencyTotals(count, group_by_currency((r[2], r[0]) for r in rows))

    def paid_revenue_totals(self, organization_id: int, start: date, end: date) -> CurrencyTotals:
        """Fully PAID invoices issued within [start, end), per currency."""
        rows = (
            self._db.query(
                Invoice.currency,
                func.count(Invoice.id),
                func.coalesce(func.sum(Invoice.total_amount), 0),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.deleted_at.is_(None),
                Invoice.status == InvoiceStatus.PAID,
                Invoice.issue_date >= start,
                Invoice.issue_date < end,
            )
            .group_by(Invoice.currency)
            .all()
        )
        count = sum(int(r[1] or 0) for r in rows)
        return CurrencyTotals(count, group_by_currency((r[2], r[0]) for r in rows))

    # ── Customer balances ──────────────────────────────────────────────

    def open_invoices_for_customer(self, organization_id: int, customer_id: int) -> list[Invoice]:
        """Open (unsettled) invoices for one customer — the authoritative
        basis for an outstanding-balance figure."""
        return (
            self._db.query(Invoice)
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.customer_id == customer_id,
                Invoice.deleted_at.is_(None),
                Invoice.balance_due > 0,
                Invoice.status.in_(_LEDGER_OPEN_STATUSES),
            )
            .all()
        )

    # ── Ledger list queries (read-only, always org-scoped) ─────────────

    def reconciliation_payments(self, organization_id: int) -> list[Payment]:
        """Active cleared/pending payments with allocations eager-loaded —
        the authoritative input for reconciliation / unmatched-payment
        answers."""
        return (
            self._db.query(Payment)
            .options(selectinload(Payment.allocations))
            .filter(
                Payment.organization_id == organization_id,
                Payment.is_active == True,
                Payment.deleted_at.is_(None),
                Payment.status.in_(["cleared", "pending"]),
            )
            .all()
        )

    def lookup_invoice(
        self,
        organization_id: int,
        reference: str | None = None,
    ) -> Invoice | None:
        """Single invoice by org + (optional) matched reference; newest when
        no reference is given."""
        query = (
            self._db.query(Invoice)
            .options(selectinload(Invoice.customer))
            .filter(Invoice.organization_id == organization_id, Invoice.deleted_at.is_(None))
        )
        if reference:
            query = query.filter(func.lower(Invoice.invoice_number) == reference.lower())
        return query.order_by(Invoice.created_at.desc()).first()

    def lookup_payment(
        self,
        organization_id: int,
        reference: str | None = None,
    ) -> Payment | None:
        """Single payment by org + (optional) matched reference; newest when
        no reference is given."""
        query = (
            self._db.query(Payment)
            .options(selectinload(Payment.customer), selectinload(Payment.allocations))
            .filter(Payment.organization_id == organization_id, Payment.deleted_at.is_(None))
        )
        if reference:
            query = query.filter(func.lower(Payment.payment_number) == reference.lower())
        return query.order_by(Payment.created_at.desc()).first()

    def count_invoices_for_org(
        self,
        organization_id: int,
        *,
        active_only: bool = False,
        open_only: bool = False,
        overdue_only: bool = False,
    ) -> int:
        """Live invoice counts, org-scoped. `overdue_only` counts unsettled
        invoices past their due date; `open_only` counts unsettled invoices in
        an open status. Both filters are applied on the authoritative ledger
        so answer figures never drift from the dashboard aggregates."""
        query = (
            self._db.query(func.count(Invoice.id))
            .filter(Invoice.organization_id == organization_id, Invoice.deleted_at.is_(None))
        )
        if active_only:
            query = query.filter(Invoice.is_active == True)
        if overdue_only:
            query = query.filter(
                Invoice.balance_due > 0,
                Invoice.due_date < date.today(),
                Invoice.status.notin_(["draft", "cancelled"]),
            )
        elif open_only:
            query = query.filter(
                Invoice.balance_due > 0,
                Invoice.status.in_(["sent", "overdue", "partially_paid"]),
            )
        return int(query.scalar() or 0)

    def count_payments_for_org(self, organization_id: int) -> int:
        return int(
            self._db.query(func.count(Payment.id))
            .filter(Payment.organization_id == organization_id, Payment.deleted_at.is_(None))
            .scalar()
            or 0
        )

    def list_invoices(
        self,
        organization_id: int,
        limit: int = 10,
        balance_due_only: bool = False,
        overdue_only: bool = False,
        statuses: set[InvoiceStatus] | None = None,
    ) -> list[Invoice]:
        query = (
            self._db.query(Invoice)
            .options(selectinload(Invoice.customer))
            .filter(Invoice.organization_id == organization_id, Invoice.deleted_at.is_(None))
        )
        if overdue_only:
            query = query.filter(Invoice.balance_due > 0, Invoice.due_date < date.today())
        elif balance_due_only:
            query = query.filter(Invoice.balance_due > 0)
        elif statuses:
            query = query.filter(Invoice.status.in_(statuses))
        return query.order_by(Invoice.created_at.desc()).limit(limit).all()

    def list_payments(
        self,
        organization_id: int,
        customer_id: int | None = None,
        limit: int = 10,
    ) -> list[Payment]:
        query = (
            self._db.query(Payment)
            .options(selectinload(Payment.customer))
            .filter(Payment.organization_id == organization_id, Payment.deleted_at.is_(None))
        )
        if customer_id is not None:
            query = query.filter(Payment.customer_id == customer_id)
        return query.order_by(Payment.created_at.desc()).limit(limit).all()

    def list_overdue(self, organization_id: int, limit: int = 10) -> list[Invoice]:
        return (
            self._db.query(Invoice)
            .options(selectinload(Invoice.customer))
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.deleted_at.is_(None),
                Invoice.balance_due > 0,
                Invoice.due_date < date.today(),
            )
            .order_by(Invoice.due_date.asc())
            .limit(limit)
            .all()
        )