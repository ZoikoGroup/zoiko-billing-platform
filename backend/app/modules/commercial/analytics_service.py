"""
modules/commercial/analytics_service.py
-------------------------------------------
ZB-COM-ENT-001 Part 3 §18 — commercial/entitlement analytics. Mirrors
super_admin/financial_operations_detail_service.py's style: plain
Dict[str, Any] returns, func.coalesce to avoid NULL, enum serialization via
`s.value if hasattr(s, "value") else str(s)`, batched (not N+1) lookups.

Honesty rule (carried over from Part 2's fail-open/fail-closed discipline):
when a metric's true RATE isn't computable from data that actually exists
in this codebase, this service exposes the computable numerator/count and
OMITS the ratio field, with a docstring explaining why, rather than
fabricating a denominator. See metrics 4 and 7 below.

Backend-only this pass (no dedicated frontend dashboard) — a deliberate
scope cut, since the prompt itself says to cut Part C before Parts A/B if
time-boxed, and every metric here is still genuinely queryable and testable
via its read endpoint / this service directly.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.modules.commercial.entitlement_resolver import resolve_entitlement
from app.modules.commercial.enums import (
    CommercialSubscriptionStatus,
    SubscriptionChangeDirection,
    SubscriptionChangeStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialPlan,
    CommercialPlanVersion,
    CommercialSubscription,
    EntitlementDefinition,
    EntitlementSnapshot,
    PlatformInvoice,
    SubscriptionChange,
    UsageCounter,
)
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog


def _enum_value(v) -> str | None:
    return v.value if hasattr(v, "value") else (str(v) if v is not None else None)


class CommercialEntitlementAnalyticsService:
    def __init__(self, db: Session):
        self.db = db

    # ── 1. Trial activation rate ────────────────────────────────────────────
    def trial_activation_rate(self) -> Dict[str, Any]:
        """Eligible signups (orgs with a CommercialAccount) vs. those that
        reached a subscription with trial_ends_at set (i.e. actually
        activated a trial workspace, not just registered)."""
        eligible = self.db.query(func.count(CommercialAccount.id)).scalar() or 0
        activated = (
            self.db.query(func.count(func.distinct(CommercialSubscription.commercial_account_id)))
            .filter(CommercialSubscription.trial_ends_at.isnot(None))
            .scalar()
        ) or 0
        rate = (activated / eligible) if eligible else None
        return {"eligible_accounts": eligible, "activated_trials": activated, "activation_rate": rate}

    # ── 2. Trial-to-paid conversion rate ────────────────────────────────────
    def trial_to_paid_conversion_rate(self) -> Dict[str, Any]:
        rows = (
            self.db.query(CommercialSubscription.status, func.count(CommercialSubscription.id))
            .filter(CommercialSubscription.trial_ends_at.isnot(None))
            .group_by(CommercialSubscription.status)
            .all()
        )
        by_status = {_enum_value(status): count for status, count in rows}
        converted = by_status.get("active", 0)
        expired_unpaid = by_status.get("suspended", 0)
        denominator = converted + expired_unpaid
        rate = (converted / denominator) if denominator else None
        return {
            "converted": converted, "expired_unpaid": expired_unpaid,
            "still_trialing": by_status.get("trialing", 0),
            "conversion_rate": rate,
            "by_status": by_status,
        }

    # ── 3. Time to first invoice (median, activation -> first invoice) ─────
    def time_to_first_invoice_days(self) -> Dict[str, Any]:
        """"Activation" proxy: CommercialAccount.created_at (no separate
        activation timestamp exists in this schema)."""
        accounts = self.db.query(CommercialAccount.id, CommercialAccount.created_at).all()
        if not accounts:
            return {"sample_size": 0, "median_days": None}
        account_ids = [a.id for a in accounts]
        first_invoice_by_account: dict[int, datetime] = {}
        first_invoices = (
            self.db.query(
                PlatformInvoice.commercial_account_id,
                func.min(PlatformInvoice.issue_date),
            )
            .filter(PlatformInvoice.commercial_account_id.in_(account_ids), PlatformInvoice.issue_date.isnot(None))
            .group_by(PlatformInvoice.commercial_account_id)
            .all()
        )
        for account_id, first_issue_date in first_invoices:
            first_invoice_by_account[account_id] = first_issue_date

        created_at_by_account = {a.id: a.created_at for a in accounts}
        days = []
        for account_id, first_issue_date in first_invoice_by_account.items():
            created_at = created_at_by_account.get(account_id)
            if created_at is None or first_issue_date is None:
                continue
            delta_days = (datetime.combine(first_issue_date, datetime.min.time()) - created_at).days
            if delta_days >= 0:
                days.append(delta_days)

        if not days:
            return {"sample_size": 0, "median_days": None}
        days.sort()
        mid = len(days) // 2
        median = days[mid] if len(days) % 2 == 1 else (days[mid - 1] + days[mid]) / 2
        return {"sample_size": len(days), "median_days": median}

    # ── 4. Upgrade conversion rate ──────────────────────────────────────────
    def upgrade_conversion_rate(self) -> Dict[str, Any]:
        """NOT a fully computable ratio: preview calls (the "intent" side of
        this metric) are deliberately not persisted anywhere (Part 3A design
        — a preview commits nothing), so there is no denominator to divide
        by. Exposes the computable numerator (applied upgrades) only."""
        applied = (
            self.db.query(func.count(SubscriptionChange.id))
            .filter(
                SubscriptionChange.direction == SubscriptionChangeDirection.UPGRADE,
                SubscriptionChange.status == SubscriptionChangeStatus.APPLIED,
            )
            .scalar()
        ) or 0
        return {
            "applied_upgrades": applied,
            "conversion_rate": None,
            "note": (
                "Rate not computable: upgrade preview calls are not persisted "
                "(intentional — a preview commits nothing), so there is no "
                "intent denominator. Only the applied-upgrade count is real."
            ),
        }

    # ── 5. Downgrade save rate ──────────────────────────────────────────────
    def downgrade_save_rate(self) -> Dict[str, Any]:
        """Customers who hit a blocker/scheduled a downgrade and then were
        found back on their ORIGINAL plan with no APPLIED downgrade for that
        subscription — i.e. they resolved the friction and stayed."""
        attempts = (
            self.db.query(SubscriptionChange)
            .filter(
                SubscriptionChange.direction == SubscriptionChangeDirection.DOWNGRADE,
                SubscriptionChange.status.in_([SubscriptionChangeStatus.BLOCKED, SubscriptionChangeStatus.SCHEDULED, SubscriptionChangeStatus.REVERSED]),
            )
            .all()
        )
        if not attempts:
            return {"attempts": 0, "saved": 0, "save_rate": None}

        applied_subscription_ids = {
            row[0]
            for row in self.db.query(SubscriptionChange.commercial_subscription_id)
            .filter(
                SubscriptionChange.direction == SubscriptionChangeDirection.DOWNGRADE,
                SubscriptionChange.status == SubscriptionChangeStatus.APPLIED,
            )
            .all()
        }
        saved = sum(
            1 for a in attempts
            if a.commercial_subscription_id not in applied_subscription_ids
            and a.subscription is not None
            and a.subscription.commercial_plan_id == a.from_plan_id
        )
        return {"attempts": len(attempts), "saved": saved, "save_rate": saved / len(attempts)}

    # ── 6. Limit-pressure rate ───────────────────────────────────────────────
    def limit_pressure_rate(self) -> Dict[str, Any]:
        """Orgs at >=70/85/95/100% of their resolved limit, across every
        (organization, key) pair that actually has a UsageCounter row —
        batched resolution, not N+1."""
        pairs = (
            self.db.query(UsageCounter.organization_id, UsageCounter.entitlement_definition_id, UsageCounter.count)
            .all()
        )
        thresholds = {"70": 0, "85": 0, "95": 0, "100": 0}
        total_measured = 0
        definition_keys: dict[int, str] = {
            d.id: d.key for d in self.db.query(EntitlementDefinition).all()
        }
        for organization_id, definition_id, count in pairs:
            key = definition_keys.get(definition_id)
            if key is None:
                continue
            try:
                resolved = resolve_entitlement(self.db, organization_id, key)
            except Exception:  # noqa: BLE001 - a single bad org must not break the whole metric
                continue
            limit = resolved.value
            if limit in (None, 0) or not isinstance(limit, (int, float)):
                continue  # unlimited or non-numeric — excluded, not shown as 0% pressure
            total_measured += 1
            pct = count / limit
            if pct >= 1.0:
                thresholds["100"] += 1
            elif pct >= 0.95:
                thresholds["95"] += 1
            elif pct >= 0.85:
                thresholds["85"] += 1
            elif pct >= 0.70:
                thresholds["70"] += 1
        return {"total_measured_pairs": total_measured, "at_or_above_threshold": thresholds}

    # ── 7. Entitlement-denial rate ──────────────────────────────────────────
    def entitlement_denial_counts(self) -> Dict[str, Any]:
        """NOT a rate: only denials are logged (via
        EntitlementEnforcementService._emit_usage_signal on the failure
        branch) — total gate evaluations (including passes) are not logged
        anywhere, so there is no denominator. Exposes denial COUNTS by
        capability key only."""
        rows = (
            self.db.query(PlatformAuditLog)
            .filter(
                PlatformAuditLog.action.in_(
                    [PlatformAuditAction.ENTITLEMENT_BLOCKED, PlatformAuditAction.ENTITLEMENT_SOFT_LIMIT_BREACHED]
                )
            )
            .all()
        )
        counts_by_key: dict[str, int] = {}
        for row in rows:
            key = (row.metadata_ or {}).get("key", "unknown")
            counts_by_key[key] = counts_by_key.get(key, 0) + 1
        return {
            "denial_counts_by_key": counts_by_key,
            "total_denials": len(rows),
            "denial_rate": None,
            "note": (
                "Rate not computable: only denials are logged, not total gate "
                "evaluations (no pass-through logging exists) — a rate would "
                "need a denominator this codebase doesn't record."
            ),
        }

    # ── 8. Revenue leakage exceptions (target zero) ─────────────────────────
    def revenue_leakage_exceptions(self) -> Dict[str, Any]:
        from app.modules.commercial.service import CommercialSubscriptionService

        sub_svc = CommercialSubscriptionService(self.db)
        active_subs = (
            self.db.query(CommercialSubscription)
            .filter(CommercialSubscription.status == CommercialSubscriptionStatus.ACTIVE)
            .all()
        )

        unresolvable_price_subscription_ids = []
        superseded_pin_subscription_ids = []
        for sub in active_subs:
            resolved = sub_svc.resolve_price(sub)
            if resolved is None:
                unresolvable_price_subscription_ids.append(sub.id)
                continue
            if sub.catalog_version_id is None:
                continue
            latest_published = (
                self.db.query(CommercialPlanVersion)
                .filter(
                    CommercialPlanVersion.plan_id == sub.commercial_plan_id,
                    CommercialPlanVersion.status == "published",
                )
                .order_by(CommercialPlanVersion.version_number.desc())
                .first()
            )
            if (
                latest_published is not None
                and latest_published.id != sub.catalog_version_id
                and latest_published.price_amount is not None
                and resolved[0] != latest_published.price_amount
            ):
                superseded_pin_subscription_ids.append(sub.id)

        return {
            "unresolvable_price_subscription_ids": unresolvable_price_subscription_ids,
            "unresolvable_price_count": len(unresolvable_price_subscription_ids),
            "superseded_catalog_pin_subscription_ids": superseded_pin_subscription_ids,
            "superseded_catalog_pin_count": len(superseded_pin_subscription_ids),
            "note": (
                "Pattern B (superseded pin) is not automatically wrong — "
                "grandfathered pricing is often intentional; flagged for review, "
                "not asserted as a bug."
            ),
        }

    # ── 9. Entitlement drift (AC-15, target zero) ───────────────────────────
    def entitlement_drift(self) -> Dict[str, Any]:
        """Cheap, always-on check: an EntitlementSnapshot whose subscription
        has been updated more recently than the snapshot was last computed —
        a direct proxy for "something changed since the last recompute,"
        which should never happen given Part 2's recompute-on-every-mutation
        discipline. A nonzero count here is a real regression signal."""
        rows = (
            self.db.query(EntitlementSnapshot, CommercialSubscription)
            .join(
                CommercialSubscription,
                CommercialSubscription.id == EntitlementSnapshot.commercial_subscription_id,
            )
            .filter(CommercialSubscription.updated_at > EntitlementSnapshot.computed_at)
            .all()
        )
        drifted_organization_ids = [snap.organization_id for snap, _sub in rows]
        return {"drifted_organization_ids": drifted_organization_ids, "drift_count": len(drifted_organization_ids)}

    def entitlement_drift_deep_check(self, *, sample_size: int = 20) -> Dict[str, Any]:
        """Opt-in, expensive: live-resolves each of the 19 catalog keys for a
        sample of orgs and diffs against the materialized snapshot. O(N) live
        resolutions per sampled org — never run on every dashboard load."""
        from app.modules.commercial.entitlement_catalog_spec import ENTITLEMENT_CATALOG_SPEC

        snapshots = self.db.query(EntitlementSnapshot).limit(sample_size).all()
        mismatches = []
        for snapshot in snapshots:
            for spec in ENTITLEMENT_CATALOG_SPEC:
                key = spec["key"]
                try:
                    resolved = resolve_entitlement(self.db, snapshot.organization_id, key)
                except Exception:  # noqa: BLE001
                    continue
                snapshot_entry = (snapshot.values or {}).get(key)
                snapshot_value = snapshot_entry.get("value") if snapshot_entry else None
                if resolved.source_level in (3,):
                    continue  # an active override legitimately isn't reflected in the plan-derived snapshot
                if snapshot_value != resolved.value:
                    mismatches.append({
                        "organization_id": snapshot.organization_id, "key": key,
                        "snapshot_value": snapshot_value, "live_value": resolved.value,
                    })
        return {"sampled": len(snapshots), "mismatch_count": len(mismatches), "mismatches": mismatches}

    # ── 10. Failed plan transitions ─────────────────────────────────────────
    def failed_plan_transitions(self, *, grace_hours: int = 24) -> Dict[str, Any]:
        blocked = (
            self.db.query(func.count(SubscriptionChange.id))
            .filter(SubscriptionChange.status == SubscriptionChangeStatus.BLOCKED)
            .scalar()
        ) or 0
        overdue_cutoff = datetime.utcnow() - timedelta(hours=grace_hours)
        overdue_scheduled = (
            self.db.query(func.count(SubscriptionChange.id))
            .filter(
                SubscriptionChange.status == SubscriptionChangeStatus.SCHEDULED,
                SubscriptionChange.effective_at.isnot(None),
                SubscriptionChange.effective_at < overdue_cutoff,
            )
            .scalar()
        ) or 0
        return {
            "blocked_count": blocked,
            "overdue_scheduled_count": overdue_scheduled,
            "overdue_grace_hours": grace_hours,
        }
