"""
tests/test_pricing_rule_update_clear_and_product_scope.py
---------------------------------------------------------
BUG-08.1 follow-up (/billing/pricing/pricing-rules). The conditional
requirements stay as they are (see test_pricing_rule_contract.py); this file
pins the validation gaps the Phase 3 audit confirmed:

  * an explicit null on update must CLEAR a nullable field -- previously
    filter_allowed's drop_none silently kept the old value;
  * a rule's product must exist in the caller's organization (a missing and a
    foreign product get the same 400, so no cross-tenant existence leak);
  * Effective To must not precede Effective From, including on an update that
    changes only one side.

The router functions are called directly with real Pydantic payloads so the
`model_dump(exclude_unset=True)` path is exercised too.
"""
from datetime import date
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.core.exceptions import BadRequestException
from app.modules.billing.models import Product
from app.modules.billing.routers.pricing_rule_router import (
    create_pricing_rule, update_pricing_rule,
)
from app.modules.billing.schemas import PricingRuleCreate, PricingRuleUpdate
from app.modules.billing.services.pricing_service import PricingRuleService
from tests.conftest import make_organization


def _user(org):
    return SimpleNamespace(id=1, organization_id=org.id)


def _product(db, org, code):
    p = Product(organization_id=org.id, name=f"Product {code}", code=code)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _create(db, org, code, **kw):
    data = dict(name=f"Rule {code}", code=code, rule_type="percentage_discount", scope="global",
                value=10, effective_from=date(2026, 1, 1))
    data.update(kw)
    return create_pricing_rule(PricingRuleCreate(**data), db=db, current_user=_user(org))


def _update(db, org, rule, **kw):
    return update_pricing_rule(rule.id, PricingRuleUpdate(**kw), db=db, current_user=_user(org))


# ── clearing optional fields on update ───────────────────────────────────────

def test_explicit_null_clears_optional_fields(db_session):
    org = make_organization(db_session, "PRU1")
    prod = _product(db_session, org, "PRU1P")
    rule = _create(db_session, org, "CLR", description="Spring promo", effective_to=date(2026, 6, 30),
                   usage_limit=50, product_id=prod.id, region="EMEA")

    updated = _update(db_session, org, rule, description=None, effective_to=None, usage_limit=None,
                      product_id=None, region=None)

    assert updated.description is None
    assert updated.effective_to is None
    assert updated.usage_limit is None
    assert updated.product_id is None
    assert updated.region is None


def test_omitted_fields_are_left_untouched(db_session):
    org = make_organization(db_session, "PRU2")
    rule = _create(db_session, org, "KEEP", description="Keep me", usage_limit=5)
    updated = _update(db_session, org, rule, name="Renamed")
    assert updated.name == "Renamed"
    assert updated.description == "Keep me" and updated.usage_limit == 5


def test_null_on_a_non_nullable_field_is_ignored_not_written(db_session):
    org = make_organization(db_session, "PRU3")
    rule = _create(db_session, org, "NN", priority=7)
    updated = PricingRuleService(db_session).update(rule.id, org.id, 1, priority=None, name=None, status=None)
    assert updated.priority == 7 and updated.name == "Rule NN" and updated.status is not None


def test_clearing_a_discount_value_is_rejected_and_not_persisted(db_session):
    org = make_organization(db_session, "PRU4")
    rule = _create(db_session, org, "VAL")
    with pytest.raises(BadRequestException, match="value is required"):
        _update(db_session, org, rule, value=None)
    db_session.refresh(rule)
    assert rule.value == 10


def test_clearing_the_product_of_a_product_scoped_rule_is_rejected(db_session):
    org = make_organization(db_session, "PRU5")
    prod = _product(db_session, org, "PRU5P")
    rule = _create(db_session, org, "PSC", scope="product", product_id=prod.id)
    with pytest.raises(BadRequestException, match="product"):
        _update(db_session, org, rule, product_id=None)
    db_session.refresh(rule)
    assert rule.product_id == prod.id


# ── product existence and tenant ownership ──────────────────────────────────

