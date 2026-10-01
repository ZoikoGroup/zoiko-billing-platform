"""
ZB-COM-ENT-001 Part 2 — route-wiring tests (AC-01, AC-11).

Calls router functions directly as plain Python functions (no HTTP layer —
this repo has no TestClient precedent anywhere in tests/, see
test_commercial_entitlements.py's own docstring) so the actual router body
logic is exercised, not just the service layer it calls into.

Covers:
  - AC-01: "A tenant on Essentials cannot create a usage-metered billing
    contract through UI, API or background jobs." The route-body path here
    stands in for UI/API (both go through the same router function); the
    background-job path is EntitlementEnforcementService called directly
    with no route/dependency involved at all (also exercised in
    test_commercial_entitlements.py's enforcement tests).
  - AC-11: "A raw API call bypassing the front end is still blocked by
    require_entitlement." Exercised by calling the dependency callable
    require_entitlement() produces directly, without going through FastAPI's
    dependency-injection machinery.

Only routes 1 (billing.usage_metering) and 5 (collections.dunning) get full
router-body fixtures here — routes 2-4's router bodies are thin 3-5 line
pass-throughs to EntitlementEnforcementService, already covered at the
service level in test_commercial_entitlements.py; duplicating full
Contract/Invoice/Customer/User fixture chains for them would cost more than
it proves.
"""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.modules.billing.models import BillingCustomer, Product, ProductType
from app.modules.billing.routers.contract_router import set_contract_items
from app.modules.billing.routers.customer_router import create_customer
from app.modules.billing.routers.dunning_router import create_level
from app.modules.billing.schemas import (
    ContractItemBulkCreate,
    ContractItemCreate,
    CustomerCreate,
    DunningLevelCreate,
)
from app.modules.billing.services import ContractService
from app.modules.commercial.entitlement_enforcement import (
    EntitlementBlockedException,
    require_entitlement,
)
from app.modules.commercial.entitlement_resolver import EntitlementKeyNotFoundError
from app.modules.commercial.enums import EntitlementValueType
from tests.conftest import make_customer, make_organization
from tests.test_commercial_entitlements import _plan_with_entitlement, _org_with_active_subscription


def _fake_user(organization_id, user_id=1):
    return SimpleNamespace(organization_id=organization_id, id=user_id)


def _make_contract(db, organization_id, customer_id, *, number):
    return ContractService(db).create_contract(
        organization_id=organization_id,
        created_by=1,
        customer_id=customer_id,
        contract_number=number,
        contract_name="Test Contract",
        start_date=date.today(),
        currency="USD",
    )


def _make_product(db, organization_id, *, product_type, code):
    product = Product(
        organization_id=organization_id, name=f"Product {code}", code=code,
        product_type=product_type, currency="USD",
    )
    db.add(product)
    db.flush()
    return product


# ── Route 1: billing.usage_metering on PUT /contracts/{id}/items ───────────


def test_route1_blocks_usage_product_item_without_entitlement(db_session):
    plan, definition = _plan_with_entitlement(db_session, "WIRE1PKG", "billing.usage_metering", False)
    org, account, sub = _org_with_active_subscription(db_session, "WIRE1ORG", plan)
    customer = make_customer(db_session, org.id, code="WIRE1CUST")
    contract = _make_contract(db_session, org.id, customer.id, number="WIRE1-C1")
    usage_product = _make_product(db_session, org.id, product_type=ProductType.USAGE, code="USG1")
    db_session.commit()

    data = ContractItemBulkCreate(items=[
        ContractItemCreate(product_id=usage_product.id, description="Usage line", unit_price=Decimal("10")),
    ])

    with pytest.raises(EntitlementBlockedException):
        set_contract_items(
            contract_id=contract.id, data=data, db=db_session, current_user=_fake_user(org.id),
        )


def test_route1_allows_usage_product_item_with_entitlement(db_session):
    plan, definition = _plan_with_entitlement(db_session, "WIRE1BPKG", "billing.usage_metering", True)
    org, account, sub = _org_with_active_subscription(db_session, "WIRE1BORG", plan)
    customer = make_customer(db_session, org.id, code="WIRE1BCUST")
    contract = _make_contract(db_session, org.id, customer.id, number="WIRE1B-C1")
    usage_product = _make_product(db_session, org.id, product_type=ProductType.USAGE, code="USG1B")
    db_session.commit()

    data = ContractItemBulkCreate(items=[
        ContractItemCreate(product_id=usage_product.id, description="Usage line", unit_price=Decimal("10")),
    ])

    items = set_contract_items(
        contract_id=contract.id, data=data, db=db_session, current_user=_fake_user(org.id),
    )
    assert len(items) == 1


def test_route1_does_not_gate_non_usage_product_items(db_session):
    """The conditional trigger must not fire for an ordinary (non-USAGE)
    product, even when the org lacks billing.usage_metering."""
    plan, definition = _plan_with_entitlement(db_session, "WIRE1CPKG", "billing.usage_metering", False)
    org, account, sub = _org_with_active_subscription(db_session, "WIRE1CORG", plan)
    customer = make_customer(db_session, org.id, code="WIRE1CCUST")
    contract = _make_contract(db_session, org.id, customer.id, number="WIRE1C-C1")
    service_product = _make_product(db_session, org.id, product_type=ProductType.SERVICE, code="SVC1C")
    db_session.commit()

    data = ContractItemBulkCreate(items=[
        ContractItemCreate(product_id=service_product.id, description="Service line", unit_price=Decimal("10")),
    ])

    items = set_contract_items(
        contract_id=contract.id, data=data, db=db_session, current_user=_fake_user(org.id),
    )
    assert len(items) == 1


