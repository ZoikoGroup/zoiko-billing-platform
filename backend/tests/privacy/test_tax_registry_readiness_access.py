"""ZB-TAX-ARCH-001 Phase 1: the tax registry readiness endpoint exposes only
per-role counts and is reachable only by the tax roles (TAX_REVIEWER /
TAX_PUBLISHER) — not other super admins, not tenant users."""
from app.modules.auth.models import PlatformRole, User, UserRole
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin

URL = "/api/v1/super-admin/tax-registry/readiness"
EXPECTED_KEYS = {
    "step_up_required", "active_reviewers", "active_publishers",
    "publishers_with_mfa", "reviewers_with_mfa", "ready",
}


def test_tax_roles_get_counts_only(db_session, client_for):
    reviewer = make_super_admin(db_session, "rev@tax.privacy.example", PlatformRole.TAX_REVIEWER)
    publisher = make_super_admin(db_session, "pub@tax.privacy.example", PlatformRole.TAX_PUBLISHER)
    for user in (reviewer, publisher):
        response = client_for(user).get(URL)
        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == EXPECTED_KEYS
        assert all(isinstance(v, (int, bool)) for v in body.values())
        assert "@" not in response.text            # no emails, names or user ids


def test_other_super_admins_and_tenants_are_refused(db_session, client_for):
    for role in (PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.AUDITOR, PlatformRole.SUPPORT_OPERATOR):
        admin = make_super_admin(db_session, f"{role.value}@tax.privacy.example", role)
        assert client_for(admin).get(URL).status_code == 403, role

    org = make_organization(db_session, code="TAXREADY")
    tenant_admin = User(email="owner@taxready.example", hashed_password="x", role=UserRole.ORG_ADMIN,
                        organization_id=org.id, first_name="T", last_name="A", is_active=True, is_verified=True)
    db_session.add(tenant_admin)
    db_session.commit()
    assert client_for(tenant_admin).get(URL).status_code == 403
