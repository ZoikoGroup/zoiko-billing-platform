"""
modules/auth/service.py
-----------------------
Auth business logic: login, org registration, action tokens (invite /
reset), change password, and org-admin user management.
"""

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.code_generation import generate_organization_code
from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
)
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_password,
)
from app.modules.auth.models import SecurityActionPurpose, SecurityActionToken, User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.organizations.models import Organization

logger = logging.getLogger("zoiko_billing.auth")

TOKEN_TTL_HOURS = 24
INVALID_TOKEN_MESSAGE = "This link is no longer valid. Please request a new one."


# ── Action tokens (invite / password reset) ────────────────────────────────

def _token_hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _action_link(purpose: SecurityActionPurpose, raw_token: str) -> str:
    base = os.environ.get("API_BASE_URL", "http://localhost:8000")
    path = "accept-invite" if purpose == SecurityActionPurpose.INVITE else "reset-password"
    return f"{base}/auth/{path}?token={raw_token}"


def _issue_action_token(db: Session, email: str, organization_id, purpose) -> tuple[str, datetime]:
    raw_token = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS)
    db.add(SecurityActionToken(
        email=email,
        organization_id=organization_id,
        purpose=purpose,
        token_hash=_token_hash(raw_token),
        expires_at=expires_at,
    ))
    db.flush()
    return raw_token, expires_at


def _consume_action_token(db: Session, raw_token: str, purpose) -> Optional[dict]:
    """Atomically consume a single-use token (UPDATE ... RETURNING). Returns
    {"email":..., "organization_id":...} or None for every invalid state."""
    from sqlalchemy import text

    row = db.execute(
        text(
            """
            UPDATE security_action_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE token_hash = :hash
              AND purpose = :purpose
              AND used_at IS NULL
              AND expires_at > :now
            RETURNING email, organization_id
            """
        ),
        {"hash": _token_hash(raw_token), "purpose": purpose.name, "now": datetime.utcnow()},
    ).fetchone()
    if row is None:
        return None
    return {"email": row[0], "organization_id": row[1]}


def validate_action_token(db: Session, raw_token: str, purpose) -> Optional[dict]:
    from sqlalchemy import text

    row = db.execute(
        text("SELECT email, organization_id, expires_at, used_at, purpose FROM security_action_tokens WHERE token_hash = :hash"),
        {"hash": _token_hash(raw_token)},
    ).fetchone()
    if row is None:
        return None
    email, organization_id, expires_at, used_at, purpose_stored = row
    if (
        used_at is not None
        or purpose_stored != purpose.name
        or expires_at <= datetime.utcnow()
    ):
        return None
    return {"token": raw_token, "email": email, "organization_id": organization_id}


def complete_action_token(db: Session, raw_token: str, purpose, new_password: str) -> dict:
    consumed = _consume_action_token(db, raw_token, purpose)
    if consumed is None:
        raise BadRequestException(INVALID_TOKEN_MESSAGE)

    user = db.query(User).filter(User.email == consumed["email"]).first()
    if user is None:
        raise BadRequestException(INVALID_TOKEN_MESSAGE)

    user.hashed_password = hash_password(new_password)
    user.is_active = True
    db.commit()
    db.refresh(user)
    return {"message": "Password set successfully. You can now sign in."}


# ── Login ───────────────────────────────────────────────────────────────────

def login_user(db: Session, email: str, password: str) -> dict:
    user = db.query(User).filter(User.email == email).first()
    if user is None or not verify_password(password, user.hashed_password):
        raise UnauthorizedException("Invalid email or password.")

    if user.organization_id:
        org = db.query(Organization).filter(Organization.id == user.organization_id).first()
        if org is not None and not org.is_active:
            raise UnauthorizedException(
                "Your organization has been suspended. Please contact support."
            )

    if not user.is_active:
        raise UnauthorizedException("Your account has been deactivated.")

    token_payload = {
        "sub": user.email,
        "role": user.role.value,
        "user_id": user.id,
        "organization_id": user.organization_id,
    }
    access_token = create_access_token(data=token_payload)
    refresh_token = create_refresh_token(data=token_payload)

    logger.info("User %s (%s) logged in", user.email, user.role.value)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": user,
    }


