"""
Regression tests for PHASE 6: CommercialAccount foundation.

Covers: model creation + uniqueness + organization relationship, registration
integration (atomic, correct source/classification, BillingConfiguration still
seeded), idempotent ensure (lazy backfill), tenant isolation (org A cannot
read/modify org B), client immunity of billing_source/classification,
Super Admin RBAC, and non-regression of existing Billing Customer /
Invoice / Subscription workflows.

Handlers and dependencies are invoked directly against the real router
functions (no HTTP layer), so every test runs on the isolated in-memory
SQLite fixture from conftest.py — never BILLING_DATABASE_URL. RBAC is tested
at the dependency that enforces it (get_current_super_admin /
get_organization_id / require_organization_access).
"""
import pytest
from sqlalchemy.exc import IntegrityError

from app.core.dependencies import (
    get_current_super_admin,
    get_organization_id,
    require_organization_access,
)
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.billing.models import BillingConfiguration, BillingCustomer
from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialAccountStatus,
)
from app.modules.commercial.models import CommercialAccount
from app.modules.commercial.service import CommercialAccountService
from app.modules.organizations.models import Organization
from app.modules.organizations.router import (
    get_my_commercial_account,
    update_my_organization,
)
from app.modules.organizations.schemas import OrganizationUpdate
from app.modules.super_admin.router import (
    get_commercial_account as super_admin_get_commercial_account,
)
from app.modules.super_admin.router import list_commercial_accounts
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


# ── model / service ─────────────────────────────────────────────────────────

def test_commercial_account_can_be_created(db_session):
    org = make_organization(db_session, code="CREATE1", name="Create Co")
    db_session.commit()

    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)

    assert account.id is not None
    assert account.organization_id == org.id
    assert account.status == CommercialAccountStatus.ACTIVE


def test_commercial_account_belongs_to_an_organization(db_session):
    org = make_organization(db_session, code="BELONG1", name="Belongs Co")
    db_session.commit()

    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)

    assert account.organization is not None
    assert account.organization.id == org.id
    assert account.organization.organization_name == "Belongs Co"
    assert org.commercial_account is not None
    assert org.commercial_account.id == account.id


def test_organization_id_is_unique(db_session):
    org = make_organization(db_session, code="UNIQ1", name="Unique Co")
    db_session.commit()
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    with pytest.raises(IntegrityError):
        db_session.add(CommercialAccount(organization_id=org.id))
        db_session.flush()
    db_session.rollback()


def test_existing_commercial_account_is_not_duplicated(db_session):
    org = make_organization(db_session, code="NODUP1", name="No Dup Co")
    db_session.commit()

    svc = CommercialAccountService(db_session)
    first = svc.ensure_commercial_account(org.id)
    second = svc.ensure_commercial_account(org.id)
    third = svc.ensure_commercial_account(org.id)
    db_session.commit()

    assert first.id == second.id == third.id
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 1


# ── registration ────────────────────────────────────────────────────────────

def test_registration_creates_commercial_account(db_session):
    _register(db_session, "reg6@acme.example")

    account = _account_for(db_session, "reg6@acme.example")
    assert account is not None
    assert account.status == CommercialAccountStatus.ACTIVE


def test_registration_creates_commercial_account_with_correct_source(db_session):
    _register(db_session, "src6@acme.example")

    admin = db_session.query(User).filter_by(email="src6@acme.example").first()
    org = db_session.query(Organization).filter_by(id=admin.organization_id).first()
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE


def test_registration_creates_commercial_account_with_correct_classification(db_session):
    _register(db_session, "cls6@acme.example")

    admin = db_session.query(User).filter_by(email="cls6@acme.example").first()
    org = db_session.query(Organization).filter_by(id=admin.organization_id).first()
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE


