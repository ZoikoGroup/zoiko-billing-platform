"""Customer Settings: Require Billing Address / Require Tax ID are persisted
and enforced on customer create/update."""
import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from tests.conftest import make_organization

import itertools

_n = itertools.count(1)


def _base():
    n = next(_n)
    return {"company_name": f"Acme{n}", "email": f"a{n}@acme.test", "currency": "USD", "customer_code": f"CUST-{n}"}


def _require(db, org, **prefs):
    BillingConfigurationService(db).update_configuration(
        org.id, updated_by=1, customer_extra_settings=prefs,
    )


def test_settings_persist_and_merge(db_session):
    org = make_organization(db_session, "REQ1")
    _require(db_session, org, require_billing_address=True)
    _require(db_session, org, require_tax_id=True)  # shallow-merged, not replaced
    cfg = BillingConfigurationService(db_session).get_configuration(org.id)
    assert cfg.customer_extra_settings == {"require_billing_address": True, "require_tax_id": True}


def test_default_is_optional(db_session):
    org = make_organization(db_session, "REQ2")
    cust = CustomerService(db_session).create_customer(org.id, 1, **_base())
    assert cust.id


def test_billing_address_required_on_create(db_session):
    org = make_organization(db_session, "REQ3")
    _require(db_session, org, require_billing_address=True)
    svc = CustomerService(db_session)
    with pytest.raises(BadRequestException, match="Billing address"):
        svc.create_customer(org.id, 1, **_base())
    with pytest.raises(BadRequestException, match="Billing address"):
        svc.create_customer(org.id, 1, **_base(), billing_address="   ")
    assert svc.create_customer(org.id, 1, **_base(), billing_address="1 Main St").id


@pytest.mark.parametrize("field", ["tax_id", "gst_number", "vat_number", "tin"])
def test_tax_id_required_accepts_any_identifier(db_session, field):
    org = make_organization(db_session, f"REQ4{field[:2]}")
    _require(db_session, org, require_tax_id=True)
    svc = CustomerService(db_session)
    with pytest.raises(BadRequestException, match="Tax ID"):
        svc.create_customer(org.id, 1, **_base())
    value = "29ABCDE1234F1Z5" if field == "gst_number" else "TAX-123"
    assert svc.create_customer(org.id, 1, **_base(), **{field: value}).id


def test_update_only_checks_fields_being_sent(db_session):
    org = make_organization(db_session, "REQ5")
    svc = CustomerService(db_session)
    cust = svc.create_customer(org.id, 1, **_base())  # created while optional
    _require(db_session, org, require_billing_address=True, require_tax_id=True)
    # Unrelated edit on a legacy customer still works.
    assert svc.update_customer(cust.id, org.id, 1, notes="hello").notes == "hello"
    # But blanking a required field is rejected.
    with pytest.raises(BadRequestException, match="Billing address"):
        svc.update_customer(cust.id, org.id, 1, billing_address="")
    with pytest.raises(BadRequestException, match="Tax ID"):
        svc.update_customer(cust.id, org.id, 1, tax_id="")
