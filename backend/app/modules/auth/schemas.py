"""
modules/auth/schemas.py
-----------------------
"""
import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.modules.auth.country_currency import is_valid_currency_code
from app.modules.auth.models import UserRole


# ── Auth ────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email_whitespace(cls, v):
        # Autofill/password managers can deliver a padded email; strip it so
        # the credential check sees the address the user meant. The password
        # is deliberately NOT normalized — its exact bytes are the credential.
        return v.strip() if isinstance(v, str) else v


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
    currency: Optional[str] = None
    tax_no: Optional[str] = Field(None, max_length=50)
    registration_number: Optional[str] = Field(None, max_length=100)
    fiscal_year_start: Optional[str] = "01-01"
    fiscal_year_end: Optional[str] = "12-31"
    # Enterprise is contract/quote-based only (§2) and must be structurally
    # unreachable through self-serve registration — excluding it from this
    # Literal makes an "enterprise" submission a 422 at the schema layer,
    # before any org/user/account row is created.
    intended_plan: Literal["essentials", "professional", "business"] = Field(
        ...,
        description="Which plan the registrant intends to use. Recorded for "
        "Sales/onboarding visibility only — it does not provision a "
        "CommercialSubscription (see CommercialSubscriptionService."
        "provision_default_subscription).",
    )

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
    timezone: str
    fiscal_year_start: str
    fiscal_year_end: str
    date_format: str


class CountryDefaultsResponse(BaseModel):
    # No fallback_currency: the platform has NO silent USD fallback
    # (ZB-SA-CMD-003 v3.0). Countries absent from this map require an
    # explicit supported currency at registration or creation time.
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
    is_verified: bool = False
    last_login_at: Optional[datetime] = None
    created_at: datetime
    platform_role: Optional[str] = None  # only meaningful for role == super_admin; None == platform_administrator


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


class SuccessResponse(BaseModel):
    message: str


# ── Super Admin MFA ─────────────────────────────────────────────────────────
# ZB-SA-CMD-003 v3.0 master directive: normal login NEVER requires MFA (no
# mfa_status/mfa_token in the login response — /auth/login returns
# TokenResponse for every role). MFA exists purely as a server-enforced
# STEP-UP factor for privileged operations, managed from an authenticated
# session via the endpoints below. There is no fallback that bypasses it.

class MFASetupStartResponse(BaseModel):
    secret: str
    otpauth_url: str
    issuer: str


class MFASetupVerifyRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=8)


class MFASetupVerifyResponse(BaseModel):
    """Confirmed enrollment: MFA is now enabled for step-up verification.
    Recovery codes are returned exactly once — only their SHA-256 hashes are
    stored server-side."""
    recovery_codes: list[str]


class MFAStatusResponse(BaseModel):
    enabled: bool


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


class UserSummaryResponse(BaseModel):
    total: int = 0
    active: int = 0
    pending: int = 0
    suspended: int = 0
    invited: int = 0
