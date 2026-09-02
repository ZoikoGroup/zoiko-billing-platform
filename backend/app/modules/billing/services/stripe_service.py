"""modules/billing/services/stripe_service.py

Stripe Checkout / PaymentIntents / webhook / subscription integration for the
billing module. Every public method raises BadRequestException with a clear
message when Stripe is not configured (no STRIPE_SECRET_KEY), so callers can
degrade gracefully instead of crashing.

The webhook path is the source of truth for gateway money movement. Event ids
are recorded in the stripe_events ledger (unique constraint) so re-delivered
webhooks are idempotent — the original outcome is returned without re-running
side effects.

The stripe package is imported lazily so the rest of the app (and the test
suite) never fails to import this module when the package is missing.
"""

import logging
import uuid
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException
from app.modules.billing.models import (
    BillingAuditAction,
    BillingCustomer,
    BillingSubscriptionStatus,
    Dispute,
    DisputeStatus,
    IntegrationConnectionStatus,
    Invoice,
    InvoiceStatus,
    NumberFormat,
    Payment,
    PaymentGatewayType,
    PaymentStatus,
    PaymentType,
    Refund,
    RefundMethod,
    RefundSource,
    RefundStatus,
    RefundStatusHistory,
    RefundType,
    SequenceReset,
    StripeConnectedAccount,
    StripeEvent,
    Subscription,
    SubscriptionEvent,
)
from app.modules.billing.utils.currency_utils import VALID_CURRENCY_CODES
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.document_sequence import DocumentSequenceService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.payment_service import PaymentService
from app.modules.billing.services.refund_service import RefundService
from app.modules.billing.services.stripe_connect_service import (
    _derive_status,
    _resolve_environment,
    configure_stripe_runtime,
    resolve_connected_account,
)
from app.modules.billing.services.subscription_service import SubscriptionService

logger = logging.getLogger("zoiko_billing")

SYSTEM_ACTOR = None


def _to_cents(amount) -> int:
    value = Decimal(str(amount))
    if value < 0:
        raise BadRequestException("Amount cannot be negative")
    return int((value * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))


def _from_cents(cents) -> Decimal:
    return (Decimal(str(cents)) / Decimal("100")).quantize(Decimal("0.01"))


def _stripe_module():
    try:
        import stripe
    except ImportError:
        raise BadRequestException(
            "The 'stripe' package is not installed. Add stripe to requirements.txt and reinstall."
        )
    if not settings.STRIPE_SECRET_KEY:
        raise BadRequestException(
            "Stripe is not configured. Set STRIPE_SECRET_KEY in the environment."
        )
    stripe.api_key = settings.STRIPE_SECRET_KEY
    # Transport hardening: bounded retries (with SDK-managed idempotency keys
    # for automatic transport retries) + per-attempt timeout. See
    # stripe_connect_service.configure_stripe_runtime.
    configure_stripe_runtime(stripe)
    return stripe


def _translate_stripe_error(e: Exception) -> BadRequestException:
    """Convert a Stripe SDK error into a safe, client-presentable error.

    Never leaks API keys, request ids, or internal stack details; keeps the
    human-readable message Stripe provides when available."""
    message = getattr(e, "user_message", None) or str(e) or "Stripe request failed"
    code = getattr(e, "code", None)
    if code:
        return BadRequestException(f"Stripe error ({code}): {message}")
    return BadRequestException(f"Stripe error: {message}")


