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


# One standard reference rate per supported currency. Currencies with no
# single clean national VAT/GST rate (e.g. USD -- US sales tax varies by
# state) are deliberately absent; seeding must never fabricate a rate for
# an unsupported currency.
STARTER_TAX_CATALOGUE: Tuple[TaxCatalogueEntry, ...] = (
    TaxCatalogueEntry("GBP", "GB", "UK-VAT-STD", "UK Standard VAT", Decimal("20.00"), TaxType.VAT, "United Kingdom"),
    TaxCatalogueEntry("INR", "IN", "IN-GST-STD", "India Standard GST", Decimal("18.00"), TaxType.GST, "India"),
    TaxCatalogueEntry("EUR", "DE", "EU-VAT-STD", "EU Standard VAT (Germany reference)", Decimal("19.00"), TaxType.VAT, "Germany / Eurozone reference"),
    TaxCatalogueEntry("AED", "AE", "AE-VAT-STD", "UAE Standard VAT", Decimal("5.00"), TaxType.VAT, "United Arab Emirates"),
    TaxCatalogueEntry("SGD", "SG", "SG-GST-STD", "Singapore Standard GST", Decimal("9.00"), TaxType.GST, "Singapore"),
    TaxCatalogueEntry("AUD", "AU", "AU-GST-STD", "Australia Standard GST", Decimal("10.00"), TaxType.GST, "Australia"),
    TaxCatalogueEntry("CAD", "CA", "CA-GST-STD", "Canada Standard GST", Decimal("5.00"), TaxType.GST, "Canada"),
)


def get_catalogue_entries_for_currency(currency_code: str) -> Tuple[TaxCatalogueEntry, ...]:
    """Return the starter catalogue entries for a currency code, or an
    empty tuple if the currency has no catalogue entry -- callers must
    treat an empty result as "no starter rate available", never fabricate
    one themselves."""
    if not currency_code:
        return ()
    normalized = currency_code.strip().upper()
    return tuple(e for e in STARTER_TAX_CATALOGUE if e.currency_code == normalized)
