"""
tests/test_subscription_plan_management.py
-------------------------------------------
Focused backend tests for Phase 18 — Organization Admin Subscription Plan
management.

Scope: the billing-plane SubscriptionPlan catalog (create / list / retrieve /
update / activate / deactivate), tenant isolation, RBAC wiring, and financial
validation. Runs against an isolated in-memory SQLite DB via the shared
`db_session` fixture — never against BILLING_DATABASE_URL.
"""
from decimal import Decimal
from datetime import date

import pytest

from app.core.exceptions import AlreadyExistsException, BadRequestException, NotFoundException
from app.modules.billing.models import (
    BillingPeriod,
    PlanCategory,
    SubscriptionPlan,
)
from app.modules.billing.services.subscription_service import SubscriptionService

from tests.conftest import make_organization, make_customer, make_subscription_plan


@pytest.fixture()
def org1(db_session):
    return make_organization(db_session, code="ORG-PLANS-1", name="Org Plans One")


@pytest.fixture()
def org2(db_session):
    return make_organization(db_session, code="ORG-PLANS-2", name="Org Plans Two")


def _make_service(db_session):
    return SubscriptionService(db_session)


# ── Create ──────────────────────────────────────────────────────────────────

def test_create_plan(db_session, org1):
    svc = _make_service(db_session)
    plan = svc.create_plan(
        organization_id=org1.id,
        created_by=1,
        plan_code="BASIC-M",
        plan_name="Basic Monthly",
        category="subscription",
        billing_period="monthly",
        unit_price=Decimal("999.00"),
        setup_fee=Decimal("0"),
        trial_days=14,
        is_public=True,
    )
    assert plan.id is not None
    assert plan.organization_id == org1.id
    assert plan.unit_price == Decimal("999.00")
    assert plan.is_active is True
    db_session.refresh(plan)


def test_create_duplicate_plan_code_raises(db_session, org1):
    svc = _make_service(db_session)
    svc.create_plan(org1.id, 1, plan_code="DUP", plan_name="One",
                    category="subscription", billing_period="monthly",
                    unit_price=Decimal("10"))
    with pytest.raises(AlreadyExistsException):
        svc.create_plan(org1.id, 1, plan_code="DUP", plan_name="Two",
                        category="subscription", billing_period="monthly",
                        unit_price=Decimal("20"))


