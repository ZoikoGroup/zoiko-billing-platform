"""tests/test_tax_phase4a2_pg.py
------------------------------
ZB-TAX-ARCH-001 Phase 4a-2 guarantees only PostgreSQL provides: connection
keys frozen, evidence files write-once and deletable only by the erasure
purge, certificate evidence attached once, the provider connection frozen on
approved activations and on quotes, and an issue + credit through a
connection end to end against every trigger.

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
    not PG_URL, reason="TAX_PG_TEST_URL is not set: PostgreSQL-only Phase 4a-2 tax guarantees not exercised",
)

if os.environ.get("TAX_PG_TESTS_REQUIRED") and not PG_URL:
    raise RuntimeError("TAX_PG_TESTS_REQUIRED is set but TAX_PG_TEST_URL is empty")
if PG_URL and not PG_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError(f"TAX_PG_TEST_URL must be a PostgreSQL URL, got {PG_URL.split(':', 1)[0]!r}")

from datetime import date  # noqa: E402

from app.modules.billing.models import InvoiceStatus  # noqa: E402
from app.modules.billing.services.invoice_service import InvoiceService  # noqa: E402
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService  # noqa: E402
from app.modules.tax.determination_service import TaxDeterminationService  # noqa: E402
from app.modules.tax.enums import OutboxOperation, OutboxState  # noqa: E402
from app.modules.tax.governed_credit_service import GovernedCreditService  # noqa: E402
from app.modules.tax.issuance_gate import GovernedIssuanceGate  # noqa: E402
from app.modules.tax.provider_issuance import ProviderIssuanceService  # noqa: E402
from app.modules.tax.provider_models import TaxProviderOutbox  # noqa: E402
from tests.test_tax_phase3a_governed import build_world, draft  # noqa: E402

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


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
    return build_world(pg, org_code=f"P4A2PG{id(pg) % 100000}")


def test_phase4a2_tables_and_triggers_exist(pg):
    tables = set(pg.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")).scalars())
    assert {"tax_provider_connections", "tax_provider_secrets", "tax_evidence_files", "tax_regime_changes"} <= tables
    triggers = set(pg.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
    assert {"trg_tax_provider_connections_guard", "trg_tax_evidence_files_guard", "trg_tax_regime_changes_guard",
            "trg_customer_certificate_evidence_write_once"} <= triggers


def test_connection_keys_are_frozen(pg, world):
    cid = world["connection"].id
    _rejects(pg, "UPDATE tax_provider_connections SET provider_name = 'other' WHERE id = :id", {"id": cid})
    _rejects(pg, "UPDATE tax_provider_connections SET environment = 'PRODUCTION' WHERE id = :id", {"id": cid})
    _accepts(pg, "UPDATE tax_provider_connections SET health_ok = true WHERE id = :id", {"id": cid})
    _rejects(pg, "DELETE FROM tax_provider_connections WHERE id = :id", {"id": cid})


def test_activation_and_quote_keep_their_connection(pg, world):
    _rejects(pg, "UPDATE entity_tax_activations SET provider_connection_id = NULL "
                 "WHERE provider_connection_id = :c AND status = 'APPROVED'", {"c": world["connection"].id})
    inv = draft(world, [(world["dig_product"], 100, 1, False)])
    q = TaxDeterminationService(pg).create_quote(world["org"].id, world["maker"].id, "invoice", inv.id)
    pg.flush()
    _rejects(pg, "UPDATE tax_quotes SET provider_connection_id = NULL WHERE id = :id", {"id": q.id})


def test_certificate_evidence_is_write_once_and_retained(pg, world):
    svc = BuyerEvidenceService(pg)
    cert = svc.add_certificate(world["org"].id, world["maker"].id, world["customer"].id, certificate_number="PG-1",
                               jurisdiction_id=world["gb"].id, scope_description="x", valid_from=date(2026, 1, 1),
                               evidence_ref="file")
    svc.attach_certificate_evidence(world["org"].id, world["maker"].id, cert.id, content=PDF,
                                    media_type="application/pdf")
    pg.flush()
    _rejects(pg, "UPDATE customer_exemption_certificates SET evidence_file_id = NULL WHERE id = :id", {"id": cert.id})
    _rejects(pg, "UPDATE tax_evidence_files SET content = 'x' WHERE id = :id", {"id": cert.evidence_file_id})
    _rejects(pg, "DELETE FROM tax_evidence_files WHERE id = :id", {"id": cert.evidence_file_id})


def test_issue_and_credit_through_a_connection_on_postgres(pg, world):
    inv = draft(world, [(world["dig_product"], 100, 1, False)])
    TaxDeterminationService(pg).create_quote(world["org"].id, world["maker"].id, "invoice", inv.id)
    svc = InvoiceService(pg)
    svc.governed_gate = GovernedIssuanceGate(pg)
    assert svc.finalize_invoice(inv.id, world["org"].id, world["maker"].id).status == InvoiceStatus.SENT
    GovernedCreditService(pg).create(world["org"].id, world["maker"].id, inv.id,
                                     lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.5"}])
    ProviderIssuanceService(pg).reconcile()
    adjust = pg.query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.ADJUST).one()
    assert adjust.state == OutboxState.DONE and len(world["provider"].adjustments) == 1
