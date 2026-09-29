"""modules/billing/routers/webhook_router.py

Stripe webhook receiver. Deliberately registered OUTSIDE the billing router so
it is never guarded by auth/subscription dependencies — Stripe cannot send a
JWT. The service verifies the Stripe-Signature header itself and returns 400
on any mismatch; idempotency is enforced by the stripe_events ledger.

A handler failure returns HTTP 500 (WEB-2 remediation): the event is recorded
as "failed" in the ledger, and Stripe's automatic retry schedule re-delivers
it — the next delivery resets the failed ledger row and genuinely re-runs the
handler instead of being short-circuited as a duplicate.
"""

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
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
        # Signal Stripe to retry. The message itself intentionally stays
        # generic — internal error strings must not leak to the wire — but
        # SEC-3 requires an operator to be able to look up the real error
        # server-side from the response alone: event_id (== correlation_id,
        # see StripeService._process_verified_event) is the stripe_events
        # table's own natural, already-unique lookup key.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Webhook processing failed; the event will be retried",
                "event_id": result.get("event_id"),
            },
        )
    return result
