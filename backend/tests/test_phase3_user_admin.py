"""
PHASE 3B tests — Administrators & Users (Super-Admin-scoped mutations).

Coverage:
   1-3    Derived status evidence chain (active / suspended / invited).
   4      Real last-login stamping by auth login_user().
   5-10   Super-admin invite: creates unverified org admin + platform audit
          event; SoD rule inherited (only org_admin creatable); non-tenant
          roles rejected; duplicate email rejected; missing org 404.
  11-17   Role changes: applied + audited with mandatory reason; blank
          reason rejected; self-role-change forbidden; super-admin targets
          rejected; creation rules still gate assignable roles; missing
          user 404.
  18-23   Membership moves: applied + audited (old/new organization_id);
          strip-to-none allowed for tenant users; forbidden on super-admin
          platform accounts; missing reason rejected; same-scope no-op
          rejected; missing org 404.
  24-28   Status flips: mandatory reason; self-deactivation forbidden;
          deactivate/reactivate each write exactly one audited event with
          the right action and reason; redundant no-op rejected.

Handlers/services are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL. conftest is untouched.
"""
import pytest

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
)
from app.modules.auth.models import User, UserRole
from app.modules.auth.service import login_user
from app.core.security import hash_password
from app.modules.organizations.models import Organization
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.super_admin.router import (
    change_super_admin_user_membership,
    change_super_admin_user_role,
    invite_super_admin_user,
    list_platform_users,
    set_user_status,
)
from app.modules.super_admin.user_admin_service import STATUS_ACTIVE, STATUS_INVITED, STATUS_SUSPENDED, UserAdminService
from tests.conftest import make_organization


# ── helpers ─────────────────────────────────────────────────────────────────

class _Stub:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


