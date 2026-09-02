"""
modules/auth/service.py
-----------------------
Auth business logic: login, org registration, action tokens (invite /
reset), change password, and org-admin user management.
"""

import hashlib
import logging
import secrets
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from fastapi import BackgroundTasks

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
from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialSubscriptionStatus,
)
from app.modules.organizations.models import Organization, TenantLifecycleState

logger = logging.getLogger("zoiko_billing.auth")

TOKEN_TTL_HOURS = 24
INVALID_TOKEN_MESSAGE = "This link is no longer valid. Please request a new one."
INITIAL_QUOTE_VALID_DAYS = 14


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

    # P14 fix: the expiry check runs INSIDE SQL (matches
    # _consume_action_token's WHERE expires_at > :now above) instead of
    # comparing a fetched `expires_at` against datetime.utcnow() in Python.
    # A raw text() SELECT returns the column as whatever the driver hands
    # back for a DateTime — on SQLite (this platform's local-dev/test
    # fallback DB per README) that's a plain string, not a datetime, so the
    # old `expires_at <= datetime.utcnow()` raised TypeError on every call
    # once the dev DB was SQLite. Postgres was unaffected, which is why this
    # was not caught by earlier Postgres-only manual testing.
    row = db.execute(
        text(
            """
            SELECT email, organization_id, used_at, purpose,
                   CASE WHEN expires_at > :now THEN 1 ELSE 0 END AS unexpired
            FROM security_action_tokens WHERE token_hash = :hash
            """
        ),
        {"hash": _token_hash(raw_token), "now": datetime.utcnow()},
    ).fetchone()
    if row is None:
        return None
    email, organization_id, used_at, purpose_stored, unexpired = row
    if used_at is not None or purpose_stored != purpose.name or not unexpired:
        return None
    return {"token": raw_token, "email": email, "organization_id": organization_id}


def complete_action_token(db: Session, raw_token: str, purpose, new_password: str) -> dict:
    consumed = _consume_action_token(db, raw_token, purpose)
    if consumed is None:
        raise BadRequestException(INVALID_TOKEN_MESSAGE)

    user = db.query(User).filter(func.lower(User.email) == func.lower(consumed["email"])).first()
    if user is None:
        raise BadRequestException(INVALID_TOKEN_MESSAGE)

    # P15 fix: the token is already single-use-consumed above regardless of
    # outcome, so a deactivated account cannot retry this either — a fresh
    # invite/reset is required once an Organization/Super Admin reactivates
    # them. Previously this unconditionally set is_active=True, which meant
    # accepting an invite (or completing a reset) silently undid a
    # deactivation an admin had applied in the meantime. A normal invite
    # already starts is_active=True (set in invite_user) and
    # request_password_reset only ever issues a RESET token for an
    # already-active user, so this check changes nothing for the ordinary
    # path — it only closes the deactivation-bypass gap.
    if not user.is_active:
        raise BadRequestException("This account has been deactivated. Contact your administrator.")

    user.hashed_password = hash_password(new_password)
    user.is_verified = True
    db.commit()
    db.refresh(user)
    return {"message": "Password set successfully. You can now sign in."}


def _invalidate_pending_action_tokens(db: Session, email: str, purpose) -> int:
    """Marks every currently-unused, unexpired token of this purpose for
    this email as consumed, so a resend supersedes rather than merely
    supplements the previous invitation. Reuses the existing
    used_at-IS-NULL single-use gate (`_consume_action_token`,
    `validate_action_token`) instead of adding a new column/status — nothing
    in this codebase reads `used_at` as "accepted specifically" (it is only
    ever tested for NULL-ness), so "consumed by acceptance" and "superseded
    by a resend" are indistinguishable on purpose: both simply mean the
    token instance is no longer usable. Flush-only (part of the caller's
    transaction) and purpose-scoped, so invalidating pending INVITE tokens
    never touches a RESET token for the same email, or vice versa.
    Returns the number of tokens invalidated (informational, for audit
    metadata only)."""
    from sqlalchemy import text

    result = db.execute(
        text(
            """
            UPDATE security_action_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE email = :email AND purpose = :purpose AND used_at IS NULL
            """
        ),
        {"email": email, "purpose": purpose.name},
    )
    db.flush()
    return result.rowcount or 0


