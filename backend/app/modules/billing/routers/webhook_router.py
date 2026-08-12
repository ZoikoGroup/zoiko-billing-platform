"""modules/billing/routers/webhook_router.py

Stripe webhook receiver. Deliberately registered OUTSIDE the billing router so
it is never guarded by auth/subscription dependencies — Stripe cannot send a
JWT. The service verifies the Stripe-Signature header itself and returns 400
on any mismatch; idempotency is enforced by the stripe_events ledger.
"""

from fastapi import APIRouter, Depends, Header, Request, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.billing.services.stripe_service import StripeService

router = APIRouter(prefix="/webhooks/stripe", tags=["Stripe Webhooks"])


@router.post("", status_code=status.HTTP_200_OK)
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(..., alias="Stripe-Signature"),
    db: Session = Depends(get_db),
):
    svc = StripeService(db)
    result = svc.handle_webhook(await request.body(), stripe_signature)
    if result.get("status") == "failed":
        return Response(
            status_code=status.HTTP_200_OK,
            content=result.get("error") or "webhook handler failed",
            media_type="text/plain",
        )
    return result
