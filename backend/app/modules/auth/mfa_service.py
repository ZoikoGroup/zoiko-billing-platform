"""
modules/auth/mfa_service.py
----------------------------
Backend-enforced TOTP MFA for Super Admin accounts only (release-blocker
pass, Blocker 4 — SEC-01).

Enforcement point: login_user() (auth/service.py) never issues a real
access/refresh token pair to a super_admin directly. It always routes
through here first — either start_enrollment (no MFA configured yet) or a
challenge (MFA already enabled) — and only THIS module's verify_enrollment/
challenge functions ever call create_access_token/create_refresh_token for a
super_admin. A frontend "MFA passed" flag has no bearing on this: there is
no code path that mints a real token for a super_admin without a verified
TOTP code (or recovery code) having been checked server-side, in this
module, against the database.

Secrets: encrypted at rest (core/mfa_crypto.py, a key separate from the JWT
signing key). Recovery codes: only their SHA-256 hash is ever stored (same
pattern as SecurityActionToken). Neither is ever logged.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta

import pyotp
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, UnauthorizedException
from app.core.mfa_crypto import decrypt_secret, encrypt_secret
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_mfa_pending_token,
    verify_password,
)
from app.modules.auth.models import SuperAdminMFA, SuperAdminMFARecoveryCode, User, UserRole

logger = logging.getLogger("zoiko_billing.auth.mfa")

RECOVERY_CODE_COUNT = 10


def resolve_pending_user(db: Session, mfa_token: str, expected_purpose: str) -> User:
    """Decodes a restricted mfa_pending token and loads the matching, still
    just-as-active Super Admin. Re-verifies is_active/role from the DB
    (never trusts the token claims alone) -- the same stale-claim-rejection
    discipline get_current_user applies to real access tokens."""
    payload = decode_mfa_pending_token(mfa_token, expected_purpose)
    if payload is None:
        raise UnauthorizedException("Invalid or expired MFA session. Please log in again.")

    user = db.query(User).filter(User.id == payload.get("user_id")).first()
    if user is None or not user.is_active or user.role != UserRole.SUPER_ADMIN:
        raise UnauthorizedException("Invalid or expired MFA session. Please log in again.")
    return user


def _hash_code(raw_code: str) -> str:
    return hashlib.sha256(raw_code.encode("utf-8")).hexdigest()


def _generate_recovery_codes() -> list[str]:
    return [secrets.token_hex(5) for _ in range(RECOVERY_CODE_COUNT)]


def _token_payload(user: User) -> dict:
    return {
        "sub": user.email,
        "role": user.role.value,
        "user_id": user.id,
        "organization_id": user.organization_id,
    }


def _issue_real_tokens(user: User) -> dict:
    payload = _token_payload(user)
    return {
        "access_token": create_access_token(data=payload),
        "refresh_token": create_refresh_token(data=payload),
        "token_type": "bearer",
        "user": user,
    }


def get_or_create_mfa_row(db: Session, user: User) -> SuperAdminMFA:
    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    if row is None:
        row = SuperAdminMFA(user_id=user.id, secret_encrypted="", is_enabled=False)
        db.add(row)
        db.flush()
    return row


def is_mfa_enabled(db: Session, user_id: int) -> bool:
    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user_id).first()
    return bool(row and row.is_enabled)


# ── Enrollment ───────────────────────────────────────────────────────────────

def start_enrollment(db: Session, user: User) -> dict:
    """(Re)generates a fresh, unconfirmed TOTP secret. Safe to call again
    before verify_enrollment completes (e.g. the user re-scans a fresh QR) —
    only verify_enrollment ever flips is_enabled to True."""
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    row = get_or_create_mfa_row(db, user)
    if row.is_enabled:
        raise BadRequestException("MFA is already enabled on this account.")

    raw_secret = pyotp.random_base32()
    row.secret_encrypted = encrypt_secret(raw_secret)
    row.enrolled_at = datetime.utcnow()
    row.failed_attempts = 0
    row.locked_until = None

    PlatformAuditService(db).log_no_commit(
        actor_id=user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.MFA_ENROLLED,
        entity_type="SuperAdminMFA",
        entity_id=row.id,
        metadata={"stage": "secret_generated"},
    )
    db.commit()

    totp = pyotp.TOTP(raw_secret)
    otpauth_url = totp.provisioning_uri(name=user.email, issuer_name=settings.MFA_ISSUER_NAME)
    return {"secret": raw_secret, "otpauth_url": otpauth_url, "issuer": settings.MFA_ISSUER_NAME}


def verify_enrollment(db: Session, user: User, code: str) -> dict:
    """Confirms enrollment with a real TOTP code from the authenticator app,
    enables MFA, issues one-time recovery codes, and completes login by
    minting the real access/refresh token pair."""
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    if row is None or not row.secret_encrypted or row.is_enabled:
        raise BadRequestException("No pending MFA enrollment found for this account.")

    raw_secret = decrypt_secret(row.secret_encrypted)
    if not pyotp.TOTP(raw_secret).verify(code, valid_window=1):
        PlatformAuditService(db).log_no_commit(
            actor_id=user.id,
            actor_role="super_admin",
            action=PlatformAuditAction.MFA_CHALLENGE_FAILURE,
            entity_type="SuperAdminMFA",
            entity_id=row.id,
            metadata={"stage": "enroll_verify"},
        )
        db.commit()
        raise BadRequestException("Incorrect verification code. Please try again.")

    row.is_enabled = True
    row.enabled_at = datetime.utcnow()
    row.failed_attempts = 0
    row.locked_until = None

    # Replace any leftover unused codes from a prior aborted enrollment.
    db.query(SuperAdminMFARecoveryCode).filter(SuperAdminMFARecoveryCode.mfa_id == row.id).delete()
    raw_codes = _generate_recovery_codes()
    for raw_code in raw_codes:
        db.add(SuperAdminMFARecoveryCode(mfa_id=row.id, code_hash=_hash_code(raw_code)))

    PlatformAuditService(db).log_no_commit(
        actor_id=user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.MFA_ENABLED,
        entity_type="SuperAdminMFA",
        entity_id=row.id,
    )
    db.commit()
    db.refresh(user)

    logger.info("Super Admin %s completed MFA enrollment", user.email)
    result = _issue_real_tokens(user)
    result["recovery_codes"] = raw_codes
    return result


# ── Login-time challenge ─────────────────────────────────────────────────────

def challenge(db: Session, user: User, code: str | None, recovery_code: str | None) -> dict:
    """Verifies a TOTP code or a recovery code for a user whose MFA is
    already enabled, enforcing account-level lockout after repeated
    failures (independent of the IP-based rate limit on the endpoint
    itself). On success, mints the real access/refresh token pair."""
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    if row is None or not row.is_enabled:
        raise BadRequestException("MFA is not enabled on this account.")

    if row.locked_until and row.locked_until > datetime.utcnow():
        raise UnauthorizedException(
            f"Too many failed MFA attempts. Try again after {row.locked_until.isoformat()}Z."
        )

    used_recovery = False
    verified = False

    if recovery_code:
        candidate_hash = _hash_code(recovery_code.strip().replace("-", "").lower())
        recovery_row = (
            db.query(SuperAdminMFARecoveryCode)
            .filter(
                SuperAdminMFARecoveryCode.mfa_id == row.id,
                SuperAdminMFARecoveryCode.code_hash == candidate_hash,
                SuperAdminMFARecoveryCode.used_at.is_(None),
            )
            .first()
        )
        if recovery_row is not None:
            recovery_row.used_at = datetime.utcnow()
            verified = True
            used_recovery = True
    elif code:
        raw_secret = decrypt_secret(row.secret_encrypted)
        verified = pyotp.TOTP(raw_secret).verify(code, valid_window=1)

    if not verified:
        row.failed_attempts += 1
        locked = row.failed_attempts >= settings.MFA_MAX_FAILED_ATTEMPTS
        if locked:
            row.locked_until = datetime.utcnow() + timedelta(minutes=settings.MFA_LOCKOUT_MINUTES)
        PlatformAuditService(db).log_no_commit(
            actor_id=user.id,
            actor_role="super_admin",
            action=PlatformAuditAction.MFA_CHALLENGE_FAILURE,
            entity_type="SuperAdminMFA",
            entity_id=row.id,
            metadata={"stage": "challenge", "locked": locked, "failed_attempts": row.failed_attempts},
        )
        db.commit()
        raise UnauthorizedException("Incorrect verification code.")

    row.failed_attempts = 0
    row.locked_until = None

    PlatformAuditService(db).log_no_commit(
        actor_id=user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.MFA_CHALLENGE_SUCCESS,
        entity_type="SuperAdminMFA",
        entity_id=row.id,
        metadata={"via": "recovery_code" if used_recovery else "totp"},
    )
    if used_recovery:
        PlatformAuditService(db).log_no_commit(
            actor_id=user.id,
            actor_role="super_admin",
            action=PlatformAuditAction.MFA_RECOVERY_CODE_USED,
            entity_type="SuperAdminMFA",
            entity_id=row.id,
        )
    db.commit()
    db.refresh(user)

    logger.info("Super Admin %s passed MFA challenge (%s)", user.email, "recovery_code" if used_recovery else "totp")
    result = _issue_real_tokens(user)
    if used_recovery:
        remaining = (
            db.query(SuperAdminMFARecoveryCode)
            .filter(SuperAdminMFARecoveryCode.mfa_id == row.id, SuperAdminMFARecoveryCode.used_at.is_(None))
            .count()
        )
        result["recovery_codes_remaining"] = remaining
    return result


# ── Self-service disable + administrative reset ─────────────────────────────

def disable_mfa_self(db: Session, user: User, current_password: str) -> dict:
    """A fully-authenticated Super Admin (already holds a real access token,
    which itself required a passed MFA challenge if MFA was enabled) may
    disable their own MFA -- step-up-confirmed by re-entering their current
    password, since this reduces their own account's security posture."""
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    if not verify_password(current_password, user.hashed_password):
        raise BadRequestException("Current password is incorrect.")

    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    if row is None or not row.is_enabled:
        raise BadRequestException("MFA is not enabled on this account.")

    row.is_enabled = False
    row.disabled_at = datetime.utcnow()
    row.secret_encrypted = ""
    db.query(SuperAdminMFARecoveryCode).filter(SuperAdminMFARecoveryCode.mfa_id == row.id).delete()

    PlatformAuditService(db).log_no_commit(
        actor_id=user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.MFA_DISABLED,
        entity_type="SuperAdminMFA",
        entity_id=row.id,
        metadata={"initiated_by": "self"},
    )
    db.commit()
    return {"message": "MFA has been disabled on your account. You will be asked to re-enroll on your next login."}


