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
    Invoice,
    InvoiceStatus,
    NumberFormat,
    Payment,
    PaymentAllocation,
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
    StripeEvent,
    Subscription,
    SubscriptionEvent,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.document_sequence import DocumentSequenceService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.payment_service import PaymentService
from app.modules.billing.services.refund_service import RefundService
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
    return stripe


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

    # ── Customers ──────────────────────────────────────────────────────────

    def ensure_customer(self, organization_id: int, customer_id: int, created_by: Optional[int] = None) -> BillingCustomer:
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if customer.stripe_customer_id:
            stripe = _stripe_module()
            try:
                stripe.Customer.retrieve(customer.stripe_customer_id)
                return customer
            except Exception:
                logger.warning(
                    "[stripe] Customer %s (stripe=%s) no longer exists upstream; recreating",
                    customer.id, customer.stripe_customer_id,
                )
                customer.stripe_customer_id = None
        stripe = _stripe_module()
        name = customer.company_name or customer.display_name or customer.customer_code
        created = stripe.Customer.create(
            name=name,
            email=customer.email or None,
            metadata={
                "organization_id": str(organization_id),
                "customer_id": str(customer.id),
                "customer_code": customer.customer_code,
            },
        )
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

    def create_checkout_session(
        self,
        organization_id: int,
        invoice_id: int,
        success_url: str,
        cancel_url: str,
        created_by: Optional[int] = None,
    ) -> Dict[str, Any]:
        stripe = _stripe_module()
        invoice = self.invoice_service.get_invoice(invoice_id, organization_id)
        self._validate_invoice_payable(invoice)
        customer = self.ensure_customer(organization_id, invoice.customer_id, created_by)

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
                    "currency": (invoice.currency or settings.STRIPE_CURRENCY_DEFAULT).lower(),
                    "unit_amount": _to_cents(total),
                    "product_data": {"name": description or "Invoice item"},
                },
            })
        if not line_items:
            balance = invoice.balance_due if invoice.balance_due is not None else invoice.total_amount
            line_items.append({
                "quantity": 1,
                "price_data": {
                    "currency": (invoice.currency or settings.STRIPE_CURRENCY_DEFAULT).lower(),
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
        stripe = _stripe_module()
        invoice = self.invoice_service.get_invoice(invoice_id, organization_id)
        self._validate_invoice_payable(invoice)
        customer = self.ensure_customer(organization_id, invoice.customer_id, created_by)
        balance = Decimal(str(invoice.balance_due if invoice.balance_due is not None else invoice.total_amount or 0))
        currency = (invoice.currency or settings.STRIPE_CURRENCY_DEFAULT).lower()
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
        }
        if payment_method_id:
            kwargs["payment_method"] = payment_method_id
        payment_intent = stripe.PaymentIntent.create(**kwargs)
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
        stripe = _stripe_module()
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if not customer.stripe_customer_id:
            return {"customer_id": customer_id, "stripe_customer_id": None, "payment_methods": []}
        try:
            methods = stripe.PaymentMethod.list(
                customer=customer.stripe_customer_id, type="card",
            )
        except Exception as e:
            raise BadRequestException(f"Failed to list Stripe payment methods: {e}")
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
        }
        if plan and getattr(plan, "trial_days", 0) and not sub.trial_end_date:
            params["trial_period_days"] = int(plan.trial_days)
        elif sub.trial_end_date:
            params["trial_end"] = int(sub.trial_end_date.timestamp()) if hasattr(sub.trial_end_date, "timestamp") else int(datetime.combine(sub.trial_end_date, datetime.min.time()).timestamp())
        stripe_sub = stripe.Subscription.create(**params)
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
        stripe = _stripe_module()
        sub = self.subscription_service.get_subscription(subscription_id, organization_id)
        if not sub.stripe_subscription_id:
            raise BadRequestException("Subscription is not linked to a Stripe subscription")
        if cancel_at_period_end:
            stripe_sub = stripe.Subscription.modify(
                sub.stripe_subscription_id, cancel_at_period_end=True,
            )
            sub.cancel_at_period_end = True
            sub.stripe_cancel_at = datetime.utcnow()
        else:
            stripe_sub = stripe.Subscription.delete(sub.stripe_subscription_id)
            sub.cancel_at_period_end = True
            sub.stripe_cancel_at = datetime.utcnow()
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
        payment_intent_id = payment.stripe_payment_intent_id if payment else None
        if not payment_intent_id:
            raise BadRequestException("Refund is not linked to a Stripe payment intent")
        created = stripe.Refund.create(
            payment_intent=payment_intent_id,
            amount=_to_cents(refund.amount),
            metadata={"organization_id": str(organization_id), "refund_id": str(refund_id)},
        )
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

        event_id = event.get("id")
        event_type = event.get("type")
        data_object = (event.get("data") or {}).get("object") or {}
        existing = self.db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
        if existing:
            return {
                "received": True,
                "idempotent": True,
                "type": event_type,
                "status": existing.status,
            }

        org_id = self._extract_org_id(data_object)
        ledger = StripeEvent(
            event_id=event_id,
            event_type=event_type,
            organization_id=org_id,
            status="processing",
            payload=event,
        )
        self.db.add(ledger)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return {"received": True, "idempotent": True, "type": event_type, "status": "processing"}

        handler = self._handlers().get(event_type)
        if handler is None:
            return self._finalize_event(event_id, org_id, "processed", None, None, event_type)

        try:
            result = handler(data_object, org_id)
        except Exception as e:
            logger.exception("[stripe] Webhook %s (%s) handler failed", event_id, event_type)
            self.db.rollback()
            return self._finalize_event(event_id, org_id, "failed", None, str(e), event_type)
        return self._finalize_event(event_id, org_id, "processed", result, None, event_type)

    def _finalize_event(self, event_id: str, organization_id: Optional[int], status: str, result: Optional[Any], error: Optional[str], event_type: Optional[str] = None) -> Dict[str, Any]:
        row = self.db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
        if row:
            row.status = status
            row.organization_id = organization_id or row.organization_id
            row.error = error
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
        }

    @staticmethod
    def _noop_handler(data_object: Optional[Dict[str, Any]], organization_id: Optional[int]) -> Dict[str, Any]:
        return {"action": "none"}

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
        if not payment_intent_id:
            return None
        query = self.db.query(Payment).filter(Payment.stripe_payment_intent_id == payment_intent_id)
        if organization_id:
            query = query.filter(Payment.organization_id == organization_id)
        return query.first()

    # ── Handler: checkout.session.completed ────────────────────────────────

    def _handle_checkout_session_completed(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
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

    def _handle_payment_intent_succeeded(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
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

        existing_payment = self._find_payment_by_intent(organization_id, payment_intent_id)
        if existing_payment:
            if existing_payment.status == PaymentStatus.PROCESSING:
                self.payment_service.update_payment_status(
                    existing_payment.id, existing_payment.organization_id,
                    PaymentStatus.CLEARED, SYSTEM_ACTOR,
                )
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

    def _handle_payment_intent_payment_failed(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
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

    def _handle_invoice_paid(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
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

    def _handle_invoice_payment_failed(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
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

    def _handle_customer_subscription_updated(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
        stripe_sub_id = data_object.get("id")
        if not stripe_sub_id:
            return {"action": "ignored"}
        sub = self.db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id,
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

    def _handle_customer_subscription_deleted(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
        stripe_sub_id = data_object.get("id")
        if not stripe_sub_id:
            return {"action": "ignored"}
        sub = self.db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id,
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

    def _handle_charge_refunded(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
        refunds = (data_object.get("refunds") or {}).get("data") or []
        results = []
        for refund in refunds:
            if refund.get("status") != "succeeded":
                continue
            results.append(self._process_succeeded_refund(organization_id, data_object, refund))
        return {"action": "refund_processed", "results": results}

    def _handle_refund_updated(self, data_object: Dict[str, Any], organization_id: Optional[int]) -> Dict[str, Any]:
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
        self._reverse_allocations_for_refund(org, payment, amount)
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

    def _reverse_allocations_for_refund(self, organization_id: int, payment: Payment, amount: Decimal) -> None:
        remaining = amount
        total_allocated = sum(Decimal(str(a.amount)) for a in payment.allocations)
        if remaining > total_allocated:
            logger.warning(
                "[stripe] Refund %s exceeds allocated amount %s on payment %s; difference is a customer credit",
                remaining, total_allocated, payment.id,
            )
        allocations = (
            self.db.query(PaymentAllocation)
            .filter(
                PaymentAllocation.payment_id == payment.id,
                PaymentAllocation.organization_id == organization_id,
            )
            .order_by(PaymentAllocation.created_at.desc())
            .all()
        )
        for allocation in allocations:
            if remaining <= 0:
                break
            take = min(remaining, Decimal(str(allocation.amount)))
            invoice = (
                self.db.query(Invoice)
                .filter(
                    Invoice.id == allocation.invoice_id,
                    Invoice.organization_id == organization_id,
                )
                .with_for_update()
                .first()
            )
            if invoice is None:
                continue
            old_status = invoice.status
            invoice.paid_amount = Decimal(str(invoice.paid_amount or 0)) - take
            invoice.balance_due = Decimal(str(invoice.total_amount or 0)) - invoice.paid_amount
            if invoice.paid_amount <= 0:
                invoice.status = InvoiceStatus.REFUNDED
            elif invoice.balance_due > 0:
                invoice.status = InvoiceStatus.PARTIALLY_PAID
            else:
                invoice.status = InvoiceStatus.PAID
            allocation.amount = Decimal(str(allocation.amount)) - take
            if allocation.amount <= 0:
                self.db.delete(allocation)
            remaining -= take
        if remaining > 0:
            self.audit.log_no_commit(
                organization_id, SYSTEM_ACTOR, BillingAuditAction.REFUND, "Payment", payment.id,
                new_values={"unallocated_refund_amount": str(remaining), "note": "refund exceeded allocation"},
            )
        total_refunded = sum(
            Decimal(str(r.amount))
            for r in self.db.query(Refund).filter(
                Refund.payment_id == payment.id,
                Refund.status == RefundStatus.COMPLETED,
            ).all()
        )
        if total_refunded >= Decimal(str(payment.amount)):
            payment.status = PaymentStatus.REFUNDED
        self.db.commit()
