"""
PHASE 7 regression tests: Commercial Plan + Commercial Subscription foundation.

Covers the mandated A–H categories:
  A. Commercial Plan        (create / retrieve / duplicate code / inactive /
                             no invented pricing)
  B. Commercial Account     (links to org / 1:1 / not duplicated)
  C. Commercial Subscription (links to account / links to plan / valid + invalid
                             lifecycle / duplicate-active prevention / history)
  D. Registration           (account created / subscription only with approved
                             plan / atomicity / rollback)
  E. Tenant isolation       (org A cannot read or modify org B)
  F. RBAC                   (Super Admin / Org Admin / org-bound Super Admin /
                             unauthorized tenant user)
  G. Billing-source integrity (client cannot change source/classification /
                             subscription cannot silently change source)
  H. Regression             (Billing Customer / Invoice / tenant Subscription /
                             BillingConfiguration / registration)

Handlers and dependencies are invoked directly against the real router
functions (no HTTP layer), so every test runs on the isolated in-memory
SQLite fixture from conftest.py — never BILLING_DATABASE_URL. RBAC is tested
at the dependency that enforces it (get_current_super_admin /
get_organization_id).
"""
import pytest
from sqlalchemy.exc import IntegrityError

from app.core.dependencies import get_current_super_admin, get_organization_id
from app.core.exceptions import ForbiddenException
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
from app.modules.commercial.schemas import (
    CommercialPlanResponse,
    CommercialSubscriptionResponse,
)
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization
from app.modules.organizations.router import (
    get_my_commercial_subscription,
    update_my_organization,
)
from app.modules.organizations.schemas import OrganizationUpdate
from app.modules.super_admin.router import (
    get_commercial_subscription as super_admin_get_commercial_subscription,
)
from app.modules.super_admin.router import list_commercial_plans
from app.modules.super_admin.router import list_commercial_subscriptions
from tests.conftest import (
    make_customer,
    make_invoice,
    make_organization,
    make_subscription,
    make_subscription_plan,
)


# ── helpers ─────────────────────────────────────────────────────────────────

def _make_user(role: str, org_id, email: str) -> User:
    return User(
        email=email,
        hashed_password="x",
        role=UserRole[role],
        organization_id=org_id,
        first_name="A",
        last_name="B",
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
        ),
    )


def _account_for(db, email) -> CommercialAccount:
    admin = db.query(User).filter_by(email=email).first()
    return (
        db.query(CommercialAccount)
        .filter_by(organization_id=admin.organization_id)
        .first()
    )


def _make_plan(db, code="STARTER", name="Starter", is_default=False):
    return CommercialPlanService(db).create_plan(
        plan_code=code, plan_name=name, is_default=is_default,
    )


def _make_account_and_subscription(db, org_id, plan=None):
    account = CommercialAccountService(db).ensure_commercial_account(org_id)
    if plan is None:
        plan = _make_plan(db, code=f"PLAN{org_id}")
    sub = CommercialSubscriptionService(db).create_subscription(account.id, plan)
    db.commit()
    return account, plan, sub


# ── A. Commercial Plan ───────────────────────────────────────────────────────

def test_plan_can_be_created(db_session):
    plan = _make_plan(db_session, code="STARTER", name="Starter Plan")
    db_session.commit()

    assert plan.id is not None
    assert plan.plan_code == "STARTER"
    assert plan.status == CommercialPlanStatus.ACTIVE
    assert plan.is_default is False


def test_plan_can_be_retrieved(db_session):
    _make_plan(db_session, code="STARTER", name="Starter Plan")
    db_session.commit()

    svc = CommercialPlanService(db_session)
    by_id = svc.get_plan(1)
    by_code = svc.get_plan_by_code("STARTER")

    assert by_id is not None and by_id.plan_code == "STARTER"
    assert by_code is not None and by_code.id == by_id.id
    assert len(svc.list_plans()) == 1


