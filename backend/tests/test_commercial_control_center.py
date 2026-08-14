"""
PHASE 9 tests — Standalone Billing Super Admin Management & Commercial Control
Center.

Coverage (30 tests):
  1-9    Consolidated Commercial Organization view (org identity, account +
         can_charge + current subscription, billing configuration, current
         subscription + plan, subscription history, entitlements, 404,
         empty-safe no-subscription, empty-safe no-entitlement-data).
  10-15  Account management additions (list/detail can_charge +
         current_subscription, latest-open-subscription resolution, terminal-
         only accounts).
  16-17  Charging-readiness (can_charge) by server-stamped billing source.
  18-19  BillingConfiguration vs CommercialSubscription independence.
  20-21  RBAC / tenant isolation on the consolidated view.
  22-28  Audit logging via the existing org-scoped BillingAuditLog (create /
         transition / actor / organization / entity / rejected-transition /
         one-row-per-action).
  29     Entitlement admin view empty-safe.
  30     Regression: Phase 8 plan + subscription management still work.

Handlers/dependencies are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL. conftest is untouched.
"""
import pytest

from app.core.dependencies import get_current_super_admin
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import BillingAuditAction, BillingAuditLog, BillingConfiguration
from app.modules.commercial.enums import (
    BillingSource,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialAccount, CommercialPlan, CommercialSubscription
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.super_admin.router import (
    create_commercial_plan,
    create_commercial_subscription,
    get_commercial_account as sa_get_commercial_account,
    get_commercial_organization_detail,
    list_commercial_accounts,
    set_commercial_plan_default,
    set_commercial_plan_status,
    set_commercial_subscription_status,
)
from tests.conftest import make_organization


# ── helpers ─────────────────────────────────────────────────────────────────

class _CreateSubSchema:
    def __init__(self, **kwargs):
        self.status = CommercialSubscriptionStatus.PENDING
        for key, value in kwargs.items():
            setattr(self, key, value)

    def model_dump(self):
        return {k: getattr(self, k) for k in ("organization_id", "plan_id", "status") if hasattr(self, k)}


class _StatusSchema:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class _PlanSchema:
    def __init__(self, **kwargs):
        self._data = kwargs

    def model_dump(self):
        return dict(self._data)


def _sa_user():
    return User(
        email="sa@cc9.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )


def _sa_user_persisted(db):
    user = _sa_user()
    db.add(user)
    db.flush()
    return user


def _org(db, code="CC9", source=BillingSource.REGISTERED_VIA_STANDALONE):
    org = make_organization(db, code=code, name=f"Org {code}")
    org.billing_source = source
    db.commit()
    return org


def _plan(db, code="CC9PLAN", features=None, max_users=None, max_storage_gb=None):
    plan = CommercialPlanService(db).create_plan(
        plan_code=code,
        plan_name=f"Plan {code}",
        features=features,
        max_users=max_users,
        max_storage_gb=max_storage_gb,
    )
    db.commit()
    return plan


def _open_subscription(db, org_id, plan_id, actor=None):
    return create_commercial_subscription(
        data=_CreateSubSchema(organization_id=org_id, plan_id=plan_id),
        current_user=actor or _sa_user(),
        db=db,
    )


def _open_org(db, code="CC9"):
    org = _org(db, code=code)
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    plan = _plan(db, code=f"{code}PLAN")
    sub = _open_subscription(db, org.id, plan.id)
    return org, account, plan, sub


# ── 1-9 Consolidated Commercial Organization view ───────────────────────────

def test_consolidated_view_returns_org_identity(db_session):
    org, _, _, _ = _open_org(db_session, "VW1")
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.organization_id == org.id
    assert result.organization_code == "VW1"
    assert result.organization_name == "Org VW1"
    assert result.is_active is True
    assert result.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
    assert result.can_charge is True


def test_consolidated_view_returns_account_with_can_charge_and_subscription(db_session):
    org, account, plan, sub = _open_org(db_session, "VW2")
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.account.id == account.id
    assert result.account.organization_id == org.id
    assert result.account.can_charge is True
    assert result.account.current_subscription is not None
    assert result.account.current_subscription.id == sub.id
    assert result.account.current_subscription.plan_code == plan.plan_code


def test_consolidated_view_returns_billing_configuration_summary(db_session):
    org, _, _, _ = _open_org(db_session, "VW3")
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    config = db_session.query(BillingConfiguration).filter_by(organization_id=org.id).first()
    assert config is not None
    assert result.billing_configuration is not None
    assert result.billing_configuration.id == config.id
    assert result.billing_configuration.company_name == org.organization_name
    assert result.billing_configuration.default_currency in ("USD", None)
    assert result.billing_configuration.invoice_prefix == "INV-"


def test_consolidated_view_returns_current_subscription_and_plan(db_session):
    org, _, plan, sub = _open_org(db_session, "VW4")
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.current_subscription is not None
    assert result.current_subscription.id == sub.id
    assert result.current_subscription.commercial_plan_id == plan.id
    assert result.plan is not None
    assert result.plan.id == plan.id
    assert result.plan.plan_code == plan.plan_code
    assert result.plan.plan_name == plan.plan_name


def test_consolidated_view_returns_subscription_history(db_session):
    org, _, plan, sub1 = _open_org(db_session, "VW5")
    set_commercial_subscription_status(
        subscription_id=sub1.id,
        data=_StatusSchema(status=CommercialSubscriptionStatus.CANCELLED),
        current_user=_sa_user(),
        db=db_session,
    )
    sub2 = _open_subscription(db_session, org.id, plan.id)
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert [s.id for s in result.subscription_history] == [sub2.id, sub1.id]
    assert result.subscription_history[0].status == CommercialSubscriptionStatus.PENDING
    assert result.subscription_history[1].status == CommercialSubscriptionStatus.CANCELLED


def test_consolidated_view_returns_entitlements(db_session):
    org = _org(db_session, "VW6")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    plan = _plan(
        db_session, "VW6PLAN",
        features={"audit": True, "multi_currency": False},
        max_users=25, max_storage_gb=100,
    )
    _open_subscription(db_session, org.id, plan.id)
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.entitlements["plan"]["plan_code"] == "VW6PLAN"
    assert result.entitlements["limits"]["max_users"] == 25
    assert result.entitlements["limits"]["max_storage_gb"] == 100
    assert result.entitlements["features"]["audit"] is True
    assert result.entitlements["features"]["multi_currency"] is False


def test_consolidated_view_missing_organization_raises_not_found(db_session):
    with pytest.raises(NotFoundException):
        get_commercial_organization_detail(
            organization_id=999999, current_user=_sa_user(), db=db_session
        )


def test_consolidated_view_empty_safe_without_subscription(db_session):
    org = _org(db_session, "VW8")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.account is not None
    assert result.current_subscription is None
    assert result.plan is None
    assert result.subscription_history == []
    assert result.entitlements == {"plan": None, "limits": {}, "features": {}}
    # The operational configuration is still seeded independently.
    assert result.billing_configuration is not None


def test_consolidated_view_empty_safe_without_entitlement_data(db_session):
    org = _org(db_session, "VW9")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    plan = _plan(db_session, "VW9PLAN")
    _open_subscription(db_session, org.id, plan.id)
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.entitlements["plan"]["plan_code"] == "VW9PLAN"
    assert result.entitlements["limits"]["max_users"] is None
    assert result.entitlements["limits"]["max_storage_gb"] is None
    assert result.entitlements["features"] == {}


# ── 10-15 Account management additions ─────────────────────────────────────

def test_account_list_includes_can_charge(db_session):
    org, _, _, _ = _open_org(db_session, "ACC10")
    result = list_commercial_accounts(
        skip=0, limit=50, search="ACC10", current_user=_sa_user(), db=db_session
    )
    assert result.total == 1
    assert result.accounts[0].organization_id == org.id
    assert result.accounts[0].can_charge is True


def test_account_list_includes_current_subscription(db_session):
    _, _, plan, sub = _open_org(db_session, "ACC11")
    result = list_commercial_accounts(
        skip=0, limit=50, search="ACC11", current_user=_sa_user(), db=db_session
    )
    summary = result.accounts[0].current_subscription
    assert summary is not None
    assert summary.id == sub.id
    assert summary.plan_code == plan.plan_code
    assert summary.status == CommercialSubscriptionStatus.PENDING


def test_account_detail_includes_can_charge(db_session):
    org, _, _, _ = _open_org(db_session, "ACC12")
    detail = sa_get_commercial_account(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert detail.organization_id == org.id
    assert detail.can_charge is True


def test_account_detail_includes_current_subscription(db_session):
    org, _, _, _ = _open_org(db_session, "ACC13")
    detail = sa_get_commercial_account(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert detail.current_subscription is not None
    assert detail.current_subscription.plan_code == "ACC13PLAN"


def test_current_subscription_reflects_latest_open_subscription(db_session):
    org, _, plan, sub1 = _open_org(db_session, "ACC14")
    set_commercial_subscription_status(
        subscription_id=sub1.id,
        data=_StatusSchema(status=CommercialSubscriptionStatus.CANCELLED),
        current_user=_sa_user(),
        db=db_session,
    )
    sub2 = _open_subscription(db_session, org.id, plan.id)
    detail = sa_get_commercial_account(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert detail.current_subscription.id == sub2.id


def test_current_subscription_none_when_only_terminal_subs(db_session):
    org, _, _, sub1 = _open_org(db_session, "ACC15")
    set_commercial_subscription_status(
        subscription_id=sub1.id,
        data=_StatusSchema(status=CommercialSubscriptionStatus.CANCELLED),
        current_user=_sa_user(),
        db=db_session,
    )
    detail = sa_get_commercial_account(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert detail.current_subscription is None


# ── 16-17 Charging readiness by billing source ─────────────────────────────

def test_can_charge_true_for_standalone_registration(db_session):
    org, _, _, _ = _open_org(db_session, "CHAR16")
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.can_charge is True
    assert result.account.can_charge is True


def test_can_charge_false_for_zoiko_one_registration(db_session):
    org = _org(db_session, "CHAR17", source=BillingSource.REGISTERED_VIA_ZOIKO_ONE)
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    # Zoiko One is the billing owner — the standalone platform must NOT charge.
    assert result.can_charge is False
    assert result.account.can_charge is False


# ── 18-19 BillingConfiguration independence ────────────────────────────────

def test_billing_configuration_seeded_independently_of_subscription(db_session):
    org = _org(db_session, "CFG18")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    # No subscription exists, yet the operational configuration was still
    # seeded — they are unrelated structures on purpose.
    assert result.current_subscription is None
    assert result.billing_configuration is not None


def test_billing_configuration_distinct_from_commercial_subscription(db_session):
    org, _, plan, sub = _open_org(db_session, "CFG19")
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    config = db_session.query(BillingConfiguration).filter_by(organization_id=org.id).first()
    assert config is not None
    # The subscription references the plan, not the configuration, and the
    # configuration is org-identity-derived, not plan-identity-derived.
    assert result.billing_configuration.id == config.id
    assert result.current_subscription.commercial_plan_id == plan.id
    assert result.plan.id == plan.id
    assert result.billing_configuration.company_name == org.organization_name
    assert result.billing_configuration.company_name != plan.plan_name
    # No plan identity leaks into the operational configuration.
    assert result.billing_configuration.invoice_prefix != plan.plan_code
    assert result.billing_configuration.tax_number is None
    assert sub.status == CommercialSubscriptionStatus.PENDING


# ── 20-21 RBAC / tenant isolation ──────────────────────────────────────────

def test_consolidated_view_rejects_non_super_admin(db_session):
    tenant = User(
        email="org@cc9.example",
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=1,
        first_name="T",
        last_name="U",
        phone="",
        is_active=True,
        is_verified=True,
    )
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=tenant)


def test_tenant_cannot_access_consolidated_view(db_session):
    org, _, _, _ = _open_org(db_session, "RBAC21")
    org_admin = User(
        email="admin@rbac21.example",
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=org.id,
        first_name="O",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )
    # The authorization dependency blocks the tenant before the handler runs.
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=org_admin)


# ── 22-28 Audit logging (org-scoped BillingAuditLog reuse) ─────────────────

def test_create_subscription_writes_audit_log(db_session):
    org = _org(db_session, "AUD22")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    plan = _plan(db_session, "AUD22PLAN")
    _open_subscription(db_session, org.id, plan.id)
    logs = (
        db_session.query(BillingAuditLog)
        .filter_by(entity_type="CommercialSubscription")
        .all()
    )
    assert len(logs) == 1
    assert logs[0].action == BillingAuditAction.CREATE


def test_status_transition_writes_audit_log(db_session):
    org, _, _, sub = _open_org(db_session, "AUD23")
    set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(status=CommercialSubscriptionStatus.ACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    logs = (
        db_session.query(BillingAuditLog)
        .filter_by(entity_type="CommercialSubscription")
        .all()
    )
    assert len(logs) == 2
    assert logs[0].action == BillingAuditAction.CREATE
    assert logs[1].action == BillingAuditAction.UPDATE


def test_audit_log_records_actor_id(db_session):
    org = _org(db_session, "AUD24")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    plan = _plan(db_session, "AUD24PLAN")
    admin = _sa_user_persisted(db_session)
    _open_subscription(db_session, org.id, plan.id, actor=admin)
    log = (
        db_session.query(BillingAuditLog)
        .filter_by(entity_type="CommercialSubscription")
        .first()
    )
    assert log.actor_id == admin.id


def test_audit_log_records_organization_id(db_session):
    org, _, _, _ = _open_org(db_session, "AUD25")
    log = (
        db_session.query(BillingAuditLog)
        .filter_by(entity_type="CommercialSubscription")
        .first()
    )
    assert log.organization_id == org.id


def test_audit_log_records_entity_and_action(db_session):
    org, _, _, sub = _open_org(db_session, "AUD26")
    log = (
        db_session.query(BillingAuditLog)
        .filter_by(entity_type="CommercialSubscription")
        .first()
    )
    assert log.entity_type == "CommercialSubscription"
    assert log.entity_id == sub.id
    assert log.action == BillingAuditAction.CREATE
    assert log.new_values.get("plan_id") == sub.commercial_plan_id


def test_rejected_transition_writes_no_audit_log(db_session):
    org, _, _, sub = _open_org(db_session, "AUD27")
    before = db_session.query(BillingAuditLog).count()
    # ACTIVE -> PENDING is an illegal transition (state machine rejects it).
    with pytest.raises(BadRequestException):
        set_commercial_subscription_status(
            subscription_id=sub.id,
            data=_StatusSchema(status=CommercialSubscriptionStatus.PENDING),
            current_user=_sa_user(),
            db=db_session,
        )
    assert db_session.query(BillingAuditLog).count() == before


def test_audit_log_entries_are_transactional(db_session):
    org, _, _, sub = _open_org(db_session, "AUD28")
    set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(status=CommercialSubscriptionStatus.ACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    logs = (
        db_session.query(BillingAuditLog)
        .filter_by(entity_type="CommercialSubscription", entity_id=sub.id)
        .order_by(BillingAuditLog.id)
        .all()
    )
    # Exactly one row per successful action: create + activate.
    assert len(logs) == 2
    assert [log.action for log in logs] == [
        BillingAuditAction.CREATE,
        BillingAuditAction.UPDATE,
    ]


# ── 29 Entitlement admin view empty-safe ───────────────────────────────────

def test_entitlement_admin_view_empty_safe(db_session):
    org = _org(db_session, "ENT29")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.entitlements == {"plan": None, "limits": {}, "features": {}}
    # Service-level safety checks remain non-raising.
    from app.modules.commercial.service import CommercialEntitlementService

    svc = CommercialEntitlementService(db_session)
    assert svc.is_entitled(org.id, "anything") is False
    assert svc.get_limit(org.id, "max_users") is None


# ── 30 Regression: Phase 8 management surface intact ───────────────────────

def test_plan_subscription_management_still_works(db_session):
    org = _org(db_session, "REG30")
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()

    plan = create_commercial_plan(
        data=_PlanSchema(plan_code="REG30PLAN", plan_name="Reg Plan"),
        current_user=_sa_user(),
        db=db_session,
    )
    plan_row = db_session.query(CommercialPlan).filter_by(id=plan.id).first()
    assert plan_row.status == CommercialPlanStatus.ACTIVE

    set_commercial_plan_default(
        plan_id=plan.id,
        data=_StatusSchema(is_default=True),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(plan_row)
    assert plan_row.is_default is True

    sub = _open_subscription(db_session, org.id, plan.id)
    set_commercial_subscription_status(
        subscription_id=sub.id,
        data=_StatusSchema(status=CommercialSubscriptionStatus.ACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    sub_row = db_session.query(CommercialSubscription).filter_by(id=sub.id).first()
    assert sub_row.status == CommercialSubscriptionStatus.ACTIVE

    # The consolidated view reflects the fully-managed state.
    result = get_commercial_organization_detail(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert result.plan.plan_code == "REG30PLAN"
    assert result.current_subscription.status == CommercialSubscriptionStatus.ACTIVE
    assert result.account.current_subscription.status == CommercialSubscriptionStatus.ACTIVE
