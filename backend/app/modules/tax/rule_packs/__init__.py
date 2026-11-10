"""
app/modules/tax/rule_packs
--------------------------
Native rule packs (ZB-TAX-ARCH-001 Phase 3b). Per §14, native packs cover the
UK and Australia simple cases only; the US and Canada are specialist-provider
markets (Phase 4) and have no native pack, Ontario included.

The rounding declarations are proposals for the tax lead to confirm at
sign-off (TAX_PHASE3B.md checklist); a pack cannot be used before its
registry row is published.

Each pack lives in its own module (Phase 8 PR 1): a pack's code hash covers
the modules that define it, so this file only registers them. A new version
of a pack goes in a new module next to the old one (Phase 8 PR 2: packs are
effective-dated, so every ACTIVE version must stay in the running code).
"""
from app.modules.tax.engines import register_rule_pack
from app.modules.tax.rule_packs.au_gst import AuGstDomesticServices
from app.modules.tax.rule_packs.gb_vat import UkVatDomesticServices

NATIVE_PACKS = (UkVatDomesticServices, AuGstDomesticServices)

for _pack in NATIVE_PACKS:
    register_rule_pack(_pack)
