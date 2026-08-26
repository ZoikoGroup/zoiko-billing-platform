"""
modules/auth/router.py
----------------------
Authentication + user management endpoints.

Public:    /auth/register, /auth/login, /auth/refresh, /auth/forgot-password,
           /auth/reset-password (GET form + POST), /auth/accept-invite
           (GET form + POST)
Any user:  /auth/me, /auth/logout, /auth/change-password
Org admin: /auth/admin/users (list/create/update/deactivate/reset)
"""

import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.core.dependencies import get_current_org_admin, get_current_user
from app.core.exceptions import BadRequestException
from app.core.rate_limiter import limiter
from app.database import get_db
from app.modules.auth import service
from app.modules.auth.country_currency import country_defaults
from app.modules.auth.models import SecurityActionPurpose, User, UserRole
from app.modules.auth.schemas import (
    ChangePasswordRequest,
    CountryDefaultsResponse,
    ForgotPasswordRequest,
    LoginRequest,
    MFADisableRequest,
    MFASetupStartResponse,
    MFASetupVerifyRequest,
    MFASetupVerifyResponse,
    MFAStatusResponse,
    RefreshRequest,
    RegisterRequest,
    SuccessResponse,
    TokenPasswordRequest,
    TokenResponse,
    UserCreateRequest,
    UserListResponse,
    UserResponse,
    UserUpdateRequest,
)

logger = logging.getLogger("zoiko_billing.auth")

router = APIRouter(prefix="/auth", tags=["Authentication"])
user_router = APIRouter(prefix="/auth/admin", tags=["User Management"])


def _invalid_token_page() -> HTMLResponse:
    return HTMLResponse(
        status_code=400,
        content=(
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head>"
            "<body style=\"font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px;\">"
            "<div style=\"max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;"
            "padding:32px;text-align:center;\">"
            "<h1 style=\"color:#FF7A00;\">Zoiko Billing</h1>"
            "<p style=\"color:#374151;line-height:1.6;\">This link is no longer valid. Please request a new one.</p>"
            "</div></body></html>"
        ),
    )


def _action_form_page(title: str, token: str, action_path: str) -> HTMLResponse:
    return HTMLResponse(
        content=(
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head>"
            "<body style=\"font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px;\">"
            "<div style=\"max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;\">"
            f"<h1 style=\"color:#FF7A00;\">{title}</h1>"
            "<p style=\"color:#6B7280;font-size:13px;\">Choose a strong password you have not used for this account before.</p>"
            "<input id=\"password\" type=\"password\" placeholder=\"New password (min 8 characters)\" "
            "style=\"width:100%;padding:12px;margin:12px 0;border:1px solid #D1D5DB;border-radius:8px;box-sizing:border-box;\"/>"
            "<p id=\"error\" style=\"color:#DC2626;font-size:13px;display:none;\"></p>"
            "<button onclick=\"submitForm()\" "
            "style=\"width:100%;background:#FF7A00;color:#ffffff;padding:12px;border:none;border-radius:24px;"
            "font-size:15px;font-weight:bold;cursor:pointer;\">Continue</button>"
            "<script>"
            f"var TOKEN={json.dumps(token)};"
            f"var PATH={json.dumps(action_path)};"
            "var busy=false;"
            "function submitForm(){"
            "if(busy)return;"
            "var p=document.getElementById('password').value;"
            "var e=document.getElementById('error');"
            "if(!p||p.length<8){e.textContent='Password must be at least 8 characters.';e.style.display='block';return;}"
            "busy=true;"
            "document.querySelector('button').disabled=true;"
            "document.querySelector('button').textContent='Submitting…';"
            "fetch(PATH,{method:'POST',headers:{'Content-Type':'application/json'},"
            "body:JSON.stringify({token:TOKEN,password:p})})"
            ".then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j};});})"
            ".then(function(res){"
            "if(res.ok){document.body.innerHTML="
            "'<div style=\"max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;text-align:center;\">"
            "<h1 style=\"color:#059669;\">All set</h1><p style=\"color:#374151;\">Your password has been set. "
            "<a href=\"" + settings.FRONTEND_URL + "/login\">Sign in to Zoiko Billing</a>.</p></div>';}"
            "else{busy=false;document.querySelector('button').disabled=false;document.querySelector('button').textContent='Continue';e.textContent=res.json.detail||'Something went wrong.';e.style.display='block';}"
            "})"
            ".catch(function(){busy=false;document.querySelector('button').disabled=false;document.querySelector('button').textContent='Continue';e.textContent='Network error. Please try again.';e.style.display='block';});}"
            "</script>"
            "</div></body></html>"
        ),
    )


