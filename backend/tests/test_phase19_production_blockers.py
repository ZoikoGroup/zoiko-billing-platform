"""Focused regression coverage for the Phase 19 production blockers."""

from datetime import date
from decimal import Decimal
import asyncio

import pytest
from fastapi import BackgroundTasks
from slowapi.errors import RateLimitExceeded
from starlette.requests import Request
from starlette.responses import Response

from app.core.exceptions import BadRequestException
from app.core.rate_limiter import limit_route, limiter
from app.modules.billing.models import (
    BillingSubscriptionStatus,
    Invoice,
    Subscription,
    SubscriptionEvent,
)
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.subscription_service import SubscriptionService
from app.modules.billing.routers.invoice_router import create_invoice as create_invoice_route
from app.modules.billing.routers.subscription_router import create_subscription as create_subscription_route
from app.modules.billing.schemas import InvoiceCreate, SubscriptionCreate
from app.modules.organizations.models import TenantLifecycleState
from app.modules.organizations.router import (
    _dispatch_org_created_notification,
    create_organization,
    delete_organization,
)
from app.modules.super_admin.lifecycle_service import TenantLifecycleService
from app.modules.super_admin.models import PlatformAuditLog
from app.modules.auth.models import User, UserRole
from app.modules.organizations.schemas import OrganizationBase

from tests.conftest import (
    make_customer,
    make_invoice,
    make_organization,
    make_subscription,
    make_subscription_plan,
)


def _super_admin(db, email="root@phase19.example"):
    user = User(
        email=email,
        hashed_password="test-hash",
        role=UserRole.SUPER_ADMIN,
        first_name="Platform",
        last_name="Admin",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_organization_delete_is_non_destructive_and_points_to_offboarding(db_session):
    org = make_organization(db_session, code="KEEP19", name="Keep History")
    customer = make_customer(db_session, org.id, code="KEEP-CUSTOMER")
    plan = make_subscription_plan(db_session, org.id, code="KEEP-PLAN")
    subscription = make_subscription(db_session, org.id, customer.id, plan.id)
    invoice = make_invoice(db_session, org.id, customer.id, invoice_number="KEEP-INV")
    actor = _super_admin(db_session)
    db_session.commit()

    with pytest.raises(BadRequestException, match="billing history must be retained"):
        delete_organization(org.id, current_user=actor, db=db_session)

    assert db_session.get(type(org), org.id) is not None
    assert db_session.get(type(subscription), subscription.id) is not None
    assert db_session.get(type(invoice), invoice.id) is not None


def test_governed_offboarding_preserves_financial_rows_and_audits_transitions(db_session):
    org = make_organization(db_session, code="LIFE19", name="Lifecycle History")
    customer = make_customer(db_session, org.id, code="LIFE-CUSTOMER")
    plan = make_subscription_plan(db_session, org.id, code="LIFE-PLAN")
    subscription = make_subscription(db_session, org.id, customer.id, plan.id)
    invoice = make_invoice(db_session, org.id, customer.id, invoice_number="LIFE-INV")
    actor = _super_admin(db_session, email="lifecycle@phase19.example")
    service = TenantLifecycleService(db_session)

    service.transition(
        actor=actor,
        organization=org,
        target=TenantLifecycleState.DEACTIVATING,
        reason="Customer requested controlled offboarding",
    )
    db_session.commit()
    service.transition(
        actor=actor,
        organization=org,
        target=TenantLifecycleState.DEACTIVATED,
        reason="Retention review completed",
    )
    db_session.commit()
    db_session.refresh(org)

    assert org.lifecycle_state == TenantLifecycleState.DEACTIVATED
    assert org.is_active is False
    assert db_session.get(type(subscription), subscription.id) is not None
    assert db_session.get(type(invoice), invoice.id) is not None
    assert (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.organization_id == org.id)
        .count()
        == 2
    )


