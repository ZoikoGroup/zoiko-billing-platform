"""
tests/test_customer_settings_bug13.py
-------------------------------------
BUG-13 (/billing/customers/settings): the five Customer Settings were read-only
"Not configurable yet" values because nothing stored them. They are now
first-class BillingConfiguration columns (migration b13c5e7a9d21):

  * default_customer_type      -> applied when a new customer has no type
  * customer_numbering_prefix  -> same rules as the other document prefixes
  * customer_numbering_format  -> NumberFormat grammar; codes generated
                                  server-side from DocumentSequence "customer"
  * require_billing_address    -> enforced on customer CREATION only
  * require_tax_id             -> enforced on customer CREATION only; any one
                                  of GST / VAT / PAN / TIN / tax ID satisfies it

Concurrency of the DocumentSequence row lock is only meaningful on PostgreSQL
(SQLite serialises writers); it is the same lock invoices already rely on.
"""
from datetime import datetime

import pytest
from pydantic import ValidationError

from app.core.exceptions import AlreadyExistsException, BadRequestException
from app.modules.billing.models import BillingCustomer, CustomerType, NumberFormat
from app.modules.billing.schemas import (
    BillingConfigurationResponse, BillingConfigurationUpdate, CustomerCreate,
)
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from tests.conftest import make_organization


def _settings(db, org, **kw):
    return BillingConfigurationService(db).update_configuration(org.id, 1, **kw)


def _create(db, org, **kw):
    data = dict(company_name="Acme Ltd", display_name="Acme")
    data.update(kw)
    return CustomerService(db).create_customer(org.id, 1, **data)


# ── settings persistence & validation ─────────────────────────────────────────

def test_defaults_keep_todays_behaviour(db_session):
    org = make_organization(db_session, "CS1")
    cfg = BillingConfigurationService(db_session).get_configuration(org.id)
    assert cfg.default_customer_type == CustomerType.BUSINESS
    assert cfg.customer_numbering_prefix == "CUST-"
    assert cfg.customer_numbering_format == NumberFormat.PREFIX_SEQ
    assert cfg.require_billing_address is False and cfg.require_tax_id is False


def test_settings_round_trip_through_the_api_schemas(db_session):
    org = make_organization(db_session, "CS2")
    payload = BillingConfigurationUpdate(
        default_customer_type="non_profit", customer_numbering_prefix="NP-",
        customer_numbering_format="PREFIX-{YYYY}-{SEQ}", require_billing_address=True, require_tax_id=True,
    ).model_dump(exclude_unset=True)
    _settings(db_session, org, **payload)
    db_session.expire_all()
    out = BillingConfigurationResponse.model_validate(BillingConfigurationService(db_session).get_configuration(org.id))
    assert out.default_customer_type == CustomerType.NON_PROFIT
    assert out.customer_numbering_prefix == "NP-"
    assert out.customer_numbering_format == NumberFormat.PREFIX_YYYY_SEQ
    assert out.require_billing_address is True and out.require_tax_id is True


@pytest.mark.parametrize("bad", ["TOO-LONG-PREFIX", "bad prefix", "x/y"])
def test_invalid_prefix_is_rejected_and_not_saved(db_session, bad):
    org = make_organization(db_session, f"CS3{len(bad)}")
    BillingConfigurationService(db_session).get_configuration(org.id)   # commits org + config
    with pytest.raises(BadRequestException, match="customer_numbering_prefix: Customer number prefix"):
        _settings(db_session, org, customer_numbering_prefix=bad)
    db_session.rollback()
    assert BillingConfigurationService(db_session).get_configuration(org.id).customer_numbering_prefix == "CUST-"


@pytest.mark.parametrize("field,value", [
    ("customer_numbering_format", "{PREFIX}{NUMBER}"),
    ("default_customer_type", "alien"),
    ("customer_numbering_prefix", "X" * 11),
])
def test_schema_rejects_unsupported_values(field, value):
    with pytest.raises(ValidationError):
        BillingConfigurationUpdate(**{field: value})


def test_settings_are_isolated_per_organization(db_session):
    a, b = make_organization(db_session, "CS4A"), make_organization(db_session, "CS4B")
    _settings(db_session, a, customer_numbering_prefix="AA-", require_tax_id=True, default_customer_type="government")
    cfg_b = BillingConfigurationService(db_session).get_configuration(b.id)
    assert cfg_b.customer_numbering_prefix == "CUST-"
    assert cfg_b.require_tax_id is False and cfg_b.default_customer_type == CustomerType.BUSINESS


# ── server-side numbering ────────────────────────────────────────────────────

