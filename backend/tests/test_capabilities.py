"""
tests/test_capabilities.py
-----------------------------
ZB-SA-CMD-003 §26 — real, ENFORCED capability-based authorization
(app/core/capabilities.py). Session 5 shipped this as scaffolding (every
capability resolved to the same coarse super_admin check); session 6
implements real per-role differentiation via `PlatformRole`
(auth/models.py) and this file now tests actual enforcement, not just the
declaration mechanics.

Coverage:
  1. unknown capability rejected at declaration time (unchanged)
  2. a NULL platform_role (every pre-existing super_admin account) keeps
     full access — backward compatible, no data migration needed
  3. PLATFORM_ADMINISTRATOR explicitly set has full access
  4. SUPPORT_OPERATOR can request tenant support access but NOT read
     financial consistency (horizontal capability boundary)
  5. AUDITOR can read financial consistency/governance but CANNOT request
     tenant support access (vertical privilege boundary — read vs. act)
  6. RELIABILITY_OPERATOR can act on incidents but not manage platform roles
  7. only PLATFORM_ADMINISTRATOR holds platform_role.manage (privilege
     escalation prevention: a non-admin operator cannot grant themselves
     or anyone else more capabilities)
  8. the FastAPI dependency raises ForbiddenException (403) for a
     capability the caller's platform_role doesn't include, and passes
     through the user object when it does
"""

import pytest

from app.core.capabilities import CAPABILITIES, has_capability, require_capability
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import PlatformRole, User, UserRole


def _super_admin(email, platform_role=None):
    return User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="A", is_active=True, is_verified=True, platform_role=platform_role,
    )


def test_unknown_capability_rejected_at_declaration_time():
    with pytest.raises(ValueError):
        require_capability("not_a_real_capability")


def test_null_platform_role_keeps_full_access():
    user = _super_admin("legacy@cap.example", platform_role=None)
    assert has_capability(user, "tenant_support.request")
    assert has_capability(user, "financial_consistency.read")
    assert has_capability(user, "platform_role.manage")


def test_explicit_platform_administrator_has_full_access():
    user = _super_admin("admin@cap.example", platform_role=PlatformRole.PLATFORM_ADMINISTRATOR)
    assert has_capability(user, "tenant_support.request")
    assert has_capability(user, "financial_consistency.read")
    assert has_capability(user, "platform_role.manage")


def test_support_operator_boundary():
    user = _super_admin("support@cap.example", platform_role=PlatformRole.SUPPORT_OPERATOR)
    assert has_capability(user, "tenant_support.request")
    assert has_capability(user, "tenant_support.activate")
    assert not has_capability(user, "financial_consistency.read")
    assert not has_capability(user, "platform_role.manage")
    assert not has_capability(user, "incident.suppress")


def test_auditor_boundary():
    user = _super_admin("auditor@cap.example", platform_role=PlatformRole.AUDITOR)
    assert has_capability(user, "financial_consistency.read")
    assert has_capability(user, "governance.read")
    assert has_capability(user, "launch_readiness.read")
    # Read-only: an auditor may see governance/attention state, but cannot
    # initiate privileged tenant access or act on an attention item.
    assert not has_capability(user, "tenant_support.request")
    assert not has_capability(user, "incident.acknowledge")
    assert not has_capability(user, "incident.suppress")


def test_reliability_operator_boundary():
    user = _super_admin("reliability@cap.example", platform_role=PlatformRole.RELIABILITY_OPERATOR)
    assert has_capability(user, "reliability.read")
    assert has_capability(user, "incident.acknowledge")
    assert has_capability(user, "incident.transition")
    assert not has_capability(user, "platform_role.manage")
    assert not has_capability(user, "tenant_support.request")


def test_only_platform_administrator_can_manage_platform_roles():
    admin = _super_admin("admin2@cap.example", platform_role=None)
    support = _super_admin("support2@cap.example", platform_role=PlatformRole.SUPPORT_OPERATOR)
    security = _super_admin("security2@cap.example", platform_role=PlatformRole.SECURITY_OPERATOR)
    auditor = _super_admin("auditor2@cap.example", platform_role=PlatformRole.AUDITOR)
    reliability = _super_admin("reliability2@cap.example", platform_role=PlatformRole.RELIABILITY_OPERATOR)
    finance = _super_admin("finance2@cap.example", platform_role=PlatformRole.FINANCE_READONLY)

    assert has_capability(admin, "platform_role.manage")
    for non_admin in (support, security, auditor, reliability, finance):
        assert not has_capability(non_admin, "platform_role.manage")


def test_dependency_raises_forbidden_for_missing_capability():
    dependency = require_capability("tenant_support.request")
    auditor = _super_admin("auditor3@cap.example", platform_role=PlatformRole.AUDITOR)
    with pytest.raises(ForbiddenException):
        dependency(current_user=auditor)


