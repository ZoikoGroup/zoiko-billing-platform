"""modules/billing/services/stripe_connect_service.py

Plane 2 — Stripe Connect onboarding and account management.

Each tenant owns exactly one Stripe Standard connected account per environment
(test / live).  Zoiko acts as the Connect Platform: it initiates the OAuth-
style onboarding redirect and syncs account status back via the
/stripe/connect/* endpoints.  The tenant (not Zoiko) is always the merchant
of record for charges made against their connected account.

Security model
--------------
- No per-tenant Stripe *secret* key is ever stored.  Every API call uses
  Zoiko's own STRIPE_SECRET_KEY plus the non-secret connected_account_id as
  the stripe_account header (on_behalf_of / Stripe-Account).
- connected_account_id is treated as a database identifier, not a caller-
  supplied credential: we look it up from our own DB row before trusting it.
- Stripe Connect client ID (STRIPE_CONNECT_CLIENT_ID) is the OAuth identifier
  for Zoiko's platform; it is NOT a secret and is safe to return in API
  responses.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import (
    IntegrationConnectionStatus,
    IntegrationEnvironment,
    StripeConnectedAccount,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.models import BillingAuditAction

logger = logging.getLogger("zoiko_billing")


def _stripe_module():
    """Lazy Stripe import — same pattern as StripeService so the app can boot
    without the package installed."""
    try:
        import stripe  # noqa: PLC0415
    except ImportError:
        raise BadRequestException(
            "The 'stripe' package is not installed. Add stripe to requirements.txt and reinstall."
        )
    if not settings.STRIPE_SECRET_KEY:
        raise BadRequestException(
            "Stripe is not configured. Set STRIPE_SECRET_KEY in the environment."
        )
    stripe.api_key = settings.STRIPE_SECRET_KEY
    configure_stripe_runtime(stripe)
    return stripe


def configure_stripe_runtime(stripe) -> None:
    """Process-wide Stripe transport hardening (applied once per process).

    - max_network_retries: the stripe-python SDK automatically retries
      transient connection errors / timeouts AND reuses ONE auto-generated
      idempotency key per logical POST across those transport retries, so a
      network blip can never double-charge.  We pin it from settings instead
      of relying on the SDK default so the policy is explicit and auditable.
    - timeout: bound each HTTP attempt (SDK default is 80s, far too long for
      an interactive request path).  Applied via RequestsClient; if the
      private http-client module ever moves, we degrade gracefully to the SDK
      default rather than breaking imports.
    """
    retries = int(getattr(settings, "STRIPE_MAX_NETWORK_RETRIES", 2) or 0)
    if getattr(stripe, "max_network_retries", None) != retries:
        stripe.max_network_retries = retries
    timeout = float(getattr(settings, "STRIPE_TIMEOUT_SECONDS", 25) or 25)
    if getattr(stripe, "default_http_client", None) is None:
        try:
            from stripe import _http_client as _stripe_http_client  # noqa: PLC0415

            stripe.default_http_client = _stripe_http_client.RequestsClient(
                timeout=timeout,
            )
        except Exception:  # pragma: no cover - defensive; keep SDK defaults
            logger.warning("[stripe] Could not set custom HTTP client timeout; using SDK default")


def _resolve_environment() -> IntegrationEnvironment:
    """Derive test/live from the secret key prefix — sk_test_ means test.
    An UNCONFIGURED platform (empty key) resolves to TEST: no outbound call
    can happen anyway, and this keeps dev/test data out of the LIVE bucket."""
    key = settings.STRIPE_SECRET_KEY or ""
    return (
        IntegrationEnvironment.LIVE
        if key.startswith("sk_live_")
        else IntegrationEnvironment.TEST
    )


# ── Centralized connected-account resolution (GAP-1 remediation) ─────────────
#
# Single source of truth for "which Stripe account does THIS tenant's money
# movement go through".  Every financial Stripe call in StripeService resolves
# through resolve_connected_account()/resolve_connected_account_id() — account
# lookup logic must never be duplicated (or weakened) at call sites.
#
# Resolution chain (trusted backend data only):
#   authenticated organization_id → stripe_connected_accounts row (org + env)
#                                 → ACTIVE status + charges_enabled
#                                 → connected_account_id → Stripe-Account header
#
# Fail-safe: any missing/inactive/mis-scoped connection raises BEFORE any
# outbound Stripe request — no customer, session, intent, or refund is ever
# created against the platform account by accident.


def get_connected_account_row(
    db: Session,
    organization_id: int,
    env: Optional[IntegrationEnvironment] = None,
) -> Optional[StripeConnectedAccount]:
    """Return the tenant's connected-account row for the CURRENT environment
    (derived from the configured secret key), without status filtering."""
    if env is None:
        env = _resolve_environment()
    return (
        db.query(StripeConnectedAccount)
        .filter(
            StripeConnectedAccount.organization_id == organization_id,
            StripeConnectedAccount.environment == env,
        )
        .first()
    )


def resolve_connected_account(db: Session, organization_id: int) -> StripeConnectedAccount:
    """Resolve the tenant's ACTIVE connected Stripe account — fail-safe.

    Raises BadRequestException (never returns None, never falls back to the
    platform account) when:
      - no connection row exists for this org in the current environment;
      - the connection is not ACTIVE (pending onboarding, restricted, ...);
      - the connection exists but Stripe-side charges are disabled.
    """
    row = get_connected_account_row(db, organization_id)
    if row is None:
        raise BadRequestException(
            "Stripe is not connected for this organization. Complete Stripe Connect "
            "onboarding before processing payments."
        )
    if row.status != IntegrationConnectionStatus.ACTIVE:
        raise BadRequestException(
            f"Stripe connection is not active for this organization "
            f"(status={row.status.value}). Payments are blocked until the "
            f"connection is active."
        )
    if not row.charges_enabled:
        raise BadRequestException(
            "Stripe connection is active but charges are disabled for this "
            "account. Payments are blocked."
        )
    return row


def resolve_connected_account_id(db: Session, organization_id: int) -> str:
    """Convenience wrapper returning just the connected_account_id to pass as
    stripe_account=... on every financial Stripe API call."""
    return resolve_connected_account(db, organization_id).connected_account_id


# ── OAuth state signing (CON-2 CSRF remediation) ─────────────────────────────
#
# The OAuth `state` parameter is issued server-side as an HMAC-signed,
# organization-bound, time-limited token.  The callback endpoint refuses to
# exchange an authorization_code unless the state verifies against the SAME
# authenticated organization, which prevents forged callbacks, state
# substitution, and cross-tenant account linking.

_OAUTH_STATE_TTL_SECONDS = int(getattr(settings, "STRIPE_OAUTH_STATE_TTL_SECONDS", 600))


def _oauth_state_secret() -> bytes:
    raw = getattr(settings, "BILLING_SECRET_KEY", "") or ""
    if not isinstance(raw, str):
        raw = str(raw)
    return (raw or "insecure-dev-secret").encode()


def issue_oauth_state(organization_id: int) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"org": int(organization_id), "iat": int(time.time())}).encode()
    ).decode().rstrip("=")
    sig = hmac.new(_oauth_state_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_oauth_state(state: Optional[str], organization_id: int) -> bool:
    if not state or "." not in state:
        return False
    payload, sig = state.rsplit(".", 1)
    expected = hmac.new(_oauth_state_secret(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        padded = payload + "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except Exception:
        return False
    if int(data.get("org", -1)) != int(organization_id):
        return False
    issued_at = int(data.get("iat", 0))
    return 0 < issued_at and (int(time.time()) - issued_at) <= _OAUTH_STATE_TTL_SECONDS


def _derive_status(acct: Dict[str, Any]) -> IntegrationConnectionStatus:
    """Map raw Stripe Account fields to our IntegrationConnectionStatus."""
    if not acct.get("details_submitted"):
        return IntegrationConnectionStatus.ONBOARDING_INCOMPLETE
    reqs = acct.get("requirements") or {}
    currently_due = reqs.get("currently_due") or []
    if currently_due:
        return IntegrationConnectionStatus.ACTION_REQUIRED
    if acct.get("charges_enabled") and acct.get("payouts_enabled"):
        return IntegrationConnectionStatus.ACTIVE
    if not acct.get("charges_enabled"):
        return IntegrationConnectionStatus.RESTRICTED
    return IntegrationConnectionStatus.RESTRICTED


class StripeConnectService:
    """Service for managing tenant Stripe Connect Standard accounts."""

    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _get_account(
        self, organization_id: int, env: Optional[IntegrationEnvironment] = None,
    ) -> Optional[StripeConnectedAccount]:
        q = self.db.query(StripeConnectedAccount).filter(
            StripeConnectedAccount.organization_id == organization_id,
        )
        if env:
            q = q.filter(StripeConnectedAccount.environment == env)
        return q.first()

    def _require_account(self, organization_id: int) -> StripeConnectedAccount:
        row = self._get_account(organization_id)
        if row is None:
            raise NotFoundException("StripeConnectedAccount", organization_id)
        return row

    # ── OAuth onboarding URL (Standard account) ───────────────────────────

    def get_onboarding_url(
        self,
        organization_id: int,
        redirect_uri: str,
    ) -> Dict[str, Any]:
        """Return the Stripe Connect OAuth URL the tenant's browser should be
        directed to.  We do NOT create the Account object here — Stripe creates
        it when the tenant completes the form; we receive the authorization_code
        in the callback endpoint below.

        The `state` parameter is ALWAYS issued server-side (HMAC-signed,
        organization-bound, short-TTL — see issue_oauth_state).  Client-supplied
        state values are ignored: they were the CON-2 CSRF vector.

        STRIPE_CONNECT_CLIENT_ID must be set to Zoiko's Connect Platform client_id.
        """
        client_id = getattr(settings, "STRIPE_CONNECT_CLIENT_ID", "") or ""
        if not client_id:
            raise BadRequestException(
                "Stripe Connect is not configured (STRIPE_CONNECT_CLIENT_ID is missing)"
            )
        params: Dict[str, str] = {
            "client_id": client_id,
            "response_type": "code",
            "scope": "read_write",
            "redirect_uri": redirect_uri,
            "stripe_user[business_type]": "company",
            "state": issue_oauth_state(organization_id),
        }
        base = "https://connect.stripe.com/oauth/authorize"
        url = base + "?" + urllib.parse.urlencode(params)
        return {"url": url, "client_id": client_id, "state": params["state"]}

    # ── OAuth callback (exchange code for account_id) ────────────────────

    def complete_oauth(
        self,
        organization_id: int,
        authorization_code: str,
        created_by: Optional[int] = None,
        state: Optional[str] = None,
    ) -> StripeConnectedAccount:
        """Exchange an OAuth authorization_code for a Stripe connected_account_id
        and persist the StripeConnectedAccount row.

        The `state` token issued by get_onboarding_url is MANDATORY and must
        verify (HMAC signature + organization binding + TTL) before any code
        exchange happens — this closes CON-2 (OAuth CSRF / account linking to
        the wrong tenant).

        Idempotent: if the organization already has a row for this environment,
        we sync the latest status from Stripe rather than creating a duplicate.
        """
        if not verify_oauth_state(state, organization_id):
            raise BadRequestException(
                "Invalid, expired, or missing OAuth state parameter. Restart the "
                "Connect onboarding flow."
            )
        stripe = _stripe_module()
        env = _resolve_environment()

        # Exchange code → Stripe account id
        try:
            response = stripe.OAuth.token(  # type: ignore[attr-defined]
                grant_type="authorization_code",
                code=authorization_code,
            )
        except Exception as e:
            raise BadRequestException(f"Stripe Connect OAuth token exchange failed: {e}")

        account_id = response.get("stripe_user_id")
        if not account_id:
            raise BadRequestException("Stripe OAuth response did not contain stripe_user_id")

        # Retrieve full account details for capability/status sync
        try:
            acct = stripe.Account.retrieve(account_id)
            acct = acct.to_dict() if hasattr(acct, "to_dict") else acct
        except Exception as e:
            raise BadRequestException(f"Could not retrieve Stripe account {account_id}: {e}")

        status = _derive_status(acct)
        now = datetime.utcnow()

        existing = self._get_account(organization_id, env)
        if existing:
            # Already onboarded — just sync latest state
            self._sync_account_fields(existing, acct, status, now)
            try:
                self.db.commit()
                self.db.refresh(existing)
            except Exception:
                self.db.rollback()
                raise
            self.audit.log(
                organization_id, created_by, BillingAuditAction.UPDATE,
                "StripeConnectedAccount", existing.id,
                new_values={"status": status.value, "connected_account_id": account_id},
            )
            return existing

        row = StripeConnectedAccount(
            organization_id=organization_id,
            environment=env,
            connected_account_id=account_id,
            account_type="standard",
            country=acct.get("country"),
            default_currency=(acct.get("default_currency") or "").upper() or None,
            charges_enabled=bool(acct.get("charges_enabled")),
            payouts_enabled=bool(acct.get("payouts_enabled")),
            details_submitted=bool(acct.get("details_submitted")),
            capabilities=acct.get("capabilities"),
            requirements_currently_due=((acct.get("requirements") or {}).get("currently_due")),
            disabled_reason=(acct.get("requirements") or {}).get("disabled_reason"),
            status=status,
            connected_at=now if status == IntegrationConnectionStatus.ACTIVE else None,
            created_by=created_by,
        )
        self.db.add(row)
        try:
            self.db.commit()
            self.db.refresh(row)
        except IntegrityError:
            self.db.rollback()
            # Race: another request created the row; fetch and return it
            row = self._require_account(organization_id)
        self.audit.log(
            organization_id, created_by, BillingAuditAction.CREATE,
            "StripeConnectedAccount", row.id,
            new_values={"connected_account_id": account_id, "status": status.value},
        )
        return row

    # ── Status sync ────────────────────────────────────────────────────────

    def sync_status(
        self, organization_id: int, updated_by: Optional[int] = None,
    ) -> StripeConnectedAccount:
        """Re-fetch the Stripe Account object and update our local status row.
        Called by a periodic job or by the tenant from the Settings UI.
        """
        row = self._require_account(organization_id)
        stripe = _stripe_module()
        try:
            acct = stripe.Account.retrieve(row.connected_account_id)
            acct = acct.to_dict() if hasattr(acct, "to_dict") else acct
        except Exception as e:
            raise BadRequestException(
                f"Could not retrieve Stripe account {row.connected_account_id}: {e}"
            )
        status = _derive_status(acct)
        self._sync_account_fields(row, acct, status, datetime.utcnow())
        try:
            self.db.commit()
            self.db.refresh(row)
        except Exception:
            self.db.rollback()
            raise
        return row

    def _sync_account_fields(
        self,
        row: StripeConnectedAccount,
        acct: Dict[str, Any],
        status: IntegrationConnectionStatus,
        now: datetime,
    ) -> None:
        row.charges_enabled = bool(acct.get("charges_enabled"))
        row.payouts_enabled = bool(acct.get("payouts_enabled"))
        row.details_submitted = bool(acct.get("details_submitted"))
        row.capabilities = acct.get("capabilities")
        row.requirements_currently_due = ((acct.get("requirements") or {}).get("currently_due"))
        row.disabled_reason = ((acct.get("requirements") or {}).get("disabled_reason"))
        row.country = acct.get("country") or row.country
        row.default_currency = (acct.get("default_currency") or "").upper() or row.default_currency
        row.status = status
        row.last_synced_at = now
        if status == IntegrationConnectionStatus.ACTIVE and not row.connected_at:
            row.connected_at = now

    # ── Disconnect ────────────────────────────────────────────────────────

    def disconnect(
        self, organization_id: int, updated_by: Optional[int] = None,
    ) -> StripeConnectedAccount:
        """Mark the account as DISCONNECTED.  We do NOT call Stripe's deauth
        endpoint here — that must be triggered separately by the tenant from
        the Stripe dashboard or a future dedicated API call, because it has
        irreversible platform-side effects.  We simply stop using the account.
        """
        row = self._require_account(organization_id)
        row.status = IntegrationConnectionStatus.DISCONNECTED
        row.disconnected_at = datetime.utcnow()
        try:
            self.db.commit()
            self.db.refresh(row)
        except Exception:
            self.db.rollback()
            raise
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE,
            "StripeConnectedAccount", row.id,
            new_values={"status": IntegrationConnectionStatus.DISCONNECTED.value},
        )
        return row

    # ── Read ─────────────────────────────────────────────────────────────

    def get_status(self, organization_id: int) -> Optional[StripeConnectedAccount]:
        return self._get_account(organization_id)

    def get_status_dict(self, organization_id: int) -> Dict[str, Any]:
        """Return a safe, frontend-consumable status summary (no secrets)."""
        row = self._get_account(organization_id)
        if row is None:
            return {
                "connected": False,
                "status": IntegrationConnectionStatus.PENDING_ONBOARDING.value,
            }
        return {
            "connected": row.status == IntegrationConnectionStatus.ACTIVE,
            "status": row.status.value,
            "environment": row.environment.value,
            "connected_account_id": row.connected_account_id,
            "country": row.country,
            "default_currency": row.default_currency,
            "charges_enabled": row.charges_enabled,
            "payouts_enabled": row.payouts_enabled,
            "details_submitted": row.details_submitted,
            "capabilities": row.capabilities,
            "requirements_currently_due": row.requirements_currently_due,
            "disabled_reason": row.disabled_reason,
            "connected_at": row.connected_at.isoformat() if row.connected_at else None,
            "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        }
