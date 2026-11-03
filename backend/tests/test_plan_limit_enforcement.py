"""
Plan limits that were advertised on the plan pages but not enforced:
team seats, the customer cap (billing.customer.max, previously borrowed
from org.entity.max), recurring billing, pricing models, currencies and
the audit-log search window, plus the live usage the plan-limits page reads.

Enforcement applies to new actions only: nothing here switches off or
removes what an organization already has.
"""

from datetime import datetime
from types import SimpleNamespace

import pytest

from app.core.security import hash_password
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import BillingCustomer, CurrencyPricing, Product, ProductType
from app.modules.billing.routers.currency_pricing_router import _assert_currency_allowed
from app.modules.billing.routers.subscription_router import create_subscription
from app.modules.billing.schemas import SubscriptionCreate
from app.modules.billing.services.customer_service import CustomerService
from app.modules.commercial.entitlement_enforcement import (
    EntitlementBlockedException,
    EntitlementEnforcementService,
    EntitlementLimitExceededException,
    PlanFeatureUnavailableException,
    audit_search_cutoff,
)
from app.modules.commercial.enums import EntitlementValueType
from app.modules.commercial.models import PlanEntitlement
from tests.conftest import make_customer, make_organization
from tests.test_commercial_entitlements import (
    _catalog_definition,
    _org_with_active_subscription,
    _plan,
    _plan_with_entitlement,
    _published_version,
)


def _fake_user(organization_id, user_id=1):
    return SimpleNamespace(organization_id=organization_id, id=user_id)


def _add_user(db, organization_id, email, *, active=True, temporary=False):
    user = User(
        email=email,
        hashed_password=hash_password("x-Password-123"),
        role=UserRole.BILLING_ADMIN,
        organization_id=organization_id,
        first_name="T",
        last_name="User",
        is_active=active,
        access_expires_at=datetime(2099, 1, 1) if temporary else None,
    )
    db.add(user)
    db.flush()
    return user


# ── Seats (plan max_users) ──────────────────────────────────────────────────


def test_seat_limit_blocks_a_user_beyond_max_users(db_session):
    plan = _plan(db_session, "SEATPKG", max_users=2)
    org, _, _ = _org_with_active_subscription(db_session, "SEATORG", plan)
    _add_user(db_session, org.id, "a@seat.test")
    _add_user(db_session, org.id, "b@seat.test")
    db_session.commit()

    with pytest.raises(EntitlementLimitExceededException) as exc_info:
        EntitlementEnforcementService(db_session).assert_seat_available(organization_id=org.id)
    exc = exc_info.value
    assert exc.extra["entity"] == "user"
    assert exc.extra["current_usage"] == 2
    assert exc.extra["limit"] == 2
    assert "max_users" not in str(exc.detail)


def test_seat_limit_ignores_suspended_and_support_access_users(db_session):
    plan = _plan(db_session, "SEAT2PKG", max_users=2)
    org, _, _ = _org_with_active_subscription(db_session, "SEAT2ORG", plan)
    _add_user(db_session, org.id, "a@seat2.test")
    _add_user(db_session, org.id, "suspended@seat2.test", active=False)
    _add_user(db_session, org.id, "support@seat2.test", temporary=True)
    db_session.commit()

    # One real seat in use out of two: one more user still fits.
    EntitlementEnforcementService(db_session).assert_seat_available(organization_id=org.id)


def test_seat_limit_is_uncapped_without_max_users_or_subscription(db_session):
    plan = _plan(db_session, "SEAT3PKG", max_users=None)
    org, _, _ = _org_with_active_subscription(db_session, "SEAT3ORG", plan)
    for i in range(10):
        _add_user(db_session, org.id, f"u{i}@seat3.test")
    lone_org = make_organization(db_session, code="SEAT3LONE", name="No Subscription")
    db_session.commit()

    EntitlementEnforcementService(db_session).assert_seat_available(organization_id=org.id)
    EntitlementEnforcementService(db_session).assert_seat_available(organization_id=lone_org.id)


# ── Recurring billing on new subscriptions ──────────────────────────────────


