"""modules/commercial/platform_stripe_router.py
--------------------------------------------------
Plane 1 — Stripe Checkout + webhook endpoints for Zoiko-billing-the-org.

Two routers, both mounted OUTSIDE the authenticated commercial_billing_router:
  - checkout_router: public (token-based), lets an org start a Checkout
    Session for its own platform invoice with no login.
  - webhook_router: Stripe cannot send a JWT — verifies Stripe-Signature
    itself. A NEW endpoint/secret (PLATFORM_STRIPE_WEBHOOK_SECRET), never
    /billing/webhooks/stripe.
"""

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.database import get_db
from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
from app.modules.commercial.platform_stripe_service import PlatformStripeService

checkout_router = APIRouter(
    prefix="/commercial-invoices/public",
    tags=["Plane 1 Invoices (Public)"],
)

webhook_router = APIRouter(prefix="/commercial/stripe", tags=["Plane 1 Stripe Webhook"])


@checkout_router.post(
    "/{token}/checkout",
    summary="Start a Stripe Checkout session to pay a platform invoice via its public link",
)
def create_checkout_session(token: str, db: Session = Depends(get_db)):
    invoice_svc = PlatformInvoiceService(db)
    try:
        invoice = invoice_svc.get_public_invoice(token)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    try:
        return PlatformStripeService(db).create_checkout_session_for_invoice(invoice)
    except BadRequestException as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@webhook_router.post("/webhook", status_code=status.HTTP_200_OK)
async def platform_stripe_webhook(
    request: Request,
    stripe_signature: str = Header(..., alias="Stripe-Signature"),
    db: Session = Depends(get_db),
):
    svc = PlatformStripeService(db)
    try:
        result = svc.handle_webhook_event(await request.body(), stripe_signature)
    except BadRequestException as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        # Signal Stripe to retry; internal error strings must not leak.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Webhook processing failed; the event will be retried",
        )
    return result
