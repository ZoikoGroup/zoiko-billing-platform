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

from app.database import get_db
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

        from app.modules.organizations.models import Organization

        try:
            org = db.query(Organization).filter(Organization.id == current_user.organization_id).first()
        except sa_exc.OperationalError:
            raise ForbiddenException("The database is temporarily unavailable. Please try again in a moment.")
        if org is None:
            raise ForbiddenException("Your organization no longer exists.")
        if not org.is_active:
            raise ForbiddenException(
                "Your organization is suspended. Please contact support to regain access."
            )
        return current_user

    return _check_subscription
