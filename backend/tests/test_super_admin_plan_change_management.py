"""
ZB-COM-ENT-001 Part 3 §16 — Super Admin management surface tests.

Covers the backend gaps Part 3 fills in (no service method previously
existed to edit a draft CommercialPlanVersion or its PlanEntitlement rows)
plus the new read/action endpoints for usage diagnostics, the plan-change
queue, and trial controls. Router functions called directly (no HTTP
layer), matching this repo's established test convention.
"""
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.modules.commercial.enums import (
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
    CommercialSubscriptionStatus,
    EntitlementValueType,
    SubscriptionChangeDirection,
    SubscriptionChangeStatus,
)
from app.modules.commercial.models import (
    CommercialSubscription,
    EntitlementDefinition,
    PlanEntitlement,
    SubscriptionChange,
    UsageCounter,
)
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialPlanVersionService,
    CommercialSubscriptionService,
)
from tests.conftest import make_organization
from tests.test_commercial_entitlements import _definition, _published_version


def _fake_super_admin(user_id=1):
    return SimpleNamespace(id=user_id)


def _draft_version(db, plan_code="MGMTPLAN"):
    plan = CommercialPlanService(db).create_plan(plan_code=plan_code, plan_name=plan_code.title())
    version = CommercialPlanVersionService(db).create_draft(plan, plan_name=plan.plan_name, actor_id=None)
    db.commit()
    return plan, version


# ── Draft-version editing ───────────────────────────────────────────────────


def test_update_draft_rejects_non_draft_version(db_session):
    plan, version = _draft_version(db_session, "UDPLAN")
    version.status = CommercialPlanVersionStatus.PUBLISHED
    db_session.commit()

    with pytest.raises(ValueError):
        CommercialPlanVersionService(db_session).update_draft(version, plan_name="New Name")


def test_update_draft_edits_fields(db_session):
    plan, version = _draft_version(db_session, "UDPLAN2")

    updated = CommercialPlanVersionService(db_session).update_draft(
        version, actor_id=1, plan_name="Renamed", price_amount=42,
    )
    db_session.commit()
    assert updated.plan_name == "Renamed"
    assert updated.price_amount == 42


def test_update_draft_rejects_unknown_field(db_session):
    plan, version = _draft_version(db_session, "UDPLAN3")
    with pytest.raises(ValueError):
        CommercialPlanVersionService(db_session).update_draft(version, status="published")


def test_set_plan_entitlement_upserts_and_rejects_non_draft(db_session):
    plan, version = _draft_version(db_session, "SPEPLAN")
    definition = _definition(db_session, "billing.invoice.create", EntitlementValueType.BOOLEAN)
    db_session.commit()

    row = CommercialPlanVersionService(db_session).set_plan_entitlement(
        version, definition.id, True, actor_id=1,
    )
    db_session.commit()
    assert row.value is True

    # Upsert: calling again updates the SAME row, doesn't duplicate.
    row2 = CommercialPlanVersionService(db_session).set_plan_entitlement(
        version, definition.id, False, actor_id=1,
    )
    db_session.commit()
    assert row2.id == row.id
    assert row2.value is False
    assert db_session.query(PlanEntitlement).filter(
        PlanEntitlement.plan_version_id == version.id
    ).count() == 1

    version.status = CommercialPlanVersionStatus.PUBLISHED
    db_session.commit()
    with pytest.raises(ValueError):
        CommercialPlanVersionService(db_session).set_plan_entitlement(version, definition.id, True)


def test_router_update_and_set_entitlement_endpoints(db_session):
    from app.modules.super_admin.router import (
        set_commercial_plan_version_entitlement,
        update_commercial_plan_version,
    )
    from app.modules.commercial.schemas import CommercialPlanVersionUpdate, PlanEntitlementSet

    plan, version = _draft_version(db_session, "ROUTERPLAN")
    definition = _definition(db_session, "billing.invoice.create", EntitlementValueType.BOOLEAN)
    db_session.commit()

    result = update_commercial_plan_version(
        version.id, CommercialPlanVersionUpdate(plan_name="Router Renamed"),
        current_user=_fake_super_admin(), db=db_session,
    )
    assert result.plan_name == "Router Renamed"

    ent_result = set_commercial_plan_version_entitlement(
        version.id, definition.id, PlanEntitlementSet(value=True),
        current_user=_fake_super_admin(), db=db_session,
    )
    assert ent_result.value is True
    assert ent_result.key == "billing.invoice.create"