def admin_reset_mfa(db: Session, actor: User, target_user_id: int) -> dict:
    """Disaster-recovery path: another Super Admin resets a locked-out
    colleague's MFA (lost device + lost recovery codes) so they can
    re-enroll from scratch on their next login. Strongly authorized (caller
    must already hold a real, fully-privileged Super Admin session -- see
    get_current_super_admin) and always audited with both actor and target
    identity."""
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction
    from app.core.exceptions import NotFoundException

    target = db.query(User).filter(User.id == target_user_id).first()
    if target is None:
        raise NotFoundException("User", "id")

    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == target_user_id).first()
    if row is None or not row.is_enabled:
        raise BadRequestException("MFA is not currently enabled on that account.")

    row.is_enabled = False
    row.disabled_at = datetime.utcnow()
    row.secret_encrypted = ""
    row.failed_attempts = 0
    row.locked_until = None
    db.query(SuperAdminMFARecoveryCode).filter(SuperAdminMFARecoveryCode.mfa_id == row.id).delete()

    PlatformAuditService(db).log_no_commit(
        actor_id=actor.id,
        actor_role="super_admin",
        action=PlatformAuditAction.MFA_ADMIN_RESET,
        entity_type="SuperAdminMFA",
        entity_id=row.id,
        metadata={"target_user_id": target_user_id, "target_email": target.email},
        reason=f"Administrative MFA reset for {target.email} by {actor.email}",
    )
    db.commit()
    logger.warning("Super Admin %s administratively reset MFA for %s", actor.email, target.email)
    return {"message": f"MFA has been reset for {target.email}. They will be asked to re-enroll on their next login."}
