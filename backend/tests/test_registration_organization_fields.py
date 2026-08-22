"""
Regression tests for PHASE 1-3 of the commercial foundation: the Organization
registration data model now carries the full profile (legal name, address
block, website, fiscal year, currency, tax/registration numbers) and stamps
the commercial classification/source server-side at registration.

These exercise the real register_enterprise service path and the PUT /me
update logic against the shared in-memory SQLite fixtures.
"""
import pytest
from pydantic import ValidationError

from app.modules.auth.models import User
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.commercial.enums import BillingClassification, BillingSource
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.modules.organizations.models import Organization
from app.modules.organizations.schemas import OrganizationUpdate
from tests.conftest import make_organization


def _org_for(db, email):
    admin = db.query(User).filter_by(email=email).first()
    assert admin is not None
    org = db.query(Organization).filter_by(id=admin.organization_id).first()
    assert org is not None
    return org


def test_register_enterprise_persists_full_profile(db_session):
    data = RegisterRequest(
        organization="Acme Corp",
        legal_name="Acme Corp Ltd",
        name="Ada Admin",
        email="ada@acme.example",
        password="StrongPass123!",
        industry="Software",
        address="1 Main St",
        city="London",
        state="London",
        country="United Kingdom",
        postal_code="SW1A 1AA",
        website="https://acme.example",
        timezone="Europe/London",
        phone="+44 20 7946 0000",
        currency="GBP",
        tax_no="GB123456789",
        registration_number="08452128",
        fiscal_year_start="04-06",
        fiscal_year_end="04-05",
        intended_plan="essentials",
    )
    register_enterprise(db_session, data)

    org = _org_for(db_session, "ada@acme.example")
    assert org.organization_name == "Acme Corp"
    assert org.legal_name == "Acme Corp Ltd"
    assert org.industry == "Software"
    assert org.address == "1 Main St"
    assert org.city == "London"
    assert org.state == "London"
    assert org.country == "United Kingdom"
    assert org.postal_code == "SW1A 1AA"
    assert org.website == "https://acme.example"
    assert org.timezone == "Europe/London"
    assert org.phone == "+44 20 7946 0000"
    assert org.currency == "GBP"
    assert org.tax_no == "GB123456789"
    assert org.registration_number == "08452128"
    assert org.fiscal_year_start == "04-06"
    assert org.fiscal_year_end == "04-05"


def test_register_enterprise_stamps_commercial_source_server_side(db_session):
    data = RegisterRequest(
        organization="Beta Ltd",
        name="Bo Admin",
        email="bo@beta.example",
        password="StrongPass123!",
        # ZB-SA-CMD-003 v3.0: no country → an explicit currency is mandatory.
        currency="USD",
        intended_plan="essentials",
        currency="USD",
    )
    register_enterprise(db_session, data)

    org = _org_for(db_session, "bo@beta.example")
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE


def test_organization_new_row_defaults(db_session):
    org = make_organization(db_session, code="DEFAULT1", name="Defaults Co")
    db_session.commit()
    db_session.refresh(org)

    assert org.currency == "USD"
    assert org.timezone == "UTC"
    assert org.fiscal_year_start == "01-01"
    assert org.fiscal_year_end == "12-31"
    assert org.billing_classification == BillingClassification.COMMERCIAL_STANDALONE
    assert org.billing_source == BillingSource.REGISTERED_VIA_STANDALONE


def test_classification_source_round_trips_through_db(db_session):
    org = make_organization(db_session, code="ROUND", name="Round Trip Co")
    org.billing_classification = BillingClassification.COMMERCIAL_ZOIKO_ONE
    org.billing_source = BillingSource.REGISTERED_VIA_ZOIKO_ONE
    db_session.commit()
    db_session.expire(org)

    loaded = db_session.query(Organization).filter_by(id=org.id).first()
    assert loaded.billing_classification == BillingClassification.COMMERCIAL_ZOIKO_ONE
    assert loaded.billing_source == BillingSource.REGISTERED_VIA_ZOIKO_ONE


