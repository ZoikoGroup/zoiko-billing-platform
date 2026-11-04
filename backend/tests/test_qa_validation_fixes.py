"""
Validation gaps found while exercising a demo organization end to end:

- customer payment terms rejected net_7 / net_10, which the org's own
  PaymentTerm enum (settings, invoice and contract forms) offers;
- customer contacts accepted any string as an email;
- overlapping pricing-plan tiers were accepted, making the price resolved
  for a quantity ambiguous;
- a duplicate pricing plan's 409 named the raw DB constraint;
- a contract could end before it started;
- a percentage discount could exceed 100%.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.core.exceptions import AlreadyExistsException, BadRequestException
from app.modules.billing.models import BillingPeriod, PricingModel, Product
from app.modules.billing.schemas import (
    CustomerContactCreate, CustomerContactUpdate, CustomerCreate, CustomerUpdate,
)
from app.modules.billing.services.contract_service import ContractService
from app.modules.billing.services.pricing_service import DiscountService, PricingService
from tests.conftest import make_customer, make_organization


@pytest.mark.parametrize("terms", ["net_7", "net_10", "due_on_receipt", "net_90"])
def test_customer_accepts_every_org_payment_term(terms):
    assert CustomerCreate(company_name="A", display_name="A", payment_terms=terms).payment_terms == terms
    assert CustomerUpdate(payment_terms=terms).payment_terms == terms


def test_customer_still_rejects_unknown_payment_terms():
    with pytest.raises(ValidationError):
        CustomerCreate(company_name="A", display_name="A", payment_terms="net_8")


@pytest.mark.parametrize("bad", ["bad", "a@b", "no-at.example.com"])
def test_contact_rejects_invalid_email(bad):
    with pytest.raises(ValidationError):
        CustomerContactCreate(first_name="A", last_name="B", email=bad)
    with pytest.raises(ValidationError):
        CustomerContactUpdate(email=bad)


def test_contact_email_is_normalized():
    assert CustomerContactCreate(first_name="A", last_name="B", email=" Ravi@Example.com ").email == "ravi@example.com"


def _product(db, org_id, code="QAV-P1"):
    product = Product(organization_id=org_id, name=f"P {code}", code=code, currency="USD", default_price=Decimal("10.00"))
    db.add(product)
    db.flush()
    return product


def test_overlapping_plan_tiers_are_rejected(db_session):
    org = make_organization(db_session, code="QAVORG1", name="QA Validation Org 1")
    product = _product(db_session, org.id)
    db_session.commit()
    svc = PricingService(db_session)
    plan = svc.create_plan(org.id, created_by=1, product_id=product.id, name="Tiered", billing_period=BillingPeriod.MONTHLY,
                           pricing_model=PricingModel.TIERED, effective_from=date.today())
    svc.add_tier(org.id, plan.id, created_by=1, from_quantity=1, to_quantity=10, unit_price=Decimal("5"))
    svc.add_tier(org.id, plan.id, created_by=1, from_quantity=11, to_quantity=None, unit_price=Decimal("4"))

    for frm, to in [(5, 12), (20, None), (10, 10)]:
        with pytest.raises(BadRequestException, match="overlaps"):
            svc.add_tier(org.id, plan.id, created_by=1, from_quantity=frm, to_quantity=to, unit_price=Decimal("1"))
    assert len(svc.list_tiers(plan.id, org.id)) == 2


def test_adjacent_tiers_are_still_allowed(db_session):
    org = make_organization(db_session, code="QAVORG2", name="QA Validation Org 2")
    product = _product(db_session, org.id, code="QAV-P2")
    db_session.commit()
    svc = PricingService(db_session)
    plan = svc.create_plan(org.id, created_by=1, product_id=product.id, name="Tiered", billing_period=BillingPeriod.MONTHLY,
                           pricing_model=PricingModel.TIERED, effective_from=date.today())
    for frm, to in [(1, 10), (11, 50), (51, None)]:
        svc.add_tier(org.id, plan.id, created_by=1, from_quantity=frm, to_quantity=to, unit_price=Decimal("1"))
    assert len(svc.list_tiers(plan.id, org.id)) == 3


def test_duplicate_pricing_plan_message_is_readable(db_session):
    org = make_organization(db_session, code="QAVORG3", name="QA Validation Org 3")
    product = _product(db_session, org.id, code="QAV-P3")
    db_session.commit()
    svc = PricingService(db_session)
    args = dict(product_id=product.id, billing_period=BillingPeriod.MONTHLY, pricing_model=PricingModel.FLAT,
                unit_price=Decimal("9"), effective_from=date.today())
    svc.create_plan(org.id, created_by=1, name="Monthly", **args)
    with pytest.raises(AlreadyExistsException) as exc:
        svc.create_plan(org.id, created_by=1, name="Monthly again", **args)
    assert "uq_" not in str(exc.value.message)
    assert "billing period" in str(exc.value.message)


def test_contract_cannot_end_before_it_starts(db_session):
    org = make_organization(db_session, code="QAVORG4", name="QA Validation Org 4")
    cust = make_customer(db_session, org.id, code="QAVCUST4")
    db_session.commit()
    svc = ContractService(db_session)
    today = date.today()
    with pytest.raises(BadRequestException, match="end date"):
        svc.create_contract(org.id, created_by=1, customer_id=cust.id, contract_number="QAV-C1", contract_name="Bad",
                            start_date=today, end_date=today - timedelta(days=1))

    ok = svc.create_contract(org.id, created_by=1, customer_id=cust.id, contract_number="QAV-C2", contract_name="Good",
                             start_date=today, end_date=today + timedelta(days=30))
    with pytest.raises(BadRequestException, match="end date"):
        svc.update_contract(ok.id, org.id, updated_by=1, end_date=today - timedelta(days=1))
    same_day = svc.update_contract(ok.id, org.id, updated_by=1, end_date=today)
    assert same_day.end_date == today


def test_percentage_discount_cannot_exceed_100(db_session):
    org = make_organization(db_session, code="QAVORG5", name="QA Validation Org 5")
    db_session.commit()
    svc = DiscountService(db_session)
    with pytest.raises(BadRequestException, match="100%"):
        svc.create(org.id, created_by=1, name="Too much", code="QAV150", discount_type="coupon",
                   discount_value=Decimal("150"), value_type="percentage", valid_from=date.today(), currency="USD")

    pct = svc.create(org.id, created_by=1, name="Ten", code="QAV10", discount_type="coupon",
                     discount_value=Decimal("10"), value_type="percentage", valid_from=date.today(), currency="USD")
    with pytest.raises(BadRequestException, match="100%"):
        svc.update(pct.id, org.id, updated_by=1, discount_value=Decimal("101"))

    fixed = svc.create(org.id, created_by=1, name="Flat 500", code="QAV500", discount_type="coupon",
                       discount_value=Decimal("500"), value_type="fixed", valid_from=date.today(), currency="USD")
    assert fixed.discount_value == Decimal("500")


@pytest.fixture
def fk_db_session():
    """Like db_session, but with SQLite foreign keys enforced (as Postgres
    does), so a delete blocked by a related row actually fails."""
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker
    from app.database import Base

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    event.listen(engine, "connect", lambda conn, _rec: conn.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_bulk_delete_of_customer_with_related_records_is_a_clean_400(fk_db_session):
    """bulk_hard_delete let the IntegrityError escape: deleting a customer that
    has contacts returned a 500 instead of an explanation."""
    from app.modules.billing.models import BillingCustomer, CustomerContact
    from app.modules.billing.services.customer_service import CustomerService

    db = fk_db_session
    org = make_organization(db, code="QAVORG6", name="QA Validation Org 6")
    with_contact = make_customer(db, org.id, code="QAVCUST6A")
    db.add(CustomerContact(organization_id=org.id, customer_id=with_contact.id, first_name="R", last_name="K", email="r@example.com"))
    db.commit()

    svc = CustomerService(db)
    with pytest.raises(BadRequestException, match="related records"):
        svc.bulk_delete_customers(org.id, [with_contact.id])
    assert db.query(BillingCustomer).filter(BillingCustomer.id == with_contact.id).count() == 1

    plain = make_customer(db, org.id, code="QAVCUST6B", email="plain@example.com")
    db.commit()
    assert svc.bulk_delete_customers(org.id, [plain.id]) == 1


@pytest.mark.parametrize("end_contract", ["cancel", "terminate"])
def test_ending_a_contract_cancels_its_subscription(db_session, end_contract):
    """Activating a contract creates its subscription, but cancelling or
    terminating the contract left that subscription active and billing."""
    from app.modules.billing.models import BillingSubscriptionStatus
    from app.modules.billing.services.subscription_service import SubscriptionService
    from tests.conftest import make_contract, make_subscription, make_subscription_plan

    org = make_organization(db_session, code=f"QAVORG7{end_contract[:2]}", name="QA Validation Org 7")
    cust = make_customer(db_session, org.id, code=f"QAVCUST7{end_contract[:2]}")
    contract = make_contract(db_session, org.id, cust.id, contract_number=f"QAV-CT-{end_contract}")
    plan = make_subscription_plan(db_session, org.id, code=f"QAV-PLAN-{end_contract}")
    linked = make_subscription(db_session, org.id, cust.id, plan.id, contract_id=contract.id, subscription_number=f"QAV-SUB-{end_contract}")
    unrelated = make_subscription(db_session, org.id, cust.id, plan.id, subscription_number=f"QAV-SUB-{end_contract}-other")
    db_session.commit()

    svc = ContractService(db_session)
    if end_contract == "cancel":
        svc.cancel_contract(contract.id, org.id, updated_by=1)
    else:
        svc.terminate_contract(contract.id, org.id, updated_by=1, reason="Customer left")

    subs = SubscriptionService(db_session)
    assert subs.repo.get_by_id(linked.id, org.id).status == BillingSubscriptionStatus.CANCELLED
    assert subs.repo.get_by_id(unrelated.id, org.id).status == BillingSubscriptionStatus.ACTIVE
