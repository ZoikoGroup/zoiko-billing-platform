"""ZB-TAX-ARCH-001 Phase 4a-2 over HTTP: who sees what (T13), no SSRF,
write-only credentials, certificate evidence, the B3 pagination contract on
every new list, and the regime-change routes."""
import hashlib

import pytest

from app.modules.auth.models import PlatformRole
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase3a_governed import build_world

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
SECRET = "http-credential-ABCD9999"


@pytest.fixture()
def world(db_session):
    return build_world(db_session, org_code="P4A2API")


def _cert(w):
    from datetime import date

    return BuyerEvidenceService(w["db"]).add_certificate(
        w["org"].id, w["maker"].id, w["customer"].id, certificate_number="EX-1", jurisdiction_id=w["gb"].id,
        scope_description="Charity", valid_from=date(2026, 1, 1), evidence_ref="file", reason_code="charity")


# ── no SSRF: tenants never supply an endpoint ───────────────────────────

@pytest.mark.parametrize("field", ["base_url", "endpoint", "url", "host"])
def test_a_tenant_supplied_url_is_refused(db_session, client_for, world, field):
    client = client_for(world["maker"])
    body = {"seller_entity_id": world["entity"].id, "provider_name": "fake-provider", "environment": "SANDBOX",
            "mode": "COMMIT", field: "http://169.254.169.254/latest/meta-data/"}
    response = client.post("/api/v1/tax/provider-connections", json=body)
    assert response.status_code == 422
    assert world["provider"].test_calls == []


def test_test_connection_reaches_only_the_allowlisted_host(db_session, client_for, world):
    from tests.fixtures.tax_fake_provider import FAKE_ENDPOINTS

    response = client_for(world["maker"]).post(f"/api/v1/tax/provider-connections/{world['connection'].id}/test")
    assert response.status_code == 200 and response.json()["health"]["ok"] is True
    assert world["provider"].test_calls == [FAKE_ENDPOINTS["SANDBOX"]]


# ── credentials: write-only, masked ─────────────────────────────────────

def test_credentials_are_write_only_over_http(db_session, client_for, world):
    client = client_for(world["maker"])
    url = f"/api/v1/tax/provider-connections/{world['connection'].id}"
    put = client.put(f"{url}/credentials", json={"secret": SECRET})
    assert put.status_code == 200, put.text
    assert put.json()["credentials"] == {"present": True, "last_rotated_at": put.json()["credentials"]["last_rotated_at"],
                                         "last4": "9999"}
    for response in (put, client.get(url), client.get("/api/v1/tax/provider-connections")):
        assert SECRET not in response.text and "ciphertext" not in response.text and "credential_ref" not in response.text


def test_revocation_over_http_freezes_the_connection(db_session, client_for, world):
    client = client_for(world["maker"])
    url = f"/api/v1/tax/provider-connections/{world['connection'].id}"
    assert client.post(f"{url}/credentials/revoke", json={}).status_code == 422          # a reason is required
    body = client.post(f"{url}/credentials/revoke", json={"reason": "leaked"}).json()
    assert body["status"] == "SUSPENDED" and body["credentials"]["present"] is False


def test_connection_approval_is_two_person_over_http(db_session, client_for, world):
    maker = client_for(world["maker"])
    created = maker.post("/api/v1/tax/provider-connections", json={
        "seller_entity_id": world["entity"].id, "provider_name": "fake-provider", "environment": "SANDBOX",
        "mode": "ESTIMATE_ONLY"}).json()
    assert created["status"] == "PROPOSED"
    assert maker.post(f"/api/v1/tax/provider-connections/{created['id']}/approve", json={}).status_code == 403
    approved = client_for(world["checker"]).post(f"/api/v1/tax/provider-connections/{created['id']}/approve", json={})
    assert approved.status_code == 200 and approved.json()["status"] == "APPROVED"


# ── T13: platform roles see none of it ──────────────────────────────────

@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.TAX_PUBLISHER,
                                  PlatformRole.SUPPORT_OPERATOR])
def test_platform_roles_cannot_reach_tenant_provider_data_or_evidence(db_session, client_for, world, role):
    cert = _cert(world)
    BuyerEvidenceService(db_session).attach_certificate_evidence(world["org"].id, world["maker"].id, cert.id,
                                                                 content=PDF, media_type="application/pdf")
    staff = client_for(make_super_admin(db_session, f"{role.value}@p4a2.example", role))
    for url in ("/api/v1/tax/provider-connections", f"/api/v1/tax/provider-connections/{world['connection'].id}",
                "/api/v1/tax/provider-transactions", "/api/v1/tax/exemption-certificates",
                f"/api/v1/tax/exemption-certificates/{cert.id}/evidence", "/api/v1/tax/regime-changes"):
        response = staff.get(url)
        assert response.status_code == 403, (role, url)
        assert PDF.decode(errors="ignore")[:8] not in response.text