# ── Login ───────────────────────────────────────────────────────────────────

def login_user(db: Session, email: str, password: str) -> dict:
    try:
        user = db.query(User).filter(func.lower(User.email) == email.lower()).first()
    except sa_exc.OperationalError:
        logger.error("Database connection failed during login for %s", email)
        raise BadRequestException("The database is temporarily unavailable. Please try again in a moment.")

    now = datetime.utcnow()
    if user is not None and user.login_locked_until is not None:
        if user.login_locked_until > now:
            # Keep the response indistinguishable from a bad credential so a
            # caller cannot use the lockout state to enumerate accounts.
            raise UnauthorizedException("Invalid email or password.")
        user.failed_login_attempts = 0
        user.login_locked_until = None

    if user is None or not verify_password(password, user.hashed_password):
        if user is not None:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
            max_attempts = max(1, settings.LOGIN_MAX_FAILED_ATTEMPTS)
            if user.failed_login_attempts >= max_attempts:
                user.login_locked_until = now + timedelta(
                    minutes=max(1, settings.LOGIN_LOCKOUT_MINUTES)
                )
            db.commit()
        raise UnauthorizedException("Invalid email or password.")

    if user.organization_id:
        org = db.query(Organization).filter(Organization.id == user.organization_id).first()
        if org is not None and not org.is_active:
            raise UnauthorizedException(
                "Your organization has been suspended. Please contact support."
            )

    if not user.is_active:
        raise UnauthorizedException("Your account has been deactivated.")

    # ZB-SA-P3 (Phase 3B): real last-login evidence. Stamped only on a
    # successful credential check; committed with the request so the
    # Administrators & Users directory can show genuine recency (NULL =
    # never logged in, surfaced as UNKNOWN — never inferred).
    user.failed_login_attempts = 0
    user.login_locked_until = None
    user.last_login_at = now
    db.commit()

    token_payload = {
        "sub": user.email,
        "role": user.role.value,
        "user_id": user.id,
        "organization_id": user.organization_id,
    }

    # ZB-SA-CMD-003 v3.0 master directive: normal Super Admin login is a
    # plain password check — NO login-time MFA challenge/enrollment gate.
    # MFA is still enforced server-side at the moment of privileged access
    # via mfa_service.verify_step_up() (grant activation, circuit-breaker
    # toggles/proposals/decisions). There is deliberately no fallback that
    # bypasses that step-up.
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

def _dispatch_registration_emails(db: Session, org, admin) -> None:
    """ZB-ORG-001 + ZB-ONB-001 email dispatch — the actual sends, against
    WHATEVER session/objects the caller gives it. Exceptions are caught: a
    transient SMTP failure must never surface anywhere the user can see,
    registration has already succeeded and committed."""
    try:
        from datetime import datetime as _dt, timezone as _tz
        from app.services.email_service import (
            notify_super_admins_org_created,
            send_org_created_email,
            send_product_welcome_email,
        )

        effective_time = _dt.now(_tz.utc).strftime("%Y-%m-%d %H:%M UTC")
        send_org_created_email(
            db=db,
            email=admin.email,
            first_name=admin.first_name,
            organization_name=org.organization_name,
            recipient_role="Owner",
            actor_display_name=admin.full_name,
            effective_time=effective_time,
            organization_id=org.id,
        )
        send_product_welcome_email(
            db=db,
            email=admin.email,
            first_name=admin.first_name,
            organization_name=org.organization_name,
            organization_id=org.id,
        )
        # Master directive (ZB-SA-CMD-003 v3.0): every successful organization
        # creation notifies all active Super Admins via real email.
        notify_super_admins_org_created(db=db, organization=org, actor_email=admin.email)
    except Exception as exc:
        logger.warning("[email] Org lifecycle emails failed for org %s: %s", getattr(org, "id", None), exc)


