"""modules/commercial/org_self_service_router.py
---------------------------------------------------
Plane 1 — org-facing "your Zoiko subscription" self-service endpoint.

Distinct from commercial_billing_router.py (super_admin-only, arbitrary
account_id). This endpoint is scoped ONLY to the caller's own organization —
never a client-supplied account_id — via get_current_billing_admin's
current_user.organization_id.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_billing_admin
from app.database import get_db
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialQuote,
    PlatformInvoice,
    PlatformPayment,
)

router = APIRouter(prefix="/billing/workspace", tags=["Plane 1 Self-Service"])


def _serialize_subscription(subscription) -> dict | None:
    if subscription is None:
        return None
    plan = subscription.plan
    return {
        "id": subscription.id,
        "status": subscription.status.value,
        "plan_code": plan.plan_code if plan else None,
        "plan_name": plan.plan_name if plan else None,
        "currency": plan.currency if plan else None,
        "price_amount": str(plan.price_amount) if plan and plan.price_amount is not None else None,
        "billing_interval": plan.billing_interval.value if plan and plan.billing_interval else None,
        "current_period_start": subscription.current_period_start.isoformat() if subscription.current_period_start else None,
        "current_period_end": subscription.current_period_end.isoformat() if subscription.current_period_end else None,
        "trial_ends_at": subscription.trial_ends_at.isoformat() if subscription.trial_ends_at else None,
    }


def _serialize_invoice(invoice: PlatformInvoice) -> dict:
    return {
        "id": invoice.id,
        "invoice_number": invoice.invoice_number,
        "status": invoice.status.value,
        "currency": invoice.currency,
        "total_amount": str(invoice.total_amount),
        "balance_due": str(invoice.balance_due),
        "issue_date": invoice.issue_date.isoformat() if invoice.issue_date else None,
        "due_date": invoice.due_date.isoformat() if invoice.due_date else None,
        "public_token": invoice.public_token,
    }


def _serialize_payment(payment: PlatformPayment) -> dict:
    return {
        "id": payment.id,
        "payment_number": payment.payment_number,
        "status": payment.status.value,
        "amount": str(payment.amount),
        "currency": payment.currency,
        "payment_method": payment.payment_method.value if payment.payment_method else None,
        "created_at": payment.created_at.isoformat() if payment.created_at else None,
    }


def _serialize_quote(quote: CommercialQuote) -> dict:
    return {
        "id": quote.id,
        "quote_number": quote.quote_number,
        "status": quote.status.value,
        "total_amount": str(quote.total_amount),
        "currency": quote.currency,
        "valid_until": quote.valid_until.isoformat() if quote.valid_until else None,
        "public_token": quote.public_token,
    }


@router.get("/zoiko-subscription", summary="The caller's own organization's Zoiko Billing subscription")
def get_zoiko_subscription(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This view requires an organization context.",
        )

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    if account is None:
        return {
            "account": None,
            "subscription": None,
            "invoices": [],
            "payments": [],
            "quotes": [],
        }

    subscription = None
    from app.modules.commercial.service import CommercialSubscriptionService

    subscription = CommercialSubscriptionService(db).get_active_subscription(account.id)

    invoices = (
        db.query(PlatformInvoice)
        .filter(PlatformInvoice.commercial_account_id == account.id)
        .order_by(PlatformInvoice.created_at.desc())
        .limit(50)
        .all()
    )
    payments = (
        db.query(PlatformPayment)
        .filter(PlatformPayment.commercial_account_id == account.id)
        .order_by(PlatformPayment.created_at.desc())
        .limit(50)
        .all()
    )
    quotes = (
        db.query(CommercialQuote)
        .filter(CommercialQuote.commercial_account_id == account.id)
        .order_by(CommercialQuote.created_at.desc())
        .limit(20)
        .all()
    )

    return {
        "account": {"id": account.id, "status": account.status.value, "intended_plan_code": account.intended_plan_code},
        "subscription": _serialize_subscription(subscription),
        "invoices": [_serialize_invoice(i) for i in invoices],
        "payments": [_serialize_payment(p) for p in payments],
        "quotes": [_serialize_quote(q) for q in quotes],
    }