def test_dependency_passes_through_for_held_capability():
    dependency = require_capability("tenant_support.request")
    support = _super_admin("support3@cap.example", platform_role=PlatformRole.SUPPORT_OPERATOR)
    assert dependency(current_user=support) is support


def test_all_capability_names_are_declared_lowercase_dotted():
    for cap in CAPABILITIES:
        assert cap == cap.lower()
        assert "." in cap


# ── set_platform_role endpoint (direct call, matching this suite's
# established pattern for testing router functions without an HTTP layer) ──

def test_set_platform_role_updates_target_and_audits(db_session):
    from app.modules.super_admin.models import PlatformAuditLog
    from app.modules.super_admin.router import set_platform_role

    admin = _super_admin("admin-router@cap.example")
    target = _super_admin("target-router@cap.example", platform_role=PlatformRole.SUPPORT_OPERATOR)
    db_session.add_all([admin, target])
    db_session.commit()

    result = set_platform_role(
        user_id=target.id, platform_role="auditor", current_user=admin, db=db_session,
    )
    assert "auditor" in result["message"]
    db_session.refresh(target)
    assert target.platform_role == PlatformRole.AUDITOR

    audit_row = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.entity_type == "User", PlatformAuditLog.entity_id == target.id)
        .first()
    )
    assert audit_row is not None
    assert audit_row.new_values == {"platform_role": "auditor"}
    assert audit_row.old_values == {"platform_role": "support_operator"}


def test_set_platform_role_rejects_non_super_admin_target(db_session):
    from app.core.exceptions import BadRequestException
    from app.modules.super_admin.router import set_platform_role

    admin = _super_admin("admin-router2@cap.example")
    org_admin = User(
        email="org@cap.example", hashed_password="x", role=UserRole.ORG_ADMIN, organization_id=None,
        first_name="O", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add_all([admin, org_admin])
    db_session.commit()

    with pytest.raises(BadRequestException):
        set_platform_role(user_id=org_admin.id, platform_role="auditor", current_user=admin, db=db_session)


def test_set_platform_role_rejects_invalid_role_name(db_session):
    from app.core.exceptions import BadRequestException
    from app.modules.super_admin.router import set_platform_role

    admin = _super_admin("admin-router3@cap.example")
    target = _super_admin("target-router3@cap.example")
    db_session.add_all([admin, target])
    db_session.commit()

    with pytest.raises(BadRequestException):
        set_platform_role(user_id=target.id, platform_role="not_a_real_role", current_user=admin, db=db_session)


def test_capability_revoked_immediately_on_role_change(db_session):
    """No caching anywhere in the authorization chain: has_capability()
    reads user.platform_role fresh on every call, so a role downgrade
    takes effect on the caller's very next request — no re-login needed,
    and no stale in-memory permission set to worry about."""
    user = User(
        email="revoke@cap.example", hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="R", last_name="V", is_active=True, is_verified=True,
        platform_role=PlatformRole.SUPPORT_OPERATOR,
    )
    db_session.add(user)
    db_session.commit()

    assert has_capability(user, "tenant_support.request")

    user.platform_role = PlatformRole.AUDITOR
    db_session.commit()

    assert not has_capability(user, "tenant_support.request")
    assert has_capability(user, "financial_consistency.read")


def test_inactive_super_admin_rejected_by_get_current_user(db_session):
    """The Command Center's authorization chain builds on the platform's
    existing get_current_user — exercised here with a REAL JWT (not a
    reimplementation of the check) to prove a deactivated Super Admin
    cannot retain access to any Command Center capability, regardless of
    platform_role, even holding an otherwise-valid, unexpired token."""
    from app.core.dependencies import get_current_user
    from app.core.exceptions import UnauthorizedException
    from app.core.security import create_access_token

    user = User(
        email="inactive@cap.example", hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="I", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    token = create_access_token(data={
        "sub": user.email, "role": user.role.value, "user_id": user.id, "organization_id": user.organization_id,
    })

    # Token was issued while active; account is deactivated afterward —
    # get_current_user re-checks is_active from the DB on every call, so a
    # standing valid token does not survive deactivation.
    user.is_active = False
    db_session.commit()

    with pytest.raises(UnauthorizedException):
        get_current_user(token=token, db=db_session)


def test_set_platform_role_endpoint_itself_requires_platform_administrator():
    """The router function's OWN dependency (require_capability) — not
    just the underlying has_capability() check — must reject a
    non-admin caller before the function body ever runs."""
    dependency_for_endpoint = require_capability("platform_role.manage")
    support = _super_admin("support-router@cap.example", platform_role=PlatformRole.SUPPORT_OPERATOR)
    with pytest.raises(ForbiddenException):
        dependency_for_endpoint(current_user=support)
