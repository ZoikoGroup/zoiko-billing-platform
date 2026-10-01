"""
tests/test_auth_token_security.py
----------------------------------
P6 (Authentication Token Security) regression coverage.

The read-only audit for P6 found no existing test file exercising
core/dependencies.get_current_user or core/security's decode/expiry paths
directly (test_login_flow.py covers login_user's credential/account-state
branches only). These call the dependency/service functions directly as
plain Python, matching this repo's established convention (no TestClient —
see test_entitlement_enforcement_wiring.py's docstring): every protected
route ultimately calls get_current_user via FastAPI's DI, so exercising it
directly covers the same code every router runs.

Scope: these tests document and lock in CURRENT behavior. No production
code changes were made for P6 in this pass (see
docs/P6_AUTHENTICATION_TOKEN_SECURITY_REMEDIATION_REPORT.md) — the
architecture decision was Option A (targeted hardening, not a token-
transport change), so these are regression tests, not tests of new
behavior.
"""
from datetime import datetime, timedelta

import pytest
from jose import jwt

from app.config import settings
from app.core.exceptions import ForbiddenException, UnauthorizedException
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_access_token,
    decode_refresh_token,
)
from app.core.dependencies import (
    get_current_billing_admin,
    get_current_org_admin,
    get_current_user,
    get_organization_id,
)
from app.modules.auth.models import User, UserRole

from tests.conftest import make_organization


@pytest.fixture()
def org(db_session):
    return make_organization(db_session, code="AUTHORG1", name="Auth Test Org 1")


@pytest.fixture()
def other_org(db_session):
    return make_organization(db_session, code="AUTHORG2", name="Auth Test Org 2")


