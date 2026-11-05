"""tests/test_tax_phase4c_pg.py
----------------------------
ZB-TAX-ARCH-001 Phase 4c guarantees only PostgreSQL provides: address
resolutions are write-once evidence (dataset version included), pseudonym key
records are frozen, a quote's exemption claims are frozen,
and a US quote through resolved districts and a certificate claim runs
against every trigger.

Same contract as the earlier PG modules: runs only with TAX_PG_TEST_URL,
skipped with a reason when unset, an error when TAX_PG_TESTS_REQUIRED is set,
never SQLite. Each test runs in one outer transaction that is rolled back.
"""
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

PG_URL = os.environ.get("TAX_PG_TEST_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 4c tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from app.modules.tax.address_resolver import ADDRESS_RESOLVERS  # noqa: E402
from app.modules.tax.enums import TaxQuoteStatus  # noqa: E402
from app.modules.tax.models import TaxAddressResolution  # noqa: E402
from tests.test_tax_phase4c_us import build_us, buyer, certificate, exempt, quote_for  # noqa: E402


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
def world(pg):
    w = build_us(pg, code=f"P4CPG{id(pg) % 100000}")
    yield w
    ADDRESS_RESOLVERS.clear()


def test_phase4c_table_column_and_triggers_exist(pg):
    tables = set(pg.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")).scalars())
    assert "tax_address_resolutions" in tables
    columns = set(pg.execute(text("SELECT column_name FROM information_schema.columns "
                                  "WHERE table_name = 'tax_quotes'")).scalars())
    assert "exemption_claims" in columns
    triggers = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    assert {"trg_tax_address_resolutions_guard", "trg_tax_pseudonym_key_records_guard"} <= triggers
    assert "tax_pseudonym_key_records" in tables


def test_address_resolution_is_write_once(pg, world):
    _, a = buyer(world, "100 First St")
    r = pg.query(TaxAddressResolution).filter(TaxAddressResolution.address_id == a.id).one()
    _rejects(pg, "UPDATE tax_address_resolutions SET jurisdiction_codes = '[]' WHERE id = :id", {"id": r.id})
    _rejects(pg, "UPDATE tax_address_resolutions SET status = 'AMBIGUOUS' WHERE id = :id", {"id": r.id})
    _rejects(pg, "UPDATE tax_address_resolutions SET dataset_version = 'other' WHERE id = :id", {"id": r.id})
    _rejects(pg, "DELETE FROM tax_address_resolutions WHERE id = :id", {"id": r.id})


def test_us_quote_with_districts_and_a_claim_on_postgres(pg, world):
    c, _ = buyer(world, "900 Ninth St")
    _, q = quote_for(world, c)
    assert q.status == TaxQuoteStatus.QUOTED and str(q.tax_amount) == "8.25"
    certificate(world, c)
    world["after"] = exempt
    _, q2 = quote_for(world, c)
    assert q2.status == TaxQuoteStatus.QUOTED and q2.exemption_claims
    pg.flush()
    _rejects(pg, "UPDATE tax_quotes SET exemption_claims = NULL WHERE id = :id", {"id": q2.id})


def test_pseudonym_key_record_is_frozen(pg, world):
    from app.modules.tax.models import TaxPseudonymKeyRecord

    record = pg.query(TaxPseudonymKeyRecord).filter(TaxPseudonymKeyRecord.organization_id == world["org"].id).one()
    _rejects(pg, "UPDATE tax_pseudonym_key_records SET fingerprint = 'x' WHERE id = :id", {"id": record.id})
    _rejects(pg, "DELETE FROM tax_pseudonym_key_records WHERE id = :id", {"id": record.id})


def test_manual_resolution_is_frozen_and_its_evidence_write_once(pg, world):
    from app.modules.tax.address_resolver import ManualResolutionService

    c, a = buyer(world, "5 Split Rd")                                  # AMBIGUOUS
    svc = ManualResolutionService(pg)
    row = svc.propose(world["org"].id, world["maker"].id, c.id, a.id,
                      jurisdiction_codes=["US", "US-CA", "US-CA-LA", "US-CA-LA-D2"], reason="county lookup")
    svc.attach_evidence(world["org"].id, world["maker"].id, row.id,
                        content=b"%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", media_type="application/pdf")
    svc.decide(world["org"].id, world["checker"].id, row.id, approve=True)
    pg.flush()
    triggers = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    assert {"trg_tax_manual_resolution_requests_guard",
            "trg_tax_manual_resolution_requests_evidence_write_once"} <= triggers
    _rejects(pg, "UPDATE tax_manual_resolution_requests SET jurisdiction_codes = '[]' WHERE id = :id", {"id": row.id})
    _rejects(pg, "UPDATE tax_manual_resolution_requests SET evidence_file_id = NULL WHERE id = :id", {"id": row.id})
    _rejects(pg, "DELETE FROM tax_manual_resolution_requests WHERE id = :id", {"id": row.id})
    _rejects(pg, "UPDATE tax_address_resolutions SET precision = 'ROOFTOP' WHERE id = :id", {"id": row.resolution_id})
