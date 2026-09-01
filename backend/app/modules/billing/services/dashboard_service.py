import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import func, case, and_
from sqlalchemy.orm import Session

from app.modules.billing.repositories.customer import CustomerRepository
from app.modules.billing.repositories.invoice import Invoice, InvoiceRepository
from app.modules.billing.repositories.payment import Payment, PaymentRepository
from app.modules.billing.repositories.subscription import SubscriptionRepository
from app.modules.billing.services.exchange_rate_service import ExchangeRateService
from app.modules.billing.services.settings_service import BillingConfigurationService
# MONTH_NAMES/get_period_dates/period_to_months live in utils/date_utils.py
# (Phase 2: repositories/invoice.py and repositories/payment.py needed these
# too, and were importing them from this service module — a repository
# depending on a service inverts the intended dependency direction). Still
# re-exported here so nothing importing them from this module breaks.
from app.modules.billing.utils.date_utils import (  # noqa: F401
    MONTH_NAMES,
    get_period_dates,
    period_to_months,
    is_daily_granularity,
)

logger = logging.getLogger("zoiko_billing")


class BillingDashboardService:
    def __init__(self, db: Session):
        self.db = db
        self.invoice_repo = InvoiceRepository(db)
        self.payment_repo = PaymentRepository(db)
        self.customer_repo = CustomerRepository(db)
        self.sub_repo = SubscriptionRepository(db)
        self.exchange_svc = ExchangeRateService(db)
        self.config_svc = BillingConfigurationService(db)

    def _get_base_currency(self, organization_id: int) -> str:
        return self.config_svc.get_default_currency(organization_id)

    def _build_currency_rates(self, organization_id: int, base_currency: Optional[str] = None) -> Dict[str, float]:
        """Build {currency_code: multiplier_to_base} for all currencies in use."""
        base = base_currency or self._get_base_currency(organization_id)
        unique_currencies = set()

        inv_currencies = self.db.query(Invoice.currency).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
        ).distinct().all()
        unique_currencies.update(row[0] for row in inv_currencies if row[0])

        from app.modules.billing.models import Payment
        pmt_currencies = self.db.query(Payment.currency).filter(
            Payment.organization_id == organization_id,
            Payment.is_active == True,
        ).distinct().all()
        unique_currencies.update(row[0] for row in pmt_currencies if row[0])

        # If the cached rates are stale, attempt ONE batch refresh so a slow or
        # unreachable live API is hit at most once instead of once per currency.
        config = self.exchange_svc.repo.get_by_organization(organization_id)
        try:
            if config and self.exchange_svc.is_rate_stale(organization_id, config=config):
                self.exchange_svc.refresh_rates(organization_id)
        except Exception as exc:
            # The refresh is savepoint-scoped in ExchangeRateService; a failure
            # must never roll back THIS session's pending work (a bare
            # self.db.rollback() here silently discarded uncommitted invoices
            # flushed by the caller before the balance question ran).
            logger.warning(
                "Exchange-rate refresh failed for org %s (using cached/legacy rates): %s",
                organization_id, exc,
            )

        rates: Dict[str, float] = {}
        for curr in sorted(unique_currencies):
            if curr == base:
                rates[curr] = 1.0
            else:
                try:
                    if config and not self.exchange_svc.is_rate_stale(organization_id, config=config):
                        rate, _, _ = self.exchange_svc.get_rate(organization_id, curr, base, config=config)
                    else:
                        rate, _, _ = self.exchange_svc._get_cached_rate(config, curr, base)
                        if rate is None:
                            rate, _, _ = self.exchange_svc._get_legacy_rate(config, curr, base)
                    rates[curr] = float(rate) if rate is not None else 1.0
                except Exception:
                    rates[curr] = 1.0
        return rates

    def get_kpis(
        self,
        organization_id: int,
        period: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """Single source of truth for the headline financial KPIs.

        Canonical definitions (T05 data-integrity guardrail — the dashboard
        page, the chatbot Inspect-mode answers and the DB must all agree):

        - total_revenue     = SUM(total_amount) of active invoices whose status
                              is NOT draft/cancelled ("billed revenue": issued
                              invoices regardless of payment status). Drafts
                              are not issued and cancelled invoices are void,
                              so neither counts as revenue. Paid-only revenue
                              is exposed separately as paid_amount.
        - outstanding_amount= SUM(balance_due) of active invoices with status
                              in (sent, overdue, partially_paid).
        - total_invoices    = COUNT of active invoices with status != draft.

        Every surface that shows these numbers MUST read them from here —
        never re-derive them with different filters.
        """
        now = datetime.utcnow()
        month_start = date(now.year, now.month, 1)
        today = date.today()

        period_start, period_end = get_period_dates(period, date_from, date_to)
        is_filtered = bool(period or date_from or date_to)

        from app.modules.billing.models import BillingCustomer, BillingSubscriptionStatus
        from app.modules.billing.models import Subscription as SubModel

        # currency_rates is expensive (2 distinct-currency queries plus a
        # possible live exchange-rate API call when the cache is stale) —
        # get_full_dashboard() computes it once and passes it through here
        # instead of paying that cost again. Standalone callers of get_kpis
        # (the /billing/dashboard/kpis endpoint) still get it computed for
        # them when they don't have one to share.
        if currency_rates is None:
            currency_rates = self._build_currency_rates(organization_id)
        if any(rate != 1.0 for rate in currency_rates.values()):
            rate_case = case(
                *[(Invoice.currency == curr, Decimal(str(rate))) for curr, rate in currency_rates.items() if rate != 1.0],
                else_=Decimal("1.0"),
            )
        else:
            rate_case = Decimal("1.0")

        inv_rows = self.invoice_repo.db.query(
            func.coalesce(func.sum(
                case((Invoice.is_active == True, Invoice.total_amount * rate_case), else_=0)
            ), 0).label("all_total"),
            func.coalesce(func.sum(
                case((and_(Invoice.is_active == True, Invoice.status.in_(["sent", "overdue", "partially_paid"])), Invoice.balance_due * rate_case), else_=0)
            ), 0).label("all_outstanding"),
            func.coalesce(func.sum(
                case((and_(Invoice.is_active == True, Invoice.status == "overdue"), Invoice.balance_due * rate_case), else_=0)
            ), 0).label("all_overdue"),
            func.count(case((
                and_(Invoice.is_active == True, Invoice.status.notin_(["draft", "cancelled"])),
                Invoice.id
            ), else_=None)).label("all_count"),
            func.coalesce(func.sum(
                case((and_(Invoice.is_active == True, Invoice.status == "paid"), Invoice.total_amount * rate_case), else_=0)
            ), 0).label("all_paid"),
            func.coalesce(func.sum(
                case((
                    and_(
                        Invoice.is_active == True,
                        Invoice.status.notin_(["draft", "cancelled"]),
                    ),
                    Invoice.total_amount * rate_case
                ), else_=0)
            ), 0).label("all_billed"),
            func.coalesce(func.sum(
                case((
                    and_(
                        Invoice.is_active == True,
                        Invoice.status == "paid",
                        Invoice.issue_date >= month_start,
                        Invoice.issue_date <= today,
                    ),
                    Invoice.total_amount * rate_case
                ), else_=0)
            ), 0).label("month_revenue"),
            func.coalesce(func.sum(
                case((
                    and_(
                        Invoice.is_active == True,
                        Invoice.status.notin_(["draft", "cancelled"]),
                        Invoice.issue_date >= period_start,
                        Invoice.issue_date <= period_end,
                    ),
                    Invoice.total_amount * rate_case
                ), else_=0)
            ), 0).label("period_total"),
            func.coalesce(func.sum(
                case((
                    and_(
                        Invoice.is_active == True,
                        Invoice.status == "paid",
                        Invoice.issue_date >= period_start,
                        Invoice.issue_date <= period_end,
                    ),
                    Invoice.total_amount * rate_case
                ), else_=0)
            ), 0).label("period_paid"),
            func.count(case((
                and_(
                    Invoice.is_active == True,
                    Invoice.status.notin_(["draft", "cancelled"]),
                    Invoice.issue_date >= period_start,
                    Invoice.issue_date <= period_end,
                ),
                Invoice.id
            ), else_=None)).label("period_count"),
        ).filter(Invoice.organization_id == organization_id).first()

        summary = {
            "total_revenue": float(inv_rows.all_billed),
            "paid_revenue": float(inv_rows.all_paid),
            "outstanding_amount": float(inv_rows.all_outstanding),
            "overdue_amount": float(inv_rows.all_overdue),
            "total_invoices": inv_rows.all_count,
        }

        period_summary = {
            "total_revenue": float(inv_rows.period_total),
            "paid_revenue": float(inv_rows.period_paid),
            "total_invoices": inv_rows.period_count,
        }

        # Customer + subscription counts in 2 queries (was 4)
        active_customers = self.customer_repo.count(organization_id, active_only=True)
        active_subs = self.sub_repo.count(organization_id, active_only=True, status="active")

        collections = self.payment_repo.get_total_collected(
            organization_id,
            date_from=str(period_start),
            date_to=str(period_end),
            currency_rates=currency_rates,
        )

        pending_payments = self.payment_repo.db.query(func.count(Payment.id)).filter(
            Payment.organization_id == organization_id,
            Payment.status == "pending",
        ).scalar() or 0

        period_total_revenue = period_summary["total_revenue"]
        period_paid_revenue = period_summary["paid_revenue"]

        return {
            "total_revenue": period_total_revenue if is_filtered else summary["total_revenue"],
            "paid_revenue": period_paid_revenue if is_filtered else summary["paid_revenue"],
            "paid_amount": period_paid_revenue if is_filtered else summary["paid_revenue"],
            "outstanding_amount": summary["outstanding_amount"],
            "overdue_amount": summary["overdue_amount"],
            "active_customers": active_customers,
            "active_subscriptions": active_subs,
            "monthly_revenue": float(inv_rows.month_revenue),
            "collections": collections,
            "pending_payments": pending_payments,
            "total_invoices": period_summary["total_invoices"] if is_filtered else summary["total_invoices"],
            "period_start": str(period_start) if is_filtered else None,
            "period_end": str(period_end) if is_filtered else None,
        }

    def get_monthly_revenue(
        self,
        organization_id: int,
        months: int = 12,
        period: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        currency_rates: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        if currency_rates is None:
            currency_rates = self._build_currency_rates(organization_id)
        if date_from or date_to:
            start, end = get_period_dates(period, date_from, date_to)
            data = (
                self.invoice_repo.get_daily_revenue(organization_id, start, end, currency_rates=currency_rates)
                if is_daily_granularity(start, end)
                else self.invoice_repo.get_monthly_revenue_for_period(organization_id, start, end, currency_rates=currency_rates)
            )
        elif period in ("today", "week", "month"):
            start, end = get_period_dates(period)
            data = self.invoice_repo.get_daily_revenue(organization_id, start, end, currency_rates=currency_rates)
        elif period in ("quarter", "year"):
            start, end = get_period_dates(period)
            data = self.invoice_repo.get_monthly_revenue_for_period(organization_id, start, end, currency_rates=currency_rates)
        else:
            effective_months = period_to_months(period) if period else months
            data = self.invoice_repo.get_monthly_revenue_bulk(organization_id, effective_months, currency_rates=currency_rates)
        return {"monthly_revenue": data}

    def get_payment_trend(
        self,
        organization_id: int,
        period: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        currency_rates = self._build_currency_rates(organization_id)
        if date_from or date_to:
            start, end = get_period_dates(period, date_from, date_to)
            data = (
                self.payment_repo.get_daily_payment_trend(organization_id, start, end, currency_rates=currency_rates)
                if is_daily_granularity(start, end)
                else self.payment_repo.get_monthly_payment_trend(organization_id, start, end, currency_rates=currency_rates)
            )
        elif period in ("today", "week", "month"):
            start, end = get_period_dates(period)
            data = self.payment_repo.get_daily_payment_trend(organization_id, start, end, currency_rates=currency_rates)
        elif period in ("quarter", "year"):
            start, end = get_period_dates(period)
            data = self.payment_repo.get_monthly_payment_trend(organization_id, start, end, currency_rates=currency_rates)
        else:
            start, end = get_period_dates(None)
            data = self.payment_repo.get_monthly_payment_trend(organization_id, start, end, currency_rates=currency_rates)
        return {"payment_trend": data}

    def get_invoice_summary(self, organization_id: int, currency_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        return self.invoice_repo.get_invoice_summary_by_status(organization_id, currency_rates=currency_rates)

    def get_outstanding_by_customer(self, organization_id: int) -> List[Dict[str, Any]]:
        """Per-customer outstanding using the SAME aggregation as get_kpis:
        status IN (sent, overdue, partially_paid), is_active, balance_due > 0,
        converted to the org's base currency.

        The sum of these per-customer values ALWAYS equals the org-wide
        outstanding_amount from get_kpis, because they share the exact same
        filters and rate_case. This is the single authoritative breakdown the
        chatbot / customer pages must use so per-customer and aggregate figures
        can never diverge (T05 data-integrity guardrail).
        """
        from app.modules.billing.models import Invoice
        currency_rates = self._build_currency_rates(organization_id)
        if any(rate != 1.0 for rate in currency_rates.values()):
            rate_case = case(
                *[(Invoice.currency == curr, Decimal(str(rate))) for curr, rate in currency_rates.items() if rate != 1.0],
                else_=Decimal("1.0"),
            )
        else:
            rate_case = Decimal("1.0")

        rows = self.db.query(
            Invoice.customer_id,
            func.coalesce(func.sum(Invoice.balance_due * rate_case), 0).label("outstanding"),
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.is_active == True,
            Invoice.status.in_(["sent", "overdue", "partially_paid"]),
            Invoice.balance_due > 0,
        ).group_by(Invoice.customer_id).all()
        return [{"customer_id": r[0], "outstanding": float(r[1])} for r in rows]

    def get_customer_summary(self, organization_id: int) -> Dict[str, Any]:
        base = self.customer_repo.count(organization_id, active_only=True)
        by_status = self.customer_repo.count_by_status(organization_id)
        return {
            "total_active_customers": base,
            "by_status": by_status,
        }

    def get_subscription_summary(self, organization_id: int) -> Dict[str, Any]:
        base = self.sub_repo.count(organization_id, active_only=True)
        by_status = self.sub_repo.count_by_status(organization_id)
        return {
            "total_active_subscriptions": base,
            "by_status": by_status,
        }

    def get_full_dashboard(
        self,
        organization_id: int,
        period: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        # Computed once and shared with get_kpis/get_monthly_revenue below —
        # see the comment on get_kpis for why this matters (each call is a
        # real cost: 2 DB round trips plus, when the org's cached rates are
        # stale, a live external exchange-rate API request).
        currency_rates = self._build_currency_rates(organization_id)
        kpis = self.get_kpis(organization_id, period=period, date_from=date_from, date_to=date_to, currency_rates=currency_rates)
        inv_summary = self.get_invoice_summary(organization_id, currency_rates=currency_rates)
        monthly = self.get_monthly_revenue(organization_id, period=period, date_from=date_from, date_to=date_to, currency_rates=currency_rates)

        # Customer + subscription summaries in 2 grouped queries (was 4 separate)
        from app.modules.billing.models import BillingCustomer, BillingSubscriptionStatus
        from app.modules.billing.models import Subscription as SubModel

        cust_rows = (
            self.db.query(
                BillingCustomer.status,
                func.count(BillingCustomer.id),
            ).filter(
                BillingCustomer.organization_id == organization_id,
                BillingCustomer.deleted_at.is_(None),
            ).group_by(BillingCustomer.status).all()
        )
        cust_by_status = {row[0]: row[1] for row in cust_rows}
        cust_summary = {
            "total_active_customers": sum(cust_by_status.values()),
            "by_status": cust_by_status,
        }

        sub_rows = (
            self.db.query(
                SubModel.status,
                func.count(SubModel.id),
            ).filter(
                SubModel.organization_id == organization_id,
                SubModel.is_active == True,
            ).group_by(SubModel.status).all()
        )
        sub_by_status = {row[0].value if hasattr(row[0], "value") else str(row[0]): row[1] for row in sub_rows}
        sub_summary = {
            "total_active_subscriptions": sum(sub_by_status.values()),
            "by_status": sub_by_status,
        }

        return {
            "kpis": kpis,
            "monthly_revenue": monthly,
            "invoice_summary": inv_summary,
            "customer_summary": cust_summary,
            "subscription_summary": sub_summary,
            "total_revenue": kpis.get("total_revenue", 0),
            "outstanding_amount": kpis.get("outstanding_amount", 0),
            "overdue_amount": kpis.get("overdue_amount", 0),
            "total_customers": cust_summary.get("total_active_customers", 0),
            "active_subscriptions": sub_summary.get("total_active_subscriptions", 0),
            "draft_invoices": inv_summary.get("draft_count", 0),
            "unpaid_invoices": inv_summary.get("sent_count", 0),
            "paid_invoices": inv_summary.get("paid_count", 0),
            "overdue_invoices": inv_summary.get("overdue_count", 0),
        }
