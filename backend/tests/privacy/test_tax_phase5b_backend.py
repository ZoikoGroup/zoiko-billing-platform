"""ZB-TAX-ARCH-001 Phase 5b PR 1 (G-5a-1, G-5a-3): read-only reference
pickers and tax-staff names for the Tax Control Center.

- /authorities, /tax-types, /components: tax roles only, paged (B3).
- /people: only platform users holding a tax role, name and role only. No
  email, no other platform users, no tenant users.
"""
import pytest

from app.modules.auth.models import PlatformRole, User, UserRole
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase1_registry import people, registry  # noqa: F401 (fixtures)

BASE = "/api/v1/super-admin/tax-registry"


def test_reference_pickers_list_registry_rows(db_session, client_for, registry, people):  # noqa: F811
    client = client_for(people["maker"])
    authorities = client.get(f"{BASE}/authorities").json()
    assert [a["code"] for a in authorities["items"]] == ["GB-HMRC"] and authorities["next_cursor"] is None
    assert authorities["items"][0]["jurisdiction_code"] == "GB"
    types = client.get(f"{BASE}/tax-types").json()
    assert {t["code"] for t in types["items"]} >= {"VAT"}
    components = client.get(f"{BASE}/components").json()
    by_code = {c["code"]: c for c in components["items"]}
    assert by_code["GB-VAT"]["jurisdiction_code"] == "GB" and by_code["GB-VAT"]["tax_type"] == "VAT"
    assert by_code["GB-LEVY"]["is_cumulative"] is True
    gb_id = by_code["GB-VAT"]["jurisdiction_id"]
    filtered = client.get(f"{BASE}/components", params={"jurisdiction_id": gb_id}).json()["items"]
    assert filtered and all(c["jurisdiction_id"] == gb_id for c in filtered)


def test_reference_pickers_page(db_session, client_for, registry, people):  # noqa: F811
    client = client_for(people["checker"])
    first = client.get(f"{BASE}/components", params={"limit": 1}).json()
    assert len(first["items"]) == 1 and first["next_cursor"]
    rest = client.get(f"{BASE}/components", params={"cursor": first["next_cursor"]}).json()["items"]
    assert first["items"][0]["id"] not in {c["id"] for c in rest}


def test_people_lists_only_tax_staff_with_name_and_role(db_session, client_for, registry, people):  # noqa: F811
    support = make_super_admin(db_session, "support@p5b.example", PlatformRole.SUPPORT_OPERATOR)
    admin = make_super_admin(db_session, "admin@p5b.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    org = make_organization(db_session, code="P5BT")
    tenant = User(email="tenant@p5b.example", hashed_password="x", role=UserRole.ORG_ADMIN, organization_id=org.id,
                  first_name="Tess", last_name="Tenant", platform_role=PlatformRole.TAX_REVIEWER)
    db_session.add(tenant)
    db_session.commit()

    body = client_for(people["maker"]).get(f"{BASE}/people").json()
    ids = {p["id"] for p in body["items"]}
    assert ids == {people["maker"].id, people["maker2"].id, people["checker"].id}
    assert support.id not in ids and admin.id not in ids and tenant.id not in ids
    maker = next(p for p in body["items"] if p["id"] == people["maker"].id)
    assert maker == {"id": people["maker"].id, "name": "Mara Maker", "platform_role": "TAX_REVIEWER", "active": True}
    assert "@" not in str(body)                                              # no email addresses


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.SUPPORT_OPERATOR,
                                  PlatformRole.AUDITOR])
def test_pickers_and_people_are_for_tax_roles_only(db_session, client_for, registry, role):  # noqa: F811
    staff = client_for(make_super_admin(db_session, f"{role.value}@p5b.example", role))
    for path in ("authorities", "tax-types", "components", "people"):
        assert staff.get(f"{BASE}/{path}").status_code == 403, path


def test_tenant_users_cannot_reach_pickers_or_people(db_session, client_for, registry):  # noqa: F811
    org = make_organization(db_session, code="P5BX")
    user = User(email="t@p5bx.example", hashed_password="x", role=UserRole.ORG_ADMIN, organization_id=org.id,
                first_name="T", last_name="X")
    db_session.add(user)
    db_session.commit()
    client = client_for(user)
    for path in ("authorities", "tax-types", "components", "people"):
        assert client.get(f"{BASE}/{path}").status_code == 403, path
