"""
tests/test_login_flow.py
------------------------
Regression tests for the login/authentication flow fix:

- LoginRequest normalizes whitespace-padded emails (autofill artifact)
  WITHOUT touching the password bytes.
- login_user issues tokens only on a real credential match and never
  echoes the password back in any form.
- Account-state failures (suspended org / deactivated user) raise 401
  with their own specific messages, not the generic credentials message.
"""
import pytest

from app.core.exceptions import UnauthorizedException
from app.core.security import hash_password, verify_password
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import LoginRequest
from app.modules.organizations.models import Organization

from tests.conftest import make_organization


@pytest.fixture()
def org(db_session):
    return make_organization(db_session)


def _make_user(db, organization, email="user@example.com", password="CorrectPass123!", **kw):
    is_active = kw.pop("is_active", True)
    user = User(
        email=email,
        hashed_password=hash_password(password),
        role=UserRole.ORG_ADMIN,
        organization_id=organization.id,
        first_name="Login",
        last_name="Flow",
        phone="",
        is_active=is_active,
        is_verified=True,
        **kw,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


# ── Schema normalization ─────────────────────────────────────────────────────

class TestLoginRequestNormalization:
    def test_whitespace_padded_email_is_stripped(self):
        req = LoginRequest(email="  user@example.com  ", password="secret")
        assert req.email == "user@example.com"

    def test_password_is_never_trimmed_or_altered(self):
        raw = "  padded secret\t"
        req = LoginRequest(email="user@example.com", password=raw)
        assert req.password == raw

    def test_malformed_email_still_rejected_with_422_style_error(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            LoginRequest(email="not-an-email", password="secret")

    def test_empty_password_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            LoginRequest(email="user@example.com", password="")


# ── Service behavior ─────────────────────────────────────────────────────────

class TestLoginService:
    def test_correct_credentials_issue_tokens_and_user(self, db_session, org):
        from app.modules.auth import service

        _make_user(db_session, org)
        result = service.login_user(
            db_session,
            LoginRequest(email="user@example.com", password="CorrectPass123!").email,
            "CorrectPass123!",
        )
        assert result["access_token"] and result["refresh_token"]
        assert result["token_type"] == "bearer"
        assert result["user"].email == "user@example.com"
        # The password must never appear anywhere in the response payload.
        assert "password" not in str(result)

    def test_wrong_password_raises_401_invalid_credentials(self, db_session, org):
        from app.modules.auth import service

        _make_user(db_session, org)
        with pytest.raises(UnauthorizedException) as exc:
            service.login_user(db_session, "user@example.com", "WrongPass999!")
        assert exc.value.status_code == 401
        assert "Invalid email or password." == exc.value.message

    def test_unknown_email_raises_401_invalid_credentials(self, db_session, org):
        from app.modules.auth import service

        with pytest.raises(UnauthorizedException) as exc:
            service.login_user(db_session, "ghost@nowhere.com", "Whatever123!")
        assert exc.value.status_code == 401
        assert exc.value.message == "Invalid email or password."

    def test_lookup_is_case_insensitive_on_email(self, db_session, org):
        from app.modules.auth import service

        _make_user(db_session, org, email="Mixed.Case@Example.com")
        result = service.login_user(
            db_session,
            LoginRequest(email="mixed.case@EXAMPLE.com", password="CorrectPass123!").email,
            "CorrectPass123!",
        )
        assert result["user"].email.lower() == "mixed.case@example.com"

    def test_suspended_organization_uses_specific_message_not_generic(self, db_session, org):
        from app.modules.auth import service

        user = _make_user(db_session, org)
        org.is_active = False
        db_session.commit()

        with pytest.raises(UnauthorizedException) as exc:
            service.login_user(db_session, user.email, "CorrectPass123!")
        assert "suspended" in exc.value.message.lower()

    def test_deactivated_user_uses_specific_message_not_generic(self, db_session, org):
        from app.modules.auth import service

        user = _make_user(db_session, org, is_active=False)
        with pytest.raises(UnauthorizedException) as exc:
            service.login_user(db_session, user.email, "CorrectPass123!")
        assert "deactivated" in exc.value.message.lower()

    def test_last_login_stamped_only_on_success(self, db_session, org):
        from app.modules.auth import service

        user = _make_user(db_session, org)
        assert user.last_login_at is None
        try:
            service.login_user(db_session, user.email, "nope")
        except UnauthorizedException:
            pass
        db_session.refresh(user)
        assert user.last_login_at is None  # failed attempt must not stamp

        service.login_user(db_session, user.email, "CorrectPass123!")
        db_session.refresh(user)
        assert user.last_login_at is not None
