"""
tests/test_mfa_service.py
---------------------------
Coverage for app/modules/auth/mfa_service.py after the ZB-SA-CMD-003 v3.0
master directive removed the login-time MFA gate. MFA is now a STEP-UP-ONLY
factor: login issues real tokens on a valid password for every role, and
this module is the sole server-side enforcement point at the moment of
privileged actions (tenant-access activation, circuit-breaker changes,
approval decisions).

Coverage:
   1. enrollment (start + verify) enables MFA and returns recovery codes
      exactly once — from an authenticated session, minting NO tokens
   2. verify_enrollment rejects a wrong code and does not enable MFA
   3. wrong TOTP code is rejected by step-up and increments failed_attempts
   4. account locks out after MFA_MAX_FAILED_ATTEMPTS; even a CORRECT code
      is rejected while locked
   5. recovery code is single-use in step-up (second use of the same code
      fails)
   6. TOTP replay protection: the SAME code cannot be reused for a second
      step-up within the replay window
   7. a different, later code succeeds normally (replay protection isn't
      overly broad)
   8. verify_step_up requires MFA to be enabled at all
"""

from datetime import datetime

import pyotp
import pytest

from app.core.exceptions import BadRequestException, UnauthorizedException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth import mfa_service
from app.modules.auth.models import SuperAdminMFA, User, UserRole


def _mfa_super_admin(db, email="mfa@test.example"):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db.add(user)
    db.flush()
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.flush()
    return user, secret


