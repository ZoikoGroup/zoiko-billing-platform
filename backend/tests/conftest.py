"""
tests/conftest.py
------------------
Minimal pytest fixtures for backend regression tests.

Every test runs against a fresh, isolated in-memory SQLite database created
via Base.metadata.create_all() for that single test only — never against
BILLING_DATABASE_URL (Neon/Postgres). This is the smallest infrastructure
needed to exercise real PaymentService/InvoiceService code paths without any
risk of touching shared or production tenant data.

Factory helpers here create only the columns each test actually needs;
everything else is left to its model-level default.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer,
    BillingPeriod,
    BillingSubscriptionStatus,
    Contract,
    ContractStatus,
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    Payment,
    PaymentStatus,
    PaymentType,
    PlanCategory,
    QuoteStatus,
    Quotation,
    QuotationItem,
    Subscription,
    SubscriptionPlan,
    TaxApplicability,
    TaxRate,
    TaxType,
)


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def count_queries(db):
    """Context manager yielding a {"n": int} counter of SELECT statements
    issued against `db`'s bind while the block runs — the N+1-audit
    regression tool (Task 5). Originally a private helper duplicated in
    test_credit_note_relations_query_count.py; promoted here so every
    query-count regression test shares one implementation.

    Usage:
        with count_queries(db_session) as counter:
            repo.list_paginated(...)
        assert counter["n"] <= 2
    """
    counter = {"n": 0}
    engine = db.get_bind()

    def _before(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().lower().startswith("select"):
            counter["n"] += 1

    event.listen(engine, "before_cursor_execute", _before)

    class _Guard:
        def __enter__(self):
            return counter

        def __exit__(self, *exc):
            event.remove(engine, "before_cursor_execute", _before)
            return False

    return _Guard()


@pytest.fixture(autouse=True)
def _clear_in_process_caches():
    """Every test gets a fresh in-memory DB (above) with auto-increment ids
    restarting at 1 — so any in-process TTL cache from a previous test would
    serve stale cross-test results under a colliding key. Reset them here."""
    from app.modules.billing.services.dashboard_service import _KPI_CACHE
    from app.modules.commercial.cache import _latest_published_cache

    _KPI_CACHE.clear()
    _latest_published_cache.clear()
    yield
    _KPI_CACHE.clear()
    _latest_published_cache.clear()


def make_organization(db, code="ORG1", name="Test Org"):
    org = Organization(organization_name=name, organization_code=code)
    db.add(org)
    db.flush()
    return org


def make_customer(db, organization_id, code="CUST1", currency="USD", email="customer@example.com"):
    customer = BillingCustomer(
        organization_id=organization_id,
        customer_code=code,
        company_name="Test Customer",
        display_name="Test Customer",
        currency=currency,
        email=email,
    )
    db.add(customer)
    db.flush()
    return customer


def make_invoice(
    db, organization_id, customer_id,
    status=InvoiceStatus.SENT, total_amount="100.00", paid_amount="0.00",
    currency="USD", invoice_number=None,
):
    total = total_amount if isinstance(total_amount, str) else str(total_amount)
    paid = paid_amount if isinstance(paid_amount, str) else str(paid_amount)
    invoice = Invoice(
        organization_id=organization_id,
        customer_id=customer_id,
        invoice_number=invoice_number or f"INV-{status.value}-{customer_id}",
        status=status,
        issue_date=date.today(),
        due_date=date.today(),
        total_amount=total,
        paid_amount=paid,
        balance_due=str(float(total) - float(paid)),
        currency=currency,
    )
    db.add(invoice)
    db.flush()





    db.refresh(invoice)
    return invoice


def make_payment(
    db, organization_id, customer_id,
    amount="100.00", status=PaymentStatus.CLEARED, currency="USD",
    payment_number=None, stripe_payment_intent_id=None,
):
    payment = Payment(
        organization_id=organization_id,
        customer_id=customer_id,
        payment_number=payment_number or f"PAY-{customer_id}-{amount}",
        payment_type=PaymentType.MANUAL,
        status=status,
        amount=amount,
        currency=currency,
        stripe_payment_intent_id=stripe_payment_intent_id,
        payment_date=date.today(),
    )
    db.add(payment)
    db.flush()
    return payment


def make_contract(
    db, organization_id, customer_id,
    status=ContractStatus.ACTIVE, contract_number=None, currency="USD",
):
    contract = Contract(
        organization_id=organization_id,
        customer_id=customer_id,
        contract_number=contract_number or f"CON-{organization_id}-{customer_id}-{status.value}",
        contract_name="Test Contract",
        status=status,
        start_date=date.today(),
        currency=currency,
    )
    db.add(contract)
    db.flush()
    return contract


def make_subscription_plan(db, organization_id, code=None):
    plan = SubscriptionPlan(
        organization_id=organization_id,
        plan_code=code or f"PLAN-{organization_id}",
        plan_name="Test Plan",
        category=PlanCategory.SUBSCRIPTION,
        billing_period=BillingPeriod.MONTHLY,
        unit_price="10.00",
    )
    db.add(plan)
    db.flush()
    return plan


def make_subscription(
    db, organization_id, customer_id, plan_id,
    contract_id=None, status=BillingSubscriptionStatus.ACTIVE,
    next_billing_at=None, subscription_number=None, unit_price="10.00",
    currency="USD", is_active=True,
):
    today = date.today()
    sub = Subscription(
        organization_id=organization_id,
        customer_id=customer_id,
        plan_id=plan_id,
        contract_id=contract_id,
        subscription_number=subscription_number or f"SUB-{organization_id}-{customer_id}-{plan_id}",
        status=status,
        unit_price=unit_price,
        start_date=today,
        current_term_start=today,
        current_term_end=today + timedelta(days=30),
        next_billing_at=next_billing_at if next_billing_at is not None else today,
        currency=currency,
        is_active=is_active,
    )
    db.add(sub)
    db.flush()
    return sub


def make_invoice_item(db, organization_id, invoice_id, line_number=1, description="Item", quantity="1", unit_price="100.00", total="100.00", tax_rate_id=None, tax_percentage="0"):
    item = InvoiceItem(
        organization_id=organization_id,
        invoice_id=invoice_id,
        line_number=line_number,
        description=description,
        quantity=quantity,
        unit_price=unit_price,
        total=total,
        tax_percentage=tax_percentage,
        tax_rate_id=tax_rate_id,
    )
    db.add(item)
    db.flush()
    return item


def make_quotation(
    db, organization_id, customer_id,
    status=QuoteStatus.DRAFT, total_amount="100.00", currency="USD", quote_number=None,
):
    quote = Quotation(
        organization_id=organization_id,
        customer_id=customer_id,
        quote_number=quote_number or f"QUO-{status.value}-{customer_id}",
        status=status,
        subtotal=total_amount,
        total_amount=total_amount,
        currency=currency,
    )
    db.add(quote)
    db.flush()
    return quote


def make_quotation_item(db, organization_id, quotation_id, line_number=1, description="Item", quantity="1", unit_price="100.00", total_amount="100.00", tax_rate_id=None, tax_percentage="0"):
    item = QuotationItem(
        organization_id=organization_id,
        quotation_id=quotation_id,
        line_number=line_number,
        description=description,
        quantity=quantity,
        unit_price=unit_price,
        total_amount=total_amount,
        tax_percentage=tax_percentage,
        tax_rate_id=tax_rate_id,
    )
    db.add(item)
    db.flush()
    return item


def make_tax_rate(
    db, organization_id, code, rate="15.00",
    name=None, currency_code=None, country_code=None,
    is_default=False, is_active=True, jurisdiction="Custom",
    tax_type=TaxType.SALES_TAX,
):
    """A custom/pre-existing org tax rate, for tests that need to verify
    the starter-catalogue seed never touches organization-created rates."""
    tax_rate = TaxRate(
        organization_id=organization_id,
        name=name or f"Custom Rate {code}",
        code=code,
        jurisdiction=jurisdiction,
        rate=rate,
        tax_type=tax_type,
        applies_to=TaxApplicability.BOTH,
        country_code=country_code,
        currency_code=currency_code,
        is_default=is_default,
        is_active=is_active,
        effective_from=date.today(),
    )
    db.add(tax_rate)
    db.flush()
    db.refresh(tax_rate)
    return tax_rate
