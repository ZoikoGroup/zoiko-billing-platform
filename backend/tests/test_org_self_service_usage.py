"""
Part 3 — org-facing usage diagnostics (GET /billing/workspace/usage) tests.

The org self-service usage surface must:
  1. return only the caller's OWN organization's counters (never another org's)
  2. join real UsageCounter rows with the resolved entitlement limit (7-level
     chain, L4 trial grant here) — a budget key with no row is absent, not 0
  3. fail OPEN when entitlement resolution breaks (<14): the counters are
     still returned, with limit surfaced as unknown rather than ~0~
  4. degrade cleanly when the org has no account / no subscription

No TestClient precedent exists in tests/ — router functions are invoked
directly against the isolated in-memory SQLite fixture.
"""
from datetime import datetime, timedelta
from unittest.mock import patch

from app.modules.auth.models import User, UserRole
from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
    EntitlementEnforcementType,
    EntitlementValueType,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialSubscription,
    EntitlementDefinition,
    UsageCounter,
)
from app.modules.commercial.org_self_service_router import get_org_usage
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
)
from tests.conftest import make_organization

BUDGET_KEY = "billing.usage.customers_limit"


def _chargeable_org(db, code="USA1", name="Usage Co"):
    org = make_organization(db, code=code, name=name)
    org.billing_classification = BillingClassification.COMMERCIAL_STANDALONE
    org.billing_source = BillingSource.REGISTERED_VIA_STANDALONE
    db.flush()
    return org


def _plan(db, code="USA1P"):
    plan = CommercialPlanService(db).create_plan(
        plan_code=code,
        plan_name=f"{code} Plan",
        billing_interval=CommercialBillingInterval.MONTHLY,
        currency="USD",
        price_amount="49.00",
        is_quote_only=False,
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db.commit()
    return plan


def _admin(db, org_id, email="admin@usage1.co"):
    user = User(
        email=email,
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=org_id,
        first_name="Ada",
        last_name="Admin",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _definition(db, key=BUDGET_KEY, enforce=EntitlementEnforcementType.HARD):
    definition = EntitlementDefinition(
        key=key,
        value_type=EntitlementValueType.INTEGER,
        enforcement_type=enforce,
        description=f"{key} budget",
    )
    db.add(definition)
    db.flush()
    return definition


class _CurrentUser:
    def __init__(self, user):
        self.id = user.id
        self.organization_id = user.organization_id


def _trial_setup(db, *, code="USA1"):
    plan = _plan(db, f"{code}P")
    org = _chargeable_org(db, code=code)
    user = _admin(db, org.id, email=f"admin@{code.lower()}.co")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    sub = CommercialSubscription(
        commercial_account_id=account.id,
        commercial_plan_id=plan.id,
        status=CommercialSubscriptionStatus.TRIALING,
        trial_ends_at=datetime.utcnow() + timedelta(days=10),
        recovery_ends_at=datetime.utcnow() + timedelta(days=24),
        trial_granted_entitlements=[{"key": BUDGET_KEY, "value": 250}],
    )
    db.add(sub)
    db.commit()
    return org, user, account, plan, sub


def _counter(db, *, organization_id, definition, count=18, window="month"):
    counter = UsageCounter(
        organization_id=organization_id,
        entitlement_definition_id=definition.id,
        window_key=window,
        count=count,
    )
    db.add(counter)
    db.commit()
    return counter


# ── 1. org scoping + real join ───────────────────────────────────────────────

def test_usage_returns_own_counters_with_resolved_limit(db_session):
    _, user, _, _, _ = _trial_setup(db_session, code="UA1")
    definition = _definition(db_session)
    _counter(db_session, organization_id=user.organization_id, definition=definition, count=18)

    payload = get_org_usage(db=db_session, current_user=_CurrentUser(user))

    assert payload["plan_code"] == "UA1P"
    assert len(payload["counters"]) == 1
    row = payload["counters"][0]
    assert row["entitlement_key"] == BUDGET_KEY
    assert row["count"] == 18
    # L4 trial grant: 250 customers, exercise fails open on limits anyway
    assert row["limit"] == 250
    assert row["enforcement_type"] == "hard"


def test_usage_never_crosses_organization_boundaries(db_session):
    _, user_a, _, _, _ = _trial_setup(db_session, code="UA2")
    _, user_b, _, _, _ = _trial_setup(db_session, code="UB2")
    definition = _definition(db_session)
    _counter(db_session, organization_id=user_a.organization_id, definition=definition, count=99)
    _counter(db_session, organization_id=user_b.organization_id, definition=definition, count=7)

    payload_a = get_org_usage(db=db_session, current_user=_CurrentUser(user_a))
    payload_b = get_org_usage(db=db_session, current_user=_CurrentUser(user_b))

    assert [r["count"] for r in payload_a["counters"]] == [99]
    assert [r["count"] for r in payload_b["counters"]] == [7]


# ── 2. honesty — no row means no tracked usage, not a fabricated zero ────────

def test_usage_returns_empty_when_no_counter_rows(db_session):
    _, user, _, _, _ = _trial_setup(db_session, code="UA3")
    _definition(db_session)

    payload = get_org_usage(db=db_session, current_user=_CurrentUser(user))

    assert payload["counters"] == []
    assert payload["plan_code"] == "UA3P"


# ── 3. fail-open read when resolution breaks ─────────────────────────────────

def test_usage_fails_open_when_resolver_breaks(db_session):
    _, user, _, _, _ = _trial_setup(db_session, code="UA4")
    definition = _definition(db_session)
    _counter(db_session, organization_id=user.organization_id, definition=definition, count=18)

    with patch(
        "app.modules.commercial.entitlement_resolver.resolve_entitlement",
        side_effect=RuntimeError("catalog corrupt"),
    ):
        payload = get_org_usage(db=db_session, current_user=_CurrentUser(user))

    row = payload["counters"][0]
    assert row["count"] == 18
    assert row["limit"] is None
    assert row["enforcement_type"] is None


# ── 4. clean degradation ─────────────────────────────────────────────────────

def test_usage_empty_without_account(db_session):
    org = _chargeable_org(db_session, code="UA5")
    user = _admin(db_session, org.id, email="admin@ua5.co")

    payload = get_org_usage(db=db_session, current_user=_CurrentUser(user))

    assert payload["account"] is None
    assert payload["subscription"] is None
    assert payload["counters"] == []


def test_usage_no_subscription_still_lists_owned_counters(db_session):
    org = _chargeable_org(db_session, code="UA6")
    user = _admin(db_session, org.id, email="admin@ua6.co")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    definition = _definition(db_session)
    # Counter rows may exist (usage metered pre- or post-provisioning) even
    # when the org's subscription is currently absent.
    _counter(db_session, organization_id=org.id, definition=definition, count=5)

    payload = get_org_usage(db=db_session, current_user=_CurrentUser(user))

    assert payload["subscription"] is None
    assert len(payload["counters"]) == 1
    assert payload["counters"][0]["count"] == 5