class StripeService:
    def __init__(self, db: Session):
        self.db = db
        self.customer_service = CustomerService(db)
        self.invoice_service = InvoiceService(db)
        self.payment_service = PaymentService(db)
        self.subscription_service = SubscriptionService(db)
        self.refund_service = RefundService(db)
        self.audit = BillingAuditService(db)
        self.sequence_service = DocumentSequenceService(db)

    # ── Config ─────────────────────────────────────────────────────────────

    @staticmethod
    def is_configured() -> bool:
        return bool(settings.STRIPE_SECRET_KEY)

    @staticmethod
    def publishable_key() -> Optional[str]:
        return settings.STRIPE_PUBLISHABLE_KEY or None

    # ── Connected-account routing (GAP-1) ──────────────────────────────────
    #
    # CONNECTED ACCOUNT CONTEXT operations (tenant is merchant of record):
    #   ensure_customer, create_checkout_session, create_payment_intent,
    #   list_payment_methods, create_stripe_subscription,
    #   cancel_stripe_subscription, create_stripe_refund.
    # Each resolves the tenant's ACTIVE connected account server-side and
    # passes stripe_account=<connected_account_id> on EVERY Stripe call.
    #
    # PLATFORM CONTEXT operations (no stripe_account header, by design):
    #   OAuth token exchange + Account.retrieve in StripeConnectService
    #   (complete_oauth / sync_status) — these read/act as the platform on
    #   the account object itself; adding a Stripe-Account header there would
    #   change their semantics.

    def _connected_account_id(self, organization_id: int) -> str:
        """Resolve the tenant's ACTIVE connected account id from trusted DB
        data (organization_id → StripeConnectedAccount). Fails safely — raises
        BEFORE any outbound Stripe request — when no active connection exists."""
        return resolve_connected_account(self.db, organization_id).connected_account_id

    # ── Customers ──────────────────────────────────────────────────────────

    def ensure_customer(self, organization_id: int, customer_id: int, created_by: Optional[int] = None) -> BillingCustomer:
        connected_account_id = self._connected_account_id(organization_id)
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if customer.stripe_customer_id:
            stripe = _stripe_module()
            try:
                stripe.Customer.retrieve(
                    customer.stripe_customer_id,
                    stripe_account=connected_account_id,
                )
                return customer
            except Exception:
                logger.warning(
                    "[stripe] Customer %s (stripe=%s) no longer exists upstream; recreating",
                    customer.id, customer.stripe_customer_id,
                )
                customer.stripe_customer_id = None
        stripe = _stripe_module()
        name = customer.company_name or customer.display_name or customer.customer_code
        try:
            created = stripe.Customer.create(
                name=name,
                email=customer.email or None,
                metadata={
                    "organization_id": str(organization_id),
                    "customer_id": str(customer.id),
                    "customer_code": customer.customer_code,
                },
                stripe_account=connected_account_id,
            )
        except Exception as e:
            if isinstance(e, BadRequestException):
                raise
            raise _translate_stripe_error(e)
        customer.stripe_customer_id = created.id
        self.db.commit()
        self.db.refresh(customer)
        self.audit.log(
            organization_id, created_by, BillingAuditAction.UPDATE,
            "BillingCustomer", customer.id,
            new_values={"stripe_customer_id": created.id},
        )
        return customer

    # ── Checkout / PaymentIntents ──────────────────────────────────────────

    def _validate_invoice_payable(self, invoice: Invoice) -> None:
        if invoice.status in (InvoiceStatus.PAID, InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED):
            raise BadRequestException(f"Cannot collect payment for a {invoice.status.value} invoice")
        balance = Decimal(str(invoice.balance_due if invoice.balance_due is not None else invoice.total_amount or 0))
        if balance <= 0:
            raise BadRequestException("Invoice has no outstanding balance")

    @staticmethod
    def _resolve_and_validate_currency(invoice_currency: Optional[str]) -> str:
        """Fail fast, locally, on an unsupported currency code rather than
        letting Stripe's API reject it after we've already created upstream
        state (a Customer, a Checkout Session, etc.)."""
        currency = (invoice_currency or settings.STRIPE_CURRENCY_DEFAULT).lower()
        if currency.upper() not in VALID_CURRENCY_CODES:
            raise BadRequestException(f"Unsupported currency code: {currency.upper()}")
        return currency

    def _require_payment_attempts_enabled(self) -> None:
        """ZB-SA-CMD-003 §9.2 — 'Pause automatic payment attempts' circuit
        breaker. Gates NEW platform-initiated captures only; the Stripe
        webhook handlers deliberately do NOT call this, because in-flight
        processor activity must not be canceled by a breaker."""
        from app.core.exceptions import BadRequestException
        from app.modules.super_admin.kill_switch_service import (
            TENANT_PAYMENT_ATTEMPTS,
            BillingBlockedError,
            BillingKillSwitchService,
        )

        try:
            BillingKillSwitchService(self.db).require_enabled(TENANT_PAYMENT_ATTEMPTS)
        except BillingBlockedError as exc:
            raise BadRequestException(str(exc))

    def create_checkout_session(
        self,
        organization_id: int,
        invoice_id: int,
        success_url: str,
        cancel_url: str,
        created_by: Optional[int] = None,
    ) -> Dict[str, Any]:
        self._require_payment_attempts_enabled()
        # Fail-safe gate FIRST: never touch Stripe (or even the customer
        # record) unless this tenant has an ACTIVE connected account.
        connected_account_id = self._connected_account_id(organization_id)
        stripe = _stripe_module()
        invoice = self.invoice_service.get_invoice(invoice_id, organization_id)
        self._validate_invoice_payable(invoice)

        # Application-level idempotency for Checkout Sessions: if a previously
        # created session for this invoice is still open, hand back the SAME
        # session instead of minting a duplicate payable link (double-click /
        # retry safety).  Expired or completed sessions fall through to a new
        # creation — Checkout Sessions are single-use by design.
        if invoice.stripe_checkout_session_id:
            try:
                existing_session = stripe.checkout.Session.retrieve(
                    invoice.stripe_checkout_session_id,
                    stripe_account=connected_account_id,
                )
                if getattr(existing_session, "status", None) == "open":
                    self.audit.log(
                        organization_id, created_by, BillingAuditAction.SEND, "Invoice", invoice_id,
                        new_values={"checkout_url": existing_session.url, "reused_open_session": True},
                    )
                    return {
                        "checkout_url": existing_session.url,
                        "session_id": existing_session.id,
                        "invoice_id": invoice_id,
                        "invoice_number": invoice.invoice_number,
                        "reused": True,
                    }
            except Exception:
                logger.info(
                    "[stripe] Stored checkout session %s is no longer retrievable; creating a new one",
                    invoice.stripe_checkout_session_id,
                )

        customer = self.ensure_customer(organization_id, invoice.customer_id, created_by)
        currency = self._resolve_and_validate_currency(invoice.currency)

        items = self.invoice_service.list_items(invoice_id, organization_id)
        line_items = []
        for item in items:
            total = Decimal(str(item.total or 0))
            if total <= 0:
                continue
            description = (item.description or "")[:134]
            line_items.append({
                "quantity": 1,
                "price_data": {
                    "currency": currency,
                    "unit_amount": _to_cents(total),
                    "product_data": {"name": description or "Invoice item"},
                },
            })
        if not line_items:
            balance = invoice.balance_due if invoice.balance_due is not None else invoice.total_amount
            line_items.append({
                "quantity": 1,
                "price_data": {
                    "currency": currency,
                    "unit_amount": _to_cents(balance or 0),
                    "product_data": {"name": f"Invoice {invoice.invoice_number}"},
                },
            })

        payment_method_types = [t.strip() for t in settings.STRIPE_PAYMENT_METHOD_TYPES.split(",") if t.strip()] or ["card"]
        metadata = {
            "organization_id": str(organization_id),
            "invoice_id": str(invoice_id),
            "invoice_number": invoice.invoice_number,
        }
        session = stripe.checkout.Session.create(
            mode="payment",
            customer=customer.stripe_customer_id,
            line_items=line_items,
            success_url=success_url,
            cancel_url=cancel_url,
            payment_method_types=payment_method_types,
            billing_address_collection=settings.STRIPE_BILLING_ADDRESS_COLLECTION,
            metadata=metadata,
            payment_intent_data={"metadata": metadata},
            # Idempotency policy: a fresh key per logical creation (uuid) so a
            # transport-level retry inside the SDK reuses it (no duplicate
            # sessions from network blips), while a deliberate user retry
            # after the open-session reuse check above legitimately mints the
            # next session.
            idempotency_key=f"cs-{organization_id}-{invoice_id}-{uuid.uuid4().hex}",
            stripe_account=connected_account_id,
        )
        invoice.stripe_checkout_session_id = session.id
        self.db.commit()
        self.db.refresh(invoice)
        self.audit.log(
            organization_id, created_by, BillingAuditAction.SEND, "Invoice", invoice_id,
            new_values={"stripe_checkout_session_id": session.id, "checkout_url": session.url},
        )
        return {
            "checkout_url": session.url,
            "session_id": session.id,
            "invoice_id": invoice_id,
            "invoice_number": invoice.invoice_number,
        }

    def create_payment_intent(
        self,
        organization_id: int,
        invoice_id: int,
        payment_method_id: Optional[str] = None,
        created_by: Optional[int] = None,
    ) -> Dict[str, Any]:
        self._require_payment_attempts_enabled()
        connected_account_id = self._connected_account_id(organization_id)
        stripe = _stripe_module()
        invoice = self.invoice_service.get_invoice(invoice_id, organization_id)
        self._validate_invoice_payable(invoice)
        customer = self.ensure_customer(organization_id, invoice.customer_id, created_by)
        balance = Decimal(str(invoice.balance_due if invoice.balance_due is not None else invoice.total_amount or 0))
        currency = self._resolve_and_validate_currency(invoice.currency)
        metadata = {
            "organization_id": str(organization_id),
            "invoice_id": str(invoice_id),
            "invoice_number": invoice.invoice_number,
        }
        kwargs: Dict[str, Any] = {
            "amount": _to_cents(balance),
            "currency": currency,
            "customer": customer.stripe_customer_id,
            "metadata": metadata,
            "description": f"Invoice {invoice.invoice_number}",
            # Deterministic per business identity: an application-level retry
            # (timeout, worker re-run) with the same org+invoice returns the
            # SAME PaymentIntent instead of creating a duplicate chargeable
            # intent.  Transport retries inside the SDK reuse it as well.
            "idempotency_key": f"pi-{organization_id}-{invoice_id}",
            "stripe_account": connected_account_id,
        }
        if payment_method_id:
            kwargs["payment_method"] = payment_method_id
        try:
            payment_intent = stripe.PaymentIntent.create(**kwargs)
        except Exception as e:
            if isinstance(e, BadRequestException):
                raise
            raise _translate_stripe_error(e)
        invoice.stripe_payment_intent_id = payment_intent.id
        self.db.commit()
        self.db.refresh(invoice)
        self.audit.log(
            organization_id, created_by, BillingAuditAction.SEND, "Invoice", invoice_id,
            new_values={"stripe_payment_intent_id": payment_intent.id},
        )
        return {
            "payment_intent_id": payment_intent.id,
            "client_secret": payment_intent.client_secret,
            "publishable_key": settings.STRIPE_PUBLISHABLE_KEY or "",
            "amount": str(balance),
            "currency": currency,
            "invoice_id": invoice_id,
        }

    def list_payment_methods(self, organization_id: int, customer_id: int) -> Dict[str, Any]:
        connected_account_id = self._connected_account_id(organization_id)
        stripe = _stripe_module()
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if not customer.stripe_customer_id:
            return {"customer_id": customer_id, "stripe_customer_id": None, "payment_methods": []}
        try:
            methods = stripe.PaymentMethod.list(
                customer=customer.stripe_customer_id,
                type="card",
                stripe_account=connected_account_id,
            )
        except Exception as e:
            raise _translate_stripe_error(e)
        return {
            "customer_id": customer_id,
            "stripe_customer_id": customer.stripe_customer_id,
            "payment_methods": [
                {
                    "id": m.id,
                    "type": m.type,
                    "card_brand": (m.card or {}).get("brand"),
                    "last4": (m.card or {}).get("last4"),
                    "exp_month": (m.card or {}).get("exp_month"),
                    "exp_year": (m.card or {}).get("exp_year"),
                }
                for m in methods.data
            ],
        }

    # ── Subscriptions ──────────────────────────────────────────────────────

    def create_stripe_subscription(
        self,
        organization_id: int,
        subscription_id: int,
        price_id: Optional[str] = None,
        created_by: Optional[int] = None,
    ) -> Dict[str, Any]:
        connected_account_id = self._connected_account_id(organization_id)
        stripe = _stripe_module()
        sub = self.subscription_service.get_subscription(subscription_id, organization_id)
        if sub.stripe_subscription_id:
            raise BadRequestException(
                f"Subscription already linked to Stripe ({sub.stripe_subscription_id})"
            )
        price_id = price_id or sub.stripe_price_id
        if not price_id:
            raise BadRequestException(
                "A Stripe price_id is required. Pass price_id or set subscription.stripe_price_id first."
            )
        customer = self.ensure_customer(organization_id, sub.customer_id, created_by)
        plan = sub.plan
        params: Dict[str, Any] = {
            "customer": customer.stripe_customer_id,
            "items": [{"price": price_id, "quantity": max(int(sub.quantity or 1), 1)}],
            "metadata": {
                "organization_id": str(organization_id),
                "subscription_id": str(subscription_id),
                "subscription_number": sub.subscription_number,
            },
            # Deterministic per business identity — a retried link attempt
            # re-attaches the SAME Stripe subscription instead of creating a
            # second billing relationship.
            "idempotency_key": f"sub-{organization_id}-{subscription_id}",
            "stripe_account": connected_account_id,
        }
        if plan and getattr(plan, "trial_days", 0) and not sub.trial_end_date:
            params["trial_period_days"] = int(plan.trial_days)
        elif sub.trial_end_date:
            params["trial_end"] = int(sub.trial_end_date.timestamp()) if hasattr(sub.trial_end_date, "timestamp") else int(datetime.combine(sub.trial_end_date, datetime.min.time()).timestamp())
        try:
            stripe_sub = stripe.Subscription.create(**params)
        except Exception as e:
            if isinstance(e, BadRequestException):
                raise
            raise _translate_stripe_error(e)
        sub.stripe_subscription_id = stripe_sub.id
        sub.stripe_price_id = price_id
        sub.cancel_at_period_end = False
        self.db.commit()
        self.db.refresh(sub)
        self.db.add(SubscriptionEvent(
            organization_id=organization_id,
            subscription_id=sub.id,
            event_type="stripe_subscription_created",
            old_value=None,
            new_value={"stripe_subscription_id": stripe_sub.id, "stripe_price_id": price_id},
            created_by=created_by,
        ))
        self.db.commit()
        self.audit.log(
            organization_id, created_by, BillingAuditAction.UPDATE, "Subscription", sub.id,
            new_values={"stripe_subscription_id": stripe_sub.id, "stripe_price_id": price_id},
        )
        return {
            "stripe_subscription_id": stripe_sub.id,
            "status": stripe_sub.status,
            "current_period_start": stripe_sub.current_period_start,
            "current_period_end": stripe_sub.current_period_end,
            "cancel_at_period_end": stripe_sub.cancel_at_period_end,
        }

    def cancel_stripe_subscription(
        self,
        organization_id: int,
        subscription_id: int,
        cancel_at_period_end: bool = True,
        updated_by: Optional[int] = None,
    ) -> Dict[str, Any]:
        connected_account_id = self._connected_account_id(organization_id)
        stripe = _stripe_module()
        sub = self.subscription_service.get_subscription(subscription_id, organization_id)
        if not sub.stripe_subscription_id:
            raise BadRequestException("Subscription is not linked to a Stripe subscription")
        try:
            if cancel_at_period_end:
                # Cancel-at-period-end and deletion are naturally idempotent
                # Stripe-side (repeating them converges to the same state), so
                # no explicit idempotency key is required — only the routing
                # header matters here.
                stripe_sub = stripe.Subscription.modify(
                    sub.stripe_subscription_id, cancel_at_period_end=True,
                    stripe_account=connected_account_id,
                )
            else:
                stripe_sub = stripe.Subscription.delete(
                    sub.stripe_subscription_id,
                    stripe_account=connected_account_id,
                )
        except Exception as e:
            if isinstance(e, BadRequestException):
                raise
            raise _translate_stripe_error(e)
        sub.cancel_at_period_end = True
        sub.stripe_cancel_at = datetime.utcnow()
        if not cancel_at_period_end:
            sub.status = BillingSubscriptionStatus.CANCELLED
        self.db.commit()
        self.db.refresh(sub)
        self.db.add(SubscriptionEvent(
            organization_id=organization_id,
            subscription_id=sub.id,
            event_type="stripe_subscription_cancelled",
            old_value=None,
            new_value={
                "stripe_subscription_id": sub.stripe_subscription_id,
                "cancel_at_period_end": cancel_at_period_end,
                "stripe_status": stripe_sub.status,
            },
            created_by=updated_by,
        ))
        self.db.commit()
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.CANCEL, "Subscription", sub.id,
            new_values={"cancel_at_period_end": cancel_at_period_end, "stripe_status": stripe_sub.status},
        )
        return {
            "stripe_subscription_id": sub.stripe_subscription_id,
            "status": stripe_sub.status,
            "cancel_at_period_end": cancel_at_period_end,
        }

    # ── Refunds (outbound) ─────────────────────────────────────────────────

    def create_stripe_refund(self, organization_id: int, refund_id: int, updated_by: Optional[int] = None) -> Dict[str, Any]:
        stripe = _stripe_module()
        refund = self.refund_service.get_refund(refund_id, organization_id)
        if refund.status not in (RefundStatus.APPROVED, RefundStatus.PROCESSING):
            raise BadRequestException(
                f"Only approved or processing refunds can be pushed to Stripe (current: {refund.status.value})"
            )
        if refund.gateway_refund_id:
            return {
                "refund_id": refund_id,
                "gateway_refund_id": refund.gateway_refund_id,
                "status": refund.status.value,
                "already_submitted": True,
            }
        payment = None
        if refund.payment_id:
            payment = self.payment_service.get_payment(refund.payment_id, organization_id)
        if payment is None:
            raise BadRequestException("Refund is not linked to a payment")
        # Cross-tenant guard (defense in depth): the refund must belong to the
        # SAME organization as the caller AND the underlying payment.  The
        # org-scoped get_refund/get_payment lookups above already enforce
        # this; the explicit assert below makes it impossible to bypass by
        # future refactoring.
        if payment.organization_id != organization_id or refund.organization_id != organization_id:
            raise BadRequestException("Refund and payment do not belong to this organization")
        payment_intent_id = payment.stripe_payment_intent_id
        if not payment_intent_id:
            raise BadRequestException("Refund is not linked to a Stripe payment intent")
        # Route against the connected account that owns the ORIGINAL PAYMENT
        # — refunds always execute in the merchant context of the charge.
        connected_account_id = self._connected_account_id(organization_id)
        try:
            created = stripe.Refund.create(
                payment_intent=payment_intent_id,
                amount=_to_cents(refund.amount),
                metadata={"organization_id": str(organization_id), "refund_id": str(refund_id)},
                # Deterministic per business identity: a retried push re-uses
                # the same key so a timeout/re-run can never create a SECOND
                # refund for the same local Refund row.
                idempotency_key=f"rf-{organization_id}-{refund_id}",
                stripe_account=connected_account_id,
            )
        except Exception as e:
            if isinstance(e, BadRequestException):
                raise
            raise _translate_stripe_error(e)
        refund.gateway_refund_id = created.id
        self.refund_service.process_refund(
            refund_id, organization_id, updated_by, gateway_refund_id=created.id,
        )
        return {
            "refund_id": refund_id,
            "gateway_refund_id": created.id,
            "status": created.status,
            "amount": str(refund.amount),
        }

    # ── Webhooks ───────────────────────────────────────────────────────────

    def handle_webhook(self, payload: bytes, signature: str) -> Dict[str, Any]:
        if not settings.STRIPE_WEBHOOK_SECRET:
            raise BadRequestException("Stripe webhooks are not configured (STRIPE_WEBHOOK_SECRET)")
        stripe = _stripe_module()
        try:
            event = stripe.Webhook.construct_event(
                payload, signature, settings.STRIPE_WEBHOOK_SECRET,
            )
        except Exception as e:
            raise BadRequestException(f"Invalid Stripe webhook signature: {e}")

        # stripe>=10 SDK: Event is a StripeObject exposing __getitem__ but
        # NOT .get() -- converting to a plain dict up front keeps every
        # downstream .get() call below correct regardless of installed SDK
        # version (Phase 4.1 remediation: this crashed with AttributeError
        # on every real webhook call before test coverage caught it).
        event = event.to_dict() if hasattr(event, "to_dict") else event

        event_id = event.get("id")
        event_type = event.get("type")
        data_object = (event.get("data") or {}).get("object") or {}
        # WEB-1: the event envelope's top-level `account` field is how Stripe
        # scopes Connect events.  Present ⇒ the event was emitted against a
        # CONNECTED account; absent ⇒ platform-scope event on our own account.
        event_account = event.get("account") or None
        environment = _resolve_environment()

        # Trusted tenant resolution order:
        #   1. Connect envelope: event.account → stripe_connected_accounts row
        #      (same environment) → organization_id  [authoritative]
        #   2. Event metadata organization_id                     [legacy signal]
        org_id = None
        if event_account:
            mapped = (
                self.db.query(StripeConnectedAccount)
                .filter(
                    StripeConnectedAccount.connected_account_id == event_account,
                    StripeConnectedAccount.environment == environment,
                )
                .first()
            )
            if mapped is not None:
                org_id = mapped.organization_id
        if org_id is None:
            org_id = self._extract_org_id(data_object)

        existing = self.db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
        if existing:
            if existing.status == "failed":
                # WEB-2 remediation: previously a failed handler was pinned in
                # the ledger forever, so Stripe's retry got a short-circuit and
                # the event was never actually reprocessed.  Reset the row so
                # this delivery genuinely retries the handler (attempts count
                # is preserved + incremented for observability).
                existing.status = "processing"
                existing.processing_attempts = (existing.processing_attempts or 0) + 1
                existing.error = None
                self.db.commit()
            else:
                return {
                    "received": True,
                    "idempotent": True,
                    "type": event_type,
                    "status": existing.status,
                    "processing_attempts": existing.processing_attempts,
                }
        else:
            ledger = StripeEvent(
                event_id=event_id,
                event_type=event_type,
                organization_id=org_id,
                status="processing",
                payload=event,
                connected_account_id=event_account,
                environment=environment,
                processing_attempts=1,
            )
            self.db.add(ledger)
            try:
                self.db.commit()
            except IntegrityError:
                self.db.rollback()
                return {"received": True, "idempotent": True, "type": event_type, "status": "processing"}

        handler = self._handlers().get(event_type)
        if handler is None:
            return self._finalize_event(event_id, org_id, "processed", None, None, event_type, event_account)

        try:
            result = handler(data_object, org_id, event_account)
        except Exception as e:
            logger.exception("[stripe] Webhook %s (%s) handler failed", event_id, event_type)
            self.db.rollback()
            return self._finalize_event(event_id, org_id, "failed", None, str(e), event_type, event_account)
        return self._finalize_event(event_id, org_id, "processed", result, None, event_type, event_account)

    def _finalize_event(
        self,
        event_id: str,
        organization_id: Optional[int],
        status: str,
        result: Optional[Any],
        error: Optional[str],
        event_type: Optional[str] = None,
        event_account: Optional[str] = None,
    ) -> Dict[str, Any]:
        row = self.db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
        if row:
            row.status = status
            row.organization_id = organization_id or row.organization_id
            row.error = error
            row.connected_account_id = event_account or row.connected_account_id
            row.environment = _resolve_environment()
            try:
                self.db.commit()
            except Exception:
                self.db.rollback()
        return {
            "received": True,
            "type": event_type,
            "status": status,
            "result": result,
            "error": error,
        }

    @staticmethod
    def _extract_org_id(data_object: Optional[Dict[str, Any]]) -> Optional[int]:
        if not data_object:
            return None
        metadata = data_object.get("metadata") or {}
        raw = metadata.get("organization_id") or data_object.get("organization_id")
        if raw:
            try:
                return int(raw)
            except (TypeError, ValueError):
                return None
        return None

    def _handlers(self) -> Dict[str, Any]:
        return {
            "checkout.session.completed": self._handle_checkout_session_completed,
            "checkout.session.expired": self._noop_handler,
            "payment_intent.succeeded": self._handle_payment_intent_succeeded,
            "payment_intent.payment_failed": self._handle_payment_intent_payment_failed,
            "payment_intent.canceled": self._noop_handler,
            "invoice.paid": self._handle_invoice_paid,
            "invoice.payment_failed": self._handle_invoice_payment_failed,
            "customer.subscription.created": self._handle_customer_subscription_updated,
            "customer.subscription.updated": self._handle_customer_subscription_updated,
            "customer.subscription.deleted": self._handle_customer_subscription_deleted,
            "charge.refunded": self._handle_charge_refunded,
            "refund.updated": self._handle_refund_updated,
            # Dispute / chargeback events (Phase B — Plane 2 only)
            "charge.dispute.created": self._handle_dispute_event,
            "charge.dispute.updated": self._handle_dispute_event,
            "charge.dispute.closed": self._handle_dispute_event,
            # CON-3: Connect account state changes push the authoritative
            # charges/payouts/requirements flags to us — without this handler
            # a restricted or disabled tenant account would keep accepting
            # payments until someone clicked "sync" manually.
            "account.updated": self._handle_account_updated,
        }

    @staticmethod
    def _noop_handler(
        data_object: Optional[Dict[str, Any]],
        organization_id: Optional[int],
        event_account: Optional[str] = None,
    ) -> Dict[str, Any]:
        return {"action": "none"}

    def _handle_account_updated(
        self,
        data_object: Dict[str, Any],
        organization_id: Optional[int],
        event_account: Optional[str] = None,
    ) -> Dict[str, Any]:
        """CON-3: sync the local StripeConnectedAccount row from an
        `account.updated` Connect event.  Tenant resolution is via the event's
        connected_account_id (trusted DB map), never via caller input."""
        acct_id = data_object.get("id")
        if not acct_id:
            return {"action": "ignored", "reason": "no account id"}
        row = (
            self.db.query(StripeConnectedAccount)
            .filter(
                StripeConnectedAccount.connected_account_id == acct_id,
                StripeConnectedAccount.environment == _resolve_environment(),
            )
            .first()
        )
        if row is None:
            # Not a tenant connection we track (e.g. the platform account's own
            # account.updated) — nothing local to update.
            return {"action": "ignored", "reason": "no matching local connection"}
        status = _derive_status(data_object)
        now = datetime.utcnow()
        row.charges_enabled = bool(data_object.get("charges_enabled"))
        row.payouts_enabled = bool(data_object.get("payouts_enabled"))
        row.details_submitted = bool(data_object.get("details_submitted"))
        row.capabilities = data_object.get("capabilities")
        row.requirements_currently_due = (data_object.get("requirements") or {}).get("currently_due")
        row.disabled_reason = (data_object.get("requirements") or {}).get("disabled_reason")
        row.country = data_object.get("country") or row.country
        row.default_currency = (data_object.get("default_currency") or "").upper() or row.default_currency
        row.status = status
        row.last_synced_at = now
        if status == IntegrationConnectionStatus.ACTIVE and not row.connected_at:
            row.connected_at = now
        try:
            self.db.commit()
            self.db.refresh(row)
        except Exception:
            self.db.rollback()
            raise
        logger.info(
            "[stripe] account.updated synced connection %s → status=%s",
            acct_id, status.value,
        )
        return {"action": "connection_synced", "connection_id": row.id, "status": status.value}

    # ── Payment recording shared by the money-movement handlers ────────────

    def _record_cleared_payment(
        self,
        organization_id: int,
        invoice: Invoice,
        payment_intent_id: Optional[str],
        charge_id: Optional[str] = None,
        amount: Optional[Decimal] = None,
        payment_method_id: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> Payment:
        amount = amount or Decimal(str(invoice.balance_due if invoice.balance_due is not None else invoice.total_amount or 0))
        if amount <= 0:
            raise BadRequestException("Cannot record a zero-amount payment")
        customer_id = invoice.customer_id
        payment_number = self.sequence_service.next_number(
            organization_id, "payment", "PAY-", NumberFormat.PREFIX_YYYY_SEQ, SequenceReset.ANNUALLY,
        )
        payment = self.payment_service.record_payment(
            organization_id=organization_id,
            customer_id=customer_id,
            payment_number=payment_number,
            amount=amount,
            payment_date=date.today(),
            created_by=SYSTEM_ACTOR,
            idempotency_key=payment_intent_id,
            payment_type=PaymentType.INVOICE_PAYMENT,
            status=PaymentStatus.CLEARED,
            gateway=PaymentGatewayType.CREDIT_CARD,
            gateway_charge_id=charge_id,
            currency=invoice.currency or settings.STRIPE_CURRENCY_DEFAULT.upper(),
            notes=notes or f"Stripe payment intent {payment_intent_id}",
        )
        if payment_intent_id:
            payment.stripe_payment_intent_id = payment_intent_id
        self.db.commit()
        self._link_payment_method(organization_id, customer_id, payment_method_id)
        self._allocate_payment(organization_id, invoice, payment)
        return payment

    def _link_payment_method(self, organization_id: int, customer_id: int, payment_method_id: Optional[str]) -> None:
        if not payment_method_id or not payment_method_id.startswith("pm_"):
            return
        from app.modules.billing.models import PaymentMethod, PaymentMethodStatus
        existing = (
            self.db.query(PaymentMethod)
            .filter(
                PaymentMethod.organization_id == organization_id,
                PaymentMethod.gateway_payment_method_id == payment_method_id,
            )
            .first()
        )
        if existing:
            return
        self.db.add(PaymentMethod(
            organization_id=organization_id,
            customer_id=customer_id,
            payment_type=PaymentGatewayType.CREDIT_CARD,
            gateway="stripe",
            gateway_customer_id=None,
            gateway_payment_method_id=payment_method_id,
            status=PaymentMethodStatus.ACTIVE,
            is_active=True,
        ))
        self.db.commit()

    def _allocate_payment(self, organization_id: int, invoice: Invoice, payment: Payment) -> None:
        balance = Decimal(str(invoice.balance_due if invoice.balance_due is not None else invoice.total_amount or 0))
        if balance <= 0:
            return
        try:
            self.payment_service.allocate_payment(
                payment_id=payment.id,
                organization_id=organization_id,
                invoice_id=invoice.id,
                amount=min(Decimal(str(payment.amount)), balance),
                created_by=SYSTEM_ACTOR,
            )
        except Exception as e:
            if "PaymentAllocation" in str(e) and "already" in str(e).lower():
                logger.info("[stripe] Payment %s already allocated to invoice %s", payment.id, invoice.id)
                return
            raise

    def _find_payment_by_intent(self, organization_id: Optional[int], payment_intent_id: Optional[str]) -> Optional[Payment]:
        if not payment_intent_id or organization_id is None:
            return None
        return self.db.query(Payment).filter(
            Payment.stripe_payment_intent_id == payment_intent_id,
            Payment.organization_id == organization_id,
        ).first()

    # ── Handler: checkout.session.completed ────────────────────────────────

    def _handle_checkout_session_completed(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        if data_object.get("payment_status") not in ("paid", "no_payment_required"):
            return {"action": "ignored", "reason": f"payment_status={data_object.get('payment_status')}"}
        metadata = data_object.get("metadata") or {}
        invoice_id = metadata.get("invoice_id")
        if not invoice_id:
            return {"action": "ignored", "reason": "no invoice_id in session metadata"}
        try:
            invoice_id = int(invoice_id)
        except (TypeError, ValueError):
            return {"action": "ignored", "reason": "invalid invoice_id in session metadata"}
        if not organization_id:
            # Invoice.id is a per-organization identifier, not globally
            # unique — without a verified organization_id there is no safe
            # way to know which tenant's invoice_id N refers to. Reject
            # rather than fall back to an unscoped lookup that could match
            # another organization's row with the same id.
            logger.warning(
                "[stripe] checkout.session.completed missing organization_id metadata; refusing to guess invoice %s",
                invoice_id,
            )
            return {"action": "ignored", "reason": "no organization_id in session metadata"}
        invoice = self.db.query(Invoice).filter(
            Invoice.id == invoice_id,
            Invoice.organization_id == int(organization_id),
        ).first()
        if invoice is None:
            return {"action": "ignored", "reason": "invoice not found for the given organization_id"}
        payment_intent_id = data_object.get("payment_intent")
        charge_id = None
        if payment_intent_id:
            existing_payment = self._find_payment_by_intent(organization_id, payment_intent_id)
            if existing_payment:
                invoice.stripe_payment_intent_id = payment_intent_id
                invoice.stripe_checkout_session_id = data_object.get("id")
                invoice.stripe_invoice_id = data_object.get("invoice")
                self.db.commit()
                return {"action": "already_recorded", "payment_id": existing_payment.id}
            invoice.stripe_payment_intent_id = payment_intent_id
        invoice.stripe_checkout_session_id = data_object.get("id")
        if data_object.get("invoice"):
            invoice.stripe_invoice_id = data_object.get("invoice")
        payment = self._record_cleared_payment(
            organization_id=invoice.organization_id,
            invoice=invoice,
            payment_intent_id=payment_intent_id,
            charge_id=charge_id,
            payment_method_id=(data_object.get("payment_method") or {}).get("card") if isinstance(data_object.get("payment_method"), dict) else data_object.get("payment_method"),
            notes=f"Stripe Checkout session {data_object.get('id')}",
        )
        invoice.stripe_payment_intent_id = payment_intent_id or invoice.stripe_payment_intent_id
        self.db.commit()
        return {"action": "payment_recorded", "payment_id": payment.id}

    # ── Handler: payment_intent.succeeded ──────────────────────────────────

    def _handle_payment_intent_succeeded(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        payment_intent_id = data_object.get("id")
        if not payment_intent_id:
            return {"action": "ignored", "reason": "no payment_intent id"}
        metadata = data_object.get("metadata") or {}
        invoice_id = metadata.get("invoice_id")
        invoice = None
        if invoice_id:
            try:
                invoice_id = int(invoice_id)
            except (TypeError, ValueError):
                invoice_id = None
        if invoice_id and organization_id:
            # Invoice.id is per-organization, not globally unique — only
            # attempt this lookup when we have a verified organization_id to
            # scope it by. A missing organization_id must never fall back to
            # an unscoped id lookup.
            invoice = self.db.query(Invoice).filter(
                Invoice.id == invoice_id,
                Invoice.organization_id == int(organization_id),
            ).first()
        if invoice is None:
            # Fallback: stripe_payment_intent_id is a Stripe-issued
            # identifier we ourselves stored on exactly one of our own
            # invoices — a trustworthy tenant-resolution path independent of
            # the (possibly missing/wrong) event metadata organization_id.
            invoice = self.db.query(Invoice).filter(
                Invoice.stripe_payment_intent_id == payment_intent_id,
            ).first()
        if invoice is None:
            return {"action": "ignored", "reason": "no matching invoice"}

        # The invoice fallback above may establish the tenant when legacy
        # processor metadata is absent. Use that trusted local ownership for
        # the duplicate-payment lookup rather than querying globally.
        existing_payment = self._find_payment_by_intent(invoice.organization_id, payment_intent_id)
        if existing_payment:
            if existing_payment.status == PaymentStatus.PROCESSING:
                self.payment_service.update_payment_status(
                    existing_payment.id, existing_payment.organization_id,
                    PaymentStatus.CLEARED, SYSTEM_ACTOR,
                )
            # DIS-2: a checkout-path payment is recorded by
            # checkout.session.completed, which carries NO charge id — the
            # charge only becomes known on this payment_intent event.  Backfill
            # gateway_charge_id here so later charge.dispute.* events can
            # attribute reliably.
            latest_charge = data_object.get("latest_charge")
            if (
                not existing_payment.gateway_charge_id
                and isinstance(latest_charge, str)
                and latest_charge
            ):
                existing_payment.gateway_charge_id = latest_charge
            self._allocate_payment(existing_payment.organization_id, invoice, existing_payment)
            invoice.stripe_payment_intent_id = payment_intent_id
            self.db.commit()
            return {"action": "updated", "payment_id": existing_payment.id}

        latest_charge = data_object.get("latest_charge")
        charge_id = latest_charge if isinstance(latest_charge, str) else None
        amount_cents = data_object.get("amount_received")
        amount = _from_cents(amount_cents) if amount_cents else None
        pm_data = data_object.get("payment_method")
        pm_id = pm_data if isinstance(pm_data, str) else None
        payment = self._record_cleared_payment(
            organization_id=invoice.organization_id,
            invoice=invoice,
            payment_intent_id=payment_intent_id,
            charge_id=charge_id,
            amount=amount,
            payment_method_id=pm_id,
            notes=f"Stripe payment intent {payment_intent_id}",
        )
        invoice.stripe_payment_intent_id = payment_intent_id
        self.db.commit()
        return {"action": "payment_recorded", "payment_id": payment.id}

    # ── Handler: payment_intent.payment_failed ─────────────────────────────

    def _handle_payment_intent_payment_failed(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        payment_intent_id = data_object.get("id")
        if not payment_intent_id:
            return {"action": "ignored"}
        payment = self._find_payment_by_intent(organization_id, payment_intent_id)
        if payment is None:
            return {"action": "ignored", "reason": "no matching local payment"}
        last_error = (data_object.get("last_payment_error") or {}).get("message")
        code = (data_object.get("last_payment_error") or {}).get("code")
        try:
            self.payment_service.update_payment_status(
                payment.id, payment.organization_id, PaymentStatus.FAILED, SYSTEM_ACTOR,
                failure_reason=last_error, failure_code=code,
            )
        except BadRequestException:
            logger.warning(
                "[stripe] Could not mark payment %s failed (status=%s)",
                payment.id, payment.status,
            )
            return {"action": "skipped", "reason": f"status={payment.status.value}"}
        return {"action": "payment_failed", "payment_id": payment.id}

    # ── Handler: invoice.paid / invoice.payment_failed ─────────────────────

    def _handle_invoice_paid(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        metadata = data_object.get("metadata") or {}
        invoice = None
        local_invoice_id = metadata.get("invoice_id")
        if local_invoice_id:
            try:
                local_invoice_id = int(local_invoice_id)
            except (TypeError, ValueError):
                local_invoice_id = None
        if local_invoice_id and organization_id:
            # Invoice.id is per-organization, not globally unique — only
            # attempt this lookup when we have a verified organization_id to
            # scope it by. A missing organization_id must never fall back to
            # an unscoped id lookup.
            invoice = self.db.query(Invoice).filter(
                Invoice.id == local_invoice_id,
                Invoice.organization_id == int(organization_id),
            ).first()
        if invoice is None and data_object.get("id"):
            invoice = self.db.query(Invoice).filter(
                Invoice.stripe_invoice_id == data_object.get("id"),
            ).first()
        if invoice is None and metadata.get("subscription_id"):
            try:
                sub_id = int(metadata["subscription_id"])
            except (TypeError, ValueError):
                sub_id = None
            if sub_id and organization_id:
                sub = self.subscription_service.get_subscription(sub_id, int(organization_id))
                if sub:
                    result = self.subscription_service.generate_invoice(sub_id, int(organization_id), SYSTEM_ACTOR)
                    if not result.get("skipped"):
                        invoice = self.invoice_service.get_invoice(result["invoice_id"], int(organization_id))
        if invoice is None:
            return {"action": "ignored", "reason": "no matching local invoice"}
        payment_intent_id = data_object.get("payment_intent")
        if data_object.get("id") and not invoice.stripe_invoice_id:
            invoice.stripe_invoice_id = data_object.get("id")
        payment = self._record_cleared_payment(
            organization_id=invoice.organization_id,
            invoice=invoice,
            payment_intent_id=payment_intent_id,
            amount=_from_cents(data_object.get("amount_paid")) if data_object.get("amount_paid") else None,
            notes=f"Stripe invoice {data_object.get('id')} paid",
        )
        self.db.commit()
        return {"action": "payment_recorded", "payment_id": payment.id}

    def _handle_invoice_payment_failed(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        payment_intent_id = data_object.get("payment_intent")
        payment = self._find_payment_by_intent(organization_id, payment_intent_id) if payment_intent_id else None
        if payment is None:
            return {"action": "ignored", "reason": "no matching local payment"}
        try:
            self.payment_service.update_payment_status(
                payment.id, payment.organization_id, PaymentStatus.FAILED, SYSTEM_ACTOR,
                failure_reason=(data_object.get("last_finalization_error") or {}).get("message"),
            )
        except BadRequestException:
            return {"action": "skipped", "reason": f"status={payment.status.value}"}
        return {"action": "payment_failed", "payment_id": payment.id}

    # ── Handlers: customer.subscription.updated / deleted ──────────────────

    def _handle_customer_subscription_updated(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        stripe_sub_id = data_object.get("id")
        if not stripe_sub_id:
            return {"action": "ignored"}
        if organization_id is None:
            return {"action": "ignored", "reason": "no verified organization for subscription event"}
        sub = self.db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id,
            Subscription.organization_id == organization_id,
        ).first()
        if sub is None:
            return {"action": "ignored", "reason": "no matching local subscription"}
        status = (data_object.get("status") or "").lower()
        if status == "active":
            sub.status = BillingSubscriptionStatus.ACTIVE
        elif status in ("past_due", "unpaid"):
            sub.status = BillingSubscriptionStatus.PAST_DUE
        elif status == "paused":
            sub.status = BillingSubscriptionStatus.PAUSED
        elif status in ("canceled", "cancelled"):
            sub.status = BillingSubscriptionStatus.CANCELLED
        sub.cancel_at_period_end = bool(data_object.get("cancel_at_period_end"))
        items = data_object.get("items") or {}
        for item in (items.get("data") or []):
            price_id = item.get("price", {}).get("id")
            if price_id:
                sub.stripe_price_id = price_id
                break
        self.db.commit()
        return {"action": "subscription_synced", "subscription_id": sub.id, "stripe_status": status}

    def _handle_customer_subscription_deleted(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        stripe_sub_id = data_object.get("id")
        if not stripe_sub_id:
            return {"action": "ignored"}
        if organization_id is None:
            return {"action": "ignored", "reason": "no verified organization for subscription event"}
        sub = self.db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id,
            Subscription.organization_id == organization_id,
        ).first()
        if sub is None:
            return {"action": "ignored", "reason": "no matching local subscription"}
        sub.status = BillingSubscriptionStatus.CANCELLED
        sub.cancel_at_period_end = True
        sub.stripe_cancel_at = datetime.utcnow()
        self.db.commit()
        self.db.add(SubscriptionEvent(
            organization_id=sub.organization_id,
            subscription_id=sub.id,
            event_type="stripe_subscription_deleted",
            old_value=None,
            new_value={"stripe_subscription_id": stripe_sub_id},
            created_by=SYSTEM_ACTOR,
        ))
        self.db.commit()
        return {"action": "subscription_cancelled", "subscription_id": sub.id}

    # ── Handlers: charge.refunded / refund.updated ─────────────────────────

    def _handle_charge_refunded(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        refunds = (data_object.get("refunds") or {}).get("data") or []
        results = []
        for refund in refunds:
            if refund.get("status") != "succeeded":
                continue
            results.append(self._process_succeeded_refund(organization_id, data_object, refund))
        return {"action": "refund_processed", "results": results}

    def _handle_refund_updated(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        if data_object.get("status") != "succeeded":
            return {"action": "ignored", "reason": f"status={data_object.get('status')}"}
        charge = None
        if data_object.get("payment_intent"):
            payment = self._find_payment_by_intent(organization_id, data_object.get("payment_intent"))
            if payment:
                charge = {"id": payment.gateway_charge_id or data_object.get("id"), "payment_intent": data_object.get("payment_intent")}
        if charge is None:
            charge = {"id": data_object.get("id"), "payment_intent": data_object.get("payment_intent")}
        return self._process_succeeded_refund(organization_id, charge, data_object)

    def _process_succeeded_refund(self, organization_id: Optional[int], charge: Dict[str, Any], refund: Dict[str, Any]) -> Dict[str, Any]:
        refund_id = refund.get("id")
        existing = self.db.query(Refund).filter(Refund.gateway_refund_id == refund_id).first()
        if existing:
            return {"refund_id": refund_id, "action": "already_recorded"}
        payment_intent_id = refund.get("payment_intent") or charge.get("payment_intent")
        payment = self._find_payment_by_intent(organization_id, payment_intent_id)
        if payment is None:
            return {"refund_id": refund_id, "action": "ignored", "reason": "no matching payment"}
        amount = _from_cents(refund.get("amount") or 0)
        if amount <= 0:
            return {"refund_id": refund_id, "action": "ignored", "reason": "zero amount"}
        org = organization_id or payment.organization_id
        self._create_gateway_refund(org, payment, refund_id, amount)
        self.payment_service.reverse_allocations_for_refund(org, payment.id, amount, SYSTEM_ACTOR)
        return {"refund_id": refund_id, "action": "recorded", "amount": str(amount)}

    def _create_gateway_refund(self, organization_id: int, payment: Payment, gateway_refund_id: str, amount: Decimal) -> Refund:
        refund_number = self.sequence_service.next_number(
            organization_id, "refund", "RF-", NumberFormat.PREFIX_YYYY_SEQ, SequenceReset.ANNUALLY,
        )
        refund = Refund(
            organization_id=organization_id,
            customer_id=payment.customer_id,
            payment_id=payment.id,
            invoice_id=payment.allocations[0].invoice_id if payment.allocations else None,
            refund_number=refund_number,
            refund_type=RefundType.FULL if amount >= Decimal(str(payment.amount)) else RefundType.PARTIAL,
            refund_source=RefundSource.PAYMENT,
            refund_method=RefundMethod.CARD_REFUND,
            status=RefundStatus.COMPLETED,
            amount=amount,
            currency=payment.currency,
            gateway=PaymentGatewayType.CREDIT_CARD,
            gateway_refund_id=gateway_refund_id,
            reason=f"Stripe gateway refund {gateway_refund_id}",
            completed_at=datetime.utcnow(),
        )
        self.db.add(refund)
        self.db.flush()
        self.db.add(RefundStatusHistory(
            organization_id=organization_id,
            refund_id=refund.id,
            from_status=None,
            to_status=RefundStatus.COMPLETED,
            reason="Stripe gateway refund",
        ))
        return refund

    # Allocation/invoice-balance reversal for a completed refund now lives on
    # PaymentService.reverse_allocations_for_refund — shared with the
    # internal refund-approval workflow (RefundService.complete_refund) so
    # both produce identical invoice/payment state after a refund lands.

    # ── Handler: charge.dispute.created / updated / closed ─────────────────

    def _handle_dispute_event(self, data_object: Dict[str, Any], organization_id: Optional[int], event_account: Optional[str] = None) -> Dict[str, Any]:
        """Upsert a Dispute row for a Stripe charge.dispute.* event.

        A dispute is a financial adjustment layered on top of the original
        Payment — it never modifies or deletes the Payment row.  If a dispute
        is ultimately lost, the caller is expected to reconcile the invoice
        balance separately; we record the event and outcome faithfully.

        Tenant / payment attribution (DIS-2 remediation), in trust order:
          1. gateway_charge_id match  (charge.dispute events always carry it)
          2. stripe_payment_intent_id match via the event's `payment_intent`
             field — covers checkout-path payments whose gateway_charge_id was
             only backfilled by payment_intent.succeeded
          3. organization_id embedded in event metadata (legacy signal)
        The connected_account_id stored on the row is taken from the trusted
        webhook envelope (`event.account`), not from the dispute payload.
        """
        dispute_id = data_object.get("id")
        if not dispute_id:
            return {"action": "ignored", "reason": "no dispute id"}

        charge_id = data_object.get("charge")
        payment = None
        if charge_id:
            payment = (
                self.db.query(Payment)
                .filter(Payment.gateway_charge_id == charge_id)
                .first()
            )
        if payment is None:
            payment_intent_ref = data_object.get("payment_intent")
            if payment_intent_ref:
                payment = (
                    self.db.query(Payment)
                    .filter(Payment.stripe_payment_intent_id == payment_intent_ref)
                    .first()
                )

        resolved_org_id = (payment.organization_id if payment else None) or organization_id
        if resolved_org_id is None:
            logger.warning(
                "[stripe] charge.dispute event %s: cannot resolve organization; recording with NULL org",
                dispute_id,
            )

        # Map Stripe status string to our DisputeStatus enum; unknown values fall
        # back to NEEDS_RESPONSE so the operations team is alerted.
        status_str = (data_object.get("status") or "needs_response").lower()
        try:
            status = DisputeStatus(status_str)
        except ValueError:
            logger.warning("[stripe] Unknown dispute status %r; defaulting to needs_response", status_str)
            status = DisputeStatus.NEEDS_RESPONSE

        amount = _from_cents(data_object.get("amount") or 0)
        currency = (data_object.get("currency") or "usd").upper()

        evidence_due_by = None
        raw_due = (data_object.get("evidence_details") or {}).get("due_by")
        if raw_due:
            try:
                evidence_due_by = datetime.utcfromtimestamp(int(raw_due))
            except (TypeError, ValueError):
                pass

        # Upsert: a re-delivered event or update event should update the
        # existing row rather than create a duplicate.
        existing = (
            self.db.query(Dispute)
            .filter(Dispute.gateway_dispute_id == dispute_id)
            .first()
        )
        if existing:
            existing.status = status
            existing.evidence_due_by = evidence_due_by or existing.evidence_due_by
            if status in (DisputeStatus.WON, DisputeStatus.LOST, DisputeStatus.WARNING_CLOSED):
                existing.closed_at = datetime.utcnow()
            try:
                self.db.commit()
            except Exception:
                self.db.rollback()
            return {"action": "dispute_updated", "dispute_id": existing.id, "status": status.value}

        dispute = Dispute(
            organization_id=resolved_org_id,
            payment_id=payment.id if payment else None,
            # Trusted envelope account (event.account) first — the payload's
            # own `account` key is not part of the dispute object schema.
            connected_account_id=event_account or data_object.get("account") or None,
            gateway_dispute_id=dispute_id,
            gateway_charge_id=charge_id,
            amount=amount,
            currency=currency,
            status=status,
            reason=data_object.get("reason"),
            evidence_due_by=evidence_due_by,
            is_charge_refundable=data_object.get("is_charge_refundable"),
            closed_at=datetime.utcnow() if status in (
                DisputeStatus.WON, DisputeStatus.LOST, DisputeStatus.WARNING_CLOSED,
            ) else None,
        )
        self.db.add(dispute)
        try:
            self.db.commit()
            self.db.refresh(dispute)
        except Exception:
            self.db.rollback()
            raise
        logger.info(
            "[stripe] Dispute %s recorded: payment=%s org=%s status=%s",
            dispute_id, payment.id if payment else None, resolved_org_id, status.value,
        )
        return {"action": "dispute_recorded", "dispute_id": dispute.id, "status": status.value}
