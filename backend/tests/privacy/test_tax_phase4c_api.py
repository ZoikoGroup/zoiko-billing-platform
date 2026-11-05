"""ZB-TAX-ARCH-001 Phase 4c over HTTP: resolving a buyer's US tax address,
the resolution in the buyer's tax evidence, and who can reach it (T13)."""
import pytest

from app.modules.auth.models import PlatformRole, UserRole
from app.modules.tax.address_resolver import ADDRESS_RESOLVERS
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase4c_us import buyer, build_us


@pytest.fixture()
def world(db_session):
    w = build_us(db_session, code="P4CAPI")
    yield w
    ADDRESS_RESOLVERS.clear()


def _url(c, a):
    return f"/api/v1/tax/customers/{c.id}/tax-addresses/{a.id}/resolve"


def test_resolve_records_and_shows_the_resolution(db_session, client_for, world):
    c, a = buyer(world, "100 First St", resolve=False)
    client = client_for(world["maker"])
    response = client.post(_url(c, a))
    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["status"], body["precision"], body["resolver"]) == ("RESOLVED", "ROOFTOP", "fake-resolver")
    assert body["jurisdiction_codes"][-1] == "US-CA-LA-D1"
    evidence = client.get(f"/api/v1/tax/customers/{c.id}/tax-evidence").json()
    assert evidence["addresses"][0]["resolution"]["id"] == body["id"]


def test_resolve_refuses_a_zip_only_address_and_a_mismatched_customer(db_session, client_for, world):
    c, a = buyer(world, None, resolve=False)
    other, _ = buyer(world, "100 First St", resolve=False)
    client = client_for(world["maker"])
    assert client.post(_url(c, a)).status_code == 400
    assert client.post(_url(other, a)).status_code == 404


def test_resolve_needs_a_billing_admin(db_session, client_for, world):
    c, a = buyer(world, "100 First St", resolve=False)
    assert client_for(world["checker"]).post(_url(c, a)).status_code == 403


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.TAX_PUBLISHER,
                                  PlatformRole.SUPPORT_OPERATOR])
def test_platform_roles_cannot_resolve_tenant_addresses(db_session, client_for, world, role):
    c, a = buyer(world, "100 First St", resolve=False)
    staff = client_for(make_super_admin(db_session, f"{role.value}@p4c.example", role))
    assert staff.post(_url(c, a)).status_code == 403
    assert world["resolver"].calls == []


def test_other_tenants_cannot_resolve_an_address(db_session, client_for, world):
    from tests.conftest import make_organization
    from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

    c, a = buyer(world, "100 First St", resolve=False)
    other = make_organization(db_session, code="P4CX", name="Other")
    client = client_for(_tenant_user(db_session, other, UserRole.BILLING_ADMIN, "admin@p4cx.example"))
    assert client.post(_url(c, a)).status_code == 404
    assert world["resolver"].calls == []


# ── pseudonym key over HTTP ─────────────────────────────────────────────

def test_pseudonym_key_status_and_two_person_acknowledgement_over_http(db_session, client_for, world, monkeypatch):
    from app.config import settings

    maker = client_for(world["maker"])
    status = maker.get("/api/v1/tax/pseudonym-key").json()
    assert status["key_set"] is True and status["blocked_reason"] is None
    assert settings.TAX_PROVIDER_PSEUDONYM_KEY not in str(status)
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "rotated-over-http")
    assert maker.get("/api/v1/tax/pseudonym-key").json()["blocked_reason"] == "pseudonym key changed — remap required"
    assert maker.post("/api/v1/tax/pseudonym-key/acknowledgements", json={}).status_code == 422   # reason required
    ack = maker.post("/api/v1/tax/pseudonym-key/acknowledgements", json={"reason": "remapped"})
    assert ack.status_code == 201 and ack.json()["status"] == "PROPOSED"
    url = f"/api/v1/tax/pseudonym-key/acknowledgements/{ack.json()['id']}/approve"
    assert maker.post(url, json={}).status_code == 403                     # not a finance approver
    approved = client_for(world["checker"]).post(url, json={})
    assert approved.status_code == 200 and approved.json()["status"] == "APPROVED"
    maker = client_for(world["maker"])
    assert maker.get("/api/v1/tax/pseudonym-key").json()["blocked_reason"] is None
    page = maker.get("/api/v1/tax/pseudonym-key/acknowledgements?limit=1").json()
    assert len(page["items"]) == 1 and page["next_cursor"]
    assert "rotated-over-http" not in str(page)


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.TAX_PUBLISHER,
                                  PlatformRole.SUPPORT_OPERATOR])
def test_platform_roles_cannot_reach_pseudonym_key_records(db_session, client_for, world, role):
    staff = client_for(make_super_admin(db_session, f"{role.value}@p4ck.example", role))
    for url in ("/api/v1/tax/pseudonym-key", "/api/v1/tax/pseudonym-key/acknowledgements"):
        assert staff.get(url).status_code == 403, (role, url)
    assert staff.post("/api/v1/tax/pseudonym-key/acknowledgements", json={"reason": "x"}).status_code == 403
