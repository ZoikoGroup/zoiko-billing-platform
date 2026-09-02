"""modules/commercial/platform_stripe_service.py
--------------------------------------------------
Plane 1 — Stripe Checkout / webhook integration for Zoiko-billing-the-org.

Uses Zoiko's OWN Stripe account (PLATFORM_STRIPE_SECRET_KEY) — never a
tenant's StripeConnectedAccount, never Plane 2's STRIPE_* settings. Every
public method raises BadRequestException with a clear message when Platform
Stripe is not configured, matching billing/services/stripe_service.py's
degrade pattern — but this module imports NOTHING from billing/.

Webhook idempotency uses PlatformStripeEvent (separate table/endpoint/secret
from Plane 2's stripe_events/STRIPE_WEBHOOK_SECRET/webhooks/stripe route).

The stripe package is imported lazily so the rest of the app (and the test
suite) never fails to import this module when the package is missing.
"""

import logging
import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException
from app.modules.commercial.enums import (
    CommercialSubscriptionStatus,
    PlatformInvoiceStatus,
    PlatformPaymentStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialSubscription,
    PlatformInvoice,
    PlatformPayment,
    PlatformStripeEvent,
)
from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
from app.modules.commercial.platform_payment_service import PlatformPaymentService
from app.modules.commercial.service import CommercialSubscriptionService

logger = logging.getLogger("zoiko_billing.commercial.stripe")

_NON_PAYABLE_INVOICE_STATUSES = {
    PlatformInvoiceStatus.DRAFT,
    PlatformInvoiceStatus.PAID,
    PlatformInvoiceStatus.VOIDED,
    PlatformInvoiceStatus.CREDITED,
}


def _to_cents(amount) -> int:
    value = Decimal(str(amount))
    if value < 0:
        raise BadRequestException("Amount cannot be negative")
    return int((value * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))


def _expected_livemode() -> bool:
    """Whether this deployment is configured for Stripe *live* mode, inferred
    from the configured secret key's prefix (Stripe's own convention:
    sk_live_... vs sk_test_...). There's no separate "environment" setting to
    check against — the key IS the environment here."""
    return settings.PLATFORM_STRIPE_SECRET_KEY.startswith("sk_live_")


def _stripe_module():
    try:
        import stripe
    except ImportError:
        raise BadRequestException(
            "The 'stripe' package is not installed. Add stripe to requirements.txt and reinstall."
        )
    if not settings.PLATFORM_STRIPE_SECRET_KEY:
        raise BadRequestException(
            "Platform Stripe is not configured. Set PLATFORM_STRIPE_SECRET_KEY in the environment."
        )
    stripe.api_key = settings.PLATFORM_STRIPE_SECRET_KEY
    return stripe


