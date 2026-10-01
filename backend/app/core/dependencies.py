"""
core/dependencies.py
--------------------
Auth dependencies for the standalone Billing Platform.

Role hierarchy (lowest = highest privilege):
    super_admin    → platform-level, organization_id is None
    org_admin      → full control inside their own org
    billing_admin  → day-to-day billing operations inside their own org

Every billing query for a non-super-admin role MUST be scoped by
organization_id. Super Admin never reads through the org-scoped helpers;
it must explicitly pass an organization_id (get_super_admin_organization_id
or require_organization_access), or it is blocked.
"""

from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import exc as sa_exc
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.core.cache_service import ORG_GATE_KEY, cache_delete, cache_get, cache_set
from app.core.security import decode_access_token
from app.core.exceptions import ForbiddenException, UnauthorizedException

# Tokens are issued by this platform only (see core/security.py).
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

ROLE_SUPER_ADMIN = "super_admin"
ROLE_ORG_ADMIN = "org_admin"
ROLE_BILLING_ADMIN = "billing_admin"
# §25 Segregation-of-Duties Doctrine: a distinct approver role (so maker-
# checker gates can require someone other than whoever can create the
# request) and a read-only floor role for Support/Legal-style access.
ROLE_FINANCE_APPROVER = "finance_approver"
ROLE_AUDITOR = "auditor"

VALID_ROLES = {
    ROLE_SUPER_ADMIN, ROLE_ORG_ADMIN, ROLE_BILLING_ADMIN,
    ROLE_FINANCE_APPROVER, ROLE_AUDITOR,
}

# What each role may create (org admin manages org users; super admin
# manages org admins platform-wide).
ROLE_CREATION_RULES = {
    ROLE_SUPER_ADMIN: [ROLE_ORG_ADMIN],
    ROLE_ORG_ADMIN: [ROLE_BILLING_ADMIN, ROLE_FINANCE_APPROVER, ROLE_AUDITOR],
    ROLE_BILLING_ADMIN: [],
    ROLE_FINANCE_APPROVER: [],
    ROLE_AUDITOR: [],
}


def can_create_role(creator_role, target_role) -> bool:
    return target_role in ROLE_CREATION_RULES.get(creator_role, [])