def test_new_subscription_blocked_without_recurring_billing(db_session):
    plan, _ = _plan_with_entitlement(db_session, "RECOFF", "billing.recurring.manage", False)
    org, _, _ = _org_with_active_subscription(db_session, "RECOFFORG", plan)
    db_session.commit()

    body = SubscriptionCreate.model_construct(customer_id=1, plan_id=1, idempotency_key=None)
    with pytest.raises(PlanFeatureUnavailableException) as exc_info:
        create_subscription(
            body=body, idempotency_key_header=None, db=db_session,
            current_user=_fake_user(org.id), _admin=None, _revenue_gate=None,
        )
    exc = exc_info.value
    assert exc.error_code == "PLAN_FEATURE_UNAVAILABLE"
    assert exc.extra["feature"] == "Recurring billing"
    # The org admin sees a sentence, not the internal key.
    assert "billing.recurring.manage" not in str(exc.detail)
    assert "Recurring billing isn't included in your Recoff plan" in str(exc.detail)


# ── Pricing models ──────────────────────────────────────────────────────────


def test_pricing_model_families(db_session):
    plan, _ = _plan_with_entitlement(
        db_session, "PMFLAT", "billing.pricing_model_set", ["flat"], value_type=EntitlementValueType.SET,
    )
    org, _, _ = _org_with_active_subscription(db_session, "PMFLATORG", plan)
    db_session.commit()
    svc = EntitlementEnforcementService(db_session)

    svc.assert_pricing_model_allowed(organization_id=org.id, pricing_model="flat")
    svc.assert_pricing_model_allowed(organization_id=org.id, pricing_model="per_unit")  # flat family
    for blocked in ("tiered", "graduated", "volume"):
        with pytest.raises(PlanFeatureUnavailableException):
            svc.assert_pricing_model_allowed(organization_id=org.id, pricing_model=blocked)


def test_pricing_model_unrestricted_when_set_is_contracted(db_session):
    plan, _ = _plan_with_entitlement(
        db_session, "PMANY", "billing.pricing_model_set", None, value_type=EntitlementValueType.SET,
    )
    org, _, _ = _org_with_active_subscription(db_session, "PMANYORG", plan)
    db_session.commit()

    EntitlementEnforcementService(db_session).assert_pricing_model_allowed(
        organization_id=org.id, pricing_model="volume",
    )


# ── Currencies ──────────────────────────────────────────────────────────────


def _price_in(db, organization_id, currency, code):
    product = Product(
        organization_id=organization_id, name=f"Product {code}", code=code,
        product_type=ProductType.SERVICE, currency="USD",
    )
    db.add(product)
    db.flush()
    db.add(CurrencyPricing(organization_id=organization_id, product_id=product.id, currency=currency, price=10))
    db.flush()


def test_currency_limit_counts_distinct_new_currencies_only(db_session):
    plan, _ = _plan_with_entitlement(
        db_session, "CURPKG", "currency.enabled.max", 1, value_type=EntitlementValueType.INTEGER,
    )
    org, _, _ = _org_with_active_subscription(db_session, "CURORG", plan)
    _price_in(db_session, org.id, "EUR", "CURP1")
    db_session.commit()
    user = _fake_user(org.id)

    # More prices in a currency already in use never take a new slot.
    _assert_currency_allowed(db_session, user, "eur")
    with pytest.raises(EntitlementLimitExceededException) as exc_info:
        _assert_currency_allowed(db_session, user, "GBP")
    assert exc_info.value.extra["entity"] == "currency"


# ── Customers: single create and bulk import ────────────────────────────────


def test_customer_import_stops_at_the_customer_limit(db_session):
    plan, _ = _plan_with_entitlement(
        db_session, "IMPPKG", "billing.customer.max", 2, value_type=EntitlementValueType.INTEGER,
    )
    org, _, _ = _org_with_active_subscription(db_session, "IMPORG", plan)
    make_customer(db_session, org.id, code="IMPC0", email="c0@imp.test")
    db_session.commit()

    result = CustomerService(db_session).import_customers(
        organization_id=org.id, created_by=1,
        items=[
            {"customer_code": f"IMPC{i}", "company_name": f"Imp {i}", "email": f"c{i}@imp.test"}
            for i in (1, 2, 3)
        ],
    )
    assert result["imported"] == 1
    assert result["skipped"] == 2
    assert all("allows up to 2 customers" in e for e in result["errors"])
    assert db_session.query(BillingCustomer).filter_by(organization_id=org.id).count() == 2


