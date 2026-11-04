"""ZB-TAX-ARCH-001 Phase 2 — T13 and tenant scoping of the new tax routes.

Platform staff without a JIT grant cannot read tenant tax IDs, registrations,
activations, review items or the tax context — whatever their platform role,
including the tax registry roles. Support reaches tenant data only through
the temporary AUDITOR account an approved grant issues, and that account
stops working at its expiry.
"""
from datetime import date, datetime, timedelta

import pytest

from app.core.dependencies import get_organization_id
from app.core.security import create_access_token
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_customer, make_invoice, make_organization
from tests.privacy.conftest import make_super_admin

SECRET_TAX_ID = "GB-SECRET-777"


@pytest.fixture()
def tenant(db_session):
    db = db_session
    org = make_organization(db, code="T13ORG", name="T13 Org")
    entity = LegalEntityService(db).ensure_default_entity(org.id)
    admin = User(email="admin@t13.example", hashed_password="x", role=UserRole.BILLING_ADMIN, organization_id=org.id,
                 first_name="A", last_name="Dmin", is_active=True, is_verified=True)
    gb = TaxJurisdiction(code="GB", name="United Kingdom", level="country", country_code="GB", timezone="Europe/London")
    vat = TaxTypeDefinition(code="VAT", name="VAT")
    db.add_all([admin, gb, vat])
    db.flush()
    customer = make_customer(db, org.id)
    BuyerEvidenceService(db).add_tax_id(org.id, admin.id, customer.id, value=SECRET_TAX_ID)
    TenantTaxService(db).create_registration(org.id, admin.id, seller_entity_id=entity.id, jurisdiction_id=gb.id,
                                             tax_type_id=vat.id, registration_number="REG-SECRET-1",
                                             valid_from=date(2020, 1, 1))
    invoice = make_invoice(db, org.id, customer.id, invoice_number="INV-T13")
    db.commit()
    return {"org": org, "admin": admin, "customer": customer, "invoice": invoice}


def _urls(t):
    return [
        f"/api/v1/tax/customers/{t['customer'].id}/tax-evidence",
        "/api/v1/tax/registrations",
        "/api/v1/tax/activations",
        "/api/v1/tax/legal-bases",
        "/api/v1/tax/product-classifications",
        "/api/v1/tax/review-items",
        f"/api/v1/tax/context/invoice/{t['invoice'].id}",
    ]


def test_tenant_user_reads_own_tax_evidence(db_session, client_for, tenant):
    client = client_for(tenant["admin"])
    for url in _urls(tenant):
        assert client.get(url).status_code == 200, url
    assert SECRET_TAX_ID in client.get(_urls(tenant)[0]).text


@pytest.mark.parametrize("role", list(PlatformRole))
def test_t13_platform_staff_without_a_grant_are_refused(db_session, client_for, tenant, role):
    staff = make_super_admin(db_session, f"{role.value}@t13.example", role)
    client = client_for(staff)
    for url in _urls(tenant):
        response = client.get(url)
        assert response.status_code == 403, (role, url, response.status_code)
        assert SECRET_TAX_ID not in response.text and "REG-SECRET-1" not in response.text


def _support_account(db, org, expires_at):
    user = User(email=f"support-{expires_at:%H%M%S%f}@support-access.example", hashed_password="x",
                role=UserRole.AUDITOR, organization_id=org.id, first_name="Support", last_name="Access",
                is_active=True, is_verified=True, access_expires_at=expires_at)
    db.add(user)
    db.commit()
    token = create_access_token({"sub": user.email, "role": "auditor", "user_id": user.id,
                                 "organization_id": org.id})
    return {"Authorization": f"Bearer {token}"}


def _real_auth_client(db_session):
    from fastapi.testclient import TestClient

    from app.core.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app, raise_server_exceptions=False)


def test_t13_support_access_works_only_while_the_grant_account_is_live(db_session, tenant):
    from app.database import get_db
    from app.main import app

    client = _real_auth_client(db_session)
    try:
        live = _support_account(db_session, tenant["org"], datetime.utcnow() + timedelta(minutes=20))
        assert client.get(_urls(tenant)[0], headers=live).status_code == 200

        expired = _support_account(db_session, tenant["org"], datetime.utcnow() - timedelta(seconds=1))
        for url in _urls(tenant):
            response = client.get(url, headers=expired)
            assert response.status_code == 401, (url, response.status_code)
            assert SECRET_TAX_ID not in response.text
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_every_phase2_tenant_route_resolves_the_tenant_scope():
    from app.modules.tax.router import router

    def depends_on(dependant, target):
        return any(d.call is target or depends_on(d, target) for d in dependant.dependencies)

    routes = [r for r in router.routes if hasattr(r, "dependant")]
    assert len(routes) > 30
    for route in routes:
        assert depends_on(route.dependant, get_organization_id), route.path
