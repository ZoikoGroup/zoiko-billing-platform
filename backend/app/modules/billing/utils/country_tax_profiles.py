"""
app/modules/billing/utils/country_tax_profiles.py
---------------------------------------------------
Centralized country -> currency -> tax-system -> tax-terminology ->
default-tax-configuration resolution.

This is the single source of truth for "what does tax look like for an
organization registered in country X": which tax system it uses (GST/VAT/
Sales Tax/Consumption Tax), what its tax identifier is actually called
(GSTIN, VAT Registration Number, EIN, ...), and what a sensible default
standard rate is -- all keyed by country, not currency, because two
countries can share a currency (Germany and France both bill in EUR) while
having genuinely different tax systems, terminology, and rates.

This module supplies TERMINOLOGY and a DEFAULT reference rate only. It is
never itself the source of truth for what rate applies to an actual
invoice line -- that always comes from a real TaxRate row in the database
(see TaxService / tax_catalogue.py, which this module feeds). The 18%
standard GST rate listed for India, for example, is the requested default
STANDARD-slab GST configuration for new organizations to seed from, not a
universal rate for every Indian product or service -- India has multiple
GST slabs (0/5/12/18/28), all of which remain available once seeded (see
tax_catalogue.py's IN-GST-* entries) and organizations remain free to add,
edit, or deactivate any of them.

Country coverage: the ten registration countries this module was built to
cover. Adding an eleventh country is a matter of appending one
CountryTaxProfile entry here -- no other code should need to change.
"""
from dataclasses import dataclass
from decimal import Decimal
from typing import Dict, Optional, Tuple

from app.modules.auth.country_currency import resolve_country_code
from app.modules.billing.models import TaxType


@dataclass(frozen=True)
class CountryTaxProfile:
    country_code: str          # ISO 3166-1 alpha-2
    country_name: str
    currency: str               # ISO 4217
    tax_system: str             # human-facing name: "GST", "VAT", "Sales Tax", "Consumption Tax"
    tax_type: TaxType           # closest TaxRate.tax_type classification
    tax_id_label: str           # what the tax identifier is actually called in this country
    standard_rate: Optional[Decimal]  # default STANDARD-slab rate, or None where no single national rate exists


# Order matches the ten countries requested for initial coverage.
COUNTRY_TAX_PROFILES: Tuple[CountryTaxProfile, ...] = (
    CountryTaxProfile("IN", "India", "INR", "GST", TaxType.GST, "GSTIN", Decimal("18.00")),
    CountryTaxProfile("GB", "United Kingdom", "GBP", "VAT", TaxType.VAT, "VAT Registration Number", Decimal("20.00")),
    CountryTaxProfile("US", "United States", "USD", "Sales Tax", TaxType.SALES_TAX, "EIN (Employer Identification Number)", None),
    CountryTaxProfile("CA", "Canada", "CAD", "GST", TaxType.GST, "GST/HST Number", Decimal("5.00")),
    CountryTaxProfile("AU", "Australia", "AUD", "GST", TaxType.GST, "ABN (Australian Business Number)", Decimal("10.00")),
    CountryTaxProfile("DE", "Germany", "EUR", "VAT", TaxType.VAT, "USt-IdNr. (VAT Identification Number)", Decimal("19.00")),
    CountryTaxProfile("FR", "France", "EUR", "VAT", TaxType.VAT, "Numéro de TVA intracommunautaire", Decimal("20.00")),
    CountryTaxProfile("AE", "United Arab Emirates", "AED", "VAT", TaxType.VAT, "TRN (Tax Registration Number)", Decimal("5.00")),
    CountryTaxProfile("SG", "Singapore", "SGD", "GST", TaxType.GST, "GST Registration Number", Decimal("9.00")),
    CountryTaxProfile("JP", "Japan", "JPY", "Consumption Tax", TaxType.VAT, "Invoice Registration Number (T-Number)", Decimal("10.00")),
)

_BY_CODE: Dict[str, CountryTaxProfile] = {p.country_code: p for p in COUNTRY_TAX_PROFILES}
_BY_NAME: Dict[str, CountryTaxProfile] = {p.country_name.upper(): p for p in COUNTRY_TAX_PROFILES}


def get_country_tax_profile(country: Optional[str]) -> Optional[CountryTaxProfile]:
    """Resolve a country (name or ISO alpha-2 code) to its tax profile.

    Returns None for a country outside the current coverage list -- never
    fabricates a tax system, terminology, or rate for a country this module
    doesn't actually know about."""
    if not country:
        return None
    key = country.strip().upper()
    if key in _BY_CODE:
        return _BY_CODE[key]
    if key in _BY_NAME:
        return _BY_NAME[key]
    code = resolve_country_code(country)
    return _BY_CODE.get(code) if code else None


def list_supported_country_codes() -> Tuple[str, ...]:
    return tuple(p.country_code for p in COUNTRY_TAX_PROFILES)
