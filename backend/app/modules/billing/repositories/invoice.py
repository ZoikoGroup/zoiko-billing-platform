import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, case, extract, or_
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import joinedload

from app.core.exceptions import BadRequestException
from app.modules.billing.models import (
    CommunicationEventStatus,
    Invoice,
    InvoiceCommunication,
    InvoiceItem,
    InvoiceStatus,
    InvoiceStatusHistory,
)
from app.modules.billing.repositories.base import BaseRepository

logger = logging.getLogger("zoiko_billing")


class InvoiceRepository(BaseRepository[Invoice]):
    def __init__(self, db):
        super().__init__(db, Invoice)

    def update(self, id: int, organization_id: int, **data: Any) -> Invoice:
        obj = self.get_by_id(id, organization_id)
        if obj.status != InvoiceStatus.DRAFT:
            raise BadRequestException("Only draft invoices can be edited")
        return super().update(id, organization_id, **data)

    def get_by_id_for_update(self, id: int, organization_id: int) -> Invoice:
        """Row-level lock for preventing concurrent over-refund of an invoice.
        Falls back to plain read on SQLite (local dev) where FOR UPDATE is unsupported."""
        query = self.db.query(Invoice).filter(Invoice.id == id)
        try:
            query = query.with_for_update(nowait=False)
        except NotImplementedError:
            pass  # SQLite does not support row-level locking
        query = self._org_filter(query, organization_id)
        obj = query.first()
        if not obj:
            from app.core.exceptions import NotFoundException
            raise NotFoundException("Invoice", id)
        return obj

    @staticmethod
    def _rate_case(column, currency_rates):
        """Build a CASE expression to convert amounts by currency rate.
        
        currency_rates: {currency_code: multiplier_to_base, ...}
        Returns an expression that can be multiplied with an amount column.
        """
        if not currency_rates:
            return 1
        clauses = [(column == curr, rate) for curr, rate in currency_rates.items() if rate != 1.0]
        if not clauses:
            return 1
        return case(*clauses, else_=1.0)

    def get_amount_summary(self, organization_id: int, date_from: Optional[date] = None, date_to: Optional[date] = None, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        filters = [
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
        ]
        if date_from is not None:
            filters.append(Invoice.issue_date >= date_from)
        if date_to is not None:
            filters.append(Invoice.issue_date <= date_to)

        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = self.db.query(
            Invoice.status,
            func.coalesce(func.sum(Invoice.total_amount * rate), 0),
            func.coalesce(func.sum(Invoice.balance_due * rate), 0),
            func.count(Invoice.id),
        ).filter(*filters).group_by(Invoice.status).all()

        total_amount = 0.0
        total_balance = 0.0
        total_count = 0
        paid = 0.0
        overdue = 0.0
        for status, amount, balance, count in rows:
            total_amount += float(amount)
            total_balance += float(balance)
            total_count += count
            status_val = status.value if hasattr(status, "value") else str(status)
            if status_val == "paid":
                paid = float(amount)
            elif status_val == "overdue":
                overdue = float(balance)

        return {
            "total_revenue": total_amount,
            "paid_revenue": paid,
            "outstanding_amount": total_balance,
            "overdue_amount": overdue,
            "total_invoices": total_count,
        }

    def get_monthly_revenue(self, organization_id: int, start: date, end: date, currency_rates: Optional[Dict[str, float]] = None) -> float:
        rate = self._rate_case(Invoice.currency, currency_rates)
        result = self.db.query(
            func.coalesce(func.sum(Invoice.total_amount * rate), 0),
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.status == "paid",
            Invoice.issue_date >= start,
            Invoice.issue_date < end,
        ).scalar() or 0
        return float(result)

    def get_monthly_revenue_bulk(self, organization_id: int, months: int, currency_rates: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
        cutoff = date.today().replace(day=1)
        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = (
            self.db.query(
                extract("year", Invoice.issue_date).label("yr"),
                extract("month", Invoice.issue_date).label("mo"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("revenue"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status == "paid",
                Invoice.issue_date >= date(cutoff.year - 1, 1, 1),
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        lookup = {(int(r.yr), int(r.mo)): float(r.revenue) for r in rows}
        from app.modules.billing.utils.date_utils import MONTH_NAMES
        result = []
        today = date.today()
        for i in range(months - 1, -1, -1):
            m = today.month - i
            y = today.year
            while m <= 0:
                m += 12
                y -= 1
            result.append({
                "month": MONTH_NAMES[m - 1],
                "year": y,
                "revenue": lookup.get((y, m), 0.0),
            })
        return result

    def get_daily_revenue(self, organization_id: int, start_date: date, end_date: date, currency_rates: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
        """Return daily paid revenue between start_date and end_date (inclusive)."""
        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = (
            self.db.query(
                Invoice.issue_date.label("day"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("revenue"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status == "paid",
                Invoice.issue_date >= start_date,
                Invoice.issue_date <= end_date,
            )
            .group_by(Invoice.issue_date)
            .order_by(Invoice.issue_date)
            .all()
        )
        lookup = {r.day: float(r.revenue) for r in rows}
        result = []
        current = start_date
        while current <= end_date:
            result.append({
                "date": current.strftime("%b %d"),
                "period": current.strftime("%b %d"),
                "revenue": lookup.get(current, 0.0),
            })
            current += timedelta(days=1)
        return result

    def get_monthly_revenue_for_period(self, organization_id: int, start_date: date, end_date: date, currency_rates: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
        """Return monthly paid revenue between start_date and end_date."""
        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = (
            self.db.query(
                extract("year", Invoice.issue_date).label("yr"),
                extract("month", Invoice.issue_date).label("mo"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("revenue"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status == "paid",
                Invoice.issue_date >= start_date,
                Invoice.issue_date <= end_date,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        lookup = {(int(r.yr), int(r.mo)): float(r.revenue) for r in rows}
        from app.modules.billing.utils.date_utils import MONTH_NAMES
        result = []
        current = start_date.replace(day=1)
        end_month = end_date.replace(day=1)
        while current <= end_month:
            result.append({
                "month": MONTH_NAMES[current.month - 1],
                "period": f"{MONTH_NAMES[current.month - 1]} {current.year}",
                "revenue": lookup.get((current.year, current.month), 0.0),
            })
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1)
            else:
                current = current.replace(month=current.month + 1)
        return result

    def get_invoice_summary_by_status(self, organization_id: int, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = self.db.query(
            Invoice.status,
            func.count(Invoice.id),
            func.coalesce(func.sum(Invoice.total_amount * rate), 0),
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
        ).group_by(Invoice.status).all()

        total_count = 0
        total_amount = 0.0
        counts = {}
        for status, count, amount in rows:
            total_count += count
            total_amount += float(amount)
            counts[status.value if hasattr(status, "value") else str(status)] = {"count": count, "amount": float(amount)}

        paid = counts.get("paid", {"count": 0, "amount": 0.0})
        overdue = counts.get("overdue", {"count": 0, "amount": 0.0})

        return {
            "total_invoices": total_count,
            "total_amount": total_amount,
            "paid_count": paid["count"],
            "paid_amount": paid["amount"],
            "overdue_count": overdue["count"],
            "overdue_amount": overdue["amount"],
            "sent_count": counts.get("sent", {"count": 0})["count"],
            "draft_count": counts.get("draft", {"count": 0})["count"],
        }

    def get_by_number(self, organization_id: int, number: str) -> Optional[Invoice]:
        return self.get_first(organization_id, invoice_number=number)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Invoice]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[Invoice]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_overdue(self, organization_id: int) -> List[Invoice]:
        return self.list_effectively_overdue(organization_id)

    def list_effectively_overdue(self, organization_id: int, with_customer: bool = False) -> List[Invoice]:
        """Invoices that are functionally overdue by due_date, regardless of
        whether the OVERDUE status flag has actually been set on the row yet.

        The OVERDUE status transition only happens via
        tasks/overdue_invoices.py's scheduled job (ENABLE_RECURRING_BILLING_
        SCHEDULER, off by default) or the manual /invoices/process-overdue
        trigger — nothing else ever flips SENT/PARTIALLY_PAID -> OVERDUE. A
        read path that filtered strictly on `status == OVERDUE` (the
        pre-existing behavior of this method, and of get_collections_queue /
        DunningService.process_dunning) would silently show nothing for a
        real, materially overdue invoice whenever neither of those has run
        yet -- this is the single source of truth every "which invoices are
        overdue" read path should use instead, matching the due-date-based
        condition get_aging_buckets() already used (the one read path that
        was never affected by this gap).
        """
        from sqlalchemy.orm import joinedload

        today = date.today()
        query = self.db.query(Invoice).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.status.in_([InvoiceStatus.SENT, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIALLY_PAID]),
            Invoice.due_date.isnot(None),
            Invoice.due_date < today,
        )
        if with_customer:
            query = query.options(joinedload(Invoice.customer))
        return query.all()

    def list_due_between(
        self,
        organization_id: int,
        start_date: str,
        end_date: str,
    ) -> List[Invoice]:
        # The /invoices/due-between endpoint serializes these through
        # InvoiceResponse, whose customer_* fields are model properties that
        # lazy-load Invoice.customer per row. Eager-load to avoid N+1.
        from sqlalchemy.orm import joinedload
        return self.db.query(Invoice).options(joinedload(Invoice.customer)).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.due_date >= start_date,
            Invoice.due_date <= end_date,
        ).all()

    def get_overdue_by_customer(
        self, organization_id: int, currency_rates: Optional[Dict[str, float]] = None, limit: int = 20,
    ) -> List[Dict[str, Any]]:
        """Top-N customers by overdue balance — a single grouped aggregate
        rather than loading every overdue invoice into Python and summing
        per-customer there (the shape CollectionService.get_aging_buckets/
        get_collections_queue currently use)."""
        from app.modules.billing.models import BillingCustomer

        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = (
            self.db.query(
                Invoice.customer_id,
                BillingCustomer.company_name,
                BillingCustomer.display_name,
                func.coalesce(func.sum(Invoice.balance_due * rate), 0),
                func.count(Invoice.id),
                func.min(Invoice.due_date),
            )
            .join(BillingCustomer, BillingCustomer.id == Invoice.customer_id)
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status.in_(["sent", "overdue", "partially_paid"]),
            )
            .group_by(Invoice.customer_id, BillingCustomer.company_name, BillingCustomer.display_name)
            .order_by(func.coalesce(func.sum(Invoice.balance_due * rate), 0).desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "customer_id": customer_id,
                "customer_name": display_name or company_name,
                "total_overdue": float(total),
                "invoice_count": count,
                "oldest_due_date": oldest_due.isoformat() if oldest_due else None,
            }
            for customer_id, company_name, display_name, total, count, oldest_due in rows
        ]

    def get_aging_buckets(self, organization_id: int, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        """AR aging buckets computed in the database.

        A single grouped aggregate (by currency and bucket) replaces the old
        per-invoice Python loop in CollectionService — the aggregation no
        longer scales with the invoice count. Buckets are defined by due-date
        thresholds relative to today, so the SQL is portable across Postgres
        (production) and SQLite (local dev): due_date is compared against
        literal dates, not a day-difference expression.

        Return shape is byte-identical to the previous implementation: dict
        keys "0_30".."91_plus" (each {count, total}) plus a "buckets" list
        view for chart/report consumers.
        """
        today = date.today()
        d30 = today - timedelta(days=30)
        d60 = today - timedelta(days=60)
        d90 = today - timedelta(days=90)

        bucket_expr = case(
            (Invoice.due_date <= d90, "91_plus"),
            (Invoice.due_date <= d60, "61_90"),
            (Invoice.due_date <= d30, "31_60"),
            else_="0_30",
        )
        rows = (
            self.db.query(
                Invoice.currency,
                bucket_expr.label("bucket"),
                func.count(Invoice.id),
                func.coalesce(func.sum(Invoice.balance_due), 0),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status.in_(["sent", "overdue", "partially_paid"]),
                Invoice.due_date.isnot(None),
                # An invoice due today is not yet overdue -- same boundary
                # InvoiceRepository.list_effectively_overdue and the
                # scheduled overdue-invoice job both use (DEF-06: this used
                # to be `<= today`, one day out of step with those two).
                Invoice.due_date < today,
            )
            .group_by(Invoice.currency, "bucket")
            .all()
        )

        buckets = {
            "0_30": {"total": Decimal("0"), "count": 0},
            "31_60": {"total": Decimal("0"), "count": 0},
            "61_90": {"total": Decimal("0"), "count": 0},
            "91_plus": {"total": Decimal("0"), "count": 0},
        }
        for currency, bucket, count, total in rows:
            rate = (currency_rates or {}).get(currency, 1.0)
            buckets[bucket]["total"] += Decimal(str(total)) * Decimal(str(rate))
            buckets[bucket]["count"] += count

        total_all = sum(float(v["total"]) for v in buckets.values())
        bucket_labels = {"0_30": "0-30 days", "31_60": "31-60 days", "61_90": "61-90 days", "91_plus": "91+ days"}
        result = {
            k: {"count": v["count"], "total": float(v["total"])}
            for k, v in buckets.items()
        }
        result["buckets"] = [
            {
                "bucket": bucket_labels[k],
                "count": v["count"],
                "total_amount": float(v["total"]),
                "percentage": round((float(v["total"]) / total_all * 100), 2) if total_all else 0.0,
            }
            for k, v in buckets.items()
        ]
        return result

    def list_overdue_with_customer(self, organization_id: int) -> List[Invoice]:
        """Effectively-overdue invoices (see list_effectively_overdue) with
        the customer relationship eager-loaded — the collections queue reads
        inv.customer per row, so a plain query would trigger an N+1 query
        for every invoice."""
        return self.list_effectively_overdue(organization_id, with_customer=True)

    def get_outstanding_total(self, organization_id: int, currency_rates: Optional[Dict[str, float]] = None) -> float:
        rate = self._rate_case(Invoice.currency, currency_rates)
        result = self.db.query(
            func.coalesce(func.sum(Invoice.balance_due * rate), 0)
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.status.in_(["sent", "overdue", "partially_paid"]),
        ).scalar()
        return float(result)

    def mark_sent(self, id: int, organization_id: int) -> Invoice:
        inv = self.get_by_id(id, organization_id)
        inv.status = InvoiceStatus.SENT
        inv.sent_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(inv)
        return inv

    def mark_paid(self, id: int, organization_id: int, amount: Decimal) -> Invoice:
        inv = self.get_by_id(id, organization_id)
        inv.paid_amount = amount
        inv.balance_due = inv.total_amount - amount
        inv.status = InvoiceStatus.PAID if inv.balance_due <= 0 else InvoiceStatus.PARTIALLY_PAID
        inv.paid_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(inv)
        return inv

    def get_dashboard_stats(self, organization_id: int, period: Optional[str] = None, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        from app.modules.billing.utils.date_utils import get_period_dates
        rate = self._rate_case(Invoice.currency, currency_rates)
        filters = [
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
        ]
        if period:
            period_start, period_end = get_period_dates(period)
            filters.append(Invoice.issue_date >= period_start)
            filters.append(Invoice.issue_date <= period_end)
        # Single grouped-aggregate query instead of 4 separate round trips
        # (1 count + 3 conditional sums) -- each round trip costs real,
        # measurable network latency in this environment.
        total_invoices, total_amount, paid_amount, overdue_amount = self.db.query(
            func.count(Invoice.id),
            func.coalesce(func.sum(Invoice.total_amount * rate), 0),
            func.coalesce(func.sum(case((Invoice.status == "paid", Invoice.total_amount * rate), else_=0)), 0),
            func.coalesce(func.sum(case((Invoice.status == "overdue", Invoice.balance_due * rate), else_=0)), 0),
        ).filter(*filters).one()
        return {
            "total_invoices": total_invoices,
            "total_amount": float(total_amount),
            "paid_amount": float(paid_amount),
            "overdue_amount": float(overdue_amount),
        }

    def get_enterprise_dashboard_stats(
        self,
        organization_id: int,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        rate = self._rate_case(Invoice.currency, currency_rates)
        base_filters = [
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.status != "draft",
        ]
        if date_from:
            base_filters.append(Invoice.issue_date >= date_from)
        if date_to:
            base_filters.append(Invoice.issue_date <= date_to)

        now = datetime.utcnow()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        outstanding_cond = Invoice.status.in_(["sent", "overdue", "partially_paid"])
        paid_cond = Invoice.status == "paid"
        overdue_cond = Invoice.status == "overdue"
        this_month_cond = and_(paid_cond, Invoice.paid_at >= month_start)

        # Single grouped-aggregate query instead of 7 separate round trips
        # (1 count + 6 conditional sums) -- each round trip costs real,
        # measurable network latency in this environment. this_month_revenue
        # is computed here too, before month_start was previously used
        # further down -- moved up so it's available for this same query.
        (total_invoices, total_amount, paid_amount, outstanding_amount,
         overdue_amount, this_month_revenue, total_tax) = self.db.query(
            func.count(Invoice.id),
            func.coalesce(func.sum(Invoice.total_amount * rate), 0),
            func.coalesce(func.sum(case((paid_cond, Invoice.total_amount * rate), else_=0)), 0),
            func.coalesce(func.sum(case((outstanding_cond, Invoice.balance_due * rate), else_=0)), 0),
            func.coalesce(func.sum(case((overdue_cond, Invoice.balance_due * rate), else_=0)), 0),
            func.coalesce(func.sum(case((this_month_cond, Invoice.total_amount * rate), else_=0)), 0),
            func.coalesce(func.sum(Invoice.tax_amount * rate), 0),
        ).filter(*base_filters).one()
        total_amount = float(total_amount)
        paid_amount = float(paid_amount)
        outstanding_amount = float(outstanding_amount)
        overdue_amount = float(overdue_amount)
        this_month_revenue = float(this_month_revenue)
        total_tax = float(total_tax)

        status_query = self.db.query(
            Invoice.status,
            func.count(Invoice.id),
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
        )
        if date_from:
            status_query = status_query.filter(Invoice.issue_date >= date_from)
        if date_to:
            status_query = status_query.filter(Invoice.issue_date <= date_to)
        status_rows = status_query.group_by(Invoice.status).all()
        status_counts = {row[0].value if hasattr(row[0], "value") else str(row[0]): row[1] for row in status_rows}

        avg_days_query = self.db.query(
            func.avg(
                func.extract("epoch", Invoice.paid_at - Invoice.issue_date) / 86400
            )
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.status == "paid",
            Invoice.paid_at.isnot(None),
            Invoice.issue_date.isnot(None),
        )
        if date_from:
            avg_days_query = avg_days_query.filter(Invoice.issue_date >= date_from)
        if date_to:
            avg_days_query = avg_days_query.filter(Invoice.issue_date <= date_to)
        avg_days = float(avg_days_query.scalar() or 0)

        collection_rate = (paid_amount / total_amount * 100) if total_amount > 0 else 0

        return {
            "total_invoices": total_invoices,
            "status_counts": status_counts,
            "total_amount": total_amount,
            "outstanding_amount": outstanding_amount,
            "collected_amount": paid_amount,
            "this_month_revenue": this_month_revenue,
            "average_payment_days": round(avg_days, 1),
            "collection_rate": round(min(100, collection_rate), 1),
            "total_tax_collected": total_tax,
            "overdue_amount": overdue_amount,
        }

    def get_invoice_trend(self, organization_id: int, months: int = 12, currency_rates: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
        now = datetime.utcnow()
        cutoff = (now - timedelta(days=30 * months)).replace(day=1)
        rate = self._rate_case(Invoice.currency, currency_rates)
        rows = (
            self.db.query(
                extract("year", Invoice.created_at).label("yr"),
                extract("month", Invoice.created_at).label("mo"),
                func.count(Invoice.id).label("count"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("total"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.created_at >= cutoff,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        lookup = {(int(r.yr), int(r.mo)): {"count": r.count, "total": float(r.total)} for r in rows}
        results = []
        for i in range(months - 1, -1, -1):
            dt = now - timedelta(days=30 * i)
            month_start = dt.replace(day=1)
            key = (month_start.year, month_start.month)
            data = lookup.get(key, {"count": 0, "total": 0.0})
            results.append({
                "month": month_start.strftime("%b %Y"),
                "count": data["count"],
                "total": data["total"],
            })
        return results

    def get_revenue_trend(self, organization_id: int, months: int = 12, currency_rates: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
        now = datetime.utcnow()
        cutoff = (now - timedelta(days=30 * months)).replace(day=1)
        rate = self._rate_case(Invoice.currency, currency_rates)

        invoiced_rows = (
            self.db.query(
                extract("year", Invoice.created_at).label("yr"),
                extract("month", Invoice.created_at).label("mo"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("invoiced"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.created_at >= cutoff,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        invoiced_lookup = {(int(r.yr), int(r.mo)): float(r.invoiced) for r in invoiced_rows}

        collected_rows = (
            self.db.query(
                extract("year", Invoice.paid_at).label("yr"),
                extract("month", Invoice.paid_at).label("mo"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("revenue"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status == "paid",
                Invoice.paid_at >= cutoff,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        collected_lookup = {(int(r.yr), int(r.mo)): float(r.revenue) for r in collected_rows}

        results = []
        for i in range(months - 1, -1, -1):
            dt = now - timedelta(days=30 * i)
            month_start = dt.replace(day=1)
            key = (month_start.year, month_start.month)
            results.append({
                "month": month_start.strftime("%b %Y"),
                "revenue": collected_lookup.get(key, 0.0),
                "invoiced": invoiced_lookup.get(key, 0.0),
            })
        return results

    def get_payment_collection_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        now = datetime.utcnow()
        cutoff = (now - timedelta(days=30 * months)).replace(day=1)

        total_rows = (
            self.db.query(
                extract("year", Invoice.created_at).label("yr"),
                extract("month", Invoice.created_at).label("mo"),
                func.count(Invoice.id).label("total"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.created_at >= cutoff,
            )
            .group_by("yr", "mo")
            .all()
        )
        total_lookup = {(int(r.yr), int(r.mo)): r.total for r in total_rows}

        paid_rows = (
            self.db.query(
                extract("year", Invoice.paid_at).label("yr"),
                extract("month", Invoice.paid_at).label("mo"),
                func.count(Invoice.id).label("paid"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status == "paid",
                Invoice.paid_at >= cutoff,
            )
            .group_by("yr", "mo")
            .all()
        )
        paid_lookup = {(int(r.yr), int(r.mo)): r.paid for r in paid_rows}

        results = []
        for i in range(months - 1, -1, -1):
            dt = now - timedelta(days=30 * i)
            month_start = dt.replace(day=1)
            key = (month_start.year, month_start.month)
            total_inv = total_lookup.get(key, 0)
            paid_inv = paid_lookup.get(key, 0)
            rate = (paid_inv / total_inv * 100) if total_inv > 0 else 0
            results.append({
                "month": month_start.strftime("%b %Y"),
                "rate": round(rate, 1),
                "total": total_inv,
                "paid": paid_inv,
            })
        return results

    def get_status_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        results = self.db.query(
            Invoice.status,
            func.count(Invoice.id),
            func.coalesce(func.sum(Invoice.total_amount), 0),
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
        ).group_by(Invoice.status).all()

        colors = {
            "draft": "#6b7280",
            "sent": "#3b82f6",
            "paid": "#10b981",
            "overdue": "#ef4444",
            "cancelled": "#f59e0b",
            "partially_paid": "#8b5cf6",
            "refunded": "#ec4899",
        }
        return [
            {"name": status.value.replace("_", " ").title(), "value": count, "amount": float(amount), "color": colors.get(status.value, "#6b7280")}
            for status, count, amount in results
        ]

    def get_monthly_revenue_stats(self, organization_id: int, months: int = 12, currency_rates: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
        now = datetime.utcnow()
        cutoff = (now - timedelta(days=30 * months)).replace(day=1)
        rate = self._rate_case(Invoice.currency, currency_rates)

        created_rows = (
            self.db.query(
                extract("year", Invoice.created_at).label("yr"),
                extract("month", Invoice.created_at).label("mo"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("total"),
                func.coalesce(func.sum(Invoice.tax_amount * rate), 0).label("tax"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.created_at >= cutoff,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        created_lookup = {(int(r.yr), int(r.mo)): {"total": float(r.total), "tax": float(r.tax)} for r in created_rows}

        collected_rows = (
            self.db.query(
                extract("year", Invoice.paid_at).label("yr"),
                extract("month", Invoice.paid_at).label("mo"),
                func.coalesce(func.sum(Invoice.total_amount * rate), 0).label("collected"),
            )
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.is_active == True,
                Invoice.status == "paid",
                Invoice.paid_at >= cutoff,
            )
            .group_by("yr", "mo")
            .order_by("yr", "mo")
            .all()
        )
        collected_lookup = {(int(r.yr), int(r.mo)): float(r.collected) for r in collected_rows}

        results = []
        for i in range(months - 1, -1, -1):
            dt = now - timedelta(days=30 * i)
            month_start = dt.replace(day=1)
            key = (month_start.year, month_start.month)
            data = created_lookup.get(key, {"total": 0.0, "tax": 0.0})
            results.append({
                "month": month_start.strftime("%b %Y"),
                "total": data["total"],
                "collected": collected_lookup.get(key, 0.0),
                "tax": data["tax"],
            })
        return results

    def get_recent_activity(self, organization_id: int, limit: int = 10) -> List[Dict[str, Any]]:
        history = self.db.query(InvoiceStatusHistory).filter(
            InvoiceStatusHistory.organization_id == organization_id,
        ).order_by(InvoiceStatusHistory.created_at.desc()).limit(limit).all()

        return [
            {
                "id": h.id,
                "invoice_id": h.invoice_id,
                "from_status": h.from_status,
                "to_status": h.to_status,
                "changed_by": h.changed_by,
                "reason": h.reason,
                "created_at": h.created_at.isoformat() if h.created_at else None,
                "action": f"Status changed from {h.from_status or 'new'} to {h.to_status}",
            }
            for h in history
        ]

    def bulk_delete(self, ids: List[int], organization_id: int) -> int:
        # Resolve the requested ids within this organization first (silently
        # excludes ids that don't exist or belong to another org, same as the
        # delete query below always has) and validate status BEFORE any
        # mutation. If any resolved invoice is not DRAFT, reject the whole
        # batch — a bulk operation must never delete some invoices while
        # discovering a protected one partway through.
        invoices = self.get_by_ids(ids, organization_id)
        non_draft = [inv for inv in invoices if inv.status != InvoiceStatus.DRAFT]
        if non_draft:
            raise BadRequestException("Only draft invoices can be deleted.")

        query = self.db.query(Invoice).filter(
            Invoice.id.in_(ids),
            Invoice.organization_id == organization_id,
        )
        deleted = query.delete(synchronize_session="fetch")
        self.db.commit()
        return deleted

    def _build_filtered_query(self, organization_id: int, active_only: bool = True, **filters: Any):
        query = self.db.query(Invoice)
        query = self._org_filter(query, organization_id)
        query = self._active_filter(query, active_only)
        if self._has_deleted_at:
            query = query.filter(Invoice.deleted_at.is_(None))
        for field, value in filters.items():
            if value is not None:
                query = self._apply_filter(query, field, value)
        return query

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        status: Optional[str] = None,
        invoice_type: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        currency: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        payment_status: Optional[str] = None,
        is_overdue: Optional[bool] = None,
        owner_id: Optional[int] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        per_page = min(max(per_page, 1), 200)
        page = max(page, 1)
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if invoice_type:
            filters["invoice_type"] = invoice_type
        if "contract_id" in filters and filters["contract_id"] is None:
            filters.pop("contract_id")
        if "subscription_id" in filters and filters["subscription_id"] is None:
            filters.pop("subscription_id")
        base_query = self._build_filtered_query(
            organization_id, active_only, **filters
        )
        base_query = base_query.options(joinedload(Invoice.customer))
        if search_term:
            base_query = base_query.filter(
                or_(
                    Invoice.invoice_number.ilike(f"%{search_term}%"),
                    Invoice.po_number.ilike(f"%{search_term}%"),
                )
            )
        if date_from:
            base_query = base_query.filter(Invoice.issue_date >= self._parse_date_boundary(date_from, "date_from").date())
        if date_to:
            base_query = base_query.filter(Invoice.issue_date <= self._parse_date_boundary(date_to, "date_to").date())
        if currency:
            base_query = base_query.filter(Invoice.currency == currency)
        if min_amount is not None:
            base_query = base_query.filter(Invoice.total_amount >= min_amount)
        if max_amount is not None:
            base_query = base_query.filter(Invoice.total_amount <= max_amount)
        if is_overdue:
            base_query = base_query.filter(Invoice.status == "overdue")
        if owner_id:
            base_query = base_query.filter(Invoice.created_by == owner_id)
        total = base_query.count()
        if sort_by and hasattr(Invoice, sort_by):
            from sqlalchemy import asc as sa_asc, desc as sa_desc
            order_fn = sa_asc if sort_order == "asc" else sa_desc
            base_query = base_query.order_by(order_fn(getattr(Invoice, sort_by)))
        items = base_query.offset((page - 1) * per_page).limit(per_page).all()
        return {
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
            "items": items,
        }


class InvoiceItemRepository(BaseRepository[InvoiceItem]):
    def __init__(self, db):
        super().__init__(db, InvoiceItem)

    def list_by_invoice(self, organization_id: int, invoice_id: int) -> List[InvoiceItem]:
        query = self.db.query(InvoiceItem).filter(
            InvoiceItem.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(InvoiceItem.line_number).all()

    def bulk_create_for_invoice(
        self,
        organization_id: int,
        invoice_id: int,
        items: List[Dict[str, Any]],
    ) -> List[InvoiceItem]:
        objs = [InvoiceItem(organization_id=organization_id, invoice_id=invoice_id, **item) for item in items]
        self.db.add_all(objs)
        self.db.commit()
        for obj in objs:
            self.db.refresh(obj)
        return objs

    def delete_by_invoice(self, organization_id: int, invoice_id: int) -> int:
        query = self.db.query(InvoiceItem).filter(
            InvoiceItem.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        deleted = query.delete(synchronize_session="fetch")
        self.db.commit()
        return deleted


class InvoiceStatusHistoryRepository(BaseRepository[InvoiceStatusHistory]):
    def __init__(self, db):
        super().__init__(db, InvoiceStatusHistory)

    def list_by_invoice(self, organization_id: int, invoice_id: int) -> List[InvoiceStatusHistory]:
        query = self.db.query(InvoiceStatusHistory).filter(
            InvoiceStatusHistory.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(InvoiceStatusHistory.created_at.desc()).all()

    def log_status_change(
        self,
        organization_id: int,
        invoice_id: int,
        from_status: Optional[str],
        to_status: str,
        changed_by: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> InvoiceStatusHistory:
        entry = InvoiceStatusHistory(
            organization_id=organization_id,
            invoice_id=invoice_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry


class InvoiceCommunicationRepository(BaseRepository[InvoiceCommunication]):
    def __init__(self, db):
        super().__init__(db, InvoiceCommunication)

    def list_by_invoice(self, organization_id: int, invoice_id: int) -> List[InvoiceCommunication]:
        query = self.db.query(InvoiceCommunication).filter(
            InvoiceCommunication.invoice_id == invoice_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(InvoiceCommunication.created_at.desc()).all()

    def record_event(
        self,
        organization_id: int,
        invoice_id: int,
        event_type: str,
        status: str = CommunicationEventStatus.SENT,
        recipient: Optional[str] = None,
        subject: Optional[str] = None,
        body_preview: Optional[str] = None,
        event_metadata: Optional[Dict[str, Any]] = None,
        created_by: Optional[int] = None,
    ) -> InvoiceCommunication:
        entry = InvoiceCommunication(
            organization_id=organization_id,
            invoice_id=invoice_id,
            event_type=event_type,
            status=status,
            recipient=recipient,
            subject=subject,
            body_preview=body_preview,
            event_metadata=event_metadata,
            created_by=created_by,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def list_by_invoice_safe(self, organization_id: int, invoice_id: int) -> List[InvoiceCommunication]:
        """Best-effort read. Communication history is a secondary feature and
        must never break invoice/timeline rendering if it can't be loaded."""
        try:
            return self.list_by_invoice(organization_id, invoice_id)
        except SQLAlchemyError as e:
            logger.warning("Could not load communication history for invoice %d: %s", invoice_id, e)
            self.db.rollback()
            return []

    def record_event_safe(self, *args: Any, **kwargs: Any) -> Optional[InvoiceCommunication]:
        """Best-effort write. Logging a communication event must never fail
        the operation (e.g. sending an email) that triggered it."""
        try:
            return self.record_event(*args, **kwargs)
        except SQLAlchemyError as e:
            invoice_id = kwargs.get("invoice_id", args[1] if len(args) > 1 else None)
            logger.warning("Could not record communication event for invoice %s: %s", invoice_id, e)
            self.db.rollback()
            return None