def _send_registration_emails(org_id: int, admin_id: int) -> None:
    """FastAPI BackgroundTasks entry point — run OUTSIDE the request/response
    cycle. Each of the three sends is a real outbound SMTP connection; run
    inline and sequentially they previously added tens of seconds to the
    register response, past the frontend's fetch timeout, so the browser
    reported a failure even though the account was created successfully.

    Opens its OWN DB session: the request's session is already closed by the
    time a background task runs, and by then org/admin are guaranteed
    committed (register_enterprise commits before scheduling this) — same
    pattern as the scheduled job tasks in commercial/tasks/. NOT suitable for
    a caller with an uncommitted/test-transactional session (e.g. direct
    calls, tests) — those must go through _dispatch_registration_emails with
    their own session instead (see register_enterprise's sync fallback).
    """
    from app.database import SessionLocal
    from app.modules.organizations.models import Organization

    db = SessionLocal()
    try:
        org = db.query(Organization).filter(Organization.id == org_id).first()
        admin = db.query(User).filter(User.id == admin_id).first()
        if org is None or admin is None:
            logger.warning(
                "[email] Registration email dispatch skipped — org_id=%s/admin_id=%s not found.",
                org_id, admin_id,
            )
            return
        _dispatch_registration_emails(db, org, admin)
    finally:
        db.close()


