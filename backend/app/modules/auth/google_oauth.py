"""
modules/auth/google_oauth.py
----------------------------
"Continue with Google" — OAuth 2.0 authorization-code flow.

  GET /auth/google/login     -> 302 to Google's consent screen (signed state)
  GET /auth/google/callback  -> exchanges the code, requires a verified email
                                that matches an EXISTING active user, then
                                302s to the SPA with the session in the URL
                                fragment (never sent to servers / logs).

Accounts are never auto-created from Google identities: an unknown email is
sent to /register with a signed ticket and is created only when the
registration form is submitted.
"""

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, UnauthorizedException
from app.core.rate_limiter import limiter
from app.database import get_db
from app.modules.auth import service
from app.modules.auth.schemas import UserResponse

logger = logging.getLogger("zoiko_billing.auth.google")

router = APIRouter(prefix="/auth/google", tags=["Authentication"])

_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
_STATE_TTL_SECONDS = 600
_SIGNUP_TICKET_TTL_SECONDS = 1800


def _enabled() -> bool:
    return bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET)


def _make_state() -> str:
    return jwt.encode(
        {
            "nonce": secrets.token_urlsafe(16),
            "type": "google_state",
            "iss": settings.JWT_ISSUER,
            "exp": datetime.now(timezone.utc) + timedelta(seconds=_STATE_TTL_SECONDS),
        },
        settings.BILLING_SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )


def _state_valid(state: Optional[str]) -> bool:
    if not state:
        return False
    try:
        payload = jwt.decode(
            state, settings.BILLING_SECRET_KEY,
            algorithms=[settings.ALGORITHM], issuer=settings.JWT_ISSUER,
        )
    except JWTError:
        return False
    return payload.get("type") == "google_state"


def _make_signup_ticket(email: str, name: str) -> str:
    return jwt.encode(
        {
            "email": email,
            "name": name,
            "type": "google_signup",
            "iss": settings.JWT_ISSUER,
            "exp": datetime.now(timezone.utc) + timedelta(seconds=_SIGNUP_TICKET_TTL_SECONDS),
        },
        settings.BILLING_SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )


def read_signup_ticket(ticket: str) -> Optional[dict]:
    """Return {"email", "name"} for a valid Google signup ticket, else None."""
    try:
        payload = jwt.decode(
            ticket, settings.BILLING_SECRET_KEY,
            algorithms=[settings.ALGORITHM], issuer=settings.JWT_ISSUER,
        )
    except JWTError:
        return None
    if payload.get("type") != "google_signup" or not payload.get("email"):
        return None
    return {"email": payload["email"], "name": payload.get("name") or ""}


def _login_redirect(**params: str) -> RedirectResponse:
    base = settings.FRONTEND_URL.rstrip("/") + "/login"
    return RedirectResponse(f"{base}?{urlencode(params)}", status_code=302)


@router.get("/login", summary="Start Google sign-in")
@limiter.limit("20/minute")
def google_login(request: Request):
    if not _enabled():
        return _login_redirect(google_error="not_configured")
    query = urlencode({
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": _make_state(),
        "prompt": "select_account",
    })
    return RedirectResponse(f"{_AUTH_URL}?{query}", status_code=302)


@router.get("/callback", summary="Google sign-in callback")
@limiter.limit("20/minute")
def google_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
):
    if not _enabled():
        return _login_redirect(google_error="not_configured")
    if error or not code:
        return _login_redirect(google_error="cancelled")
    if not _state_valid(state):
        return _login_redirect(google_error="invalid_state")

    try:
        with httpx.Client(timeout=10) as client:
            token_res = client.post(_TOKEN_URL, data={
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": settings.GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            })
            if token_res.status_code != 200:
                logger.warning("Google token exchange failed: %s", token_res.status_code)
                return _login_redirect(google_error="exchange_failed")
            info_res = client.get(
                _USERINFO_URL,
                headers={"Authorization": f"Bearer {token_res.json().get('access_token', '')}"},
            )
            if info_res.status_code != 200:
                return _login_redirect(google_error="exchange_failed")
            info = info_res.json()
    except (httpx.HTTPError, ValueError):
        logger.exception("Google sign-in network failure")
        return _login_redirect(google_error="exchange_failed")

    email = (info.get("email") or "").strip()
    if not email or info.get("email_verified") is not True:
        return _login_redirect(google_error="unverified_email")

    try:
        data = service.login_user_via_google(db, email)
    except UnauthorizedException as exc:
        msg = str(getattr(exc, "message", "") or "").lower()
        if "suspended" in msg or "deactivated" in msg:
            return _login_redirect(google_error="inactive")
        # No account yet: never create one here. Send the verified identity to
        # registration; the account is created (and logged in) only once the
        # registration form is completed.
        fragment = urlencode({
            "google_ticket": _make_signup_ticket(email, info.get("name") or ""),
            "email": email,
            "name": info.get("name") or "",
        })
        return RedirectResponse(
            f"{settings.FRONTEND_URL.rstrip('/')}/register#{fragment}", status_code=302,
        )
    except BadRequestException:
        return _login_redirect(google_error="exchange_failed")

    user_json = UserResponse.model_validate(data["user"]).model_dump_json()
    fragment = urlencode({
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "user": user_json,
    })
    base = settings.FRONTEND_URL.rstrip("/") + "/login"
    return RedirectResponse(f"{base}#{fragment}", status_code=302)
