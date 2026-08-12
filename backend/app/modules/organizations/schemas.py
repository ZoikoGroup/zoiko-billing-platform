"""
modules/organizations/schemas.py
--------------------------------
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class OrganizationBase(BaseModel):
    organization_name: str = Field(..., min_length=1, max_length=200)
    display_name: Optional[str] = None
    industry: Optional[str] = None
    address: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    tax_no: Optional[str] = None
    registration_number: Optional[str] = None
    currency: str = "USD"
    timezone: str = "UTC"


class OrganizationUpdate(BaseModel):
    organization_name: Optional[str] = Field(None, min_length=1, max_length=200)
    display_name: Optional[str] = None
    industry: Optional[str] = None
    address: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    tax_no: Optional[str] = None
    registration_number: Optional[str] = None
    currency: Optional[str] = None
    timezone: Optional[str] = None


class OrganizationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_name: str
    organization_code: str
    display_name: Optional[str] = None
    industry: Optional[str] = None
    address: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    tax_no: Optional[str] = None
    registration_number: Optional[str] = None
    currency: str
    timezone: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class OrganizationListResponse(BaseModel):
    organizations: list[OrganizationResponse]
    total: int


class RecentCustomer(BaseModel):
    name: str
    initials: str
    status: str
    statusColor: str


class OrganizationDashboardStats(BaseModel):
    total_customers: int = 0
    active_customers: int = 0
    active_subscriptions: int = 0
    open_invoices: int = 0
    overdue_invoices: int = 0
    outstanding_amount: float = 0
    revenue_this_month: float = 0
    billing_admins: int = 0
    recent_customers: list[RecentCustomer] = []


class OrganizationDetail(BaseModel):
    id: int
    name: str
    code: str
    status: str
    admin_name: Optional[str] = None
    admin_email: Optional[str] = None
    industry: Optional[str] = None
    address: Optional[str] = None
    currency: str = "USD"
    timezone: str = "UTC"
    total_customers: int = 0
    active_customers: int = 0
    billing_admins: int = 0
    created_at: datetime
