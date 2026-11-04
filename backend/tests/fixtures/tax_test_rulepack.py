"""
TEST-ONLY rule pack for ZB-TAX-ARCH-001 Phase 3a golden tests.

It is NOT a real market pack and makes no legal claim about any jurisdiction:
it exists only to exercise the determination contract. It lives under tests/,
is injected through EngineResolver(rule_pack_lookup=...), is never added to
app.modules.tax.engines.RULE_PACKS, and is never inserted into the
tax_rule_pack_versions table — test_tax_phase3a_governed.py fails if any of
that changes.

Behaviour (fixture rules only):
  * rate = the published reference rate (tax_code STANDARD, product scope of
    the line's tax code) valid on the tax date — none => NOT_DETERMINED;
  * a business buyer evidenced by a verified tax ID on a B2B line =>
    REVERSE_CHARGE (0, reverse-charge component);
  * a buyer without business evidence => consumer treatment (charges tax).
"""
from app.modules.tax.engines import ROUTING_FACTS, ComponentResult, EngineRequest, LineResult, RulePack
from app.modules.tax.enums import RoundingMode, RoundingRule, TaxOutcome
from app.modules.tax.registry_service import RegistryReadService

TEST_PACK_CODE = "TEST-ONLY-FIXTURE"


class TestOnlyRulePack(RulePack):
    __test__ = False                       # not a pytest test class
    code = TEST_PACK_CODE
    version = "0-test"
    required_facts = ROUTING_FACTS
    unresolved_buyer_as_consumer = True

    def __init__(self, rounding_rule: RoundingRule = RoundingRule.PER_LINE,
                 rounding_mode: RoundingMode = RoundingMode.HALF_UP):
        self.rounding_rule = rounding_rule
        self.rounding_mode = rounding_mode

    def determine(self, request: EngineRequest) -> LineResult:
        components = []
        reader = RegistryReadService(request.db)
        scope = (request.line.registry_product_scope or "GENERAL").upper()
        for activation in request.activations:
            lookup = reader.lookup_rates(jurisdiction_id=activation.jurisdiction_id, tax_code="STANDARD",
                                         as_of=request.tax_date)
            matches = [i for i in lookup["items"]
                       if i["tax_type"] == activation.tax_type.code and i["product_scope"] == scope]
            if len(matches) != 1:
                return LineResult.not_determined(
                    "NO_APPROVED_RATE", f"No single approved reference rate on {request.tax_date.isoformat()}.")
            version = matches[0]
            reverse = request.business_buyer is True and activation.transaction_class.name.startswith("B2B")
            components.append(ComponentResult(
                component_code=version["component_code"], rate_percent=version["rate_percent"],
                rate_source="REGISTRY", jurisdiction_id=activation.jurisdiction_id, tax_type_id=activation.tax_type_id,
                rate_version_id=version["id"], activation_id=activation.id, is_reverse_charge=reverse,
                reporting_code="RC" if reverse else "STD",
            ))
        if any(c.is_reverse_charge for c in components):
            return LineResult(outcome=TaxOutcome.REVERSE_CHARGE, explanation_code="FIXTURE_B2B_REVERSE_CHARGE",
                              components=components, legal_reason="Fixture rule: verified business buyer.")
        return LineResult(outcome=TaxOutcome.STANDARD, explanation_code="FIXTURE_STANDARD_RATE",
                          components=components, legal_reason="Fixture rule: standard reference rate.")