def test_create_rejects_a_nonexistent_product(db_session):
    org = make_organization(db_session, "PRU6")
    with pytest.raises(BadRequestException, match="not found in this organization"):
        _create(db_session, org, "MISS", scope="product", product_id=987654)


def test_create_rejects_another_organizations_product_with_the_same_message(db_session):
    org = make_organization(db_session, "PRU7")
    other = make_organization(db_session, "PRU7X", name="Other Org")
    foreign = _product(db_session, other, "PRU7FP")
    with pytest.raises(BadRequestException, match="not found in this organization"):
        _create(db_session, org, "FOR", scope="product", product_id=foreign.id)


def test_update_rejects_switching_to_another_organizations_product(db_session):
    org = make_organization(db_session, "PRU8")
    other = make_organization(db_session, "PRU8X", name="Other Org")
    own = _product(db_session, org, "PRU8P")
    foreign = _product(db_session, other, "PRU8FP")
    rule = _create(db_session, org, "SW", scope="product", product_id=own.id)
    with pytest.raises(BadRequestException, match="not found in this organization"):
        _update(db_session, org, rule, product_id=foreign.id)
    db_session.refresh(rule)
    assert rule.product_id == own.id


def test_own_product_is_accepted(db_session):
    org = make_organization(db_session, "PRU9")
    prod = _product(db_session, org, "PRU9P")
    assert _create(db_session, org, "OWN", scope="product", product_id=prod.id).product_id == prod.id


# ── effective date range ────────────────────────────────────────────────────

def test_create_rejects_effective_to_before_effective_from():
    with pytest.raises(ValidationError, match="effective_to"):
        PricingRuleCreate(name="R", code="DT", rule_type="percentage_discount", value=5,
                          effective_from=date(2026, 3, 1), effective_to=date(2026, 2, 28))


def test_update_of_one_date_is_checked_against_the_stored_other(db_session):
    org = make_organization(db_session, "PRU10")
    rule = _create(db_session, org, "DT1", effective_to=date(2026, 6, 30))
    with pytest.raises(BadRequestException, match="Effective To"):
        _update(db_session, org, rule, effective_to=date(2025, 12, 31))
    with pytest.raises(BadRequestException, match="Effective To"):
        _update(db_session, org, rule, effective_from=date(2026, 7, 1))
    db_session.refresh(rule)
    assert rule.effective_from == date(2026, 1, 1) and rule.effective_to == date(2026, 6, 30)


def test_same_day_range_is_allowed(db_session):
    org = make_organization(db_session, "PRU11")
    rule = _create(db_session, org, "DT2")
    assert _update(db_session, org, rule, effective_to=date(2026, 1, 1)).effective_to == date(2026, 1, 1)


# ── BUG-08.2 / D3: "Include deactivated" = active_only=false ────────────────

def test_active_only_lists_active_rules_and_false_includes_deactivated(db_session):
    org = make_organization(db_session, "PRU12")
    live = _create(db_session, org, "LIVE")
    gone = _create(db_session, org, "GONE")
    svc = PricingRuleService(db_session)
    svc.deactivate(gone.id, org.id, 1)

    default = svc.list(org.id, active_only=True)
    assert {r.code for r in default["items"]} == {"LIVE"} and default["total"] == 1

    included = svc.list(org.id, active_only=False)
    assert {r.code for r in included["items"]} == {"LIVE", "GONE"} and included["total"] == 2

    # Combined with another filter, the toggle still only widens by is_active.
    combined = svc.list(org.id, active_only=False, search_term="GONE")
    assert [r.id for r in combined["items"]] == [gone.id]
    assert live.id not in [r.id for r in combined["items"]]


# ── existing schema minimums (priority >= 0, usage_limit >= 1) ──────────────

@pytest.mark.parametrize("field,value", [("priority", -1), ("usage_limit", 0)])
def test_schema_minimums_are_enforced(field, value):
    with pytest.raises(ValidationError):
        PricingRuleCreate(name="R", code="MIN", rule_type="tier_pricing",
                          effective_from=date(2026, 1, 1), **{field: value})
