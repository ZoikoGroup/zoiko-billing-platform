"""
Entitlement Limit UX Hardening — structured error contract tests.

Covers the additive `entity=` parameter on
EntitlementEnforcementService.assert_within_limit() and the
EntitlementLimitExceededException it raises when supplied
(backend/app/modules/commercial/entitlement_enforcement.py), plus the two
real call sites that opt into it: POST /billing/customers (org.entity.max)
and POST /billing/invoices (billing.invoice.monthly_limit).

This is UX/error-contract hardening only — assert_within_limit's actual
enforcement decision (allow/deny, HARD/SOFT_THEN_HARD/THROTTLE branching) is
untouched and already covered by test_commercial_entitlements.py and
test_entitlement_enforcement_wiring.py. These tests exist to lock in:
  - the structured payload's shape and values (error_code, entity,
    current_usage, limit, remaining, plan_name) for a real limit-gated
    route, including when existing usage is already above the limit
    (remaining must clamp to 0, never go negative);
  - that omitting `entity` (every caller before this change) preserves the
    exact prior plain-EntitlementBlockedException behavior;
  - that the structured exception is still an EntitlementBlockedException,
    so nothing that already asserts on that type breaks;
  - tenant isolation is preserved (org A's usage/limit never affects org B).
"""

from app.modules.billing.models import BillingCustomer
from app.modules.billing.routers.customer_router import create_customer
from app.modules.billing.schemas import CustomerCreate
from app.modules.commercial.entitlement_enforcement import (
    EntitlementBlockedException,
    EntitlementEnforcementService,
    EntitlementLimitExceededException,
)
from app.modules.commercial.enums import EntitlementValueType
from tests.conftest import make_customer
from tests.test_entitlement_enforcement_wiring import _customer_payload, _fake_user
from tests.test_commercial_entitlements import _org_with_active_subscription, _plan_with_entitlement


def test_within_limit_creation_succeeds_no_error(db_session):
    plan, definition = _plan_with_entitlement(
        db_session, "UXOKPKG", "org.entity.max", 2, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "UXOKORG", plan)
    db_session.commit()

    created = create_customer(
        data=_customer_payload("UXOKCUST1"), db=db_session, current_user=_fake_user(org.id),
    )
    assert created.customer_code == "UXOKCUST1"


def test_limit_exactly_reached_raises_structured_payload(db_session):
    plan, definition = _plan_with_entitlement(
        db_session, "UXLIMPKG", "org.entity.max", 2, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "UXLIMORG", plan)
    make_customer(db_session, org.id, code="UXLIMCUST1")
    make_customer(db_session, org.id, code="UXLIMCUST2")
    db_session.commit()

    try:
        create_customer(
            data=_customer_payload("UXLIMCUST3"), db=db_session, current_user=_fake_user(org.id),
        )
        assert False, "expected EntitlementLimitExceededException"
    except EntitlementLimitExceededException as exc:
        assert isinstance(exc, EntitlementBlockedException)  # subclass, not a replacement
        assert exc.status_code == 403
        assert exc.error_code == "SUBSCRIPTION_LIMIT_REACHED"
        assert exc.extra["error_type"] == "ENTITLEMENT_LIMIT"
        assert exc.extra["entity"] == "customer"
        assert exc.extra["current_usage"] == 2
        assert exc.extra["limit"] == 2
        assert exc.extra["remaining"] == 0
        assert exc.extra["plan_name"] == "Uxlimpkg"  # _plan() sets plan_name = plan_code.title()
        assert exc.extra["entitlement_key"] == "org.entity.max"
        # The raw technical key must not be the primary message shown to
        # an org admin — only present in the structured 'entitlement_key'
        # metadata field for engineering/support debugging.
        non_key_values = "".join(str(v) for k, v in exc.extra.items() if k != "entitlement_key")
        assert "org.entity.max" not in non_key_values
    # No partial row left behind by the blocked write.
    assert db_session.query(BillingCustomer).filter_by(organization_id=org.id).count() == 2


