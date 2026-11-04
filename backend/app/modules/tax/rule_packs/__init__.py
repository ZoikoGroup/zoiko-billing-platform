"""
app/modules/tax/rule_packs
--------------------------
Native rule packs (ZB-TAX-ARCH-001 Phase 3b). Per §14, native packs cover the
UK and Australia simple cases only; the US and Canada are specialist-provider
markets (Phase 4) and have no native pack, Ontario included.

The rounding declarations below are proposals for the tax lead to confirm at
sign-off (TAX_PHASE3B.md checklist); a pack cannot be used before its
registry row is published.
"""
from app.modules.tax.engines import RULE_PACKS
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


class AuGstDomesticServices(DomesticStandardRatedServicesPack):
    code = "AU-GST-DOMESTIC-SERVICES"
    version = "1"
    country = "AU"
    tax_type = "GST"
    component_code = "AU-GST"
    currency = "AUD"
    source_refs = ("S16",)
    summary = ("Australian GST on taxable supplies of services by an Australian seller entity to a buyer billed "
               "in Australia, business or consumer, priced in AUD.")
    rounding_rule = RoundingRule.PER_DOCUMENT
    rounding_mode = RoundingMode.HALF_UP


NATIVE_PACKS = (UkVatDomesticServices, AuGstDomesticServices)

for _pack in NATIVE_PACKS:
    RULE_PACKS[_pack.code] = _pack
