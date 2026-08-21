"""
Regression tests for ZB-COM-BILL-001 N1: the Plane-1 (Zoiko's own
subscription) failed-payment schedule — day 0 past-due, day 10 restrict
expansion, day 20 suspend, day 45 terminate — and N3, the payment-succeeds
restoration path back to ACTIVE.

Entirely independent of Plane-2's tenant-facing dunning (N4) — see the
import-boundary assertion at the bottom of this file.
"""
from datetime import datetime, timedelta

from app.modules.commercial.dunning_service import CommercialDunningService
from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialPlan, CommercialSubscription
from app.modules.commercial.service import CommercialAccountService
from tests.conftest import make_organization


def _standalone_org(db, code):
    org = make_organization(db, code=code)
    org.billing_classification = BillingClassification.COMMERCIAL_STANDALONE
    org.billing_source = BillingSource.REGISTERED_VIA_STANDALONE
    db.flush()
    return org


def _plan(db, code):
    plan = CommercialPlan(plan_code=code, plan_name="Test Plan", status=CommercialPlanStatus.ACTIVE)
    db.add(plan)
    db.flush()
    return plan


def _subscription(db, account_id, plan_id, days_past_due):
    sub = CommercialSubscription(
        commercial_account_id=account_id,
        commercial_plan_id=plan_id,
        status=CommercialSubscriptionStatus.ACTIVE,
        payment_failed_at=datetime.utcnow() - timedelta(days=days_past_due),
    )
    db.add(sub)
    db.flush()
    return sub


def test_sweep_advances_through_past_due_restricted_suspended_terminated(db_session):
    org = _standalone_org(db_session, "DUN1")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    plan = _plan(db_session, "PLAN-DUN1")

    day0 = _subscription(db_session, account.id, plan.id, 0)
    day10 = _subscription(db_session, account.id, plan.id, 10)
    day20 = _subscription(db_session, account.id, plan.id, 20)
    day45 = _subscription(db_session, account.id, plan.id, 45)
    db_session.commit()

    CommercialDunningService(db_session).sweep(db_session)
    db_session.commit()

    db_session.refresh(day0)
    db_session.refresh(day10)
    db_session.refresh(day20)
    db_session.refresh(day45)

    assert day0.status == CommercialSubscriptionStatus.PAST_DUE
    assert day10.status == CommercialSubscriptionStatus.RESTRICTED
    assert day20.status == CommercialSubscriptionStatus.SUSPENDED
    assert day45.status == CommercialSubscriptionStatus.CANCELLED

    # N2: never a hard delete — every row still exists with its financial
    # history intact.
    for sub in (day0, day10, day20, day45):
        assert db_session.query(CommercialSubscription).filter_by(id=sub.id).first() is not None


def test_restore_clears_payment_failed_at_and_reactivates(db_session):
    org = _standalone_org(db_session, "DUN2")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    plan = _plan(db_session, "PLAN-DUN2")
    sub = _subscription(db_session, account.id, plan.id, 15)
    sub.status = CommercialSubscriptionStatus.RESTRICTED
    db_session.commit()

    CommercialDunningService(db_session).restore(sub)
    db_session.commit()
    db_session.refresh(sub)

    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    assert sub.payment_failed_at is None


def test_no_cross_import_from_plane_2_dunning_or_payment_service():
    """N4: no code path may let a tenant's (Plane-2) payment failure change a
    CommercialSubscription status."""
    import app.modules.commercial.dunning_service as mod
    import inspect

    source = inspect.getsource(mod)
    assert "billing.services.dunning_service" not in source
    assert "billing.services.payment_service" not in source
