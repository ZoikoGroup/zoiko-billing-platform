"""tests/test_tax_phase3a_pg.py
----------------------------
ZB-TAX-ARCH-001 Phase 3a guarantees only PostgreSQL provides: quote / snapshot
/ credit-line content frozen from insert, COMMITTED -> VOIDED only, VOIDED
final, deletes only under the erasure flag, invoices.tax_quote_id RESTRICT,
the rule-pack registry guard — and an end-to-end quote -> issue -> credit run
proving the gate's write pattern is compatible with every trigger.

Same contract as the earlier PG modules: runs only with TAX_PG_TEST_URL (a
migrated PostgreSQL database), skipped with a reason when unset, an error when
TAX_PG_TESTS_REQUIRED is set, never SQLite. Each test runs in one outer
transaction that is rolled back.
"""
import os
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 3a tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.billing.models import InvoiceStatus  # noqa: E402
from app.modules.tax.enums import TaxQuoteStatus  # noqa: E402
from app.modules.tax.governed_credit_service import GovernedCreditService  # noqa: E402
from tests.test_tax_phase3a_governed import build_world, buyer, draft, finalize, quote  # noqa: E402


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
    """A governed invoice issued through the gate, plus a governed credit note —
    the full Phase 3a write pattern running against the Postgres triggers."""
    w = build_world(pg, org_code=f"P3APG{id(pg) % 100000}")
    customer = buyer(w, verified=False, code="PG")
    inv = draft(w, [(w["svc_product"], 100, 1, False), (w["svc_product"], "33.33", 1, False)],
                customer=customer, discount_pct="10")
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED
    finalize(w, inv)
    note = GovernedCreditService(pg).create(w["org"].id, w["maker"].id, inv.id,
                                            lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.5"}])
    pg.flush()
    return {"w": w, "invoice": inv, "quote": q, "credit_note": note}


def test_phase3a_triggers_are_installed(pg):
    names = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    assert {"trg_tax_quotes_guard", "trg_tax_quote_lines_guard", "trg_tax_quote_components_guard",
            "trg_credit_note_tax_lines_guard", "trg_tax_quotes_status_guard",
            "trg_tax_rule_pack_versions_guard"} <= names


def test_end_to_end_governed_issue_and_credit_on_postgres(pg, issued):
    inv, q = issued["invoice"], issued["quote"]
    pg.refresh(inv)
    pg.refresh(q)
    assert inv.status == InvoiceStatus.SENT and inv.tax_quote_id == q.id
    assert q.status == TaxQuoteStatus.COMMITTED
    assert inv.subtotal - inv.discount_amount + inv.tax_amount == inv.total_amount
    rows = pg.execute(text("SELECT count(*) FROM credit_note_tax_lines WHERE credit_note_id = :c"),
                      {"c": issued["credit_note"].id}).scalar()
    assert rows == 1


def test_committed_snapshot_content_is_frozen(pg, issued):
    qid = issued["quote"].id
    _rejects(pg, "UPDATE tax_quotes SET tax_amount = 1 WHERE id = :id", {"id": qid})
    _rejects(pg, "UPDATE tax_quotes SET context_fingerprint = 'x' WHERE id = :id", {"id": qid})
    _rejects(pg, "UPDATE tax_quote_lines SET tax_amount = 1 WHERE tax_quote_id = :id", {"id": qid})
    _rejects(pg, "UPDATE tax_quote_components SET rate_percent = 1 WHERE tax_quote_id = :id", {"id": qid})
    _rejects(pg, "UPDATE credit_note_tax_lines SET credited_tax = 0 WHERE tax_quote_id = :id", {"id": qid})


def test_committed_quote_can_only_be_voided_and_voided_is_final(pg, issued):
    qid = issued["quote"].id
    _rejects(pg, "UPDATE tax_quotes SET status = 'QUOTED' WHERE id = :id", {"id": qid})
    _rejects(pg, "UPDATE tax_quotes SET status = 'STALE' WHERE id = :id", {"id": qid})
    _accepts(pg, "UPDATE tax_quotes SET status = 'VOIDED', voided_at = now(), void_reason = 'test' WHERE id = :id",
             {"id": qid})
    _rejects(pg, "UPDATE tax_quotes SET void_reason = 'changed' WHERE id = :id", {"id": qid})
    _rejects(pg, "UPDATE tax_quotes SET status = 'COMMITTED' WHERE id = :id", {"id": qid})


def test_snapshot_rows_are_deleted_only_under_the_erasure_flag(pg, issued):
    qid = issued["quote"].id
    _rejects(pg, "DELETE FROM credit_note_tax_lines WHERE tax_quote_id = :id", {"id": qid})
    _rejects(pg, "DELETE FROM tax_quote_components WHERE tax_quote_id = :id", {"id": qid})
    with pg.begin_nested():
        pg.execute(text("SET LOCAL zoiko.tax_erasure = 'on'"))
        pg.execute(text("DELETE FROM credit_note_tax_lines WHERE tax_quote_id = :id"), {"id": qid})
        pg.execute(text("DELETE FROM tax_quote_components WHERE tax_quote_id = :id"), {"id": qid})
        pg.execute(text("DELETE FROM tax_quote_lines WHERE tax_quote_id = :id"), {"id": qid})
        # The invoice still references the committed quote: RESTRICT holds even under erasure.
        with pytest.raises(IntegrityError):
            with pg.begin_nested():
                pg.execute(text("DELETE FROM tax_quotes WHERE id = :id"), {"id": qid})


def test_rule_pack_registry_versions_are_frozen_once_submitted(pg):
    now = datetime.now(timezone.utc)
    rid = pg.execute(text(
        "INSERT INTO tax_rule_pack_versions (code, version, markets, rounding_rule, rounding_mode, status, created_at) "
        "VALUES ('PG-PACK', '1', '[]', 'PER_LINE', 'HALF_UP', 'PENDING_REVIEW', :now) RETURNING id"), {"now": now}).scalar()
    _accepts(pg, "UPDATE tax_rule_pack_versions SET notes = 'draft edit' WHERE id = :id", {"id": rid})
    _accepts(pg, "UPDATE tax_rule_pack_versions SET status = 'IN_APPROVAL' WHERE id = :id", {"id": rid})
    _rejects(pg, "UPDATE tax_rule_pack_versions SET markets = '[{\"jurisdiction_code\": \"GB\"}]' WHERE id = :id",
             {"id": rid})
    _rejects(pg, "DELETE FROM tax_rule_pack_versions WHERE id = :id", {"id": rid})
