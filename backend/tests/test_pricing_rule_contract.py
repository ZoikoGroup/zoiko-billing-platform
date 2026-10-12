"""
tests/test_pricing_rule_contract.py
-----------------------------------
Batch 3 / B1 (/billing/pricing/pricing-rules): "a rule can be created
without Description, Value, Priority, Effective To, Usage Limit, Product ID,
Region". Investigation showed most of those are optional BY DESIGN (NULL
means no description / priority 0 / open-ended / unlimited / all products /
all regions -- see get_applicable_rules). What was genuinely missing, and is
now enforced server-side for both create and update:

  * percentage/fixed discount rules must have a value (a discount with no
    amount rendered as "null%"/"$null"), and a percentage discount <= 100;
  * a PRODUCT-scoped rule needs a product, a REGION-scoped rule a region --
    otherwise the NULL target silently applies the rule to everything.
"""
from datetime import date

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.services.pricing_service import PricingRuleService
from tests.conftest import make_organization


def _create(db, org_id, code, **kw):
    data = dict(name=f"Rule {code}", code=code, rule_type="percentage_discount", scope="global",
                value=10, effective_from=date.today())
    data.update(kw)
    return PricingRuleService(db).create(org_id, 1, **data)


def test_optional_fields_stay_optional(db_session):
    org = make_organization(db_session, "PRC1")
    rule = _create(db_session, org.id, "OPT", description=None, effective_to=None, usage_limit=None,
                   product_id=None, region=None)
    assert rule.id is not None and rule.priority == 0


@pytest.mark.parametrize("rule_type", ["percentage_discount", "fixed_discount"])
def test_discount_rules_require_a_value(db_session, rule_type):
    org = make_organization(db_session, f"PRC2{rule_type[:3].upper()}")
    with pytest.raises(BadRequestException, match="value is required"):
        _create(db_session, org.id, "NOVAL", rule_type=rule_type, value=None)


def test_non_discount_rule_types_do_not_require_a_value(db_session):
    org = make_organization(db_session, "PRC3")
    assert _create(db_session, org.id, "TIER", rule_type="tier_pricing", value=None).id


def test_percentage_discount_cannot_exceed_100(db_session):
    org = make_organization(db_session, "PRC4")
    with pytest.raises(BadRequestException, match="cannot exceed 100"):
        _create(db_session, org.id, "BIG", value=101)
    assert _create(db_session, org.id, "MAX", value=100).id
    # A fixed amount above 100 is fine.
    assert _create(db_session, org.id, "FIX", rule_type="fixed_discount", value=250).id


def test_scoped_rules_need_their_target(db_session):
    org = make_organization(db_session, "PRC5")
    with pytest.raises(BadRequestException, match="product"):
        _create(db_session, org.id, "PSCOPE", scope="product", product_id=None)
    with pytest.raises(BadRequestException, match="region"):
        _create(db_session, org.id, "RSCOPE", scope="region", region="  ")
    assert _create(db_session, org.id, "RSCOPEOK", scope="region", region="EMEA").id


def test_update_is_validated_against_the_stored_rule(db_session):
    org = make_organization(db_session, "PRC6")
    rule = _create(db_session, org.id, "UPD")
    svc = PricingRuleService(db_session)
    # An explicit null now clears nullable fields (BUG-08.1 follow-up), so
    # clearing a discount's value must be rejected by the merged contract.
    with pytest.raises(BadRequestException, match="value is required"):
        svc.update(rule.id, org.id, 1, value=None)
    with pytest.raises(BadRequestException, match="product"):
        svc.update(rule.id, org.id, 1, scope="product")  # scope change without a product
    assert svc.update(rule.id, org.id, 1, description="ok").description == "ok"
