"""
An invoice with no line items could be finalized and emailed: QA issued a
numbered invoice that billed only its 100.00 shipping amount, and another for
0.00. Both paths that move a draft to SENT -- finalize_invoice and
send_invoice_via_email -- now require at least one line item.

Also: a voided invoice must stay visible in the invoice list.
"""
import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.models import InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from tests.conftest import make_customer, make_invoice, make_invoice_item, make_organization


def test_finalize_rejects_invoice_without_items(db_session):
    org = make_organization(db_session, code="EMPTYORG1", name="Empty Invoice Org 1")
    cust = make_customer(db_session, org.id, code="EMPTYCUST1")
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT, total_amount="0.00", invoice_number="INV-EMPTY-1")
    db_session.commit()

    svc = InvoiceService(db_session)
    with pytest.raises(BadRequestException, match="at least one line item"):
        svc.finalize_invoice(inv.id, org.id, updated_by=1)
    assert svc.repo.get_by_id(inv.id, org.id).status == InvoiceStatus.DRAFT


def test_send_email_rejects_invoice_without_items(db_session):
    org = make_organization(db_session, code="EMPTYORG2", name="Empty Invoice Org 2")
    cust = make_customer(db_session, org.id, code="EMPTYCUST2")
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT, total_amount="0.00", invoice_number="INV-EMPTY-2")
    db_session.commit()

    svc = InvoiceService(db_session)
    with pytest.raises(BadRequestException, match="at least one line item"):
        svc.send_invoice_via_email(inv.id, org.id, sent_by=1)
    assert svc.repo.get_by_id(inv.id, org.id).status == InvoiceStatus.DRAFT


def test_finalize_still_allows_a_fully_discounted_invoice_with_lines(db_session):
    org = make_organization(db_session, code="EMPTYORG3", name="Empty Invoice Org 3")
    cust = make_customer(db_session, org.id, code="EMPTYCUST3")
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT, total_amount="0.00", invoice_number="INV-EMPTY-3")
    make_invoice_item(db_session, org.id, inv.id, unit_price="0.00", total="0.00")
    db_session.commit()

    result = InvoiceService(db_session).finalize_invoice(inv.id, org.id, updated_by=1)
    assert result.status == InvoiceStatus.SENT


def test_voided_invoice_stays_in_the_invoice_list(db_session):
    """void_invoice also cleared is_active, which the list filters on, so a
    voided invoice disappeared from the list (a cancelled one did not)."""
    org = make_organization(db_session, code="VOIDORG1", name="Void Org 1")
    cust = make_customer(db_session, org.id, code="VOIDCUST1")
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, invoice_number="INV-VOID-1")
    db_session.commit()

    svc = InvoiceService(db_session)
    voided = svc.void_invoice(inv.id, org.id, reason="Billed in error", updated_by=1)
    assert voided.status == InvoiceStatus.CANCELLED

    listed = svc.list_invoices(organization_id=org.id)
    assert inv.id in [i.id for i in listed["items"]]
