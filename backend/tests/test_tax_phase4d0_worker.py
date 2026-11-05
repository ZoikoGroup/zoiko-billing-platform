"""
tests/test_tax_phase4d0_worker.py
---------------------------------
ZB-TAX-ARCH-001 Phase 4d-0: the dedicated reconciliation worker.

The mode switch (worker: the web app schedules nothing; in_app: it does), the
worker loop (startup checks, --once, stop on SIGTERM, disabled), and that a
stale heartbeat still blocks provider issuing in worker mode. The two-worker
race on PostgreSQL is tests/test_tax_phase4d0_worker_pg.py.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.config import settings
from app.modules.tax import reconciliation_runner, reconciliation_worker
from app.modules.tax.enums import TaxQuoteStatus
from app.modules.tax.provider_issuance import beat_for_tests
from tests.test_tax_phase3a_governed import build_world, draft, finalize, quote


@pytest.fixture(autouse=True)
def _no_scheduler():
    reconciliation_runner.shutdown()
    yield
    reconciliation_runner.shutdown()


@pytest.fixture()
def startup_checks(monkeypatch):
    calls = []
    import app.database as database
    from app.modules.tax import secret_store

    monkeypatch.setattr(database, "verify_critical_columns_present", lambda: calls.append("columns"))
    monkeypatch.setattr(secret_store, "verify_secret_store_at_startup", lambda: calls.append("secret_store"))
    return calls


# ── the mode switch ─────────────────────────────────────────────────────

def test_worker_mode_means_the_web_app_schedules_nothing(monkeypatch):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_MODE", "worker")
    reconciliation_runner.start()
    assert reconciliation_runner._scheduler is None


def test_in_app_mode_schedules_reconciliation_in_the_web_app(monkeypatch):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_MODE", "in_app")
    reconciliation_runner.start()
    assert reconciliation_runner._scheduler is not None
    assert reconciliation_runner._scheduler.get_job(reconciliation_runner.JOB_ID) is not None


def test_an_unknown_mode_refuses_to_start(monkeypatch):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_MODE", "cron")
    with pytest.raises(SystemExit, match="worker, in_app"):
        reconciliation_runner.start()


# ── the worker loop ─────────────────────────────────────────────────────

def test_once_runs_the_startup_checks_and_one_pass(monkeypatch, startup_checks):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_MODE", "worker")
    passes = []
    assert reconciliation_worker.run(once=True, run_once=lambda: passes.append(1) or {"delivered": 2}) == 0
    assert passes == [1] and startup_checks == ["columns", "secret_store"]


def test_the_loop_runs_until_stopped(monkeypatch, startup_checks):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS", 1)
    passes = []

    def one_pass():
        passes.append(1)
        if len(passes) == 2:
            reconciliation_worker.request_stop()                # what SIGTERM does
        return {}

    assert reconciliation_worker.run(run_once=one_pass) == 0
    assert len(passes) == 2


def test_a_failed_pass_does_not_stop_the_worker(monkeypatch, startup_checks):
    passes = []

    def one_pass():
        passes.append(1)
        raise RuntimeError("database blip")

    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS", 1)
    assert reconciliation_worker.run(max_runs=2, run_once=one_pass) == 0
    assert len(passes) == 2


def test_a_disabled_worker_exits_without_running(monkeypatch, startup_checks):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_ENABLED", False)
    passes = []
    assert reconciliation_worker.run(once=True, run_once=lambda: passes.append(1)) == 0
    assert passes == []


def test_the_worker_refuses_an_unsafe_secret_store(monkeypatch):
    import app.database as database

    monkeypatch.setattr(database, "verify_critical_columns_present", lambda: None)
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "vault")
    with pytest.raises(SystemExit, match="must be one of"):
        reconciliation_worker.run(once=True, run_once=lambda: {})


def test_main_is_the_process_entry_point(monkeypatch):
    seen = {}
    monkeypatch.setattr(reconciliation_worker, "run", lambda once=False: seen.setdefault("once", once) and 0)
    with pytest.raises(SystemExit) as exit_info:
        reconciliation_worker.main(["--once"])
    assert seen == {"once": True} and exit_info.value.code in (0, True)


def test_the_real_pass_writes_the_heartbeat(db_session, monkeypatch, startup_checks):
    from app.modules.tax.provider_issuance import ProviderIssuanceService

    world = build_world(db_session, org_code="P4DW")
    old = datetime.now(timezone.utc) - timedelta(days=1)
    beat_for_tests(db_session, at=old)
    db_session.commit()
    assert ProviderIssuanceService(db_session).health.heartbeat_problem() is not None
    reconciliation_worker.run(once=True, run_once=lambda: ProviderIssuanceService(db_session).reconcile())
    assert ProviderIssuanceService(db_session).health.heartbeat_problem() is None
    assert world["org"].id


# ── fail closed in worker mode ──────────────────────────────────────────

def test_a_stale_heartbeat_blocks_provider_issuing_in_worker_mode(db_session, monkeypatch):
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_MODE", "worker")
    w = build_world(db_session, org_code="P4DWS")
    stale = datetime.now(timezone.utc) - timedelta(
        seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS * (settings.TAX_PROVIDER_HEARTBEAT_STALE_INTERVALS + 1))
    beat_for_tests(db_session, at=stale)
    db_session.commit()
    inv = draft(w, [(w["dig_product"], 100, 1, False)])
    assert quote(w, inv).status == TaxQuoteStatus.QUOTED
    with pytest.raises(Exception, match="reconciliation is not running"):
        finalize(w, inv)
    assert w["provider"].payloads == []
