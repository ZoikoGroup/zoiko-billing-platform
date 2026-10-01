"""
tests/test_org_user_management.py
----------------------------------
Phase 14 — Organization User Management & Role-Based Access.

Reported problem: an Organization Admin creates a Billing Admin, but the
invitation email is never received, and the UI shows "Invitation sent"
regardless. Root cause (traced in this pass): `auth.service.invite_user`
(and the mirror-image `UserAdminService.invite_user` on the Super Admin
side) called `_send_invite_email` / `send_user_invite_email` and discarded
its return value — `send_approval_email` swallows every SMTP exception and
returns False on failure (logging it at ERROR level) rather than raising,
so a failed send was silently indistinguishable from a successful one at
every layer above it, all the way to the frontend's unconditional
"Invitation sent to {email}." toast. The fix threads that boolean through
(`invite_email_sent` on UserResponse/SuperAdminUserResponse, `email_sent` on
the new ResendInviteResponse) instead of changing transport or introducing
background dispatch.

Per this repo's established convention (no TestClient anywhere in tests/ —
see test_entitlement_enforcement_wiring.py's docstring), these call the
router/service functions directly. Every email-producing call is
monkeypatched to a fake, capturing sender — this suite must never perform a
real SMTP send (backend/.env carries live production credentials).

Role vocabulary note: the actual roles defined in this codebase
(app/modules/auth/models.py::UserRole) are super_admin, org_admin,
billing_admin, finance_approver, auditor. There is no "billing_user" role
anywhere in the backend or frontend (frontend/src/config/roles.js mirrors
the same five) — tests below exercise the roles that actually exist rather
than assuming one that doesn't.
"""
from datetime import datetime, timedelta

import pytest

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
)
from app.core.dependencies import (
    can_create_role,
    get_current_org_admin,
    get_organization_id,
)
from app.modules.auth import service as auth_service
from app.modules.auth.models import SecurityActionPurpose, User, UserRole
from app.modules.auth.router import (
    create_user,
    deactivate_user,
    resend_invite,
    update_user,
)
from app.modules.auth.schemas import UserCreateRequest, UserUpdateRequest
from app.modules.commercial.entitlement_enforcement import EntitlementEnforcementService
from app.modules.super_admin.user_admin_service import UserAdminService

from tests.conftest import make_organization


# ── Shared fixtures / helpers ────────────────────────────────────────────────

@pytest.fixture()
def org_a(db_session):
    return make_organization(db_session, code="ORGA", name="Org A")


@pytest.fixture()
def org_b(db_session):
    return make_organization(db_session, code="ORGB", name="Org B")


@pytest.fixture(autouse=True)
def _no_real_entitlement_catalog_dependency(monkeypatch):
    """update_user's role-change path gates on the Plane 1 commercial
    entitlement 'security.custom_roles' (AC-01, ZB-COM-ENT-001 Part 2) —
    already covered end-to-end by test_entitlement_enforcement_wiring.py /
    test_commercial_entitlements.py against a fully seeded catalog + plan.
    This suite is testing Plane 2's own RBAC (can_create_role), not Plane 1's
    entitlement resolution, and a bare test org has no EntitlementDefinition
    catalog row at all (that's seeded once platform-wide via
    scripts/seed_entitlement_definitions.py, never per-test) — so the gate is
    neutralized here to isolate what this suite is actually verifying,
    exactly like _send_invite_email is faked below to isolate SMTP."""
    monkeypatch.setattr(EntitlementEnforcementService, "assert_boolean", lambda self, **kw: None)


