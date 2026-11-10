"""
app/modules/tax/rule_packs/gb_vat.py
------------------------------------
UK VAT on domestic standard-rated services (Phase 3b). Its own module so
its code hash (Phase 8 PR 1) changes only when this pack, or the shared
domestic logic it builds on, changes.
"""
from app.modules.tax.enums import RoundingMode, RoundingRule
from app.modules.tax.rule_packs.domestic import DomesticStandardRatedServicesPack


class UkVatDomesticServices(DomesticStandardRatedServicesPack):
    code = "GB-VAT-DOMESTIC-SERVICES"
    version = "1"
    country = "GB"
    tax_type = "VAT"
    component_code = "GB-VAT"
    currency = "GBP"
    source_refs = ("S11",)
    summary = ("UK VAT on standard-rated services supplied by a UK-established seller entity to a buyer billed "
               "in the UK, business or consumer, priced in GBP.")
    rounding_rule = RoundingRule.PER_LINE
    rounding_mode = RoundingMode.HALF_UP