def _make_user(db, organization, role=UserRole.ORG_ADMIN, email="authuser@example.com", **kw):
    from app.core.security import hash_password

    is_active = kw.pop("is_active", True)
    user = User(
        email=email,
        hashed_password=hash_password("CorrectPass123!"),
        role=role,
        organization_id=organization.id if organization is not None else None,
        first_name="Auth",
        last_name="Test",
        phone="",
        is_active=is_active,
        is_verified=True,
        **kw,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _payload_for(user):
    return {
        "sub": user.email,
        "role": user.role.value,
        "user_id": user.id,
        "organization_id": user.organization_id,
    }


# ── Access token validation (get_current_user) ──────────────────────────────

class TestGetCurrentUserTokenValidation:
    def test_valid_access_token_resolves_the_user(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_access_token(data=_payload_for(user))
        resolved = get_current_user(token=token, db=db_session)
        assert resolved.id == user.id

    def test_expired_access_token_is_rejected(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_access_token(data=_payload_for(user), expires_delta=timedelta(seconds=-1))
        with pytest.raises(UnauthorizedException):
            get_current_user(token=token, db=db_session)

    def test_tampered_signature_is_rejected(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_access_token(data=_payload_for(user))
        tampered = token[:-4] + ("aaaa" if not token.endswith("aaaa") else "bbbb")
        with pytest.raises(UnauthorizedException):
            get_current_user(token=tampered, db=db_session)

    def test_wrong_signing_key_is_rejected(self, db_session, org):
        user = _make_user(db_session, org)
        forged = jwt.encode(
            {**_payload_for(user), "exp": 9999999999, "iss": settings.JWT_ISSUER, "type": "access"},
            "not-the-real-secret",
            algorithm=settings.ALGORITHM,
        )
        with pytest.raises(UnauthorizedException):
            get_current_user(token=forged, db=db_session)

    def test_refresh_token_is_not_accepted_as_an_access_token(self, db_session, org):
        user = _make_user(db_session, org)
        refresh = create_refresh_token(data=_payload_for(user))
        with pytest.raises(UnauthorizedException):
            get_current_user(token=refresh, db=db_session)

    def test_wrong_issuer_is_rejected(self, db_session, org):
        user = _make_user(db_session, org)
        forged = jwt.encode(
            {**_payload_for(user), "exp": 9999999999, "iss": "not-zoiko-billing-platform", "type": "access"},
            settings.BILLING_SECRET_KEY,
            algorithm=settings.ALGORITHM,
        )
        with pytest.raises(UnauthorizedException):
            get_current_user(token=forged, db=db_session)

    def test_deactivated_user_token_is_rejected_even_if_still_unexpired(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_access_token(data=_payload_for(user))
        user.is_active = False
        db_session.commit()
        with pytest.raises(UnauthorizedException):
            get_current_user(token=token, db=db_session)

    def test_role_change_since_token_issuance_invalidates_it(self, db_session, org):
        user = _make_user(db_session, org, role=UserRole.BILLING_ADMIN)
        token = create_access_token(data=_payload_for(user))
        user.role = UserRole.ORG_ADMIN
        db_session.commit()
        with pytest.raises(UnauthorizedException):
            get_current_user(token=token, db=db_session)

    def test_org_reassignment_since_token_issuance_invalidates_it(self, db_session, org, other_org):
        user = _make_user(db_session, org)
        token = create_access_token(data=_payload_for(user))
        user.organization_id = other_org.id
        db_session.commit()
        with pytest.raises(UnauthorizedException):
            get_current_user(token=token, db=db_session)

    def test_missing_or_empty_token_is_rejected(self, db_session):
        with pytest.raises(UnauthorizedException):
            get_current_user(token="", db=db_session)


# ── Refresh token validation ─────────────────────────────────────────────────

class TestRefreshTokenValidation:
    def test_valid_refresh_token_decodes(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_refresh_token(data=_payload_for(user))
        payload = decode_refresh_token(token)
        assert payload["user_id"] == user.id

    def test_expired_refresh_token_is_rejected(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_access_token(data={**_payload_for(user), "type": "refresh"}, expires_delta=timedelta(seconds=-1))
        assert decode_refresh_token(token) is None

    def test_access_token_is_not_accepted_as_a_refresh_token(self, db_session, org):
        user = _make_user(db_session, org)
        access = create_access_token(data=_payload_for(user))
        assert decode_refresh_token(access) is None

    def test_refresh_endpoint_rejects_invalid_refresh_token(self, db_session):
        from app.modules.auth.service import refresh_user_token

        with pytest.raises(UnauthorizedException):
            refresh_user_token(db_session, "not-a-real-token")

    def test_refresh_issues_a_new_access_token_for_an_active_user(self, db_session, org):
        from app.modules.auth.service import refresh_user_token

        user = _make_user(db_session, org)
        refresh = create_refresh_token(data=_payload_for(user))
        result = refresh_user_token(db_session, refresh)
        assert result["access_token"]
        assert decode_access_token(result["access_token"])["user_id"] == user.id

    def test_refresh_rejected_once_user_is_deactivated(self, db_session, org):
        from app.modules.auth.service import refresh_user_token

        user = _make_user(db_session, org)
        refresh = create_refresh_token(data=_payload_for(user))
        user.is_active = False
        db_session.commit()
        with pytest.raises(UnauthorizedException):
            refresh_user_token(db_session, refresh)


class TestAccountLoginLockout:
    def test_wrong_passwords_lock_one_account_even_when_source_ip_changes(self, db_session, org, monkeypatch):
        from app.modules.auth import service

        user = _make_user(db_session, org, email="lockout@example.com")
        monkeypatch.setattr(service.settings, "LOGIN_MAX_FAILED_ATTEMPTS", 3)
        monkeypatch.setattr(service.settings, "LOGIN_LOCKOUT_MINUTES", 15)

        for _ in range(3):
            with pytest.raises(UnauthorizedException, match="Invalid email or password"):
                service.login_user(db_session, user.email, "wrong-password")

        db_session.refresh(user)
        assert user.failed_login_attempts == 3
        assert user.login_locked_until is not None
        with pytest.raises(UnauthorizedException, match="Invalid email or password"):
            service.login_user(db_session, user.email, "CorrectPass123!")

    def test_expired_lockout_allows_success_and_resets_state(self, db_session, org, monkeypatch):
        from app.modules.auth import service

        user = _make_user(db_session, org, email="expired-lockout@example.com")
        user.failed_login_attempts = 3
        user.login_locked_until = datetime.utcnow() - timedelta(minutes=1)
        db_session.commit()
        monkeypatch.setattr(service.settings, "LOGIN_MAX_FAILED_ATTEMPTS", 3)

        result = service.login_user(db_session, user.email, "CorrectPass123!")

        db_session.refresh(user)
        assert result["user"].id == user.id
        assert user.failed_login_attempts == 0
        assert user.login_locked_until is None


# ── RBAC preserved (unauthorized role -> 403, unauthenticated -> 401) ───────

class TestAuthorizationRegression:
    def test_billing_admin_is_forbidden_from_org_admin_gate(self, db_session, org):
        user = _make_user(db_session, org, role=UserRole.BILLING_ADMIN, email="ba@example.com")
        with pytest.raises(ForbiddenException):
            get_current_org_admin(current_user=user)

    def test_org_admin_passes_billing_admin_gate(self, db_session, org):
        user = _make_user(db_session, org, role=UserRole.ORG_ADMIN, email="oa@example.com")
        assert get_current_billing_admin(current_user=user) is user

    def test_super_admin_cannot_use_org_scoped_helper(self, db_session):
        super_admin = _make_user(db_session, None, role=UserRole.SUPER_ADMIN, email="sa@example.com")
        with pytest.raises(ForbiddenException):
            get_organization_id(current_user=super_admin)

    def test_unauthenticated_request_is_rejected(self, db_session):
        with pytest.raises(UnauthorizedException):
            get_current_user(token="garbage.not.a.jwt", db=db_session)


# ── Tenant isolation (backend-level, not frontend filtering) ────────────────

class TestTenantIsolation:
    def test_get_organization_id_never_returns_a_different_tenant(self, db_session, org, other_org):
        user_a = _make_user(db_session, org, email="a@tenant-a.com")
        user_b = _make_user(db_session, other_org, email="b@tenant-b.com")
        assert get_organization_id(current_user=user_a) == org.id
        assert get_organization_id(current_user=user_b) == other_org.id
        assert get_organization_id(current_user=user_a) != get_organization_id(current_user=user_b)

    def test_org_a_token_resolves_to_org_a_user_only(self, db_session, org, other_org):
        user_a = _make_user(db_session, org, email="a2@tenant-a.com")
        _make_user(db_session, other_org, email="b2@tenant-b.com")
        token = create_access_token(data=_payload_for(user_a))
        resolved = get_current_user(token=token, db=db_session)
        assert resolved.organization_id == org.id
        assert resolved.organization_id != other_org.id


# ── Credential exposure ──────────────────────────────────────────────────────

class TestCredentialExposure:
    def test_login_result_never_contains_the_plaintext_or_hashed_password(self, db_session, org):
        from app.modules.auth import service

        _make_user(db_session, org, email="expose@example.com")
        result = service.login_user(db_session, "expose@example.com", "CorrectPass123!")
        dumped = str(result)
        assert "CorrectPass123!" not in dumped
        assert result["user"].hashed_password not in dumped

    def test_unauthorized_exception_message_carries_no_token_or_secret_material(self, db_session, org):
        user = _make_user(db_session, org)
        token = create_access_token(data=_payload_for(user), expires_delta=timedelta(seconds=-1))
        with pytest.raises(UnauthorizedException) as exc:
            get_current_user(token=token, db=db_session)
        assert settings.BILLING_SECRET_KEY not in exc.value.message
        assert token not in exc.value.message