def test_org_created_notification_is_queued_after_commit(db_session, monkeypatch):
    actor = _super_admin(db_session, email="creator@phase19.example")
    background_tasks = BackgroundTasks()
    notify = monkeypatch.setattr

    calls = []
    notify(
        "app.services.email_service.notify_super_admins_org_created",
        lambda **kwargs: calls.append(kwargs),
    )

    org = create_organization(
        OrganizationBase(organization_name="Async Org", country="Australia"),
        background_tasks=background_tasks,
        current_user=actor,
        db=db_session,
    )

    assert org.id is not None
    assert calls == []
    assert len(background_tasks.tasks) == 1
    task = background_tasks.tasks[0]
    assert task.func is _dispatch_org_created_notification
    assert task.kwargs == {
        "organization_id": org.id,
        "actor_email": actor.email,
    }


def test_subscription_creation_replays_same_idempotency_key_without_duplicates(db_session):
    org = make_organization(db_session, code="IDEM19", name="Idempotent Org")
    customer = make_customer(db_session, org.id, code="IDEM-CUSTOMER")
    plan = make_subscription_plan(db_session, org.id, code="IDEM-PLAN")
    service = SubscriptionService(db_session)
    request = {
        "organization_id": org.id,
        "created_by": 1,
        "customer_id": customer.id,
        "plan_id": plan.id,
        "subscription_number": "SUB-IDEM-19",
        "idempotency_key": "subscription-create-19",
        "currency": "USD",
        "unit_price": Decimal("10.00"),
        "start_date": date.today(),
    }

    first = service.create_subscription(**request)
    replay = service.create_subscription(**request)

    assert replay.id == first.id
    assert db_session.query(Subscription).filter(Subscription.organization_id == org.id).count() == 1
    assert (
        db_session.query(SubscriptionEvent)
        .filter(SubscriptionEvent.subscription_id == first.id)
        .count()
        == 1
    )


def test_subscription_idempotency_key_rejects_a_different_request(db_session):
    org = make_organization(db_session, code="CONFLICT19", name="Conflict Org")
    customer = make_customer(db_session, org.id, code="CONFLICT-CUSTOMER")
    plan = make_subscription_plan(db_session, org.id, code="CONFLICT-PLAN")
    service = SubscriptionService(db_session)
    common = {
        "organization_id": org.id,
        "created_by": 1,
        "customer_id": customer.id,
        "plan_id": plan.id,
        "subscription_number": "SUB-CONFLICT-19",
        "idempotency_key": "subscription-conflict-19",
        "currency": "USD",
        "unit_price": Decimal("10.00"),
        "start_date": date.today(),
    }
    service.create_subscription(**common)

    with pytest.raises(BadRequestException, match="different subscription request"):
        service.create_subscription(**{**common, "unit_price": Decimal("11.00")})


def test_subscription_idempotency_key_is_scoped_to_the_organization(db_session):
    org_a = make_organization(db_session, code="IDEM-A", name="Idempotent A")
    customer_a = make_customer(db_session, org_a.id, code="IDEM-A-CUSTOMER")
    plan_a = make_subscription_plan(db_session, org_a.id, code="IDEM-A-PLAN")
    org_b = make_organization(db_session, code="IDEM-B", name="Idempotent B")
    customer_b = make_customer(db_session, org_b.id, code="IDEM-B-CUSTOMER")
    plan_b = make_subscription_plan(db_session, org_b.id, code="IDEM-B-PLAN")
    key = "same-key-in-two-tenants"

    first = SubscriptionService(db_session).create_subscription(
        organization_id=org_a.id,
        created_by=1,
        customer_id=customer_a.id,
        plan_id=plan_a.id,
        subscription_number="SUB-IDEM-A",
        idempotency_key=key,
        currency="USD",
        unit_price=Decimal("10.00"),
        start_date=date.today(),
    )
    second = SubscriptionService(db_session).create_subscription(
        organization_id=org_b.id,
        created_by=1,
        customer_id=customer_b.id,
        plan_id=plan_b.id,
        subscription_number="SUB-IDEM-B",
        idempotency_key=key,
        currency="USD",
        unit_price=Decimal("10.00"),
        start_date=date.today(),
    )

    assert first.id != second.id
    assert first.organization_id == org_a.id
    assert second.organization_id == org_b.id


def test_subscription_route_rejects_conflicting_body_and_header_keys():
    body = SubscriptionCreate(
        customer_id=1,
        plan_id=1,
        subscription_number="SUB-ROUTE-19",
        idempotency_key="body-key",
        unit_price=Decimal("10.00"),
        start_date=date.today(),
        current_term_start=date.today(),
        current_term_end=date.today(),
    )

    with pytest.raises(BadRequestException, match="must match"):
        create_subscription_route(
            body,
            idempotency_key_header="header-key",
            current_user=None,
            db=None,
            _admin=None,
        )