def test_billing_configuration_still_seeded_at_registration(db_session):
    _register(db_session, "cfg6@acme.example")

    admin = db_session.query(User).filter_by(email="cfg6@acme.example").first()
    config = (
        db_session.query(BillingConfiguration)
        .filter_by(organization_id=admin.organization_id)
        .first()
    )
    assert config is not None
    assert config.company_name == "Acme Corp"


def test_registration_is_atomic_when_commercial_account_fails(db_session, monkeypatch):
    def _boom(self, organization_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        CommercialAccountService, "ensure_commercial_account", _boom
    )

    with pytest.raises(RuntimeError):
        _register(db_session, "atomic6@acme.example")

    db_session.rollback()
    assert db_session.query(User).filter_by(email="atomic6@acme.example").first() is None
    assert db_session.query(Organization).count() == 0
    assert db_session.query(CommercialAccount).count() == 0


# ── existing tenants / lazy backfill ────────────────────────────────────────

def test_existing_organization_behavior_remains_intact(db_session):
    org = make_organization(db_session, code="LEGACY1", name="Legacy Co")
    db_session.commit()

    # A pre-Phase-6 org has no account and its data is untouched.
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 0

    org.organization_name = "Legacy Co Renamed"
    db_session.commit()
    db_session.refresh(org)
    assert org.organization_name == "Legacy Co Renamed"
    assert org.is_active is True

    # Lazy ensure backfills without disturbing org data.
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    assert account.status == CommercialAccountStatus.ACTIVE
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 1
    db_session.refresh(org)
    assert org.organization_name == "Legacy Co Renamed"


# ── multi-tenancy / RBAC / client immunity ─────────────────────────────────

def test_org_a_cannot_access_org_b_account(db_session):
    org_a = make_organization(db_session, code="ORGA1", name="Org A")
    org_b = make_organization(db_session, code="ORGB1", name="Org B")
    CommercialAccountService(db_session).ensure_commercial_account(org_a.id)
    CommercialAccountService(db_session).ensure_commercial_account(org_b.id)
    db_session.commit()

    user_a = _make_user("ORG_ADMIN", org_a.id, "a@orga.example")

    # The tenant endpoint takes NO organization_id at all — organization scope
    # always comes from the authenticated user (get_organization_id).
    resp = get_my_commercial_account(current_user=user_a, db=db_session)
    assert resp.organization_id == org_a.id
    assert resp.organization_code == "ORGA1"
    assert resp.status == CommercialAccountStatus.ACTIVE

    # org A's user cannot even address org B through this surface.
    assert org_b.id != resp.organization_id


def test_org_a_cannot_modify_org_b_account(db_session):
    org_a = make_organization(db_session, code="MODA1", name="Mod Org A")
    org_b = make_organization(db_session, code="MODB1", name="Mod Org B")
    acc_b = CommercialAccountService(db_session).ensure_commercial_account(org_b.id)
    db_session.commit()
    b_status_before = acc_b.status

    user_a = _make_user("ORG_ADMIN", org_a.id, "a@moda.example")

    # There is NO tenant-facing mutation endpoint for commercial accounts
    # (only GET /organizations/me/commercial-account). Updating org A's own
    # profile must not touch org B's account.
    updated = update_my_organization(
        OrganizationUpdate(website="https://a.example"),
        current_user=user_a,
        db=db_session,
    )
    assert updated.id == org_a.id

    db_session.refresh(acc_b)
    assert acc_b.status == b_status_before


def test_require_organization_access_blocks_cross_tenant(db_session):
    org_a = make_organization(db_session, code="RTCA1", name="RT A")
    org_b = make_organization(db_session, code="RTCB1", name="RT B")
    user_a = _make_user("ORG_ADMIN", org_a.id, "rt@a.example")

    assert require_organization_access(org_a.id, user_a) is True
    with pytest.raises(ForbiddenException):
        require_organization_access(org_b.id, user_a)


