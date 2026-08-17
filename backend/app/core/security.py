"""
core/security.py
----------------
Password hashing + JWT create/verify for the standalone billing platform.

JWT contract (namespaced — never accepted by the main platform):
  - signed with BILLING_SECRET_KEY (own secret, not the main platform's)
  - payload: sub=user email, user_id, role, organization_id (null for
    super_admin), iss=settings.JWT_ISSUER, type=access|refresh, exp
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain_password: str) -> str:
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def _encode(data: dict, expires_delta: timedelta, token_type: str) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({
        "exp": expire,
        "iss": settings.JWT_ISSUER,
        "type": token_type,
    })
    return jwt.encode(to_encode, settings.BILLING_SECRET_KEY, algorithm=settings.ALGORITHM)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    delta = expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    return _encode(data, delta, "access")


def create_refresh_token(data: dict) -> str:
    return _encode(data, timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS), "refresh")


def create_mfa_pending_token(data: dict, mfa_purpose: str) -> str:
    """Short-lived, narrowly-scoped token issued after password verification
    but BEFORE MFA is satisfied. `mfa_purpose` is either "enroll" or
    "challenge" — decode_mfa_pending_token enforces the caller asked for the
    matching purpose, so an enrollment-pending token can never be replayed
    against the challenge endpoint (or vice versa). This token alone grants
    NO access to any privileged endpoint — get_current_user/
    get_current_super_admin only ever accept type="access" tokens."""
    payload = dict(data)
    payload["mfa_purpose"] = mfa_purpose
    return _encode(payload, timedelta(minutes=settings.MFA_PENDING_TOKEN_EXPIRE_MINUTES), "mfa_pending")


def decode_mfa_pending_token(token: str, expected_purpose: str) -> Optional[dict]:
    payload = _decode(token, expected_type="mfa_pending")
    if payload is None:
        return None
    if payload.get("mfa_purpose") != expected_purpose:
        return None
    return payload


def decode_access_token(token: str) -> Optional[dict]:
    return _decode(token, expected_type="access")


def decode_refresh_token(token: str) -> Optional[dict]:
    return _decode(token, expected_type="refresh")


def _decode(token: str, expected_type: str) -> Optional[dict]:
    try:
        payload = jwt.decode(
            token,
            settings.BILLING_SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            issuer=settings.JWT_ISSUER,
        )
    except JWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    if payload.get("iss") != settings.JWT_ISSUER:
        return None
    return payload
