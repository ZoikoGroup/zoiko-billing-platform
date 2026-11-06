"""ZB-TAX-ARCH-001 Phase 5b PR 2: the additive tenant reads and evidence
routes the Settings → Taxes screens need.

- Registration and legal-basis evidence: PDF/PNG/JPEG, size and hash checked,
  attached once (ORM guard), tenant-only, legal bases only while proposed.
- GET /api/v1/tax/people: the caller's own organization's users; name and
  role only, no email, no platform users, no other tenants.
- GET /api/v1/tax/tax-types: platform reference data for pickers.
"""
import hashlib
from datetime import date

import pytest

from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.tax.models import EntityTaxRegistration, TaxRecordFrozenError
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase3a_governed import build_world

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


@pytest.fixture()
def world(db_session):
    return build_world(db_session, org_code="P5B2")


def _registration(w):
    return w["db"].query(EntityTaxRegistration).filter(EntityTaxRegistration.organization_id == w["org"].id).first()


def _proposed_basis(w):
    return TenantTaxService(w["db"]).propose_legal_basis(
        w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id, jurisdiction_id=w["gb"].id,
        tax_type_id=w["vat"].id, legal_basis="Non-established taxable person, VATA 1994 Sch 1A",
        evidence_ref="cabinet 2", valid_from=date(2025, 1, 1))


def test_registration_evidence_upload_download_and_write_once(db_session, client_for, world):
    reg = _registration(world)
    client = client_for(world["maker"])
    url = f"/api/v1/tax/registrations/{reg.id}/evidence"
    assert client.post(url, files={"file": ("x.txt", b"plain", "text/plain")}).status_code == 400
    ok = client.post(url, files={"file": ("cert.pdf", PDF, "application/pdf")},
                     data={"sha256": hashlib.sha256(PDF).hexdigest()})
    assert ok.status_code == 200 and ok.json()["evidence_attached"] is True
    again = client.post(url, files={"file": ("cert.pdf", PDF, "application/pdf")})
    assert again.status_code == 400 and "write-once" in again.text
    download = client.get(url)
    assert download.status_code == 200 and download.content == PDF
    assert download.headers["x-content-sha256"] == hashlib.sha256(PDF).hexdigest()
    db_session.refresh(reg)
    reg.evidence_file_id = None
    with pytest.raises(TaxRecordFrozenError):
        db_session.flush()
    db_session.rollback()


def test_legal_basis_evidence_only_while_proposed(db_session, client_for, world):
    basis = _proposed_basis(world)
    url = f"/api/v1/tax/legal-bases/{basis.id}/evidence"
    ok = client_for(world["maker"]).post(url, files={"file": ("basis.pdf", PDF, "application/pdf")})
    assert ok.status_code == 200 and ok.json()["evidence_attached"] is True
    TenantTaxService(db_session).decide_legal_basis(world["org"].id, world["checker"].id, basis.id, approve=True)
    other = _proposed_basis(world)
    TenantTaxService(db_session).decide_legal_basis(world["org"].id, world["checker"].id, other.id, approve=False)
    late = client_for(world["maker"]).post(f"/api/v1/tax/legal-bases/{other.id}/evidence",
                                           files={"file": ("basis.pdf", PDF, "application/pdf")})
    assert late.status_code == 400 and "while proposed" in late.text


def test_evidence_size_limit(db_session, client_for, world, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "TAX_EVIDENCE_MAX_BYTES", 16)
    reg = _registration(world)
    response = client_for(world["maker"]).post(f"/api/v1/tax/registrations/{reg.id}/evidence",
                                               files={"file": ("cert.pdf", PDF, "application/pdf")})
    assert response.status_code == 400 and "exceeds" in response.text


def test_only_billing_admins_upload_and_other_tenants_see_nothing(db_session, client_for, world):
    from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

    reg = _registration(world)
    url = f"/api/v1/tax/registrations/{reg.id}/evidence"
    assert client_for(world["checker"]).post(url, files={"file": ("c.pdf", PDF, "application/pdf")}).status_code == 403
    client_for(world["maker"]).post(url, files={"file": ("c.pdf", PDF, "application/pdf")})
    other = make_organization(db_session, code="P5B2X", name="Other")
    stranger = client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "admin@p5b2x.example"))
    assert stranger.get(url).status_code == 404
    staff = client_for(make_super_admin(db_session, "pa@p5b2.example", PlatformRole.PLATFORM_ADMINISTRATOR))
    assert staff.get(url).status_code == 403


def test_people_lists_only_this_organizations_users(db_session, client_for, world):
    from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

    other = make_organization(db_session, code="P5B2Y", name="Other")
    outsider = _tenant_user(db_session, other, UserRole.ORG_ADMIN, "out@p5b2y.example")
    staff = make_super_admin(db_session, "tax@p5b2.example", PlatformRole.TAX_REVIEWER)
    body = client_for(world["maker"]).get("/api/v1/tax/people").json()
    ids = {p["id"] for p in body["items"]}
    assert world["maker"].id in ids and world["checker"].id in ids
    assert outsider.id not in ids and staff.id not in ids
    assert all(set(p) == {"id", "name", "role", "active"} for p in body["items"])
    assert "@" not in str(body)
    maker = next(p for p in body["items"] if p["id"] == world["maker"].id)
    assert maker["role"] == "BILLING_ADMIN"


def test_people_is_refused_to_platform_staff(db_session, client_for, world):
    staff = client_for(make_super_admin(db_session, "pa2@p5b2.example", PlatformRole.PLATFORM_ADMINISTRATOR))
    assert staff.get("/api/v1/tax/people").status_code == 403


def test_reference_tax_types_for_pickers(db_session, client_for, world):
    body = client_for(world["checker"]).get("/api/v1/tax/tax-types").json()
    assert any(t["code"] == "VAT" for t in body["items"]) and "next_cursor" in body
