"""
ZB-COM-ENT-001 Part 3 — plan-change orchestration tests (§6.1, §7, §8).

Handlers/services invoked directly (no HTTP layer), matching this repo's
established convention (see test_commercial_entitlements.py's docstring —
no TestClient precedent exists anywhere in tests/).

Covers:
  - The _OPEN_STATUSES fix (SCHEDULED_CHANGE must resolve as "open").
  - apply_plan_change()'s in-place mutation + AC-03 (snapshot_version bumps
    exactly once).
  - The 8-row compatibility checklist, including AC-04 (usage-billing
    contract blocks a downgrade).
  - AC-05 (scheduled downgrade -> reversed before effective_at).
  - AC-06 (row-count equality across a downgrade — nothing is deleted).
  - The scheduled job's due-query, per-row apply, and drift handling.
  - AC-14 (full audit chain: preview -> commit -> SubscriptionChange ->
    PlatformAuditLog -> EntitlementSnapshot).
"""
from datetime import datetime, timedelta

import pytest

from app.modules.commercial.enums import (
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
    CommercialSubscriptionStatus,
    SubscriptionChangeDirection,
    SubscriptionChangeStatus,
)
from app.modules.commercial.models import (
    CommercialOverride,
    CommercialSubscription,
    EntitlementSnapshot,
    SubscriptionChange,
)
from app.modules.commercial.plan_change_compatibility import run_compatibility_checks
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialPlanVersionService,
    CommercialSubscriptionService,
)
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from tests.conftest import make_customer, make_organization
from tests.test_commercial_entitlements import _catalog_definition, _plan, _plan_with_entitlement, _published_version
from app.modules.commercial.models import PlanEntitlement


def _plan_with_published_version(db, code, *, price_amount=None, max_users=None):
    plan = CommercialPlanService(db).create_plan(
        plan_code=code, plan_name=code.title(), max_users=max_users,
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db.flush()
    version = CommercialPlanVersionService(db).create_draft(
        plan, plan_name=plan.plan_name, price_amount=price_amount, currency="USD",
        billing_interval=CommercialBillingInterval.MONTHLY, actor_id=None,
    )
    version.status = CommercialPlanVersionStatus.PUBLISHED
    db.flush()
    return plan, version


def _two_plans_with_shared_entitlement(db, from_code, to_code, key, from_value, to_value, value_type=None):
    """_plan_with_entitlement (test_commercial_entitlements.py) creates a
    fresh EntitlementDefinition every call, which collides on the unique
    `key` column if called twice with the same key in one test — this
    creates the definition once and binds it to two separate plan versions,
    one per side of a from/to compatibility comparison."""
    from app.modules.commercial.enums import EntitlementValueType

    value_type = value_type or EntitlementValueType.BOOLEAN
    from_plan = _plan(db, from_code)
    to_plan = _plan(db, to_code)
    from_version = _published_version(db, from_plan)
    to_version = _published_version(db, to_plan)
    definition = _catalog_definition(db, key, value_type)
    db.add(PlanEntitlement(plan_version_id=from_version.id, entitlement_definition_id=definition.id, value=from_value))
    db.add(PlanEntitlement(plan_version_id=to_version.id, entitlement_definition_id=definition.id, value=to_value))
    db.flush()
    return from_plan, to_plan, definition


def _org_active_subscription(db, code, plan, *, period_end_days=15):
    org = make_organization(db, code=code, name=f"PlanChange {code}")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    sub = CommercialSubscriptionService(db).create_subscription(account.id, plan)
    CommercialSubscriptionService(db).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    sub.current_period_end = datetime.utcnow() + timedelta(days=period_end_days)
    db.commit()
    return org, account, sub


def test_open_statuses_includes_scheduled_change():
    assert CommercialSubscriptionStatus.SCHEDULED_CHANGE in CommercialSubscriptionService._OPEN_STATUSES


def test_apply_plan_change_mutates_in_place_and_bumps_snapshot_version_once(db_session):
    from_plan, _ = _plan_with_published_version(db_session, "APCFROM", price_amount=50)
    to_plan, _ = _plan_with_published_version(db_session, "APCTO", price_amount=100)
    org, account, sub = _org_active_subscription(db_session, "APCORG", from_plan)
    sub_id = sub.id

    snapshot_before = db_session.query(EntitlementSnapshot).filter(
        EntitlementSnapshot.organization_id == org.id
    ).first()
    version_before = snapshot_before.snapshot_version

    updated = CommercialSubscriptionService(db_session).apply_plan_change(
        sub, to_plan, actor_id=1, reason="upgrade test",
    )
    db_session.commit()

    assert updated.id == sub_id  # in-place: same subscription row, never replaced
    assert updated.commercial_plan_id == to_plan.id
    assert db_session.query(CommercialSubscription).filter(
        CommercialSubscription.commercial_account_id == account.id
    ).count() == 1  # no second subscription created

    snapshot_after = db_session.query(EntitlementSnapshot).filter(
        EntitlementSnapshot.organization_id == org.id
    ).first()
    assert snapshot_after.snapshot_version == version_before + 1  # AC-03: exactly once


def test_apply_plan_change_rejects_non_active_subscription(db_session):
    from_plan, _ = _plan_with_published_version(db_session, "APCNAFROM", price_amount=50)
    to_plan, _ = _plan_with_published_version(db_session, "APCNATO", price_amount=100)
    org, account, sub = _org_active_subscription(db_session, "APCNAORG", from_plan)
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.SUSPENDED)
    db_session.commit()

    with pytest.raises(ValueError):
        CommercialSubscriptionService(db_session).apply_plan_change(sub, to_plan, actor_id=1)


