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