def test_invoice_creation_replays_same_idempotency_key_without_duplicate_drafts(db_session):
    org = make_organization(db_session, code="INV-IDEM-19", name="Invoice Idempotency")
    customer = make_customer(db_session, org.id, code="INV-IDEM-CUSTOMER")
    service = InvoiceService(db_session)
    request = {
        "organization_id": org.id,
        "created_by": 1,
        "customer_id": customer.id,
        "invoice_number": "INV-IDEM-19",
        "idempotency_key": "invoice-create-19",
        "issue_date": date.today(),
        "due_date": date.today(),
        "currency": "USD",
        "notes": "Retry-safe draft",
        "_skip_recalculate": True,
    }

    first = service.create_invoice(**request)
    replay = service.create_invoice(**request)

    assert replay.id == first.id
    assert db_session.query(Invoice).filter(Invoice.organization_id == org.id).count() == 1


def test_invoice_idempotency_key_rejects_a_different_request(db_session):
    org = make_organization(db_session, code="INV-CONFLICT-19", name="Invoice Conflict")
    customer = make_customer(db_session, org.id, code="INV-CONFLICT-CUSTOMER")
    service = InvoiceService(db_session)
    common = {
        "organization_id": org.id,
        "created_by": 1,
        "customer_id": customer.id,
        "invoice_number": "INV-CONFLICT-19",
        "idempotency_key": "invoice-conflict-19",
        "issue_date": date.today(),
        "due_date": date.today(),
        "currency": "USD",
        "_skip_recalculate": True,
    }
    service.create_invoice(**common)

    with pytest.raises(BadRequestException, match="different invoice request"):
        service.create_invoice(**{**common, "notes": "Changed request"})


def test_invoice_route_replay_is_not_blocked_by_monthly_limit(db_session, monkeypatch):
    from app.modules.commercial.entitlement_enforcement import EntitlementEnforcementService

    org = make_organization(db_session, code="INV-ROUTE-19", name="Invoice Route")
    customer = make_customer(db_session, org.id, code="INV-ROUTE-CUSTOMER")
    actor = User(
        email="invoice-route@phase19.example",
        hashed_password="test-hash",
        role=UserRole.ORG_ADMIN,
        organization_id=org.id,
        first_name="Invoice",
        last_name="Route",
        is_active=True,
        is_verified=True,
    )
    db_session.add(actor)
    db_session.commit()
    db_session.refresh(actor)
    body = InvoiceCreate(
        customer_id=customer.id,
        invoice_number="INV-ROUTE-19",
        idempotency_key="invoice-route-replay-19",
        issue_date=date.today(),
        due_date=date.today(),
        currency="USD",
    )
    entitlement_checks = []

    def allow_limit(self, **kwargs):
        entitlement_checks.append(kwargs)

    monkeypatch.setattr(EntitlementEnforcementService, "assert_within_limit", allow_limit)
    created = create_invoice_route(
        body,
        idempotency_key_header="invoice-route-replay-19",
        db=db_session,
        current_user=actor,
        _admin=actor,
    )

    def reject_limit(self, **kwargs):
        raise AssertionError("an idempotent replay must not consume the monthly limit")

    monkeypatch.setattr(EntitlementEnforcementService, "assert_within_limit", reject_limit)
    replayed = create_invoice_route(
        body,
        idempotency_key_header="invoice-route-replay-19",
        db=db_session,
        current_user=actor,
        _admin=actor,
    )

    assert len(entitlement_checks) == 1
    assert replayed.id == created.id