# ── Usage diagnostics ────────────────────────────────────────────────────────


def test_router_list_usage_counters(db_session):
    from app.modules.super_admin.router import list_commercial_usage_counters

    org = make_organization(db_session, code="USGDIAG", name="Usage Diag Org")
    definition = _definition(db_session, "api.requests_per_day", EntitlementValueType.INTEGER)
    db_session.commit()

    counter = UsageCounter(
        organization_id=org.id, entitlement_definition_id=definition.id, window_key="2026-08", count=42,
    )
    db_session.add(counter)
    db_session.commit()

    result = list_commercial_usage_counters(
        organization_id=org.id, entitlement_key="", current_user=_fake_super_admin(), db=db_session,
    )
    assert result.total == 1
    assert result.counters[0].entitlement_key == "api.requests_per_day"
    assert result.counters[0].count == 42


# ── Plan-change queue ────────────────────────────────────────────────────────


def test_router_subscription_change_queue_list_and_reverse(db_session):
    from app.modules.super_admin.router import (
        list_commercial_subscription_changes,
        reverse_commercial_subscription_change,
    )
    from app.modules.commercial.schemas import SubscriptionChangeReverseRequest

    from_plan = CommercialPlanService(db_session).create_plan(plan_code="QFROM", plan_name="Q From")
    to_plan = CommercialPlanService(db_session).create_plan(plan_code="QTO", plan_name="Q To")
    from_plan.status = CommercialPlanStatus.ACTIVE
    db_session.commit()

    org = make_organization(db_session, code="QUEUEORG", name="Queue Org")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    sub = CommercialSubscriptionService(db_session).create_subscription(account.id, from_plan)
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    sub.current_period_end = datetime.utcnow() + timedelta(days=10)
    db_session.commit()

    change = SubscriptionChange(
        commercial_subscription_id=sub.id, from_plan_id=from_plan.id, to_plan_id=to_plan.id,
        direction=SubscriptionChangeDirection.DOWNGRADE, status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=sub.current_period_end, requested_by_user_id=1,
    )
    db_session.add(change)
    db_session.flush()
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.SCHEDULED_CHANGE)
    db_session.commit()

    listing = list_commercial_subscription_changes(
        status="scheduled", skip=0, limit=50, current_user=_fake_super_admin(), db=db_session,
    )
    assert listing.total == 1
    assert listing.changes[0].to_plan_code == "QTO"

    reversed_change = reverse_commercial_subscription_change(
        change.id, SubscriptionChangeReverseRequest(reason="ops decision"),
        current_user=_fake_super_admin(), db=db_session,
    )
    assert reversed_change.status == "reversed"


# ── Trial controls ───────────────────────────────────────────────────────────


def test_router_trial_status_reports_eligibility_and_state(db_session):
    from app.modules.super_admin.router import get_commercial_account_trial_status

    plan = CommercialPlanService(db_session).create_plan(plan_code="TRIALMGMT", plan_name="Trial Mgmt")
    plan.status = CommercialPlanStatus.ACTIVE
    db_session.commit()

    org = make_organization(db_session, code="TRIALORG2", name="Trial Org 2")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    sub = CommercialSubscriptionService(db_session).create_subscription(account.id, plan)
    sub.trial_ends_at = datetime.utcnow() + timedelta(days=7)
    sub.recovery_ends_at = sub.trial_ends_at + timedelta(days=14)
    db_session.commit()

    status = get_commercial_account_trial_status(org.id, current_user=_fake_super_admin(), db=db_session)
    assert status.organization_id == org.id
    assert status.trial_ends_at is not None
    assert status.is_trial_eligible is False  # already has a trial recorded