def _make_user(db, organization, role, email, is_active=True, is_verified=True, **kw):
    from app.core.security import hash_password

    user = User(
        email=email,
        hashed_password=hash_password("CorrectPass123!"),
        role=role,
        organization_id=organization.id if organization is not None else None,
        first_name=kw.pop("first_name", "Test"),
        last_name=kw.pop("last_name", "User"),
        phone="",
        is_active=is_active,
        is_verified=is_verified,
        **kw,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _fake_email(result=True):
    """Drop-in replacement for send_user_invite_email — never touches SMTP."""
    calls = []

    def _send(*, email, first_name, invite_link, invited_by="", organization_id=None, db=None):
        calls.append({"email": email, "invite_link": invite_link})
        return result

    _send.calls = calls
    return _send


# ═══════════════════════════════════════════════════════════════════════════
# Authority hierarchy: Organization Admin creates tenant roles
# ═══════════════════════════════════════════════════════════════════════════

class TestOrgAdminCreatesTenantRoles:
    @pytest.mark.parametrize("role", [UserRole.BILLING_ADMIN, UserRole.FINANCE_APPROVER, UserRole.AUDITOR])
    def test_org_admin_can_create_every_role_it_is_authorized_for(self, db_session, org_a, monkeypatch, role):
        monkeypatch.setattr(auth_service, "send_user_invite_email", _fake_email(True), raising=False)
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")

        created = create_user(
            UserCreateRequest(email=f"{role.value}@orga.com", first_name="New", last_name="Hire", role=role),
            current_user=actor, db=db_session,
        )
        assert created.role == role
        assert created.organization_id == org_a.id
        assert created.is_active is True
        assert created.is_verified is False  # pending until they accept

    def test_org_admin_cannot_create_another_org_admin(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        with pytest.raises(ForbiddenException):
            create_user(
                UserCreateRequest(email="new-admin@orga.com", first_name="X", last_name="Y", role=UserRole.ORG_ADMIN),
                current_user=actor, db=db_session,
            )

    def test_org_admin_cannot_create_a_super_admin(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        with pytest.raises(ForbiddenException):
            create_user(
                UserCreateRequest(email="wannabe@orga.com", first_name="X", last_name="Y", role=UserRole.SUPER_ADMIN),
                current_user=actor, db=db_session,
            )

    def test_billing_admin_cannot_create_any_user(self, db_session, org_a):
        """billing_admin has an empty ROLE_CREATION_RULES entry — it cannot
        invite anyone, including another billing_admin."""
        actor = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "ba@orga.com")
        with pytest.raises(ForbiddenException):
            create_user(
                UserCreateRequest(email="peer@orga.com", first_name="X", last_name="Y", role=UserRole.BILLING_ADMIN),
                current_user=actor, db=db_session,
            )

    def test_duplicate_email_is_rejected(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "existing@orga.com")
        with pytest.raises(AlreadyExistsException):
            create_user(
                UserCreateRequest(email="existing@orga.com", first_name="X", last_name="Y", role=UserRole.BILLING_ADMIN),
                current_user=actor, db=db_session,
            )


# ═══════════════════════════════════════════════════════════════════════════
# Super Admin boundary: platform manages orgs, not tenant Billing Admins
# ═══════════════════════════════════════════════════════════════════════════

class TestSuperAdminBoundary:
    def test_super_admin_cannot_use_the_tenant_invite_route_at_all(self, db_session, org_a):
        """auth.service.invite_user (the Organization-Admin-facing route) is
        structurally unreachable for a super_admin actor — it has no
        organization_id, which invite_user requires up front."""
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        with pytest.raises(ForbiddenException):
            create_user(
                UserCreateRequest(email="x@orga.com", first_name="X", last_name="Y", role=UserRole.BILLING_ADMIN),
                current_user=super_admin, db=db_session,
            )

    def test_super_admin_can_create_an_org_admin_via_the_platform_service(self, db_session, org_a, monkeypatch):
        """The one documented platform-level exception: Super Admin may seed
        or replace an org's Organization Admin (bootstrapping / lockout
        recovery) — ROLE_CREATION_RULES[SUPER_ADMIN] = [ORG_ADMIN] only."""
        monkeypatch.setattr(auth_service, "_send_invite_email", lambda *a, **kw: True)
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")

        user = UserAdminService(db_session).invite_user(
            actor=super_admin, organization_id=org_a.id, email="neworgadmin@orga.com",
            role=UserRole.ORG_ADMIN, first_name="New", last_name="Admin", send_invite=True,
        )
        db_session.commit()
        assert user.role == UserRole.ORG_ADMIN
        assert user.organization_id == org_a.id

    @pytest.mark.parametrize("role", [UserRole.BILLING_ADMIN, UserRole.FINANCE_APPROVER, UserRole.AUDITOR])
    def test_super_admin_cannot_create_billing_admin_or_other_tenant_roles(self, db_session, org_a, role):
        """This is the actual guardrail behind 'Super Admin does not create
        Billing Admins' — enforced by the same can_create_role() shared with
        the Organization Admin route, not a separate/duplicated rule."""
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        with pytest.raises(ForbiddenException):
            UserAdminService(db_session).invite_user(
                actor=super_admin, organization_id=org_a.id, email=f"{role.value}@orga.com",
                role=role, send_invite=False,
            )

    def test_can_create_role_matrix_matches_the_documented_hierarchy(self):
        assert can_create_role("super_admin", "org_admin") is True
        assert can_create_role("super_admin", "billing_admin") is False
        assert can_create_role("org_admin", "billing_admin") is True
        assert can_create_role("org_admin", "finance_approver") is True
        assert can_create_role("org_admin", "auditor") is True
        assert can_create_role("org_admin", "org_admin") is False
        assert can_create_role("org_admin", "super_admin") is False
        assert can_create_role("billing_admin", "billing_admin") is False


# ═══════════════════════════════════════════════════════════════════════════
# The reported bug: invitation email outcome must be visible, never assumed
# ═══════════════════════════════════════════════════════════════════════════

class TestInviteEmailVisibility:
    def test_successful_send_is_reported_as_sent(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")

        created = create_user(
            UserCreateRequest(email="ba@orga.com", first_name="B", last_name="A", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        assert created.invite_email_sent is True

    def test_failed_send_is_reported_as_failed_but_the_user_is_still_created(self, db_session, org_a, monkeypatch):
        """This is the exact reported symptom: SMTP fails, but the request
        must not silently claim success, and the account must still exist
        (email delivery is not the source of truth for account creation)."""
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(False))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")

        created = create_user(
            UserCreateRequest(email="ba2@orga.com", first_name="B", last_name="A", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        assert created.invite_email_sent is False
        # The user row itself must exist and be queryable — email delivery
        # failing must never roll back a successful account creation.
        persisted = db_session.query(User).filter(User.email == "ba2@orga.com").first()
        assert persisted is not None
        assert persisted.role == UserRole.BILLING_ADMIN

    def test_skipping_the_invite_email_reports_no_attempt_not_a_failure(self, db_session, org_a, monkeypatch):
        fake = _fake_email(True)
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", fake)
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")

        created = create_user(
            UserCreateRequest(email="ba3@orga.com", first_name="B", last_name="A", role=UserRole.BILLING_ADMIN, send_invite=False),
            current_user=actor, db=db_session,
        )
        assert created.invite_email_sent is None
        assert fake.calls == []  # no email attempted at all

    def test_resend_reports_success_truthfully(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "pending@orga.com", is_verified=False)

        result = resend_invite(pending.id, current_user=actor, db=db_session)
        assert result["email_sent"] is True
        assert "resent" in result["message"].lower()

    def test_resend_reports_failure_truthfully_without_raising(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(False))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "pending2@orga.com", is_verified=False)

        result = resend_invite(pending.id, current_user=actor, db=db_session)
        assert result["email_sent"] is False
        assert "could not be delivered" in result["message"].lower()

    def test_super_admin_platform_invite_also_reports_email_outcome(self, db_session, org_a, monkeypatch):
        """The same silent-failure bug existed in the mirror-image Super
        Admin 'invite tenant administrator' path (UserAdminService) — fixed
        the same way."""
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(False))
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")

        user = UserAdminService(db_session).invite_user(
            actor=super_admin, organization_id=org_a.id, email="neworgadmin2@orga.com",
            role=UserRole.ORG_ADMIN, send_invite=True,
        )
        db_session.commit()
        assert user.invite_email_sent is False


# ═══════════════════════════════════════════════════════════════════════════
# Invitation token lifecycle
# ═══════════════════════════════════════════════════════════════════════════

class TestInvitationLifecycle:
    def test_invite_token_is_valid_and_activates_the_account(self, db_session, org_a):
        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "invitee@orga.com", is_verified=False)
        raw_token, _ = auth_service._issue_action_token(db_session, user.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()

        ctx = auth_service.validate_action_token(db_session, raw_token, SecurityActionPurpose.INVITE)
        assert ctx is not None and ctx["email"] == user.email

        result = auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "NewPass123!")
        assert "successfully" in result["message"].lower()
        db_session.refresh(user)
        assert user.is_active is True
        assert user.is_verified is True

    def test_invite_token_is_single_use(self, db_session, org_a):
        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "invitee2@orga.com", is_verified=False)
        raw_token, _ = auth_service._issue_action_token(db_session, user.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()

        auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "NewPass123!")
        with pytest.raises(BadRequestException):
            auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "AnotherPass456!")

    def test_expired_invite_token_is_rejected(self, db_session, org_a):
        from sqlalchemy import text

        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "invitee3@orga.com", is_verified=False)
        raw_token, _ = auth_service._issue_action_token(db_session, user.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()
        db_session.execute(
            text("UPDATE security_action_tokens SET expires_at = :past WHERE token_hash = :h"),
            {"past": datetime.utcnow() - timedelta(hours=1), "h": auth_service._token_hash(raw_token)},
        )
        db_session.commit()

        assert auth_service.validate_action_token(db_session, raw_token, SecurityActionPurpose.INVITE) is None
        with pytest.raises(BadRequestException):
            auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "NewPass123!")

    def test_invite_token_never_contains_a_password_or_jwt(self, db_session, org_a):
        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "invitee4@orga.com", is_verified=False)
        raw_token, _ = auth_service._issue_action_token(db_session, user.email, org_a.id, SecurityActionPurpose.INVITE)
        # A URL-safe random token (secrets.token_urlsafe) is neither a JWT
        # (no two '.' separators) nor derived from any password material.
        assert raw_token.count(".") == 0
        assert "CorrectPass123!" not in raw_token

    def test_resend_issues_an_independently_valid_new_token(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "resend@orga.com", is_verified=False)

        first_token, _ = auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()
        resend_invite(pending.id, current_user=actor, db=db_session)

        # The freshly-resent token activates the account on its own.
        second_token_ctx = db_session.execute(
            __import__("sqlalchemy").text(
                "SELECT token_hash FROM security_action_tokens WHERE email = :e AND used_at IS NULL ORDER BY id DESC LIMIT 1"
            ),
            {"e": pending.email},
        ).fetchone()
        assert second_token_ctx is not None


