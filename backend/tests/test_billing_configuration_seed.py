"""
Regression tests for PHASE 4-5: BillingConfiguration is initialized from the
Organization's identity fields at registration and auto-populated on the lazy
GET /billing/settings/config backstop, while existing configurations are never
overwritten and operational defaults always remain.

These exercise the real BillingConfigurationService and register_enterprise
paths against the shared in-memory SQLite fixtures.
"""
from app.modules.auth.models import User
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.billing.models import (
    BillingConfiguration,
    CurrencyCode,
    DateFormat,
    NumberFormat,
    PaymentTerm,
)
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.organizations.models import Organization
from tests.conftest import make_organization


def _make_full_org(db):
    org = make_organization(db, code="FULL1", name="Acme Corp")
    org.legal_name = "Acme Corp Ltd"
    org.email = "billing@acme.example"
    org.phone = "+44 20 7946 0000"
    org.website = "https://acme.example"
    org.address = "1 Main St"
    org.city = "London"
    org.state = "London"
    org.country = "United Kingdom"
    org.postal_code = "SW1A 1AA"
    org.currency = "GBP"
    org.timezone = "Europe/London"
    org.fiscal_year_start = "04-06"
    org.fiscal_year_end = "04-05"
    org.tax_no = "GB123456789"
    org.registration_number = "08452128"
    db.commit()
    db.refresh(org)
    return org


def test_billing_configuration_seed_from_organization(db_session):
    org = _make_full_org(db_session)

    config = BillingConfigurationService(db_session).seed_billing_configuration(org.id)

    assert config.company_name == "Acme Corp"
    assert config.billing_email == "billing@acme.example"
    assert config.billing_phone == "+44 20 7946 0000"
    assert config.website == "https://acme.example"
    assert config.address_line1 == "1 Main St"
    assert config.city == "London"
    assert config.state == "London"
    assert config.country == "United Kingdom"
    assert config.postal_code == "SW1A 1AA"
    assert config.timezone == "Europe/London"
    assert config.fiscal_year_start == "04-06"
    assert config.fiscal_year_end == "04-05"
    assert config.default_currency == CurrencyCode.GBP
    assert config.home_currency == CurrencyCode.GBP
    assert config.base_currency == CurrencyCode.GBP
    assert config.tax_number == "GB123456789"
    assert config.business_registration_number == "08452128"


def test_existing_billing_configuration_is_not_overwritten(db_session):
    org = _make_full_org(db_session)
    existing = BillingConfiguration(
        organization_id=org.id,
        company_name="Custom Legal Name",
        billing_email="custom@acme.example",
        invoice_prefix="CST-",
        default_currency=CurrencyCode.USD,
        base_currency=CurrencyCode.USD,
        home_currency=CurrencyCode.USD,
    )
    db_session.add(existing)
    db_session.commit()
    existing_id = existing.id

    returned = BillingConfigurationService(db_session).seed_billing_configuration(org.id)

    assert returned.id == existing_id
    assert db_session.query(BillingConfiguration).filter_by(organization_id=org.id).count() == 1
    assert returned.company_name == "Custom Legal Name"
    assert returned.billing_email == "custom@acme.example"
    assert returned.invoice_prefix == "CST-"
    assert returned.default_currency == CurrencyCode.USD
    assert returned.city is None


def test_get_billing_settings_auto_initializes(db_session):
    org = _make_full_org(db_session)
    assert db_session.query(BillingConfiguration).filter_by(organization_id=org.id).first() is None

    config = BillingConfigurationService(db_session).get_configuration(org.id)

    assert config is not None
    assert config.company_name == "Acme Corp"
    assert config.billing_email == "billing@acme.example"
    assert config.default_currency == CurrencyCode.GBP

    fresh = db_session.query(BillingConfiguration).filter_by(organization_id=org.id).first()
    assert fresh is not None
    assert fresh.id == config.id


def test_registration_creates_billing_configuration(db_session):
    data = RegisterRequest(
        organization="Acme Corp",
        name="Ada Admin",
        email="ada@acme.example",
        password="StrongPass123!",
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

    admin = db_session.query(User).filter_by(email="ada@acme.example").first()
    assert admin is not None
    org = db_session.query(Organization).filter_by(id=admin.organization_id).first()
    config = db_session.query(BillingConfiguration).filter_by(organization_id=admin.organization_id).first()

    assert config is not None
    assert config.company_name == "Acme Corp"
    assert config.billing_email == "ada@acme.example"
    assert config.billing_phone == "+44 20 7946 0000"
    assert config.website == "https://acme.example"
    assert config.city == "London"
    assert config.state == "London"
    assert config.country == "United Kingdom"
    assert config.postal_code == "SW1A 1AA"
    assert config.timezone == "Europe/London"
    assert config.default_currency == CurrencyCode.GBP
    assert config.tax_number == "GB123456789"
    assert config.business_registration_number == "08452128"
    assert config.fiscal_year_start == "04-06"
    assert config.fiscal_year_end == "04-05"
    assert org.billing_source is not None


def test_operational_defaults_remain(db_session):
    org = make_organization(db_session, code="OPS1", name="Ops Co")
    db_session.commit()

    config = BillingConfigurationService(db_session).seed_billing_configuration(org.id)

    assert config.company_name == "Ops Co"
    assert config.invoice_prefix == "INV-"
    assert config.quote_prefix == "QTE-"
    assert config.invoice_number_format == NumberFormat.PREFIX_YYYY_SEQ
    assert config.default_payment_terms == PaymentTerm.NET_30
    assert config.default_due_days == 30
    assert config.date_format == DateFormat.DD_MM_YYYY
    assert config.language == "en"
    assert config.tax_label == "VAT"


def test_unsupported_org_currency_falls_back_to_default(db_session):
    org = make_organization(db_session, code="CUR1", name="Cur Co")
    org.currency = "XYZ"
    db_session.commit()

    config = BillingConfigurationService(db_session).seed_billing_configuration(org.id)

    assert config.default_currency == CurrencyCode.USD
    assert config.home_currency == CurrencyCode.USD
    assert config.base_currency == CurrencyCode.USD


def test_organization_update_does_not_unintentionally_overwrite_billing_config(db_session):
    """Synchronization is intentionally one-way (registration time only):
    later Organization edits must never overwrite an existing configuration."""
    org = make_organization(db_session, code="SYNC1", name="Original Co")
    db_session.commit()

    config = BillingConfigurationService(db_session).seed_billing_configuration(org.id)
    db_session.commit()
    assert config.company_name == "Original Co"

    org.organization_name = "Renamed Co"
    db_session.commit()

    fresh = db_session.query(BillingConfiguration).filter_by(organization_id=org.id).first()
    assert fresh.company_name == "Original Co"
    assert db_session.query(BillingConfiguration).filter_by(organization_id=org.id).count() == 1
