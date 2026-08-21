"""
modules/auth/mfa_service.py
---------------------------
Server-enforced TOTP MFA for Super Admin accounts — STEP-UP ONLY
(ZB-SA-CMD-003 v3.0 master directive).

Normal login NEVER involves MFA: login_user() issues a real access/refresh
token pair to every role on a plain password check, with no mfa_status /
mfa_token side-channel and no enrollment redirect. There is deliberately no
fallback around this.

What MFA still guards — and the ONLY thing it guards — is privileged
actions taken from an already-authenticated session:

  * privileged tenant access activation (privileged_access_service)
  * circuit-breaker engage/lift, proposal and decision (§9)
  * any other operation routed through verify_step_up()

verify_step_up() reuses the same SuperAdminMFA row, TOTP secret and
account-level lockout counter that enrollment set up, never mints tokens,
and requires a FRESH code on every call (replay protection). A frontend
"MFA passed" flag has no bearing on any of this: enforcement is always a
server-side database check inside this module at the moment of the action.

Enrollment is self-service from an authenticated Super Admin session via
start_enrollment()/verify_enrollment() (exposed at /auth/mfa/setup/*) —
NOT at login. Secrets are encrypted at rest (core/mfa_crypto.py, a key
separate from the JWT signing key). Recovery codes: only their SHA-256
hash is ever stored (same pattern as SecurityActionToken). Neither is ever
logged.
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
from app.core.security import verify_password
from app.modules.auth.models import SuperAdminMFA, SuperAdminMFARecoveryCode, User, UserRole

logger = logging.getLogger("zoiko_billing.auth.mfa")

RECOVERY_CODE_COUNT = 10


def _hash_code(raw_code: str) -> str:
    return hashlib.sha256(raw_code.encode("utf-8")).hexdigest()


# TOTP replay window: matches pyotp's valid_window=1 (±1 step of 30s = up
# to ~90s a code stays verifiable). Anything shorter would under-protect;
# anything much longer risks rejecting a legitimately-reused-looking but
# actually-new code from a resynced client clock — 120s gives a safety
# margin without meaningfully widening the attack window.
TOTP_REPLAY_WINDOW_SECONDS = 120


def _totp_code_is_replay(row: "SuperAdminMFA", code: str) -> bool:
    if not row.last_used_code_hash or not row.last_used_code_at:
        return False
    if row.last_used_code_at < datetime.utcnow() - timedelta(seconds=TOTP_REPLAY_WINDOW_SECONDS):
        return False
    return row.last_used_code_hash == _hash_code(code)


def _record_totp_code_used(row: "SuperAdminMFA", code: str) -> None:
    row.last_used_code_hash = _hash_code(code)
    row.last_used_code_at = datetime.utcnow()


def _generate_recovery_codes() -> list[str]:
    return [secrets.token_hex(5) for _ in range(RECOVERY_CODE_COUNT)]


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


# ── Enrollment (self-service from an authenticated session) ──────────────────

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
    """Confirms enrollment with a real TOTP code from the authenticator app
    and enables MFA for step-up verification. Called from an already-
    authenticated session — it NEVER mints tokens (login does not involve
    MFA). Issues one-time recovery codes, returned exactly once."""
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
    return {"recovery_codes": raw_codes}


# ── Step-up (re-)verification for an already-authenticated session ──────────
# ZB-SA-CMD-003 §7: privileged tenant access requires "MFA step-up" at the
# moment of activation. This is now the SOLE enforcement point of MFA in the
# system (there is no login-time gate anymore). Reuses the exact same
# SuperAdminMFA row, TOTP secret and account-level lockout counter as every
# other flow (one shared brute-force budget per account), but never mints
# tokens — the caller already holds a valid access token; this only proves
# fresh possession of the factor for one sensitive action.

def verify_step_up(db: Session, user: User, code: str | None, recovery_code: str | None) -> None:
    """Raises BadRequestException/UnauthorizedException on failure. Returns
    None (no tokens) on success."""
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).first()
    if row is None or not row.is_enabled:
        raise BadRequestException("MFA is not enabled on this account. Step-up verification requires MFA.")

    if row.locked_until and row.locked_until > datetime.utcnow():
        raise UnauthorizedException(
            f"Too many failed MFA attempts. Try again after {row.locked_until.isoformat()}Z."
        )

    verified = False
    used_recovery = False
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
        # Replay protection: a code consumed by an earlier step-up cannot be
        # reused — each privileged action needs a FRESH authentication event
        # (ZB-SA-CMD-003 §19).
        verified = pyotp.TOTP(raw_secret).verify(code, valid_window=1) and not _totp_code_is_replay(row, code)

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
            metadata={"stage": "step_up", "locked": locked, "failed_attempts": row.failed_attempts},
        )
        db.commit()
        raise UnauthorizedException("Incorrect verification code.")

    if code and not used_recovery:
        _record_totp_code_used(row, code)
    row.failed_attempts = 0
    row.locked_until = None
    PlatformAuditService(db).log_no_commit(
        actor_id=user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.MFA_CHALLENGE_SUCCESS,
        entity_type="SuperAdminMFA",
        entity_id=row.id,
        metadata={"stage": "step_up", "via": "recovery_code" if used_recovery else "totp"},
    )
    db.commit()


# ── Self-service disable + administrative reset ─────────────────────────────

def disable_mfa_self(db: Session, user: User, current_password: str) -> dict:
    """A fully-authenticated Super Admin may disable their own MFA —
    confirmed by re-entering their current password, since this reduces
    their own account's security posture (step-up will then fail until they
    re-enroll, which is surfaced honestly rather than papered over)."""
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
    return {"message": "MFA has been disabled on your account. Privileged actions will require re-enrolling first."}


def admin_reset_mfa(db: Session, actor: User, target_user_id: int) -> dict:
    """Disaster-recovery path: another Super Admin resets a locked-out
    colleague's MFA (lost device + lost recovery codes) so they can
    re-enroll from Settings. Strongly authorized (caller must already hold
    a real, fully-privileged Super Admin session -- see
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
    return {"message": f"MFA has been reset for {target.email}. They can re-enroll from Settings."}
