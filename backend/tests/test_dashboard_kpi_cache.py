"""
Regression tests for the dashboard KPI cache (BillingDashboardService.get_kpis).

Covers:
  - a repeated call within the TTL serves the SAME aggregate instead of
    re-scanning committed invoice changes
  - the cache is keyed by the full (organization_id, period, date_from, date_to)
    so filtered views never collide with the unfiltered headline
  - DASHBOARD_KPI_CACHE_TTL_SECONDS=0 disables the cache (fresh reads always)
"""
import pytest

from app.config import settings
from app.modules.billing.services.dashboard_service import BillingDashboardService, _KPI_CACHE
from tests.conftest import make_customer, make_invoice, make_organization


@pytest.fixture()
def kpi_cache(monkeypatch):
    cache = _KPI_CACHE
    assert settings.DASHBOARD_KPI_CACHE_TTL_SECONDS > 0
    yield cache


def test_repeat_call_within_ttl_is_cached(db_session, kpi_cache):
    org = make_organization(db_session, code="KPI1", name="KPI Org")
    customer = make_customer(db_session, org.id, code="KCUST")
    make_invoice(db_session, org.id, customer.id, total_amount="1000.00", invoice_number="KINV1")
    db_session.commit()

    service = BillingDashboardService(db_session)
    first = service.get_kpis(organization_id=org.id)
    assert first["total_revenue"] == 1000.0

    make_invoice(db_session, org.id, customer.id, total_amount="2000.00", invoice_number="KINV2")
    db_session.commit()

    second = service.get_kpis(organization_id=org.id)
    assert second["total_revenue"] == 1000.0, "cached result must not see the new invoice"

    kpi_cache.clear()
    third = service.get_kpis(organization_id=org.id)
    assert third["total_revenue"] == 3000.0, "after expiry the aggregate must be fresh"


def test_period_filters_do_not_collide(db_session):
    org = make_organization(db_session, code="KPI2", name="KPI Org 2")
    customer = make_customer(db_session, org.id, code="KCUST2")
    make_invoice(db_session, org.id, customer.id, total_amount="500.00", invoice_number="KINV3")
    db_session.commit()

    service = BillingDashboardService(db_session)
    unfiltered = service.get_kpis(organization_id=org.id)

    past = service.get_kpis(organization_id=org.id, date_from="2020-01-01", date_to="2020-12-31")
    assert past["total_revenue"] == 0.0, "past window must not hit the unfiltered cache entry"
    assert unfiltered["total_revenue"] == 500.0


def test_zero_ttl_disables_cache(db_session, monkeypatch):
    monkeypatch.setattr(settings, "DASHBOARD_KPI_CACHE_TTL_SECONDS", 0)
    org = make_organization(db_session, code="KPI3", name="KPI Org 3")
    customer = make_customer(db_session, org.id, code="KCUST3")
    make_invoice(db_session, org.id, customer.id, total_amount="700.00", invoice_number="KINV4")
    db_session.commit()

    service = BillingDashboardService(db_session)
    assert service.get_kpis(organization_id=org.id)["total_revenue"] == 700.0

    make_invoice(db_session, org.id, customer.id, total_amount="300.00", invoice_number="KINV5")
    db_session.commit()
    assert service.get_kpis(organization_id=org.id)["total_revenue"] == 1000.0, "disabled cache must read fresh data"