# ── Compatibility checklist ─────────────────────────────────────────────────


def test_compatibility_checklist_has_eight_rows_in_fixed_order(db_session):
    from_plan, _ = _plan_with_published_version(db_session, "CHKFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "CHKTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "CHKORG", from_plan)
    db_session.commit()

    results = run_compatibility_checks(db_session, org.id, sub, to_plan)
    assert [r.check_id for r in results] == [
        "internal_users_vs_max_users",
        "legal_entities_vs_org_entity_max",
        "currencies_vs_currency_enabled_max",
        "payment_providers_vs_payments_provider_max",
        "usage_billing_contracts_vs_billing_usage_metering",
        "dunning_rules_vs_collections_dunning",
        "api_write_and_webhooks_dependents",
        "sso_scim_dependency",
    ]
    assert results[6].severity == "not_applicable"
    assert results[7].severity == "not_applicable"


def test_compatibility_blocks_downgrade_with_active_usage_billing_contract(db_session):
    """AC-04: a downgrade with active usage-billed contracts is blocked
    until remediation."""
    from app.modules.billing.models import Contract, ContractItem, ContractStatus, Product, ProductType

    from_plan, to_plan, _def = _two_plans_with_shared_entitlement(
        db_session, "USGFROM", "USGTO", "billing.usage_metering", True, False,
    )
    org, account, sub = _org_active_subscription(db_session, "USGORGC", from_plan)
    customer = make_customer(db_session, org.id, code="USGCUST")
    product = Product(
        organization_id=org.id, name="Usage Product", code="USGPROD",
        product_type=ProductType.USAGE, currency="USD",
    )
    db_session.add(product)
    db_session.flush()
    contract = Contract(
        organization_id=org.id, customer_id=customer.id, contract_number="USG-C1",
        contract_name="Usage Contract", start_date=datetime.utcnow().date(),
        status=ContractStatus.ACTIVE, currency="USD",
    )
    db_session.add(contract)
    db_session.flush()
    item = ContractItem(
        organization_id=org.id, contract_id=contract.id, line_number=1, product_id=product.id,
        description="usage line", quantity=1, unit_price=10, total_amount=10,
    )
    db_session.add(item)
    db_session.commit()

    results = run_compatibility_checks(db_session, org.id, sub, to_plan)
    usage_check = next(r for r in results if r.check_id == "usage_billing_contracts_vs_billing_usage_metering")
    assert usage_check.severity == "blocker"
    assert usage_check.current_count == 1