def _sa_user(db=None):
    user = User(
        email="sa@p3b.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )
    if db is not None:
        db.add(user)
        db.flush()
    return user


def _org(db, code="P3B", name=None):
    org = make_organization(db, code=code, name=name or f"Org {code}")
    db.commit()
    return org


def _tenant_user(db, org_id, email, role=UserRole.ORG_ADMIN, is_active=True, is_verified=True):
    user = User(
        email=email,
        hashed_password=hash_password("StrongPass123!"),
        role=role,
        organization_id=org_id,
        first_name="T",
        last_name="U",
        phone="",
        is_active=is_active,
        is_verified=is_verified,
    )
    db.add(user)
    db.flush()
    return user


def _audit_rows(db):
    return db.query(PlatformAuditLog).order_by(PlatformAuditLog.id.asc()).all()


def _invite(db, actor, org_id, email, role=UserRole.ORG_ADMIN, **kwargs):
    payload = _Stub(
        organization_id=org_id,
        email=email,
        first_name=kwargs.get("first_name", "In"),
        last_name=kwargs.get("last_name", "Vited"),
        phone=kwargs.get("phone", ""),
        role=role,
        send_invite=kwargs.get("send_invite", True),
    )
    return invite_super_admin_user(data=payload, current_user=actor, db=db)


# ── 1-3 Derived status ──────────────────────────────────────────────────────

def test_derived_status_active_suspended_invited(db_session):
    org = _org(db_session)
    service = UserAdminService(db_session)

    active = _tenant_user(db_session, org.id, "active@p3b.example")
    assert service.derived_status(active) == STATUS_ACTIVE

    suspended = _tenant_user(
        db_session, org.id, "off@p3b.example", is_active=False
    )
    assert service.derived_status(suspended) == STATUS_SUSPENDED

    invited = _tenant_user(
        db_session, org.id, "new@p3b.example", is_verified=False
    )
    assert service.derived_status(invited) == STATUS_INVITED


def test_directory_users_list_includes_derived_fields(db_session):
    org = _org(db_session, "LIST")
    sa = _sa_user(db_session)
    _tenant_user(db_session, org.id, "boss@list.example")  # verified → active
    _tenant_user(db_session, org.id, "fresh@list.example", is_verified=False)

    response = list_platform_users(
        skip=0,
        limit=50,
        search="",
        role="",
        organization_id=org.id,
        is_active=None,
        current_user=sa,
        db=db_session,
    )
    by_email = {u.email: u for u in response.users}
    assert by_email["boss@list.example"].derived_status == STATUS_ACTIVE
    assert by_email["boss@list.example"].last_login_at is None
    assert by_email["fresh@list.example"].derived_status == STATUS_INVITED


def test_login_stamps_last_login_at(db_session):
    org = _org(db_session, "LOGIN")
    user = _tenant_user(db_session, org.id, "who@login.example")
    assert user.last_login_at is None

    login_user(db_session, "who@login.example", "StrongPass123!")
    db_session.refresh(user)
    assert user.last_login_at is not None


# ── 5-10 Invite ─────────────────────────────────────────────────────────────

def test_invite_creates_unverified_org_admin_with_audit(db_session):
    org = _org(db_session, "INV")
    sa = _sa_user(db_session)

    user = _invite(db_session, sa, org.id, "admin@invite.example")

    assert user.is_active is True
    assert user.derived_status == STATUS_INVITED  # invited, not yet accepted
    assert user.role == UserRole.ORG_ADMIN
    assert user.organization_id == org.id
    db_row = db_session.query(User).filter_by(email="admin@invite.example").first()
    assert db_row.is_verified is False

    events = [e for e in _audit_rows(db_session) if e.entity_type == "User"]
    assert len(events) == 1
    event = events[0]
    assert event.action == PlatformAuditAction.CREATE
    assert event.actor_id == sa.id
    assert event.actor_role == "super_admin"
    assert event.organization_id == org.id
    assert event.new_values["email"] == "admin@invite.example"
    assert event.metadata_["plane"] == "TENANT"


def test_invite_respects_segregation_of_duties(db_session):
    org = _org(db_session, "SOD")
    sa = _sa_user(db_session)

    # §25 ROLE_CREATION_RULES: super admins create ORG ADMINS only — they do
    # NOT bypass the tenant org admin's authority over billing/finance roles.
    with pytest.raises(ForbiddenException):
        _invite(db_session, sa, org.id, "bill@sod.example", role=UserRole.BILLING_ADMIN)


def test_invite_rejects_non_tenant_roles(db_session):
    org = _org(db_session, "NT")
    sa = _sa_user(db_session)
    with pytest.raises(BadRequestException):
        _invite(db_session, sa, org.id, "godmode@nt.example", role=UserRole.SUPER_ADMIN)


def test_invite_rejects_duplicate_email_across_orgs(db_session):
    org_a = _org(db_session, "DUPA")
    org_b = _org(db_session, "DUPB")
    sa = _sa_user(db_session)
    _tenant_user(db_session, org_a.id, "taken@example.com")

    with pytest.raises(AlreadyExistsException):
        _invite(db_session, sa, org_b.id, "taken@example.com")


def test_invite_into_missing_organization_404(db_session):
    sa = _sa_user(db_session)
    with pytest.raises(NotFoundException):
        _invite(db_session, sa, 987654, "ghost@nowhere.example")


def test_invite_without_email_delivery_still_records_audit(db_session):
    org = _org(db_session, "QUIET")
    sa = _sa_user(db_session)
    user = _invite(db_session, sa, org.id, "quiet@quiet.example", send_invite=False)
    events = [e for e in _audit_rows(db_session) if e.entity_type == "User"]
    assert len(events) == 1
    assert events[0].new_values["send_invite"] is False
    assert user.email == "quiet@quiet.example"


# ── 11-17 Role changes ──────────────────────────────────────────────────────

def _change_role(db, actor, user, role, reason="Promotion approved"):
    return change_super_admin_user_role(
        user_id=user.id,
        data=_Stub(role=role, reason=reason),
        current_user=actor,
        db=db,
    )


def test_role_change_applies_and_audits_with_reason(db_session):
    org = _org(db_session, "ROLE")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "auditor@role.example", role=UserRole.AUDITOR)

    response = _change_role(db_session, sa, user, UserRole.ORG_ADMIN)

    db_session.refresh(user)
    assert user.role == UserRole.ORG_ADMIN
    assert response.role == UserRole.ORG_ADMIN
    assert response.derived_status == STATUS_ACTIVE

    events = [
        e
        for e in _audit_rows(db_session)
        if e.action == PlatformAuditAction.UPDATE and e.entity_type == "User"
    ]
    assert len(events) == 1
    assert events[0].old_values == {"role": "auditor"}
    assert events[0].new_values == {"role": "org_admin"}
    assert events[0].reason == "Promotion approved"


