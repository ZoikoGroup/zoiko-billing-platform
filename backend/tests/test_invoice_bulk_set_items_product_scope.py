"""
InvoiceService.bulk_set_items -- the path the Create Invoice wizard saves
line items through -- never checked that a line's product_id belongs to the
invoice's organization (add_item resolves the product org-scoped; this
sibling did not), so another tenant's product could be attached to a line.
It now rejects such a product the same way a foreign tax_rate_id is rejected.
"""
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.models import InvoiceStatus, Product
from app.modules.billing.services.invoice_service import InvoiceService
from tests.conftest import make_customer, make_invoice, make_organization


def _make_product(db, organization_id, code, price="1500.00"):
    product = Product(
        organization_id=organization_id, name=f"Product {code}", code=code,
        currency="USD", default_price=Decimal(price), original_price=Decimal("0.00"),
    )
    db.add(product)
    db.flush()
    return product


def _line(product_id, unit_price="1500.00"):
    return {
        "description": "Website Audit", "quantity": 1, "unit_price": Decimal(unit_price),
        "product_id": product_id, "original_currency": "USD",
        "original_amount": Decimal(unit_price), "exchange_rate": Decimal("1"),
        "tax_percentage": Decimal("0"),
    }


def test_bulk_set_items_accepts_own_product_and_keeps_its_price(db_session):
    org = make_organization(db_session, code="BSIORG1", name="Bulk Set Org 1")
    customer = make_customer(db_session, org.id, code="BSICUST1", currency="USD")
    invoice = make_invoice(db_session, org.id, customer.id, status=InvoiceStatus.DRAFT, total_amount="0.00", currency="USD")
    product = _make_product(db_session, org.id, "AUD1")
    db_session.commit()

    svc = InvoiceService(db_session)
    items = svc.bulk_set_items(invoice.id, org.id, [_line(product.id)])

    assert len(items) == 1
    assert items[0].product_id == product.id
    assert items[0].unit_price == Decimal("1500.00")
    assert svc.repo.get_by_id(invoice.id, org.id).subtotal == Decimal("1500.00")


def test_bulk_set_items_rejects_another_organizations_product(db_session):
    org = make_organization(db_session, code="BSIORG2", name="Bulk Set Org 2")
    other_org = make_organization(db_session, code="BSIORG3", name="Bulk Set Org 3")
    customer = make_customer(db_session, org.id, code="BSICUST2", currency="USD")
    invoice = make_invoice(db_session, org.id, customer.id, status=InvoiceStatus.DRAFT, total_amount="0.00", currency="USD")
    foreign_product = _make_product(db_session, other_org.id, "AUD2")
    db_session.commit()

    svc = InvoiceService(db_session)
    with pytest.raises(BadRequestException):
        svc.bulk_set_items(invoice.id, org.id, [_line(foreign_product.id)])


def test_bulk_set_items_allows_lines_without_a_product(db_session):
    org = make_organization(db_session, code="BSIORG4", name="Bulk Set Org 4")
    customer = make_customer(db_session, org.id, code="BSICUST4", currency="USD")
    invoice = make_invoice(db_session, org.id, customer.id, status=InvoiceStatus.DRAFT, total_amount="0.00", currency="USD")
    db_session.commit()

    svc = InvoiceService(db_session)
    items = svc.bulk_set_items(invoice.id, org.id, [{
        "description": "Ad-hoc service", "quantity": 2, "unit_price": Decimal("50.00"), "tax_percentage": Decimal("0"),
    }])
    assert items[0].product_id is None
    assert svc.repo.get_by_id(invoice.id, org.id).subtotal == Decimal("100.00")
