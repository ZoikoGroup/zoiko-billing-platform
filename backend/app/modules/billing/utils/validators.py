"""
modules/billing/utils/validators.py
------------------------------------
Shared Pydantic field-validation logic for the billing schemas.

Each of these was previously copy-pasted verbatim across multiple *Create/
*Update schemas in schemas.py (e.g. CustomerCreate and CustomerUpdate each
had their own byte-identical validate_email/validate_phone/... methods).
Consolidated here so there's one implementation to read and change.

These are plain functions, not decorated validators — each schema still
declares its own `@field_validator(...)` with its own field name(s)/mode,
and the method body simply delegates to the matching function below. That
keeps every schema's validator registration (field names, mode="before",
error format) exactly as it was before consolidation.
"""

import re
from decimal import Decimal
from typing import Optional, Set

# Currency codes accepted by the Customer/PriceList/PriceListItem/PricingRule/
# Discount/CurrencyPricing `currency` field validators. This is intentionally
# NOT the same set as the `CurrencyCode` enum in models.py (used elsewhere,
# e.g. BillingConfiguration) — the two have already diverged (this set accepts
# PLN/CZK/HUF/TRY/VND/TWD which CurrencyCode doesn't, while CurrencyCode
# accepts SAR/QAR/KWD/NGN/PKR/BDT/LKR/NPR/BHD/OMR which this set doesn't).
# Left as two separate sets on purpose: unifying them would silently start
# rejecting (or accepting) currency codes some schemas currently don't.
LEGACY_SCHEMA_CURRENCY_CODES = {
    "USD", "EUR", "GBP", "INR", "AED", "SGD", "AUD", "CAD", "CHF", "JPY",
    "CNY", "HKD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON",
    "BGN", "HRK", "RUB", "TRY", "ZAR", "BRL", "MXN", "THB", "MYR", "IDR",
    "PHP", "VND", "KRW", "TWD",
}

# Ceiling for a single monetary input field. The billing module's money
# columns are Numeric(14,2) / Numeric(16,4) — both cap the integer part at 12
# digits regardless of decimal scale — so any value at or below this is
# guaranteed to fit in either column type. Without this, an oversized amount
# fails as an unhandled DB error at commit instead of a clean 422 at the API
# boundary.
MAX_MONEY_AMOUNT = Decimal("999999999999.99")


def validate_email_format(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    if not re.match(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$", v.strip()):
        raise ValueError("Invalid email format")
    return v.strip().lower()


def validate_phone_format(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    cleaned = re.sub(r"[\s\-\(\)]", "", v)
    if not re.match(r"^[\+]?\d{7,15}$", cleaned):
        raise ValueError("Invalid phone format")
    return cleaned


def validate_website_format(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    if not re.match(r"^https?://[\w\-]+(\.[\w\-]+)+(/[\w\-./?#&%=]*)?$", v.strip()):
        raise ValueError("Invalid website URL (must start with http:// or https://)")
    return v.strip()


def validate_gst_format(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    gst = v.strip().upper()
    if not re.match(r"^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$", gst):
        raise ValueError("Invalid GSTIN format (expected: 2 digits + 5 letters + 4 digits + 1 letter + Z + 1 alphanumeric)")
    state_code = gst[:2]
    valid_states = {"01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38"}
    if state_code not in valid_states:
        raise ValueError(f"Invalid GSTIN state code: {state_code}")
    pan_in_gst = gst[2:12]
    if not re.match(r"^[A-Z]{5}\d{4}[A-Z]$", pan_in_gst):
        raise ValueError("GSTIN contains invalid PAN portion")
    return gst


def validate_vat_format(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    vat = v.strip()
    if len(vat) < 4 or len(vat) > 20:
        raise ValueError("VAT number length must be 4-20 characters")
    return vat


def validate_pan_format(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    pan = v.strip().upper()
    if not re.match(r"^[A-Z]{5}\d{4}[A-Z]{1}$", pan):
        raise ValueError("Invalid PAN format (expected: 5 letters + 4 digits + 1 letter)")
    entity_char = pan[3]
    valid_entities = {"A", "B", "C", "F", "G", "H", "L", "J", "P", "T"}
    if entity_char not in valid_entities:
        raise ValueError(f"Unusual PAN entity type: {entity_char}")
    return pan


def validate_currency_format(v: Optional[str], valid_currencies: Set[str] = LEGACY_SCHEMA_CURRENCY_CODES) -> Optional[str]:
    """Optional currency check: blank/None passes through as None."""
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    currency = v.strip().upper()
    if currency not in valid_currencies:
        raise ValueError(f"Unsupported currency code: {currency}")
    return currency


def validate_code_required(v: str) -> str:
    if v is None or v.strip() == "":
        raise ValueError("Code cannot be empty")
    return v.strip().upper()


def validate_code_optional(v: Optional[str]) -> Optional[str]:
    if v is None or v.strip() == "":
        return None
    return v.strip().upper()


def validate_effective_date_range(effective_from, effective_to) -> None:
    """Raise unless effective_to is on/after effective_from (either side may be None)."""
    if effective_from is not None and effective_to is not None and effective_to < effective_from:
        raise ValueError("effective_to must be greater than or equal to effective_from")


def validate_validity_date_range(valid_from, valid_to) -> None:
    """Raise unless valid_to is strictly after valid_from (either side may be None)."""
    if valid_from is not None and valid_to is not None and valid_to <= valid_from:
        raise ValueError("valid_to must be greater than valid_from")
