"""tests/test_registration_start_mode.py
------------------------------------------
Registration offers two ways to start:
  - trial (default): the standard 14-day ESSENTIALS trial, whatever plan was
    passed, nothing to pay up front;
  - paid ("buy now"): the chosen plan is provisioned PENDING with no trial and
    a finalized invoice + public pay link is returned; the first cleared Stripe
    payment activates it and anchors its billing period.
"""
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from app.modules.auth.models import User
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.commercial.enums import CommercialSubscriptionStatus, PlatformInvoiceStatus
from app.modules.commercial.models import CommercialAccount, CommercialSubscription, PlatformInvoice
from app.modules.commercial.platform_payment_service import PlatformPaymentService
from app.modules.commercial.platform_stripe_service import PlatformStripeService
from tests.test_plan_change_orchestration import _plan_with_published_version

SETTINGS_PATH = "app.modules.commercial.platform_stripe_service.settings"
STRIPE_MODULE_PATH = "app.modules.commercial.platform_stripe_service._stripe_module"


def _seed_plans(db):
    _plan_with_published_version(db, "essentials", price_amount=49)
    _plan_with_published_version(db, "professional", price_amount=149)
    db.commit()


def _register(db, email, **overrides):
    payload = dict(
        organization="Acme Corp", name="Ada Admin", email=email, password="StrongPass123!",
        currency="USD", intended_plan="essentials",
    )
    payload.update(overrides)
    return register_enterprise(db, RegisterRequest(**payload))


def _subscription_for(db, email):
    admin = db.query(User).filter_by(email=email).first()
    account = db.query(CommercialAccount).filter_by(organization_id=admin.organization_id).first()
    return account, db.query(CommercialSubscription).filter_by(commercial_account_id=account.id).one()


def test_default_start_is_the_14_day_essentials_trial_even_if_another_plan_is_sent(db_session):
    _seed_plans(db_session)
    result = _register(db_session, "trial@example.com", intended_plan="professional")

    _, sub = _subscription_for(db_session, "trial@example.com")
    assert sub.plan.plan_code == "essentials"
    assert sub.status == CommercialSubscriptionStatus.TRIALING
    assert result["start_mode"] == "trial"
    assert result["payment_token"] is None
    days = (sub.trial_ends_at - sub.created_at).days if sub.created_at else 14
    assert 13 <= days <= 14


def test_paid_start_provisions_chosen_plan_pending_with_a_pay_link(db_session):
    _seed_plans(db_session)
    result = _register(db_session, "paid@example.com", intended_plan="professional", start_mode="paid")

    account, sub = _subscription_for(db_session, "paid@example.com")
    assert sub.plan.plan_code == "professional"
    assert sub.status == CommercialSubscriptionStatus.PENDING
    assert sub.trial_ends_at is None
    assert result["start_mode"] == "paid"

    invoice = db_session.query(PlatformInvoice).filter_by(commercial_subscription_id=sub.id).one()
    assert invoice.status == PlatformInvoiceStatus.ISSUED
    assert float(invoice.balance_due) == 149.0
    assert result["payment_token"] == invoice.public_token


def test_paying_the_signup_invoice_activates_the_plan_and_stamps_its_period(db_session):
    _seed_plans(db_session)
    result = _register(db_session, "activate@example.com", intended_plan="professional", start_mode="paid")
    account, sub = _subscription_for(db_session, "activate@example.com")
    invoice = db_session.query(PlatformInvoice).filter_by(commercial_subscription_id=sub.id).one()

    payment = PlatformPaymentService(db_session).record(
        account_id=account.id, actor_id=None, amount=invoice.balance_due,
        currency=invoice.currency, payment_method="card", notes="signup checkout",
    )
    payment.gateway_checkout_session_id = "cs_signup_1"
    db_session.commit()

    event = {
        "id": "evt_signup_1", "type": "checkout.session.completed", "livemode": False,
        "data": {"object": {
            "id": "cs_signup_1", "payment_intent": "pi_signup_1",
            "metadata": {"platform_invoice_id": str(invoice.id)},
        }},
    }
    with patch(SETTINGS_PATH) as s:
        s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
        s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
        ms, me = MagicMock(), MagicMock()
        me.to_dict.return_value = event
        ms.Webhook.construct_event.return_value = me
        with patch(STRIPE_MODULE_PATH, return_value=ms):
            PlatformStripeService(db_session).handle_webhook_event(b"{}", "t=1,v1=sig")

    db_session.expire_all()
    sub = db_session.query(CommercialSubscription).get(sub.id)
    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    assert sub.current_period_start is not None
    assert sub.current_period_end is not None
    assert sub.current_period_end - sub.current_period_start >= timedelta(days=28)


def test_enterprise_is_still_not_registrable(db_session):
    with pytest.raises(ValidationError):
        RegisterRequest(
            organization="X", name="Y Z", email="e@example.com", password="StrongPass123!",
            currency="USD", intended_plan="enterprise", start_mode="paid",
        )


def test_unknown_start_mode_is_rejected():
    with pytest.raises(ValidationError):
        RegisterRequest(
            organization="X", name="Y Z", email="e2@example.com", password="StrongPass123!",
            currency="USD", intended_plan="essentials", start_mode="free_forever",
        )


def test_registration_without_a_provisionable_plan_raises_an_attention_item(db_session):
    # No plans seeded at all -> nothing can be provisioned.
    _register(db_session, "noplan@example.com")
    from app.modules.super_admin.models import AttentionItem

    items = db_session.query(AttentionItem).filter(AttentionItem.source == "registration").all()
    assert len(items) == 1
    assert "without a subscription" in items[0].title


def test_start_trial_self_heals_an_org_with_no_subscription(db_session):
    from app.modules.commercial.org_self_service_router import start_trial
    from tests.test_plan_change_orchestration import _fake_billing_admin

    _register(db_session, "heal@example.com")          # no plans yet -> no subscription
    admin = db_session.query(User).filter_by(email="heal@example.com").first()
    account = db_session.query(CommercialAccount).filter_by(organization_id=admin.organization_id).first()
    assert db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).count() == 0

    _seed_plans(db_session)                              # Essentials becomes available
    result = start_trial(db=db_session, current_user=_fake_billing_admin(admin.organization_id))
    assert result["status"] == "trialing"
    sub = db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).one()
    assert sub.plan.plan_code == "essentials"

    # Second call: already has a subscription.
    from app.core.exceptions import BadRequestException
    with pytest.raises(BadRequestException):
        start_trial(db=db_session, current_user=_fake_billing_admin(admin.organization_id))


def test_start_trial_refused_when_trial_already_used(db_session):
    from app.core.exceptions import BadRequestException
    from app.modules.commercial.org_self_service_router import start_trial
    from tests.test_plan_change_orchestration import _fake_billing_admin

    _seed_plans(db_session)
    _register(db_session, "used@example.com")            # gets the trial
    admin = db_session.query(User).filter_by(email="used@example.com").first()
    account = db_session.query(CommercialAccount).filter_by(organization_id=admin.organization_id).first()
    sub = db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).one()
    sub.status = CommercialSubscriptionStatus.CANCELLED   # trial_ends_at stays set
    db_session.commit()

    with pytest.raises(BadRequestException):
        start_trial(db=db_session, current_user=_fake_billing_admin(admin.organization_id))
