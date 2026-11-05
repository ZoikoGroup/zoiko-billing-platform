"""tests/test_tax_phase3b_pg.py
----------------------------
ZB-TAX-ARCH-001 Phase 3b guarantees only PostgreSQL provides: the declared
rounding mode is frozen on a quote, a submitted rule-pack version's new
declarations (rounding mode, required facts, coverage, source dependencies)
are frozen, and the UK pack runs quote -> issue against every trigger.

Same contract as the earlier PG modules: runs only with TAX_PG_TEST_URL (a
migrated PostgreSQL database), skipped with a reason when unset, an error when
TAX_PG_TESTS_REQUIRED is set, never SQLite. Each test runs in one outer
transaction that is rolled back.
"""
import os
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 3b tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from decimal import Decimal  # noqa: E402

from app.modules.billing.models import InvoiceStatus  # noqa: E402
from app.modules.tax.enums import RoundingMode, TaxQuoteStatus  # noqa: E402
from app.modules.tax.rule_packs import UkVatDomesticServices  # noqa: E402
from tests.test_tax_phase3b_packs import build_world, draft, govern, issue, publish_pack, quote  # noqa: E402


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
def uk_issued(pg):
    w = build_world(pg, org_code=f"P3BPG{id(pg) % 100000}")
    publish_pack(w, UkVatDomesticServices.code)
    govern(w, w["uk"])
    inv = draft(w, [(w["svc"], 100, 1)])
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    issue(w, inv)
    pg.flush()
    return {"w": w, "invoice": inv, "quote": q}


def test_phase3b_columns_exist(pg):
    cols = set(pg.execute(text(
        "SELECT table_name || '.' || column_name FROM information_schema.columns "
        "WHERE table_name IN ('tax_quotes', 'tax_rule_pack_versions')")).scalars())
    assert {"tax_quotes.rounding_mode", "tax_rule_pack_versions.rounding_mode",
            "tax_rule_pack_versions.required_facts", "tax_rule_pack_versions.coverage",
            "tax_rule_pack_versions.source_dependencies"} <= cols


def test_uk_pack_end_to_end_on_postgres(pg, uk_issued):
    inv, q = uk_issued["invoice"], uk_issued["quote"]
    pg.refresh(inv)
    pg.refresh(q)
    assert inv.status == InvoiceStatus.SENT and inv.tax_quote_id == q.id
    assert (inv.tax_amount, inv.total_amount) == (Decimal("20.00"), Decimal("120.00"))
    assert q.status == TaxQuoteStatus.COMMITTED and q.rounding_mode == RoundingMode.HALF_UP


def test_quote_rounding_mode_is_frozen(pg, uk_issued):
    _rejects(pg, "UPDATE tax_quotes SET rounding_mode = 'HALF_EVEN' WHERE id = :id", {"id": uk_issued["quote"].id})


def test_submitted_rule_pack_declarations_are_frozen(pg):
    now = datetime.now(timezone.utc)
    rid = pg.execute(text(
        "INSERT INTO tax_rule_pack_versions (code, version, markets, rounding_rule, rounding_mode, required_facts, "
        "coverage, source_dependencies, status, created_at) VALUES ('PG-3B', '1', '[]', 'PER_LINE', 'HALF_UP', "
        "'[]', '{}', '[]', 'PENDING_REVIEW', :now) RETURNING id"), {"now": now}).scalar()
    _accepts(pg, "UPDATE tax_rule_pack_versions SET coverage = '{\"draft\": true}' WHERE id = :id", {"id": rid})
    _accepts(pg, "UPDATE tax_rule_pack_versions SET status = 'IN_APPROVAL' WHERE id = :id", {"id": rid})
    for column, value in (("rounding_mode", "'HALF_EVEN'"), ("required_facts", "'[\"X\"]'"),
                          ("coverage", "'{}'"), ("source_dependencies", "'[{}]'")):
        _rejects(pg, f"UPDATE tax_rule_pack_versions SET {column} = {value} WHERE id = :id", {"id": rid})