def test_codes_are_generated_server_side_in_sequence(db_session):
    org = make_organization(db_session, "CS5")
    assert _create(db_session, org).customer_code == "CUST-00001"
    assert _create(db_session, org, email="b@example.com").customer_code == "CUST-00002"
    assert _create(db_session, org, email="c@example.com", customer_code="   ").customer_code == "CUST-00003"


def test_prefix_and_format_from_settings_are_used(db_session):
    org = make_organization(db_session, "CS6")
    _settings(db_session, org, customer_numbering_prefix="C-", customer_numbering_format="PREFIX-{YYYY}-{SEQ}")
    code = _create(db_session, org).customer_code
    assert code == f"C-{datetime.utcnow().year}-00001"


def test_manual_code_is_kept_and_duplicates_are_rejected(db_session):
    org = make_organization(db_session, "CS7")
    assert _create(db_session, org, customer_code="VIP-1").customer_code == "VIP-1"
    with pytest.raises(AlreadyExistsException):
        _create(db_session, org, customer_code="VIP-1", email="other@example.com")


def test_generated_numbers_skip_codes_already_taken(db_session):
    org = make_organization(db_session, "CS8")
    _create(db_session, org, customer_code="CUST-00001")           # legacy/manual code
    assert _create(db_session, org, email="n@example.com").customer_code == "CUST-00002"


def test_soft_deleted_codes_are_not_reassigned(db_session):
    org = make_organization(db_session, "CS9")
    first = _create(db_session, org)
    first.deleted_at = datetime.utcnow()
    db_session.commit()
    assert _create(db_session, org, email="z@example.com").customer_code == "CUST-00002"


def test_sequences_are_per_organization(db_session):
    a, b = make_organization(db_session, "CS10A"), make_organization(db_session, "CS10B")
    assert _create(db_session, a).customer_code == "CUST-00001"
    assert _create(db_session, a, email="2@example.com").customer_code == "CUST-00002"
    assert _create(db_session, b).customer_code == "CUST-00001"


def test_create_schema_no_longer_requires_a_code_or_type():
    data = CustomerCreate(company_name="A", display_name="A", customer_type="").model_dump(exclude_unset=True)
    assert "customer_code" not in data and data["customer_type"] is None


# ── default customer type ────────────────────────────────────────────────────

def test_default_type_applies_only_when_no_type_is_given(db_session):
    org = make_organization(db_session, "CS11")
    _settings(db_session, org, default_customer_type="individual")
    assert _create(db_session, org).customer_type == CustomerType.INDIVIDUAL
    assert _create(db_session, org, email="g@example.com", customer_type="government").customer_type == CustomerType.GOVERNMENT


# ── creation requirements ────────────────────────────────────────────────────

def test_require_billing_address_blocks_creation_without_one(db_session):
    org = make_organization(db_session, "CS12")
    _settings(db_session, org, require_billing_address=True)
    with pytest.raises(BadRequestException, match="billing_address"):
        _create(db_session, org, billing_address="   ")
    assert _create(db_session, org, billing_address="1 Main St, Pune").billing_address == "1 Main St, Pune"


@pytest.mark.parametrize("field", ["gst_number", "vat_number", "pan", "tin", "tax_id"])
def test_require_tax_id_is_satisfied_by_any_supported_identifier(db_session, field):
    org = make_organization(db_session, f"CS13{field[:3].upper()}")
    _settings(db_session, org, require_tax_id=True)
    with pytest.raises(BadRequestException, match="tax_id"):
        _create(db_session, org)
    value = {"gst_number": "27AAPFU0939F1ZV", "pan": "AAPFU0939F"}.get(field, "TAX-123")
    assert getattr(_create(db_session, org, **{field: value}), field) == value


def test_a_rejected_create_does_not_consume_a_number(db_session):
    org = make_organization(db_session, "CS14")
    _settings(db_session, org, require_billing_address=True)
    with pytest.raises(BadRequestException):
        _create(db_session, org)
    db_session.rollback()
    assert _create(db_session, org, billing_address="Addr").customer_code == "CUST-00001"


def test_requirements_do_not_block_existing_customers_or_edits(db_session):
    org = make_organization(db_session, "CS15")
    existing = _create(db_session, org)                       # no address, no tax id
    _settings(db_session, org, require_billing_address=True, require_tax_id=True)
    updated = CustomerService(db_session).update_customer(existing.id, org.id, 1, notes="still editable")
    assert updated.notes == "still editable"
    assert db_session.get(BillingCustomer, existing.id).billing_address in (None, "")