def refresh_user_token(db: Session, refresh_token: str) -> dict:
    from app.core.security import decode_refresh_token

    payload = decode_refresh_token(refresh_token)
    if payload is None:
        raise UnauthorizedException("Invalid or expired refresh token.")

    user = db.query(User).filter(User.id == payload.get("user_id")).first()
    if user is None or not user.is_active:
        raise UnauthorizedException("User not found or inactive.")

    if user.organization_id:
        org = db.query(Organization).filter(Organization.id == user.organization_id).first()
        if org is not None and not org.is_active:
            raise UnauthorizedException("Your organization has been suspended.")

    new_access = create_access_token(data={
        "sub": user.email,
        "role": user.role.value,
        "user_id": user.id,
        "organization_id": user.organization_id,
    })
    return {
        "access_token": new_access,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": user,
    }


# ── Registration (public self-serve onboarding) ─────────────────────────────

def register_enterprise(db: Session, data: RegisterRequest) -> dict:
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise AlreadyExistsException("User", "email")

    org_code = generate_organization_code(data.organization, db)

    org = Organization(
        organization_name=data.organization,
        organization_code=org_code,
        industry=data.industry,
        address=data.address,
        email=data.email,
        phone=data.phone,
        timezone=data.timezone or "UTC",
        is_active=True,
    )
    db.add(org)
    db.flush()

    name_parts = data.name.strip().split(" ", 1)
    first_name = name_parts[0]
    last_name = name_parts[1] if len(name_parts) > 1 else "Admin"

    admin = User(
        email=data.email,
        hashed_password=hash_password(data.password),
        role=UserRole.ORG_ADMIN,
        organization_id=org.id,
        first_name=first_name,
        last_name=last_name,
        phone=data.phone or "",
        is_active=True,
        is_verified=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    db.refresh(org)

    logger.info("New organization %s registered by %s", org.organization_code, data.email)

    token_payload = {
        "sub": admin.email,
        "role": admin.role.value,
        "user_id": admin.id,
        "organization_id": admin.organization_id,
    }
    return {
        "access_token": create_access_token(data=token_payload),
        "refresh_token": create_refresh_token(data=token_payload),
        "token_type": "bearer",
        "user": admin,
    }


# ── Password flows ──────────────────────────────────────────────────────────

def request_password_reset(db: Session, email: str) -> dict:
    user = db.query(User).filter(User.email == email).first()
    if user is not None and user.is_active:
        raw_token, _ = _issue_action_token(db, user.email, user.organization_id, SecurityActionPurpose.RESET)
        link = _action_link(SecurityActionPurpose.RESET, raw_token)
        db.commit()
        _send_reset_email(db, user, link)
    else:
        db.rollback()
    # Always return the same message to avoid email enumeration.
    return {"message": "If that email is registered, a password reset link has been sent."}


def change_password(db: Session, user_id: int, current_password: str, new_password: str) -> dict:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise NotFoundException("User", "id")
    if not verify_password(current_password, user.hashed_password):
        raise BadRequestException("Current password is incorrect.")
    user.hashed_password = hash_password(new_password)
    db.commit()
    return {"message": "Password changed successfully."}


def invite_user(db: Session, actor, data) -> User:
    """Org admin invites a billing_admin into their own org."""
    from app.modules.auth.schemas import UserCreateRequest
    from app.core.dependencies import can_create_role

    if not can_create_role(actor.role.value, data.role.value):
        raise ForbiddenException(
            f"Role {actor.role.value} cannot create users with role {data.role.value}."
        )
    if actor.organization_id is None:
        raise ForbiddenException("Super Admin must create users via the super-admin API.")

    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise AlreadyExistsException("User", "email")

    user = User(
        email=data.email,
        hashed_password=hash_password(secrets.token_urlsafe(24)),
        role=data.role,
        organization_id=actor.organization_id,
        first_name=data.first_name,
        last_name=data.last_name,
        phone=data.phone or "",
        is_active=True,
        is_verified=False,
    )
    db.add(user)
    db.flush()

    if data.send_invite:
        raw_token, _ = _issue_action_token(db, user.email, user.organization_id, SecurityActionPurpose.INVITE)
        link = _action_link(SecurityActionPurpose.INVITE, raw_token)
        _send_invite_email(db, user, actor, link)

    db.commit()
    db.refresh(user)
    return user


# ── Email notifications ─────────────────────────────────────────────────────

def _send_reset_email(db: Session, user: User, link: str) -> None:
    from app.services.email_service import send_org_admin_password_reset_email

    send_org_admin_password_reset_email(
        db=db,
        email=user.email,
        first_name=user.first_name,
        reset_link=link,
        organization_id=user.organization_id,
    )


def _send_invite_email(db: Session, user: User, actor, link: str) -> None:
    from app.services.email_service import send_user_invite_email

    send_user_invite_email(
        db=db,
        email=user.email,
        first_name=user.first_name,
        invite_link=link,
        invited_by=actor.full_name,
        organization_id=user.organization_id,
    )
