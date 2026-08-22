"""
PHASE 3F tests — Plane 1 SaaS administration.

Covers:
  F5  plan change (supersede-with-history, audited, charging guards)
  F10 honest SaaS reporting read model (counts + MRR honesty rules)

Handlers/dependencies are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import BillingAuditLog
from app.modules.commercial.enums import (
    BillingSource,
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialPlanVersion, CommercialSubscription
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialPlanVersionService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.super_admin.router import (
    change_commercial_subscription_plan,
    create_commercial_subscription,
    get_saas_commercial_reporting,
)
from app.modules.super_admin.saas_reporting_service import SaasReportingService

from tests.test_commercial_subscription_management import (
    _CreateSchema,
    _org_with_plan,
    _sa_user,
)


class _PlanChangeSchema:
    def __init__(self, new_plan_id, reason="Consolidating seats onto the growth tier"):
        self.new_plan_id = new_plan_id
        self.reason = reason


def _publish_version(db, plan, *, currency="USD", amount=None, interval=None):
    """Draft -> submit -> approve -> publish (maker != checker)."""
    version_service = CommercialPlanVersionService(db)
    version = version_service.create_draft(
        plan,
        plan_name=plan.plan_name or "Plan",
        billing_interval=interval or CommercialBillingInterval.MONTHLY,
        currency=currency,
        price_amount=amount,
        actor_id=1,
    )
    submitted, _request = version_service.submit_for_approval(
        version, requested_by_user_id=1, reason="Phase 3F test publication"
    )
    version_service.approve_and_publish(submitted, approver_user_id=2)
    return submitted


# ═══════════════════════════════════════════════════════════════════════════
# F5 — plan change service semantics
# ═══════════════════════════════════════════════════════════════════════════


def _open_sub(db, org, plan):
    return create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db,
    )


def test_change_plan_supersedes_active_subscription_preserving_history(db_session):
    org, old_plan, account = _org_with_plan(db_session, "F5A", "F5AOLD")
    sub = _open_sub(db_session, org, old_plan)
    # Activate the original through the state machine.
    svc = CommercialSubscriptionService(db_session)
    svc.transition(
        db_session.query(CommercialSubscription).get(sub.id),
        CommercialSubscriptionStatus.ACTIVE,
    )

    _, new_plan, _ = _org_with_plan(db_session, "F5B", "F5BNEW")
    replacement = svc.change_plan(
        db_session.query(CommercialSubscription).get(sub.id),
        new_plan,
        actor_id=_sa_user().id,
        reason="Upgrade to the larger tier",
    )

    assert replacement.status == CommercialSubscriptionStatus.ACTIVE
    assert replacement.commercial_plan_id == new_plan.id
    assert replacement.id != sub.id
    # History preserved: exactly one CANCELLED row + one ACTIVE replacement.
    rows = db_session.query(CommercialSubscription).order_by(CommercialSubscription.id).all()
    assert [r.status for r in rows] == [
        CommercialSubscriptionStatus.CANCELLED,
        CommercialSubscriptionStatus.ACTIVE,
    ]
    cancelled = rows[0]
    assert cancelled.commercial_plan_id == old_plan.id


def test_change_plan_from_pending_keeps_replacement_pending(db_session):
    org, old_plan, _ = _org_with_plan(db_session, "F5C", "F5COLD")
    sub = _open_sub(db_session, org, old_plan)
    _, new_plan, _ = _org_with_plan(db_session, "F5D", "F5DNEW")

    replacement = CommercialSubscriptionService(db_session).change_plan(
        db_session.query(CommercialSubscription).get(sub.id),
        new_plan,
        actor_id=9,
        reason="Pre-activation tier switch",
    )
    assert replacement.status == CommercialSubscriptionStatus.PENDING


def test_change_plan_same_target_is_a_no_op_error(db_session):
    org, plan, _ = _org_with_plan(db_session, "F5E", "F5EPLAN")
    sub = _open_sub(db_session, org, plan)
    with pytest.raises(ValueError, match="nothing to change"):
        CommercialSubscriptionService(db_session).change_plan(
            db_session.query(CommercialSubscription).get(sub.id),
            plan,
            actor_id=9,
            reason="Same plan again",
        )


def test_change_plan_to_archived_plan_rejected(db_session):
    org, plan, _ = _org_with_plan(db_session, "F5F", "F5FPLAN")
    sub = _open_sub(db_session, org, plan)
    _, target, _ = _org_with_plan(db_session, "F5G", "F5GARCH")
    target.status = CommercialPlanStatus.ARCHIVED
    db_session.flush()

    with pytest.raises(ValueError, match="archived"):
        CommercialSubscriptionService(db_session).change_plan(
            db_session.query(CommercialSubscription).get(sub.id),
            target,
            actor_id=9,
            reason="Trying an archived plan",
        )


def test_change_plan_on_terminal_subscription_rejected(db_session):
    org, plan, _ = _org_with_plan(db_session, "F5H", "F5HPLAN")
    created = _open_sub(db_session, org, plan)
    row = db_session.query(CommercialSubscription).get(created.id)
    CommercialSubscriptionService(db_session).transition(row, CommercialSubscriptionStatus.CANCELLED)

    _, other, _ = _org_with_plan(db_session, "F5I", "F5IPLAN")
    with pytest.raises(ValueError, match="terminal"):
        CommercialSubscriptionService(db_session).change_plan(
            db_session.query(CommercialSubscription).get(created.id),
            other,
            actor_id=9,
            reason="Too late",
        )


def test_change_plan_requires_reason(db_session):
    org, plan, _ = _org_with_plan(db_session, "F5J", "F5JPLAN")
    sub = _open_sub(db_session, org, plan)
    _, other, _ = _org_with_plan(db_session, "F5K", "F5KPLAN")
    with pytest.raises(ValueError, match="[Rr]eason"):
        CommercialSubscriptionService(db_session).change_plan(
            db_session.query(CommercialSubscription).get(sub.id),
            other,
            actor_id=9,
            reason="   ",
        )


def test_change_plan_active_to_inactive_plan_fails_fast_before_mutation(db_session):
    """An ACTIVE subscription cannot move to a non-ACTIVE plan; the guard
    fires before any mutation, so no CANCELLED row appears."""
    org, plan, _ = _org_with_plan(db_session, "F5L", "F5LPLAN")
    created = _open_sub(db_session, org, plan)
    row = db_session.query(CommercialSubscription).get(created.id)
    CommercialSubscriptionService(db_session).transition(row, CommercialSubscriptionStatus.ACTIVE)

    _, target, _ = _org_with_plan(db_session, "F5M", "F5MPLAN")
    target.status = CommercialPlanStatus.INACTIVE
    db_session.flush()

    with pytest.raises(ValueError, match="only ACTIVE plans"):
        CommercialSubscriptionService(db_session).change_plan(
            row, target, actor_id=9, reason="Downgrade attempt"
        )

    still_open = (
        db_session.query(CommercialSubscription)
        .filter(CommercialSubscription.id == created.id)
        .one()
    )
    assert still_open.status == CommercialSubscriptionStatus.ACTIVE


def test_change_plan_endpoint_writes_both_audit_trails(db_session):
    org, old_plan, account = _org_with_plan(db_session, "F5N", "F5NOLD")
    created = _open_sub(db_session, org, old_plan)
    row = db_session.query(CommercialSubscription).get(created.id)
    CommercialSubscriptionService(db_session).transition(row, CommercialSubscriptionStatus.ACTIVE)

    _, new_plan, _ = _org_with_plan(db_session, "F5O", "F5ONEW")
    payload = change_commercial_subscription_plan(
        subscription_id=created.id,
        data=_PlanChangeSchema(new_plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    assert payload.commercial_plan_id == new_plan.id
    assert payload.organization_id == org.id

    plan_change_rows = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.entity_type == "CommercialSubscription",
            PlatformAuditLog.correlation_id.like("pc-%"),
        )
        .all()
    )
    assert len(plan_change_rows) == 1
    entry = plan_change_rows[0]
    assert entry.action == PlatformAuditAction.UPDATE
    assert entry.reason == "Consolidating seats onto the growth tier"
    assert entry.new_values["change"] == "plan_change"
    assert entry.old_values["commercial_plan_id"] == old_plan.id

    # The org-scoped trail must reference the replacement subscription.
    org_rows = (
        db_session.query(BillingAuditLog)
        .filter_by(organization_id=org.id, entity_type="CommercialSubscription")
        .all()
    )
    assert any(r.entity_id == payload.id for r in org_rows)


def test_change_plan_unknown_subscription_or_plan_404(db_session):
    org, plan, _ = _org_with_plan(db_session, "F5P", "F5PPLAN")
    created = _open_sub(db_session, org, plan)
    with pytest.raises(NotFoundException):
        change_commercial_subscription_plan(
            subscription_id=999999,
            data=_PlanChangeSchema(plan.id),
            current_user=_sa_user(),
            db=db_session,
        )
    with pytest.raises(NotFoundException):
        change_commercial_subscription_plan(
            subscription_id=created.id,
            data=_PlanChangeSchema(999999),
            current_user=_sa_user(),
            db=db_session,
        )


# ═══════════════════════════════════════════════════════════════════════════
# F10 — honest SaaS reporting read model
# ═══════════════════════════════════════════════════════════════════════════


def test_reporting_empty_database_reports_unknown_mrr(db_session):
    report = SaasReportingService(db_session).get_reporting()
    assert report["plane"] == "PLATFORM"
    assert report["accounts"]["total"] == 0
    assert report["subscriptions"]["total_open"] == 0
    assert report["mrr"]["state"] == "unknown"
    assert report["mrr"]["amount"] is None
    assert report["mrr"]["coverage"]["open_subscriptions_total"] == 0
    assert any("REC-01" in note for note in report["honesty_notes"])


def test_reporting_counts_are_real_rows(db_session):
    org, plan, _ = _org_with_plan(db_session, "F10A", "F10APLAN")
    created = _open_sub(db_session, org, plan)
    report = SaasReportingService(db_session).get_reporting()
    assert report["accounts"]["total"] >= 1
    assert report["subscriptions"]["total_open"] >= 1
    by_code = {i["plan_code"]: i["open_subscriptions"] for i in report["subscriptions"]["open_by_plan"]}
    assert by_code.get("F10APLAN") == 1
    # The PENDING status is a real row in the all-time distribution.
    assert report["subscriptions"]["by_status"].get("pending", 0) >= 1


def test_reporting_mrr_computed_only_from_priced_published_versions(db_session):
    org, plan, _ = _org_with_plan(db_session, "F10B", "F10BPLAN")
    created = _open_sub(db_session, org, plan)

    # Unpriced published version first: auto-derived catalog_version points at
    # a version WITHOUT a price → must NOT contribute.
    unpriced = _publish_version(db_session, plan, amount=None)
    row = db_session.query(CommercialSubscription).get(created.id)
    row.catalog_version_id = unpriced.id
    db_session.flush()

    report = SaasReportingService(db_session).get_reporting()
    assert report["mrr"]["state"] == "unknown"

    # Now attach a priced monthly version.
    priced = _publish_version(db_session, plan, amount=Decimal("50.00"))
    row.catalog_version_id = priced.id
    db_session.flush()

    report = SaasReportingService(db_session).get_reporting()
    assert report["mrr"]["state"] == "computed"
    assert report["mrr"]["amount"] == Decimal("50.00")
    coverage = report["mrr"]["coverage"]
    assert coverage["open_subscriptions_total"] == coverage["open_subscriptions_priced"]
    assert coverage["plans_with_published_price"] >= 1


def test_reporting_mrr_normalizes_annual_prices_monthly(db_session):
    org, plan, _ = _org_with_plan(db_session, "F10C", "F10CPLAN")
    created = _open_sub(db_session, org, plan)
    annual = _publish_version(
        db_session,
        plan,
        amount=Decimal("1200.00"),
        interval=CommercialBillingInterval.ANNUAL,
    )
    row = db_session.query(CommercialSubscription).get(created.id)
    row.catalog_version_id = annual.id
    db_session.flush()

    report = SaasReportingService(db_session).get_reporting()
    assert report["mrr"]["state"] == "computed"
    assert report["mrr"]["amount"] == Decimal("100.00")


def test_reporting_multi_currency_never_fabricates_single_total(db_session):
    org_a, plan_a, _ = _org_with_plan(db_session, "F10D", "F10DPLAN")
    sub_a = _open_sub(db_session, org_a, plan_a)
    ver_usd = _publish_version(db_session, plan_a, currency="USD", amount=Decimal("40.00"))
    db_session.query(CommercialSubscription).get(sub_a.id).catalog_version_id = ver_usd.id

    org_b, plan_b, _ = _org_with_plan(db_session, "F10E", "F10EPLAN")
    sub_b = _open_sub(db_session, org_b, plan_b)
    ver_eur = _publish_version(db_session, plan_b, currency="EUR", amount=Decimal("30.00"))
    db_session.query(CommercialSubscription).get(sub_b.id).catalog_version_id = ver_eur.id
    db_session.flush()

    report = SaasReportingService(db_session).get_reporting()
    assert report["mrr"]["state"] == "multi_currency"
    assert report["mrr"]["amount"] is None
    currencies = {c["currency"]: c for c in report["mrr"]["currencies"]}
    assert currencies["USD"]["monthly_amount"] == Decimal("40.00")
    assert currencies["EUR"]["monthly_amount"] == Decimal("30.00")


def test_reporting_router_endpoint_returns_response_shape(db_session):
    from app.modules.super_admin.schemas import SaasReportingResponse

    raw = get_saas_commercial_reporting(current_user=_sa_user(), db=db_session)
    payload = SaasReportingResponse.model_validate(raw)  # response_model parity
    assert payload.plane == "PLATFORM"
    assert payload.mrr.state in {"computed", "unknown", "multi_currency"}
    assert payload.subscriptions.total_open == sum(
        i.open_subscriptions for i in payload.subscriptions.open_by_plan
    )