def _role_value(user) -> str:
    role = getattr(user, "role", "") or ""
    return role.value if hasattr(role, "value") else str(role)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Any authenticated, active user. Returns the User ORM row."""
    payload = decode_access_token(token)
    if payload is None:
        raise UnauthorizedException("Invalid or expired token. Please log in again.")

    user_id = payload.get("user_id")
    if user_id is None:
        raise UnauthorizedException("Token is missing user information.")

    from app.modules.auth.models import User

    try:
        user = db.query(User).filter(User.id == user_id).first()
    except sa_exc.OperationalError:
        raise UnauthorizedException("The database is temporarily unavailable. Please try again in a moment.")
    if user is None:
        raise UnauthorizedException("User account not found. Please log in again.")
    if not user.is_active:
        raise UnauthorizedException("Your account is disabled. Contact your administrator.")

    # Reject tokens issued for a different role/org than the DB currently
    # holds — a role demotion or org transfer must invalidate stale sessions.
    jwt_role = payload.get("role")
    if jwt_role != _role_value(user):
        raise UnauthorizedException("Your role changed. Please log in again.")

    jwt_org_id = payload.get("organization_id")
    if jwt_org_id != user.organization_id:
        raise UnauthorizedException("Your organization assignment changed. Please log in again.")

    # A super_admin token must not carry an organization_id.
    if _role_value(user) == ROLE_SUPER_ADMIN and user.organization_id is not None:
        raise UnauthorizedException("Super Admin token is invalid.")

    return user


def get_current_super_admin(current_user=Depends(get_current_user)):
    """Only platform-level Super Admin. Bypasses all org scoping."""
    if _role_value(current_user) != ROLE_SUPER_ADMIN:
        raise ForbiddenException("This action requires Super Admin privileges.")
    if current_user.organization_id is not None:
        raise ForbiddenException("Super Admin must not belong to an organization.")
    return current_user


def get_current_org_admin(current_user=Depends(get_current_user)):
    """Org-scoped admin: org_admin (or super_admin, who may act cross-org)."""
    role = _role_value(current_user)
    if role not in (ROLE_ORG_ADMIN, ROLE_SUPER_ADMIN):
        raise ForbiddenException(
            f"This action requires organization admin privileges. Your role: {role}"
        )
    return current_user


def get_current_billing_admin(current_user=Depends(get_current_user)):
    """Org-scoped billing operator: org_admin or billing_admin (or
    super_admin acting cross-org). This is the gate used by the copied
    billing routers — it replaces the old platform's get_current_billing_admin
    (super_admin/admin/billing_admin), remapped to this platform's role
    names (admin -> org_admin)."""
    role = _role_value(current_user)
    if role not in (ROLE_ORG_ADMIN, ROLE_BILLING_ADMIN, ROLE_SUPER_ADMIN):
        raise ForbiddenException(
            f"This action requires billing admin privileges. Your role: {role}"
        )
    return current_user


def get_current_finance_approver(current_user=Depends(get_current_user)):
    """§25: distinct from billing_admin. Can approve refunds/discounts/
    write-offs/credit-notes that a billing_admin submitted, but per SoD,
    never their own (enforced separately, in each service's approve method)."""
    role = _role_value(current_user)
    if role not in (ROLE_FINANCE_APPROVER, ROLE_SUPER_ADMIN):
        raise ForbiddenException(
            f"This action requires Finance Approver privileges. Your role: {role}"
        )
    return current_user


def get_current_auditor_or_above(current_user=Depends(get_current_user)):
    """Read-only floor. Any authenticated role may satisfy this — it's a
    minimum, not a ceiling, so org_admin/billing_admin/finance_approver/
    super_admin all pass too."""
    return current_user


def _org_gate_snapshot(db: Session, organization_id: int) -> dict:
    """Build the {org_exists, org_active, subscription_suspended,
    subscription_recovery} gate snapshot (primary source of truth) — the
    cached form of the three-to-five queries both subscription gates run.
    """
    from app.modules.organizations.models import Organization
    from app.modules.commercial.enums import CommercialSubscriptionStatus
    from app.modules.commercial.models import CommercialAccount, CommercialSubscription

    snapshot = {
        "org_exists": True,
        "org_active": False,
        "subscription_suspended": False,
        "subscription_recovery": False,
    }
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        return {"org_exists": False, "org_active": False,
                "subscription_suspended": False, "subscription_recovery": False}
    snapshot["org_active"] = bool(org.is_active)
    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == organization_id)
        .first()
    )
    if account is not None:
        sub = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.commercial_account_id == account.id,
                CommercialSubscription.status.in_([
                    CommercialSubscriptionStatus.SUSPENDED,
                    CommercialSubscriptionStatus.TRIAL_RECOVERY,
                ]),
            )
            .order_by(CommercialSubscription.id.desc())
            .first()
        )
        if sub is not None:
            if sub.status == CommercialSubscriptionStatus.SUSPENDED:
                snapshot["subscription_suspended"] = True
            else:
                snapshot["subscription_recovery"] = True
    return snapshot


def _get_org_gate(db: Session, organization_id: int) -> dict:
    """Cached org access-gate snapshot used by both subscription gates.

    Bounds a freshly-suspended org's ability to keep writing in the same
    request flow without querying on every request. TTL is short
    (REDIS_GATE_TTL); subscription status transitions invalidate the entry
    proactively (see cache_service.invalidate_subscription_caches).
    """
    cached = cache_get(ORG_GATE_KEY.format(org_id=organization_id))
    if cached is not None:
        return cached
    snapshot = _org_gate_snapshot(db, organization_id)
    cache_set(
        ORG_GATE_KEY.format(org_id=organization_id),
        snapshot,
        ttl=settings.REDIS_GATE_TTL,
    )
    return snapshot


def invalidate_org_gate(organization_id: int) -> None:
    cache_delete(ORG_GATE_KEY.format(org_id=organization_id))


def get_organization_id(current_user=Depends(get_current_user)) -> int:
    """Return the current user's organization_id.

    Super Admin MUST use get_super_admin_organization_id instead — using
    this helper with a super_admin token is blocked, because a Super Admin
    belongs to no single org.
    """
    role = _role_value(current_user)
    if role == ROLE_SUPER_ADMIN:
        raise ForbiddenException(
            "Super Admin must use get_super_admin_organization_id() to explicitly select an organization."
        )
    if current_user.organization_id is None:
        raise ForbiddenException("User is not associated with any organization.")
    return current_user.organization_id


