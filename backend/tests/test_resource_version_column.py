"""
CRIT-Q17 / Item 2 (option 1) — optimistic-lock `version` column.

Confirms `version` actually increments on EVERY audited write path for the two
resources the invoice_draft preview depends on (BillingCustomer and
BillingConfiguration), including AUTOMATIC recalcs (sync_outstanding_balance) —
per the approval directive: "bumping on every mutation, human or automatic, is
the safer default; err toward extra invalidation over missed staleness."

These exercise the real repositories/services against the shared in-memory
SQLite fixtures. The bump is EXPLICIT (service/repository layer), never an ORM
`onupdate` hook, so a future bulk Query.update()/raw-SQL path cannot silently
skip it.
"""
from decimal import Decimal

import pytest

from app.modules.billing.models import BillingConfiguration
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from tests.conftest import make_customer, make_organization


# ── BillingCustomer ─────────────────────────────────────────────────────────

def _fresh_customer(db):
    org = make_organization(db, code="VORG1", name="Version Org")
    return org, make_customer(db, org.id, code="VCUST1")


def test_create_starts_at_version_one(db_session):
    _, cust = _fresh_customer(db_session)
    assert cust.version == 1
    db_session.refresh(cust)
    assert cust.version == 1


def test_create_customer_service_starts_at_version_one(db_session):
    org = make_organization(db_session, code="VORG2", name="Version Org 2")
    svc = CustomerService(db_session)
    cust = svc.create_customer(
        org.id,
        created_by=1,
        customer_code="VCUST2",
        company_name="Create Path Co",
        currency="USD",
    )
    assert cust.version == 1


def test_update_customer_bumps_version(db_session):
    _, cust = _fresh_customer(db_session)
    db_session.refresh(cust)
    assert cust.version == 1

    svc = CustomerService(db_session)
    svc.update_customer(cust.id, cust.organization_id, updated_by=1, email="new@example.com")

    db_session.refresh(cust)
    assert cust.version == 2


def test_activate_deactivate_suspend_each_bump_version(db_session):
    _, cust = _fresh_customer(db_session)
    # make_customer default status is ACTIVE, so the first mutation must be a
    # transition away from ACTIVE (deactivate). Each transition bumps once.
    assert cust.version == 1

    svc = CustomerService(db_session)

    svc.deactivate_customer(cust.id, cust.organization_id, updated_by=1)
    db_session.refresh(cust)
    assert cust.version == 2

    svc.activate_customer(cust.id, cust.organization_id, updated_by=1)
    db_session.refresh(cust)
    assert cust.version == 3

    svc.suspend_customer(cust.id, cust.organization_id, updated_by=1)
    db_session.refresh(cust)
    assert cust.version == 4


def test_sync_outstanding_balance_bumps_version_even_with_no_invoices(db_session):
    """The explicit approval case: an AUTOMATIC balance recalc is exactly the
    kind of change that must invalidate a stale preview. sync_outstanding_balance
    goes through repo.save, so version must bump even when there is nothing to
    change (0 outstanding)."""
    _, cust = _fresh_customer(db_session)
    db_session.refresh(cust)
    assert cust.version == 1

    svc = CustomerService(db_session)
    svc.sync_outstanding_balance(cust.id, cust.organization_id)

    db_session.refresh(cust)
    assert cust.version == 2


def test_adjust_credit_balance_bumps_version(db_session):
    _, cust = _fresh_customer(db_session)
    db_session.refresh(cust)
    assert cust.version == 1

    svc = CustomerService(db_session)
    svc.adjust_credit_balance(
        cust.id, cust.organization_id, amount=Decimal("50.00"),
        adj_type="increase", reason="test", updated_by=1,
    )

    db_session.refresh(cust)
    assert cust.version == 2


def test_bulk_update_status_bumps_each_customer(db_session):
    org = make_organization(db_session, code="VORG3", name="Version Org 3")
    c1 = make_customer(db_session, org.id, code="VCB1")
    c2 = make_customer(db_session, org.id, code="VCB2")
    db_session.commit()
    db_session.refresh(c1)
    db_session.refresh(c2)
    assert c1.version == 1
    assert c2.version == 1

    svc = CustomerService(db_session)
    svc.bulk_update_status(org.id, [c1.id, c2.id], status="inactive", updated_by=1)

    db_session.refresh(c1)
    db_session.refresh(c2)
    assert c1.version == 2
    assert c2.version == 2


def test_soft_delete_and_restore_bump_version(db_session):
    _, cust = _fresh_customer(db_session)
    svc = CustomerService(db_session)

    svc.repo.soft_delete(cust.id, cust.organization_id)
    db_session.refresh(cust)
    assert cust.version == 2

    svc.restore_customer(cust.id, cust.organization_id, updated_by=1)
    db_session.refresh(cust)
    assert cust.version == 3


def test_update_customer_to_same_values_still_bumps_version(db_session):
    """Even a no-op-ish update (same email) must advance version — we can't
    distinguish 'really changed' from 're-sent same value', so err toward
    invalidation."""
    _, cust = _fresh_customer(db_session)
    db_session.refresh(cust)
    assert cust.version == 1

    svc = CustomerService(db_session)
    svc.update_customer(cust.id, cust.organization_id, updated_by=1, email="customer@example.com")

    db_session.refresh(cust)
    assert cust.version == 2


# ── BillingConfiguration ────────────────────────────────────────────────────

@pytest.fixture()
def _config(db_session):
    org = make_organization(db_session, code="VORG4", name="Config Org")
    svc = BillingConfigurationService(db_session)
    config = svc.seed_billing_configuration(org.id)
    db_session.commit()
    db_session.refresh(config)
    assert config.version == 1
    return config


def test_config_seed_starts_at_version_one(_config):
    assert _config.version == 1


def test_config_upsert_bumps_version(_config, db_session):
    repo = BillingConfigurationRepository(db_session)
    config = repo.upsert(_config.organization_id, updated_by=1, company_name="Renamed Co")
    db_session.refresh(config)
    assert config.version == 2

    config = repo.upsert(_config.organization_id, updated_by=1, default_currency="INR")
    db_session.refresh(config)
    assert config.version == 3


def test_config_update_service_bumps_version(_config, db_session):
    svc = BillingConfigurationService(db_session)
    config = svc.update_configuration(_config.organization_id, updated_by=1, company_name="Svc Co")
    db_session.refresh(config)
    assert config.version == 2


def test_config_reset_to_defaults_recreates_at_version_one(_config, db_session):
    """reset_to_defaults is a delete+re-create; the fresh row starts back at v1."""
    repo = BillingConfigurationRepository(db_session)
    config = repo.reset_to_defaults(_config.organization_id, updated_by=1)
    db_session.refresh(config)
    assert config.version == 1


def test_fx_refresh_bumps_config_version(_config, db_session, monkeypatch):
    """An AUTOMATIC FX refresh mutates BillingConfiguration.exchange_* fields
    and must bump version so a stale invoice_draft preview pins a now-different
    config. Monkeypatch the live fetch to avoid network."""
    from app.modules.billing.services.exchange_rate_service import ExchangeRateService

    def fake_fetch_all_rates(self, base):
        return {"USD": 1.0, "INR": 83.0}, {"last_refreshed": "2026-01-01"}

    monkeypatch.setattr(ExchangeRateService, "_fetch_all_rates", fake_fetch_all_rates)
    svc = ExchangeRateService(db_session)
    result = svc.refresh_rates(_config.organization_id)

    assert result["base_currency"] == "USD"
    db_session.refresh(_config)
    assert _config.version == 2
