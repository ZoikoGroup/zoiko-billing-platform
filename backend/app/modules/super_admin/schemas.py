"""
modules/super_admin/schemas.py
------------------------------
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.modules.auth.models import UserRole


class SettingCreate(BaseModel):
    key: str
    value: Optional[str] = None
    description: Optional[str] = None
    category: str = "general"
    is_public: bool = False


class SettingUpdate(BaseModel):
    value: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    is_public: Optional[bool] = None


class SettingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    key: str
    value: Optional[str] = None
    description: Optional[str] = None
    category: str
    is_public: bool
    updated_at: datetime


class SuperAdminUserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    role: UserRole
    organization_id: Optional[int] = None
    organization_name: Optional[str] = None
    organization_code: Optional[str] = None
    first_name: str
    last_name: str
    is_active: bool
    created_at: datetime


class SuperAdminUserListResponse(BaseModel):
    users: list[SuperAdminUserResponse]
    total: int


class DashboardStats(BaseModel):
    total_organizations: int
    active_organizations: int
    total_users: int
    org_admins: int
    billing_admins: int
    total_customers: int
    total_invoices: int
    recent_organizations: list[dict]


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 11 — Platform audit log feed (Super Admin, cross-organization)
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformAuditLogResponse(BaseModel):
    """One platform-plane audit entry, enriched with the actor email and
    organization name for cross-org display. Built manually in the router
    (a LEFT JOIN against users/organizations)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    actor_id: Optional[int] = None
    actor_email: Optional[str] = None
    action: str
    entity_type: str
    entity_id: Optional[int] = None
    organization_id: Optional[int] = None
    organization_name: Optional[str] = None
    old_values: Optional[dict] = None
    new_values: Optional[dict] = None
    metadata: Optional[dict] = None
    created_at: datetime


class PlatformAuditLogListResponse(BaseModel):
    logs: list[PlatformAuditLogResponse]
    total: int
