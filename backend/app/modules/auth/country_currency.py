"""
modules/auth/country_currency.py
--------------------------------
Authoritative country → default billing-currency intelligence.

This module is the SINGLE source of truth the platform uses to derive an
organization's default billing currency from its registration country:

    RegisterRequest / register_enterprise   (persists Organization.currency)
    GET /api/auth/country-defaults          (serves the map to the frontend UX)

The mapping reuses the project's existing published country/currency dataset
(frontend/src/utils/currency.js — COUNTRY_OPTIONS / JURISDICTION_TO_CURRENCY)
so there is exactly one country → currency contract across the platform
instead of a new invented one.

Countries whose national currency is NOT in the backend CurrencyCode enum
(e.g. Ghana GHS, Kenya KES, Rwanda RWF, Tanzania TZS, Uganda UGX) are
deliberately excluded: persisting a currency outside the enum would make
BillingConfiguration seed fall back to USD, producing an
Organization.currency ≠ BillingConfiguration.base_currency mismatch. Those
countries keep the project's existing safe fallback (USD) and are reported
as such.

Currency precedence (see resolve_currency):
    1. explicit currency supplied by the user (must be a valid code)
    2. country-derived default currency
    3. safe fallback (DEFAULT_FALLBACK_CURRENCY) when neither is available
"""
from typing import Dict, Optional, Tuple

from app.modules.billing.utils.currency_utils import validate_currency_code

DEFAULT_FALLBACK_CURRENCY = "USD"

# (ISO-3166-1 alpha-2, canonical country name, ISO-4217 currency code)
# Mirrors frontend/src/utils/currency.js COUNTRY_OPTIONS. Countries whose
# currency is outside the backend CurrencyCode enum are omitted on purpose.
_COUNTRY_CURRENCY_TABLE: Tuple[Tuple[str, str, str], ...] = (
    ("IN", "India", "INR"),
    ("US", "United States", "USD"),
    ("GB", "United Kingdom", "GBP"),
    ("AE", "United Arab Emirates", "AED"),
    ("AU", "Australia", "AUD"),
    ("BD", "Bangladesh", "BDT"),
    ("BH", "Bahrain", "BHD"),
    ("BR", "Brazil", "BRL"),
    ("CA", "Canada", "CAD"),
    ("CH", "Switzerland", "CHF"),
    ("CN", "China", "CNY"),
    ("DK", "Denmark", "DKK"),
    ("DE", "Germany", "EUR"),
    ("FR", "France", "EUR"),
    ("IE", "Ireland", "EUR"),
    ("NL", "Netherlands", "EUR"),
    ("IT", "Italy", "EUR"),
    ("ES", "Spain", "EUR"),
    ("BE", "Belgium", "EUR"),
    ("AT", "Austria", "EUR"),
    ("FI", "Finland", "EUR"),
    ("PT", "Portugal", "EUR"),
    ("GR", "Greece", "EUR"),
    ("HK", "Hong Kong", "HKD"),
    ("JP", "Japan", "JPY"),
    ("KR", "South Korea", "KRW"),
    ("KW", "Kuwait", "KWD"),
    ("LK", "Sri Lanka", "LKR"),
    ("MX", "Mexico", "MXN"),
    ("MY", "Malaysia", "MYR"),
    ("NG", "Nigeria", "NGN"),
    ("NO", "Norway", "NOK"),
    ("NP", "Nepal", "NPR"),
    ("NZ", "New Zealand", "NZD"),
    ("OM", "Oman", "OMR"),
    ("PK", "Pakistan", "PKR"),
    ("QA", "Qatar", "QAR"),
    ("SA", "Saudi Arabia", "SAR"),
    ("SE", "Sweden", "SEK"),
    ("SG", "Singapore", "SGD"),
    ("TH", "Thailand", "THB"),
    ("ZA", "South Africa", "ZAR"),
)

# Build lookups, keeping only entries whose currency is valid per the backend
# CurrencyCode enum so the persisted Organization.currency always round-trips
# into BillingConfiguration without falling back to USD.
COUNTRY_NAME_TO_CURRENCY: Dict[str, str] = {}
COUNTRY_CODE_TO_CURRENCY: Dict[str, str] = {}
for _code, _name, _currency in _COUNTRY_CURRENCY_TABLE:
    if not validate_currency_code(_currency):
        raise ValueError(
            f"Country/currency row {_code} {_name} -> {_currency} is not a "
            f"supported CurrencyCode; fix the table instead of persisting it."
        )
    COUNTRY_CODE_TO_CURRENCY[_code.upper()] = _currency
    COUNTRY_NAME_TO_CURRENCY[_name.upper()] = _currency

# Registration countries present in the frontend list but intentionally absent
# above (currency outside CurrencyCode enum) — kept for reporting/debugging.
UNSUPPORTED_COUNTRY_NOTES: Dict[str, str] = {
    "Ghana": "GHS is not a supported backend CurrencyCode; falls back to USD",
    "Kenya": "KES is not a supported backend CurrencyCode; falls back to USD",
    "Rwanda": "RWF is not a supported backend CurrencyCode; falls back to USD",
    "Tanzania": "TZS is not a supported backend CurrencyCode; falls back to USD",
    "Uganda": "UGX is not a supported backend CurrencyCode; falls back to USD",
}


def is_valid_currency_code(code: Optional[str]) -> bool:
    if not code:
        return False
    return validate_currency_code(code.strip().upper())


def get_default_currency_for_country(country: Optional[str]) -> Optional[str]:
    """Return the authoritative default currency for a country, given either
    its canonical name ("India") or ISO-3166-1 alpha-2 code ("IN"). Returns
    None when the country is unknown or unsupported — never invents one."""
    if not country:
        return None
    key = country.strip().upper()
    if key in COUNTRY_CODE_TO_CURRENCY:
        return COUNTRY_CODE_TO_CURRENCY[key]
    if key in COUNTRY_NAME_TO_CURRENCY:
        return COUNTRY_NAME_TO_CURRENCY[key]
    if key == "UK":  # common alias for United Kingdom
        return COUNTRY_CODE_TO_CURRENCY.get("GB")
    return None


def resolve_currency(explicit_currency: Optional[str], country: Optional[str]) -> str:
    """Resolve the registration currency with strict precedence:

        1. explicit currency supplied by the user (already normalized/validated)
        2. country-derived default currency
        3. DEFAULT_FALLBACK_CURRENCY when neither is available

    An explicit but empty/blank value counts as "not supplied" so a client
    that sends currency="" still gets the country-derived default."""
    if explicit_currency and explicit_currency.strip():
        return explicit_currency.strip().upper()
    derived = get_default_currency_for_country(country)
    if derived:
        return derived
    return DEFAULT_FALLBACK_CURRENCY


def country_defaults() -> Dict:
    """Payload for GET /api/auth/country-defaults: the authoritative map the
    registration frontend consumes so its auto-suggest never diverges from
    what the backend persists."""
    countries = sorted(
        (
            {"name": name, "code": code, "currency": currency}
            for code, name, currency in _COUNTRY_CURRENCY_TABLE
        ),
        key=lambda c: c["name"],
    )
    return {
        "fallback_currency": DEFAULT_FALLBACK_CURRENCY,
        "countries": countries,
    }
