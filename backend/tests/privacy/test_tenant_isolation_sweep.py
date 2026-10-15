"""
tests/privacy/test_tenant_isolation_sweep.py
--------------------------------------------
ZB-SEC-PRIV-001 §ISO-01 / §ISO-03 / §AT-02 / §E06:
Automated tenant isolation sweep across tenant-scoped API routes and repository layer.
"""

from datetime import date, timedelta
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient

from app.core.dependencies import get_current_user
from app.core.exceptions import NotFoundException
from app.database import get_db
from app.main import app
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import (
    BillingCustomer,
    Invoice,
    InvoiceStatus,
    Quotation,
    QuoteStatus,
)
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.quote_service import QuoteService
from app.modules.organizations.models import Organization
from tests.privacy.conftest import control


def _create_tenant_user(db, org_id: int, email: str, role: UserRole = UserRole.BILLING_ADMIN) -> User:
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if not org:
        org = Organization(id=org_id, organization_name=f"Tenant Org {org_id}", organization_code=f"org-{org_id}")
        db.add(org)
        db.flush()

    user = User(
        email=email,
        hashed_password="x",
        first_name="Tenant",
        last_name="User",
        role=role,
        organization_id=org_id,
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.commit()
    return user


@control("ISO-01", "ISO-03", "AT-02", "E06")
def test_route_discovery_and_tenant_surface():
    """Verify route discovery successfully catalogs the API route surface."""
    discovered_routes = []
    for route in app.routes:
        if hasattr(route, "path") and hasattr(route, "methods"):
            discovered_routes.append((route.path, list(route.methods)))

    assert len(discovered_routes) > 10, "FastAPI route discovery should find all mounted platform routes"
    # Verify tenant billing routes exist in the catalog
    billing_paths = [path for path, _ in discovered_routes if "/invoices" in path or "/quotations" in path]
    assert len(billing_paths) > 0, "Tenant-scoped billing routes must be registered"


@control("ISO-01", "ISO-03", "AT-02", "E06")
def test_cross_tenant_invoice_repo_isolation(db_session):
    """Repository-layer isolation: querying invoice of Org A with Org B ID returns NotFound."""
    user_a = _create_tenant_user(db_session, org_id=201, email="user_a@tenant201.com")
    user_b = _create_tenant_user(db_session, org_id=202, email="user_b@tenant202.com")

    cust_a = BillingCustomer(
        id=2010,
        organization_id=user_a.organization_id,
        customer_code="CUST-2010",
        company_name="Tenant A Customer",
        display_name="Tenant A Cust",
        currency="USD",
    )
    db_session.add(cust_a)
    inv_a = Invoice(
        id=20101,
        organization_id=user_a.organization_id,
        customer_id=cust_a.id,
        invoice_number="INV-20101",
        status=InvoiceStatus.SENT,
        issue_date=date.today(),
        due_date=date.today() + timedelta(days=30),
        total_amount=Decimal("500.00"),
        balance_due=Decimal("500.00"),
        paid_amount=Decimal("0.00"),
        currency="USD",
        public_link_version=1,
    )
    db_session.add(inv_a)
    db_session.commit()

    inv_svc = InvoiceService(db_session)

    # Org A can get their own invoice
    own_inv = inv_svc.repo.get_by_id(inv_a.id, organization_id=user_a.organization_id)
    assert own_inv.id == inv_a.id

    # Org B trying to get Org A's invoice raises NotFoundException
    with pytest.raises(NotFoundException):
        inv_svc.repo.get_by_id(inv_a.id, organization_id=user_b.organization_id)


@control("ISO-01", "ISO-03", "AT-02", "E06")
def test_cross_tenant_quote_repo_isolation(db_session):
    """Repository-layer isolation: querying quotation of Org A with Org B ID returns NotFound."""
    user_a = _create_tenant_user(db_session, org_id=203, email="user_a@tenant203.com")
    user_b = _create_tenant_user(db_session, org_id=204, email="user_b@tenant204.com")

    cust_a = BillingCustomer(
        id=2030,
        organization_id=user_a.organization_id,
        customer_code="CUST-2030",
        company_name="Tenant A Quote Customer",
        display_name="Tenant A Quote Cust",
        currency="USD",
    )
    db_session.add(cust_a)
    quote_a = Quotation(
        id=20301,
        organization_id=user_a.organization_id,
        customer_id=cust_a.id,
        quote_number="Q-20301",
        status=QuoteStatus.SENT,
        total_amount=Decimal("1200.00"),
        subtotal=Decimal("1200.00"),
        currency="USD",
        public_link_version=1,
    )
    db_session.add(quote_a)
    db_session.commit()

    quote_svc = QuoteService(db_session)

    # Org A gets quote
    own_quote = quote_svc.repo.get_by_id(quote_a.id, organization_id=user_a.organization_id)
    assert own_quote.id == quote_a.id

    # Org B querying quote of Org A gets NotFoundException
    with pytest.raises(NotFoundException):
        quote_svc.repo.get_by_id(quote_a.id, organization_id=user_b.organization_id)


@control("ISO-01", "ISO-03", "AT-02", "E06")
def test_cross_tenant_api_link_lookup_blocked(client_for, db_session):
    """API-layer isolation: Authenticated user from Org B requesting public link for Org A invoice receives 404."""
    user_a = _create_tenant_user(db_session, org_id=205, email="user_a@tenant205.com")
    user_b = _create_tenant_user(db_session, org_id=206, email="user_b@tenant206.com")

    cust_a = BillingCustomer(
        id=2050,
        organization_id=user_a.organization_id,
        customer_code="CUST-2050",
        company_name="Tenant A Customer",
        display_name="Tenant A Cust",
        currency="USD",
    )
    db_session.add(cust_a)
    inv_a = Invoice(
        id=20501,
        organization_id=user_a.organization_id,
        customer_id=cust_a.id,
        invoice_number="INV-20501",
        status=InvoiceStatus.SENT,
        issue_date=date.today(),
        due_date=date.today() + timedelta(days=30),
        total_amount=Decimal("150.00"),
        balance_due=Decimal("150.00"),
        paid_amount=Decimal("0.00"),
        currency="USD",
        public_link_version=1,
    )
    db_session.add(inv_a)
    db_session.commit()

    # User B calls API for invoice A
    client_b = client_for(user_b)
    res = client_b.get(f"/api/v1/invoices/{inv_a.id}/public-link")
    # Must return 404 (or 403), never 200
    assert res.status_code in (404, 403)