def test_compatibility_override_prevents_false_blocker(db_session):
    """A live org-level CommercialOverride on the target key should prevent
    a false blocker even when the target plan's own base value would fail."""
    from app.modules.commercial.entitlement_override_service import CommercialOverrideService
    from app.modules.commercial.enums import CommercialOverrideStatus

    from app.modules.commercial.enums import EntitlementValueType

    from_plan, to_plan, to_def = _two_plans_with_shared_entitlement(
        db_session, "OVRFFROM", "OVRFTO", "org.entity.max", 100, 1, EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_active_subscription(db_session, "OVRFORG", from_plan)
    # 2 customers, which would exceed the target plan's base limit of 1.
    make_customer(db_session, org.id, code="OVRFC1")
    make_customer(db_session, org.id, code="OVRFC2")
    db_session.commit()

    override = CommercialOverride(
        organization_id=org.id, entitlement_definition_id=to_def.id,
        value=10, reason="test", status=CommercialOverrideStatus.APPROVED,
    )
    db_session.add(override)
    db_session.commit()

    results = run_compatibility_checks(db_session, org.id, sub, to_plan)
    entity_check = next(r for r in results if r.check_id == "legal_entities_vs_org_entity_max")
    assert entity_check.severity == "pass"
    assert entity_check.target_limit == 10


# ── Scheduling, reversal, row-count equality ────────────────────────────────


def test_scheduled_downgrade_sets_scheduled_change_and_can_be_reversed(db_session):
    """AC-05: a confirmed renewal-date downgrade can be reversed before the
    effective date."""
    from_plan, _ = _plan_with_published_version(db_session, "SCHFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "SCHTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "SCHORG", from_plan)
    db_session.commit()

    change = SubscriptionChange(
        commercial_subscription_id=sub.id,
        from_plan_id=from_plan.id, to_plan_id=to_plan.id,
        direction=SubscriptionChangeDirection.DOWNGRADE,
        status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=sub.current_period_end,
        requested_by_user_id=1,
    )
    db_session.add(change)
    db_session.flush()
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.SCHEDULED_CHANGE)
    db_session.commit()

    assert sub.status == CommercialSubscriptionStatus.SCHEDULED_CHANGE
    # Entitlements still resolve off the CURRENT plan while scheduled.
    assert sub.commercial_plan_id == from_plan.id

    CommercialSubscriptionService(db_session).reverse_scheduled_change(change, actor_id=1, reason="changed mind")
    db_session.commit()

    assert change.status == SubscriptionChangeStatus.REVERSED
    assert change.reversed_at is not None
    fresh_sub = db_session.query(CommercialSubscription).get(sub.id)
    assert fresh_sub.status == CommercialSubscriptionStatus.ACTIVE
    assert fresh_sub.commercial_plan_id == from_plan.id  # unchanged — nothing ever applied


def test_downgrade_row_count_equality(db_session):
    """AC-06: no downgrade deletes historical financial/config records —
    assert row-count equality, not just absence of errors."""
    from app.modules.billing.models import BillingCustomer, DunningLevel

    from_plan, _ = _plan_with_published_version(db_session, "CNTFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "CNTTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "CNTORG", from_plan)
    make_customer(db_session, org.id, code="CNTC1")
    db_session.add(DunningLevel(
        organization_id=org.id, level_number=1, name="L1", min_days_overdue=1,
        action_type="email_reminder", is_active=True,
    ))
    db_session.commit()

    def _counts():
        return (
            db_session.query(BillingCustomer).filter(BillingCustomer.organization_id == org.id).count(),
            db_session.query(DunningLevel).filter(DunningLevel.organization_id == org.id).count(),
        )

    before = _counts()

    # Schedule (default path) — no deletion expected.
    change = SubscriptionChange(
        commercial_subscription_id=sub.id, from_plan_id=from_plan.id, to_plan_id=to_plan.id,
        direction=SubscriptionChangeDirection.DOWNGRADE, status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=sub.current_period_end, requested_by_user_id=1,
    )
    db_session.add(change)
    db_session.flush()
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.SCHEDULED_CHANGE)
    db_session.commit()

    assert _counts() == before

    # Apply immediately (in-place) — still no deletion expected.
    CommercialSubscriptionService(db_session)._set_plan_fields(sub, to_plan)
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db_session.commit()

    assert _counts() == before


# ── Scheduled job ────────────────────────────────────────────────────────────


def test_scheduled_job_applies_due_change(db_session, monkeypatch):
    from app.modules.commercial.tasks import apply_scheduled_change

    monkeypatch.setattr("app.config.settings.ENABLE_SCHEDULED_PLAN_CHANGES", True)
    monkeypatch.setattr(apply_scheduled_change, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(db_session, "close", lambda: None)  # keep the test fixture session alive

    from_plan, _ = _plan_with_published_version(db_session, "JOBFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "JOBTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "JOBORG", from_plan, period_end_days=-1)  # already due

    change = SubscriptionChange(
        commercial_subscription_id=sub.id, from_plan_id=from_plan.id, to_plan_id=to_plan.id,
        direction=SubscriptionChangeDirection.DOWNGRADE, status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=sub.current_period_end, requested_by_user_id=1,
    )
    db_session.add(change)
    db_session.flush()
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.SCHEDULED_CHANGE)
    db_session.commit()

    summary = apply_scheduled_change.run_scheduled_plan_change_job()

    assert summary["applied"] == 1
    assert summary["errors"] == []
    fresh_change = db_session.query(SubscriptionChange).get(change.id)
    fresh_sub = db_session.query(CommercialSubscription).get(sub.id)
    assert fresh_change.status == SubscriptionChangeStatus.APPLIED
    assert fresh_sub.status == CommercialSubscriptionStatus.ACTIVE
    assert fresh_sub.commercial_plan_id == to_plan.id