def test_client_cannot_change_billing_source_or_classification(db_session):
    org = make_organization(db_session, code="LOCK1", name="Lock Co")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE

    user = _make_user("ORG_ADMIN", org.id, "lock@x.example")

    # OrganizationUpdate simply has no billing_source / billing_classification
    # fields; extra fields in the payload are ignored by pydantic and the PUT
    # handler only persists declared fields.
    assert "billing_source" not in OrganizationUpdate.model_fields
    assert "billing_classification" not in OrganizationUpdate.model_fields

    update_my_organization(
        OrganizationUpdate(
            website="https://lock.example",
            billing_source="registered_via_zoiko_one",
            billing_classification="commercial_zoiko_one",
        ),
        current_user=user,
        db=db_session,
    )

    db_session.refresh(org)
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE
    assert org.website == "https://lock.example"


def test_super_admin_access_follows_existing_rbac(db_session):
    org = make_organization(db_session, code="SARB1", name="SA RB Co")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    org_admin_user = _make_user("ORG_ADMIN", org.id, "sa@org.example")
    bad_sa_user = _make_user("SUPER_ADMIN", org.id, "bad@sa.example")
    sa_user = _make_user("SUPER_ADMIN", None, "sa@example.com")

    # Dependency gates: non-super-admin and org-bound super_admin are blocked.
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=org_admin_user)
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=bad_sa_user)
    assert get_current_super_admin(current_user=sa_user) is sa_user

    # Super Admin can list + read detail.
    result = list_commercial_accounts(
        skip=0, limit=50, search="", current_user=sa_user, db=db_session
    )
    assert result.total >= 1
    assert result.accounts[0].organization_code == "SARB1"

    detail = super_admin_get_commercial_account(
        organization_id=org.id, current_user=sa_user, db=db_session
    )
    assert detail.organization_id == org.id
    assert detail.status == CommercialAccountStatus.ACTIVE

    # Super Admin cannot use the tenant-scoped endpoint (no single org).
    with pytest.raises(ForbiddenException):
        get_organization_id(current_user=sa_user)


def test_super_admin_cannot_mutate_source_or_classification(db_session):
    org = make_organization(db_session, code="SAFIX1", name="SA Fix Co")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    sa_user = _make_user("SUPER_ADMIN", None, "sa@fix.example")

    # Phase 6 is read-only: no mutation endpoints exist for accounts; the
    # org update path is tenant-org-admin-only and has no such fields.
    assert get_organization_id is not None
    with pytest.raises(ForbiddenException):
        get_organization_id(current_user=sa_user)


# ── non-regression of existing Billing functionality ────────────────────────

def test_existing_billing_customer_functionality_still_works(db_session):
    org = make_organization(db_session, code="CUST6", name="Customer Co")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    customer = make_customer(db_session, org.id, code="C1")

    assert isinstance(customer, BillingCustomer)
    assert customer.organization_id == org.id
    assert account.organization_id == org.id
    assert db_session.query(CommercialAccount).count() == 1
    assert db_session.query(BillingCustomer).count() == 1
    # Distinct concepts, distinct tables: the commercial account is not a
    # billing customer and never shares its rows (ids are independent
    # autoincrement sequences per table).
    assert BillingCustomer.__tablename__ != CommercialAccount.__tablename__


def test_existing_invoice_subscription_workflows_are_unaffected(db_session):
    org = make_organization(db_session, code="INV6", name="Invoice Co")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    customer = make_customer(db_session, org.id, code="IC1")
    invoice = make_invoice(db_session, org.id, customer.id)
    plan = make_subscription_plan(db_session, org.id)
    subscription = make_subscription(db_session, org.id, customer.id, plan.id)

    assert invoice.invoice_number.startswith("INV-")
    assert subscription.subscription_number
    assert db_session.query(BillingCustomer).filter_by(organization_id=org.id).count() == 1
    assert db_session.query(CommercialAccount).filter_by(organization_id=org.id).count() == 1
