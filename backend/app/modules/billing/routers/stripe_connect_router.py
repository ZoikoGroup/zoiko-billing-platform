"""modules/billing/routers/stripe_connect_router.py

Authenticated Stripe Connect endpoints:

GET  /stripe/connect/status          — tenant reads their connection status
GET  /stripe/connect/onboarding-url  — get the Stripe Connect OAuth redirect URL
POST /stripe/connect/callback         — receive the OAuth code after Stripe redirects back
POST /stripe/connect/sync             — re-fetch account status from Stripe
POST /stripe/connect/disconnect       — mark the account as disconnected

All routes require billing_admin access.  The connected_account_id returned by
these endpoints is a non-secret identifier (safe to return to the tenant's own
authenticated session) — no Stripe secret key is ever included in responses.
"""

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.dependencies import get_current_user, get_current_billing_admin
from app.modules.billing.services.stripe_connect_service import StripeConnectService

router = APIRouter(prefix="/stripe/connect", tags=["Stripe Connect"])


# ── Schemas ──────────────────────────────────────────────────────────────────


class OAuthCallbackRequest(BaseModel):
    code: str
    # Mandatory server-issued CSRF token from /onboarding-url (CON-2 fix).
    state: str


class OnboardingUrlRequest(BaseModel):
    redirect_uri: str


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("/status")
def get_connect_status(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    """Return the tenant's Stripe Connect account status (safe summary, no secrets)."""
    svc = StripeConnectService(db)
    return svc.get_status_dict(current_user.organization_id)


@router.post("/onboarding-url")
def get_onboarding_url(
    body: OnboardingUrlRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    """Return the Stripe Connect OAuth URL that the tenant should be redirected to
    in order to connect their Stripe account.

    The `redirect_uri` must exactly match one of the URIs registered in the
    Stripe Dashboard under Connect → Settings → Redirect URIs.  A signed,
    organization-bound `state` token is generated server-side and embedded in
    the returned URL; the client MUST preserve it through the redirect and
    send it back to /callback.
    """
    svc = StripeConnectService(db)
    return svc.get_onboarding_url(
        organization_id=current_user.organization_id,
        redirect_uri=body.redirect_uri,
    )


@router.post("/callback", status_code=status.HTTP_201_CREATED)
def oauth_callback(
    body: OAuthCallbackRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    """Exchange the Stripe OAuth authorization_code for a connected account ID
    and persist the StripeConnectedAccount record.

    The frontend should call this after the tenant returns from the Stripe
    onboarding redirect with ?code=...&state=... in the query string.  The
    state is verified against the authenticated organization (CSRF protection)
    before the code is exchanged.
    """
    svc = StripeConnectService(db)
    row = svc.complete_oauth(
        organization_id=current_user.organization_id,
        authorization_code=body.code,
        created_by=current_user.id,
        state=body.state,
    )
    return svc.get_status_dict(current_user.organization_id)


@router.post("/sync")
def sync_status(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    """Re-fetch the Stripe Account object and update local status.
    Use this after the tenant completes outstanding Stripe requirements.
    """
    svc = StripeConnectService(db)
    svc.sync_status(
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return svc.get_status_dict(current_user.organization_id)


@router.post("/disconnect")
def disconnect(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    _admin=Depends(get_current_billing_admin),
):
    """Mark the tenant's Stripe connected account as DISCONNECTED.

    This stops Zoiko from routing payments through this account.  The tenant
    can re-connect at any time via the /onboarding-url → /callback flow.

    Note: This does NOT call Stripe's deauthorize endpoint.  If the tenant
    also wants to remove Zoiko's platform access from the Stripe Dashboard,
    they must do that separately.
    """
    svc = StripeConnectService(db)
    svc.disconnect(
        organization_id=current_user.organization_id,
        updated_by=current_user.id,
    )
    return svc.get_status_dict(current_user.organization_id)
