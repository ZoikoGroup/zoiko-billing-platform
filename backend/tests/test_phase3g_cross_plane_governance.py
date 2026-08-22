"""
PHASE 3G tests — cross-plane governance, JIT hardening and auditability.

Plane definitions enforced here:
  Plane 1 (SaaS administration) = commercial_* tables
  Plane 2 (tenant revenue ops)  = billing module tables (invoices, payments,
                                  tenant subscriptions)
  Domain C (telemetry)          = counts/states only, never currency

Covers:
  - isolation in BOTH directions: Plane 2 data cannot move Plane 1 numbers
    (reporting MRR/counts), and Plane 1 read models never carry monetary
    fields even when invoices/payments exist for the same organizations
  - cross-plane authorization gates and IDOR guards on the new endpoints
  - JIT privileged access hardening (duration cap, no reuse after exit,
    mid-session expiry, MFA-locked step-up)
  - auditability (correlated plan-change audit without secrets; invite
    links/tokens never land in the platform audit trail)
  - maker-checker (self-approval refused at catalog publish)
  - bounded query counts for the directory and reporting read models

Handlers/dependencies are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta
from decimal import Decimal

import pyotp
import pytest
from sqlalchemy import event, text

from app.core.dependencies import get_current_super_admin, get_organization_id
from app.core.exceptions import (
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
)
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth import mfa_service
from app.modules.auth.models import SuperAdminMFA, User, UserRole
from app.modules.billing.models import BillingAuditLog, InvoiceStatus, PaymentStatus
from app.modules.commercial.enums import (
    CommercialPlanVersionStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialSubscription
from app.modules.commercial.service import CommercialSubscriptionService
from app.modules.organizations.models import TenantLifecycleState
from app.modules.super_admin.approval_service import SelfApprovalError
from app.modules.super_admin.lifecycle_service import TenantLifecycleService
from app.modules.super_admin.organization_service import OrganizationDirectoryService
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.super_admin.privileged_access_service import (
    MAX_GRANT_MINUTES,
    PrivilegedAccessService,
    PrivilegedAccessStatus,
)
from app.modules.super_admin.saas_reporting_service import SaasReportingService
from app.modules.super_admin.router import (
    change_commercial_subscription_plan,
    create_commercial_subscription,
    list_commercial_subscriptions,
)
from app.modules.super_admin.user_admin_service import UserAdminService

from tests.conftest import (
    make_customer,
    make_invoice,
    make_organization,
    make_payment,
    make_subscription,
    make_subscription_plan,
)
from tests.test_commercial_subscription_management import (
    _CreateSchema,
    _org_with_plan,
    _org_user,
    _sa_user,
)


# ── helpers ──────────────────────────────────────────────────────────────────


class _PlanChangeSchema:
    def __init__(self, new_plan_id, reason="Phase 3G probe"):
        self.new_plan_id = new_plan_id
        self.reason = reason


def _open_sub(db, org, plan):
    created = create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db,
    )
    return db.query(CommercialSubscription).get(created.id)


def _activate(db, sub):
    CommercialSubscriptionService(db).transition(sub, CommercialSubscriptionStatus.ACTIVE)


def _seed_plane2_noise(db, org, suffix=""):
    """Real Domain B rows that must never influence Plane 1 read models."""
    customer = make_customer(db, organization_id=org.id, code=f"C-{org.id}{suffix}")
    make_invoice(
        db, organization_id=org.id, customer_id=customer.id,
        status=InvoiceStatus.SENT, total_amount="100.00",
        invoice_number=f"INV{suffix}-{org.id}-A",
    )
    make_invoice(
        db, organization_id=org.id, customer_id=customer.id,
        status=InvoiceStatus.PAID, total_amount="250.00", paid_amount="250.00",
        invoice_number=f"INV{suffix}-{org.id}-B",
    )
    make_payment(
        db, organization_id=org.id, customer_id=customer.id,
        amount="500.00", status=PaymentStatus.CLEARED,
    )
    plan2 = make_subscription_plan(db, organization_id=org.id, code=f"P2-{org.id}")
    make_subscription(
        db, organization_id=org.id, customer_id=customer.id, plan_id=plan2.id,
        unit_price="77.00",
    )
    db.flush()


_MONETARY_MARKERS = (
    "amount", "mrr", "revenue", "price", "paid", "balance_due",
    "total_due", "cost",
)

_SECRET_MARKERS = ("password", "token_urlsafe", "secret_encrypted", "hashed_password")


def _assert_no_monetary_keys(payload, path="root"):
    """Recursively assert a payload carries no monetary field NAMES."""
    if isinstance(payload, dict):
        for key, value in payload.items():
            lowered = str(key).lower()
            assert not any(marker in lowered for marker in _MONETARY_MARKERS), (
                f"monetary field leaked into identity-plane payload: {path}.{key}"
            )
            _assert_no_monetary_keys(value, f"{path}.{key}")
    elif isinstance(payload, list):
        for index, item in enumerate(payload):
            _assert_no_monetary_keys(item, f"{path}[{index}]")


def _audit_blob(row) -> str:
    parts = [
        row.old_values, row.new_values, getattr(row, "metadata_", None),
        getattr(row, "reason", None),
    ]
    return str(parts).lower()


@contextmanager
def _count_selects(db):
    counter = {"select": 0}

    def _before(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            counter["select"] += 1

    event.listen(db.bind, "before_cursor_execute", _before)
    try:
        yield counter
    finally:
        event.remove(db.bind, "before_cursor_execute", _before)


def _jit_super_admin(db, email):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="J", last_name="T",
        is_active=True, is_verified=True,
    )
    db.add(user)
    db.flush()
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.flush()
    return user, secret


# ═══════════════════════════════════════════════════════════════════════════
# A — plane isolation, both directions
# ═══════════════════════════════════════════════════════════════════════════


def test_plane2_data_cannot_move_plane1_numbers(db_session):
    from tests.test_phase3f_saas_plane1 import _publish_version

    org, plan, _account = _org_with_plan(db_session, "G1A", "G1APLAN")
    sub = _open_sub(db_session, org, plan)
    priced = _publish_version(db_session, plan, amount=Decimal("50.00"))
    sub.catalog_version_id = priced.id
    db_session.flush()

    report = SaasReportingService(db_session).get_reporting()
    assert report["subscriptions"]["total_open"] == 1
    assert report["mrr"]["state"] == "computed"
    assert report["mrr"]["amount"] == Decimal("50.00")

    # Hundreds of dollars of Plane 2 activity across two organizations.
    _seed_plane2_noise(db_session, org, "-x")
    other = make_organization(db_session, code="G1B", name="Other Org")
    db_session.flush()
    _seed_plane2_noise(db_session, other, "-y")
    db_session.commit()

    after = SaasReportingService(db_session).get_reporting()
    assert after["subscriptions"]["total_open"] == 1
    assert after["mrr"]["state"] == "computed"
    assert after["mrr"]["amount"] == Decimal("50.00")


def test_plane1_subscription_list_excludes_tenant_subscriptions(db_session):
    org, plan, _account = _org_with_plan(db_session, "G2A", "G2APLAN")
    created = _open_sub(db_session, org, plan)
    _seed_plane2_noise(db_session, org)
    db_session.commit()

    response = list_commercial_subscriptions(
        skip=0, limit=50, current_user=_sa_user(), db=db_session
    )

    tenant_ids = db_session.execute(text("SELECT id FROM subscriptions")).scalars().all()
    assert len(tenant_ids) == 1, "tenant subscription row must exist for this probe"
    # Exactly one Plane 1 row comes back even though a same-id tenant
    # subscription exists: the read model never unions across planes.
    assert [item.id for item in response.subscriptions] == [created.id]
    assert response.total == 1
    assert all(
        item.commercial_plan_id == plan.id for item in response.subscriptions
    )


def test_directory_payload_is_identity_and_counts_only(db_session):
    org, plan, _account = _org_with_plan(db_session, "G3", "G3PLAN")
    sub = _open_sub(db_session, org, plan)
    _activate(db_session, db_session.query(CommercialSubscription).get(sub.id))
    _seed_plane2_noise(db_session, org)
    db_session.commit()

    result = OrganizationDirectoryService(db_session).list_organizations(limit=10)
    assert result["total"] == 1
    _assert_no_monetary_keys(result["organizations"])

    overview = OrganizationDirectoryService(db_session).get_organization_overview(org.id)
    _assert_no_monetary_keys(overview)


# ═══════════════════════════════════════════════════════════════════════════
# B — cross-plane authorization / lifecycle guardrails
# ═══════════════════════════════════════════════════════════════════════════


def test_tenant_actor_rejected_by_super_admin_gate(db_session):
    org = make_organization(db_session, code="G4")
    db_session.commit()
    intruder = _org_user("ORG_ADMIN", org.id, "admin@g4.example")

    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=intruder)


def test_super_admin_rejected_by_tenant_scope_dependency(db_session):
    sa = _sa_user()
    with pytest.raises((ForbiddenException, UnauthorizedException)):
        get_organization_id(current_user=sa)


def test_change_plan_idor_guards(db_session):
    org, plan, _account = _org_with_plan(db_session, "G5", "G5PLAN")

    with pytest.raises(NotFoundException):
        change_commercial_subscription_plan(
            subscription_id=999999,
            data=_PlanChangeSchema(plan.id, reason="IDOR probe"),
            current_user=_sa_user(),
            db=db_session,
        )

    sub = _open_sub(db_session, org, plan)
    with pytest.raises(NotFoundException):
        change_commercial_subscription_plan(
            subscription_id=sub.id,
            data=_PlanChangeSchema(999999, reason="Missing target plan"),
            current_user=_sa_user(),
            db=db_session,
        )


def test_lifecycle_transition_guardrails(db_session):
    org = make_organization(db_session, code="G6")
    db_session.commit()
    sa = _sa_user()
    service = TenantLifecycleService(db_session)

    with pytest.raises(BadRequestException):
        service.transition(actor=sa, organization=org, target=TenantLifecycleState.ACTIVE, reason="   ")

    # ACTIVE cannot jump straight to the terminal state.
    with pytest.raises(BadRequestException, match="Invalid lifecycle transition"):
        service.transition(
            actor=sa, organization=org, target=TenantLifecycleState.DEACTIVATED,
            reason="Skipping states",
        )

    moved, previous = service.transition(
        actor=sa, organization=org, target=TenantLifecycleState.SUSPENDED,
        reason="Fraud investigation hold",
    )
    assert previous == TenantLifecycleState.ACTIVE
    assert moved.is_active is False
    audit_rows = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.action == PlatformAuditAction.LIFECYCLE_TRANSITION,
            PlatformAuditLog.entity_id == org.id,
        )
        .count()
    )
    assert audit_rows >= 1


# ═══════════════════════════════════════════════════════════════════════════
# C — JIT privileged access hardening
# ═══════════════════════════════════════════════════════════════════════════


def test_grant_duration_capped_at_thirty_minutes(db_session):
    org = make_organization(db_session, code="G7")
    db_session.commit()
    sa, _secret = _jit_super_admin(db_session, "g7@jit.example")

    grant = PrivilegedAccessService(db_session).request_access(
        sa, org.id, "Investigate billing discrepancy", "TICKET-G7",
        requested_minutes=9999,
    )
    assert grant.requested_minutes == MAX_GRANT_MINUTES == 30


def test_exited_grant_cannot_be_reactivated(db_session):
    org = make_organization(db_session, code="G8")
    db_session.commit()
    sa, secret = _jit_super_admin(db_session, "g8@jit.example")
    service = PrivilegedAccessService(db_session)

    grant = service.request_access(sa, org.id, "Support session", "TICKET-G8")
    service.activate(sa, grant.id, code=pyotp.TOTP(secret).now(), recovery_code=None)
    service.exit_grant(sa, grant.id)

    with pytest.raises(BadRequestException):
        service.activate(sa, grant.id, code=pyotp.TOTP(secret).now(), recovery_code=None)


def test_mid_session_expiry_blocks_summary_read(db_session):
    from app.modules.super_admin.models import PrivilegedTenantAccessGrant

    org = make_organization(db_session, code="G9")
    db_session.commit()
    sa, secret = _jit_super_admin(db_session, "g9@jit.example")
    service = PrivilegedAccessService(db_session)

    grant = service.request_access(sa, org.id, "Support session", "TICKET-G9")
    service.activate(sa, grant.id, code=pyotp.TOTP(secret).now(), recovery_code=None)

    # Simulate the clock running past expires_at while status is still ACTIVE.
    stored = db_session.query(PrivilegedTenantAccessGrant).get(grant.id)
    stored.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    with pytest.raises(ForbiddenException):
        service.get_tenant_summary(sa, grant.id)
    refreshed = db_session.query(PrivilegedTenantAccessGrant).get(grant.id)
    assert refreshed.status == PrivilegedAccessStatus.EXPIRED


def test_mfa_locked_admin_cannot_activate_grant(db_session):
    from app.config import settings

    org = make_organization(db_session, code="GA")
    db_session.commit()
    sa, _secret = _jit_super_admin(db_session, "ga@jit.example")

    for _ in range(settings.MFA_MAX_FAILED_ATTEMPTS):
        with pytest.raises(UnauthorizedException):
            mfa_service.verify_step_up(db_session, sa, code="000000", recovery_code=None)

    service = PrivilegedAccessService(db_session)
    grant = service.request_access(sa, org.id, "Support session", "TICKET-GA")
    with pytest.raises(UnauthorizedException):
        service.activate(sa, grant.id, code="000000", recovery_code=None)

    failed_events = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.entity_id == grant.id,
            PlatformAuditLog.action == PlatformAuditAction.PRIVILEGED_ACCESS_STEP_UP_FAILED,
        )
        .count()
    )
    assert failed_events >= 1


# ═══════════════════════════════════════════════════════════════════════════
# D — auditability (correlated trails, no secrets)
# ═══════════════════════════════════════════════════════════════════════════


def test_invite_audit_trail_never_carries_tokens_or_links(db_session, monkeypatch):
    org = make_organization(db_session, code="GB")
    db_session.commit()

    captured = {}

    def _fake_send(db, user, actor, link):
        captured["link"] = link

    from app.modules.auth import service as auth_service

    monkeypatch.setattr(auth_service, "_send_invite_email", _fake_send)

    UserAdminService(db_session).invite_user(
        actor=_sa_user(), organization_id=org.id,
        email="invited@gb.example", role=UserRole.ORG_ADMIN, send_invite=True,
    )
    db_session.commit()
    assert captured.get("link"), "invite link must have been issued for this probe"

    rows = db_session.query(PlatformAuditLog).all()
    assert rows, "expected at least one platform audit row"
    for row in rows:
        blob = _audit_blob(row)
        assert captured["link"].lower() not in blob
        for marker in _SECRET_MARKERS:
            assert marker not in blob


def test_change_plan_writes_correlated_audit_without_secrets(db_session):
    org, old_plan, _account = _org_with_plan(db_session, "GC", "GCOLD")
    created = _open_sub(db_session, org, old_plan)
    _, new_plan, _target = _org_with_plan(db_session, "GD", "GDNEW")
    replacement = change_commercial_subscription_plan(
        subscription_id=created.id,
        data=_PlanChangeSchema(new_plan.id, reason="Consolidation to growth tier"),
        current_user=_sa_user(),
        db=db_session,
    )

    platform_rows = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.entity_type == "CommercialSubscription",
            PlatformAuditLog.correlation_id.like("pc-%"),
        )
        .all()
    )
    assert len(platform_rows) == 1
    entry = platform_rows[0]
    assert entry.old_values["commercial_plan_id"] == old_plan.id
    assert entry.new_values["change"] == "plan_change"
    assert entry.new_values["replaced_by_subscription_id"] == replacement.id

    billing_rows = (
        db_session.query(BillingAuditLog)
        .filter_by(organization_id=org.id, entity_type="CommercialSubscription")
        .all()
    )
    replacement_rows = [r for r in billing_rows if r.entity_id == replacement.id]
    assert replacement_rows
    # Both trails are tied together by the same correlation id.
    assert any(
        (r.changes or {}).get("correlation_id") == entry.correlation_id
        for r in replacement_rows
    )

    for row in platform_rows + billing_rows:
        blob = f"{row.old_values}{row.new_values}".lower()
        for marker in _SECRET_MARKERS:
            assert marker not in blob


# ═══════════════════════════════════════════════════════════════════════════
# E — maker-checker
# ═══════════════════════════════════════════════════════════════════════════


def test_catalog_publish_refuses_self_approval(db_session):
    from app.modules.commercial.enums import CommercialBillingInterval
    from app.modules.commercial.service import (
        CommercialPlanService,
        CommercialPlanVersionService,
    )

    plan = CommercialPlanService(db_session).create_plan(
        plan_code="GEPLAN", plan_name="Maker Checker Plan"
    )
    version_service = CommercialPlanVersionService(db_session)
    version = version_service.create_draft(
        plan, plan_name="Maker Checker Plan",
        billing_interval=CommercialBillingInterval.MONTHLY,
        currency="USD", price_amount=None, actor_id=42,
    )
    submitted, _request = version_service.submit_for_approval(
        version, requested_by_user_id=42, reason="Self-approval probe"
    )
    with pytest.raises(SelfApprovalError):
        version_service.approve_and_publish(submitted, approver_user_id=42)
    assert submitted.status != CommercialPlanVersionStatus.PUBLISHED


# ═══════════════════════════════════════════════════════════════════════════
# F — performance (bounded query counts on list surfaces)
# ═══════════════════════════════════════════════════════════════════════════


def test_directory_query_count_independent_of_page_size(db_session):
    for index in range(20):
        org, plan, _account = _org_with_plan(db_session, f"GQ{index}", f"GQPLAN{index}")
        _seed_plane2_noise(db_session, org)
    db_session.commit()

    with _count_selects(db_session) as small:
        OrganizationDirectoryService(db_session).list_organizations(limit=5)
    with _count_selects(db_session) as large:
        OrganizationDirectoryService(db_session).list_organizations(limit=50)

    assert large["select"] <= 12, f"directory issues {large['select']} SELECTs per page"
    assert large["select"] == small["select"], (
        "query count must not grow with page size "
        f"(limit=5 -> {small['select']}, limit=50 -> {large['select']})"
    )


def test_reporting_query_count_constant_as_data_grows(db_session):
    with _count_selects(db_session) as empty_run:
        SaasReportingService(db_session).get_reporting()

    for index in range(12):
        org, plan, _account = _org_with_plan(db_session, f"GR{index}", f"GRPLAN{index}")
        _seed_plane2_noise(db_session, org)
    db_session.commit()

    with _count_selects(db_session) as grown_run:
        SaasReportingService(db_session).get_reporting()

    assert grown_run["select"] == empty_run["select"], (
        "reporting query count must not grow with data volume "
        f"(empty={empty_run['select']}, grown={grown_run['select']})"
    )
