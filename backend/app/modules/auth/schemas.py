"""
modules/auth/schemas.py
-----------------------
"""
import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.modules.auth.country_currency import is_valid_currency_code
from app.modules.auth.models import UserRole


# ── Auth ────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)


class RegisterRequest(BaseModel):
    organization: str = Field(..., min_length=1, max_length=200)
    legal_name: Optional[str] = Field(None, min_length=1, max_length=255)
    name: str = Field(..., min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    industry: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = Field(None, max_length=100)
    state: Optional[str] = Field(None, max_length=100)
    country: Optional[str] = Field(None, max_length=100)
    postal_code: Optional[str] = Field(None, max_length=20)
    website: Optional[str] = Field(None, max_length=500)
    timezone: Optional[str] = "UTC"
    phone: Optional[str] = None
    currency: Optional[str] = "USD"
    tax_no: Optional[str] = Field(None, max_length=50)
    registration_number: Optional[str] = Field(None, max_length=100)
    fiscal_year_start: Optional[str] = "01-01"
    fiscal_year_end: Optional[str] = "12-31"

    @field_validator("currency")
    @classmethod
    def _validate_currency(cls, v: Optional[str]) -> Optional[str]:
        if v:
            v = v.strip().upper()
            if not re.match(r"^[A-Z]{3}$", v):
                raise ValueError("currency must be a 3-letter ISO-4217 code")
            if not is_valid_currency_code(v):
                raise ValueError("currency must be a supported ISO-4217 currency code")
        return v

    @field_validator("fiscal_year_start", "fiscal_year_end")
    @classmethod
    def _validate_fiscal_year(cls, v: Optional[str]) -> Optional[str]:
        if v:
            v = v.strip()
            if not re.match(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$", v):
                raise ValueError("fiscal year must be in MM-DD format")
        return v


class RefreshRequest(BaseModel):
    refresh_token: str


# ── Registration country → currency intelligence ────────────────────────────

class CountryCurrencyDefault(BaseModel):
    name: str
    code: str
    currency: str


class CountryDefaultsResponse(BaseModel):
    fallback_currency: str
    countries: list[CountryCurrencyDefault]


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class TokenPasswordRequest(BaseModel):
    token: str
    password: str = Field(..., min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8, max_length=128)


# ── Responses ───────────────────────────────────────────────────────────────

class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    role: UserRole
    organization_id: Optional[int] = None
    organization_code: Optional[str] = None
    first_name: str
    last_name: str
    phone: Optional[str] = None
    is_active: bool
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


class SuccessResponse(BaseModel):
    message: str


# ── Super Admin MFA (release-blocker pass, Blocker 4) ───────────────────────

class LoginResponse(BaseModel):
    """POST /auth/login's response. For a Super Admin account, password
    verification alone never yields a real token — mfa_status tells the
    frontend exactly which restricted follow-up call to make next.
    mfa_status == "none": access_token/refresh_token/user are populated,
    login is complete (matches every non-super_admin login exactly as
    before). mfa_status in {"enrollment_required","challenge_required"}:
    only mfa_token is populated — it authorizes ONLY the matching
    /auth/mfa/* follow-up call, nothing else."""

    mfa_status: str  # "none" | "enrollment_required" | "challenge_required"
    mfa_token: Optional[str] = None
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    user: Optional[UserResponse] = None


class MFAEnrollStartRequest(BaseModel):
    mfa_token: str = Field(..., min_length=1)


class MFAEnrollStartResponse(BaseModel):
    secret: str
    otpauth_url: str
    issuer: str


class MFAEnrollVerifyRequest(BaseModel):
    mfa_token: str = Field(..., min_length=1)
    code: str = Field(..., min_length=6, max_length=8)


class MFAChallengeRequest(BaseModel):
    mfa_token: str = Field(..., min_length=1)
    code: Optional[str] = Field(None, min_length=6, max_length=8)
    recovery_code: Optional[str] = Field(None, min_length=6, max_length=20)

    @field_validator("recovery_code")
    @classmethod
    def _require_one_factor(cls, value, info):
        code = info.data.get("code")
        if not value and not code:
            raise ValueError("Either code or recovery_code is required.")
        return value


class MFACompletedLoginResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse
    recovery_codes: Optional[list[str]] = None
    recovery_codes_remaining: Optional[int] = None


class MFADisableRequest(BaseModel):
    current_password: str = Field(..., min_length=1)


# ── Org Admin manages users ────────────────────────────────────────────────

class UserCreateRequest(BaseModel):
    email: EmailStr
    first_name: str = Field(..., min_length=1, max_length=120)
    last_name: str = Field(..., min_length=1, max_length=120)
    role: UserRole
    phone: Optional[str] = None
    send_invite: bool = True


class UserUpdateRequest(BaseModel):
    first_name: Optional[str] = Field(None, min_length=1, max_length=120)
    last_name: Optional[str] = Field(None, min_length=1, max_length=120)
    role: Optional[UserRole] = None
    phone: Optional[str] = None
    is_active: Optional[bool] = None


class UserListResponse(BaseModel):
    users: list[UserResponse]
    total: int