def test_create_same_code_different_org_is_allowed(db_session, org1, org2):
    svc = _make_service(db_session)
    p1 = svc.create_plan(org1.id, 1, plan_code="SAME", plan_name="A",
                         category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    p2 = svc.create_plan(org2.id, 1, plan_code="SAME", plan_name="B",
                         category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    assert p1.id != p2.id


# ── Retrieve / List ─────────────────────────────────────────────────────────

def test_get_plan_org_scoped(db_session, org1, org2):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="P1", plan_name="P1",
                           category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    got = svc.get_plan(plan.id, org1.id)
    assert got.plan_name == "P1"
    with pytest.raises(NotFoundException):
        svc.get_plan(plan.id, org2.id)


def test_list_plans_only_returns_own_org(db_session, org1, org2):
    svc = _make_service(db_session)
    svc.create_plan(org1.id, 1, plan_code="A1", plan_name="A1",
                    category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    svc.create_plan(org2.id, 1, plan_code="B1", plan_name="B1",
                    category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    result = svc.list_plans(org1.id)
    assert result["total"] == 1
    assert result["items"][0].plan_code == "A1"
    result2 = svc.list_plans(org2.id)
    assert result2["total"] == 1
    assert result2["items"][0].plan_code == "B1"


def test_list_plans_includes_inactive_for_admin(db_session, org1):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="T1", plan_name="T1",
                           category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    svc.deactivate_plan(plan.id, org1.id, 1)
    # Admin management view must still return the inactive plan (active_only=False)
    result = svc.list_plans(org1.id)
    assert result["total"] == 1
    assert result["items"][0].is_active is False


# ── Update ──────────────────────────────────────────────────────────────────

def test_update_plan(db_session, org1, org2):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="U1", plan_name="Old",
                           category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    updated = svc.update_plan(plan.id, org1.id, 1, plan_name="New Name", unit_price=Decimal("25.00"))
    assert updated.plan_name == "New Name"
    assert updated.unit_price == Decimal("25.00")
    with pytest.raises(NotFoundException):
        svc.update_plan(plan.id, org2.id, 1, plan_name="Hack")


# ── Activate / Deactivate ───────────────────────────────────────────────────

def test_deactivate_and_activate_plan(db_session, org1):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="AD1", plan_name="AD1",
                           category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    assert plan.is_active is True
    deactivated = svc.deactivate_plan(plan.id, org1.id, 1)
    assert deactivated.is_active is False
    reactivated = svc.activate_plan(plan.id, org1.id, 1)
    assert reactivated.is_active is True


def test_deactivate_cross_org_raises(db_session, org1, org2):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="XO1", plan_name="XO1",
                           category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    with pytest.raises(NotFoundException):
        svc.deactivate_plan(plan.id, org2.id, 1)
    with pytest.raises(NotFoundException):
        svc.activate_plan(plan.id, org2.id, 1)


# ── Tenant isolation through repository boundary ────────────────────────────

def test_cannot_retrieve_plan_by_id_across_org(db_session, org1, org2):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="ISO1", plan_name="ISO1",
                           category="subscription", billing_period="monthly", unit_price=Decimal("10"))
    with pytest.raises(NotFoundException):
        svc.get_plan(plan.id, org2.id)


# ── Financial validation ────────────────────────────────────────────────────

def test_create_plan_rejects_negative_unit_price(db_session, org1):
    svc = _make_service(db_session)
    with pytest.raises(BadRequestException):
        svc.create_plan(org1.id, 1, plan_code="NEG1", plan_name="Neg",
                        category="subscription", billing_period="monthly",
                        unit_price=Decimal("-5.00"))


def test_create_plan_rejects_negative_setup_fee(db_session, org1):
    svc = _make_service(db_session)
    with pytest.raises(BadRequestException):
        svc.create_plan(org1.id, 1, plan_code="NEG2", plan_name="Neg",
                        category="subscription", billing_period="monthly",
                        unit_price=Decimal("10"), setup_fee=Decimal("-1.00"))


def test_create_plan_rejects_negative_trial_days(db_session, org1):
    svc = _make_service(db_session)
    with pytest.raises(BadRequestException):
        svc.create_plan(org1.id, 1, plan_code="NEG3", plan_name="Neg",
                        category="subscription", billing_period="monthly",
                        unit_price=Decimal("10"), trial_days=-1)


def test_update_plan_rejects_negative_price(db_session, org1):
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="UPD1", plan_name="Upd",
                           category="subscription", billing_period="monthly",
                           unit_price=Decimal("10"))
    with pytest.raises(BadRequestException):
        svc.update_plan(plan.id, org1.id, 1, unit_price=Decimal("-3.00"))


def test_create_plan_accepts_null_unit_price(db_session, org1):
    """PricingModel can be non-FLAT (usage/tiered) where unit_price is allowed
    to be NULL. A null price must not be rejected."""
    svc = _make_service(db_session)
    plan = svc.create_plan(org1.id, 1, plan_code="NULLPX", plan_name="Null",
                           category="subscription", billing_period="monthly",
                           pricing_model="per_unit", unit_price=None)
    assert plan.unit_price is None


# ── Subscription integration ────────────────────────────────────────────────

def test_inactive_plan_cannot_be_used_for_subscription(db_session, org1):
    svc = _make_service(db_session)
    customer = make_customer(db_session, org1.id, code="CUST-INACT", currency="USD")
    plan = svc.create_plan(org1.id, 1, plan_code="INACT1", plan_name="Inactive",
                           category="subscription", billing_period="monthly",
                           unit_price=Decimal("10"))
    svc.deactivate_plan(plan.id, org1.id, 1)
    with pytest.raises(BadRequestException):
        svc.create_subscription(
            organization_id=org1.id,
            created_by=1,
            customer_id=customer.id,
            plan_id=plan.id,
            subscription_number="SUB-INACT-1",
            currency="USD",
            start_date=date.today(),
        )


def test_newly_created_active_plan_can_be_used_for_subscription(db_session, org1):
    svc = _make_service(db_session)
    customer = make_customer(db_session, org1.id, code="CUST-NEW", currency="USD")
    plan = svc.create_plan(org1.id, 1, plan_code="NEWPLAN", plan_name="New Plan",
                           category="subscription", billing_period="monthly",
                           unit_price=Decimal("999.00"), trial_days=14)
    sub = svc.create_subscription(
        organization_id=org1.id,
        created_by=1,
        customer_id=customer.id,
        plan_id=plan.id,
        subscription_number="SUB-NEW-1",
        currency="USD",
        start_date=date.today(),
    )
    assert sub.plan_id == plan.id
    assert sub.unit_price == Decimal("999.00")