def get_super_admin_organization_id(
    organization_id: int = None,
    current_user=Depends(get_current_user),
) -> int:
    """Super Admin must explicitly provide organization_id; non-super admins
    cannot use this helper."""
    role = _role_value(current_user)
    if role != ROLE_SUPER_ADMIN:
        raise ForbiddenException("Only Super Admin can use this dependency.")
    if organization_id is None:
        raise ForbiddenException(
            "Super Admin must provide an organization_id query parameter to access organization data."
        )
    return organization_id


def require_organization_access(
    target_organization_id: int,
    current_user=Depends(get_current_user),
) -> bool:
    """Super Admin may access any org; every other role is confined to its own
    organization_id. Cross-org attempts are rejected."""
    role = _role_value(current_user)
    if role == ROLE_SUPER_ADMIN:
        return True
    if current_user.organization_id != target_organization_id:
        raise ForbiddenException(
            f"Access denied: you can only access data from your own organization "
            f"(ID: {current_user.organization_id})."
        )
    return True


def require_active_subscription(product_code: str):
    """Dependency factory kept for parity with the copied billing routers.

    The old platform checked a billing subscription + product entitlement.
    The standalone platform has no separate entitlement system — every
    onboarded organization is entitled to the one product it runs on. This
    gate now simply verifies the organization exists and is not suspended.
    Super Admin bypasses it.

    §5 (Free Trial Standard): a subscription in TRIAL_RECOVERY (the 14-day
    read/export-only window after a trial expires unpaid) is NOT treated as
    suspended here — the org keeps read-only / export access so it can view
    its data and still self-serve convert to a paid plan. The write-side
    blocking (new revenue-generating state) is enforced separately by
    require_new_revenue_generation_allowed(), which the write sub-routers
    add. Only true SUSPENDED (recovery window also over) blocks the whole
    product.
    """
    async def _check_subscription(
        current_user=Depends(get_current_user),
        db: Session = Depends(get_db),
    ):
        role = _role_value(current_user)
        if role == ROLE_SUPER_ADMIN:
            return current_user
        if current_user.organization_id is None:
            raise ForbiddenException("User is not associated with any organization.")

        try:
            gate = _get_org_gate(db, current_user.organization_id)
        except sa_exc.OperationalError:
            raise ForbiddenException("The database is temporarily unavailable. Please try again in a moment.")
        if not gate["org_exists"]:
            raise ForbiddenException("Your organization no longer exists.")
        if not gate["org_active"]:
            raise ForbiddenException(
                "Your organization is suspended. Please contact support to regain access."
            )
        if gate["subscription_suspended"]:
            raise ForbiddenException(
                "Your organization's Zoiko subscription is suspended. "
                "Pay the outstanding invoice from the Zoiko Subscription page to regain access."
            )
        return current_user

    return _check_subscription


def require_new_revenue_generation_allowed(product_code: str):
    """Dependency factory for write endpoints that create revenue-generating
    state.

    §5 (Free Trial Standard): "new revenue-generating actions are disabled"
    during the TRIAL_RECOVERY window. The base require_active_subscription
    gate lets TRIAL_RECOVERY through for read/export access; THIS gate is the
    write-side half — it blocks specific endpoints whose actions would create
    new charged state (new invoices, new customers, new subscriptions, new
    quotes, sending invoices/quotes) while the org is in TRIAL_RECOVERY.
    Ambiguous endpoints are BLOCKED (fail closed) — a product decision can
    loosen this later, but no ambiguous action is silently permitted.

    In trialing or fully-active subscriptions this gate passes (a trial can
    still create invoices/customers/quotes — trial caps govern volume, not
    this binary gate). Super Admin bypasses it.
    """
    async def _check_write_allowed(
        current_user=Depends(get_current_user),
        db: Session = Depends(get_db),
    ):
        role = _role_value(current_user)
        if role == ROLE_SUPER_ADMIN:
            return current_user
        if current_user.organization_id is None:
            raise ForbiddenException("User is not associated with any organization.")

        gate = _get_org_gate(db, current_user.organization_id)
        if not gate["org_exists"]:
            return current_user
        if gate["subscription_recovery"]:
            raise ForbiddenException(
                "Your trial has ended and your organization is in its read/export-only "
                "recovery window. New revenue-generating actions (invoices, customers, "
                "subscriptions, quotes) are disabled until you convert to a paid plan."
            )
        return current_user

    return _check_write_allowed
