"""
modules/super_admin/billing_command_center_service.py
-----------------------------------------------------
ZB-SA-CMD-003 — Billing Command Center read models (Domain B, cross-tenant).

Serves the /super-admin/billing-command-center page: KPI cards, action-center
alerts, billings-vs-collections trend, collections aging health, overdue
invoice list, next-7-days operational summary, per-customer collections risk,
and a composed recent-activity feed.

Currency honesty (Phase 4, G-01 — same rule as FinancialConsistencyService):
monetary totals are computed PER CURRENCY and are never summed across
currencies. Scalar convenience amounts are exposed only when the platform is
single-currency; otherwise the response names a `primary_currency` (the bucket
with the largest invoiced amount) and every figure that chart/card renders is
explicitly scoped to one currency. Counts are safe to total and always global.
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import Date, cast, func
from sqlalchemy.orm import Session

# Open receivable statuses — an invoice counts toward outstanding balance only
# while it can still be collected.
OPEN_INVOICE_STATUSES = ("sent", "overdue", "partially_paid")

AGING_BUCKETS = [
    ("current", 0, 0),
    ("1-30", 1, 30),
    ("31-60", 31, 60),
    ("61-90", 61, 90),
    ("90+", 91, None),
]


def _days_overdue(due_date: date, today: date) -> int:
    return (today - due_date).days


def _aging_key(days_overdue: int) -> str:
    if days_overdue <= 0:
        return "current"
    if days_overdue <= 30:
        return "1-30"
    if days_overdue <= 60:
        return "31-60"
    if days_overdue <= 90:
        return "61-90"
    return "90+"


class BillingCommandCenterService:
    def __init__(self, db: Session):
        self.db = db

    # ── helpers ────────────────────────────────────────────────────────────

    def _open_invoice_query(self):
        from app.modules.billing.models import Invoice

        return (
            self.db.query(Invoice)
            .filter(
                Invoice.status.in_(OPEN_INVOICE_STATUSES),
                Invoice.deleted_at.is_(None),
                Invoice.balance_due > 0,
            )
        )

    def _per_currency_kpis(self) -> List[Dict[str, Any]]:
        from app.modules.billing.models import Invoice, InvoiceStatus

        today = date.today()

        invoiced_rows = (
            self.db.query(
                Invoice.currency,
                func.count(Invoice.id),
                func.coalesce(func.sum(Invoice.total_amount), 0),
            )
            .filter(Invoice.deleted_at.is_(None))
            .group_by(Invoice.currency)
            .all()
        )
        collected_rows = dict(
            self.db.query(
                Invoice.currency,
                func.coalesce(func.sum(Invoice.total_amount), 0),
            )
            .filter(
                Invoice.status == InvoiceStatus.PAID,
                Invoice.deleted_at.is_(None),
            )
            .group_by(Invoice.currency)
            .all()
        )

        open_rows = (
            self._open_invoice_query()
            .with_entities(
                Invoice.currency,
                Invoice.due_date,
                func.coalesce(func.sum(Invoice.balance_due), 0),
                func.count(Invoice.id),
            )
            .group_by(Invoice.currency, Invoice.due_date)
            .all()
        )

        open_agg: Dict[str, Dict[str, Any]] = {}
        for currency, due_date, amount, count in open_rows:
            bucket = open_agg.setdefault(
                currency,
                {"current": Decimal("0"), "overdue": Decimal("0"), "overdue_count": 0},
            )
            if due_date is not None and due_date < today:
                bucket["overdue"] += amount or Decimal("0")
                bucket["overdue_count"] += int(count or 0)
            else:
                bucket["current"] += amount or Decimal("0")

        buckets: List[Dict[str, Any]] = []
        for currency, invoice_count, invoiced_amount in sorted(invoiced_rows, key=lambda r: (r[0] or "")):
            code = currency or "UNKNOWN"
            agg = open_agg.get(currency, {"current": Decimal("0"), "overdue": Decimal("0"), "overdue_count": 0})
            buckets.append(
                {
                    "currency": code,
                    "invoice_count": int(invoice_count or 0),
                    "invoiced_amount": str(invoiced_amount or Decimal("0")),
                    "collected_amount": str(collected_rows.get(currency, Decimal("0"))),
                    "outstanding_amount": str(agg["current"] + agg["overdue"]),
                    "current_amount": str(agg["current"]),
                    "overdue_amount": str(agg["overdue"]),
                    "overdue_count": int(agg["overdue_count"]),
                }
            )
        return buckets

    @staticmethod
    def _resolve_display_currency(buckets: List[Dict[str, Any]]) -> tuple[str, str]:
        """Returns (currency_state, display_currency). display_currency is None
        when the platform has no invoice data; otherwise it is the only currency
        (single_currency) or the largest-invoiced bucket (multi_currency)."""
        if not buckets:
            return "unknown", None
        if len(buckets) == 1:
            return "single_currency", buckets[0]["currency"]
        return "multi_currency", max(buckets, key=lambda b: Decimal(b["invoiced_amount"] or "0"))["currency"]

    def _bucket_for_granularity(self, granularity: str) -> tuple[List[date], str]:
        """Returns (ordered bucket-start dates covering the window, label format)."""
        today = date.today()
        if granularity == "weekly":
            this_monday = today - timedelta(days=today.weekday())
            starts = [this_monday - timedelta(weeks=i) for i in range(11, -1, -1)]
            return starts, "week"
        if granularity == "monthly":
            months = []
            year, month = today.year, today.month
            for _ in range(12):
                months.append(date(year, month, 1))
                month -= 1
                if month == 0:
                    month = 12
                    year -= 1
            return list(reversed(months)), "month"
        # daily default
        return [today - timedelta(days=i) for i in range(13, -1, -1)], "day"

    @staticmethod
    def _label_for_bucket(start: date, granularity: str) -> str:
        if granularity == "monthly":
            return start.strftime("%b %Y")
        if granularity == "weekly":
            return f"Wk of {start.strftime('%b %d')}"
        return start.strftime("%b %d")

    def _trend_series(self, granularity: str, currency: str) -> List[Dict[str, Any]]:
        from app.modules.billing.models import Invoice, InvoiceStatus

        starts, kind = self._bucket_for_granularity(granularity)
        window_start = starts[0]

        billed_rows = (
            self.db.query(Invoice.issue_date, func.coalesce(func.sum(Invoice.total_amount), 0))
            .filter(
                Invoice.currency == currency,
                Invoice.issue_date >= window_start,
                Invoice.deleted_at.is_(None),
            )
            .group_by(Invoice.issue_date)
            .all()
        )
        paid_rows = (
            self.db.query(
                cast(Invoice.paid_at, Date).label("paid_day"),
                func.coalesce(func.sum(Invoice.total_amount), 0),
            )
            .filter(
                Invoice.currency == currency,
                Invoice.status == InvoiceStatus.PAID,
                Invoice.paid_at.isnot(None),
                Invoice.deleted_at.is_(None),
                cast(Invoice.paid_at, Date) >= window_start,
            )
            .group_by(cast(Invoice.paid_at, Date))
            .all()
        )

        billed_by_day: Dict[date, Decimal] = {d: (a or Decimal("0")) for d, a in billed_rows}
        collected_by_day: Dict[date, Decimal] = {r[0]: (r[1] or Decimal("0")) for r in paid_rows}

        points: List[Dict[str, Any]] = []
        for i, start in enumerate(starts):
            end = starts[i + 1] if i + 1 < len(starts) else None
            billed = Decimal("0")
            collected = Decimal("0")
            for day, amount in billed_by_day.items():
                if day >= start and (end is None or day < end) and day <= date.today():
                    billed += amount
            for day, amount in collected_by_day.items():
                if day >= start and (end is None or day < end) and day <= date.today():
                    collected += amount
            rate = round(float(collected / billed) * 100, 1) if billed > 0 else 0.0
            points.append(
                {
                    "label": self._label_for_bucket(start, granularity),
                    "billed": float(billed),
                    "collected": float(collected),
                    "collection_rate_pct": rate,
                }
            )
        return points

    # ── read models ────────────────────────────────────────────────────────

    def get_overview(self) -> Dict[str, Any]:
        from app.modules.billing.models import (
            CreditNote,
            CreditNoteStatus,
            DunningCase,
            DunningStatus,
            Invoice,
            InvoiceStatus,
            Payment,
            PaymentStatus,
            Quotation,
            QuoteStatus,
            Subscription,
            BillingSubscriptionStatus,
        )

        today = date.today()
        week_end = today + timedelta(days=7)

        buckets = self._per_currency_kpis()
        currency_state, primary = self._resolve_display_currency(buckets)

        total_overdue_count = sum(b["overdue_count"] for b in buckets)

        collection_rate: Optional[float] = None
        if currency_state == "single_currency":
            inv = Decimal(buckets[0]["invoiced_amount"])
            col = Decimal(buckets[0]["collected_amount"])
            collection_rate = round(float(col / inv) * 100, 1) if inv > 0 else None

        # ── Action center inputs ───────────────────────────────────────────
        overdue_30 = (
            self._open_invoice_query()
            .filter(Invoice.due_date < today - timedelta(days=30))
            .with_entities(func.count(Invoice.id), func.coalesce(func.sum(Invoice.balance_due), 0))
            .first()
        )
        failed_payments = (
            self.db.query(func.count(Payment.id), func.coalesce(func.sum(Payment.amount), 0))
            .filter(Payment.status == PaymentStatus.FAILED, Payment.deleted_at.is_(None))
            .first()
        )
        drafts = (
            self.db.query(func.count(Invoice.id), func.coalesce(func.sum(Invoice.total_amount), 0))
            .filter(Invoice.status == InvoiceStatus.DRAFT, Invoice.deleted_at.is_(None))
            .first()
        )
        active_dunning = (
            self.db.query(func.count(DunningCase.id))
            .filter(DunningCase.status == DunningStatus.ACTIVE)
            .scalar()
            or 0
        )

        # ── Collections aging (per display currency) ───────────────────────
        aging_buckets: List[Dict[str, Any]] = []
        aging_total = Decimal("0")
        if primary:
            rows = (
                self._open_invoice_query()
                .filter(Invoice.currency == primary)
                .with_entities(Invoice.due_date, func.coalesce(func.sum(Invoice.balance_due), 0))
                .group_by(Invoice.due_date)
                .all()
            )
            per_bucket: Dict[str, Dict[str, Any]] = {key: {"count": 0, "amount": Decimal("0")} for key, _, _ in AGING_BUCKETS}
            for due_date_, amount in rows:
                days = _days_overdue(due_date_, today) if due_date_ is not None else 0
                key = _aging_key(days)
                per_bucket[key]["amount"] += amount or Decimal("0")
            counts_rows = (
                self._open_invoice_query()
                .filter(Invoice.currency == primary)
                .with_entities(Invoice.due_date, func.count(Invoice.id))
                .group_by(Invoice.due_date)
                .all()
            )
            for due_date_, count in counts_rows:
                days = _days_overdue(due_date_, today) if due_date_ is not None else 0
                per_bucket[_aging_key(days)]["count"] += int(count or 0)
            labels = {
                "current": "Current",
                "1-30": "1–30 days overdue",
                "31-60": "31–60 days",
                "61-90": "61–90 days",
                "90+": "90+ days",
            }
            aging_total = sum(v["amount"] for v in per_bucket.values())
            for key, _, _ in AGING_BUCKETS:
                amount = float(per_bucket[key]["amount"])
                aging_buckets.append(
                    {
                        "key": key,
                        "label": labels[key],
                        "count": per_bucket[key]["count"],
                        "amount": str(per_bucket[key]["amount"]),
                        "pct": round(amount / float(aging_total) * 100, 1) if aging_total > 0 else 0.0,
                    }
                )

        customers_at_risk = 0
        if primary:
            customers_at_risk = (
                self._open_invoice_query()
                .filter(Invoice.currency == primary, Invoice.due_date < today)
                .with_entities(func.count(func.distinct(Invoice.customer_id)))
                .scalar()
                or 0
            )

        # ── Next 7 days ────────────────────────────────────────────────────
        upcoming_subs = (
            self.db.query(Subscription)
            .filter(
                Subscription.status == BillingSubscriptionStatus.ACTIVE,
                Subscription.next_billing_at.isnot(None),
                Subscription.next_billing_at >= today,
                Subscription.next_billing_at <= week_end,
            )
        )
        invoices_scheduled = upcoming_subs.count()
        expected_amounts: Dict[str, Decimal] = {}
        for sub in upcoming_subs.all():
            price = sub.resolved_price if sub.resolved_price is not None else (sub.unit_price or Decimal("0"))
            expected_amounts.setdefault(sub.currency or "UNKNOWN", Decimal("0"))
            expected_amounts[sub.currency or "UNKNOWN"] += (price or Decimal("0")) * (sub.quantity or 1)
        renewals = (
            self.db.query(func.count(Subscription.id))
            .filter(
                Subscription.status == BillingSubscriptionStatus.ACTIVE,
                Subscription.current_term_end >= today,
                Subscription.current_term_end <= week_end,
            )
            .scalar()
            or 0
        )
        payment_retries = (
            self.db.query(func.count(DunningCase.id))
            .filter(
                DunningCase.status == DunningStatus.ACTIVE,
                DunningCase.next_action_at.isnot(None),
                DunningCase.next_action_at >= today,
                DunningCase.next_action_at <= week_end,
            )
            .scalar()
            or 0
        )
        quotes_expiring = (
            self.db.query(func.count(Quotation.id))
            .filter(
                Quotation.valid_until.isnot(None),
                Quotation.valid_until >= today,
                Quotation.valid_until <= week_end,
                Quotation.status.in_([QuoteStatus.DRAFT, QuoteStatus.SENT]),
                Quotation.is_active.is_(True),
            )
            .scalar()
            or 0
        )

        expected_single = None
        expected_note = None
        if len(expected_amounts) == 1:
            expected_currency = next(iter(expected_amounts))
            expected_single = str(expected_amounts[expected_currency])
            expected_note = expected_currency
        elif len(expected_amounts) > 1:
            expected_note = f"{len(expected_amounts)} currencies (never combined)"

        active_credits = (
            self.db.query(func.count(CreditNote.id))
            .filter(CreditNote.status == CreditNoteStatus.ISSUED)
            .scalar()
            or 0
        )

        # ── Sparklines: trailing daily series in the display currency ──────
        sparklines: Dict[str, List[float]] = {
            "billed": [],
            "collected": [],
            "newly_overdue": [],
            "rate": [],
        }
        if primary:
            trend_points = self._trend_series("daily", primary)[-12:]
            daily_starts = self._bucket_for_granularity("daily")[0][-12:]
            newly_overdue_rows = (
                self._open_invoice_query()
                .filter(Invoice.currency == primary, Invoice.due_date >= daily_starts[0])
                .with_entities(Invoice.due_date, func.coalesce(func.sum(Invoice.balance_due), 0))
                .group_by(Invoice.due_date)
                .all()
            )
            overdue_by_day = {d: (a or Decimal("0")) for d, a in newly_overdue_rows}
            for point in trend_points:
                sparklines["billed"].append(point["billed"])
                sparklines["collected"].append(point["collected"])
                sparklines["rate"].append(point["collection_rate_pct"])
            for start in daily_starts:
                sparklines["newly_overdue"].append(float(overdue_by_day.get(start, Decimal("0"))))

        return {
            "generated_at": datetime.utcnow(),
            "kpis": {
                "currency_state": currency_state,
                "primary_currency": primary,
                "currencies": buckets,
                "total_invoices": sum(b["invoice_count"] for b in buckets),
                "overdue_count": total_overdue_count,
                "invoiced_amount": buckets[0]["invoiced_amount"] if currency_state == "single_currency" else None,
                "collected_amount": buckets[0]["collected_amount"] if currency_state == "single_currency" else None,
                "outstanding_amount": (
                    str(Decimal(buckets[0]["outstanding_amount"])) if currency_state == "single_currency" else None
                ),
                "current_amount": buckets[0]["current_amount"] if currency_state == "single_currency" else None,
                "overdue_amount": buckets[0]["overdue_amount"] if currency_state == "single_currency" else None,
                "display_invoiced_amount": next((b["invoiced_amount"] for b in buckets if b["currency"] == primary), None),
                "display_collected_amount": next((b["collected_amount"] for b in buckets if b["currency"] == primary), None),
                "display_outstanding_amount": next((b["outstanding_amount"] for b in buckets if b["currency"] == primary), None),
                "display_current_amount": next((b["current_amount"] for b in buckets if b["currency"] == primary), None),
                "display_overdue_amount": next((b["overdue_amount"] for b in buckets if b["currency"] == primary), None),
                "display_collection_rate_pct": collection_rate
                if currency_state == "single_currency"
                else self._rate_for(buckets, primary),
            },
            "sparklines": sparklines,
            "aging": aging_buckets,
            "aging_basis": {
                "currency": primary,
                "currency_state": currency_state,
                "note": None
                if currency_state != "multi_currency"
                else f"Multi-currency platform — aging shown for {primary} (largest bucket) only.",
            },
            "action_center": {
                "overdue_30d_count": int(overdue_30[0] or 0) if overdue_30 else 0,
                "overdue_30d_amount": str(overdue_30[1] or 0) if overdue_30 else "0",
                "failed_payments_count": int(failed_payments[0] or 0) if failed_payments else 0,
                "failed_payments_amount": str(failed_payments[1] or 0) if failed_payments else "0",
                "draft_invoices_count": int(drafts[0] or 0) if drafts else 0,
                "draft_invoices_amount": str(drafts[1] or 0) if drafts else "0",
                "active_dunning_cases_count": active_dunning,
                "active_credit_notes_count": active_credits,
            },
            "next_seven_days": {
                "invoices_scheduled": invoices_scheduled,
                "expected_billing_amount": expected_single,
                "expected_billing_currency": expected_note,
                "renewals": renewals,
                "payment_retries": payment_retries,
                "quotes_expiring": quotes_expiring,
            },
            "customers_at_risk": customers_at_risk,
        }

    @staticmethod
    def _rate_for(buckets: List[Dict[str, Any]], currency: Optional[str]) -> Optional[float]:
        if not currency:
            return None
        bucket = next((b for b in buckets if b["currency"] == currency), None)
        if not bucket:
            return None
        inv = Decimal(bucket["invoiced_amount"])
        col = Decimal(bucket["collected_amount"])
        return round(float(col / inv) * 100, 1) if inv > 0 else None

    def get_trend(self, granularity: str, currency: Optional[str] = None) -> Dict[str, Any]:
        buckets = self._per_currency_kpis()
        currency_state, primary = self._resolve_display_currency(buckets)
        available = [b["currency"] for b in buckets]
        chosen = currency if currency in available else primary
        points: List[Dict[str, Any]] = []
        if chosen:
            points = self._trend_series(granularity.lower(), chosen)
        return {
            "granularity": granularity.lower(),
            "currency": chosen,
            "currency_state": currency_state,
            "available_currencies": available,
            "points": points,
        }

    def list_overdue_invoices(self, limit: int = 10) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice
        from app.modules.organizations.models import Organization

        today = date.today()
        total = (
            self._open_invoice_query()
            .filter(Invoice.due_date < today)
            .with_entities(func.count(Invoice.id))
            .scalar()
            or 0
        )
        rows = (
            self._open_invoice_query()
            .filter(Invoice.due_date < today)
            .join(Organization, Organization.id == Invoice.organization_id)
            .order_by(Invoice.due_date.asc())
            .limit(limit)
            .with_entities(
                Invoice.id,
                Invoice.organization_id,
                Organization.organization_name,
                Invoice.invoice_number,
                Invoice.customer_id,
                Invoice.due_date,
                Invoice.balance_due,
                Invoice.currency,
            )
            .all()
        )
        customer_names = self._customer_name_map([r[4] for r in rows])
        invoices = [
            {
                "invoice_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "invoice_number": r[3],
                "customer_id": r[4],
                "customer_name": customer_names.get(r[4], "UNKNOWN"),
                "due_date": r[5],
                "days_overdue": _days_overdue(r[5], today) if r[5] else 0,
                "amount": str(r[6] or 0),
                "currency": r[7] or "UNKNOWN",
            }
            for r in rows
        ]
        return {"total": total, "invoices": invoices}

    def _customer_name_map(self, customer_ids: List[int]) -> Dict[int, str]:
        from app.modules.billing.models import BillingCustomer

        ids = [c for c in set(customer_ids) if c is not None]
        if not ids:
            return {}
        rows = (
            self.db.query(BillingCustomer.id, BillingCustomer.company_name, BillingCustomer.display_name)
            .filter(BillingCustomer.id.in_(ids))
            .all()
        )
        return {r[0]: r[1] or r[2] or f"Customer #{r[0]}" for r in rows}

    def list_collections_risk(self, limit: int = 10) -> Dict[str, Any]:
        from app.modules.billing.models import (
            BillingCustomer,
            CollectionsCase,
            CollectionsStatus,
            DunningCase,
            DunningStatus,
            Invoice,
            Payment,
            PaymentStatus,
        )
        from app.modules.organizations.models import Organization

        today = date.today()
        base = (
            self._open_invoice_query()
            .filter(Invoice.due_date < today)
            .with_entities(
                Invoice.customer_id,
                func.count(Invoice.id).label("invoice_count"),
                func.coalesce(func.sum(Invoice.balance_due), 0).label("outstanding"),
                func.max(Invoice.due_date).label("worst_due"),
                func.min(Invoice.due_date).label("oldest_due"),
                func.coalesce(func.max(Invoice.currency), "UNKNOWN").label("currency"),
            )
            .group_by(Invoice.customer_id)
            .order_by(func.sum(Invoice.balance_due).desc())
            .limit(limit)
        ).all()

        customer_ids = [r.customer_id for r in base]
        if not customer_ids:
            return {"rows": []}

        org_map: Dict[int, str] = {}
        cust_org: Dict[int, int] = {}
        cust_rows = (
            self.db.query(BillingCustomer.id, BillingCustomer.organization_id)
            .filter(BillingCustomer.id.in_(customer_ids))
            .all()
        )
        for cid, oid in cust_rows:
            cust_org[cid] = oid
        if cust_org:
            org_rows = (
                self.db.query(Organization.id, Organization.organization_name)
                .filter(Organization.id.in_(set(cust_org.values())))
                .all()
            )
            org_map = {oid: name for oid, name in org_rows}

        last_payment: Dict[int, date] = {}
        payment_rows = (
            self.db.query(Payment.customer_id, func.max(Payment.payment_date))
            .filter(
                Payment.customer_id.in_(customer_ids),
                Payment.status == PaymentStatus.CLEARED,
                Payment.deleted_at.is_(None),
            )
            .group_by(Payment.customer_id)
            .all()
        )
        for cid, last in payment_rows:
            last_payment[cid] = last

        dunned = set(
            row[0]
            for row in self.db.query(DunningCase.customer_id)
            .filter(
                DunningCase.customer_id.in_(customer_ids),
                DunningCase.status == DunningStatus.ACTIVE,
            )
            .all()
        )
        in_collections = set(
            row[0]
            for row in self.db.query(CollectionsCase.customer_id)
            .filter(
                CollectionsCase.customer_id.in_(customer_ids),
                CollectionsCase.status == CollectionsStatus.OPEN,
            )
            .all()
        )

        name_map = self._customer_name_map(customer_ids)
        rows: List[Dict[str, Any]] = []
        for r in base:
            oldest_days = _days_overdue(r.oldest_due, today) if r.oldest_due else 0
            risk = "High" if (oldest_days >= 31 or r.customer_id in dunned or r.customer_id in in_collections) else "Medium"
            notes: List[str] = []
            notes.append(f"{r.invoice_count} overdue invoice{'s' if r.invoice_count != 1 else ''}")
            if r.customer_id in dunned:
                notes.append("active dunning case")
            if r.customer_id in in_collections:
                notes.append("open collections case")
            note = ", ".join(notes)
            rows.append(
                {
                    "customer_id": r.customer_id,
                    "customer_name": name_map.get(r.customer_id, f"Customer #{r.customer_id}"),
                    "organization_name": org_map.get(cust_org.get(r.customer_id), "UNKNOWN"),
                    "outstanding": str(r.outstanding or 0),
                    "currency": r.currency,
                    "risk": risk,
                    "last_activity": last_payment.get(r.customer_id),
                    "note": note,
                }
            )
        return {"rows": rows}

    def list_recent_activity(self, limit: int = 8) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, Payment, PaymentStatus, SubscriptionEvent
        from app.modules.auth.models import User

        actor_ids = set()

        payments = (
            self.db.query(Payment)
            .filter(
                Payment.status.in_([PaymentStatus.CLEARED, PaymentStatus.FAILED]),
                Payment.deleted_at.is_(None),
            )
            .order_by(Payment.created_at.desc())
            .limit(limit)
            .all()
        )
        invoices = (
            self.db.query(Invoice)
            .filter(Invoice.sent_at.isnot(None), Invoice.deleted_at.is_(None))
            .order_by(Invoice.sent_at.desc())
            .limit(limit)
            .all()
        )
        sub_events = (
            self.db.query(SubscriptionEvent).order_by(SubscriptionEvent.created_at.desc()).limit(limit).all()
        )

        items: List[Dict[str, Any]] = []

        payment_customer_names = self._customer_name_map([p.customer_id for p in payments])
        invoice_customer_names = self._customer_name_map([i.customer_id for i in invoices])

        for p in payments:
            occurred = p.cleared_at if p.status == PaymentStatus.CLEARED and p.cleared_at else p.created_at
            if p.created_by:
                actor_ids.add(p.created_by)
            items.append(
                {
                    "kind": "payment_received" if p.status == PaymentStatus.CLEARED else "payment_failed",
                    "title": "Payment received" if p.status == PaymentStatus.CLEARED else "Payment failed",
                    "meta": f"{p.currency or ''} {p.amount} · {payment_customer_names.get(p.customer_id, 'Unknown customer')}".strip(),
                    "actor_id": p.created_by,
                    "occurred_at": occurred or p.created_at,
                }
            )
        for inv in invoices:
            if inv.created_by:
                actor_ids.add(inv.created_by)
            items.append(
                {
                    "kind": "invoice_sent",
                    "title": "Invoice sent",
                    "meta": f"{inv.invoice_number} to {invoice_customer_names.get(inv.customer_id, 'Unknown customer')}",
                    "actor_id": inv.created_by,
                    "occurred_at": inv.sent_at,
                }
            )
        for ev in sub_events:
            if ev.created_by:
                actor_ids.add(ev.created_by)
            items.append(
                {
                    "kind": "subscription_changed",
                    "title": "Subscription changed",
                    "meta": f"{str(ev.event_type or '').replace('_', ' ')} on subscription #{ev.subscription_id}",
                    "actor_id": ev.created_by,
                    "occurred_at": ev.created_at,
                }
            )

        def _occurred_ts(item: Dict[str, Any]) -> datetime:
            value = item["occurred_at"]
            if isinstance(value, datetime):
                if value.tzinfo is not None:
                    return value.replace(tzinfo=None)
                return value
            return datetime.min

        items.sort(key=_occurred_ts, reverse=True)
        items = items[:limit]

        actors: Dict[int, str] = {}
        if actor_ids:
            user_rows = self.db.query(User.id, User.email).filter(User.id.in_(list(actor_ids))).all()
            actors = {uid: email for uid, email in user_rows}
        for item in items:
            item["actor"] = actors.get(item.pop("actor_id"))

        return {"items": items}