def test_usage_already_above_limit_clamps_remaining_to_zero(db_session):
    """Mirrors the real demo-org condition: existing usage (5) already
    exceeds the plan limit (2). `remaining` must clamp to 0, not go
    negative, and the wording data must still be accurate (current_usage
    reflects the real existing count, not the limit)."""
    plan, definition = _plan_with_entitlement(
        db_session, "UXOVERPKG", "org.entity.max", 2, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "UXOVERORG", plan)
    for i in range(5):
        make_customer(db_session, org.id, code=f"UXOVERCUST{i}")
    db_session.commit()

    try:
        create_customer(
            data=_customer_payload("UXOVERCUST_NEW"), db=db_session, current_user=_fake_user(org.id),
        )
        assert False, "expected EntitlementLimitExceededException"
    except EntitlementLimitExceededException as exc:
        assert exc.extra["current_usage"] == 5
        assert exc.extra["limit"] == 2
        assert exc.extra["remaining"] == 0  # not -3


def test_entity_omitted_preserves_plain_blocked_exception(db_session):
    """Backward compatibility: a caller that does not pass `entity=` (the
    exact shape of every assert_within_limit call before this change) must
    keep raising the plain EntitlementBlockedException with the original
    free-text message, not the new structured subclass."""
    plan, definition = _plan_with_entitlement(
        db_session, "UXBWCPKG", "org.entity.max", 1, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "UXBWCORG", plan)
    make_customer(db_session, org.id, code="UXBWCCUST1")
    db_session.commit()

    svc = EntitlementEnforcementService(db_session)
    try:
        svc.assert_within_limit(organization_id=org.id, key="org.entity.max", current_count=1)
        assert False, "expected EntitlementBlockedException"
    except EntitlementLimitExceededException:
        assert False, "must not raise the structured subclass when entity= is omitted"
    except EntitlementBlockedException as exc:
        assert exc.error_code == "FORBIDDEN"
        assert exc.extra == {}
        assert str(exc.detail) == "'org.entity.max' limit (1) exceeded."


def test_tenant_isolation_org_at_limit_does_not_block_other_org(db_session):
    plan, definition = _plan_with_entitlement(
        db_session, "UXISOPKG", "org.entity.max", 1, value_type=EntitlementValueType.INTEGER,
    )
    org_a, _, _ = _org_with_active_subscription(db_session, "UXISOA", plan)
    org_b, _, _ = _org_with_active_subscription(db_session, "UXISOB", plan)
    make_customer(db_session, org_a.id, code="UXISOACUST1")  # org A at its limit of 1
    db_session.commit()

    try:
        create_customer(data=_customer_payload("UXISOACUST2"), db=db_session, current_user=_fake_user(org_a.id))
        assert False, "expected org A to be blocked"
    except EntitlementLimitExceededException as exc:
        assert exc.extra["current_usage"] == 1

    # Org B has zero customers against the same plan/limit — unaffected by A's usage.
    created = create_customer(data=_customer_payload("UXISOBCUST1"), db=db_session, current_user=_fake_user(org_b.id))
    assert created.organization_id == org_b.id


def test_invoice_monthly_limit_also_gets_structured_payload(db_session):
    """The second real call site (billing.invoice.monthly_limit on POST
    /billing/invoices) opts into the same structured contract with its own
    entity slug — locks in that this isn't a customer-only special case."""
    from datetime import date

    from app.modules.billing.routers.invoice_router import create_invoice
    from app.modules.billing.schemas import InvoiceCreate

    plan, definition = _plan_with_entitlement(
        db_session, "UXINVPKG", "billing.invoice.monthly_limit", 0, value_type=EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "UXINVORG", plan)
    customer = make_customer(db_session, org.id, code="UXINVCUST1")
    db_session.commit()
    user = _fake_user(org.id)

    body = InvoiceCreate(customer_id=customer.id, issue_date=date.today(), due_date=date.today(), currency="USD")
    try:
        create_invoice(body, idempotency_key_header=None, db=db_session, current_user=user, _admin=user)
        assert False, "expected EntitlementLimitExceededException"
    except EntitlementLimitExceededException as exc:
        assert exc.extra["entity"] == "invoice"
        assert exc.extra["entitlement_key"] == "billing.invoice.monthly_limit"
        assert exc.extra["limit"] == 0
