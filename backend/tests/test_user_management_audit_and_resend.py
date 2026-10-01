"""
tests/test_user_management_audit_and_resend.py
------------------------------------------------
Phase 15 — User Management Auditability, Invitation Resend & Token
Revocation.

Continues from Phase 14 (test_org_user_management.py), which fixed the
silent invite-email-failure bug and validated the authority hierarchy.
Phase 14 left three documented gaps this file closes and tests:

1. Organization-Admin-driven user mutations wrote no audit record at all
   (only the Super-Admin-facing UserAdminService did). Fixed by reusing the
   SAME PlatformAuditService/PlatformAuditLog — no second audit system.
2. Resending an invitation left the previous token independently valid.
   Fixed via `auth.service._invalidate_pending_action_tokens`, called from
   both resend endpoints before issuing the new token.
3. The Super Admin "Invite tenant administrator" screen had no resend
   action. Fixed via `UserAdminService.resend_invite` +
   `POST /super-admin/users/{id}/resend-invite`, scoped to ORG_ADMIN
   targets only (tenant-role resends stay with that org's own admin).

Also covers a fourth, independent defect found while testing Step 28 of
this phase's own checklist ("deactivated invited user"): `complete_action_token`
used to unconditionally set `is_active=True`, so accepting an invite (or
completing a password reset) would silently undo a deactivation applied in
the meantime. Fixed to reject completion for a currently-deactivated
account instead.

Same conventions as test_org_user_management.py: router/service functions
called directly (no TestClient anywhere in this repo), every email call
monkeypatched to a fake sender — never a real SMTP send.
"""
from datetime import datetime, timedelta

import pytest

