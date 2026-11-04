"""ZB-TAX-ARCH-001 Phase 3a — findings reports and quotes: who sees what (T13).

Tenant reports: that organization's org admins and finance approvers only,
with invoice-level detail. Platform reports: the tax roles only, aggregate
counts and totals, no organization names/ids, customer data or invoice
numbers. Platform staff cannot reach the tenant routes at all.
"""
from decimal import Decimal

import pytest

from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import InvoiceStatus, Tax
from tests.conftest import make_customer, make_invoice, make_organization
from tests.privacy.conftest import make_super_admin

TENANT_OVERCOLLECTION = "/api/v1/tax/reports/legacy-discount-overcollection"
TENANT_DUPLICATES = "/api/v1/tax/reports/duplicate-tax-rows"
PLATFORM_OVERCOLLECTION = "/api/v1/super-admin/tax-registry/reports/legacy-discount-overcollection"
PLATFORM_DUPLICATES = "/api/v1/super-admin/tax-registry/reports/duplicate-tax-rows"
SECRET_ORG = "Secret Tenant Holdings"
SECRET_NUMBER = "INV-SECRET-0001"
SECRET_CUSTOMER_EMAIL = "secret-buyer@leak.example"


def _tenant_user(db, org, role, email):
    u = User(email=email, hashed_password="x", role=role, organization_id=org.id, first_name="T", last_name="U",
             is_active=True, is_verified=True)
    db.add(u)
    db.commit()
    return u


@pytest.fixture()
def tenant(db_session):
    db = db_session
    org = make_organization(db, code="P3AREP", name=SECRET_ORG)
    customer = make_customer(db, org.id, code="P3ACUST", email=SECRET_CUSTOMER_EMAIL)
    inv = make_invoice(db, org.id, customer.id, status=InvoiceStatus.SENT, invoice_number=SECRET_NUMBER)
    inv.discount_percentage = Decimal("10")
    inv.tax_amount = Decimal("20.00")
    inv.currency = "GBP"
    for _ in range(2):
        db.add(Tax(organization_id=org.id, invoice_id=inv.id, taxable_amount=Decimal("100"),
                   tax_amount=Decimal("20"), tax_percentage=Decimal("20"), is_active=True))
    db.commit()
    return {"org": org, "invoice": inv}


@pytest.mark.parametrize("role", [UserRole.ORG_ADMIN, UserRole.FINANCE_APPROVER])
def test_tenant_admins_and_finance_see_their_own_detail(db_session, client_for, tenant, role):
    user = _tenant_user(db_session, tenant["org"], role, f"{role.value}@p3a.example")
    client = client_for(user)
    over = client.get(TENANT_OVERCOLLECTION)
    assert over.status_code == 200, over.text
    assert over.json()["invoices"][0]["invoice_number"] == SECRET_NUMBER
    dup = client.get(TENANT_DUPLICATES)
    assert dup.status_code == 200 and dup.json()["duplicate_rows"] == 1


@pytest.mark.parametrize("role", [UserRole.BILLING_ADMIN, UserRole.AUDITOR])
def test_other_tenant_roles_are_refused(db_session, client_for, tenant, role):
    user = _tenant_user(db_session, tenant["org"], role, f"{role.value}-no@p3a.example")
    client = client_for(user)
    assert client.get(TENANT_OVERCOLLECTION).status_code == 403
    assert client.get(TENANT_DUPLICATES).status_code == 403


@pytest.mark.parametrize("role", list(PlatformRole))
def test_platform_staff_cannot_reach_tenant_reports_or_quotes(db_session, client_for, tenant, role):
    staff = make_super_admin(db_session, f"{role.value}@p3a-staff.example", role)
    client = client_for(staff)
    for url in (TENANT_OVERCOLLECTION, TENANT_DUPLICATES, "/api/v1/tax/quotes/1",
                f"/api/v1/tax/quotes?document_type=invoice&document_id={tenant['invoice'].id}"):
        response = client.get(url)
        assert response.status_code == 403, (role, url)
        assert SECRET_NUMBER not in response.text


@pytest.mark.parametrize("role", [PlatformRole.TAX_REVIEWER, PlatformRole.TAX_PUBLISHER])
def test_platform_reports_are_aggregate_only(db_session, client_for, tenant, role):
    staff = make_super_admin(db_session, f"{role.value}@p3a-agg.example", role)
    client = client_for(staff)
    over = client.get(PLATFORM_OVERCOLLECTION)
    dup = client.get(PLATFORM_DUPLICATES)
    assert over.status_code == 200 and dup.status_code == 200
    body = over.json()
    assert body["organizations_affected"] == 1 and body["invoice_count"] == 1
    assert set(body) == {"method", "organizations_affected", "invoice_count", "totals_by_currency"}
    assert set(dup.json()) == {"organizations_affected", "invoices_affected", "duplicate_rows", "note"}
    for text in (over.text, dup.text):
        for secret in (SECRET_ORG, SECRET_NUMBER, SECRET_CUSTOMER_EMAIL, "P3AREP", "invoice_id", "organization_id"):
            assert secret not in text, secret


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.AUDITOR,
                                  PlatformRole.SUPPORT_OPERATOR, PlatformRole.FINANCE_READONLY])
def test_platform_reports_are_restricted_to_tax_roles(db_session, client_for, tenant, role):
    staff = make_super_admin(db_session, f"{role.value}@p3a-deny.example", role)
    client = client_for(staff)
    assert client.get(PLATFORM_OVERCOLLECTION).status_code == 403
    assert client.get(PLATFORM_DUPLICATES).status_code == 403
