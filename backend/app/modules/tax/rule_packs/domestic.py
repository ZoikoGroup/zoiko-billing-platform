"""
app/modules/tax/rule_packs/domestic.py
--------------------------------------
Shared logic for the Phase 3b native packs (ZB-TAX-ARCH-001 §14 pilot): a
seller and buyer in the same country, a standard-rated service, priced in the
local currency. That is the whole coverage. Any line outside it is
NOT_DETERMINED, never 0% and never a guess.

A pack holds no rate. It reads the published reference rate from the
registry (component, tax code STANDARD, product scope GENERAL) valid on the
tax date, and records that rate version on the quote, so the rate and its
source revision are preserved. No published rate means NOT_DETERMINED.

A pack is used only after its tax_rule_pack_versions row is ACTIVE: authored,
reviewed by a different person, golden tests attached, every source it
depends on approved, and published by the tax lead. Until then it is a draft
and the engine resolver ignores it.
"""
from decimal import Decimal
from typing import Optional

from app.modules.tax.engines import ROUTING_FACTS, ComponentResult, EngineRequest, LineResult, RulePack
from app.modules.tax.enums import SupplyCategory, TaxOutcome, TransactionClass
from app.modules.tax.registry_service import RegistryReadService

OUTSIDE = "OUTSIDE_PACK_COVERAGE"


class DomesticStandardRatedServicesPack(RulePack):
    #: ISO country of both seller entity and buyer billing address.
    country: str
    tax_type: str
    component_code: str
    currency: str
    #: Source-register entries (handoff refs) this pack's legal rules rely on.
    source_refs: tuple = ()
    #: Plain-language statement of what the pack decides, shown to reviewers.
    summary: str = ""

    required_facts = ROUTING_FACTS
    # Domestic: a buyer without business evidence is charged exactly like a
    # business buyer, so an unresolved buyer status does not block.
    unresolved_buyer_as_consumer = True
    supply_categories = frozenset({SupplyCategory.SERVICES})
    transaction_classes = frozenset({TransactionClass.B2B_SERVICES, TransactionClass.B2C_SERVICES})
    product_scopes = frozenset({"GENERAL"})
    REGISTRY_TAX_CODE = "STANDARD"

    # ── declarations (copied to the registry row at registration) ──
    @classmethod
    def markets(cls) -> list:
        return [{"jurisdiction_code": cls.country, "tax_type": cls.tax_type}]

    @classmethod
    def coverage(cls) -> dict:
        return {
            "summary": cls.summary,
            "seller_country": cls.country,
            "buyer_country": cls.country,
            "currencies": [cls.currency],
            "supply_categories": sorted(c.name for c in cls.supply_categories),
            "transaction_classes": sorted(c.name for c in cls.transaction_classes),
            "registry_product_scopes": sorted(cls.product_scopes),
            "registry_component": cls.component_code,
            "registry_tax_code": cls.REGISTRY_TAX_CODE,
            "outside_coverage": "NOT_DETERMINED",
        }

    @classmethod
    def declaration(cls) -> dict:
        return {
            "code": cls.code, "version": cls.version, "markets": cls.markets(),
            "rounding_rule": cls.rounding_rule.name,
            "rounding_mode": cls.rounding_mode.name if cls.rounding_mode else None,
            "required_facts": sorted(cls.required_facts), "coverage": cls.coverage(),
            "source_refs": list(cls.source_refs),
        }

    # ── determination ──
    def _outside(self, request: EngineRequest) -> Optional[str]:
        facts = request.facts or {}
        seller = facts.get("seller_entity") or {}
        billing = ((facts.get("buyer") or {}).get("addresses") or {}).get("BILLING") or {}
        line = request.line
        if (request.currency or "").upper() != self.currency:
            return f"priced in {request.currency or 'no currency'}, not {self.currency}"
        if seller.get("country_code") != self.country:
            return f"the seller entity is not established in {self.country}"
        if billing.get("country_code") != self.country:
            return f"the buyer's billing address is not in {self.country} (not a domestic supply)"
        if line.supply_category not in self.supply_categories:
            return "the line is not a service"
        if (line.registry_product_scope or "").upper() not in self.product_scopes:
            return f"tax code {line.tax_code} is not a standard-rated general service"
        if line.transaction_class not in self.transaction_classes:
            return "the transaction class is outside the pack"
        for activation in request.activations:
            jurisdiction = activation.jurisdiction.code if activation.jurisdiction else None
            tax_type = activation.tax_type.code if activation.tax_type else None
            if (jurisdiction, tax_type) != (self.country, self.tax_type):
                return f"an activation for {jurisdiction} {tax_type} is outside the pack"
        if len(request.activations) != 1:
            return "exactly one activation must apply to the line"
        return None

    def determine(self, request: EngineRequest) -> LineResult:
        reason = self._outside(request)
        if reason:
            return LineResult.not_determined(OUTSIDE, f"{self.code}: outside pack coverage: {reason}.")
        activation = request.activations[0]
        rates = getattr(request, "rate_lookup", None) or RegistryReadService(request.db).lookup_rates
        lookup = rates(jurisdiction_id=activation.jurisdiction_id, tax_code=self.REGISTRY_TAX_CODE, as_of=request.tax_date)
        matches = [i for i in lookup["items"]
                   if i["component_code"] == self.component_code and i["product_scope"] in self.product_scopes]
        if len(matches) != 1:
            return LineResult.not_determined(
                "NO_APPROVED_RATE",
                f"{self.code}: no single published {self.component_code} standard rate on "
                f"{request.tax_date.isoformat()}.")
        rate = matches[0]
        if Decimal(rate["rate_percent"]) <= 0:
            return LineResult.not_determined("NO_APPROVED_RATE", f"{self.code}: the published standard rate is not positive.")
        component = ComponentResult(
            component_code=self.component_code, rate_percent=Decimal(rate["rate_percent"]), rate_source="REGISTRY",
            label=rate.get("component_name"), jurisdiction_id=activation.jurisdiction_id,
            tax_type_id=activation.tax_type_id, rate_version_id=rate["id"], activation_id=activation.id,
            reporting_code="STANDARD",
        )
        return LineResult(outcome=TaxOutcome.STANDARD, explanation_code="DOMESTIC_STANDARD_RATED_SERVICE",
                          components=[component],
                          legal_reason=f"{self.code} {self.version}: domestic standard-rated service "
                                       f"({self.component_code} rate version {rate['id']}).")