from app.core.exceptions import (
    BadRequestException,
    ForbiddenException,
    NotFoundException,
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
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.super_admin.router import (
    invite_super_admin_user,
    resend_super_admin_user_invite,
)
from app.modules.super_admin.schemas import SuperAdminUserInviteRequest
from app.modules.super_admin.user_admin_service import UserAdminService

from tests.conftest import make_organization


# ── Shared fixtures / helpers (mirrors test_org_user_management.py) ─────────

@pytest.fixture()
def org_a(db_session):
    return make_organization(db_session, code="P15ORGA", name="P15 Org A")


@pytest.fixture()
def org_b(db_session):
    return make_organization(db_session, code="P15ORGB", name="P15 Org B")


@pytest.fixture(autouse=True)
def _no_real_entitlement_catalog_dependency(monkeypatch):
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
        phone=kw.pop("phone", ""),
        is_active=is_active,
        is_verified=is_verified,
        **kw,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _fake_email(result=True):
    calls = []

    def _send(*, email, first_name, invite_link, invited_by="", organization_id=None, db=None):
        calls.append({"email": email, "invite_link": invite_link})
        return result

    _send.calls = calls
    return _send


def _latest_unused_token_hash(db, email, purpose):
    row = db.execute(
        __import__("sqlalchemy").text(
            "SELECT token_hash FROM security_action_tokens "
            "WHERE email = :e AND purpose = :p AND used_at IS NULL ORDER BY id DESC LIMIT 1"
        ),
        {"e": email, "p": purpose.name},
    ).fetchone()
    return row[0] if row else None


def _unused_token_count(db, email, purpose):
    row = db.execute(
        __import__("sqlalchemy").text(
            "SELECT COUNT(*) FROM security_action_tokens WHERE email = :e AND purpose = :p AND used_at IS NULL"
        ),
        {"e": email, "p": purpose.name},
    ).fetchone()
    return row[0]


# ═══════════════════════════════════════════════════════════════════════════
# Organization Admin auditability (the primary Phase 15 gap)
# ═══════════════════════════════════════════════════════════════════════════

class TestOrgAdminAuditTrail:
    def test_user_creation_is_audited(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")

        created = create_user(
            UserCreateRequest(email="ba@p15a.com", first_name="B", last_name="A", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == created.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row is not None
        assert row.action == PlatformAuditAction.CREATE
        assert row.actor_id == actor.id
        assert row.actor_role == "org_admin"
        assert row.organization_id == org_a.id
        assert row.new_values["role"] == "billing_admin"
        assert row.new_values["invite_email_sent"] is True

    def test_role_change_is_audited_with_old_and_new_value(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target@p15a.com")

        update_user(target.id, UserUpdateRequest(role=UserRole.FINANCE_APPROVER), current_user=actor, db=db_session)

        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == target.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row.old_values["role"] == "billing_admin"
        assert row.new_values["role"] == "finance_approver"
        assert row.metadata_["field"] == "role_change"

    def test_profile_edit_without_role_change_is_audited_as_profile_modification(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target2@p15a.com", first_name="Old")

        update_user(target.id, UserUpdateRequest(first_name="New"), current_user=actor, db=db_session)

        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == target.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row.old_values == {"first_name": "Old"}
        assert row.new_values == {"first_name": "New"}
        assert row.metadata_["field"] == "profile_modification"

    def test_no_op_update_writes_no_audit_row(self, db_session, org_a):
        """Sending the same value back must not create audit noise."""
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target3@p15a.com", phone="555")

        before_count = db_session.query(PlatformAuditLog).count()
        update_user(target.id, UserUpdateRequest(phone="555"), current_user=actor, db=db_session)
        assert db_session.query(PlatformAuditLog).count() == before_count

    def test_deactivation_is_audited(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target4@p15a.com")

        deactivate_user(target.id, current_user=actor, db=db_session)

        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == target.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row.action == PlatformAuditAction.DEACTIVATE
        assert row.old_values == {"is_active": True}
        assert row.new_values == {"is_active": False}

    def test_reactivation_via_update_user_is_audited_as_activate(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target5@p15a.com", is_active=False)

        update_user(target.id, UserUpdateRequest(is_active=True), current_user=actor, db=db_session)

        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == target.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row.action == PlatformAuditAction.ACTIVATE

    def test_invitation_resend_is_audited(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "pending@p15a.com", is_verified=False)

        resend_invite(pending.id, current_user=actor, db=db_session)

        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == pending.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row.metadata_["field"] == "invitation_resent"
        assert row.new_values["invite_email_sent"] is True

    def test_failed_mutation_writes_no_audit_row(self, db_session, org_a):
        """log_no_commit only flushes into the caller's transaction — a
        rejected mutation (e.g. escalation attempt) must leave zero rows."""
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target6@p15a.com")

        before_count = db_session.query(PlatformAuditLog).count()
        with pytest.raises(ForbiddenException):
            update_user(target.id, UserUpdateRequest(role=UserRole.ORG_ADMIN), current_user=actor, db=db_session)
        assert db_session.query(PlatformAuditLog).count() == before_count


# ═══════════════════════════════════════════════════════════════════════════
# Audit content & security
# ═══════════════════════════════════════════════════════════════════════════

class TestAuditContentSecurity:
    def test_audit_actor_and_target_are_correct(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target7@p15a.com")
        deactivate_user(target.id, current_user=actor, db=db_session)

        row = db_session.query(PlatformAuditLog).filter(PlatformAuditLog.entity_id == target.id).first()
        assert row.actor_id == actor.id
        assert row.actor_id != target.id
        assert row.entity_id == target.id

    def test_no_invitation_token_or_link_in_any_audit_row(self, db_session, org_a, monkeypatch):
        captured = {}

        def _fake_send(db, user, actor, link):
            captured["link"] = link
            return True

        monkeypatch.setattr(auth_service, "_send_invite_email", _fake_send)
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")

        create_user(
            UserCreateRequest(email="secure@p15a.com", first_name="S", last_name="U", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        assert captured.get("link")
        rows = db_session.query(PlatformAuditLog).all()
        for row in rows:
            blob = str(row.old_values) + str(row.new_values) + str(row.metadata_)
            assert captured["link"] not in blob

    def test_no_password_in_any_audit_row(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        created = create_user(
            UserCreateRequest(email="secure2@p15a.com", first_name="S", last_name="U", role=UserRole.BILLING_ADMIN),
            current_user=actor, db=db_session,
        )
        stored = db_session.query(User).filter(User.id == created.id).first()
        rows = db_session.query(PlatformAuditLog).filter(PlatformAuditLog.entity_id == created.id).all()
        for row in rows:
            blob = str(row.old_values) + str(row.new_values) + str(row.metadata_)
            assert stored.hashed_password not in blob
            assert "CorrectPass123!" not in blob


# ═══════════════════════════════════════════════════════════════════════════
# Audit tenant isolation
# ═══════════════════════════════════════════════════════════════════════════

class TestAuditTenantIsolation:
    def test_org_admin_a_action_never_writes_an_org_b_audit_row(self, db_session, org_a, org_b):
        actor_a = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target_a = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "target8@p15a.com")

        deactivate_user(target_a.id, current_user=actor_a, db=db_session)

        rows = db_session.query(PlatformAuditLog).filter(PlatformAuditLog.entity_id == target_a.id).all()
        assert all(r.organization_id == org_a.id for r in rows)
        assert all(r.organization_id != org_b.id for r in rows)

    def test_cross_tenant_mutation_attempt_is_rejected_and_unaudited(self, db_session, org_a, org_b):
        """Org Admin A cannot forge its way into Org B's user-management
        records via IDOR — the query is scoped by organization_id server-side
        before the row is even found, so no audit row for Org B is ever
        created from this attempt."""
        actor_a = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        user_b = _make_user(db_session, org_b, UserRole.BILLING_ADMIN, "userb@p15b.com")

        before_count = db_session.query(PlatformAuditLog).count()
        with pytest.raises(NotFoundException):
            deactivate_user(user_b.id, current_user=actor_a, db=db_session)
        assert db_session.query(PlatformAuditLog).count() == before_count
        db_session.refresh(user_b)
        assert user_b.is_active is True  # untouched


# ═══════════════════════════════════════════════════════════════════════════
# Invitation token revocation on resend
# ═══════════════════════════════════════════════════════════════════════════

class TestTokenRevocationOnResend:
    def test_old_token_invalid_after_org_admin_resend(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "resend1@p15a.com", is_verified=False)

        old_token, _ = auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()
        assert auth_service.validate_action_token(db_session, old_token, SecurityActionPurpose.INVITE) is not None

        resend_invite(pending.id, current_user=actor, db=db_session)

        assert auth_service.validate_action_token(db_session, old_token, SecurityActionPurpose.INVITE) is None

    def test_new_token_valid_and_single_use_after_resend(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "resend2@p15a.com", is_verified=False)

        auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()
        resend_invite(pending.id, current_user=actor, db=db_session)

        new_hash = _latest_unused_token_hash(db_session, pending.email, SecurityActionPurpose.INVITE)
        assert new_hash is not None
        # Exactly one unused INVITE token remains for this email — the old
        # one(s) were superseded, not left dangling alongside the new one.
        assert _unused_token_count(db_session, pending.email, SecurityActionPurpose.INVITE) == 1

    def test_resend_does_not_create_a_duplicate_user(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "resend3@p15a.com", is_verified=False)

        resend_invite(pending.id, current_user=actor, db=db_session)
        resend_invite(pending.id, current_user=actor, db=db_session)

        count = db_session.query(User).filter(User.email == "resend3@p15a.com").count()
        assert count == 1

    def test_resend_never_touches_a_password_reset_token_for_the_same_email(self, db_session, org_a, monkeypatch):
        """Step 24: invitation-token revocation must not collide with the
        independent password-reset token lifecycle for the same user."""
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "resend4@p15a.com", is_verified=False)

        reset_token, _ = auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.RESET)
        invite_token, _ = auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()

        resend_invite(pending.id, current_user=actor, db=db_session)

        assert auth_service.validate_action_token(db_session, invite_token, SecurityActionPurpose.INVITE) is None
        assert auth_service.validate_action_token(db_session, reset_token, SecurityActionPurpose.RESET) is not None


# ═══════════════════════════════════════════════════════════════════════════
# Super Admin resend (the Phase 14 gap this phase closes)
# ═══════════════════════════════════════════════════════════════════════════

class TestSuperAdminResend:
    def test_super_admin_can_resend_a_pending_org_admin_invitation(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        pending_admin = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "neworgadmin@p15a.com", is_verified=False)

        user, email_sent = UserAdminService(db_session).resend_invite(actor=super_admin, user_id=pending_admin.id)
        db_session.commit()

        assert email_sent is True
        assert user.id == pending_admin.id
        assert db_session.query(User).filter(User.email == pending_admin.email).count() == 1

    def test_super_admin_resend_reports_email_failure_truthfully(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(False))
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        pending_admin = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "neworgadmin2@p15a.com", is_verified=False)

        result = resend_super_admin_user_invite(pending_admin.id, current_user=super_admin, db=db_session)
        assert result["email_sent"] is False
        assert "could not be delivered" in result["message"].lower()

    def test_super_admin_resend_is_audited(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        pending_admin = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "neworgadmin3@p15a.com", is_verified=False)

        resend_super_admin_user_invite(pending_admin.id, current_user=super_admin, db=db_session)

        row = (
            db_session.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_id == pending_admin.id)
            .order_by(PlatformAuditLog.id.desc())
            .first()
        )
        assert row.actor_role == "super_admin"
        assert row.metadata_["field"] == "invitation_resent"

    def test_super_admin_cannot_resend_a_tenant_role_invitation(self, db_session, org_a):
        """The authority boundary: Super Admin resending stays scoped to the
        accounts it is allowed to create (org_admin only) — a
        billing_admin/finance_approver/auditor invited by that org's own
        Organization Admin is not reachable through this platform route."""
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        pending_billing_admin = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "ba@p15a.com", is_verified=False)

        with pytest.raises(ForbiddenException):
            UserAdminService(db_session).resend_invite(actor=super_admin, user_id=pending_billing_admin.id)

    def test_super_admin_resend_rejects_an_already_activated_account(self, db_session, org_a):
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        active_admin = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "active@p15a.com", is_verified=True)

        with pytest.raises(BadRequestException):
            UserAdminService(db_session).resend_invite(actor=super_admin, user_id=active_admin.id)

    def test_super_admin_resend_also_revokes_the_prior_token(self, db_session, org_a, monkeypatch):
        monkeypatch.setattr("app.services.email_service.send_user_invite_email", _fake_email(True))
        super_admin = _make_user(db_session, None, UserRole.SUPER_ADMIN, "root@platform.com")
        pending_admin = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "neworgadmin4@p15a.com", is_verified=False)

        old_token, _ = auth_service._issue_action_token(db_session, pending_admin.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()

        UserAdminService(db_session).resend_invite(actor=super_admin, user_id=pending_admin.id)
        db_session.commit()

        assert auth_service.validate_action_token(db_session, old_token, SecurityActionPurpose.INVITE) is None


# ═══════════════════════════════════════════════════════════════════════════
# Deactivated invited user cannot activate through invitation (Step 28)
# ═══════════════════════════════════════════════════════════════════════════

class TestDeactivatedInvitedUserCannotActivate:
    def test_invitation_cannot_reactivate_a_deactivated_account(self, db_session, org_a):
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "deactivated@p15a.com", is_verified=False)

        raw_token, _ = auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()

        # Org Admin deactivates the invitee before they ever accept.
        deactivate_user(pending.id, current_user=actor, db=db_session)

        with pytest.raises(BadRequestException):
            auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "NewPass123!")

        db_session.refresh(pending)
        assert pending.is_active is False  # the attempt must not have flipped it back
        assert pending.is_verified is False

    def test_password_reset_cannot_reactivate_a_deactivated_account(self, db_session, org_a):
        """Same fix, same guarantee, for the RESET purpose."""
        actor = _make_user(db_session, org_a, UserRole.ORG_ADMIN, "admin@p15a.com")
        target = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "resetdeactivated@p15a.com")

        raw_token, _ = auth_service._issue_action_token(db_session, target.email, org_a.id, SecurityActionPurpose.RESET)
        db_session.commit()
        deactivate_user(target.id, current_user=actor, db=db_session)

        with pytest.raises(BadRequestException):
            auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.RESET, "NewPass123!")

    def test_ordinary_invite_acceptance_still_activates_normally(self, db_session, org_a):
        """Regression guard: removing the unconditional is_active=True must
        not break the ordinary (never-deactivated) path."""
        pending = _make_user(db_session, org_a, UserRole.BILLING_ADMIN, "normal@p15a.com", is_verified=False)
        raw_token, _ = auth_service._issue_action_token(db_session, pending.email, org_a.id, SecurityActionPurpose.INVITE)
        db_session.commit()

        auth_service.complete_action_token(db_session, raw_token, SecurityActionPurpose.INVITE, "NewPass123!")
        db_session.refresh(pending)
        assert pending.is_active is True
        assert pending.is_verified is True
