"""
modules/auth/service.py
-----------------------
Auth business logic: login, org registration, action tokens (invite /
reset), change password, and org-admin user management.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import exc as sa_exc, func
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
    create_mfa_pending_token,
    create_refresh_token,
    hash_password,
    verify_password,
)
from app.modules.auth.country_currency import (
    resolve_currency,
    resolve_fiscal_year,
    resolve_timezone,
)
from app.modules.auth.models import SecurityActionPurpose, SecurityActionToken, User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.commercial.enums import BillingClassification, BillingSource
from app.modules.organizations.models import Organization

logger = logging.getLogger("zoiko_billing.auth")

TOKEN_TTL_HOURS = 24
INVALID_TOKEN_MESSAGE = "This link is no longer valid. Please request a new one."


# ── Action tokens (invite / password reset) ────────────────────────────────

def _token_hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _action_link(purpose: SecurityActionPurpose, raw_token: str) -> str:
    # Phase 6 production-readiness finding: os.environ.get("FRONTEND_URL")
    # only sees a value if it's a real exported shell/container env var --
    # pydantic-settings reads .env into its own internal source without
    # writing it back into os.environ, so a FRONTEND_URL set only in .env
    # (this app's documented configuration mechanism) was silently ignored
    # here, and every invite/password-reset email linked to localhost
    # regardless of the configured production frontend URL.
    base = settings.FRONTEND_URL.rstrip("/")
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

    user = db.query(User).filter(func.lower(User.email) == func.lower(consumed["email"])).first()
    if user is None:
        raise BadRequestException(INVALID_TOKEN_MESSAGE)

    user.hashed_password = hash_password(new_password)
    user.is_active = True
    user.is_verified = True
    db.commit()
    db.refresh(user)
    return {"message": "Password set successfully. You can now sign in."}


# ── Login ───────────────────────────────────────────────────────────────────

def login_user(db: Session, email: str, password: str) -> dict:
    try:
        user = db.query(User).filter(func.lower(User.email) == email.lower()).first()
    except sa_exc.OperationalError:
        logger.error("Database connection failed during login for %s", email)
        raise BadRequestException("The database is temporarily unavailable. Please try again in a moment.")
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

    if user.role == UserRole.SUPER_ADMIN:
        from app.modules.auth import mfa_service

        purpose = "challenge" if mfa_service.is_mfa_enabled(db, user.id) else "enroll"
        logger.info("Super Admin %s login pending MFA (%s)", user.email, purpose)
        return {
            "mfa_status": "challenge_required" if purpose == "challenge" else "enrollment_required",
            "mfa_token": create_mfa_pending_token(token_payload, purpose),
        }

    access_token = create_access_token(data=token_payload)
    refresh_token = create_refresh_token(data=token_payload)

    logger.info("User %s (%s) logged in", user.email, user.role.value)
    return {
        "mfa_status": "none",
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

    try:
        user = db.query(User).filter(User.id == payload.get("user_id")).first()
    except sa_exc.OperationalError:
        logger.error("Database connection failed during token refresh")
        raise BadRequestException("The database is temporarily unavailable. Please try again in a moment.")
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
    existing = db.query(User).filter(func.lower(User.email) == data.email.lower()).first()
    if existing:
        raise AlreadyExistsException("User", "email")

    org_code = generate_organization_code(data.organization, db)

    # Country → default currency intelligence (single authoritative mapping in
    # auth/country_currency.py). Precedence: explicit currency > country-derived
    # default > safe fallback. model_fields_set distinguishes "user chose USD"
    # from "client did not send currency at all", so an India registration
    # without an explicit currency correctly derives INR instead of USD.
    explicit_currency = data.currency if "currency" in data.model_fields_set else None
    currency = resolve_currency(explicit_currency, data.country)

    # Same explicit > country-derived > safe-fallback precedence as currency
    # above, applied to timezone and fiscal year -- so a direct API caller
    # (bypassing RegisterPage's own client-side country defaults) still gets
    # a country-appropriate value instead of a hardcoded UTC/Jan-Dec default.
    explicit_timezone = data.timezone if "timezone" in data.model_fields_set else None
    timezone = resolve_timezone(explicit_timezone, data.country)
    explicit_fy_start = data.fiscal_year_start if "fiscal_year_start" in data.model_fields_set else None
    explicit_fy_end = data.fiscal_year_end if "fiscal_year_end" in data.model_fields_set else None
    fiscal_year_start, fiscal_year_end = resolve_fiscal_year(explicit_fy_start, explicit_fy_end, data.country)

    org = Organization(
        organization_name=data.organization,
        organization_code=org_code,
        legal_name=data.legal_name,
        industry=data.industry,
        address=data.address,
        city=data.city,
        state=data.state,
        country=data.country,
        postal_code=data.postal_code,
        email=data.email,
        phone=data.phone,
        website=data.website,
        tax_no=data.tax_no,
        registration_number=data.registration_number,
        currency=currency,
        timezone=timezone,
        fiscal_year_start=fiscal_year_start,
        fiscal_year_end=fiscal_year_end,
        # Stamped server-side — never accepted from the client, so a tenant
        # cannot self-attribute a Zoiko One source to skip a charge.
        billing_classification=BillingClassification.COMMERCIAL_STANDALONE,
        billing_source=BillingSource.REGISTERED_VIA_STANDALONE,
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
    db.flush()

    # CommercialAccount is created inside the same transaction (PHASE 6):
    # organization + user + commercial account + billing configuration commit
    # together, so any failure rolls back the whole registration instead of
    # leaving a partially initialized tenant. ensure_commercial_account() is
    # idempotent and flush-only (does not commit). billing_source and
    # billing_classification come from the Organization's Phase 1 server-side
    # stamps — the account does not accept them from the client.
    from app.modules.commercial.service import (
        CommercialAccountService,
        CommercialSubscriptionService,
    )
    account = CommercialAccountService(db).ensure_commercial_account(org.id)

    # CommercialSubscription (PHASE 7): provisioned ONLY when an approved
    # default plan exists. Phase 7 seeds no plans, so this is a safe no-op that
    # leaves the account without a subscription — a free/paid plan is never
    # invented merely to satisfy the flow. Same transaction, flush-only.
    CommercialSubscriptionService(db).provision_default_subscription(account.id)

    # Intent capture only (§B3) — provision_default_subscription() already
    # correctly refuses to invent a subscription when no approved plan
    # exists. This just records what the registrant said they wanted, for
    # the eventual checkout/upgrade flow and for Sales follow-up on
    # Business/Professional leads. Does not create a CommercialSubscription.
    account.intended_plan_code = data.intended_plan
    db.add(account)

    # BillingConfiguration is initialized inside the same transaction (PHASE 4):
    # organization + user + config commit together, so a failure rolls back the
    # whole registration instead of leaving a partially initialized tenant.
    # seed_billing_configuration() is idempotent and does not commit; the lazy
    # GET /billing/settings/config backstop still covers any org without a config.
    from app.modules.billing.services.settings_service import BillingConfigurationService
    BillingConfigurationService(db).seed_billing_configuration(org.id)

    # Starter tax catalogue seed for the org's billing currency (Phase 5.7),
    # inside the same transaction as org + user + config: a fresh org's
    # currency is derived from country (explicit > country-derived > USD
    # fallback), so a currency with a real catalogue entry (e.g. India → INR)
    # seeds its starter rates here; a currency without a catalogue entry (e.g.
    # USD) is a deliberate no-op, not an error. commit=False keeps this
    # flush-only so a failure here rolls back org+user+config too instead of
    # leaving a partially initialized tenant -- the same all-or-nothing
    # guarantee PHASE 4/6 already give BillingConfiguration/CommercialAccount.
    from app.modules.billing.services.tax_service import TaxService
    TaxService(db).seed_starter_tax_rates(org.id, org.currency, created_by=admin.id, commit=False)

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
    user = db.query(User).filter(func.lower(User.email) == email.lower()).first()
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

    existing = db.query(User).filter(func.lower(User.email) == data.email.lower()).first()
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
