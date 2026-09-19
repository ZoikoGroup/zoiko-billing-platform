"""
tests/ai_assistant/test_qa_webhook_contract.py
----------------------------------------------
QA traceability coverage for the webhook contract cluster of the
Zoiko Billing Chatbot Combined QA Test Pack v1.0:

  Q32  Webhook payloads avoid embedding sensitive financial detail beyond a
       fetch trigger (minimization).
  Q33  Out-of-order webhook delivery handled without a double effect
       (replay / redelivery cannot re-clear an already-terminal payment).

All tests are against the Plane 1 (commercial) Stripe webhook service, which
is the documented minimization contract: only event_id + event_type are
persisted (the `payload` column stays NULL); card/financial detail never
reaches this application.
"""

from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from app.modules.commercial.enums import PlatformPaymentStatus
from app.modules.commercial.models import PlatformStripeEvent
from app.modules.commercial.platform_stripe_service import (
    PlatformStripeService,
    _stripe_module,
)
from tests.test_commercial_subscription_management import _org_with_plan
from tests.test_platform_stripe_service import (
    _invoice_and_pending_payment,
    _checkout_completed_event,
)

SETTINGS_PATH = "app.modules.commercial.platform_stripe_service.settings"
STRIPE_MODULE_PATH = "app.modules.commercial.platform_stripe_service._stripe_module"


def _patched_call(db, event):
    """Run handle_webhook_event with a mocked Stripe module that returns the
    given event dict. Returns (service, result) after calling once."""
    svc = PlatformStripeService(db)
    with patch(SETTINGS_PATH) as s:
        s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
        s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
        ms = MagicMock()
        me = MagicMock()
        me.to_dict.return_value = event
        ms.Webhook.construct_event.return_value = me
        with patch(STRIPE_MODULE_PATH, return_value=ms):
            result = svc.handle_webhook_event(b"{}", "t=1,v1=sig")
    return svc, result


class TestWebhookPayloadMinimizationQ32:
    """Q32: the stored webhook ledger must NOT embed sensitive financial
    detail (card data, full account numbers). Plane 1 persists only
    event_id + event_type + status; the `payload` column stays NULL.
    """

    def test_plane1_ledger_does_not_persist_payload(self, db_session):
        org, plan, account = _org_with_plan(db_session, "PWMIN1", "PWMIN1PLAN")
        invoice, payment = _invoice_and_pending_payment(db_session, account)
        event = _checkout_completed_event(
            "evt_min_1", payment.gateway_checkout_session_id, invoice.id
        )
        event["data"]["object"]["payment_method_details"] = {
            "card": {"last4": "4242", "brand": "visa"},
        }
        event["data"]["object"]["receipt_url"] = "https://pay.stripe.com/receipts/full-bank-detail"

        _patched_call(db_session, event)

        row = db_session.query(PlatformStripeEvent).filter_by(stripe_event_id="evt_min_1").one()
        assert row.event_type == "checkout.session.completed"
        # Minimization: the raw data.object (cards, receipt URL) is NOT stored.
        assert row.payload is None
        # Only a fetch trigger (the event id) is retained, not the money detail.
        assert "4242" not in str(row.__dict__)
        assert "receipt_url" not in str(row.__dict__)

    def test_plane1_failure_log_contains_no_request_body(self, db_session):
        org, plan, account = _org_with_plan(db_session, "PWMIN2", "PWMIN2PLAN")
        invoice, payment = _invoice_and_pending_payment(db_session, account)
        event = _checkout_completed_event(
            "evt_min_2", payment.gateway_checkout_session_id, invoice.id
        )

        # First (and only) delivery fails during routing; the error column must
        # capture only the exception string, never the raw request body. The
        # handler records 'failed' then re-raises so Stripe retries.
        svc = PlatformStripeService(db_session)
        with patch.object(svc, "_route_event", side_effect=RuntimeError("boom")):
            with patch(SETTINGS_PATH) as s:
                s.PLATFORM_STRIPE_WEBHOOK_SECRET = "whsec_test"
                s.PLATFORM_STRIPE_SECRET_KEY = "sk_test_x"
                ms = MagicMock()
                me = MagicMock()
                me.to_dict.return_value = event
                ms.Webhook.construct_event.return_value = me
                with patch(STRIPE_MODULE_PATH, return_value=ms):
                    with pytest.raises(RuntimeError, match="boom"):
                        svc.handle_webhook_event(b"SECRET-RAW-BODY", "t=1,v1=sig")
        row = db_session.query(PlatformStripeEvent).filter_by(stripe_event_id="evt_min_2").one()
        assert row.status == "failed"
        assert "SECRET-RAW-BODY" not in (row.error or "")


class TestWebhookOutOfOrderDeliveryQ33:
    """Q33: out-of-order / reordered webhook delivery must not produce a
    double money-moving effect. Replays of an already-terminal event must
    short-circuit; a retried failed event must be processed idempotently.
    """

    def test_replay_of_already_processed_event_no_double_effect(self, db_session):
        org, plan, account = _org_with_plan(db_session, "PWOOO1", "PWOOO1PLAN")
        invoice, payment = _invoice_and_pending_payment(db_session, account)
        event = _checkout_completed_event(
            "evt_ooo_1", payment.gateway_checkout_session_id, invoice.id
        )

        svc, first = _patched_call(db_session, event)
        assert first.get("duplicate") is not True
        db_session.refresh(payment)
        assert payment.status == PlatformPaymentStatus.CLEARED
        cleared_at = payment.cleared_at

        # A redelivery (out-of-order: duplicate arrives after the terminal state)
        # must be short-circuited, not re-cleared.
        svc2, second = _patched_call(db_session, event)
        assert second == {"received": True, "duplicate": True}

        db_session.refresh(payment)
        assert payment.status == PlatformPaymentStatus.CLEARED
        assert payment.cleared_at == cleared_at

        db_session.refresh(invoice)
        assert invoice.paid_amount == payment.amount

    def test_failed_event_retried_is_processed_once(self, db_session):
        """WEB-2: a genuinely failed delivery is reset for retry; the retry
        result must be idempotent (no duplicate money effect)."""
        org, plan, account = _org_with_plan(db_session, "PWOOO2", "PWOOO2PLAN")
        invoice, payment = _invoice_and_pending_payment(db_session, account)
        event = _checkout_completed_event(
            "evt_ooo_2", payment.gateway_checkout_session_id, invoice.id
        )

        # First delivery fails mid-processing.
        db_session.add(PlatformStripeEvent(
            stripe_event_id="evt_ooo_2",
            event_type="checkout.session.completed",
            status="failed",
            error="transient error",
        ))
        db_session.commit()

        # Retry processes it (failed -> processing -> processed).
        svc, result = _patched_call(db_session, event)
        db_session.refresh(payment)
        assert payment.status == PlatformPaymentStatus.CLEARED
        row = db_session.query(PlatformStripeEvent).filter_by(stripe_event_id="evt_ooo_2").one()
        assert row.status == "processed"
