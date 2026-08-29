"""
ZB-COM-ENT-001 Part 3 §18 — commercial analytics tests.

Primary focus is AC-15 (entitlement-drift analytic queryable, returns zero
for freshly-recomputed fixtures, and actually detects drift when a snapshot
is deliberately left stale — proving the query works, not just that it
always returns zero). A handful of sanity checks cover the other metrics'
basic shape.
"""
from datetime import datetime, timedelta

from app.modules.commercial.analytics_service import CommercialEntitlementAnalyticsService
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import EntitlementSnapshot
from app.modules.commercial.service import CommercialAccountService, CommercialSubscriptionService
from tests.conftest import make_organization
from tests.test_commercial_entitlements import _plan


def _org_active_subscription(db, code, plan):
    org = make_organization(db, code=code, name=f"Analytics {code}")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    sub = CommercialSubscriptionService(db).create_subscription(account.id, plan)
    CommercialSubscriptionService(db).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db.commit()
    return org, account, sub


def test_entitlement_drift_is_zero_on_fresh_fixtures(db_session):
    """AC-15: the analytic returns zero for all live subscriptions when
    every snapshot is up to date."""
    plan = _plan(db_session, "DRIFTAPLAN")
    org, account, sub = _org_active_subscription(db_session, "DRIFTAORG", plan)

    result = CommercialEntitlementAnalyticsService(db_session).entitlement_drift()
    assert result["drift_count"] == 0
    assert org.id not in result["drifted_organization_ids"]


def test_entitlement_drift_detects_stale_snapshot(db_session):
    """The query must actually detect drift, not just always return zero —
    deliberately backdate a snapshot's computed_at behind the subscription's
    updated_at and confirm it's flagged."""
    plan = _plan(db_session, "DRIFTBPLAN")
    org, account, sub = _org_active_subscription(db_session, "DRIFTBORG", plan)

    snapshot = db_session.query(EntitlementSnapshot).filter(
        EntitlementSnapshot.organization_id == org.id
    ).first()
    snapshot.computed_at = datetime.utcnow() - timedelta(days=1)
    db_session.commit()
    # Force subscription.updated_at forward without a real recompute, to
    # simulate "something changed and the snapshot didn't catch it".
    sub.updated_at = datetime.utcnow()
    db_session.commit()

    result = CommercialEntitlementAnalyticsService(db_session).entitlement_drift()
    assert result["drift_count"] == 1
    assert org.id in result["drifted_organization_ids"]


def test_entitlement_drift_deep_check_runs_without_error(db_session):
    plan = _plan(db_session, "DRIFTCPLAN")
    org, account, sub = _org_active_subscription(db_session, "DRIFTCORG", plan)

    result = CommercialEntitlementAnalyticsService(db_session).entitlement_drift_deep_check(sample_size=5)
    assert result["sampled"] >= 1
    assert "mismatch_count" in result


def test_trial_activation_rate_shape(db_session):
    plan = _plan(db_session, "TARPLAN")
    org, account, sub = _org_active_subscription(db_session, "TARORG", plan)

    result = CommercialEntitlementAnalyticsService(db_session).trial_activation_rate()
    assert result["eligible_accounts"] >= 1
    assert result["activated_trials"] >= 0


def test_upgrade_conversion_rate_omits_fabricated_ratio(db_session):
    result = CommercialEntitlementAnalyticsService(db_session).upgrade_conversion_rate()
    assert result["conversion_rate"] is None
    assert "note" in result
    assert result["applied_upgrades"] == 0


def test_entitlement_denial_counts_omits_fabricated_rate(db_session):
    result = CommercialEntitlementAnalyticsService(db_session).entitlement_denial_counts()
    assert result["denial_rate"] is None
    assert result["denial_counts_by_key"] == {}


def test_failed_plan_transitions_shape(db_session):
    result = CommercialEntitlementAnalyticsService(db_session).failed_plan_transitions()
    assert result["blocked_count"] == 0
    assert result["overdue_scheduled_count"] == 0


def test_revenue_leakage_shape(db_session):
    plan = _plan(db_session, "RLPLAN")
    org, account, sub = _org_active_subscription(db_session, "RLORG", plan)

    result = CommercialEntitlementAnalyticsService(db_session).revenue_leakage_exceptions()
    # No price on this plan -> resolve_price() returns None -> flagged.
    assert sub.id in result["unresolvable_price_subscription_ids"]