# ═══════════════════════════════════════════════════════════════════════════
# Activation → login → role resolution
# ═══════════════════════════════════════════════════════════════════════════

class TestActivationLoginRoleResolution:
    def test_full_lifecycle_invite_to_authenticated_billing_admin(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")

        created = create_user(
            UserCreateRequest(email="lifecycle@orga.com", first_name="Life", last_name="Cycle", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        assert created.invite_email_sent is True

        raw_token, _ = auth_service._issue_action_token(db_session, created.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()
        auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "SetupPass123!")

        result = auth_service.login_user(db_session, "lifecycle@orga.com", "SetupPass123!")
        assert result["user"].role == UserRole.BILLING_ADMIN
        assert result["user"].organization_id == org_a.id

        from app.core.security import decode_access_token

        payload = decode_access_token(result["access_token"])
        assert payload["role"] == "billing_admin"
        assert payload["organization_id"] == org_a.id

    def test_frontend_cannot_invent_a_role_backend_resolves_from_the_db(self, db_session, org_a):
        """get_current_user always re-fetches the User row and rejects a
        token whose role claim no longer matches it — a frontend cannot
        upgrade its own effective role by holding onto a stale/edited token."""
        from app.core.dependencies import get_current_user
        from app.core.security import create_access_token

        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "spoof@orga.com")
        forged_payload = {"sub": user.email, "role": "super_admin", "user_id": user.id, "organization_id": None}
        forged_token = create_access_token(data=forged_payload)
        with pytest.raises(UnauthorizedException):
            get_current_user(token=forged_token, db=db_session)


# ═══════════════════════════════════════════════════════════════════════════
# Privilege escalation prevention
# ═══════════════════════════════════════════════════════════════════════════

class TestPrivilegeEscalation:
    def test_org_admin_cannot_promote_a_user_to_org_admin(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target@orga.com")
        with pytest.raises(ForbiddenException):
            update_user(target.id, UserUpdateRequest(role=UserRole.ORG_ADMIN), current_user=actor, db=db_session)

    def test_org_admin_cannot_promote_a_user_to_super_admin(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target2@orga.com")
        with pytest.raises(ForbiddenException):
            update_user(target.id, UserUpdateRequest(role=UserRole.SUPER_ADMIN), current_user=actor, db=db_session)

    def test_org_admin_can_move_a_user_between_roles_it_is_authorized_for(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target3@orga.com")
        updated = update_user(target.id, UserUpdateRequest(role=UserRole.FINANCE_APPROVER), current_user=actor, db=db_session)
        assert updated.role == UserRole.FINANCE_APPROVER

    def test_billing_admin_cannot_reach_the_user_management_dependency_at_all(self, db_session, org_a):
        billing_admin = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "ba@orga.com")
        with pytest.raises(ForbiddenException):
            get_current_org_admin(current_user=billing_admin)


# ═══════════════════════════════════════════════════════════════════════════
# Tenant isolation — verified at the backend, not the frontend
# ═══════════════════════════════════════════════════════════════════════════

class TestTenantIsolation:
    def test_org_admin_a_cannot_update_a_user_in_org_b(self, db_session, org_a, org_b):
        admin_a = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        user_b = _make_user(db_session, org_b, UserRole.BILLING_ADMIN, "user@orgb.com")
        with pytest.raises(NotFoundException):
            update_user(user_b.id, UserUpdateRequest(first_name="Hacked"), current_user=admin_a, db=db_session)

    def test_org_admin_a_cannot_deactivate_a_user_in_org_b(self, db_session, org_a, org_b):
        admin_a = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        user_b = _make_user(db_session, org_b, UserRole.BILLING_ADMIN, "user2@orgb.com")
        with pytest.raises(NotFoundException):
            deactivate_user(user_b.id, current_user=admin_a, db=db_session)

    def test_org_admin_a_cannot_resend_invite_for_org_b_user(self, db_session, org_a, org_b):
        admin_a = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        pending_b = _make_user(db_session, org_b, UserRole.BILLING_ADMIN, "pending@orgb.com", is_verified=False)
        with pytest.raises(NotFoundException):
            resend_invite(pending_b.id, current_user=admin_a, db=db_session)

    def test_get_organization_id_is_never_cross_tenant(self, db_session, org_a, org_b):
        admin_a = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        admin_b = _make_user(db_session, org_b, UserRole.ORG_ADMIN, "admin@orgb.com")
        assert get_organization_id(current_user=admin_a) == org_a.id
        assert get_organization_id(current_user=admin_b) == org_b.id


# ═══════════════════════════════════════════════════════════════════════════
# Deactivation / reactivation
# ═══════════════════════════════════════════════════════════════════════════

class TestDeactivationReactivation:
    def test_deactivate_blocks_subsequent_login(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target@orga.com")

        deactivate_user(target.id, current_user=actor, db=db_session)
        with pytest.raises(UnauthorizedException) as exc:
            auth_service.login_user(db_session, "target@orga.com", "CorrectPass123!")
        assert "deactivated" in exc.value.message.lower()

    def test_reactivate_restores_login(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target2@orga.com")

        deactivate_user(target.id, current_user=actor, db=db_session)
        update_user(target.id, UserUpdateRequest(is_active=True), current_user=actor, db=db_session)

        result = auth_service.login_user(db_session, "target2@orga.com", "CorrectPass123!")
        assert result["access_token"]

    def test_org_admin_cannot_deactivate_their_own_account(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        with pytest.raises(BadRequestException):
            deactivate_user(actor.id, current_user=actor, db=db_session)


# ═══════════════════════════════════════════════════════════════════════════
# Password reset
# ═══════════════════════════════════════════════════════════════════════════

class TestPasswordReset:
    def test_reset_flow_changes_the_password_and_invalidates_the_old_one(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_org_admin_password_reset_email", lambda **kw: True)
        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "reset@orga.com")

        auth_service.request_password_reset(db_session, "reset@orga.com")
        raw_token, _ = auth_service._issue_action_token(db_session, user.email, org_a.id, SecurityActionPurpose.RESET)
        db_session.commit()

        auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.RESET, "BrandNewPass456!")

        with pytest.raises(UnauthorizedException):
            auth_service.login_user(db_session, "reset@orga.com", "CorrectPass123!")
        result = auth_service.login_user(db_session, "reset@orga.com", "BrandNewPass456!")
        assert result["access_token"]

    def test_reset_token_is_single_use(self, db_session, org_a):
        user = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "reset2@orga.com")
        raw_token, _ = auth_service._issue_action_token(db_session, user.email, org_a.id, SecurityActionPurpose.RESET)
        db_session.commit()

        auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.RESET, "FirstNew123!")
        with pytest.raises(BadRequestException):
            auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.RESET, "SecondNew456!")

    def test_unknown_email_still_returns_the_generic_message(self, db_session):
        """Enumeration-safe: a non-existent email must not reveal that fact."""
        result = auth_service.request_password_reset(db_session, "nobody@nowhere.com")
        assert "if that email is registered" in result["message"].lower()


# ═══════════════════════════════════════════════════════════════════════════
# Credential / secret exposure
# ═══════════════════════════════════════════════════════════════════════════

class TestNoCredentialLeakage:
    def test_invite_creation_result_never_carries_a_password(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@orga.com")
        created = create_user(
            UserCreateRequest(email="secure@orga.com", first_name="S", last_name="U", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        # create_user's response_model (UserResponse) is what actually
        # reaches the client — that's what must never carry the hash.
        from app.modules.auth.schemas import UserResponse

        dumped = UserResponse.model_validate(created).model_dump_json()
        assert "hashed_password" not in dumped
        assert created.hashed_password not in dumped