# ── Public auth ─────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse, summary="Login and get access token")
@limiter.limit("10/minute")
def login(request: Request, data: LoginRequest, db: Session = Depends(get_db)):
    # ZB-SA-CMD-003 v3.0 master directive: a valid password yields tokens for
    # EVERY role, including super_admin. There is no login-time MFA challenge
    # and no enrollment redirect; MFA is enforced only as a step-up at the
    # moment of privileged actions (see /auth/mfa/* below).
    return service.login_user(db, data.email, data.password)


# ── Super Admin MFA (step-up factor management) ─────────────────────────────
# ZB-SA-CMD-003 v3.0: MFA is NOT part of login. These endpoints let an
# already-authenticated Super Admin manage the TOTP factor that
# mfa_service.verify_step_up() enforces at the moment of privileged actions
# (tenant-access activation, circuit-breaker changes, approval decisions).
# Every endpoint requires a real access token via get_current_user.

@router.post(
    "/mfa/setup/start", response_model=MFASetupStartResponse,
    summary="Begin Super Admin MFA enrollment (issues a TOTP secret)",
)
@limiter.limit("10/minute")
def mfa_setup_start(request: Request, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    from app.modules.auth import mfa_service

    _require_super_admin(current_user)
    return mfa_service.start_enrollment(db, current_user)


@router.post(
    "/mfa/setup/verify", response_model=MFASetupVerifyResponse,
    summary="Confirm Super Admin MFA enrollment with a TOTP code",
)
@limiter.limit("10/minute")
def mfa_setup_verify(request: Request, data: MFASetupVerifyRequest, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    from app.modules.auth import mfa_service

    _require_super_admin(current_user)
    return mfa_service.verify_enrollment(db, current_user, data.code)


@router.get(
    "/mfa/status", response_model=MFAStatusResponse,
    summary="Whether the calling Super Admin has MFA enabled for step-up",
)
def mfa_status(current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    from app.modules.auth import mfa_service

    _require_super_admin(current_user)
    return {"enabled": mfa_service.is_mfa_enabled(db, current_user.id)}


@router.post(
    "/mfa/disable", response_model=SuccessResponse,
    summary="Disable MFA on your own Super Admin account (requires current password)",
)
@limiter.limit("3/minute")
def mfa_disable(request: Request, data: MFADisableRequest, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    from app.modules.auth import mfa_service

    _require_super_admin(current_user)
    return mfa_service.disable_mfa_self(db, current_user, data.current_password)


def _require_super_admin(user) -> None:
    if user.role != UserRole.SUPER_ADMIN:
        raise BadRequestException("MFA is only available for Super Admin accounts.")


@router.post("/register", response_model=TokenResponse, summary="Register a new organization")
@limiter.limit("5/minute")
def register(
    request: Request,
    data: RegisterRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return service.register_enterprise(db, data, background_tasks=background_tasks)


@router.get(
    "/country-defaults",
    response_model=CountryDefaultsResponse,
    summary="Authoritative country → default currency map for registration UX",
)
def get_registration_country_defaults():
    """Public, unauthenticated map consumed by the registration form so its
    currency auto-suggest comes from the same authoritative definition the
    backend persists (auth/country_currency.py)."""
    return country_defaults()


@router.post("/refresh", response_model=TokenResponse, summary="Refresh access token")
@limiter.limit("30/minute")
def refresh_token(request: Request, data: RefreshRequest, db: Session = Depends(get_db)):
    return service.refresh_user_token(db, data.refresh_token)


@router.get("/me", response_model=UserResponse, summary="Get current logged-in user")
def get_me(current_user=Depends(get_current_user)):
    return current_user


@router.post("/logout", response_model=SuccessResponse, summary="Logout")
def logout(current_user=Depends(get_current_user), request: Request = None):
    logger.info("User %s logged out", current_user.email)
    return {"message": "Logged out successfully."}


@router.post("/change-password", response_model=SuccessResponse, summary="Change current user password")
@limiter.limit("5/minute")
def change_password(
    request: Request,
    data: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    return service.change_password(db, current_user.id, data.current_password, data.new_password)


@router.post("/forgot-password", response_model=SuccessResponse, summary="Request password reset link")
@limiter.limit("5/minute")
def forgot_password(request: Request, data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    return service.request_password_reset(db, data.email)


@router.get("/accept-invite", response_class=HTMLResponse, summary="Account-setup form from invite link", include_in_schema=False)
def accept_invite_form(token: str = Query(...), db: Session = Depends(get_db)):
    ctx = service.validate_action_token(db, token, SecurityActionPurpose.INVITE)
    if ctx is None:
        return _invalid_token_page()
    return _action_form_page("Set up your account", ctx["token"], "/auth/accept-invite")


@router.get("/validate-invite", summary="Validate an invitation token and return metadata (JSON)")
def validate_invite_token(token: str = Query(...), db: Session = Depends(get_db)):
    from sqlalchemy import text as sql_text
    import hashlib
    from app.modules.auth.service import _token_hash
    from app.modules.auth.models import SecurityActionPurpose
    from app.modules.organizations.models import Organization

    token_hash = _token_hash(token)
    row = db.execute(
        sql_text("SELECT email, organization_id, expires_at, used_at, purpose FROM security_action_tokens WHERE token_hash = :hash"),
        {"hash": token_hash},
    ).fetchone()
    if row is None:
        return {"valid": False, "error": "invalid_token"}
    email, organization_id, expires_at, used_at, purpose_stored = row
    if purpose_stored != SecurityActionPurpose.INVITE.name:
        return {"valid": False, "error": "invalid_token"}
    if used_at is not None:
        return {"valid": False, "error": "already_accepted"}
    from datetime import datetime
    if expires_at <= datetime.utcnow():
        return {"valid": False, "error": "expired"}
    org_name = ""
    if organization_id:
        org = db.query(Organization).filter(Organization.id == organization_id).first()
        org_name = org.organization_name if org else ""
    return {"valid": True, "email": email, "organization_name": org_name}


@router.post("/accept-invite", summary="Complete account setup from invitation link")
@limiter.limit("10/minute")
def accept_invite(request: Request, data: TokenPasswordRequest, db: Session = Depends(get_db)):
    return service.complete_action_token(db, data.token, SecurityActionPurpose.INVITE, data.password)


@router.get("/reset-password", response_class=HTMLResponse, summary="Password-reset form from reset link", include_in_schema=False)
def reset_password_form(token: str = Query(...), db: Session = Depends(get_db)):
    ctx = service.validate_action_token(db, token, SecurityActionPurpose.RESET)
    if ctx is None:
        return _invalid_token_page()
    return _action_form_page("Reset your password", ctx["token"], "/auth/reset-password")


@router.get("/validate-reset", summary="Validate a password-reset token and return metadata (JSON)")
def validate_reset_token(token: str = Query(...), db: Session = Depends(get_db)):
    from sqlalchemy import text as sql_text
    from app.modules.auth.service import _token_hash
    from app.modules.auth.models import SecurityActionPurpose

    token_hash = _token_hash(token)
    row = db.execute(
        sql_text("SELECT email, organization_id, expires_at, used_at, purpose FROM security_action_tokens WHERE token_hash = :hash"),
        {"hash": token_hash},
    ).fetchone()
    if row is None:
        return {"valid": False, "error": "invalid_token"}
    email, organization_id, expires_at, used_at, purpose_stored = row
    if purpose_stored != SecurityActionPurpose.RESET.name:
        return {"valid": False, "error": "invalid_token"}
    if used_at is not None:
        return {"valid": False, "error": "already_used"}
    from datetime import datetime
    if expires_at <= datetime.utcnow():
        return {"valid": False, "error": "expired"}
    return {"valid": True, "email": email}


@router.post("/reset-password", summary="Set a new password from a reset link")
@limiter.limit("10/minute")
def reset_password(request: Request, data: TokenPasswordRequest, db: Session = Depends(get_db)):
    return service.complete_action_token(db, data.token, SecurityActionPurpose.RESET, data.password)


# ── Org admin user management ───────────────────────────────────────────────

@user_router.get("/users", response_model=UserListResponse, summary="List users in your organization")
def list_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = Query(""),
    current_user=Depends(get_current_org_admin),
    db: Session = Depends(get_db),
):
    from app.core.dependencies import get_organization_id

    org_id = get_organization_id(current_user)
    query = db.query(User).filter(User.organization_id == org_id)
    if search:
        like = f"%{search}%"
        query = query.filter(
            (User.email.ilike(like)) | (User.first_name.ilike(like)) | (User.last_name.ilike(like))
        )
    total = query.count()
    users = query.order_by(User.created_at.desc()).offset(skip).limit(limit).all()
    return UserListResponse(users=users, total=total)


@user_router.post("/users", response_model=UserResponse, summary="Invite a user into your organization")
def create_user(
    data: UserCreateRequest,
    current_user=Depends(get_current_org_admin),
    db: Session = Depends(get_db),
):
    return service.invite_user(db, current_user, data)


@user_router.put("/users/{user_id}", response_model=UserResponse, summary="Update a user in your organization")
def update_user(
    user_id: int,
    data: UserUpdateRequest,
    current_user=Depends(get_current_org_admin),
    db: Session = Depends(get_db),
):
    from app.core.dependencies import get_organization_id, can_create_role

    org_id = get_organization_id(current_user)
    user = db.query(User).filter(User.id == user_id, User.organization_id == org_id).first()
    if user is None:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("User", "id")

    if data.role is not None and data.role != user.role:
        if not can_create_role(current_user.role.value, data.role.value):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException(f"Cannot assign role {data.role.value}.")

    for field, value in data.model_dump(exclude_unset=True).items():
        if field == "role" and value is not None:
            user.role = value
        elif value is not None or field in {"phone", "is_active"}:
            setattr(user, field, value)
    db.commit()
    db.refresh(user)
    return user


@user_router.delete("/users/{user_id}", response_model=SuccessResponse, summary="Deactivate a user")
def deactivate_user(
    user_id: int,
    current_user=Depends(get_current_org_admin),
    db: Session = Depends(get_db),
):
    from app.core.dependencies import get_organization_id
    from app.core.exceptions import NotFoundException, BadRequestException

    org_id = get_organization_id(current_user)
    user = db.query(User).filter(User.id == user_id, User.organization_id == org_id).first()
    if user is None:
        raise NotFoundException("User", "id")
    if user.id == current_user.id:
        raise BadRequestException("You cannot deactivate your own account.")
    user.is_active = False
    db.commit()
    return {"message": "User deactivated successfully."}


@user_router.post("/users/{user_id}/resend-invite", response_model=SuccessResponse, summary="Resend invite email")
def resend_invite(
    user_id: int,
    current_user=Depends(get_current_org_admin),
    db: Session = Depends(get_db),
):
    from app.core.dependencies import get_organization_id
    from app.core.exceptions import NotFoundException

    org_id = get_organization_id(current_user)
    user = db.query(User).filter(User.id == user_id, User.organization_id == org_id).first()
    if user is None:
        raise NotFoundException("User", "id")
    if user.is_verified:
        raise BadRequestException("This user has already set up their account.")

    raw_token, _ = service._issue_action_token(db, user.email, user.organization_id, SecurityActionPurpose.INVITE)
    link = service._action_link(SecurityActionPurpose.INVITE, raw_token)
    service._send_invite_email(db, user, current_user, link)
    db.commit()
    return {"message": "Invite email resent."}
