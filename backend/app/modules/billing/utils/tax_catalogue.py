"""
app/modules/billing/utils/tax_catalogue.py
-------------------------------------------
Starter tax-rate catalogue: widely-published national standard VAT/GST
rates, keyed by currency code, offered as a convenient onboarding default.

This is the single source of truth TaxService.seed_starter_tax_rates()
reads from. Invoice/quotation/payment calculation code must never hardcode
a tax percentage directly -- it only ever reads TaxRate rows from the
database; this module exists solely to seed those rows, not to be
referenced from calculation logic.

Organizations remain free to edit, deactivate, or add their own tax rates
at any time -- this catalogue only ever supplies a starting point, never a
mandatory or exclusive rate. EUR is represented by Germany's standard VAT
rate as a common Eurozone reference point; organizations billing in other
Eurozone countries should adjust for their own jurisdiction.
"""
from dataclasses import dataclass
from decimal import Decimal
from typing import Tuple

from app.modules.billing.models import TaxType


@dataclass(frozen=True)
class TaxCatalogueEntry:
    currency_code: str
    country_code: str
    code: str
    name: str
    rate: Decimal
    tax_type: TaxType
    jurisdiction: str
    # True for the one entry get_catalogue_entries_for_currency() returns
    # when a caller only has a currency, not a country, to seed from (kept
    # so existing currency-only callers see exactly the same result as
    # before country-level entries existed). Every currency has at most one
    # representative entry; a second country sharing that currency (e.g.
    # France sharing Germany's EUR) is only ever reachable through
    # get_catalogue_entries_for_country().
    currency_representative: bool = True


# One standard reference rate per supported currency. Currencies with no
# single clean national VAT/GST rate (e.g. USD -- US sales tax varies by
# state) are deliberately absent; seeding must never fabricate a rate for
# an unsupported currency.
STARTER_TAX_CATALOGUE: Tuple[TaxCatalogueEntry, ...] = (
    TaxCatalogueEntry("GBP", "GB", "UK-VAT-STD", "UK Standard VAT", Decimal("20.00"), TaxType.VAT, "United Kingdom"),
    # India's GST is a multi-slab system, not one flat rate -- IN-GST-STD
    # (18%, the most common slab) is kept as the pre-existing code, listed
    # first so it remains the is_default rate for organizations already
    # seeded from it and for newly seeded ones alike; the other four
    # published GST slabs are added alongside it, none of them default.
    TaxCatalogueEntry("INR", "IN", "IN-GST-STD", "India Standard GST", Decimal("18.00"), TaxType.GST, "India"),
    TaxCatalogueEntry("INR", "IN", "IN-GST-0", "GST 0% (Nil-rated / Exempt)", Decimal("0.00"), TaxType.GST, "India"),
    TaxCatalogueEntry("INR", "IN", "IN-GST-5", "GST 5%", Decimal("5.00"), TaxType.GST, "India"),
    TaxCatalogueEntry("INR", "IN", "IN-GST-12", "GST 12%", Decimal("12.00"), TaxType.GST, "India"),
    TaxCatalogueEntry("INR", "IN", "IN-GST-28", "GST 28%", Decimal("28.00"), TaxType.GST, "India"),
    TaxCatalogueEntry("EUR", "DE", "EU-VAT-STD", "EU Standard VAT (Germany reference)", Decimal("19.00"), TaxType.VAT, "Germany / Eurozone reference"),
    # France shares Germany's currency (EUR) but has its own, higher
    # standard VAT rate (20%, matching the UK's) -- keyed by its own
    # country_code/code so seeding by COUNTRY (not just currency) never
    # conflates the two. get_catalogue_entries_for_currency("EUR") still
    # only returns Germany's entry, unchanged, for any caller that hasn't
    # been updated to seed by country -- see get_catalogue_entries_for_country.
    TaxCatalogueEntry("EUR", "FR", "FR-VAT-STD", "France Standard VAT (TVA)", Decimal("20.00"), TaxType.VAT, "France", currency_representative=False),
    TaxCatalogueEntry("AED", "AE", "AE-VAT-STD", "UAE Standard VAT", Decimal("5.00"), TaxType.VAT, "United Arab Emirates"),
    TaxCatalogueEntry("SGD", "SG", "SG-GST-STD", "Singapore Standard GST", Decimal("9.00"), TaxType.GST, "Singapore"),
    TaxCatalogueEntry("AUD", "AU", "AU-GST-STD", "Australia Standard GST", Decimal("10.00"), TaxType.GST, "Australia"),
    TaxCatalogueEntry("CAD", "CA", "CA-GST-STD", "Canada Standard GST", Decimal("5.00"), TaxType.GST, "Canada"),
    # Japan's consumption tax has no dedicated TaxType member -- VAT is the
    # closest existing classification (it is, structurally, a value-added
    # tax), while the human-facing name/terminology ("Consumption Tax")
    # comes from country_tax_profiles.py, not from this technical enum.
    TaxCatalogueEntry("JPY", "JP", "JP-CT-STD", "Japan Standard Consumption Tax", Decimal("10.00"), TaxType.VAT, "Japan"),
)


def get_catalogue_entries_for_currency(currency_code: str) -> Tuple[TaxCatalogueEntry, ...]:
    """Return the starter catalogue entries for a currency code, or an
    empty tuple if the currency has no catalogue entry -- callers must
    treat an empty result as "no starter rate available", never fabricate
    one themselves.

    Only currency_representative entries are returned -- a currency shared
    by more than one country (e.g. EUR: Germany and France) still returns
    just the one representative entry here, exactly as before country-level
    entries existed. A caller that actually knows the organization's
    registration country should use get_catalogue_entries_for_country()
    instead, which correctly distinguishes them."""
    if not currency_code:
        return ()
    normalized = currency_code.strip().upper()
    return tuple(e for e in STARTER_TAX_CATALOGUE if e.currency_code == normalized and e.currency_representative)


def get_catalogue_entries_for_country(country_code: str) -> Tuple[TaxCatalogueEntry, ...]:
    """Return the starter catalogue entries for a country (ISO alpha-2
    code), or an empty tuple if the country has no catalogue entry. This is
    the country-aware counterpart to get_catalogue_entries_for_currency():
    it correctly distinguishes countries that share a currency (France vs.
    Germany, both EUR) instead of always resolving to whichever entry
    happens to be that currency's representative."""
    if not country_code:
        return ()
    normalized = country_code.strip().upper()
    return tuple(e for e in STARTER_TAX_CATALOGUE if e.country_code == normalized)
