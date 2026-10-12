"""tests/test_plan_change_upgrade_payment.py
------------------------------------------
Self-serve upgrade is pay-first: the Stripe webhook that clears the PLAN_CHANGE
invoice's payment is what actually swaps the plan, and a replay never applies
it twice. Complements test_plan_change_orchestration.py (router/state side).
"""
from unittest.mock import MagicMock, patch

from app.modules.commercial.enums import SubscriptionChangeStatus
from app.modules.commercial.models import (
    CommercialSubscription,
    PlatformInvoice,
    PlatformStripeEvent,
    SubscriptionChange,
)
from app.modules.commercial.org_self_service_router import PlanChangeCommitRequest, commit_plan_change
from app.modules.commercial.platform_payment_service import PlatformPaymentService
from app.modules.commercial.platform_stripe_service import PlatformStripeService
from tests.test_plan_change_orchestration import (
    _fake_billing_admin,
    _org_active_subscription,
    _plan_with_published_version,
    _stub_checkout,
)

SETTINGS_PATH = "app.modules.commercial.platform_stripe_service.settings"
STRIPE_MODULE_PATH = "app.modules.commercial.platform_stripe_service._stripe_module"


def _deliver(db, event):
    with patch(SETTINGS_PATH) as s:
        s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
        s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
        ms = MagicMock()
        me = MagicMock()
        me.to_dict.return_value = event
        ms.Webhook.construct_event.return_value = me
        with patch(STRIPE_MODULE_PATH, return_value=ms):
            return PlatformStripeService(db).handle_webhook_event(b"{}", "t=1,v1=sig")


def test_stripe_payment_of_upgrade_invoice_applies_plan_once(db_session, monkeypatch):
    _stub_checkout(monkeypatch)
    from_plan, _ = _plan_with_published_version(db_session, "WHUFROM", price_amount=50)
    to_plan, _ = _plan_with_published_version(db_session, "WHUTO", price_amount=100)
    org, account, sub = _org_active_subscription(db_session, "WHUORG", from_plan)
    db_session.commit()

    commit_plan_change(
        PlanChangeCommitRequest(target_plan_id=to_plan.id), db=db_session, current_user=_fake_billing_admin(org.id),
    )
    invoice = db_session.query(PlatformInvoice).filter(PlatformInvoice.commercial_subscription_id == sub.id).one()

    # What create_checkout_session_for_invoice records, minus the Stripe call.
    payment = PlatformPaymentService(db_session).record(
        account_id=account.id, actor_id=None, amount=invoice.balance_due,
        currency=invoice.currency, payment_method="card", notes="upgrade checkout",
    )
    payment.gateway_checkout_session_id = "cs_upgrade_1"
    db_session.commit()

    event = {
        "id": "evt_upgrade_1",
        "type": "checkout.session.completed",
        "livemode": False,
        "data": {"object": {
            "id": "cs_upgrade_1",
            "payment_intent": "pi_upgrade_1",
            "metadata": {"platform_invoice_id": str(invoice.id)},
        }},
    }
    result = _deliver(db_session, event)
    assert result["plan_change_applied"]

    db_session.expire_all()
    assert db_session.query(CommercialSubscription).get(sub.id).commercial_plan_id == to_plan.id
    change = db_session.query(SubscriptionChange).filter(SubscriptionChange.commercial_subscription_id == sub.id).one()
    assert change.status == SubscriptionChangeStatus.APPLIED

    # Stripe redelivers: no second apply, no new event row.
    replay = _deliver(db_session, event)
    assert replay.get("duplicate") is True
    assert db_session.query(PlatformStripeEvent).filter(PlatformStripeEvent.stripe_event_id == "evt_upgrade_1").count() == 1


def test_trial_can_buy_a_higher_plan_outright_and_activates_it_on_payment(db_session, monkeypatch):
    from app.modules.auth.models import User
    from app.modules.auth.schemas import RegisterRequest
    from app.modules.auth.service import register_enterprise
    from app.modules.commercial.enums import CommercialSubscriptionStatus, PlatformInvoiceStatus
    from app.modules.commercial.models import CommercialAccount
    from app.modules.commercial.org_self_service_router import TrialConvertRequest, convert_trial_to_paid

    _stub_checkout(monkeypatch)
    _plan_with_published_version(db_session, "essentials", price_amount=49)
    pro, _ = _plan_with_published_version(db_session, "professional", price_amount=149)
    db_session.commit()
    register_enterprise(db_session, RegisterRequest(
        organization="Trial Co", name="Tia Admin", email="tia@trial.example", password="StrongPass123!",
        currency="USD", intended_plan="essentials",
    ))
    admin = db_session.query(User).filter_by(email="tia@trial.example").first()
    account = db_session.query(CommercialAccount).filter_by(organization_id=admin.organization_id).first()
    sub = db_session.query(CommercialSubscription).filter_by(commercial_account_id=account.id).one()
    assert sub.status == CommercialSubscriptionStatus.TRIALING

    route = convert_trial_to_paid(
        TrialConvertRequest(plan_id=pro.id), db=db_session, current_user=_fake_billing_admin(admin.organization_id),
    )
    assert route["status"] == "payment_required" and route["mode"] == "checkout"
    assert float(route["amount"]) == 149.0

    # Nothing changes until the money lands: still the Essentials trial.
    db_session.expire_all()
    sub = db_session.query(CommercialSubscription).get(sub.id)
    assert sub.status == CommercialSubscriptionStatus.TRIALING and sub.plan.plan_code == "essentials"
    # The registration quote's invoice must not be left competing with this one.
    open_invoices = db_session.query(PlatformInvoice).filter(
        PlatformInvoice.commercial_subscription_id == sub.id,
        PlatformInvoice.status == PlatformInvoiceStatus.ISSUED,
    ).all()
    assert len(open_invoices) == 1 and float(open_invoices[0].balance_due) == 149.0

    invoice = open_invoices[0]
    payment = PlatformPaymentService(db_session).record(
        account_id=account.id, actor_id=None, amount=invoice.balance_due,
        currency=invoice.currency, payment_method="card", notes="trial purchase",
    )
    payment.gateway_checkout_session_id = "cs_trialbuy_1"
    db_session.commit()
    event = {
        "id": "evt_trialbuy_1", "type": "checkout.session.completed", "livemode": False,
        "data": {"object": {"id": "cs_trialbuy_1", "payment_intent": "pi_tb_1",
                            "metadata": {"platform_invoice_id": str(invoice.id)}}},
    }
    with patch("app.modules.commercial.platform_stripe_service.notify_trial_converted_after_commit", create=True), \
            patch("app.modules.commercial.trial_conversion_service.notify_trial_converted_after_commit"):
        result = _deliver(db_session, event)
    assert result["plan_change_applied"] and result["trial_converted"] == sub.id

    db_session.expire_all()
    sub = db_session.query(CommercialSubscription).get(sub.id)
    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    assert sub.plan.plan_code == "professional"
    assert sub.trial_ends_at is None and sub.current_period_end is not None