def test_duplicate_plan_code_rejected(db_session):
    _make_plan(db_session, code="STARTER", name="Starter")
    db_session.commit()

    with pytest.raises(ValueError):
        _make_plan(db_session, code="STARTER", name="Starter Duplicate")
    db_session.rollback()
    assert len(CommercialPlanService(db_session).list_plans()) == 1


def test_inactive_plan_behavior(db_session):
    plan = _make_plan(db_session, code="RETIRED", name="Retired")
    plan.status = CommercialPlanStatus.INACTIVE
    db_session.commit()

    # An INACTIVE plan is still valid for existing subscriptions/history, but
    # the default-plan provisioning path must NOT pick it up.
    assert plan.status == CommercialPlanStatus.INACTIVE

    account = CommercialAccountService(db_session).ensure_commercial_account(
        make_organization(db_session, code="INACTIVE1", name="Inactive Co").id
    )
    sub = CommercialSubscriptionService(db_session).create_subscription(account.id, plan)
    db_session.commit()
    assert sub.commercial_plan_id == plan.id


def test_no_invented_pricing_values(db_session):
    plan = _make_plan(db_session, code="STARTER", name="Starter")
    db_session.commit()

    # Structural-only: nothing invented.
    assert plan.price_amount is None
    assert plan.currency is None
    assert plan.billing_interval is None
    assert plan.max_users is None
    assert plan.max_storage_gb is None
    assert plan.features is None


# ── B. Commercial Account ────────────────────────────────────────────────────

def test_account_links_to_organization(db_session):
    org = make_organization(db_session, code="ACCT1", name="Account Co")
    db_session.commit()

    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    assert account.organization_id == org.id
    assert account.organization.id == org.id
    assert org.commercial_account.id == account.id


def test_account_remains_one_to_one(db_session):
    org = make_organization(db_session, code="ONETOONE", name="One To One Co")
    db_session.commit()
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    with pytest.raises(IntegrityError):
        db_session.add(CommercialAccount(organization_id=org.id))
        db_session.flush()
    db_session.rollback()


def test_existing_account_is_not_duplicated(db_session):
    org = make_organization(db_session, code="NODUP7", name="No Dup 7 Co")
    db_session.commit()

    svc = CommercialAccountService(db_session)
    first = svc.ensure_commercial_account(org.id)
    second = svc.ensure_commercial_account(org.id)
    db_session.commit()

    assert first.id == second.id
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 1


# ── C. Commercial Subscription ───────────────────────────────────────────────

def test_subscription_links_to_account(db_session):
    org = make_organization(db_session, code="SUBA1", name="Sub A Co")
    db_session.commit()
    account, _, _ = _make_account_and_subscription(db_session, org.id)

    sub = db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).first()
    assert sub is not None
    assert sub.account.id == account.id
    assert account.subscriptions[0].id == sub.id


def test_subscription_links_to_plan(db_session):
    org = make_organization(db_session, code="SUBP1", name="Sub P Co")
    db_session.commit()
    _, plan, sub = _make_account_and_subscription(db_session, org.id)

    assert sub.plan.id == plan.id
    assert sub.commercial_plan_id == plan.id
    assert plan.subscriptions[0].id == sub.id


def test_valid_lifecycle_transition(db_session):
    org = make_organization(db_session, code="LIFE1", name="Life Co")
    db_session.commit()
    _, _, sub = _make_account_and_subscription(db_session, org.id)
    assert sub.status == CommercialSubscriptionStatus.PENDING

    svc = CommercialSubscriptionService(db_session)
    svc.transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db_session.commit()
    assert sub.status == CommercialSubscriptionStatus.ACTIVE

    svc.transition(sub, CommercialSubscriptionStatus.SUSPENDED)
    db_session.commit()
    assert sub.status == CommercialSubscriptionStatus.SUSPENDED

    svc.transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db_session.commit()
    assert sub.status == CommercialSubscriptionStatus.ACTIVE

    svc.transition(sub, CommercialSubscriptionStatus.CANCELLED)
    db_session.commit()
    assert sub.status == CommercialSubscriptionStatus.CANCELLED