def test_scheduled_job_skips_drifted_subscription(db_session, monkeypatch):
    from app.modules.commercial.tasks import apply_scheduled_change

    monkeypatch.setattr("app.config.settings.ENABLE_SCHEDULED_PLAN_CHANGES", True)
    monkeypatch.setattr(apply_scheduled_change, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(db_session, "close", lambda: None)

    from_plan, _ = _plan_with_published_version(db_session, "DRIFTFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "DRIFTTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "DRIFTORG", from_plan, period_end_days=-1)

    change = SubscriptionChange(
        commercial_subscription_id=sub.id, from_plan_id=from_plan.id, to_plan_id=to_plan.id,
        direction=SubscriptionChangeDirection.DOWNGRADE, status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=sub.current_period_end, requested_by_user_id=1,
    )
    db_session.add(change)
    db_session.commit()
    # Subscription never actually transitioned to SCHEDULED_CHANGE — simulates drift.

    summary = apply_scheduled_change.run_scheduled_plan_change_job()

    assert summary["applied"] == 0
    assert summary["skipped_subscription_not_scheduled"] == 1
    fresh_change = db_session.query(SubscriptionChange).get(change.id)
    assert fresh_change.status == SubscriptionChangeStatus.REVERSED


# ── AC-14: full audit chain ──────────────────────────────────────────────────


def test_upgrade_audit_chain_end_to_end(db_session):
    from_plan, _ = _plan_with_published_version(db_session, "CHAINFROM", price_amount=50)
    to_plan, _ = _plan_with_published_version(db_session, "CHAINTO", price_amount=100)
    org, account, sub = _org_active_subscription(db_session, "CHAINORG", from_plan)
    db_session.commit()

    snapshot_before = db_session.query(EntitlementSnapshot).filter(
        EntitlementSnapshot.organization_id == org.id
    ).first()
    computed_at_before = snapshot_before.computed_at

    CommercialSubscriptionService(db_session).apply_plan_change(sub, to_plan, actor_id=1, reason="upgrade")
    db_session.commit()

    audit_rows = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.entity_type == "CommercialSubscription",
            PlatformAuditLog.entity_id == sub.id,
            PlatformAuditLog.action == PlatformAuditAction.SUBSCRIPTION_PLAN_CHANGE_APPLIED,
        )
        .all()
    )
    assert len(audit_rows) == 1

    snapshot_after = db_session.query(EntitlementSnapshot).filter(
        EntitlementSnapshot.organization_id == org.id
    ).first()
    assert snapshot_after.computed_at > computed_at_before
    assert sub.commercial_plan_id == to_plan.id


def test_downgrade_audit_chain_end_to_end(db_session):
    from_plan, _ = _plan_with_published_version(db_session, "DCHAINFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "DCHAINTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "DCHAINORG", from_plan)
    db_session.commit()

    checklist = run_compatibility_checks(db_session, org.id, sub, to_plan)
    blockers = [r.__dict__ for r in checklist if r.severity == "blocker"]
    assert blockers == []

    change = SubscriptionChange(
        commercial_subscription_id=sub.id, from_plan_id=from_plan.id, to_plan_id=to_plan.id,
        direction=SubscriptionChangeDirection.DOWNGRADE, status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=sub.current_period_end, requested_by_user_id=1,
        blockers=blockers,
    )
    db_session.add(change)
    db_session.flush()
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.SCHEDULED_CHANGE)
    db_session.commit()

    # Simulate the scheduled job applying it (reuse the shared mutation path).
    CommercialSubscriptionService(db_session)._set_plan_fields(sub, to_plan)
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    change.status = SubscriptionChangeStatus.APPLIED
    change.applied_at = datetime.utcnow()
    db_session.commit()

    persisted = db_session.query(SubscriptionChange).get(change.id)
    assert persisted.status == SubscriptionChangeStatus.APPLIED
    assert persisted.blockers == []
    snapshot = db_session.query(EntitlementSnapshot).filter(
        EntitlementSnapshot.organization_id == org.id
    ).first()
    assert snapshot is not None
    assert sub.commercial_plan_id == to_plan.id


# ── Router-level tests (plain function calls, no HTTP layer — matches the
#    established convention: no TestClient precedent exists in this repo) ──


def _fake_billing_admin(organization_id, user_id=1):
    from types import SimpleNamespace

    return SimpleNamespace(organization_id=organization_id, id=user_id)


