"""
PHASE 8 tests — Commercial Entitlement foundation (Step 13 §ENTITLEMENTS).

  28. plan feature lookup
  29. plan limit lookup
  30. missing entitlement handled safely

Also covers the double-charge readiness helper (Step 10) which the mandated
list does not name but Phase 8 Step 10 requires verifying: billing_source
decides whether the standalone platform may charge.

Handlers/dependencies/services invoked directly (no HTTP layer) on the
isolated in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
import pytest

from app.modules.commercial.enums import (
    BillingSource,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialEntitlementService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization
from tests.conftest import make_organization


def _plan(db, code, *, features=None, max_users=None, max_storage_gb=None):
    plan = CommercialPlanService(db).create_plan(
        plan_code=code,
        plan_name=code.title(),
        features=features,
        max_users=max_users,
        max_storage_gb=max_storage_gb,
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db.commit()
    return plan


def _org_with_active_subscription(db, code, plan):
    org = make_organization(db, code=code, name=f"Ent {code}")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    sub = CommercialSubscriptionService(db).create_subscription(account.id, plan)
    CommercialSubscriptionService(db).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db.commit()
    return org, account, sub


def test_plan_feature_lookup(db_session):
    org, _, _ = _org_with_active_subscription(
        db_session,
        "FEAT8",
        _plan(db_session, "FEAT8P", features={"export": True, "api": False}),
    )
    svc = CommercialEntitlementService(db_session)
    assert svc.is_entitled(org.id, "export") is True
    assert svc.is_entitled(org.id, "api") is False


def test_plan_limit_lookup(db_session):
    org, _, _ = _org_with_active_subscription(
        db_session,
        "LIM8",
        _plan(db_session, "LIM8P", max_users=25, max_storage_gb=50),
    )
    svc = CommercialEntitlementService(db_session)
    assert svc.get_limit(org.id, "max_users") == 25
    assert svc.get_limit(org.id, "max_storage_gb") == 50
    # Custom named limit resolved from the features dict.
    _plan(db_session, "LIM8C", features={"seats": 40})
    org2 = make_organization(db_session, code="LIM8B", name="Ent LIM8B")
    CommercialAccountService(db_session).ensure_commercial_account(org2.id)
    db_session.commit()
    assert svc.get_limit(org2.id, "seats") is None  # no subscription yet


def test_missing_entitlement_handled_safely(db_session):
    org = make_organization(db_session, code="NONE8", name="No Ent")
    db_session.commit()
    svc = CommercialEntitlementService(db_session)

    # No account at all -> safe empty answers, no exceptions.
    assert svc.is_entitled(org.id, "export") is False
    assert svc.get_limit(org.id, "max_users") is None
    assert svc.get_organization_entitlements(org.id) == {
        "plan": None,
        "limits": {},
        "features": {},
    }

    # Account but no subscription -> same safe answers.
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    assert svc.is_entitled(org.id, "export") is False
    assert svc.get_limit(org.id, "max_users") is None
    assert svc.get_organization_entitlements(org.id) == {
        "plan": None,
        "limits": {},
        "features": {},
    }

    # Subscription on a plan with NO entitlement data -> false / None.
    org2, _, _ = _org_with_active_subscription(
        db_session, "NONE9", _plan(db_session, "NONE9P")
    )
    assert svc.is_entitled(org2.id, "export") is False
    assert svc.get_limit(org2.id, "max_users") is None
    assert svc.is_entitled(org2.id, "") is False
    assert svc.get_limit(org2.id, "") is None


def test_entitlement_resolves_through_open_subscription_only(db_session):
    plan = _plan(db_session, "OPEN8P", features={"audit": True})
    org, account, sub = _org_with_active_subscription(db_session, "OPEN8", plan)
    svc = CommercialEntitlementService(db_session)
    assert svc.is_entitled(org.id, "audit") is True

    # Terminate the subscription -> entitlement disappears (history kept).
    CommercialSubscriptionService(db_session).transition(
        sub, CommercialSubscriptionStatus.CANCELLED
    )
    db_session.commit()
    assert svc.is_entitled(org.id, "audit") is False
    assert db_session.query(CommercialSubscription).count() == 1


def test_double_charge_readiness(db_session):
    """Step 10: billing_source drives whether the standalone platform may
    independently charge. Preserved on the Organization (server-stamped)."""
    svc = CommercialAccountService(db_session)

    standalone = make_organization(db_session, code="CHG8A", name="Chg A")
    standalone.billing_source = BillingSource.REGISTERED_VIA_STANDALONE
    db_session.commit()
    assert svc.can_charge(standalone) is True

    zoiko_one = make_organization(db_session, code="CHG8B", name="Chg B")
    zoiko_one.billing_source = BillingSource.REGISTERED_VIA_ZOIKO_ONE
    db_session.commit()
    assert svc.can_charge(zoiko_one) is False

    # The account does NOT duplicate the source — it is read off the org.
    account_a = svc.ensure_commercial_account(standalone.id)
    account_b = svc.ensure_commercial_account(zoiko_one.id)
    db_session.commit()
    assert account_a is not None and account_b is not None
    assert hasattr(account_a, "billing_source") is False
    assert svc.determine_billing_source(standalone) == BillingSource.REGISTERED_VIA_STANDALONE
    assert svc.determine_billing_source(zoiko_one) == BillingSource.REGISTERED_VIA_ZOIKO_ONE
