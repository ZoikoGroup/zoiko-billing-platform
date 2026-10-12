"""Section 3: invoice/customer/payment/quotation list endpoints must not issue
per-row queries (N+1). 20 rows + related data are created, the real service
list method is called at page size 20 and the result is serialized through the
endpoint's response model so any lazy relationship it touches is counted."""
from app.modules.billing.schemas import (
    CustomerListResponse,
    InvoiceListResponse,
    PaymentListResponse,
    QuotationListResponse,
    UnallocatedPaymentListResponse,
)
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.payment_service import PaymentService
from app.modules.billing.services.quote_service import QuoteService

from tests.conftest import (
    make_customer,
    make_invoice,
    make_invoice_item,
    make_organization,
    make_payment,
    make_quotation,
    make_quotation_item,
)
from tests.query_helpers import assert_max_queries

N = 20


def _seed(db):
    org = make_organization(db)
    for i in range(N):
        c = make_customer(db, org.id, code=f"C{i}", email=f"c{i}@x.com")
        inv = make_invoice(db, org.id, c.id, invoice_number=f"INV-{i}")
        make_invoice_item(db, org.id, inv.id)
        make_payment(db, org.id, c.id, payment_number=f"PAY-{i}")
        q = make_quotation(db, org.id, c.id, quote_number=f"QUO-{i}")
        make_quotation_item(db, org.id, q.id)
    db.commit()
    db.expire_all()
    return org


def test_list_invoices_query_count(db_session):
    org = _seed(db_session)
    with assert_max_queries(6, "list_invoices"):
        res = InvoiceService(db_session).list_invoices(org.id, page=1, per_page=20)
        out = InvoiceListResponse.model_validate(res)
    assert len(out.items) == N and out.items[0].customer_name


def test_list_customers_query_count(db_session):
    org = _seed(db_session)
    with assert_max_queries(6, "list_customers"):
        res = CustomerService(db_session).list_customers(org.id, page=1, per_page=20)
        out = CustomerListResponse.model_validate(res)
    assert len(out.items) == N


def test_list_payments_query_count(db_session):
    org = _seed(db_session)
    with assert_max_queries(6, "list_payments"):
        res = PaymentService(db_session).list_payments(org.id, page=1, per_page=20)
        out = PaymentListResponse.model_validate(res)
    assert len(out.items) == N


def test_list_unallocated_payments_query_count(db_session):
    org = _seed(db_session)
    with assert_max_queries(6, "list_unallocated_payments"):
        res = PaymentService(db_session).list_unallocated_payments(org.id, page=1, per_page=20)
        out = UnallocatedPaymentListResponse.model_validate(res)
    assert len(out.items) == N


def test_list_quotes_query_count(db_session):
    org = _seed(db_session)
    with assert_max_queries(6, "list_quotes"):
        res = QuoteService(db_session).list_quotes(org.id, page=1, per_page=20)
        out = QuotationListResponse.model_validate(res)
    assert len(out.items) == N