def test_router_preview_upgrade_skips_checklist(db_session):
    from app.modules.commercial.org_self_service_router import PlanChangePreviewRequest, preview_plan_change

    from_plan, _ = _plan_with_published_version(db_session, "RPUFROM", price_amount=50)
    to_plan, _ = _plan_with_published_version(db_session, "RPUTO", price_amount=100)
    org, account, sub = _org_active_subscription(db_session, "RPUORG", from_plan)
    db_session.commit()

    result = preview_plan_change(
        PlanChangePreviewRequest(target_plan_id=to_plan.id), db=db_session, current_user=_fake_billing_admin(org.id),
    )
    assert result["direction"] == "upgrade"
    assert result["checklist"] == []
    assert result["immediate_eligible"] is True


def test_router_commit_upgrade_applies_immediately(db_session):
    from app.modules.commercial.org_self_service_router import PlanChangeCommitRequest, commit_plan_change

    from_plan, _ = _plan_with_published_version(db_session, "RCUFROM", price_amount=50)
    to_plan, _ = _plan_with_published_version(db_session, "RCUTO", price_amount=100)
    org, account, sub = _org_active_subscription(db_session, "RCUORG", from_plan)
    db_session.commit()

    result = commit_plan_change(
        PlanChangeCommitRequest(target_plan_id=to_plan.id), db=db_session, current_user=_fake_billing_admin(org.id),
    )
    assert result["status"] == "applied"
    assert result["subscription_status"] == "active"
    fresh_sub = db_session.query(CommercialSubscription).get(sub.id)
    assert fresh_sub.commercial_plan_id == to_plan.id
    changes = db_session.query(SubscriptionChange).filter(SubscriptionChange.commercial_subscription_id == sub.id).all()
    assert len(changes) == 1
    assert changes[0].status == SubscriptionChangeStatus.APPLIED


def test_router_commit_downgrade_schedules_by_default(db_session):
    from app.modules.commercial.org_self_service_router import PlanChangeCommitRequest, commit_plan_change

    from_plan, _ = _plan_with_published_version(db_session, "RCDFROM", price_amount=100)
    to_plan, _ = _plan_with_published_version(db_session, "RCDTO", price_amount=50)
    org, account, sub = _org_active_subscription(db_session, "RCDORG", from_plan)
    db_session.commit()

    result = commit_plan_change(
        PlanChangeCommitRequest(target_plan_id=to_plan.id), db=db_session, current_user=_fake_billing_admin(org.id),
    )
    assert result["status"] == "scheduled"
    fresh_sub = db_session.query(CommercialSubscription).get(sub.id)
    assert fresh_sub.status == CommercialSubscriptionStatus.SCHEDULED_CHANGE
    assert fresh_sub.commercial_plan_id == from_plan.id  # unchanged until effective_at


def test_router_commit_immediate_downgrade_blocked_creates_investigable_row(db_session):
    from fastapi import HTTPException

    from app.modules.commercial.org_self_service_router import PlanChangeCommitRequest, commit_plan_change

    from_plan, to_plan, _def = _two_plans_with_shared_entitlement(
        db_session, "RCIFFROM", "RCIFTO", "billing.usage_metering", True, False,
    )
    org, account, sub = _org_active_subscription(db_session, "RCIFORG", from_plan)
    customer = make_customer(db_session, org.id, code="RCIFCUST")
    from app.modules.billing.models import Contract, ContractItem, ContractStatus, Product, ProductType

    product = Product(organization_id=org.id, name="Usage", code="RCIFPROD", product_type=ProductType.USAGE, currency="USD")
    db_session.add(product)
    db_session.flush()
    contract = Contract(
        organization_id=org.id, customer_id=customer.id, contract_number="RCIF-C1", contract_name="C",
        start_date=datetime.utcnow().date(), status=ContractStatus.ACTIVE, currency="USD",
    )
    db_session.add(contract)
    db_session.flush()
    db_session.add(ContractItem(
        organization_id=org.id, contract_id=contract.id, line_number=1, product_id=product.id,
        description="usage", quantity=1, unit_price=10, total_amount=10,
    ))
    db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        commit_plan_change(
            PlanChangeCommitRequest(target_plan_id=to_plan.id, confirm_immediate=True),
            db=db_session, current_user=_fake_billing_admin(org.id),
        )
    assert exc_info.value.status_code == 422
    change_id = exc_info.value.detail["subscription_change_id"]
    persisted = db_session.query(SubscriptionChange).get(change_id)
    assert persisted.status == SubscriptionChangeStatus.BLOCKED
    fresh_sub = db_session.query(CommercialSubscription).get(sub.id)
    assert fresh_sub.commercial_plan_id == from_plan.id  # nothing applied
