"""
modules/organizations/schemas.py
--------------------------------
"""
import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.modules.commercial.enums import BillingClassification, BillingSource


class OrganizationBase(BaseModel):
    organization_name: str = Field(..., min_length=1, max_length=200)
    display_name: Optional[str] = None
    legal_name: Optional[str] = Field(None, max_length=255)
    industry: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = Field(None, max_length=100)
    state: Optional[str] = Field(None, max_length=100)
    country: Optional[str] = Field(None, max_length=100)
    postal_code: Optional[str] = Field(None, max_length=20)
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    website: Optional[str] = Field(None, max_length=500)
    tax_no: Optional[str] = None
    registration_number: Optional[str] = None
    # ZB-SA-CMD-003 v3.0: no "USD" default. When omitted, the creation
    # endpoint derives the currency from the organization's country via
    # auth/country_currency.resolve_currency — and an unmapped country is an
    # explicit error, never a silent USD fallback.
    currency: Optional[str] = None
    timezone: str = "UTC"
    fiscal_year_start: Optional[str] = "01-01"
    fiscal_year_end: Optional[str] = "12-31"

    @field_validator("currency")
    @classmethod
    def _validate_currency(cls, v: Optional[str]) -> Optional[str]:
        if v:
            v = v.strip().upper()
            if not re.match(r"^[A-Z]{3}$", v):
                raise ValueError("currency must be a 3-letter ISO-4217 code")
            from app.modules.auth.country_currency import is_valid_currency_code

            if not is_valid_currency_code(v):
                raise ValueError("currency must be a supported ISO-4217 currency code")
        return v


class OrganizationUpdate(BaseModel):
    organization_name: Optional[str] = Field(None, min_length=1, max_length=200)
    display_name: Optional[str] = None
    legal_name: Optional[str] = Field(None, max_length=255)
    industry: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = Field(None, max_length=100)
    state: Optional[str] = Field(None, max_length=100)
    country: Optional[str] = Field(None, max_length=100)
    postal_code: Optional[str] = Field(None, max_length=20)
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    website: Optional[str] = Field(None, max_length=500)
    tax_no: Optional[str] = None
    registration_number: Optional[str] = None
    currency: Optional[str] = None
    timezone: Optional[str] = None
    fiscal_year_start: Optional[str] = None
    fiscal_year_end: Optional[str] = None

    @field_validator("currency")
    @classmethod
    def _validate_currency(cls, v: Optional[str]) -> Optional[str]:
        if v:
            v = v.strip().upper()
            if not re.match(r"^[A-Z]{3}$", v):
                raise ValueError("currency must be a 3-letter ISO-4217 code")
        return v

    @field_validator("fiscal_year_start", "fiscal_year_end")
    @classmethod
    def _validate_fiscal_year(cls, v: Optional[str]) -> Optional[str]:
        if v:
            v = v.strip()
            if not re.match(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$", v):
                raise ValueError("fiscal year must be in MM-DD format")
        return v


class OrganizationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_name: str
    organization_code: str
    display_name: Optional[str] = None
    legal_name: Optional[str] = None
    industry: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    tax_no: Optional[str] = None
    registration_number: Optional[str] = None
    currency: str
    timezone: str
    fiscal_year_start: Optional[str] = None
    fiscal_year_end: Optional[str] = None
    billing_classification: BillingClassification
    billing_source: BillingSource
    is_active: bool
    created_at: datetime
    updated_at: datetime


class OrganizationListResponse(BaseModel):
    organizations: list[OrganizationResponse]
    total: int


class RecentCustomer(BaseModel):
    id: int
    name: str
    initials: str
    status: str
    statusColor: str
    currency: Optional[str] = None
    company_name: Optional[str] = None


class OrganizationDashboardStats(BaseModel):
    total_customers: int = 0
    active_customers: int = 0
    active_subscriptions: int = 0
    open_invoices: int = 0
    overdue_invoices: int = 0
    outstanding_amount: float = 0
    revenue_this_month: float = 0
    billing_admins: int = 0
    currency: Optional[str] = None
    recent_customers: list[RecentCustomer] = []


class OrganizationDetail(BaseModel):
    id: int
    name: str
    code: str
    status: str
    admin_name: Optional[str] = None
    admin_email: Optional[str] = None
    legal_name: Optional[str] = None
    industry: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    currency: Optional[str] = None
    timezone: str = "UTC"
    fiscal_year_start: Optional[str] = None
    fiscal_year_end: Optional[str] = None
    billing_classification: Optional[BillingClassification] = None
    billing_source: Optional[BillingSource] = None
    total_customers: int = 0
    active_customers: int = 0
    billing_admins: int = 0
    created_at: datetime


# ZB-SA-CMD-003 §19/§20 — tenant-visible privileged support-access log.
# One row per support-access SESSION (grant), not a raw per-event audit
# replay — reads directly from PrivilegedTenantAccessGrant so reason/
# ticket_reference are always present without reconstructing them from
# audit-log metadata.
class PrivilegedAccessLogEntry(BaseModel):
    requested_at: datetime
    status: str  # pending_step_up | active | exited | expired | denied
    reason: str
    ticket_reference: str
    activated_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None  # exited_at, or expires_at if lazily expired
    correlation_id: str


class PrivilegedAccessLogResponse(BaseModel):
    entries: list[PrivilegedAccessLogEntry]
