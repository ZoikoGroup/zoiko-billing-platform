"""
modules/super_admin/saas_reporting_service.py
------------------------------------------------
Phase 3F F10 — honest Plane 1 commercial reporting read model.

Aggregates real rows from the commercial tables into the super-admin
"SaaS Reporting" surface. Honesty rules (gap analysis 3F/F10, mirroring
COM-01):

  - subscription/account counts are real database row counts — never
    estimated or extrapolated;
  - MRR is computed ONLY from open subscriptions whose catalog version is
    PUBLISHED with a non-null ``price_amount`` (monthly normalization:
    annual prices are divided by 12);
  - coverage is always reported alongside any computed figure;
  - when no priced open subscription exists the figure is reported with
    ``state="unknown"`` — never zero, never fabricated;
  - Plane 1 invoicing/payments/collections do not exist yet (acceptance
    items REC-01 / PAY-01 / PAY-02), so this report contains no
    invoice-derived figures and never will until those are built.

Read-only: opens no transaction of its own.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.modules.commercial.enums import (
    CommercialAccountStatus,
    CommercialBillingInterval,
    CommercialPlanVersionStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialPlanVersion,
    CommercialSubscription,
)

logger = logging.getLogger("zoiko_billing.super_admin.saas_reporting")

# Monthly normalization factors for MRR.
_INTERVAL_MONTHLY_FACTOR = {
    CommercialBillingInterval.MONTHLY: Decimal("1"),
    CommercialBillingInterval.ANNUAL: Decimal("1") / Decimal("12"),
}

_TWO_PLACES = Decimal("0.01")

_OPEN_SUB_STATUSES = {
    CommercialSubscriptionStatus.PENDING,
    CommercialSubscriptionStatus.ACTIVE,
    CommercialSubscriptionStatus.PAST_DUE,
    CommercialSubscriptionStatus.RESTRICTED,
    CommercialSubscriptionStatus.SUSPENDED,
}

_HONESTY_NOTES = [
    "Counts are real database rows; nothing is estimated.",
    "MRR uses only PUBLISHED catalog versions with a non-null price_amount; "
    "annual prices are normalized by dividing by 12.",
    "Plane 1 invoicing, payments and collections do not exist yet "
    "(acceptance items REC-01 / PAY-01 / PAY-02), so this report contains "
    "no invoice-derived figures.",
]


def _enum_value(value) -> str:
    return value.value if hasattr(value, "value") else str(value)


class SaasReportingService:
    def __init__(self, db: Session):
        self.db = db

    # ── public read model ───────────────────────────────────────────────────

    def get_reporting(self) -> dict:
        accounts_by_status = self._count_accounts_by_status()
        subs_by_status = self._count_subscriptions_by_status()
        open_by_plan = self._open_subscriptions_by_plan()
        mrr = self._compute_mrr()

        return {
            "generated_at": datetime.now(timezone.utc),
            "accounts": {
                "total": sum(accounts_by_status.values()),
                "by_status": accounts_by_status,
            },
            "subscriptions": {
                "total_ever": sum(subs_by_status.values()),
                "total_open": sum(i["open_subscriptions"] for i in open_by_plan),
                "by_status": subs_by_status,
                "open_by_plan": open_by_plan,
            },
            "mrr": mrr,
            "plane": "PLATFORM",
            "honesty_notes": list(_HONESTY_NOTES),
        }

    # ── aggregations ────────────────────────────────────────────────────────

    def _count_accounts_by_status(self) -> dict[str, int]:
        rows = (
            self.db.query(CommercialAccount.status, func.count(CommercialAccount.id))
            .group_by(CommercialAccount.status)
            .all()
        )
        counts = {status.value: 0 for status in CommercialAccountStatus}
        for status, count in rows:
            counts[_enum_value(status)] = int(count)
        return counts

    def _count_subscriptions_by_status(self) -> dict[str, int]:
        rows = (
            self.db.query(
                CommercialSubscription.status, func.count(CommercialSubscription.id)
            )
            .group_by(CommercialSubscription.status)
            .all()
        )
        counts = {status.value: 0 for status in CommercialSubscriptionStatus}
        for status, count in rows:
            counts[_enum_value(status)] = int(count)
        return counts

    def _open_subscriptions_by_plan(self) -> list[dict]:
        """Open subscriptions grouped by plan (real counts only)."""
        from app.modules.commercial.models import CommercialPlan

        plan_join = self.db.query(
            CommercialPlan.id,
            CommercialPlan.plan_code,
            CommercialPlan.plan_name,
            func.count(CommercialSubscription.id).label("open_count"),
        ).join(
            CommercialSubscription,
            CommercialSubscription.commercial_plan_id == CommercialPlan.id,
        ).filter(
            CommercialSubscription.status.in_(list(_OPEN_SUB_STATUSES)),
        ).group_by(
            CommercialPlan.id, CommercialPlan.plan_code, CommercialPlan.plan_name,
        ).order_by(CommercialPlan.plan_code).all()

        return [
            {
                "plan_id": plan_id,
                "plan_code": plan_code,
                "plan_name": plan_name,
                "open_subscriptions": int(open_count),
            }
            for plan_id, plan_code, plan_name, open_count in plan_join
        ]

    def _compute_mrr(self) -> dict:
        """Compute MRR strictly from priced published catalog versions.

        A subscription contributes only when its own ``catalog_version_id``
        points at a PUBLISHED version carrying a non-null price_amount.
        Subscriptions without such a reference are counted as unpriced
        coverage — they never contribute an invented amount.
        """
        open_total = (
            self.db.query(func.count(CommercialSubscription.id))
            .filter(CommercialSubscription.status.in_(list(_OPEN_SUB_STATUSES)))
            .scalar()
        ) or 0

        plans_with_price = (
            self.db.query(func.count(func.distinct(CommercialPlanVersion.plan_id)))
            .filter(
                CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
                CommercialPlanVersion.price_amount.isnot(None),
            )
            .scalar()
        ) or 0

        priced_rows = (
            self.db.query(
                CommercialPlanVersion.currency,
                CommercialPlanVersion.billing_interval,
                CommercialPlanVersion.price_amount,
            )
            .join(
                CommercialSubscription,
                CommercialSubscription.catalog_version_id == CommercialPlanVersion.id,
            )
            .filter(
                CommercialSubscription.status.in_(list(_OPEN_SUB_STATUSES)),
                CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
                CommercialPlanVersion.price_amount.isnot(None),
            )
            .all()
        )

        per_currency: dict[str, Decimal] = {}
        per_currency_subs: dict[str, int] = {}
        for currency, interval, amount in priced_rows:
            factor = _INTERVAL_MONTHLY_FACTOR.get(interval)
            if factor is None:
                # Unknown interval — refuse to guess a normalization factor.
                logger.warning(
                    "Skipping MRR contribution with unknown billing_interval=%s",
                    interval,
                )
                continue
            key = _enum_value(currency)
            per_currency[key] = per_currency.get(key, Decimal("0")) + (
                Decimal(str(amount)) * factor
            )
            per_currency_subs[key] = per_currency_subs.get(key, 0) + 1

        priced_total = sum(per_currency_subs.values())
        currencies = [
            {
                "currency": code,
                "monthly_amount": per_currency[code].quantize(
                    _TWO_PLACES, rounding=ROUND_HALF_UP
                ),
                "subscriptions": per_currency_subs[code],
            }
            for code in sorted(per_currency)
        ]

        if priced_total == 0:
            # COM-01 mirror: zero priced catalogue => UNKNOWN, not zero.
            return {
                "state": "unknown",
                "amount": None,
                "currencies": [],
                "coverage": {
                    "open_subscriptions_total": int(open_total),
                    "open_subscriptions_priced": 0,
                    "plans_with_published_price": int(plans_with_price),
                },
                "basis": (
                    "UNKNOWN — no open subscription references a PUBLISHED "
                    "catalog version with a non-null price_amount."
                ),
            }

        if len(currencies) > 1:
            return {
                "state": "multi_currency",
                "amount": None,
                "currencies": currencies,
                "coverage": {
                    "open_subscriptions_total": int(open_total),
                    "open_subscriptions_priced": priced_total,
                    "plans_with_published_price": int(plans_with_price),
                },
                "basis": (
                    "Computed per currency; no single-currency total is "
                    "fabricated across mixed currencies."
                ),
            }

        return {
            "state": "computed",
            "amount": currencies[0]["monthly_amount"],
            "currencies": currencies,
            "coverage": {
                "open_subscriptions_total": int(open_total),
                "open_subscriptions_priced": priced_total,
                "plans_with_published_price": int(plans_with_price),
            },
            "basis": (
                f"Sum of monthly-normalized published prices over "
                f"{priced_total} priced open subscription(s); "
                f"{int(open_total) - priced_total} unpriced open "
                "subscription(s) excluded."
            ),
        }