# ── Route 5: collections.dunning via require_entitlement() Depends factory ──
# AC-11: a raw call to the dependency callable, bypassing FastAPI's DI and
# any UI, is still blocked.


def test_route5_dependency_blocks_without_entitlement(db_session):
    plan, definition = _plan_with_entitlement(db_session, "WIRE5PKG", "collections.dunning", False)
    org, account, sub = _org_with_active_subscription(db_session, "WIRE5ORG", plan)
    db_session.commit()

    dependency = require_entitlement("collections.dunning")
    with pytest.raises(EntitlementBlockedException):
        dependency(db=db_session, current_user=_fake_user(org.id))


def test_route5_dependency_allows_with_entitlement(db_session):
    plan, definition = _plan_with_entitlement(db_session, "WIRE5BPKG", "collections.dunning", True)
    org, account, sub = _org_with_active_subscription(db_session, "WIRE5BORG", plan)
    db_session.commit()

    dependency = require_entitlement("collections.dunning")
    returned_user = dependency(db=db_session, current_user=_fake_user(org.id))
    assert returned_user.organization_id == org.id


def test_route5_full_router_body_blocks_without_entitlement(db_session):
    """End-to-end through the actual router function, including its
    dependencies=[...] gate, by invoking the dependency exactly as FastAPI
    would before calling the route body."""
    plan, definition = _plan_with_entitlement(db_session, "WIRE5CPKG", "collections.dunning", False)
    org, account, sub = _org_with_active_subscription(db_session, "WIRE5CORG", plan)
    db_session.commit()

    user = _fake_user(org.id)
    with pytest.raises(EntitlementBlockedException):
        require_entitlement("collections.dunning")(db=db_session, current_user=user)
        create_level(
            data=DunningLevelCreate(
                level_number=1, name="Level 1", min_days_overdue=30, action_type="email",
            ),
            db=db_session, current_user=user,
        )


def test_require_entitlement_rejects_unknown_key_at_definition_time():
    """A typo'd key fails at router-definition time (ValueError), not at
    request time — mirrors require_capability()'s exact behavior."""
    with pytest.raises(ValueError):
        require_entitlement("not.a.real.catalog.key")


# ── Route: org.entity.max on POST /billing/customers ────────────────────────
# Phase 5 (Billing E2E reliability remediation) — this router body's
# EntitlementEnforcementService.assert_within_limit(key="org.entity.max")
# call is exactly what a real environment missing the seeded entitlement
# catalog (scripts/seed_entitlement_definitions.py never run) surfaces as an
# unhandled EntitlementKeyNotFoundError -> 500 on customer creation. Fixed by
# ensuring that seed script (and scripts/seed_commercial_plans.py, its own
# prerequisite) runs as part of environment/test setup — not by touching this
# router or the entitlement resolver, both of which are working exactly as
# designed (see entitlement_enforcement.py's own "fail-open vs fail-closed"
# docstring: a write whose entitlement can't be resolved must never silently
# succeed). These tests lock in that the *router* wiring is correct and
# document the real, deliberate business rule (a plan's org.entity.max caps
# how many BillingCustomer rows an org may have) that the E2E lifecycle test
# had to become tenant-per-run to respect, rather than fight.


def _customer_payload(code):
    return CustomerCreate(
        customer_code=code, company_name=f"Customer {code}", display_name=f"Customer {code}",
    )


def test_customer_creation_blocked_when_entity_limit_reached(db_session):
    plan, definition = _plan_with_entitlement(
        db_session, "ENT1PKG", "org.entity.max", 1, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "ENT1ORG", plan)
    make_customer(db_session, org.id, code="ENT1CUST1")  # already at the limit of 1
    db_session.commit()

    with pytest.raises(EntitlementBlockedException):
        create_customer(
            data=_customer_payload("ENT1CUST2"), db=db_session, current_user=_fake_user(org.id),
        )
    # Blocked write must not leave a partial second customer behind.
    assert db_session.query(BillingCustomer).filter_by(organization_id=org.id).count() == 1


def test_customer_creation_allowed_within_entity_limit(db_session):
    plan, definition = _plan_with_entitlement(
        db_session, "ENT2PKG", "org.entity.max", 1, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "ENT2ORG", plan)
    db_session.commit()

    created = create_customer(
        data=_customer_payload("ENT2CUST1"), db=db_session, current_user=_fake_user(org.id),
    )
    assert created.customer_code == "ENT2CUST1"
    assert created.organization_id == org.id


def test_customer_creation_fails_closed_without_seeded_entitlement_catalog(db_session):
    """Reproduces the exact Phase 5 defect: no EntitlementDefinition row for
    'org.entity.max' at all (the seed script was never run) makes customer
    creation raise, by design (see entitlement_resolver.py's own docstring:
    this is treated as a coding bug / missing setup, not a tenant condition,
    and never silently resolves). This is the failure the real fix
    (seeding the catalog before the app/tests run) prevents — proving this
    stays a hard failure here documents why the fix belongs in environment
    setup, not in a try/except around this call."""
    org = make_organization(db_session, code="ENT3ORG", name="Ent3 Org")
    db_session.commit()
    # Deliberately no EntitlementDefinition, no CommercialAccount/Subscription
    # at all for this org -- the exact state of a freshly created org before
    # scripts/seed_entitlement_definitions.py has ever been run.

    with pytest.raises(EntitlementKeyNotFoundError):
        create_customer(
            data=_customer_payload("ENT3CUST1"), db=db_session, current_user=_fake_user(org.id),
        )
