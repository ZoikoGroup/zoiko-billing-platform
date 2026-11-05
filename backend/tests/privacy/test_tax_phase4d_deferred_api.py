"""ZB-TAX-ARCH-001 Phase 4d over HTTP: manual address resolution (two
people, evidence, T13) and the pseudonym remap export (CSV, no key material)."""
import hashlib

import pytest

from app.config import settings
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.tax.address_resolver import ADDRESS_RESOLVERS
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase4c_us import COUNTY, D2, STATE, build_us, buyer

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
CODES = ["US", STATE, COUNTY, D2]


@pytest.fixture()
def world(db_session):
    w = build_us(db_session, code="P4DAPI")
    yield w
    ADDRESS_RESOLVERS.clear()


def _propose(client, c, a, **body):
    return client.post(f"/api/v1/tax/customers/{c.id}/tax-addresses/{a.id}/manual-resolutions",
                       json={"jurisdiction_codes": CODES, "reason": "county lookup", **body})


def test_manual_resolution_end_to_end_over_http(db_session, client_for, world):
    c, a = buyer(world, "5 Split Rd")
    maker = client_for(world["maker"])
    created = _propose(maker, c, a)
    assert created.status_code == 201, created.text
    rid = created.json()["id"]
    assert created.json()["status"] == "PROPOSED" and created.json()["evidence_attached"] is False
    upload = maker.post(f"/api/v1/tax/manual-resolutions/{rid}/evidence",
                        files={"file": ("lookup.pdf", PDF, "application/pdf")},
                        data={"sha256": hashlib.sha256(PDF).hexdigest()})
    assert upload.status_code == 200 and upload.json()["evidence_attached"] is True
    assert maker.post(f"/api/v1/tax/manual-resolutions/{rid}/approve", json={}).status_code == 403
    approved = client_for(world["checker"]).post(f"/api/v1/tax/manual-resolutions/{rid}/approve", json={})
    assert approved.status_code == 200 and approved.json()["status"] == "APPROVED"
    maker = client_for(world["maker"])
    evidence = maker.get(f"/api/v1/tax/customers/{c.id}/tax-evidence").json()
    assert evidence["addresses"][0]["resolution"]["precision"] == "MANUAL"
    download = maker.get(f"/api/v1/tax/manual-resolutions/{rid}/evidence")
    assert download.status_code == 200 and download.content == PDF
    page = maker.get("/api/v1/tax/manual-resolutions", params={"address_id": a.id, "limit": 1}).json()
    assert [i["id"] for i in page["items"]] == [rid]


def test_manual_resolution_request_is_strict(db_session, client_for, world):
    c, a = buyer(world, "5 Split Rd")
    maker = client_for(world["maker"])
    assert _propose(maker, c, a, reason="").status_code == 422
    assert _propose(maker, c, a, precision="ROOFTOP").status_code == 422          # no extra fields
    assert maker.post(f"/api/v1/tax/customers/{c.id}/tax-addresses/{a.id}/manual-resolutions",
                      json={"jurisdiction_codes": [], "reason": "x"}).status_code == 422


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.TAX_PUBLISHER,
                                  PlatformRole.SUPPORT_OPERATOR])
def test_platform_roles_cannot_reach_manual_resolutions_or_the_remap(db_session, client_for, world, role):
    c, a = buyer(world, "5 Split Rd")
    rid = _propose(client_for(world["maker"]), c, a).json()["id"]
    staff = client_for(make_super_admin(db_session, f"{role.value}@p4dapi.example", role))
    assert staff.get("/api/v1/tax/manual-resolutions").status_code == 403
    assert staff.get(f"/api/v1/tax/manual-resolutions/{rid}/evidence").status_code == 403
    assert staff.post(f"/api/v1/tax/manual-resolutions/{rid}/approve", json={}).status_code == 403
    assert staff.post("/api/v1/tax/pseudonym-key/remap-export").status_code == 403


def test_other_tenants_cannot_see_a_manual_resolution(db_session, client_for, world):
    from tests.conftest import make_organization
    from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

    c, a = buyer(world, "5 Split Rd")
    rid = _propose(client_for(world["maker"]), c, a).json()["id"]
    other = make_organization(db_session, code="P4DAPX", name="Other")
    client = client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "admin@p4dapx.example"))
    assert client.get(f"/api/v1/tax/manual-resolutions/{rid}/evidence").status_code == 404
    assert client.get("/api/v1/tax/manual-resolutions").json()["items"] == []


def test_remap_export_is_a_csv_of_pseudonyms_only(db_session, client_for, world, monkeypatch):
    from app.modules.billing.models import InvoiceStatus
    from app.modules.billing.services.invoice_service import InvoiceService
    from app.modules.tax.issuance_gate import GovernedIssuanceGate
    from tests.test_tax_phase4c_us import quote_for

    c, _ = buyer(world, "100 First St")
    inv, _ = quote_for(world, c)
    service = InvoiceService(db_session)
    service.governed_gate = GovernedIssuanceGate(db_session)
    assert service.finalize_invoice(inv.id, world["org"].id, world["maker"].id).status == InvoiceStatus.SENT
    outgoing = settings.TAX_PROVIDER_PSEUDONYM_KEY
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "rotated-key-for-http")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS", outgoing)
    maker = client_for(world["maker"])
    status = maker.get("/api/v1/tax/pseudonym-key").json()
    assert status["remap_export_available"] is True and outgoing not in str(status)
    response = maker.post("/api/v1/tax/pseudonym-key/remap-export")
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
    assert response.headers["cache-control"] == "no-store"
    lines = response.text.strip().splitlines()
    assert lines[0] == "old_customer_ref,new_customer_ref" and len(lines) == 2
    assert outgoing not in response.text and "rotated-key-for-http" not in response.text
    assert c.email not in response.text
    assert client_for(world["checker"]).post("/api/v1/tax/pseudonym-key/remap-export").status_code == 403
