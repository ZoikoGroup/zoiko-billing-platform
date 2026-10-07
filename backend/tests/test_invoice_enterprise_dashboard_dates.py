"""
GET /billing/invoices/enterprise-dashboard?date_from=...&date_to=... returned
HTTP 500 in production (Postgres + psycopg 3) while working without dates:
get_enterprise_dashboard_stats compared the issue_date DATE column with the
raw query-string, which psycopg 3 binds as text and Postgres rejects
(date >= text). The Invoice Dashboard always sends its date range, so every
KPI on it failed to load.

SQLite accepts the comparison, so the regression check inspects what is
actually bound: the date parameters must be datetime.date objects. An invalid
date must be a 400, not a crash.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import event

from app.core.exceptions import BadRequestException
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.billing.repositories.invoice import InvoiceRepository
from tests.conftest import make_customer, make_organization


def _bound_params(db_session, fn):
    """Python values bound to statements touching issue_date, captured BEFORE
    the dialect's type processing (which stringifies dates on SQLite)."""
    seen = []

    def capture(conn, clauseelement, multiparams, params, execution_options):
        compiled = clauseelement.compile(dialect=conn.dialect)
        if "issue_date" in str(compiled):
            seen.extend(compiled.params.values())

    engine = db_session.get_bind()
    event.listen(engine, "before_execute", capture)
    try:
        result = fn()
    finally:
        event.remove(engine, "before_execute", capture)
    return result, seen


def test_date_range_is_bound_as_dates_not_strings(db_session):
    org = make_organization(db_session, code="EDDATES", name="Enterprise Dashboard Dates")
    cust = make_customer(db_session, org.id, code="EDD1")
    today = date.today()
    for n, issued in enumerate([today - timedelta(days=3), today - timedelta(days=60)]):
        db_session.add(Invoice(
            organization_id=org.id, customer_id=cust.id, invoice_number=f"EDD-{n}",
            status=InvoiceStatus.SENT, issue_date=issued, due_date=issued + timedelta(days=30),
            total_amount="100.00", paid_amount="0.00", balance_due="100.00", currency="USD",
        ))
    db_session.commit()

    repo = InvoiceRepository(db_session)
    frm, to = (today - timedelta(days=30)).isoformat(), today.isoformat()
    stats, params = _bound_params(db_session, lambda: repo.get_enterprise_dashboard_stats(org.id, date_from=frm, date_to=to))

    assert stats["total_invoices"] == 1  # only the invoice issued inside the window
    assert frm not in params and to not in params, "raw query-string dates reached SQL"
    assert date.fromisoformat(frm) in params and date.fromisoformat(to) in params


def test_invalid_date_is_a_400_not_a_crash(db_session):
    org = make_organization(db_session, code="EDDBAD", name="Enterprise Dashboard Bad Date")
    db_session.commit()
    with pytest.raises(BadRequestException):
        InvoiceRepository(db_session).get_enterprise_dashboard_stats(org.id, date_from="not-a-date")


def test_overdue_count_matches_the_overdue_list_filter(db_session):
    """The dashboard's Overdue count used only the OVERDUE status flag (set by
    an off-by-default scheduler), so an open, past-due invoice showed as
    "Overdue 0" while /invoices?status=overdue listed it."""
    org = make_organization(db_session, code="EDDOVR", name="Enterprise Dashboard Overdue")
    cust = make_customer(db_session, org.id, code="EDO1")
    today = date.today()
    rows = [
        ("past-due-sent", InvoiceStatus.SENT, today - timedelta(days=40), today - timedelta(days=10), "500.00"),
        ("flagged", InvoiceStatus.OVERDUE, today - timedelta(days=5), today + timedelta(days=5), "50.00"),
        ("future-due", InvoiceStatus.SENT, today - timedelta(days=2), today + timedelta(days=20), "70.00"),
        ("paid-late", InvoiceStatus.PAID, today - timedelta(days=40), today - timedelta(days=10), "0.00"),
    ]
    for n, (num, st, issued, due, bal) in enumerate(rows):
        db_session.add(Invoice(
            organization_id=org.id, customer_id=cust.id, invoice_number=f"EDO-{num}",
            status=st, issue_date=issued, due_date=due,
            total_amount="500.00", paid_amount="0.00", balance_due=bal, currency="USD",
        ))
    db_session.commit()

    repo = InvoiceRepository(db_session)
    stats = repo.get_enterprise_dashboard_stats(org.id)
    listed = repo.list_paginated(organization_id=org.id, page=1, per_page=50, status="overdue")
    assert stats["overdue_count"] == 2  # past-due SENT + flagged OVERDUE; not future-due, not paid
    assert stats["overdue_count"] == listed["total"]  # the card equals the list it opens
    assert stats["overdue_amount"] == 550.0
    assert stats["status_counts"].get("overdue") == 1  # raw flag count is unchanged

    # Production case: a date range that EXCLUDES the overdue invoices' issue
    # dates must not zero the amount while the count stays 1+ ("1 invoice
    # overdue — ₹0.00"). Overdue is a snapshot, like the list it opens.
    narrow = repo.get_enterprise_dashboard_stats(org.id, date_from=today.isoformat(), date_to=today.isoformat())
    listed_amount = sum(float(i.balance_due) for i in listed["items"])
    assert narrow["overdue_count"] == listed["total"] == 2
    assert narrow["overdue_amount"] == listed_amount == 550.0