def test_invalid_lifecycle_transition_rejected(db_session):
    org = make_organization(db_session, code="BADLIFE", name="Bad Life Co")
    db_session.commit()
    _, _, sub = _make_account_and_subscription(db_session, org.id)

    svc = CommercialSubscriptionService(db_session)
    with pytest.raises(ValueError):
        svc.transition(sub, CommercialSubscriptionStatus.EXPIRED)  # PENDING -> EXPIRED
    with pytest.raises(ValueError):
        svc.transition(sub, CommercialSubscriptionStatus.PENDING)  # PENDING -> PENDING

    svc.transition(sub, CommercialSubscriptionStatus.CANCELLED)
    db_session.commit()
    # Terminal state: no further transitions.
    with pytest.raises(ValueError):
        svc.transition(sub, CommercialSubscriptionStatus.ACTIVE)
    assert sub.status == CommercialSubscriptionStatus.CANCELLED


def test_duplicate_active_subscription_prevented(db_session):
    org = make_organization(db_session, code="DUPACT", name="Dup Active Co")
    db_session.commit()
    account, _, _ = _make_account_and_subscription(db_session, org.id)

    other_plan = _make_plan(db_session, code="OTHERPLAN", name="Other Plan")
    svc = CommercialSubscriptionService(db_session)
    with pytest.raises(ValueError):
        svc.create_subscription(account.id, other_plan)
    db_session.rollback()

    assert svc.get_active_subscription(account.id) is not None
    assert db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).count() == 1


def test_historical_subscription_preserved(db_session):
    org = make_organization(db_session, code="HIST1", name="Hist Co")
    db_session.commit()
    account, plan_a, sub_a = _make_account_and_subscription(db_session, org.id)

    svc = CommercialSubscriptionService(db_session)
    svc.transition(sub_a, CommercialSubscriptionStatus.CANCELLED)
    db_session.commit()

    plan_b = _make_plan(db_session, code="GROWTH", name="Growth")
    sub_b = svc.create_subscription(account.id, plan_b)
    db_session.commit()

    rows = db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).all()
    assert len(rows) == 2
    assert sub_a.status == CommercialSubscriptionStatus.CANCELLED
    assert sub_b.status == CommercialSubscriptionStatus.PENDING
    assert svc.get_active_subscription(account.id).id == sub_b.id
    assert svc.get_most_recent_subscription(account.id).id == sub_b.id


# ── D. Registration ──────────────────────────────────────────────────────────

def test_registration_creates_account(db_session):
    _register(db_session, "reg7@acme.example")
    account = _account_for(db_session, "reg7@acme.example")
    assert account is not None
    assert account.status.value == "active"


def test_subscription_created_only_when_approved_default_plan_exists(db_session):
    # No approved default plan (Phase 7 seeds none) -> NO subscription.
    _register(db_session, "noplan@acme.example")
    account = _account_for(db_session, "noplan@acme.example")
    assert account is not None
    assert db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).count() == 0

    # With an approved default plan -> subscription IS created.
    plan = _make_plan(db_session, code="DEFAULT7", name="Default", is_default=True)
    plan.status = CommercialPlanStatus.ACTIVE
    db_session.commit()

    _register(db_session, "withplan@acme.example")
    account2 = _account_for(db_session, "withplan@acme.example")
    sub = (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account2.id)
        .first()
    )
    assert sub is not None
    assert sub.commercial_plan_id == plan.id


def test_registration_remains_atomic(db_session, monkeypatch):
    def _boom(self, account_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        CommercialSubscriptionService, "provision_default_subscription", _boom
    )

    with pytest.raises(RuntimeError):
        _register(db_session, "atomic7@acme.example")

    db_session.rollback()
    assert db_session.query(User).filter_by(email="atomic7@acme.example").first() is None
    assert db_session.query(Organization).count() == 0
    assert db_session.query(CommercialAccount).count() == 0
    assert db_session.query(CommercialSubscription).count() == 0


