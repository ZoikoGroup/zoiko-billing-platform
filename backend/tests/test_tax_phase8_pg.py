"""tests/test_tax_phase8_pg.py
---------------------------
ZB-TAX-ARCH-001 Phase 8 guarantees only PostgreSQL provides. PR 1: a
submitted rule-pack version's code hash is frozen by the version guard, and a
quote's rule-pack provenance (version id and code hash) is frozen by the
tenant guard, after migration d2a6c8e4f1b7 recreated both. PR 2 (migration
e3b7d9f1a2c4): an ACTIVE pack's valid_to is set once, ACTIVE date ranges of
one pack never overlap, and a decided activation cancellation is final.

Same contract as the earlier PG modules: runs only with TAX_PG_TEST_URL (a
migrated PostgreSQL database), skipped with a reason when unset, an error when
TAX_PG_TESTS_REQUIRED is set, never SQLite. Each test runs in one outer
transaction that is rolled back.
"""
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 8 tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.tax import rule_pack_integrity as rpi  # noqa: E402
from app.modules.tax.enums import TaxQuoteStatus  # noqa: E402
from app.modules.tax.policy_service import RulePackService  # noqa: E402
from app.modules.tax.rule_packs import AuGstDomesticServices, UkVatDomesticServices  # noqa: E402
from tests.test_tax_phase3b_packs import build_world, draft, govern, issue, publish_pack, quote  # noqa: E402


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(PG_URL)
    assert eng.dialect.name == "postgresql"
    yield eng
    eng.dispose()


@pytest.fixture()
def pg(engine):
    rpi.clear_cache()
    connection = engine.connect()
    outer = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        outer.rollback()
        connection.close()
        rpi.clear_cache()


def _rejects(session, sql, params=None):
    with pytest.raises(IntegrityError):
        with session.begin_nested():
            session.execute(text(sql), params or {})


def _accepts(session, sql, params=None):
    with session.begin_nested():
        session.execute(text(sql), params or {})


@pytest.fixture()
def uk(pg):
    w = build_world(pg, org_code=f"P8PG{id(pg) % 100000}")
    w["pack"] = publish_pack(w, UkVatDomesticServices.code)
    govern(w, w["uk"])
    return w


def test_code_hash_is_frozen_once_submitted_but_not_on_a_draft(uk):
    pg = uk["db"]
    _rejects(pg, "UPDATE tax_rule_pack_versions SET code_hash = :h WHERE id = :i", {"h": "0" * 64, "i": uk["pack"].id})
    draft_row = RulePackService(pg).register(actor_id=uk["reviewer"].id, code=AuGstDomesticServices.code)
    pg.flush()
    _accepts(pg, "UPDATE tax_rule_pack_versions SET code_hash = NULL WHERE id = :i", {"i": draft_row.id})


def test_quote_provenance_is_recorded_and_frozen(uk):
    pg = uk["db"]
    inv = draft(uk, [(uk["svc"], 100, 1)])
    q = quote(uk, inv)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    assert (q.rule_pack_version_id, q.rule_pack_code_hash) == (uk["pack"].id, uk["pack"].code_hash)
    issue(uk, inv)
    _rejects(pg, "UPDATE tax_quotes SET rule_pack_code_hash = :h WHERE id = :i", {"h": "1" * 64, "i": q.id})
    _rejects(pg, "UPDATE tax_quotes SET rule_pack_version_id = NULL WHERE id = :i", {"i": q.id})


def test_changed_pack_code_fails_closed_on_postgres(uk, monkeypatch):
    real = rpi._read_module
    monkeypatch.setattr(rpi, "_read_module",
                        lambda name: real(name) + ("\n# drift\n" if name == UkVatDomesticServices.__module__ else ""))
    rpi.clear_cache()
    q = quote(uk, draft(uk, [(uk["svc"], 100, 1)]))
    assert q.status == TaxQuoteStatus.UNSUPPORTED and q.refusal_code == rpi.INTEGRITY_FAILED and not q.lines


# ── PR 2: effective-dated packs and scheduled activation ────────────────

def _rejects_now(session, sql, params=None):
    """Like _rejects, with deferred constraints checked immediately."""
    with pytest.raises(IntegrityError):
        with session.begin_nested():
            session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
            session.execute(text(sql), params or {})


COPY = ("INSERT INTO tax_rule_pack_versions (code, version, markets, rounding_rule, rounding_mode, status, "
        "created_at, valid_from) SELECT code, :v, markets, rounding_rule, rounding_mode, 'ACTIVE', created_at, "
        "CAST(:f AS date) FROM tax_rule_pack_versions WHERE id = :i")


def test_valid_to_is_set_once_and_active_ranges_never_overlap(uk):
    pg, pack = uk["db"], uk["pack"]
    _accepts(pg, "UPDATE tax_rule_pack_versions SET valid_to = DATE '2031-01-01' WHERE id = :i", {"i": pack.id})
    _rejects(pg, "UPDATE tax_rule_pack_versions SET valid_to = DATE '2032-01-01' WHERE id = :i", {"i": pack.id})
    _rejects_now(pg, COPY, {"v": "8", "f": "2030-06-01", "i": pack.id})          # overlaps [start, 2031-01-01)
    with pg.begin_nested():
        pg.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        pg.execute(text(COPY), {"v": "9", "f": "2031-01-01", "i": pack.id})     # follows it: no overlap


def test_a_decided_cancellation_is_final(uk):
    pg = uk["db"]
    pg.execute(text("INSERT INTO tax_activation_cancellations (version_kind, version_id, reason, status, created_at) "
                    "VALUES ('rule_pack', :i, 'fixture', 'REJECTED', now())"), {"i": uk["pack"].id})
    cid = pg.execute(text("SELECT max(id) FROM tax_activation_cancellations")).scalar()
    _rejects(pg, "UPDATE tax_activation_cancellations SET reason = 'edited' WHERE id = :i", {"i": cid})
    _rejects(pg, "DELETE FROM tax_activation_cancellations WHERE id = :i", {"i": cid})