def test_organization_update_persists_profile_fields(db_session):
    org = make_organization(db_session, code="UPDT", name="Update Co")
    data = OrganizationUpdate(
        legal_name="Update Co SAS",
        city="Paris",
        state="Ile-de-France",
        country="France",
        postal_code="75001",
        website="https://update.example",
        fiscal_year_start="01-01",
        fiscal_year_end="12-31",
        currency="eur",
    )
    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(org, field, value)
    db_session.commit()
    db_session.refresh(org)

    assert org.legal_name == "Update Co SAS"
    assert org.city == "Paris"
    assert org.state == "Ile-de-France"
    assert org.country == "France"
    assert org.postal_code == "75001"
    assert org.website == "https://update.example"
    assert org.fiscal_year_start == "01-01"
    assert org.fiscal_year_end == "12-31"
    assert org.currency == "EUR"


def test_register_request_validates_currency_and_fiscal_year():
    with pytest.raises(ValidationError):
        RegisterRequest(
            organization="X",
            name="X Admin",
            email="x@x.example",
            password="StrongPass123!",
            fiscal_year_start="13-99",
        )
    with pytest.raises(ValidationError):
        RegisterRequest(
            organization="X",
            name="X Admin",
            email="x@x.example",
            password="StrongPass123!",
            currency="US",
        )
    ok = RegisterRequest(
        organization="X",
        name="X Admin",
        email="x@x.example",
        password="StrongPass123!",
        currency="gbp",
        fiscal_year_start="04-06",
        intended_plan="essentials",
    )
    assert ok.currency == "GBP"
    assert ok.fiscal_year_start == "04-06"


def test_organization_update_validates_currency_and_fiscal_year():
    with pytest.raises(ValidationError):
        OrganizationUpdate(fiscal_year_end="13-01")
    with pytest.raises(ValidationError):
        OrganizationUpdate(currency="XX")
    ok = OrganizationUpdate(currency="inr", fiscal_year_start="04-01")
    assert ok.currency == "INR"
    assert ok.fiscal_year_start == "04-01"


# ── ZB-COM-BILL-001 §B3: intended_plan capture, Enterprise self-serve block ──

def test_intended_plan_enterprise_rejected_at_schema_layer():
    """Enterprise is contract/quote-based only (§2) — it must be structurally
    unreachable through self-serve registration, rejected before any org/
    user/account row is ever created."""
    with pytest.raises(ValidationError):
        RegisterRequest(
            organization="Big Co",
            name="Big Admin",
            email="big@bigco.example",
            password="StrongPass123!",
            intended_plan="enterprise",
        )


def test_intended_plan_requires_a_value():
    with pytest.raises(ValidationError):
        RegisterRequest(
            organization="No Plan Co",
            name="No Plan Admin",
            email="noplan@example.com",
            password="StrongPass123!",
        )


def test_intended_plan_stored_without_provisioning_subscription(db_session):
    """A successful registration records the registrant's intended plan on
    the CommercialAccount for Sales/onboarding visibility, but never
    provisions a CommercialSubscription — Phase 7 seeds no plans, so a free/
    paid plan must never be invented merely to satisfy this flow."""
    data = RegisterRequest(
        organization="Plan Intent Co",
        name="Pat Admin",
        email="pat@planintent.example",
        password="StrongPass123!",
        # ZB-SA-CMD-003 v3.0: no country → an explicit currency is mandatory.
        currency="USD",
        intended_plan="professional",
        currency="USD",
    )
    register_enterprise(db_session, data)

    org = _org_for(db_session, "pat@planintent.example")
    account = db_session.query(CommercialAccount).filter_by(organization_id=org.id).first()
    assert account is not None
    assert account.intended_plan_code == "professional"

    subscription = (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account.id)
        .first()
    )
    assert subscription is None