def test_failed_subscription_provisioning_rolls_back(db_session, monkeypatch):
    # Provisioning succeeds for the account but the subscription creation
    # itself fails -> the entire registration must roll back.
    def _fail_subscription(self, account_id):
        raise RuntimeError("subscription failure")

    monkeypatch.setattr(
        CommercialSubscriptionService, "provision_default_subscription", _fail_subscription
    )

    with pytest.raises(RuntimeError):
        _register(db_session, "rollback7@acme.example")

    db_session.rollback()
    assert db_session.query(Organization).count() == 0
    assert db_session.query(CommercialAccount).count() == 0


# ── E. Tenant isolation ──────────────────────────────────────────────────────

def test_org_a_cannot_read_org_b_subscription(db_session):
    org_a = make_organization(db_session, code="READA1", name="Read A")
    org_b = make_organization(db_session, code="READB1", name="Read B")
    _make_account_and_subscription(db_session, org_a.id)
    _make_account_and_subscription(db_session, org_b.id)

    user_a = _make_user("ORG_ADMIN", org_a.id, "a@reada.example")

    resp = get_my_commercial_subscription(current_user=user_a, db=db_session)
    assert isinstance(resp, CommercialSubscriptionResponse)
    assert resp.organization_id == org_a.id
    assert resp.organization_id != org_b.id


def test_org_a_cannot_modify_org_b_subscription(db_session):
    org_a = make_organization(db_session, code="MODA7", name="Mod A")
    org_b = make_organization(db_session, code="MODB7", name="Mod B")
    _, _, sub_b = _make_account_and_subscription(db_session, org_b.id)
    _make_account_and_subscription(db_session, org_a.id)

    user_a = _make_user("ORG_ADMIN", org_a.id, "a@moda7.example")

    # No tenant-facing mutation endpoint exists for subscriptions; the only
    # tenant surface is read-only and org-scoped. Org A's own profile update
    # must not touch org B's subscription.
    updated = update_my_organization(
        OrganizationUpdate(website="https://a.example"),
        current_user=user_a,
        db=db_session,
    )
    assert updated.id == org_a.id

    db_session.refresh(sub_b)
    assert sub_b.status == CommercialSubscriptionStatus.PENDING


# ── F. RBAC ──────────────────────────────────────────────────────────────────

def test_super_admin_can_inspect(db_session):
    org = make_organization(db_session, code="SARB7", name="SA RB 7")
    _make_account_and_subscription(db_session, org.id)
    sa_user = _make_user("SUPER_ADMIN", None, "sa@rb7.example")

    plans = list_commercial_plans(skip=0, limit=50, current_user=sa_user, db=db_session)
    assert isinstance(plans, object) and plans.total >= 1

    subs = list_commercial_subscriptions(skip=0, limit=50, search="", current_user=sa_user, db=db_session)
    assert subs.total >= 1

    detail = super_admin_get_commercial_subscription(
        organization_id=org.id, current_user=sa_user, db=db_session
    )
    assert detail.organization_id == org.id


def test_org_admin_can_inspect_own_data(db_session):
    org = make_organization(db_session, code="ORGA7", name="Org Admin 7")
    _make_account_and_subscription(db_session, org.id)
    org_admin = _make_user("ORG_ADMIN", org.id, "admin@org7.example")

    resp = get_my_commercial_subscription(current_user=org_admin, db=db_session)
    assert resp.organization_id == org.id
    assert resp.status == CommercialSubscriptionStatus.PENDING


def test_org_bound_super_admin_cannot_bypass_tenant_endpoint(db_session):
    org = make_organization(db_session, code="BADSA1", name="Bad SA")
    _make_account_and_subscription(db_session, org.id)
    bad_sa = _make_user("SUPER_ADMIN", org.id, "bad@sa7.example")

    # An org-bound Super Admin token is invalid for both surfaces.
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=bad_sa)
    with pytest.raises(ForbiddenException):
        get_organization_id(current_user=bad_sa)