def test_other_tenants_cannot_see_a_connection_or_evidence(db_session, client_for, world):
    from tests.conftest import make_organization
    from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
    from app.modules.auth.models import UserRole

    cert = _cert(world)
    BuyerEvidenceService(db_session).attach_certificate_evidence(world["org"].id, world["maker"].id, cert.id,
                                                                 content=PDF, media_type="application/pdf")
    other = make_organization(db_session, code="P4A2X", name="Other")
    client = client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "admin@p4a2x.example"))
    assert client.get(f"/api/v1/tax/provider-connections/{world['connection'].id}").status_code == 404
    assert client.get(f"/api/v1/tax/exemption-certificates/{cert.id}/evidence").status_code == 404


# ── certificate evidence over HTTP ──────────────────────────────────────

def test_certificate_evidence_upload_and_download(db_session, client_for, world):
    cert = _cert(world)
    client = client_for(world["maker"])
    url = f"/api/v1/tax/exemption-certificates/{cert.id}/evidence"
    bad = client.post(url, files={"file": ("x.txt", b"plain text", "text/plain")})
    assert bad.status_code == 400
    ok = client.post(url, files={"file": ("cert.pdf", PDF, "application/pdf")},
                     data={"sha256": hashlib.sha256(PDF).hexdigest()})
    assert ok.status_code == 200 and ok.json()["evidence_attached"] is True
    again = client.post(url, files={"file": ("cert.pdf", PDF, "application/pdf")})
    assert again.status_code == 400 and "write-once" in again.text
    download = client.get(url)
    assert download.status_code == 200 and download.content == PDF
    assert download.headers["x-content-sha256"] == hashlib.sha256(PDF).hexdigest()


# ── B3 on every new list ────────────────────────────────────────────────

@pytest.mark.parametrize("url", ["/api/v1/tax/provider-connections", "/api/v1/tax/provider-transactions",
                                 "/api/v1/tax/exemption-certificates", "/api/v1/tax/regime-changes",
                                 "/api/v1/tax/activations"])
def test_new_lists_follow_the_pagination_contract(db_session, client_for, world, url):
    client = client_for(world["maker"])
    body = client.get(url).json()
    assert set(body) == {"items", "next_cursor"}
    assert client.get(url, params={"limit": 201}).status_code == 422
    assert client.get(url, params={"cursor": "garbage"}).status_code == 400


def test_provider_connections_page(db_session, client_for, world):
    maker = client_for(world["maker"])
    for _ in range(2):
        maker.post("/api/v1/tax/provider-connections", json={
            "seller_entity_id": world["entity"].id, "provider_name": "fake-provider", "environment": "SANDBOX",
            "mode": "COMMIT"})
    everything = maker.get("/api/v1/tax/provider-connections").json()["items"]
    first = maker.get("/api/v1/tax/provider-connections", params={"limit": 2}).json()
    rest = maker.get("/api/v1/tax/provider-connections",
                     params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [c["id"] for c in first["items"] + rest["items"]] == [c["id"] for c in everything]
    assert rest["next_cursor"] is None


# ── regime changes over HTTP ────────────────────────────────────────────

def test_regime_change_routes_are_two_person(db_session, client_for, world):
    from app.modules.auth.models import UserRole
    from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

    admin = client_for(_tenant_user(db_session, world["org"], UserRole.ORG_ADMIN, "admin@p4a2api.example"))
    proposed = admin.post(f"/api/v1/tax/legal-entities/{world['entity'].id}/regime",
                          json={"tax_regime": "legacy_manual", "reason": "pilot ended"})
    assert proposed.status_code == 201 and proposed.json()["status"] == "PROPOSED"
    change_id = proposed.json()["id"]
    assert admin.post(f"/api/v1/tax/regime-changes/{change_id}/approve", json={}).status_code == 403
    decided = client_for(world["checker"]).post(f"/api/v1/tax/regime-changes/{change_id}/approve", json={})
    assert decided.status_code == 200 and decided.json()["status"] == "APPROVED"
    listed = admin.get("/api/v1/tax/regime-changes").json()
    assert [c["id"] for c in listed["items"]] == [change_id]