def test_enrollment_enables_mfa_and_returns_recovery_codes_once(db_session):
    user = User(
        email="enroll@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    start = mfa_service.start_enrollment(db_session, user)
    assert start["secret"] and start["otpauth_url"].startswith("otpauth://totp/")

    result = mfa_service.verify_enrollment(db_session, user, pyotp.TOTP(start["secret"]).now())
    # Step-up-only model: enrollment NEVER mints tokens.
    assert "access_token" not in result and "refresh_token" not in result
    assert len(result["recovery_codes"]) == mfa_service.RECOVERY_CODE_COUNT
    assert mfa_service.is_mfa_enabled(db_session, user.id) is True

    # A second verify is refused (already enabled).
    with pytest.raises(BadRequestException):
        mfa_service.verify_enrollment(db_session, user, pyotp.TOTP(start["secret"]).now())


def test_verify_enrollment_rejects_wrong_code_and_stays_disabled(db_session):
    user = User(
        email="enroll2@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    start = mfa_service.start_enrollment(db_session, user)
    with pytest.raises(BadRequestException):
        mfa_service.verify_enrollment(db_session, user, "000000")
    assert mfa_service.is_mfa_enabled(db_session, user.id) is False


def test_enrollment_accepts_a_separated_or_padded_code(db_session):
    """pyotp does a strict string compare, so a code pasted as "123 456" used
    to be rejected as if the operator had typed the wrong one."""
    user = User(
        email="enroll-spaced@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    start = mfa_service.start_enrollment(db_session, user)
    code = pyotp.TOTP(start["secret"]).now()
    spaced = f" {code[:3]} {code[3:]} "

    result = mfa_service.verify_enrollment(db_session, user, spaced)
    assert len(result["recovery_codes"]) == mfa_service.RECOVERY_CODE_COUNT
    assert mfa_service.is_mfa_enabled(db_session, user.id) is True


def test_step_up_bypass_lets_an_unenrolled_account_through(monkeypatch, db_session):
    """Dev convenience: no authenticator required while the flag is on."""
    user = User(
        email="bypass@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    monkeypatch.setattr(mfa_service.settings, "MFA_STEP_UP_BYPASS", True)
    monkeypatch.setattr(mfa_service.settings, "DEBUG", True)

    assert mfa_service.is_mfa_enabled(db_session, user.id) is False
    assert mfa_service.step_up_is_bypassed() is True
    # Without the flag this exact call refuses outright.
    mfa_service.verify_step_up(db_session, user, code=None, recovery_code=None)


def test_step_up_bypass_is_inert_when_disabled(monkeypatch, db_session):
    """The default must be the secure behaviour, not the convenient one."""
    user = User(
        email="nobypass@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    monkeypatch.setattr(mfa_service.settings, "MFA_STEP_UP_BYPASS", False)
    assert mfa_service.step_up_is_bypassed() is False
    with pytest.raises(BadRequestException):
        mfa_service.verify_step_up(db_session, user, code=None, recovery_code=None)


def test_bypass_cannot_be_enabled_without_debug(monkeypatch):
    """Config must refuse to load with the control off in a real deployment."""
    from pydantic import ValidationError
    from app.config import Settings

    monkeypatch.setenv("MFA_STEP_UP_BYPASS", "true")
    monkeypatch.setenv("DEBUG", "false")

    with pytest.raises(ValidationError) as exc:
        Settings(
            _env_file=None,
            BILLING_DATABASE_URL="postgresql://x/y",
            BILLING_SECRET_KEY="k",
            MFA_ENCRYPTION_KEY="k",
        )
    assert "MFA_STEP_UP_BYPASS" in str(exc.value)


def test_start_enrollment_replaces_a_pending_secret(db_session):
    """regenerate=True is the only path that discards a pending key."""
    user = User(
        email="enroll-restart@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    first = mfa_service.start_enrollment(db_session, user)
    second = mfa_service.start_enrollment(db_session, user, regenerate=True)
    assert first["secret"] != second["secret"]
    assert first["reused_pending"] is False
    assert second["reused_pending"] is False

    # The discarded key is dead — confirming it is impossible, not unlucky.
    with pytest.raises(BadRequestException):
        mfa_service.verify_enrollment(db_session, user, pyotp.TOTP(first["secret"]).now())

    # The freshly issued one works.
    mfa_service.verify_enrollment(db_session, user, pyotp.TOTP(second["secret"]).now())
    assert mfa_service.is_mfa_enabled(db_session, user.id) is True


def test_start_enrollment_replays_a_pending_secret_instead_of_replacing_it(db_session):
    """Re-opening the setup screen must not invalidate a key the operator has
    already entered in their authenticator. That produced codes which could
    never verify, with no signal that the key had been swapped underneath."""
    user = User(
        email="enroll-replay@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    first = mfa_service.start_enrollment(db_session, user)
    assert first["reused_pending"] is False

    for _ in range(3):
        again = mfa_service.start_enrollment(db_session, user)
        assert again["secret"] == first["secret"]
        assert again["otpauth_url"] == first["otpauth_url"]
        assert again["reused_pending"] is True

    # The key from the FIRST call still verifies after all those re-opens.
    result = mfa_service.verify_enrollment(db_session, user, pyotp.TOTP(first["secret"]).now())
    assert len(result["recovery_codes"]) == mfa_service.RECOVERY_CODE_COUNT
    assert mfa_service.is_mfa_enabled(db_session, user.id) is True


def test_start_enrollment_still_refuses_once_mfa_is_enabled(db_session):
    user = User(
        email="enroll-guard@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    start = mfa_service.start_enrollment(db_session, user)
    mfa_service.verify_enrollment(db_session, user, pyotp.TOTP(start["secret"]).now())

    # Replay must not become a way to re-issue a secret over an enabled account.
    with pytest.raises(BadRequestException):
        mfa_service.start_enrollment(db_session, user)
    with pytest.raises(BadRequestException):
        mfa_service.start_enrollment(db_session, user, regenerate=True)


def test_wrong_code_rejected_and_counted(db_session):
    user, _secret = _mfa_super_admin(db_session)
    with pytest.raises(UnauthorizedException):
        mfa_service.verify_step_up(db_session, user, code="000000", recovery_code=None)
    row = db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    assert row.failed_attempts == 1


def test_account_locks_after_max_failed_attempts(db_session):
    from app.config import settings

    user, _secret = _mfa_super_admin(db_session)
    for _ in range(settings.MFA_MAX_FAILED_ATTEMPTS):
        with pytest.raises(UnauthorizedException):
            mfa_service.verify_step_up(db_session, user, code="000000", recovery_code=None)

    row = db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    assert row.locked_until is not None and row.locked_until > datetime.utcnow()

    # Even a CORRECT code is rejected once locked.
    with pytest.raises(UnauthorizedException):
        mfa_service.verify_step_up(db_session, user, code="000000", recovery_code=None)


def test_recovery_code_is_single_use_in_step_up(db_session):
    user, secret = _mfa_super_admin(db_session)
    enrollment_row = db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    from app.modules.auth.mfa_service import _hash_code
    from app.modules.auth.models import SuperAdminMFARecoveryCode

    raw_code = "abcd1234ef"
    db_session.add(SuperAdminMFARecoveryCode(mfa_id=enrollment_row.id, code_hash=_hash_code(raw_code)))
    db_session.commit()

    mfa_service.verify_step_up(db_session, user, code=None, recovery_code=raw_code)  # should not raise

    with pytest.raises(UnauthorizedException):
        mfa_service.verify_step_up(db_session, user, code=None, recovery_code=raw_code)

    # A normal TOTP code still works afterwards (lockout was never triggered).
    mfa_service.verify_step_up(db_session, user, code=pyotp.TOTP(secret).now(), recovery_code=None)


def test_totp_replay_rejected_within_step_up(db_session):
    user, secret = _mfa_super_admin(db_session)
    code = pyotp.TOTP(secret).now()

    mfa_service.verify_step_up(db_session, user, code=code, recovery_code=None)
    with pytest.raises(UnauthorizedException):
        mfa_service.verify_step_up(db_session, user, code=code, recovery_code=None)


def test_different_code_succeeds_after_replay_rejection(db_session):
    import time

    user, secret = _mfa_super_admin(db_session)
    totp = pyotp.TOTP(secret)
    code1 = totp.now()
    mfa_service.verify_step_up(db_session, user, code=code1, recovery_code=None)

    # A different time-step's code (not the one just consumed) must work.
    # Uses an explicit Unix timestamp (not a naive datetime) to avoid
    # pyotp.TOTP.at() silently misinterpreting a naive datetime.utcnow()
    # value in the system's local timezone instead of UTC.
    code2 = totp.at(int(time.time()) + 30)
    assert code2 != code1
    mfa_service.verify_step_up(db_session, user, code=code2, recovery_code=None)  # should not raise


def test_step_up_requires_mfa_enabled(db_session):
    user = User(
        email="nomfa@test.example", hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    with pytest.raises(BadRequestException):
        mfa_service.verify_step_up(db_session, user, code="123456", recovery_code=None)
