"""
app/modules/tax/rule_packs/au_gst.py
------------------------------------
Australian GST on domestic taxable supplies of services (Phase 3b). Its own
module so its code hash (Phase 8 PR 1) changes only when this pack, or the
shared domestic logic it builds on, changes.
"""
from app.modules.tax.enums import RoundingMode, RoundingRule
from app.modules.tax.rule_packs.domestic import DomesticStandardRatedServicesPack


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
