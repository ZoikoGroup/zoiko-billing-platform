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

from sqlalchemy import Date, case, cast, exists, func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.super_admin.privacy import currency_totals, masked_count

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
        # Drafts were never issued and cancelled invoices were voided — neither
        # is billed revenue (same rule as the F1 Billings card).
        billed_filters = (
            Invoice.deleted_at.is_(None),
            Invoice.status.notin_([InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED]),
        )

        invoiced_rows = (
            self.db.query(
                Invoice.currency,
                func.count(Invoice.id),
                func.coalesce(func.sum(Invoice.total_amount), 0),
            )
            .filter(*billed_filters)
            .group_by(Invoice.currency)
            .all()
        )
        # Money actually received, so partial payments count; refunded money
        # has gone back out.
        collected_rows = dict(
            self.db.query(
                Invoice.currency,
                func.coalesce(func.sum(Invoice.paid_amount), 0),
            )
            .filter(*billed_filters, Invoice.status != InvoiceStatus.REFUNDED)
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
        from app.core import cache_service

        cached = cache_service.cache_get("sa:bcc:overview")
        if cached is not None:
            return cached

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

        result = {
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
        cache_service.cache_set(
            "sa:bcc:overview", result, ttl=settings.REDIS_DASHBOARD_TTL
        )
        return result

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

    # ── Per-tenant aggregates (ZB-SEC-PRIV-001) ───────────────────────────
    # Everything below aggregates in SQL by organization. No per-customer or
    # per-record identifier is selected, returned or logged.

    def _org_names(self, org_ids) -> Dict[int, str]:
        from app.modules.organizations.models import Organization

        ids = [o for o in set(org_ids) if o is not None]
        if not ids:
            return {}
        rows = self.db.query(Organization.id, Organization.organization_name).filter(Organization.id.in_(ids)).all()
        return {oid: name for oid, name in rows}

    def list_overdue_invoices(self, limit: int = 10) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice

        today = date.today()
        overdue = self._open_invoice_query().filter(Invoice.due_date < today)
        total = overdue.with_entities(func.count(Invoice.id)).scalar() or 0
        org_rows = (
            overdue.with_entities(
                Invoice.organization_id,
                func.count(Invoice.id).label("n"),
                func.min(Invoice.due_date).label("oldest"),
            )
            .group_by(Invoice.organization_id)
            .order_by(func.count(Invoice.id).desc(), Invoice.organization_id.asc())
            .limit(limit)
            .all()
        )
        org_ids = [r[0] for r in org_rows]
        currency_rows = []
        if org_ids:
            currency_rows = (
                overdue.filter(Invoice.organization_id.in_(org_ids))
                .with_entities(
                    Invoice.organization_id,
                    Invoice.currency,
                    func.count(Invoice.id),
                    func.coalesce(func.sum(Invoice.balance_due), 0),
                )
                .group_by(Invoice.organization_id, Invoice.currency)
                .all()
            )
        per_org: Dict[int, list] = {}
        for oid, cur, n, amt in currency_rows:
            per_org.setdefault(oid, []).append((cur, n, amt))
        names = self._org_names(org_ids)
        rows = []
        for oid, n, oldest in org_rows:
            days = _days_overdue(oldest, today) if oldest else 0
            rows.append(
                {
                    "organization_id": oid,
                    "organization_name": names.get(oid, "UNKNOWN"),
                    **masked_count("overdue_invoice_count", n),
                    "overdue_total_by_currency": currency_totals(per_org.get(oid, [])),
                    "oldest_days_overdue_bucket": _aging_key(days) if days > 0 else None,
                }
            )
        return {**masked_count("total", total), "invoices": rows}

    def list_collections_risk(self, limit: int = 10) -> Dict[str, Any]:
        from app.modules.billing.models import (
            CollectionsCase,
            CollectionsStatus,
            DunningCase,
            DunningStatus,
            Invoice,
        )

        today = date.today()
        overdue = self._open_invoice_query().filter(Invoice.due_date < today)
        dunned = exists().where(
            DunningCase.customer_id == Invoice.customer_id, DunningCase.status == DunningStatus.ACTIVE
        )
        collected = exists().where(
            CollectionsCase.customer_id == Invoice.customer_id, CollectionsCase.status == CollectionsStatus.OPEN
        )
        high_flag = func.max(
            case((or_(Invoice.due_date <= today - timedelta(days=31), dunned, collected), 1), else_=0)
        )
        # one inner row per (tenant, account); it never leaves SQL as an identifier
        per_account = (
            overdue.with_entities(
                Invoice.organization_id.label("org_id"),
                Invoice.customer_id.label("acct"),
                high_flag.label("is_high"),
            )
            .group_by(Invoice.organization_id, Invoice.customer_id)
            .subquery()
        )
        org_rows = (
            self.db.query(
                per_account.c.org_id,
                func.count().label("n"),
                func.coalesce(func.sum(per_account.c.is_high), 0).label("high"),
            )
            .group_by(per_account.c.org_id)
            .order_by(func.count().desc(), per_account.c.org_id.asc())
            .limit(limit)
            .all()
        )
        org_ids = [r[0] for r in org_rows]
        if not org_ids:
            return {"rows": []}
        currency_rows = (
            overdue.filter(Invoice.organization_id.in_(org_ids))
            .with_entities(
                Invoice.organization_id,
                Invoice.currency,
                func.count(Invoice.id),
                func.coalesce(func.sum(Invoice.balance_due), 0),
            )
            .group_by(Invoice.organization_id, Invoice.currency)
            .all()
        )
        per_org: Dict[int, list] = {}
        for oid, cur, n, amt in currency_rows:
            per_org.setdefault(oid, []).append((cur, n, amt))
        names = self._org_names(org_ids)
        rows = []
        for oid, n, high in org_rows:
            n = int(n or 0)
            high = int(high or 0)
            rows.append(
                {
                    "organization_id": oid,
                    "organization_name": names.get(oid, "UNKNOWN"),
                    **masked_count("accounts_at_risk_count", n),
                    **masked_count("risk_high_count", high),
                    **masked_count("risk_medium_count", n - high),
                    "total_overdue_by_currency": currency_totals(per_org.get(oid, [])),
                }
            )
        return {"rows": rows}

    def list_recent_activity(self, limit: int = 8) -> Dict[str, Any]:
        """Counts per event type per tenant over the trailing 30 days. No
        record references, actors, amounts or customer names."""
        from app.modules.billing.models import Invoice, Payment, PaymentStatus, SubscriptionEvent

        since = datetime.utcnow() - timedelta(days=30)
        found: List[tuple] = []  # (org_id, event_type, count, last_at)

        for status, kind in ((PaymentStatus.CLEARED, "payment_received"), (PaymentStatus.FAILED, "payment_failed")):
            for oid, n, last in (
                self.db.query(Payment.organization_id, func.count(Payment.id), func.max(Payment.created_at))
                .filter(Payment.status == status, Payment.deleted_at.is_(None), Payment.created_at >= since)
                .group_by(Payment.organization_id)
                .all()
            ):
                found.append((oid, kind, int(n or 0), last))
        for oid, n, last in (
            self.db.query(Invoice.organization_id, func.count(Invoice.id), func.max(Invoice.sent_at))
            .filter(Invoice.sent_at.isnot(None), Invoice.deleted_at.is_(None), Invoice.sent_at >= since)
            .group_by(Invoice.organization_id)
            .all()
        ):
            found.append((oid, "invoice_sent", int(n or 0), last))
        for oid, n, last in (
            self.db.query(
                SubscriptionEvent.organization_id,
                func.count(SubscriptionEvent.id),
                func.max(SubscriptionEvent.created_at),
            )
            .filter(SubscriptionEvent.created_at >= since)
            .group_by(SubscriptionEvent.organization_id)
            .all()
        ):
            found.append((oid, "subscription_changed", int(n or 0), last))

        def _ts(value) -> datetime:
            if isinstance(value, datetime):
                return value.replace(tzinfo=None) if value.tzinfo is not None else value
            return datetime.min

        found.sort(key=lambda r: _ts(r[3]), reverse=True)
        found = found[:limit]
        names = self._org_names([r[0] for r in found])
        items = [
            {
                "organization_id": oid,
                "organization_name": names.get(oid, "UNKNOWN"),
                "event_type": kind,
                **masked_count("event_count", n),
                "last_event_at": last,
            }
            for oid, kind, n, last in found
        ]
        return {"items": items}
