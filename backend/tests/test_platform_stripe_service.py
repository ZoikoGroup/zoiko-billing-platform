"""tests/test_platform_stripe_service.py
------------------------------------------
Plane 1 (Zoiko-billing-the-org) Stripe Checkout + webhook flow — PAY-01/PAY-02
proof: signature verification, environment/livemode check, and idempotency
(replay cannot duplicate a money-moving effect). Previously zero coverage.
"""
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from app.core.exceptions import BadRequestException
from app.modules.commercial.enums import PlatformPaymentStatus
from app.modules.commercial.models import PlatformInvoice, PlatformPayment, PlatformStripeEvent
from app.modules.commercial.platform_payment_service import PlatformPaymentService
from app.modules.commercial.platform_stripe_service import PlatformStripeService
from tests.test_commercial_subscription_management import _org_with_plan

SETTINGS_PATH = "app.modules.commercial.platform_stripe_service.settings"
STRIPE_MODULE_PATH = "app.modules.commercial.platform_stripe_service._stripe_module"


def _invoice_and_pending_payment(db, account, session_id="cs_test_123", amount="100.00"):
    invoice = PlatformInvoice(
        commercial_account_id=account.id,
        invoice_number="PINV-0001",
        currency="USD",
        total_amount=Decimal(amount),
        balance_due=Decimal(amount),
    )
    db.add(invoice)
    db.flush()

    payment = PlatformPaymentService(db).record(
        account_id=account.id, actor_id=None, amount=Decimal(amount),
        currency="USD", payment_method="card", notes="test checkout",
    )
    payment.gateway_checkout_session_id = session_id
    db.commit()
    return invoice, payment


def _checkout_completed_event(event_id, session_id, invoice_id, livemode=False):
    return {
        "id": event_id,
        "type": "checkout.session.completed",
        "livemode": livemode,
        "data": {
            "object": {
                "id": session_id,
                "payment_intent": f"pi_{session_id}",
                "metadata": {"platform_invoice_id": str(invoice_id)},
            }
        },
    }


class TestWebhookSignatureAndEnvironment:
    def test_invalid_signature_rejected(self, db_session):
        with patch(SETTINGS_PATH) as s:
            s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
            s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
            ms = MagicMock()
            ms.Webhook.construct_event.side_effect = Exception("bad signature")
            with patch(STRIPE_MODULE_PATH, return_value=ms):
                with pytest.raises(BadRequestException, match="Invalid Stripe webhook signature"):
                    PlatformStripeService(db_session).handle_webhook_event(b"{}", "t=1,v1=badsig")
        # No event row should have been created for a payload that never
        # verified — nothing here should be recorded as processed.
        assert db_session.query(PlatformStripeEvent).count() == 0

    def test_missing_webhook_secret_rejected(self, db_session):
        with patch(SETTINGS_PATH) as s:
            s.PLATFORM_STRIPE_WEBHOOK_SECRET = ""
            with pytest.raises(BadRequestException, match="not configured"):
                PlatformStripeService(db_session).handle_webhook_event(b"{}", "t=1,v1=sig")

    def test_livemode_mismatch_rejected(self, db_session):
        """A validly-signed event for the wrong environment (e.g. a live
        event replayed against a test-configured deployment) must be
        rejected — a valid signature alone doesn't prove it's for *this*
        environment."""
        org, plan, account = _org_with_plan(db_session, "PSTRIPE1", "PSTRIPE1PLAN")
        invoice, payment = _invoice_and_pending_payment(db_session, account)

        event = _checkout_completed_event("evt_live_1", payment.gateway_checkout_session_id, invoice.id, livemode=True)
        with patch(SETTINGS_PATH) as s:
            s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
            s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"  # test-mode key, event claims livemode=True
            ms = MagicMock()
            me = MagicMock()
            me.to_dict.return_value = event
            ms.Webhook.construct_event.return_value = me
            with patch(STRIPE_MODULE_PATH, return_value=ms):
                with pytest.raises(BadRequestException, match="environment mismatch"):
                    PlatformStripeService(db_session).handle_webhook_event(b"{}", "t=1,v1=sig")

        db_session.refresh(payment)
        assert payment.status != PlatformPaymentStatus.CLEARED
        assert db_session.query(PlatformStripeEvent).count() == 0


class TestWebhookIdempotency:
    def test_duplicate_webhook_delivery_does_not_duplicate_payment_effect(self, db_session):
        """The core PAY-01 proof: Stripe redelivers events, and a replay of
        an already-processed event must not clear/allocate the payment a
        second time."""
        org, plan, account = _org_with_plan(db_session, "PSTRIPE2", "PSTRIPE2PLAN")
        invoice, payment = _invoice_and_pending_payment(db_session, account)
        event = _checkout_completed_event("evt_dup_1", payment.gateway_checkout_session_id, invoice.id)

        def _call():
            with patch(SETTINGS_PATH) as s:
                s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
                s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
                ms = MagicMock()
                me = MagicMock()
                me.to_dict.return_value = event
                ms.Webhook.construct_event.return_value = me
                with patch(STRIPE_MODULE_PATH, return_value=ms):
                    return PlatformStripeService(db_session).handle_webhook_event(b"{}", "t=1,v1=sig")

        first = _call()
        assert first.get("duplicate") is not True
        db_session.refresh(payment)
        assert payment.status == PlatformPaymentStatus.CLEARED
        first_cleared_at = payment.cleared_at

        second = _call()
        assert second == {"received": True, "duplicate": True}

        db_session.refresh(payment)
        assert payment.status == PlatformPaymentStatus.CLEARED
        assert payment.cleared_at == first_cleared_at  # untouched by the replay

        db_session.refresh(invoice)
        # Exactly one allocation from exactly one clearing — not two.
        assert invoice.paid_amount == payment.amount
        assert db_session.query(PlatformStripeEvent).filter_by(stripe_event_id="evt_dup_1").count() == 1

    def test_stripe_event_dedup_short_circuits_before_routing(self, db_session):
        """Narrower unit-level proof alongside the end-to-end test above:
        once an event id is recorded (status != 'failed'), a redelivery
        must short-circuit before `_route_event` runs at all."""
        db_session.add(PlatformStripeEvent(stripe_event_id="evt_dedup", event_type="checkout.session.completed", status="processed"))
        db_session.commit()

        event = {"id": "evt_dedup", "type": "checkout.session.completed", "livemode": False, "data": {"object": {}}}
        with patch(SETTINGS_PATH) as s:
            s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
            s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
            ms = MagicMock()
            me = MagicMock()
            me.to_dict.return_value = event
            ms.Webhook.construct_event.return_value = me
            with patch(STRIPE_MODULE_PATH, return_value=ms):
                svc = PlatformStripeService(db_session)
                with patch.object(svc, "_route_event") as route:
                    result = svc.handle_webhook_event(b"{}", "t=1,v1=sig")
        assert result == {"received": True, "duplicate": True}
        route.assert_not_called()
