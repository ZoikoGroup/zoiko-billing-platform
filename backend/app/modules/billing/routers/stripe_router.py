"""modules/billing/routers/stripe_router.py

Authenticated Stripe endpoints: Checkout session creation, PaymentIntents,
Stripe subscription linking/cancellation, and pushing a refund to Stripe.
All routes require the caller's organization context via the billing router
dependencies.
"""

from typing import Optional

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.stripe_service import StripeService

router = APIRouter(prefix="/stripe", tags=["Stripe"])


class CheckoutSessionCreate(BaseModel):
    invoice_id: int
    success_url: str
    cancel_url: str


class PaymentIntentCreate(BaseModel):
    invoice_id: int
    payment_method_id: Optional[str] = None


class SubscriptionLinkCreate(BaseModel):
    price_id: Optional[str] = None


class SubscriptionCancelRequest(BaseModel):
    cancel_at_period_end: bool = True


@router.get("/config")
def stripe_config(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    return {
        "configured": StripeService.is_configured(),
        "publishable_key": StripeService.publishable_key(),
        "currency": "usd",
    }


@router.post("/checkout/session", status_code=status.HTTP_201_CREATED)
def create_checkout_session(
    body: CheckoutSessionCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = StripeService(db)
    return svc.create_checkout_session(
        organization_id=current_user.organization_id,
        invoice_id=body.invoice_id,
        success_url=body.success_url,
        cancel_url=body.cancel_url,
        created_by=current_user.id,
    )


@router.post("/payment-intent", status_code=status.HTTP_201_CREATED)
def create_payment_intent(
    body: PaymentIntentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = StripeService(db)
    return svc.create_payment_intent(
        organization_id=current_user.organization_id,
        invoice_id=body.invoice_id,
        payment_method_id=body.payment_method_id,
        created_by=current_user.id,
    )


@router.get("/customers/{customer_id}/payment-methods")
def list_payment_methods(
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    svc = StripeService(db)
    return svc.list_payment_methods(
        organization_id=current_user.organization_id,
        customer_id=customer_id,
    )


@router.post("/subscriptions/{subscription_id}/link", status_code=status.HTTP_201_CREATED)
def link_stripe_subscription(
    subscription_id: int,
    body: SubscriptionLinkCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = StripeService(db)
    return svc.create_stripe_subscription(
        organization_id=current_user.organization_id,
        subscription_id=subscription_id,
        price_id=body.price_id,
        created_by=current_user.id,
    )


@router.post("/subscriptions/{subscription_id}/cancel")
def cancel_stripe_subscription(
    subscription_id: int,
    body: SubscriptionCancelRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = StripeService(db)
    return svc.cancel_stripe_subscription(
        organization_id=current_user.organization_id,
        subscription_id=subscription_id,
        cancel_at_period_end=body.cancel_at_period_end,
        updated_by=current_user.id,
    )


@router.post("/refunds/{refund_id}/push", status_code=status.HTTP_201_CREATED)
def push_refund_to_stripe(
    refund_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    svc = StripeService(db)
    return svc.create_stripe_refund(
        organization_id=current_user.organization_id,
        refund_id=refund_id,
        updated_by=current_user.id,
    )
