"""
tests/test_exchange_rate_background_refresh.py
-----------------------------------------------
Verifies Task 2 of the page-load performance pass:

1. The dashboard request path (`_build_currency_rates`) NEVER makes a live
   exchange-rate HTTP call — it reads cached/legacy rates and falls back to
   1.0 when a rate is missing. A slow/unreachable FX API must not add latency
   to a page-load response.
2. The scheduled background job (`run_exchange_rate_refresh_job`) refreshes
   stale cached rates for auto-refresh organisations, using its OWN session
   (so ExchangeRateService never commits/rolls back a session it was handed).
3. The job skips organisations that have not opted into auto-refresh.

Uses the shared in-memory SQLite fixtures (tests/conftest.py).
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.modules.billing.models import BillingConfiguration
from app.modules.billing.services.dashboard_service import BillingDashboardService
from app.modules.billing.services.exchange_rate_service import (
    EXCHANGE_RATE_MAX_AGE_HOURS,
    ExchangeRateService,
)
from app.modules.billing.tasks.exchange_rates import run_exchange_rate_refresh_job
from tests.conftest import make_customer, make_invoice, make_organization


@pytest.fixture()
def org(db_session):
    return make_organization(db_session)


def _make_config(db, org, *, auto_refresh=True, last_refreshed=None, rates=None):
    from app.modules.billing.models import CurrencyCode
    config = BillingConfiguration(
        organization_id=org.id,
        base_currency=CurrencyCode.USD if hasattr(CurrencyCode, "USD") else "USD",
        exchange_rate_auto_refresh=auto_refresh,
        exchange_rate_last_refreshed=last_refreshed,
        exchange_rates=rates or {"USD": 1.0, "EUR": 0.92, "INR": 83.5},
    )
    db.add(config)
    db.flush()
    return config


def test_dashboard_rates_never_call_live_api(db_session, org, monkeypatch):
    """The request path must read cached rates only — no live HTTP, no inline
    refresh, even when the cache is stale or missing."""
    _make_config(
        db_session, org,
        last_refreshed=datetime.now(timezone.utc) - timedelta(hours=EXCHANGE_RATE_MAX_AGE_HOURS + 1),
    )
    # An EUR invoice puts EUR into the dashboard's currency set.
    cust = make_customer(db_session, org.id, code="EUR-CUST", currency="EUR")
    make_invoice(db_session, org.id, cust.id, currency="EUR")
    db_session.flush()

    calls = {"refresh": 0}
    monkeypatch.setattr(
        ExchangeRateService, "refresh_rates",
        lambda *a, **k: calls.__setitem__("refresh", calls["refresh"] + 1),
    )
    monkeypatch.setattr(
        ExchangeRateService, "get_rate",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("live get_rate called")),
    )

    svc = BillingDashboardService(db_session)
    rates = svc._build_currency_rates(org.id)

    # Cached EUR/USD present -> real multiplier, not 1.0 fallback. The cached
    # dict stores "per-USD" ratios ({USD:1.0, EUR:0.92}); the EUR→base multiplier
    # is therefore 1/0.92 ≈ 1.08696, computed purely from the cache.
    assert rates.get("EUR") == pytest.approx(1.0 / 0.92)
    assert calls["refresh"] == 0, "request path must not trigger an inline refresh"


def test_dashboard_rate_missing_falls_back_to_1(db_session, org, monkeypatch):
    """A missing cached rate falls back to 1.0 (never blocks on the live API);
    the background job will populate a real rate on its next run."""
    _make_config(
        db_session, org,
        auto_refresh=True,
        last_refreshed=datetime.now(timezone.utc) - timedelta(hours=EXCHANGE_RATE_MAX_AGE_HOURS + 1),
        rates={"USD": 1.0},
    )
    cust = make_customer(db_session, org.id, code="INR-CUST", currency="INR")
    make_invoice(db_session, org.id, cust.id, currency="INR")
    db_session.flush()

    monkeypatch.setattr(
        ExchangeRateService, "refresh_rates",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("live refresh called")),
    )

    rates = BillingDashboardService(db_session)._build_currency_rates(org.id)
    assert rates.get("INR") == 1.0, "missing rate must fall back to 1.0, not block"


def test_background_job_refreshes_stale_rates(db_session, org, monkeypatch):
    """The scheduled job refreshes stale cached rates for auto-refresh orgs and
    persists them (its own session commit), using the live fetch."""
    config = _make_config(
        db_session, org,
        last_refreshed=datetime.now(timezone.utc) - timedelta(hours=EXCHANGE_RATE_MAX_AGE_HOURS + 1),
    )
    db_session.commit()

    monkeypatch.setattr(
        "app.modules.billing.services.exchange_rate_service.ExchangeRateService._fetch_all_rates",
        lambda self, base: ({"USD": 1.0, "EUR": 0.85, "INR": 88.0}, {"base": "USD"}),
    )

    # The job runs against the SAME in-memory DB via its own SessionLocal. The
    # in-memory SQLite store is per-engine here; monkeypatch SessionLocal to a
    # sessionmaker bound to the test's engine so the job's writes are visible
    # to the test session.
    engine = db_session.get_bind()
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    monkeypatch.setattr("app.modules.billing.tasks.exchange_rates.SessionLocal", factory)

    summary = run_exchange_rate_refresh_job()
    assert summary["organisations_refreshed"] == 1, summary

    db_session.expire_all()
    refreshed = db_session.get(BillingConfiguration, config.id)
    assert refreshed.exchange_rate_last_refreshed is not None
    # EUR rate should now be 0.85 (job persisted the fetched rate).
    assert refreshed.exchange_rates["EUR"] == 0.85


def test_background_job_skips_orgs_without_auto_refresh(db_session, org, monkeypatch):
    """Orgs that never opted into auto-refresh are left alone by the job."""
    _make_config(
        db_session, org,
        auto_refresh=False,
        last_refreshed=datetime.now(timezone.utc) - timedelta(hours=EXCHANGE_RATE_MAX_AGE_HOURS + 1),
        rates={"USD": 1.0, "EUR": 0.92},
    )
    db_session.commit()

    monkeypatch.setattr(
        "app.modules.billing.services.exchange_rate_service.ExchangeRateService._fetch_all_rates",
        lambda self, base: ({"USD": 1.0, "EUR": 0.80}, {"base": "USD"}),
    )

    from sqlalchemy.orm import sessionmaker

    engine = db_session.get_bind()
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.modules.billing.tasks.exchange_rates.SessionLocal", factory)

    summary = run_exchange_rate_refresh_job()
    assert summary["organisations_refreshed"] == 0, summary

    db_session.expire_all()
    config = db_session.query(BillingConfiguration).filter(
        BillingConfiguration.organization_id == org.id
    ).one()
    assert config.exchange_rates["EUR"] == 0.92, "auto-refresh-disabled org must not be touched"