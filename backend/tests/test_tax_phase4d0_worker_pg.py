"""tests/test_tax_phase4d0_worker_pg.py
------------------------------------
ZB-TAX-ARCH-001 Phase 4d-0 (deferred from 4a-1): two live reconciliation
workers against PostgreSQL process each outbox row once.

Two workers run concurrently, each on its own database connection and
session (as two worker processes would). They start together on a barrier,
and the provider is slow, so their passes overlap. FOR UPDATE SKIP LOCKED
must give each row to one worker: the provider sees every idempotency key
exactly once.

Unlike the other PG modules this one must COMMIT (another connection can't
see uncommitted rows), so it runs only in a throwaway database:
TAX_PG_TEST_URL plus TAX_PG_RACE_COMMITS=1, as a separate, last pytest call
in the CI tax step. Skipped otherwise; an error when TAX_PG_TESTS_REQUIRED is
set without a URL.
"""
import os
import threading
import time

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

from app.modules.tax.enums import OutboxOperation, OutboxState  # noqa: E402
from app.modules.tax.provider_issuance import ProviderIssuanceService, beat_for_tests  # noqa: E402
from app.modules.tax.provider_models import TaxProviderOutbox  # noqa: E402
from app.modules.tax.reconciliation_worker import run as run_worker  # noqa: E402
from app.modules.tax.determination_service import TaxDeterminationService  # noqa: E402
from app.modules.tax.enums import TaxQuoteStatus  # noqa: E402
from tests.test_tax_phase3a_governed import build_world, draft  # noqa: E402

ROWS = 16


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL, pool_size=6)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


def test_two_live_workers_process_each_row_once(engine, monkeypatch):
    setup = Session(bind=engine)
    w = build_world(setup, org_code=f"P4DRACE{os.getpid() % 100000}")
    issuance = ProviderIssuanceService(setup)
    row_ids = []
    for _ in range(ROWS):
        inv = draft(w, [(w["dig_product"], 100, 1, False)])
        q = TaxDeterminationService(setup).create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)
        assert q.status == TaxQuoteStatus.QUOTED and q.provider_connection_id == w["connection"].id
        row_ids.append(issuance.begin(inv, q, w["maker"].id).id)
    beat_for_tests(setup)
    setup.commit()
    assert setup.query(TaxProviderOutbox).filter(TaxProviderOutbox.id.in_(row_ids),
                                                 TaxProviderOutbox.state == OutboxState.PENDING).count() == ROWS

    fake, lock, seen = w["provider"], threading.Lock(), []
    original_commit = fake.commit

    def slow_commit(*, idempotency_key, payload, **kw):
        with lock:
            seen.append((idempotency_key, threading.current_thread().name))
        time.sleep(0.05)                                         # hold the row lock so the passes overlap
        return original_commit(idempotency_key=idempotency_key, payload=payload, **kw)

    monkeypatch.setattr(fake, "commit", slow_commit)
    barrier = threading.Barrier(2)
    errors = []

    def one_pass():
        session = Session(bind=engine)
        try:
            barrier.wait(timeout=30)
            ProviderIssuanceService(session).reconcile()
        except Exception as exc:                                 # surfaced below
            errors.append(repr(exc))
        finally:
            session.close()

    def worker(name):
        try:
            run_worker(once=True, run_once=one_pass)
        except Exception as exc:
            errors.append(f"{name}: {exc!r}")

    threads = [threading.Thread(target=worker, args=(n,), name=n) for n in ("worker-a", "worker-b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=300)
    assert not errors, errors
    assert all(not t.is_alive() for t in threads)

    keys = [k for k, _ in seen]
    assert len(keys) == ROWS and len(set(keys)) == ROWS          # every row committed, none twice
    assert {name for _, name in seen} == {"worker-a", "worker-b"}  # both workers really worked
    check = Session(bind=engine)
    try:
        rows = check.query(TaxProviderOutbox).filter(TaxProviderOutbox.id.in_(row_ids),
                                                     TaxProviderOutbox.operation == OutboxOperation.COMMIT).all()
        assert len(rows) == ROWS and all(r.state != OutboxState.PENDING for r in rows)
        assert all(r.attempts == 1 for r in rows)                # no row was attempted by both workers
        assert len(fake.ledger) == ROWS
    finally:
        check.close()
        setup.close()