# ── Audit-log search window ─────────────────────────────────────────────────


def test_audit_search_cutoff_follows_plan_months(db_session):
    plan, _ = _plan_with_entitlement(
        db_session, "AUDPKG", "audit.search_months", 3, value_type=EntitlementValueType.INTEGER,
    )
    org, _, _ = _org_with_active_subscription(db_session, "AUDORG", plan)
    db_session.commit()

    cutoff = audit_search_cutoff(db_session, org.id)
    now = datetime.utcnow()
    months_back = (now.year - cutoff.year) * 12 + (now.month - cutoff.month)
    assert months_back == 3
    assert cutoff.day == 1 and cutoff.hour == 0


def test_audit_search_cutoff_fails_open_without_catalog(db_session):
    org = make_organization(db_session, code="AUDNONE", name="No Catalog")
    db_session.commit()
    assert audit_search_cutoff(db_session, org.id) is None


# ── Live usage for the plan-limits page ─────────────────────────────────────


def test_plan_limits_reports_live_usage_and_seats(db_session):
    from app.modules.commercial.org_self_service_router import get_org_plan_limits

    plan = _plan(db_session, "USEPKG", max_users=5)
    version = _published_version(db_session, plan)
    definition = _catalog_definition(db_session, "billing.customer.max", EntitlementValueType.INTEGER)
    db_session.add(PlanEntitlement(plan_version_id=version.id, entitlement_definition_id=definition.id, value=100))
    db_session.flush()
    org, _, _ = _org_with_active_subscription(db_session, "USEORG", plan)
    make_customer(db_session, org.id, code="USEC1", email="u1@use.test")
    make_customer(db_session, org.id, code="USEC2", email="u2@use.test")
    _add_user(db_session, org.id, "a@use.test")
    db_session.commit()

    result = get_org_plan_limits(db=db_session, current_user=_fake_user(org.id))
    customers = next(e for e in result["entitlements"] if e["key"] == "billing.customer.max")
    assert customers["value"] == 100
    assert customers["current_usage"] == 2
    assert result["seats"] == {"used": 1, "limit": 5}


def test_seed_backfills_customer_limit_onto_every_plan_version(db_session):
    """A subscription resolves against its own pinned version. If the new
    key were only seeded onto the latest published version, any other
    version would resolve to the safe default (0) and block every new
    customer."""
    from app.modules.commercial.models import CommercialPlanVersion
    from scripts.seed_entitlement_definitions import _backfill_all_versions

    essentials = _plan(db_session, "essentials")
    v1 = _published_version(db_session, essentials)
    v2 = _published_version(db_session, essentials)
    v2.version_number = 2
    custom = _plan(db_session, "custom_deal")
    v_custom = _published_version(db_session, custom)
    definition = _catalog_definition(db_session, "billing.customer.max", EntitlementValueType.INTEGER)
    # v1 already has a value (e.g. set by the main seed loop): left alone.
    db_session.add(PlanEntitlement(plan_version_id=v1.id, entitlement_definition_id=definition.id, value=7))
    db_session.flush()

    inserted = _backfill_all_versions(db_session, {"billing.customer.max": definition})
    db_session.flush()
    assert inserted == 2

    def value_for(version):
        row = db_session.query(PlanEntitlement).filter_by(
            plan_version_id=version.id, entitlement_definition_id=definition.id,
        ).one()
        return row.value, row.is_contracted

    assert value_for(v1) == (7, False)
    assert value_for(v2) == (100, False)
    assert value_for(v_custom) == (None, True)
    # Idempotent: a second run inserts nothing.
    assert _backfill_all_versions(db_session, {"billing.customer.max": definition}) == 0
    assert db_session.query(CommercialPlanVersion).count() >= 3


def test_boolean_gate_message_never_shows_the_raw_key(db_session):
    plan, _ = _plan_with_entitlement(db_session, "DUNOFF", "collections.dunning", False)
    org, _, _ = _org_with_active_subscription(db_session, "DUNOFFORG", plan)
    db_session.commit()

    with pytest.raises(EntitlementBlockedException) as exc_info:
        EntitlementEnforcementService(db_session).assert_boolean(organization_id=org.id, key="collections.dunning")
    assert "collections.dunning" not in str(exc_info.value.detail)
    assert "Dunning & collections" in str(exc_info.value.detail)
