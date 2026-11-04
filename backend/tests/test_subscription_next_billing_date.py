"""
SubscriptionService.generate_invoice bills the period it opens in advance --
the term becomes [billing_date, billing_date + period] -- but then set
next_billing_at to current_term_end + another period. QA saw a monthly
subscription billed on 2026-11-03 report "not due until 2027-01-03": every
other month went unbilled. The next bill is due when the billed term ends.
"""
from datetime import date

from app.modules.billing.models import BillingPeriod, Invoice
from app.modules.billing.services.subscription_service import SubscriptionService
from tests.conftest import make_customer, make_organization, make_subscription, make_subscription_plan


def test_next_billing_is_the_end_of_the_term_just_billed(db_session):
    org = make_organization(db_session, code="NBDORG1", name="Next Billing Org")
    cust = make_customer(db_session, org.id, code="NBDCUST1")
    plan = make_subscription_plan(db_session, org.id, code="NBD-MONTHLY")
    sub = make_subscription(db_session, org.id, cust.id, plan.id, subscription_number="NBD-0001", next_billing_at=date.today())
    db_session.commit()

    svc = SubscriptionService(db_session)
    svc.generate_invoice(sub.id, org.id, created_by=1)

    refreshed = svc.repo.get_by_id(sub.id, org.id)
    one_period_out = svc._compute_next_billing_date(date.today(), BillingPeriod.MONTHLY)
    assert refreshed.current_term_start == date.today()
    assert refreshed.current_term_end == one_period_out
    assert refreshed.next_billing_at == one_period_out
    assert db_session.query(Invoice).filter(Invoice.subscription_id == sub.id).count() == 1


def test_renewal_makes_the_renewed_term_due_when_it_starts(db_session):
    """renew_subscription opens [term_end, term_end + period] without billing
    it, but set next_billing_at a full period past that term's end -- so the
    renewed term was never invoiced."""
    from app.modules.billing.models import BillingSubscriptionStatus

    org = make_organization(db_session, code="NBDORG2", name="Renewal Org")
    cust = make_customer(db_session, org.id, code="NBDCUST2")
    plan = make_subscription_plan(db_session, org.id, code="NBD-RENEW")
    term_end = date.today()
    sub = make_subscription(db_session, org.id, cust.id, plan.id, subscription_number="NBD-0002",
                            status=BillingSubscriptionStatus.EXPIRED, next_billing_at=term_end, current_term_end=term_end)
    db_session.commit()

    svc = SubscriptionService(db_session)
    svc.renew_subscription(sub.id, org.id, updated_by=1)
    renewed = svc.repo.get_by_id(sub.id, org.id)
    assert renewed.status == BillingSubscriptionStatus.ACTIVE
    assert renewed.current_term_start == term_end
    assert renewed.next_billing_at == term_end  # the renewed term is due now

    # Billing it then rolls forward exactly one period.
    svc.generate_invoice(sub.id, org.id, created_by=1)
    billed = svc.repo.get_by_id(sub.id, org.id)
    assert billed.next_billing_at == svc._compute_next_billing_date(term_end, BillingPeriod.MONTHLY)
    assert db_session.query(Invoice).filter(Invoice.subscription_id == sub.id).count() == 1


def test_renewal_keeps_an_earlier_unbilled_period_due(db_session):
    org = make_organization(db_session, code="NBDORG3", name="Renewal Org 3")
    cust = make_customer(db_session, org.id, code="NBDCUST3")
    plan = make_subscription_plan(db_session, org.id, code="NBD-RENEW3")
    unbilled_from = date.today()
    sub = make_subscription(db_session, org.id, cust.id, plan.id, subscription_number="NBD-0003", next_billing_at=unbilled_from)
    db_session.commit()

    svc = SubscriptionService(db_session)
    svc.renew_subscription(sub.id, org.id, updated_by=1)
    assert svc.repo.get_by_id(sub.id, org.id).next_billing_at == unbilled_from
