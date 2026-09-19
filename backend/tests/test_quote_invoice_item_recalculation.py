"""
Regression coverage for DEF-QA-002 / DEF-QA-003 (qa_evidence/DEFECT_LOG.md,
Aug 27 2026 fresh-org E2E QA run).

Both app.modules.billing.services.QuoteService.add_item() and
InvoiceService.add_item() computed correct line-item financials but never
called their own recalculate_quote()/recalculate_invoice(), unlike every
sibling mutating method (bulk_add_items, update_item, remove_item,
bulk_set_items / bulk_set_items). A document built one line at a time via
the natural interactive "Add Line" UI flow therefore displayed an all-zero
header (subtotal/tax_amount/total_amount) until something else incidentally
triggered a recalc.

Fixed by adding the missing recalculate_quote()/recalculate_invoice() call
at the end of each add_item(), matching the sibling methods. QuoteService's
add_item() was also missing the DRAFT-only status guard present on every
other quote item mutator (bulk_add_items, update_item, remove_item) --
fixed alongside since it's the same "single-item method doesn't match its
siblings" defect.
"""
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.models import InvoiceStatus, QuoteStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.quote_service import QuoteService
from tests.conftest import make_customer, make_invoice, make_organization, make_quotation


def test_quote_add_item_recalculates_header_totals(db_session):
    org = make_organization(db_session, code="QIRORG1", name="Quote Recalc Org")
    customer = make_customer(db_session, org.id, code="QIRCUST1", currency="USD")
    quote = make_quotation(db_session, org.id, customer.id, total_amount="0.00", currency="USD")
    db_session.commit()

    svc = QuoteService(db_session)
    svc.add_item(
        quote.id, org.id,
        description="Line 1", quantity=2, unit_price=Decimal("100.00"), tax_percentage=Decimal("18"),
    )

    refreshed = svc.get_quote(quote.id, org.id)
    assert refreshed.subtotal == Decimal("200.00")
    assert refreshed.tax_amount == Decimal("36.00")
    assert refreshed.total_amount == Decimal("236.00")


def test_quote_add_item_second_line_recalculates_cumulative_totals(db_session):
    """Adding items one at a time (not via bulk) must keep the header in
    sync after each call, not just the first."""
    org = make_organization(db_session, code="QIRORG2", name="Quote Recalc Org 2")
    customer = make_customer(db_session, org.id, code="QIRCUST2", currency="USD")
    quote = make_quotation(db_session, org.id, customer.id, total_amount="0.00", currency="USD")
    db_session.commit()

    svc = QuoteService(db_session)
    svc.add_item(quote.id, org.id, description="Line 1", quantity=1, unit_price=Decimal("50.00"), tax_percentage=Decimal("0"))
    svc.add_item(quote.id, org.id, description="Line 2", quantity=1, unit_price=Decimal("50.00"), tax_percentage=Decimal("0"))

    refreshed = svc.get_quote(quote.id, org.id)
    assert refreshed.subtotal == Decimal("100.00")
    assert refreshed.total_amount == Decimal("100.00")


def test_quote_add_item_rejects_non_draft_quote(db_session):
    """add_item was the one item mutator missing the DRAFT-only guard that
    bulk_add_items/update_item/remove_item all already enforce."""
    org = make_organization(db_session, code="QIRORG3", name="Quote Recalc Org 3")
    customer = make_customer(db_session, org.id, code="QIRCUST3", currency="USD")
    quote = make_quotation(db_session, org.id, customer.id, status=QuoteStatus.SENT, total_amount="0.00", currency="USD")
    db_session.commit()

    svc = QuoteService(db_session)
    with pytest.raises(BadRequestException):
        svc.add_item(quote.id, org.id, description="Late line", quantity=1, unit_price=Decimal("10.00"))


def test_invoice_add_item_recalculates_header_totals(db_session):
    org = make_organization(db_session, code="QIRORG4", name="Invoice Recalc Org")
    customer = make_customer(db_session, org.id, code="QIRCUST4", currency="USD")
    invoice = make_invoice(db_session, org.id, customer.id, status=InvoiceStatus.DRAFT, total_amount="0.00", currency="USD")
    db_session.commit()

    svc = InvoiceService(db_session)
    svc.add_item(
        invoice.id, org.id,
        description="Line 1", quantity=1, unit_price=Decimal("4999.00"), tax_percentage=Decimal("18"),
    )

    refreshed = svc.repo.get_by_id(invoice.id, org.id)
    assert refreshed.subtotal == Decimal("4999.00")
    assert refreshed.tax_amount == Decimal("899.82")
    assert refreshed.total_amount == Decimal("5898.82")


def test_invoice_add_item_second_line_recalculates_cumulative_totals(db_session):
    org = make_organization(db_session, code="QIRORG5", name="Invoice Recalc Org 2")
    customer = make_customer(db_session, org.id, code="QIRCUST5", currency="USD")
    invoice = make_invoice(db_session, org.id, customer.id, status=InvoiceStatus.DRAFT, total_amount="0.00", currency="USD")
    db_session.commit()

    svc = InvoiceService(db_session)
    svc.add_item(invoice.id, org.id, description="Line 1", quantity=1, unit_price=Decimal("100.00"), tax_percentage=Decimal("0"))
    svc.add_item(invoice.id, org.id, description="Line 2", quantity=1, unit_price=Decimal("50.00"), tax_percentage=Decimal("0"))

    refreshed = svc.repo.get_by_id(invoice.id, org.id)
    assert refreshed.subtotal == Decimal("150.00")
    assert refreshed.total_amount == Decimal("150.00")