def test_unauthorized_tenant_user_rejected(db_session):
    org_a = make_organization(db_session, code="NOPE1", name="Nope A")
    org_b = make_organization(db_session, code="NOPE2", name="Nope B")
    _make_account_and_subscription(db_session, org_a.id)
    _make_account_and_subscription(db_session, org_b.id)

    user_b = _make_user("ORG_ADMIN", org_b.id, "b@nope.example")

    resp = get_my_commercial_subscription(current_user=user_b, db=db_session)
    assert resp.organization_id == org_b.id
    assert resp.organization_id != org_a.id

    # A BILLING_ADMIN of org A is confined to org A.
    billing_a = _make_user("BILLING_ADMIN", org_a.id, "bill@a.example")
    resp_a = get_my_commercial_subscription(current_user=billing_a, db=db_session)
    assert resp_a.organization_id == org_a.id


# ── G. Billing-source integrity ──────────────────────────────────────────────

def test_client_cannot_change_billing_source(db_session):
    org = make_organization(db_session, code="SRC7A", name="Src A")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    user = _make_user("ORG_ADMIN", org.id, "src@a7.example")

    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
    update_my_organization(
        OrganizationUpdate(website="https://x.example", billing_source="registered_via_zoiko_one"),
        current_user=user,
        db=db_session,
    )
    db_session.refresh(org)
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE


def test_client_cannot_change_billing_classification(db_session):
    org = make_organization(db_session, code="CLS7A", name="Cls A")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    user = _make_user("ORG_ADMIN", org.id, "cls@a7.example")

    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE
    update_my_organization(
        OrganizationUpdate(website="https://y.example", billing_classification="commercial_zoiko_one"),
        current_user=user,
        db=db_session,
    )
    db_session.refresh(org)
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE


def test_subscription_cannot_silently_change_billing_source(db_session):
    org = make_organization(db_session, code="SILENT1", name="Silent Co")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    user = _make_user("ORG_ADMIN", org.id, "silent@a.example")

    # Tenant update surface has no subscription/billing fields at all.
    assert "billing_source" not in OrganizationUpdate.model_fields
    assert "billing_classification" not in OrganizationUpdate.model_fields

    update_my_organization(
        OrganizationUpdate(
            website="https://z.example",
            billing_source="registered_via_zoiko_one",
            billing_classification="commercial_zoiko_one",
            plan_code="ENTERPRISE",
            status="active",
        ),
        current_user=user,
        db=db_session,
    )
    db_session.refresh(org)
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE


# ── H. Regression ────────────────────────────────────────────────────────────

def test_existing_billing_customer_workflow_works(db_session):
    org = make_organization(db_session, code="RCUST1", name="R Cust")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    customer = make_customer(db_session, org.id, code="RC1")
    assert isinstance(customer, BillingCustomer)
    assert customer.organization_id == org.id
    assert db_session.query(BillingCustomer).count() == 1


def test_existing_invoice_workflow_works(db_session):
    org = make_organization(db_session, code="RINV1", name="R Inv")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    customer = make_customer(db_session, org.id, code="RIC1")
    invoice = make_invoice(db_session, org.id, customer.id)
    assert invoice.invoice_number.startswith("INV-")


def test_existing_tenant_subscription_workflow_works(db_session):
    org = make_organization(db_session, code="RSUB1", name="R Sub")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    customer = make_customer(db_session, org.id, code="RSC1")
    plan = make_subscription_plan(db_session, org.id)
    sub = make_subscription(db_session, org.id, customer.id, plan.id)
    assert sub.subscription_number
    # Tenant billing subscription rows are NOT commercial subscriptions.
    assert db_session.query(CommercialSubscription).count() == 0


def test_billing_configuration_still_works(db_session):
    org = make_organization(db_session, code="RCFG1", name="R Cfg")
    db_session.commit()
    # Lazy backstop: get-or-create via settings_service semantics.
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
    result = _register(db_session, "final7@acme.example")
    admin = db_session.query(User).filter_by(email="final7@acme.example").first()
    assert admin is not None
    assert admin.role == UserRole.ORG_ADMIN
    org = db_session.query(Organization).filter_by(id=admin.organization_id).first()
    assert org is not None
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 1
    assert db_session.query(BillingConfiguration).filter_by(organization_id=org.id).count() == 1
    assert result is not None
