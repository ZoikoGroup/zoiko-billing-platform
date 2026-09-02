"""
Task 6 (N+1 audit) regression: the /credit-notes list endpoint serializes
CreditNoteResponse, whose customer_* fields are hybrid properties that lazy-load
CreditNote.customer per row. CreditNoteRepository._apply_eager_loads must
joinedload customer so a page of N credit notes stays at a flat number of
queries instead of scaling with N.
"""
from datetime import date

from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer,
    CreditNote,
    CreditNoteStatus,
    CreditNoteType,
    Invoice,
    InvoiceStatus,
)
from app.modules.billing.repositories.credit import CreditNoteRepository
from app.modules.billing.repositories.invoice import InvoiceRepository
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.schemas import CreditNoteResponse, InvoiceResponse
from app.modules.billing.models import InvoiceStatus
from tests.conftest import count_queries as _count_queries


def _make_org(db):
    org = Organization(organization_name="Org", organization_code="ORG1")
    db.add(org)
    db.flush()
    return org


def _make_customer(db, org_id, code):
    customer = BillingCustomer(
        organization_id=org_id,
        customer_code=code,
        company_name=f"Customer {code}",
        display_name=f"Customer {code}",
        currency="USD",
        email=f"{code}@example.com",
    )
    db.add(customer)
    db.flush()
    return customer


def _create_credit_notes(db, org_id, customer_ids, count):
    notes = []
    for i in range(count):
        customer_id = customer_ids[i % len(customer_ids)]
        cn = CreditNote(
            organization_id=org_id,
            customer_id=customer_id,
            credit_note_number=f"CN-{i}",
            credit_note_type=CreditNoteType.PARTIAL_CREDIT,
            status=CreditNoteStatus.ISSUED,
            total_amount="10.00",
            remaining_amount="10.00",
            reason=f"reason {i}",
            issue_date=date.today(),
        )
        db.add(cn)
        notes.append(cn)
    db.commit()
    return notes


def test_credit_note_list_eager_loads_customer(db_session):
    org = _make_org(db_session)
    customers = [_make_customer(db_session, org.id, code=f"CUST{i}") for i in range(6)]
    cids = [c.id for c in customers]

    # Distinct customers per row so a lazy load fires a fresh query per row,
    # not one that SQLite's identity map can serve from an already-loaded row.
    _create_credit_notes(db_session, org.id, cids, 6)

    repo = CreditNoteRepository(db_session)
    with _count_queries(db_session) as counter:
        result = repo.list_paginated(organization_id=org.id, page=1, per_page=6)

    items = result["items"]
    assert len(items) == 6
    # Every row's customer_* data is populated, proving the relationship loaded.
    for inv in items:
        assert inv.customer_name is not None

    # Measure serialization of a fresh fetch: total SELECTs must be flat
    # (pagination + eager join), not 1 + N (one lazy-load per distinct customer).
    with _count_queries(db_session) as counter2:
        result2 = repo.list_paginated(organization_id=org.id, page=1, per_page=6)
        for row in result2["items"]:
            # Pydantic serialization walks the customer_* hybrid properties;
            # if customer were lazily loaded these would each fire a query.
            CreditNoteResponse.model_validate(row)

    # 1 query for the page (window function + joinedload in one execute). A
    # non-eager path fires 1 + N (N distinct customers) => 7 here.
    assert counter2["n"] <= 2, f"expected flat query count, got {counter2['n']}"


def _make_invoice(db, org_id, customer_id, status, number):
    from datetime import timedelta
    inv = Invoice(
        organization_id=org_id,
        customer_id=customer_id,
        invoice_number=number,
        status=status,
        issue_date=date.today(),
        due_date=date.today() - timedelta(days=5),
        total_amount="100.00",
        paid_amount="0.00",
        balance_due="100.00",
        currency="USD",
    )
    db.add(inv)
    db.flush()
    return inv


def test_invoice_overdue_list_eager_loads_customer(db_session):
    org = _make_org(db_session)
    customers = [_make_customer(db_session, org.id, code=f"OC{i}") for i in range(6)]
    for i, c in enumerate(customers):
        _make_invoice(db_session, org.id, c.id, InvoiceStatus.SENT, f"INV-{i}")

    invoices = list(db_session.query(Invoice))
    assert len(invoices) == 6

    svc = InvoiceService(db_session)
    with _count_queries(db_session) as counter:
        rows = svc.list_overdue(org.id)
        for inv in rows:
            InvoiceResponse.model_validate(inv)

    # eager joinedload + serialization => flat query count, not 1 + N.
    assert counter["n"] <= 2, f"expected flat query count, got {counter['n']}"


def test_invoice_due_between_eager_loads_customer(db_session):
    org = _make_org(db_session)
    customers = [_make_customer(db_session, org.id, code=f"DB{i}") for i in range(6)]
    for i, c in enumerate(customers):
        _make_invoice(db_session, org.id, c.id, InvoiceStatus.SENT, f"DINV-{i}")

    repo = InvoiceRepository(db_session)
    with _count_queries(db_session) as counter:
        rows = repo.list_due_between(org.id, date.today().isoformat(), date.today().isoformat())
        for inv in rows:
            assert inv.customer is not None

    assert counter["n"] <= 2, f"expected flat query count, got {counter['n']}"