def test_subscription_webhook_status_update_is_tenant_scoped(db_session):
    from app.modules.billing.services.stripe_service import StripeService

    org_a = make_organization(db_session, code="HOOK-A", name="Webhook A")
    customer_a = make_customer(db_session, org_a.id, code="HOOK-A-CUSTOMER")
    plan_a = make_subscription_plan(db_session, org_a.id, code="HOOK-A-PLAN")
    org_b = make_organization(db_session, code="HOOK-B", name="Webhook B")
    customer_b = make_customer(db_session, org_b.id, code="HOOK-B-CUSTOMER")
    plan_b = make_subscription_plan(db_session, org_b.id, code="HOOK-B-PLAN")
    sub_a = make_subscription(db_session, org_a.id, customer_a.id, plan_a.id)
    sub_b = make_subscription(db_session, org_b.id, customer_b.id, plan_b.id)
    sub_a.stripe_subscription_id = "sub-shared-test-fixture"
    sub_b.stripe_subscription_id = "sub-shared-test-fixture"
    db_session.commit()

    StripeService(db_session)._handle_customer_subscription_updated(
        {"id": "sub-shared-test-fixture", "status": "canceled"},
        organization_id=org_a.id,
    )

    db_session.refresh(sub_a)
    db_session.refresh(sub_b)
    assert sub_a.status == BillingSubscriptionStatus.CANCELLED
    assert sub_b.status == BillingSubscriptionStatus.ACTIVE


def test_subscription_webhook_without_verified_tenant_is_ignored(db_session):
    from app.modules.billing.services.stripe_service import StripeService

    org = make_organization(db_session, code="HOOK-NO-ORG", name="Webhook No Org")
    customer = make_customer(db_session, org.id, code="HOOK-NO-ORG-CUSTOMER")
    plan = make_subscription_plan(db_session, org.id, code="HOOK-NO-ORG-PLAN")
    subscription = make_subscription(db_session, org.id, customer.id, plan.id)
    subscription.stripe_subscription_id = "sub-unscoped-test-fixture"
    db_session.commit()

    result = StripeService(db_session)._handle_customer_subscription_updated(
        {"id": "sub-unscoped-test-fixture", "status": "canceled"},
        organization_id=None,
    )

    db_session.refresh(subscription)
    assert result["action"] == "ignored"
    assert subscription.status == BillingSubscriptionStatus.ACTIVE


def _request_for_rate_limit(path="/phase19-rate-limit"):
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("phase19-rate-limit", 50000),
        }
    )


def test_limit_route_preserves_direct_calls_and_enforces_http_calls():
    limiter._storage.reset()

    @limit_route("2/minute")
    def limited_endpoint(request: Request = None):
        return Response("ok")

    try:
        assert limited_endpoint().status_code == 200
        assert limited_endpoint(request=_request_for_rate_limit()).status_code == 200
        assert limited_endpoint(request=_request_for_rate_limit()).status_code == 200
        with pytest.raises(RateLimitExceeded):
            limited_endpoint(request=_request_for_rate_limit())
    finally:
        limiter._storage.reset()


@pytest.mark.parametrize(
    "placeholder",
    ["change-me-billing-platform-secret", "change-me-to-a-long-random-string"],
)
def test_production_startup_rejects_all_shipped_secret_placeholders(monkeypatch, placeholder):
    from app import main

    monkeypatch.setattr(main.settings, "DEBUG", False)
    monkeypatch.setattr(main.settings, "BILLING_SECRET_KEY", placeholder)

    async def enter_lifespan():
        manager = main.lifespan(main.app)
        await manager.__aenter__()

    with pytest.raises(SystemExit, match="must be overridden"):
        asyncio.run(enter_lifespan())


@pytest.mark.parametrize("mfa_key", ["", "not-a-fernet-key"])
def test_production_startup_rejects_missing_or_invalid_mfa_key(monkeypatch, mfa_key):
    from app import main

    monkeypatch.setattr(main.settings, "DEBUG", False)
    monkeypatch.setattr(main.settings, "BILLING_SECRET_KEY", "a-valid-production-jwt-secret")
    monkeypatch.setattr(main.settings, "MFA_ENCRYPTION_KEY", mfa_key)

    async def enter_lifespan():
        manager = main.lifespan(main.app)
        await manager.__aenter__()

    with pytest.raises(SystemExit, match="MFA_ENCRYPTION_KEY"):
        asyncio.run(enter_lifespan())


def test_security_headers_are_added_to_api_responses():
    from app import main
    from starlette.requests import Request
    from starlette.responses import Response

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/health",
            "raw_path": b"/health",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
        }
    )

    async def call_next(_request):
        return Response("ok")

    response = asyncio.run(main.security_headers_middleware(request, call_next))

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["X-XSS-Protection"] == "0"
