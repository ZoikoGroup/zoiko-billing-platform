"""
PHASE 8 tests — Commercial Subscription management, registration, security,
billing-source integrity, and regression.

Mandated coverage (Step 13):
  SUBSCRIPTION 10-17, REGISTRATION 18-20, SECURITY 21-24, SOURCE 25-27,
  REGRESSION 31-35.

Handlers/dependencies are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
import pytest
from sqlalchemy.exc import IntegrityError

from app.core.dependencies import get_current_super_admin, get_organization_id
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.billing.models import BillingConfiguration, BillingCustomer
from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialPlan,
    CommercialSubscription,
)
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization
from app.modules.organizations.router import get_my_commercial_subscription
from app.modules.organizations.schemas import OrganizationUpdate
from app.modules.super_admin.router import (
    create_commercial_subscription,
    get_commercial_subscription as super_admin_get_commercial_subscription,
    set_commercial_subscription_status,
)
from tests.conftest import (
    make_customer,
    make_invoice,
    make_organization,
    make_subscription,
    make_subscription_plan,
)


# ── helpers ─────────────────────────────────────────────────────────────────

class _CreateSchema:
    def __init__(self, **kwargs):
        self.status = CommercialSubscriptionStatus.PENDING
        for key, value in kwargs.items():
            setattr(self, key, value)

    def model_dump(self):
        return {k: getattr(self, k) for k in ("organization_id", "plan_id", "status") if hasattr(self, k)}


class _StatusSchema:
    def __init__(self, status):
        self.status = status


def _sa_user():
    return User(
        email="sa@sub8.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )


def _org_user(role, org_id, email):
    return User(
        email=email,
        hashed_password="x",
        role=UserRole[role],
        organization_id=org_id,
        first_name="T",
        last_name="U",
        phone="",
        is_active=True,
        is_verified=True,
    )


def _register(db, email, organization="Acme Corp"):
    return register_enterprise(
        db,
        RegisterRequest(
            organization=organization,
            name="Ada Admin",
            email=email,
            password="StrongPass123!",
            # ZB-SA-CMD-003 v3.0: no country → an explicit currency is
            # mandatory (there is no silent USD fallback any more).
            currency="USD",
            intended_plan="essentials",
            currency="USD",
        ),
    )


def _account_for(db, email) -> CommercialAccount:
    admin = db.query(User).filter_by(email=email).first()
    return (
        db.query(CommercialAccount)
        .filter_by(organization_id=admin.organization_id)
        .first()
    )


def _org_with_plan(db, code, plan_code="PLAN8"):
    org = make_organization(db, code=code, name=f"Org {code}")
    db.commit()
    plan = CommercialPlanService(db).create_plan(plan_code=plan_code, plan_name="Plan")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    return org, plan, account


def _make_open_org(db, code, plan_code="PLAN8"):
    org, plan, account = _org_with_plan(db, code, plan_code)
    create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db,
    )
    return org, plan, account


# ── SUBSCRIPTION 10-17 ───────────────────────────────────────────────────────

def test_super_admin_creates_subscription(db_session):
    org, plan, account = _org_with_plan(db_session, "SA10", "SA10PLAN")
    result = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    assert result.organization_id == org.id
    assert result.commercial_plan_id == plan.id
    assert result.status == CommercialSubscriptionStatus.PENDING
    assert db_session.query(CommercialSubscription).count() == 1


def test_tenant_cannot_create_unauthorized_subscription(db_session):
    org, plan, _ = _org_with_plan(db_session, "TEN11", "TEN11PLAN")
    tenant = _org_user("ORG_ADMIN", org.id, "t@ten11.example")

    # A tenant is rejected by the Super Admin authorization dependency before
    # the handler body even runs.
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=tenant)


def test_valid_transition(db_session):
    org, plan, account = _org_with_plan(db_session, "TR12", "TR12PLAN")
    sub = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    svc = CommercialSubscriptionService(db_session)

    result = set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(CommercialSubscriptionStatus.ACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    assert result.status == CommercialSubscriptionStatus.ACTIVE

    result = set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(CommercialSubscriptionStatus.SUSPENDED),
        current_user=_sa_user(),
        db=db_session,
    )
    assert result.status == CommercialSubscriptionStatus.SUSPENDED

    result = set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(CommercialSubscriptionStatus.ACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    assert result.status == CommercialSubscriptionStatus.ACTIVE

    result = set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(CommercialSubscriptionStatus.CANCELLED),
        current_user=_sa_user(),
        db=db_session,
    )
    assert result.status == CommercialSubscriptionStatus.CANCELLED


def test_invalid_transition(db_session):
    org, plan, _ = _org_with_plan(db_session, "BAD13", "BAD13PLAN")
    sub = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    # PENDING -> EXPIRED is illegal.
    with pytest.raises(BadRequestException):
        set_commercial_subscription_status(
            subscription_id=sub.id,
            data=_StatusSchema(CommercialSubscriptionStatus.EXPIRED),
            current_user=_sa_user(),
            db=db_session,
        )
    # Terminal state rejects further changes.
    set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(CommercialSubscriptionStatus.CANCELLED),
        current_user=_sa_user(),
        db=db_session,
    )
    with pytest.raises(BadRequestException):
        set_commercial_subscription_status(
            subscription_id=sub.id,
            data=_StatusSchema(CommercialSubscriptionStatus.ACTIVE),
            current_user=_sa_user(),
            db=db_session,
        )


def test_duplicate_open_subscription_rejected(db_session):
    org, plan, _ = _org_with_plan(db_session, "DUP14", "DUP14PLAN")
    create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    other_plan = CommercialPlanService(db_session).create_plan(
        plan_code="DUP14B", plan_name="Other"
    )
    db_session.commit()
    with pytest.raises(BadRequestException):
        create_commercial_subscription(
            data=_CreateSchema(organization_id=org.id, plan_id=other_plan.id),
            current_user=_sa_user(),
            db=db_session,
        )
    assert db_session.query(CommercialSubscription).count() == 1


def test_historical_subscription_retained(db_session):
    org, plan_a, account = _org_with_plan(db_session, "HIS15", "HIS15A")
    sub_a = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan_a.id),
        current_user=_sa_user(),
        db=db_session,
    )
    set_commercial_subscription_status(
        subscription_id=sub_a.id,
        data=_StatusSchema(CommercialSubscriptionStatus.CANCELLED),
        current_user=_sa_user(),
        db=db_session,
    )
    plan_b = CommercialPlanService(db_session).create_plan(
        plan_code="HIS15B", plan_name="Growth"
    )
    db_session.commit()
    sub_b = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan_b.id),
        current_user=_sa_user(),
        db=db_session,
    )
    rows = (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account.id)
        .all()
    )
    assert len(rows) == 2
    statuses = {r.status for r in rows}
    assert CommercialSubscriptionStatus.CANCELLED in statuses
    assert CommercialSubscriptionStatus.PENDING in statuses
    assert sub_b.status == CommercialSubscriptionStatus.PENDING


def test_inactive_plan_cannot_receive_new_active_subscription(db_session):
    org, plan, _ = _org_with_plan(db_session, "IN16", "IN16PLAN")
    plan.status = CommercialPlanStatus.INACTIVE
    db_session.commit()

    # PENDING on an INACTIVE plan is allowed structurally…
    pending = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    assert pending.status == CommercialSubscriptionStatus.PENDING
    # …but it can never be ACTIVATED.
    with pytest.raises(BadRequestException):
        set_commercial_subscription_status(
            subscription_id=pending.id,
            data=_StatusSchema(CommercialSubscriptionStatus.ACTIVE),
            current_user=_sa_user(),
            db=db_session,
        )
    # And a brand-new ACTIVE subscription on an INACTIVE plan is rejected.
    db_session.query(CommercialSubscription).delete()
    db_session.commit()
    with pytest.raises(BadRequestException):
        create_commercial_subscription(
            data=_CreateSchema(
                organization_id=org.id,
                plan_id=plan.id,
                status=CommercialSubscriptionStatus.ACTIVE,
            ),
            current_user=_sa_user(),
            db=db_session,
        )


def test_archived_plan_cannot_receive_new_subscription(db_session):
    org, plan, _ = _org_with_plan(db_session, "ARC17", "ARC17PLAN")
    plan.status = CommercialPlanStatus.ARCHIVED
    db_session.commit()

    with pytest.raises(BadRequestException):
        create_commercial_subscription(
            data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
            current_user=_sa_user(),
            db=db_session,
        )
    assert db_session.query(CommercialSubscription).count() == 0


# ── REGISTRATION 18-20 ──────────────────────────────────────────────────────

def test_no_default_plan_means_no_subscription(db_session):
    _register(db_session, "nodef@sub8.example")
    account = _account_for(db_session, "nodef@sub8.example")
    assert account is not None
    assert (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account.id)
        .count()
        == 0
    )


def test_approved_default_plan_creates_subscription(db_session):
    plan = CommercialPlanService(db_session).create_plan(
        plan_code="DEFAULT8", plan_name="Default", is_default=True
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db_session.commit()

    _register(db_session, "withdef@sub8.example")
    account = _account_for(db_session, "withdef@sub8.example")
    sub = (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account.id)
        .first()
    )
    assert sub is not None
    assert sub.commercial_plan_id == plan.id


def test_registration_atomicity(db_session, monkeypatch):
    def _boom(self, account_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        CommercialSubscriptionService, "provision_default_subscription", _boom
    )
    with pytest.raises(RuntimeError):
        _register(db_session, "atomic8@sub8.example")
    db_session.rollback()
    assert db_session.query(User).filter_by(email="atomic8@sub8.example").first() is None
    assert db_session.query(Organization).count() == 0
    assert db_session.query(CommercialAccount).count() == 0


# ── SECURITY 21-24 ──────────────────────────────────────────────────────────

def test_org_a_cannot_read_org_b_subscription(db_session):
    org_a, plan_a, _ = _make_open_org(db_session, "RDA8", "RDA8PLAN")
    org_b, plan_b, _ = _make_open_org(db_session, "RDB8", "RDB8PLAN")

    user_a = _org_user("ORG_ADMIN", org_a.id, "a@rda8.example")
    resp = get_my_commercial_subscription(current_user=user_a, db=db_session)
    assert resp.organization_id == org_a.id
    assert resp.organization_id != org_b.id


def test_org_a_cannot_modify_org_b_subscription(db_session):
    org_a, _, _ = _make_open_org(db_session, "MOA8", "MOA8PLAN")
    org_b, plan_b, account_b = _org_with_plan(db_session, "MOB8", "MOB8PLAN")
    sub_b = create_commercial_subscription(
        data=_CreateSchema(organization_id=org_b.id, plan_id=plan_b.id),
        current_user=_sa_user(),
        db=db_session,
    )
    user_a = _org_user("ORG_ADMIN", org_a.id, "a@moa8.example")

    # No tenant mutation surface exists; the only tenant path is read-only and
    # org-scoped. Attempting to hit the Super Admin transition with a tenant
    # token is blocked at the authorization dependency.
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=user_a)
    row = (
        db_session.query(CommercialSubscription)
        .filter(CommercialSubscription.id == sub_b.id)
        .first()
    )
    assert row is not None
    assert row.status == CommercialSubscriptionStatus.PENDING


def test_organization_id_cannot_be_spoofed(db_session):
    org_a, _, _ = _make_open_org(db_session, "SPF8A", "SPF8APLAN")
    org_b, _, _ = _make_open_org(db_session, "SPF8B", "SPF8BPLAN")

    # The tenant endpoint has NO organization_id parameter — it derives the org
    # exclusively from the authenticated token (get_organization_id). A user of
    # org A always resolves to org A even though org B exists with a different
    # subscription.
    import inspect as _inspect
    from app.modules.organizations.router import get_my_commercial_subscription as _h

    sig = _inspect.signature(_h)
    assert "organization_id" not in sig.parameters

    user_a = _org_user("ORG_ADMIN", org_a.id, "a@spf8.example")
    assert get_organization_id(current_user=user_a) == org_a.id
    resp = get_my_commercial_subscription(current_user=user_a, db=db_session)
    assert resp.organization_id == org_a.id


def test_super_admin_authorization_works(db_session):
    org, plan, _ = _org_with_plan(db_session, "SAA8", "SAA8PLAN")
    create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    # Super Admin sees the org's subscription through the cross-org surface.
    detail = super_admin_get_commercial_subscription(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert detail.organization_id == org.id
    assert detail.commercial_plan_id == plan.id


# ── SOURCE 25-27 ────────────────────────────────────────────────────────────

def test_billing_source_immutable_by_tenant(db_session):
    org = make_organization(db_session, code="SRC8A", name="Src A")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    user = _org_user("ORG_ADMIN", org.id, "s@src8a.example")

    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
    update = OrganizationUpdate(website="https://x.example", billing_source="registered_via_zoiko_one")
    from app.modules.organizations.router import update_my_organization

    update_my_organization(update, current_user=user, db=db_session)
    db_session.refresh(org)
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE


def test_billing_classification_immutable_by_tenant(db_session):
    org = make_organization(db_session, code="CLS8A", name="Cls A")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    user = _org_user("ORG_ADMIN", org.id, "c@cls8a.example")

    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE
    update = OrganizationUpdate(website="https://y.example", billing_classification="commercial_zoiko_one")
    from app.modules.organizations.router import update_my_organization

    update_my_organization(update, current_user=user, db=db_session)
    db_session.refresh(org)
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE


def test_subscription_does_not_duplicate_source_classification(db_session):
    org, plan, _ = _org_with_plan(db_session, "NODUP8", "NODUP8PLAN")
    create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )
    # The subscription model carries no source/classification columns — the
    # Organization is the single source of truth.
    columns = {c.name for c in CommercialSubscription.__table__.columns}
    assert "billing_source" not in columns
    assert "billing_classification" not in columns
    # The read model exposes the org (read-only pass-through) fine.
    resp = super_admin_get_commercial_subscription(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert resp.organization_id == org.id


# ── REGRESSION 31-35 ────────────────────────────────────────────────────────

def test_billing_customer_still_works(db_session):
    org, _, _ = _org_with_plan(db_session, "RCUS8", "RCUS8PLAN")
    customer = make_customer(db_session, org.id, code="RC8")
    assert isinstance(customer, BillingCustomer)
    assert customer.organization_id == org.id


def test_invoice_still_works(db_session):
    org, _, _ = _org_with_plan(db_session, "RINV8", "RINV8PLAN")
    customer = make_customer(db_session, org.id, code="RIC8")
    invoice = make_invoice(db_session, org.id, customer.id)
    assert invoice.invoice_number.startswith("INV-")


def test_tenant_subscription_still_works(db_session):
    org, _, _ = _org_with_plan(db_session, "RSUB8", "RSUB8PLAN")
    customer = make_customer(db_session, org.id, code="RSC8")
    plan = make_subscription_plan(db_session, org.id)
    sub = make_subscription(db_session, org.id, customer.id, plan.id)
    assert sub.subscription_number
    # Tenant billing subscription rows are NOT commercial subscriptions.
    assert db_session.query(CommercialSubscription).count() == 0


def test_billing_configuration_still_works(db_session):
    org, _, _ = _org_with_plan(db_session, "RCFG8", "RCFG8PLAN")
    from app.modules.billing.services.settings_service import BillingConfigurationService

    BillingConfigurationService(db_session).seed_billing_configuration(org.id)
    db_session.commit()
    config = (
        db_session.query(BillingConfiguration)
        .filter_by(organization_id=org.id)
        .first()
    )
    assert config is not None


def test_registration_still_works(db_session):
    result = _register(db_session, "final8@sub8.example")
    admin = db_session.query(User).filter_by(email="final8@sub8.example").first()
    assert admin is not None
    assert admin.role == UserRole.ORG_ADMIN
    org = db_session.query(Organization).filter_by(id=admin.organization_id).first()
    assert org is not None
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 1
    assert db_session.query(BillingConfiguration).filter_by(organization_id=org.id).count() == 1
    assert result is not None