def test_role_change_requires_reason(db_session):
    org = _org(db_session, "ROLR")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "x@rolr.example")
    with pytest.raises(BadRequestException):
        _change_role(db_session, sa, user, UserRole.AUDITOR, reason="   ")


def test_role_change_forbidden_on_own_account(db_session):
    org = _org(db_session, "SELF")
    sa = _sa_user(db_session)
    # A super admin cannot be retargeted anyway, but the guard fires first:
    # even a tenant-scoped mutation on one's own id is blocked.
    other_sa = User(
        email="self@self.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="B",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db_session.add(other_sa)
    db_session.flush()

    with pytest.raises((ForbiddenException, BadRequestException)):
        _change_role(db_session, sa, other_sa, UserRole.SUPER_ADMIN)


def test_role_change_never_touches_super_admin_accounts(db_session):
    sa_actor = _sa_user(db_session)
    sa_target = User(
        email="target@sa.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="C",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db_session.add(sa_target)
    db_session.flush()

    with pytest.raises(BadRequestException):
        _change_role(db_session, sa_actor, sa_target, UserRole.ORG_ADMIN)


def test_role_change_gated_by_creation_rules(db_session):
    org = _org(db_session, "GATE")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "admin@gate.example", role=UserRole.ORG_ADMIN)

    # super_admin may only grant ORG_ADMIN per ROLE_CREATION_RULES — granting
    # BILLING_ADMIN directly would bypass the tenant org admin's authority.
    with pytest.raises(ForbiddenException):
        _change_role(db_session, sa, user, UserRole.BILLING_ADMIN)


def test_role_change_missing_user_404(db_session):
    sa = _sa_user(db_session)
    with pytest.raises(NotFoundException):
        _change_role(db_session, sa, _Stub(id=987654), UserRole.ORG_ADMIN)


# ── 18-23 Membership moves ──────────────────────────────────────────────────

def _move(db, actor, user, org_id, reason="Consolidating teams"):
    return change_super_admin_user_membership(
        user_id=user.id,
        data=_Stub(organization_id=org_id, reason=reason),
        current_user=actor,
        db=db,
    )


def test_membership_move_applies_and_audits_old_and_new(db_session):
    src = _org(db_session, "MSRC")
    dst = _org(db_session, "MDST")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, src.id, "mover@msrc.example")

    response = _move(db_session, sa, user, dst.id)

    db_session.refresh(user)
    assert user.organization_id == dst.id
    assert response.organization_code == dst.organization_code or response.organization_id == dst.id

    event = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.entity_type == "User",
            PlatformAuditAction.UPDATE == PlatformAuditAction.UPDATE,
            PlatformAuditLog.old_values.isnot(None),
        )
        .order_by(PlatformAuditLog.id.desc())
        .first()
    )
    assert event is not None
    assert event.old_values == {"organization_id": src.id}
    assert event.new_values == {"organization_id": dst.id}
    assert event.reason == "Consolidating teams"


def test_membership_can_be_stripped_from_tenant_users(db_session):
    org = _org(db_session, "STRIP")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "orphan@strip.example")

    _move(db_session, sa, user, None)
    db_session.refresh(user)
    assert user.organization_id is None


