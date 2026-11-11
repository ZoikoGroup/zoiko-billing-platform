"""tests/test_tax_phase8_source_race_pg.py
---------------------------------------
ZB-TAX-ARCH-001 Phase 8 PR 5: two live source-monitor workers against
PostgreSQL record exactly one observation per monitor per due cycle and make
one request to the source host (FOR UPDATE SKIP LOCKED on the monitor, the
per-host row lock and the one-request-per-minute rule).

No network: an httpx MockTransport and a fixed public resolver.

COMMITS, so it runs only with TAX_PG_TEST_URL plus TAX_PG_RACE_COMMITS=1,
last and alone in the CI tax step.
"""
import os
import threading
import traceback
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()
COMMITS_ALLOWED = os.environ.get("TAX_PG_RACE_COMMITS") == "1"

pytestmark = pytest.mark.skipif(
    not (PG_URL and COMMITS_ALLOWED),
    reason="needs TAX_PG_TEST_URL and TAX_PG_RACE_COMMITS=1 (commits to a throwaway PostgreSQL database)",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.tax.source_fetch import SafeFetcher  # noqa: E402
from app.modules.tax.source_monitor_models import (  # noqa: E402
    TaxSourceHost, TaxSourceMonitor, TaxSourceObservation,
)
from app.modules.tax.source_monitor_service import run_source_monitoring  # noqa: E402

UTC = timezone.utc


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL, pool_size=4)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


def test_two_workers_record_one_observation_per_cycle(engine):
    now = datetime.now(UTC)
    page_requests, lock = [], threading.Lock()

    def handler(request):
        with lock:
            page_requests.append(request.url.path)
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>VAT 20%</p>")

    fetcher = SafeFetcher(transport=httpx.MockTransport(handler), resolver=lambda host: ["151.101.0.144"])
    setup = Session(bind=engine)
    host = setup.get(TaxSourceHost, "www.legislation.gov.uk") or TaxSourceHost(host="www.legislation.gov.uk")
    host.robots_fetched_at, host.robots_status, host.robots_body = now, 404, None     # robots.txt cached: absent
    host.last_request_at = now - timedelta(hours=1)
    setup.merge(host)
    m = TaxSourceMonitor(title=f"race {os.getpid()}", monitoring_url="https://www.legislation.gov.uk/race",
                         host="www.legislation.gov.uk", risk_tier="NATIONAL_VAT_GST", access_mode="AUTOMATED",
                         enabled=True, next_check_due=now - timedelta(minutes=1), consecutive_failures=0,
                         consecutive_429=0, dismissals=0, created_at=now)
    setup.add(m)
    setup.commit()
    monitor_id = m.id
    setup.close()

    barrier, errors = threading.Barrier(2), []

    def worker():
        db = Session(bind=engine)
        try:
            barrier.wait()
            run_source_monitoring(db, now=now, fetcher=fetcher)
        except Exception:                                   # surfaced below, never swallowed
            errors.append(traceback.format_exc())
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors[0]

    check = Session(bind=engine)
    try:
        observations = check.query(TaxSourceObservation).filter(TaxSourceObservation.monitor_id == monitor_id).all()
        assert len(observations) == 1 and observations[0].outcome == "BASELINE"
        assert page_requests == ["/race"]                                           # one request to the host
        assert check.get(TaxSourceMonitor, monitor_id).next_check_due > now
    finally:
        check.close()
