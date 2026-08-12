"""
modules/auth/schemas.py
-----------------------
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.modules.auth.models import UserRole


# ── Auth ────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)


class RegisterRequest(BaseModel):
    organization: str = Field(..., min_length=1, max_length=200)
    name: str = Field(..., min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    industry: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    timezone: Optional[str] = "UTC"
    phone: Optional[str] = None


class RefreshRequest(BaseModel):
    refresh_token: str


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
