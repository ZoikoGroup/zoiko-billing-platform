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
Organization.currency ≠ BillingConfiguration.base_currency mismatch. For
those countries the caller MUST supply an explicit supported currency —
registration without one fails with an explicit error. There is NO silent
USD fallback anywhere (ZB-SA-CMD-003 v3.0 master directive).

Currency precedence (see resolve_currency):
    1. explicit currency supplied by the user (must be a valid code)
    2. country-derived default currency
    3. neither available → explicit BadRequestException (never a silent USD)
"""
from typing import Dict, Optional, Tuple

from app.core.exceptions import BadRequestException
from app.modules.billing.utils.currency_utils import validate_currency_code

DEFAULT_FALLBACK_CURRENCY = "USD"  # kept only for reporting/debugging payloads

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
COUNTRY_NAME_TO_CODE: Dict[str, str] = {}
for _code, _name, _currency in _COUNTRY_CURRENCY_TABLE:
    if not validate_currency_code(_currency):
        raise ValueError(
            f"Country/currency row {_code} {_name} -> {_currency} is not a "
            f"supported CurrencyCode; fix the table instead of persisting it."
        )
    COUNTRY_CODE_TO_CURRENCY[_code.upper()] = _currency
    COUNTRY_NAME_TO_CURRENCY[_name.upper()] = _currency
    COUNTRY_NAME_TO_CODE[_name.upper()] = _code.upper()

# Representative primary IANA timezone per registration country. Several of
# these countries span multiple zones (US, CA, AU, BR, CN, RU) -- the value
# here is only ever a sensible single-country registration default, never a
# claim that it's the only zone in use; the organization can change it after
# registration.
_COUNTRY_TIMEZONE_TABLE: Dict[str, str] = {
    "IN": "Asia/Kolkata", "US": "America/New_York", "GB": "Europe/London",
    "AE": "Asia/Dubai", "AU": "Australia/Sydney", "BD": "Asia/Dhaka",
    "BH": "Asia/Bahrain", "BR": "America/Sao_Paulo", "CA": "America/Toronto",
    "CH": "Europe/Zurich", "CN": "Asia/Shanghai", "DK": "Europe/Copenhagen",
    "DE": "Europe/Berlin", "FR": "Europe/Paris", "IE": "Europe/Dublin",
    "NL": "Europe/Amsterdam", "IT": "Europe/Rome", "ES": "Europe/Madrid",
    "BE": "Europe/Brussels", "AT": "Europe/Vienna", "FI": "Europe/Helsinki",
    "PT": "Europe/Lisbon", "GR": "Europe/Athens", "HK": "Asia/Hong_Kong",
    "JP": "Asia/Tokyo", "KR": "Asia/Seoul", "KW": "Asia/Kuwait",
    "LK": "Asia/Colombo", "MX": "America/Mexico_City", "MY": "Asia/Kuala_Lumpur",
    "NG": "Africa/Lagos", "NO": "Europe/Oslo", "NP": "Asia/Kathmandu",
    "NZ": "Pacific/Auckland", "OM": "Asia/Muscat", "PK": "Asia/Karachi",
    "QA": "Asia/Qatar", "SA": "Asia/Riyadh", "SE": "Europe/Stockholm",
    "SG": "Asia/Singapore", "TH": "Asia/Bangkok", "ZA": "Africa/Johannesburg",
}
DEFAULT_FALLBACK_TIMEZONE = "UTC"

# Countries whose statutory/business fiscal year is NOT the calendar year.
# (start, end) as MM-DD, matching Organization.fiscal_year_start/end's format.
# Every country not listed here defaults to the plain calendar year.
_COUNTRY_FISCAL_YEAR_TABLE: Dict[str, Tuple[str, str]] = {
    "IN": ("04-01", "03-31"),
    "GB": ("04-01", "03-31"),
    "AU": ("07-01", "06-30"),
    "NZ": ("04-01", "03-31"),
    "PK": ("07-01", "06-30"),
    "BD": ("07-01", "06-30"),
    "ZA": ("04-01", "03-31"),
}
DEFAULT_FISCAL_YEAR: Tuple[str, str] = ("01-01", "12-31")

# Countries that conventionally write dates ISO-style or month-first rather
# than the platform's day-first default (DateFormat.DD_MM_YYYY).
_COUNTRY_DATE_FORMAT_TABLE: Dict[str, str] = {
    "US": "MM-DD-YYYY",
    "JP": "YYYY-MM-DD",
    "KR": "YYYY-MM-DD",
    "CN": "YYYY-MM-DD",
}


def _resolve_country_code(country: Optional[str]) -> Optional[str]:
    """Best-effort ISO alpha-2 code for a country given as either a code or a
    canonical name, reusing the same registration country list as currency
    resolution."""
    if not country:
        return None
    key = country.strip().upper()
    if key in COUNTRY_CODE_TO_CURRENCY:
        return key
    if key in COUNTRY_NAME_TO_CODE:
        return COUNTRY_NAME_TO_CODE[key]
    if key == "UK":
        return "GB"
    return None


def resolve_country_code(country: Optional[str]) -> Optional[str]:
    """Public entry point for _resolve_country_code -- the tax-terminology
    system (billing/utils/country_tax_profiles.py) reuses this exact
    resolver so a registration country string ("India" or "IN") maps to
    the same ISO alpha-2 code everywhere, instead of a second, possibly
    diverging implementation."""
    return _resolve_country_code(country)


def get_default_timezone_for_country(country: Optional[str]) -> Optional[str]:
    code = _resolve_country_code(country)
    return _COUNTRY_TIMEZONE_TABLE.get(code) if code else None


def resolve_timezone(explicit_timezone: Optional[str], country: Optional[str]) -> str:
    """Same precedence as resolve_currency: explicit value > country-derived
    default > safe fallback (UTC)."""
    if explicit_timezone and explicit_timezone.strip():
        return explicit_timezone.strip()
    return get_default_timezone_for_country(country) or DEFAULT_FALLBACK_TIMEZONE


def get_default_fiscal_year_for_country(country: Optional[str]) -> Optional[Tuple[str, str]]:
    code = _resolve_country_code(country)
    return _COUNTRY_FISCAL_YEAR_TABLE.get(code) if code else None


def resolve_fiscal_year(
    explicit_start: Optional[str], explicit_end: Optional[str], country: Optional[str],
) -> Tuple[str, str]:
    """Same precedence as resolve_currency. Both start and end must be
    explicitly supplied to count as "explicit" -- a single stray value
    without its pair is treated as not supplied, since a fiscal year needs
    both ends to be meaningful."""
    if explicit_start and explicit_end:
        return explicit_start.strip(), explicit_end.strip()
    return get_default_fiscal_year_for_country(country) or DEFAULT_FISCAL_YEAR


def get_default_date_format_for_country(country: Optional[str]) -> Optional[str]:
    code = _resolve_country_code(country)
    return _COUNTRY_DATE_FORMAT_TABLE.get(code) if code else None

# Registration countries present in the frontend list but intentionally absent
# above (currency outside CurrencyCode enum) — kept for reporting/debugging.
# ZB-SA-CMD-003 v3.0: these are NOT silently mapped to USD any more — a
# registration for one of them without an explicit supported currency is
# rejected with a clear error telling the caller to choose one.
UNSUPPORTED_COUNTRY_NOTES: Dict[str, str] = {
    "Ghana": "GHS is not a supported backend CurrencyCode; registration requires an explicit supported currency",
    "Kenya": "KES is not a supported backend CurrencyCode; registration requires an explicit supported currency",
    "Rwanda": "RWF is not a supported backend CurrencyCode; registration requires an explicit supported currency",
    "Tanzania": "TZS is not a supported backend CurrencyCode; registration requires an explicit supported currency",
    "Uganda": "UGX is not a supported backend CurrencyCode; registration requires an explicit supported currency",
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

        1. explicit currency supplied by the user (validated against the
           backend CurrencyCode enum — an unsupported code is an explicit
           error, never silently accepted or swapped)
        2. country-derived default currency
        3. neither available → BadRequestException naming the country and
           the supported options. There is NO silent USD fallback
           (ZB-SA-CMD-003 v3.0 master directive).

    An explicit but empty/blank value counts as "not supplied" so a client
    that sends currency="" still gets the country-derived default."""
    if explicit_currency and explicit_currency.strip():
        candidate = explicit_currency.strip().upper()
        if not validate_currency_code(candidate):
            raise BadRequestException(
                f"Currency '{candidate}' is not supported by this platform. "
                "Choose one of the supported ISO-4217 codes offered at registration."
            )
        return candidate
    derived = get_default_currency_for_country(country)
    if derived:
        return derived
    raise BadRequestException(
        f"Cannot determine a billing currency: no explicit currency was supplied and "
        f"'{country or 'unknown country'}' has no supported default mapping. "
        "Supply an explicit supported currency for this organization."
    )


def country_defaults() -> Dict:
    """Payload for GET /api/auth/country-defaults: the authoritative map the
    registration frontend consumes so its auto-suggest never diverges from
    what the backend persists."""
    countries = sorted(
        (
            {
                "name": name,
                "code": code,
                "currency": currency,
                "timezone": _COUNTRY_TIMEZONE_TABLE.get(code, DEFAULT_FALLBACK_TIMEZONE),
                "fiscal_year_start": _COUNTRY_FISCAL_YEAR_TABLE.get(code, DEFAULT_FISCAL_YEAR)[0],
                "fiscal_year_end": _COUNTRY_FISCAL_YEAR_TABLE.get(code, DEFAULT_FISCAL_YEAR)[1],
                "date_format": _COUNTRY_DATE_FORMAT_TABLE.get(code, "DD-MM-YYYY"),
            }
            for code, name, currency in _COUNTRY_CURRENCY_TABLE
        ),
        key=lambda c: c["name"],
    )
    return {
        "countries": countries,
    }