def register_enterprise(
    db: Session, data: RegisterRequest, background_tasks: Optional["BackgroundTasks"] = None,
) -> dict:
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
        # ZB-SA-P3 (Phase 3C): new tenants start ONBOARDING — registered and
        # usable, but setup (approved subscription, configuration) is not yet
        # complete. Activation to ACTIVE is a governed lifecycle transition.
        lifecycle_state=TenantLifecycleState.ONBOARDING,
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

    # Captured before provisioning so provision_default_subscription() can
    # resolve it to the matching CommercialPlan (§B3). Recorded regardless of
    # whether it resolves, for Sales/onboarding visibility.
    account.intended_plan_code = data.intended_plan
    db.add(account)

    # CommercialSubscription (PHASE 7): provisioned against the registrant's
    # selected plan when it resolves to an ACTIVE, non-quote-only
    # CommercialPlan; falls back to the approved default plan otherwise; a
    # safe no-op (account left without a subscription) if neither resolves.
    # A free/paid plan is never invented merely to satisfy the flow. The
    # resulting subscription starts PENDING — checkout/payment (not
    # registration) is what activates it. Same transaction, flush-only.
    subscription = CommercialSubscriptionService(db).provision_default_subscription(
        account.id, intended_plan_code=data.intended_plan,
    )

    # First quote (§B4/§F1): a PENDING subscription needs something the org
    # can review and accept before it's billed — nothing else in the system
    # invents one otherwise (renewal invoicing only fires for already-ACTIVE
    # subscriptions). The org admin must accept the quote before an invoice
    # is ever generated/emailed (see accept_public_quote / approve_quote in
    # commercial_billing_router.py, which convert+finalize+send the invoice
    # at acceptance time). Created in the same transaction; never invents a
    # price — a no-op if the plan has none resolvable.
    initial_quote_id: Optional[int] = None
    if subscription is not None and subscription.status == CommercialSubscriptionStatus.PENDING:
        from app.modules.commercial.quote_service import CommercialQuoteService

        priced = CommercialSubscriptionService(db).resolve_price(subscription)
        if priced is not None:
            price_amount, currency, _interval = priced
            plan_name = subscription.plan.plan_name if subscription.plan else "Subscription"

            quote_svc = CommercialQuoteService(db)
            quote = quote_svc.create_quote(
                account_id=account.id,
                actor_id=admin.id,
                subject=f"{plan_name} subscription quote",
                notes=f"{plan_name} - subscription (first period). Accept to activate your subscription.",
                valid_until=date.today() + timedelta(days=INITIAL_QUOTE_VALID_DAYS),
                currency=currency or "USD",
                subscription_id=subscription.id,
            )
            quote_svc.add_item(
                quote_id=quote.id,
                actor_id=admin.id,
                line_number=1,
                description=f"{plan_name} - subscription (first period)",
                unit_price=price_amount,
            )
            initial_quote_id = quote.id

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
    TaxService(db).seed_starter_tax_rates(org.id, org.currency, created_by=admin.id, commit=False, country_code=org.country)

    db.commit()
    db.refresh(admin)
    db.refresh(org)

    logger.info("New organization %s registered by %s", org.organization_code, data.email)

    # ── ZB-ORG-001 + ZB-ONB-001 email dispatch ────────────────────────────
    # Run OUTSIDE the request/response cycle: three real outbound SMTP sends
    # run synchronously here used to add tens of seconds to the response
    # (past the frontend's fetch timeout), reporting failure to the user even
    # though registration had already succeeded. When called from the HTTP
    # route, background_tasks is provided and this returns immediately;
    # direct/test callers with no BackgroundTasks fall back to sending inline.
    if background_tasks is not None:
        background_tasks.add_task(_send_registration_emails, org.id, admin.id)
    else:
        # Sync fallback (direct/test callers): reuse THIS session/objects —
        # org.id/admin.id may not be visible to a fresh SessionLocal() yet
        # (e.g. a test's transactional fixture that never truly commits).
        _dispatch_registration_emails(db, org, admin)

    # Same rule applies to the initial quote email (if one was generated
    # above): a real SMTP send must never run inline in this response.
    if initial_quote_id is not None:
        from app.modules.commercial.quote_service import (
            send_quote_email_with_session,
            send_quote_in_background,
        )

        if background_tasks is not None:
            background_tasks.add_task(send_quote_in_background, initial_quote_id)
        else:
            send_quote_email_with_session(db, initial_quote_id)

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

    # P14: invite_email_sent is None when no email was even attempted
    # (send_invite=False), True/False when one was. Attached as a plain
    # (non-mapped) attribute — survives the db.refresh() below since refresh
    # only reloads mapped columns — so the router/response layer can report
    # the real outcome instead of always claiming "invitation sent."
    invite_email_sent = None
    if data.send_invite:
        raw_token, _ = _issue_action_token(db, user.email, user.organization_id, SecurityActionPurpose.INVITE)
        link = _action_link(SecurityActionPurpose.INVITE, raw_token)
        invite_email_sent = _send_invite_email(db, user, actor, link)

    # P15: Organization-Admin-driven user mutations previously wrote no
    # audit record at all (only the Super-Admin-facing UserAdminService did).
    # Reuses the same platform-plane audit trail/service — flushed into THIS
    # transaction so a rollback discards the audit row along with the user
    # it describes, never a stray audit entry for a user that doesn't exist.
    # organization_id is always the actor's own (never client input), which
    # is what keeps this tenant-safe. Never includes the raw token/link.
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(
        actor_id=actor.id,
        actor_role=actor.role.value,
        action=PlatformAuditAction.CREATE,
        entity_type="User",
        entity_id=user.id,
        organization_id=actor.organization_id,
        new_values={
            "email": user.email,
            "role": user.role.value,
            "send_invite": bool(data.send_invite),
            "invite_email_sent": invite_email_sent,
        },
        metadata={"field": "user_created", "plane": "TENANT", "source": "org_admin"},
    )

    db.commit()
    db.refresh(user)
    user.invite_email_sent = invite_email_sent
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


def _send_invite_email(db: Session, user: User, actor, link: str) -> bool:
    """Returns whether the SMTP send actually succeeded (send_approval_email's
    own bool) — callers must not report "invitation sent" without checking
    this; a failed send is logged (email_service) but never raises."""
    from app.services.email_service import send_user_invite_email

    return send_user_invite_email(
        db=db,
        email=user.email,
        first_name=user.first_name,
        invite_link=link,
        invited_by=actor.full_name,
        organization_id=user.organization_id,
    )