class PlatformStripeService:
    def __init__(self, db: Session):
        self.db = db

    # ── Customer ─────────────────────────────────────────────────────────

    def get_or_create_customer(self, account: CommercialAccount) -> str:
        """Reuse the org's Stripe Customer id if one exists; otherwise create
        a new Customer under Zoiko's own Stripe account and store it."""
        if account.stripe_customer_id:
            return account.stripe_customer_id

        stripe = _stripe_module()
        org = account.organization
        org_name = org.organization_name if org else f"CommercialAccount {account.id}"

        from app.modules.auth.models import User

        admin = (
            self.db.query(User)
            .filter(User.organization_id == account.organization_id, User.role == "org_admin")
            .first()
        )
        customer = stripe.Customer.create(
            name=org_name,
            email=admin.email if admin else None,
            metadata={"commercial_account_id": str(account.id)},
            idempotency_key=f"pcust-{account.id}-{uuid.uuid4().hex}",
        )
        account.stripe_customer_id = customer.id
        self.db.flush()
        return customer.id

    # ── Checkout ─────────────────────────────────────────────────────────

    def create_checkout_session_for_invoice(self, invoice: PlatformInvoice) -> Dict[str, Any]:
        """Create a Checkout Session for an invoice's balance_due, off the
        public invoice link. Records a PENDING PlatformPayment carrying the
        session id — the webhook is what actually clears it (§B4: an
        org never gets credit for a payment that hasn't been confirmed)."""
        stripe = _stripe_module()

        account = invoice.account
        if account is None:
            raise BadRequestException("Invoice has no associated commercial account")
        if invoice.status in _NON_PAYABLE_INVOICE_STATUSES:
            raise BadRequestException(f"Invoice cannot be paid in status {invoice.status.value}")
        if invoice.balance_due is None or invoice.balance_due <= 0:
            raise BadRequestException("Invoice has no balance due")

        customer_id = self.get_or_create_customer(account)

        metadata = {"platform_invoice_id": str(invoice.id)}
        base_url = settings.FRONTEND_URL.rstrip("/")
        session = stripe.checkout.Session.create(
            mode="payment",
            customer=customer_id,
            line_items=[{
                "quantity": 1,
                "price_data": {
                    "currency": (invoice.currency or "USD").lower(),
                    "unit_amount": _to_cents(invoice.balance_due),
                    "product_data": {"name": f"Invoice {invoice.invoice_number}"},
                },
            }],
            success_url=f"{base_url}/platform-invoice/{invoice.public_token}/success",
            cancel_url=f"{base_url}/platform-invoice/{invoice.public_token}",
            metadata=metadata,
            payment_intent_data={"metadata": metadata},
            idempotency_key=f"pcs-{invoice.id}-{uuid.uuid4().hex}",
        )

        payment = PlatformPaymentService(self.db).record(
            account_id=account.id,
            actor_id=None,
            amount=invoice.balance_due,
            currency=invoice.currency,
            payment_method="card",
            notes=f"Stripe Checkout session for invoice {invoice.invoice_number}",
        )
        payment.gateway_checkout_session_id = session.id
        self.db.commit()

        return {"checkout_url": session.url, "session_id": session.id}

    # ── Webhook ──────────────────────────────────────────────────────────

    def handle_webhook_event(self, payload: bytes, sig_header: str) -> Dict[str, Any]:
        if not settings.PLATFORM_STRIPE_WEBHOOK_SECRET:
            raise BadRequestException(
                "Platform Stripe webhooks are not configured (PLATFORM_STRIPE_WEBHOOK_SECRET)"
            )
        stripe = _stripe_module()
        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, settings.PLATFORM_STRIPE_WEBHOOK_SECRET,
            )
        except Exception as e:
            raise BadRequestException(f"Invalid Stripe webhook signature: {e}")

        event = event.to_dict() if hasattr(event, "to_dict") else event

        # Environment check (PAY-01): Plane 1 uses a single, non-Connect
        # Stripe account (unlike Plane 2's Connect flow, which resolves the
        # tenant via the event's connected-account envelope) — there's no
        # "account id" to check here, only test vs. live. Reject a
        # live-mode event delivered to a test-configured deployment (or
        # vice versa): a valid signature only proves the payload came from
        # *some* Stripe webhook endpoint secret we hold, not that it's for
        # the environment this process is actually running as.
        event_livemode = event.get("livemode")
        if event_livemode is not None and event_livemode != _expected_livemode():
            raise BadRequestException(
                f"Stripe webhook environment mismatch: event livemode={event_livemode}, "
                f"this deployment is configured for livemode={_expected_livemode()}"
            )

        event_id = event.get("id")
        event_type = event.get("type")
        data_object = (event.get("data") or {}).get("object") or {}

        record = (
            self.db.query(PlatformStripeEvent)
            .filter(PlatformStripeEvent.stripe_event_id == event_id)
            .first()
        )
        if record is not None and record.status != "failed":
            return {"received": True, "duplicate": True}

        if record is None:
            record = PlatformStripeEvent(
                stripe_event_id=event_id, event_type=event_type, status="processing",
            )
            self.db.add(record)
        else:
            record.status = "processing"
            record.error = None
        self.db.commit()

        try:
            result = self._route_event(event_type, data_object)
            record.status = "processed"
            record.processed_at = datetime.utcnow()
            self.db.commit()
            return {"received": True, **result}
        except Exception as exc:
            self.db.rollback()
            record = (
                self.db.query(PlatformStripeEvent)
                .filter(PlatformStripeEvent.stripe_event_id == event_id)
                .first()
            )
            if record is not None:
                record.status = "failed"
                record.error = str(exc)[:2000]
                self.db.commit()
            logger.error(
                "Platform Stripe webhook handler failed for event %s (%s): %s",
                event_id, event_type, exc, exc_info=True,
            )
            raise

    def _route_event(self, event_type: str, data_object: dict) -> Dict[str, Any]:
        if event_type == "checkout.session.completed":
            return self._handle_checkout_completed(data_object)
        if event_type in ("checkout.session.expired", "payment_intent.payment_failed"):
            return self._handle_payment_failed(data_object)
        return {"action": "ignored", "event_type": event_type}

    def _find_pending_payment(self, data_object: dict) -> Optional[PlatformPayment]:
        session_id = data_object.get("id")
        payment_intent_id = data_object.get("payment_intent") or (
            data_object.get("id") if data_object.get("object") == "payment_intent" else None
        )
        return (
            self.db.query(PlatformPayment)
            .filter(
                or_(
                    PlatformPayment.gateway_checkout_session_id.in_(
                        [v for v in (session_id, payment_intent_id) if v]
                    ),
                    PlatformPayment.gateway_payment_intent_id.in_(
                        [v for v in (session_id, payment_intent_id) if v]
                    ),
                )
            )
            .first()
        )

    def _handle_checkout_completed(self, data_object: dict) -> Dict[str, Any]:
        payment = self._find_pending_payment(data_object)
        if payment is None:
            return {"action": "ignored", "reason": "no matching PlatformPayment for session"}
        if payment.status == PlatformPaymentStatus.CLEARED:
            return {"action": "already_recorded", "payment_id": payment.id}

        payment.status = PlatformPaymentStatus.CLEARED
        payment.cleared_at = datetime.utcnow()
        payment.gateway_payment_intent_id = data_object.get("payment_intent") or payment.gateway_payment_intent_id
        payment.transaction_id = data_object.get("payment_intent") or payment.transaction_id
        self.db.flush()

        # First-ever cleared payment for this account gates activation of a
        # PENDING self-serve subscription (§B4 — entitlement must not race
        # ahead of payment). Counted BEFORE allocation touches anything else.
        cleared_count = (
            self.db.query(PlatformPayment)
            .filter(
                PlatformPayment.commercial_account_id == payment.commercial_account_id,
                PlatformPayment.status == PlatformPaymentStatus.CLEARED,
            )
            .count()
        )

        metadata = data_object.get("metadata") or {}
        invoice_id = metadata.get("platform_invoice_id")
        if invoice_id:
            invoice = (
                self.db.query(PlatformInvoice)
                .filter(PlatformInvoice.id == int(invoice_id))
                .first()
            )
            if invoice is not None and invoice.balance_due and invoice.balance_due > 0:
                PlatformPaymentService(self.db).allocate(
                    payment_id=payment.id,
                    invoice_id=invoice.id,
                    amount=min(payment.amount, invoice.balance_due),
                    actor_id=None,
                )

        if cleared_count == 1:
            # PENDING: never-activated self-serve subscription paying for
            # the first time. TRIALING: still inside the free-trial window and
            # paying (either converts to the paid plan or settles the first
            # invoice ahead of expiry) — activation must not wait for the
            # trial to lapse. SUSPENDED: same, but the free trial expired
            # before they paid (commercial/tasks/trial_expiry.py) — paying
            # now must still reinstate it, not leave it stuck suspended.
            subscription = (
                self.db.query(CommercialSubscription)
                .filter(
                    CommercialSubscription.commercial_account_id == payment.commercial_account_id,
                    CommercialSubscription.status.in_([
                        CommercialSubscriptionStatus.PENDING,
                        CommercialSubscriptionStatus.TRIALING,
                        CommercialSubscriptionStatus.SUSPENDED,
                    ]),
                )
                .first()
            )
            if subscription is not None:
                CommercialSubscriptionService(self.db).transition(
                    subscription, CommercialSubscriptionStatus.ACTIVE,
                )

        return {"action": "payment_recorded", "payment_id": payment.id}

    def _handle_payment_failed(self, data_object: dict) -> Dict[str, Any]:
        payment = self._find_pending_payment(data_object)
        if payment is None:
            return {"action": "ignored", "reason": "no matching PlatformPayment"}
        if payment.status == PlatformPaymentStatus.CLEARED:
            return {"action": "ignored", "reason": "already cleared"}

        payment.status = PlatformPaymentStatus.FAILED
        payment.failure_reason = data_object.get("last_payment_error", {}).get("message") if isinstance(
            data_object.get("last_payment_error"), dict
        ) else "Checkout session expired or payment failed"
        self.db.flush()
        return {"action": "payment_failed", "payment_id": payment.id}
