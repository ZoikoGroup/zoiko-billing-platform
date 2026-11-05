"""Pydantic contracts for the tax domain API (ZB-TAX-ARCH-001 §09)."""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.tax.enums import EntityTaxRegime


class _EntityFields(BaseModel):
    legal_name: Optional[str] = Field(None, max_length=255)
    display_name: Optional[str] = Field(None, max_length=255)
    country_code: Optional[str] = Field(None, max_length=100, description="ISO 3166-1 alpha-2 (country names are normalized)")
    subdivision_code: Optional[str] = Field(None, max_length=6, description="ISO 3166-2 subdivision suffix, e.g. ON, NY")
    address_line1: Optional[str] = Field(None, max_length=255)
    address_line2: Optional[str] = Field(None, max_length=255)
    city: Optional[str] = Field(None, max_length=100)
    postal_code: Optional[str] = Field(None, max_length=20)
    timezone: Optional[str] = Field(None, max_length=100)
    primary_tax_id: Optional[str] = Field(None, max_length=100)
    primary_tax_id_type: Optional[str] = Field(None, max_length=50)
    registration_number: Optional[str] = Field(None, max_length=100)
    is_merchant_of_record: Optional[bool] = None
    tax_regime: Optional[EntityTaxRegime] = None
    notes: Optional[str] = None


class SellerLegalEntityCreate(_EntityFields):
    entity_code: str = Field(..., min_length=1, max_length=50)
    legal_name: str = Field(..., min_length=1, max_length=255)
    is_default: bool = False


class SellerLegalEntityUpdate(_EntityFields):
    entity_code: Optional[str] = Field(None, min_length=1, max_length=50)
    expected_version: Optional[int] = Field(None, description="Optimistic concurrency check")


class SellerLegalEntityResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    entity_code: str
    legal_name: str
    display_name: Optional[str] = None
    country_code: Optional[str] = None
    subdivision_code: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    postal_code: Optional[str] = None
    timezone: Optional[str] = None
    primary_tax_id: Optional[str] = None
    primary_tax_id_type: Optional[str] = None
    registration_number: Optional[str] = None
    is_merchant_of_record: bool
    tax_regime: EntityTaxRegime
    is_default: bool
    is_active: bool
    version: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class SellerLegalEntityListResponse(BaseModel):
    items: List[SellerLegalEntityResponse]
    next_cursor: Optional[str] = None
