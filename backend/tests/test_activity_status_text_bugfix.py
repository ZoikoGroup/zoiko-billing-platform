"""
tests/test_activity_status_text_bugfix.py
-----------------------------------------
The recent-activity feed (billing-admin workspace dashboard) built its message
from the enum objects, so it read "Status changed from InvoiceStatus.OVERDUE
to InvoiceStatus.SENT". It must use the status values.
"""
from app.modules.billing.models import InvoiceStatus, InvoiceStatusHistory
from app.modules.billing.repositories.invoice import InvoiceRepository
from tests.conftest import make_customer, make_invoice, make_organization


def test_recent_activity_message_uses_status_values(db_session):
    org = make_organization(db_session)
    customer = make_customer(db_session, org.id)
    invoice = make_invoice(db_session, org.id, customer.id, status=InvoiceStatus.SENT)
    db_session.add_all([
        InvoiceStatusHistory(organization_id=org.id, invoice_id=invoice.id, from_status=None, to_status=InvoiceStatus.DRAFT),
        InvoiceStatusHistory(organization_id=org.id, invoice_id=invoice.id, from_status=InvoiceStatus.OVERDUE, to_status=InvoiceStatus.SENT),
    ])
    db_session.flush()

    actions = {a["action"] for a in InvoiceRepository(db_session).get_recent_activity(org.id)}

    assert actions == {"Status changed from new to draft", "Status changed from overdue to sent"}
    assert not any("InvoiceStatus." in a for a in actions)
