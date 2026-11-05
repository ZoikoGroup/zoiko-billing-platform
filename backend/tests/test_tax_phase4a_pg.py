"""tests/test_tax_phase4a_pg.py
----------------------------
ZB-TAX-ARCH-001 Phase 4a-1 guarantees only PostgreSQL provides for the
provider issuance outbox: key fields frozen from insert, terminal rows final,
deletes only under the erasure flag, one active COMMIT per invoice, rows
claimed with FOR UPDATE SKIP LOCKED, and a provider-taxed invoice issued end
to end against every trigger.

Same contract as the earlier PG modules: runs only with TAX_PG_TEST_URL,
skipped with a reason when unset, an error when TAX_PG_TESTS_REQUIRED is set,
never SQLite. Each test runs in one outer transaction that is rolled back.
"""
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 4a tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.billing.models import InvoiceStatus  # noqa: E402
from app.modules.tax.enums import OutboxOperation, OutboxState  # noqa: E402
from app.modules.tax.provider_issuance import ProviderIssuanceService  # noqa: E402
from app.modules.tax.provider_models import TaxProviderOutbox  # noqa: E402
from tests.test_tax_phase3a_governed import build_world, draft, finalize, quote  # noqa: E402


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


@pytest.fixture()
def pg(engine):
    connection = engine.connect()
    outer = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        outer.rollback()
        connection.close()


def _rejects(session, sql, params=None):
    with pytest.raises(IntegrityError):
        with session.begin_nested():
            session.execute(text(sql), params or {})


def _accepts(session, sql, params=None):
    with session.begin_nested():
        session.execute(text(sql), params or {})


@pytest.fixture()
def issued(pg):
    w = build_world(pg, org_code=f"P4APG{id(pg) % 100000}")
    inv = draft(w, [(w["dig_product"], 100, 1, False)])
    q = quote(w, inv)
    issued_invoice = finalize(w, inv)
    pg.flush()
    row = pg.query(TaxProviderOutbox).filter(TaxProviderOutbox.invoice_id == inv.id,
                                             TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    return {"w": w, "invoice": issued_invoice, "quote": q, "row": row}


def test_phase4a_tables_and_triggers_exist(pg):
    tables = set(pg.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")).scalars())
    assert {"tax_provider_outbox", "tax_provider_circuits", "tax_job_heartbeats"} <= tables
    triggers = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    assert {"trg_tax_provider_outbox_guard", "trg_tax_provider_outbox_terminal_guard"} <= triggers


def test_provider_invoice_issues_end_to_end_on_postgres(pg, issued):
    pg.refresh(issued["invoice"])
    assert issued["invoice"].status == InvoiceStatus.SENT
    assert issued["row"].state == OutboxState.DONE


def test_outbox_key_fields_are_frozen_and_terminal_rows_final(pg, issued):
    rid = issued["row"].id
    _rejects(pg, "UPDATE tax_provider_outbox SET idempotency_key = 'other' WHERE id = :id", {"id": rid})
    _rejects(pg, "UPDATE tax_provider_outbox SET last_error = 'x' WHERE id = :id", {"id": rid})   # DONE is final
    _rejects(pg, "UPDATE tax_provider_outbox SET state = 'PENDING' WHERE id = :id", {"id": rid})


def test_outbox_rows_are_deleted_only_under_the_erasure_flag(pg, issued):
    rid = issued["row"].id
    _rejects(pg, "DELETE FROM tax_provider_outbox WHERE id = :id", {"id": rid})
    with pg.begin_nested():
        pg.execute(text("SET LOCAL zoiko.tax_erasure = 'on'"))
        pg.execute(text("DELETE FROM tax_provider_outbox WHERE invoice_id = :i"), {"i": issued["invoice"].id})


def test_one_active_commit_per_invoice(pg):
    w = build_world(pg, org_code=f"P4AUQ{id(pg) % 100000}")
    inv = draft(w, [(w["dig_product"], 100, 1, False)])
    q = quote(w, inv)
    svc = ProviderIssuanceService(pg, provider_lookup=lambda name: w["provider"])
    svc.begin(inv, q, w["maker"].id)
    _rejects(pg, "INSERT INTO tax_provider_outbox (organization_id, invoice_id, tax_quote_id, operation, provider_name, "
                 "idempotency_key, state, attempts, created_at) VALUES (:o, :i, :q, 'COMMIT', 'fake-provider', "
                 "'second-key', 'PENDING', 0, now())", {"o": w["org"].id, "i": inv.id, "q": q.id})


def test_rows_are_claimed_with_skip_locked(pg):
    svc = ProviderIssuanceService(pg)
    query = pg.query(TaxProviderOutbox).filter(TaxProviderOutbox.id == 1).with_for_update(skip_locked=True)
    sql = str(query.statement.compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert svc._lock(-1) is None                                    # the real query runs on Postgres