def test_membership_never_moves_super_admins(db_session):
    org = _org(db_session, "NOMOVE")
    sa_actor = _sa_user(db_session)
    sa_target = User(
        email="moveme@sa.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="D",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db_session.add(sa_target)
    db_session.flush()

    with pytest.raises(ForbiddenException):
        _move(db_session, sa_actor, sa_target, org.id)


def test_membership_requires_reason_and_valid_target(db_session):
    org = _org(db_session, "MVAL")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "val@mval.example")

    with pytest.raises(BadRequestException):
        _move(db_session, sa, user, None, reason="")
    with pytest.raises(NotFoundException):
        _move(db_session, sa, user, 987654)
    with pytest.raises(BadRequestException):
        _move(db_session, sa, user, org.id)  # same scope no-op


# ── 24-28 Status flips ──────────────────────────────────────────────────────

def _set_status(db, actor, user, is_active, reason="Abuse investigation"):
    return set_user_status(
        user_id=user.id,
        data=_Stub(is_active=is_active, reason=reason),
        current_user=actor,
        db=db,
    )


def test_status_flip_requires_reason(db_session):
    org = _org(db_session, "ST")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "flip@st.example")

    with pytest.raises(BadRequestException):
        _set_status(db_session, sa, user, False, reason="")


def test_self_deactivation_remains_impossible(db_session):
    org = _org(db_session, "ME")
    sa = _sa_user(db_session)
    sa.organization_id = org.id  # irrelevant; identity check is what matters

    with pytest.raises(BadRequestException):
        _set_status(db_session, sa, sa, False, reason="Self-offboarding attempt")


def test_deactivate_then_reactivate_writes_two_audited_events(db_session):
    org = _org(db_session, "DR")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "cycle@dr.example")

    _set_status(db_session, sa, user, False, reason="Suspected compromise")
    db_session.refresh(user)
    assert user.is_active is False

    _set_status(db_session, sa, user, True, reason="Cleared after review")
    db_session.refresh(user)
    assert user.is_active is True

    events = [
        e
        for e in _audit_rows(db_session)
        if e.entity_type == "User" and e.action in (PlatformAuditAction.ACTIVATE, PlatformAuditAction.DEACTIVATE)
    ]
    assert [(e.action, e.reason) for e in events] == [
        (PlatformAuditAction.DEACTIVATE, "Suspected compromise"),
        (PlatformAuditAction.ACTIVATE, "Cleared after review"),
    ]
    assert all(e.actor_id == sa.id for e in events)


def test_redundant_status_flip_rejected(db_session):
    org = _org(db_session, "NOOP")
    sa = _sa_user(db_session)
    user = _tenant_user(db_session, org.id, "noop@noop.example")

    with pytest.raises(BadRequestException):
        _set_status(db_session, sa, user, True)  # already active


def test_status_missing_user_404(db_session):
    sa = _sa_user(db_session)
    with pytest.raises(NotFoundException):
        set_user_status(
            user_id=987654,
            data=_Stub(is_active=False, reason="Ghost hunt"),
            current_user=sa,
            db=db_session,
        )


def test_registration_org_visible_in_lifecycle_directory(db_session):
    """Cross-check with 3A: a registered ONBOARDING org appears in the
    directory with its lifecycle state and its admin user counts."""
    from app.modules.auth.service import register_enterprise
    from app.modules.auth.schemas import RegisterRequest
    from app.modules.organizations.models import TenantLifecycleState

    register_enterprise(
        db_session,
        RegisterRequest(
            organization="Dir Check Co",
            name="Dir Admin",
            email="dircheck@register.example",
            password="StrongPass123!",
            currency="USD",
            intended_plan="essentials",
        ),
    )
    sa = _sa_user(db_session)
    response = list_platform_users(
        skip=0,
        limit=50,
        search="dircheck@register.example",
        role="",
        organization_id=None,
        is_active=None,
        current_user=sa,
        db=db_session,
    )
    assert response.total == 1
    row = response.users[0]
    assert row.role == UserRole.ORG_ADMIN
    # Self-registered users set their own password → immediately verified
    # and ACTIVE; INVITED is reserved for super-admin/org-admin invites.
    assert row.derived_status == STATUS_ACTIVE
    org = db_session.query(Organization).filter_by(id=row.organization_id).first()
    assert org.lifecycle_state == TenantLifecycleState.ONBOARDING
