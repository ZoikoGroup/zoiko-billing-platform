"""Item-1 tests: FX-staleness disclosure in chatbot dashboard/currency answers.

A chatbot must never label converted figures as "current" while the org's
exchange rates are past the system staleness threshold (24h). These tests
prove:
  * fresh rates  -> NO stale disclosure line, and the qualification never
                    falsely asserts "current" while stale
  * stale rates  -> a "last updated ... hour(s) ago" disclosure appears, and
                    the qualification no longer claims the figures are current
  * single-currency org with no cross-currency conversion -> no disclosure
    even when the config timestamp is old (because no conversion occurs)
"""
from datetime import datetime, timezone, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingConfiguration,
    BillingCustomer,
    Invoice, InvoiceStatus,
)
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _conv(db, org):
    conv = AIConversation(
        conversation_uid=f"fx-conv-{org.id}", tenant_context_id=1,
        organization_id=org.id, user_id=1, title="fx",
        conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv


def _ask(ce, conv, ctx, phrase):
    intent = ce._classify_intent(conv, phrase, ctx)
    handler = ce._get_handler(intent["domain"])
    result = handler(conv, phrase, intent, ctx)
    return intent, result


def _seed_org(db, base_ccy="USD", exchange_rates=None, last_refreshed=None):
    """Seed an org with a billing config (base cc + exchange_rates JSON) and
    one PAID USD invoice plus one SENT non-base invoice so conversion occurs."""
    org = Organization(organization_name="FX Test Org", organization_code="FX1")
    db.add(org)
    db.flush()

    cfg = BillingConfiguration(
        organization_id=org.id,
        default_currency=base_ccy,
        base_currency=base_ccy,
        exchange_rates=exchange_rates or {},
        exchange_rate_last_refreshed=last_refreshed,
    )
    db.add(cfg)
    db.flush()

    c = BillingCustomer(
        organization_id=org.id, customer_code="CUST-A",
        company_name="Alpha", display_name="Alpha",
        email="a@x.com", currency=base_ccy,
    )
    db.add(c)
    db.flush()

    inv_paid = Invoice(
        organization_id=org.id, customer_id=c.id,
        invoice_number="INV-1", status=InvoiceStatus.PAID,
        issue_date=datetime.now(timezone.utc).date(),
        due_date=datetime.now(timezone.utc).date(),
        total_amount="500.00", paid_amount="500.00",
        balance_due="0.00", currency="USD",
    )
    db.add(inv_paid)
    db.flush()
    inv_paid.is_active = True

    if base_ccy != "USD":
        inv_fx = Invoice(
            organization_id=org.id, customer_id=c.id,
            invoice_number="INV-2", status=InvoiceStatus.SENT,
            issue_date=datetime.now(timezone.utc).date(),
            due_date=datetime.now(timezone.utc).date() + timedelta(days=30),
            total_amount="1000.00", paid_amount="0.00",
            balance_due="1000.00", currency=base_ccy,
        )
        db.add(inv_fx)
        db.flush()
        inv_fx.is_active = True

    db.flush()
    return org


def _make_ctx(db, org):
    return AIContext(
        organization_id=org.id, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="fx-test",
        tenant_name="FX Test Org",
    )


# ── Single-currency org (base USD, only USD invoices) ────────────────────────
def test_single_currency_no_disclosure(db):
    """A single-currency org (all USD, no INR/other) performs no conversion,
    so even an old timestamp must NOT trigger a stale disclosure."""
    org = _seed_org(
        db, base_ccy="USD",
        exchange_rates={"USD": 1.0},
        last_refreshed=datetime.now(timezone.utc) - timedelta(hours=99),
    )
    ctx = _make_ctx(db, org)
    ce = ConversationEngine(db, model_gateway=None)
    conv = _conv(db, org)
    intent, result = _ask(ce, conv, ctx, "Show financial summary")

    assert intent["intent"] == "dashboard_summary"
    answer = result["answer"]
    assert "exchange rates last updated" not in answer.lower(), (
        f"single-currency org must not disclose stale FX: {answer}"
    )
    assert "outdated rates" not in answer.lower()


# ── Multi-currency org: fresh rates -> no disclosure ─────────────────────────
def test_fresh_rates_no_disclosure(db):
    """Base USD with an INR invoice, rates refreshed just now (fresh) -> the
    answer must NOT carry a stale-rate disclosure."""
    org = _seed_org(
        db, base_ccy="INR",
        exchange_rates={"USD": 1.0, "INR": 85.0},
        last_refreshed=datetime.now(timezone.utc),
    )
    ctx = _make_ctx(db, org)
    ce = ConversationEngine(db, model_gateway=None)
    conv = _conv(db, org)
    intent, result = _ask(ce, conv, ctx, "Show financial summary")

    assert intent["intent"] == "dashboard_summary"
    answer = result["answer"]
    assert "exchange rates last updated" not in answer.lower(), (
        f"fresh rates must NOT disclose staleness: {answer}"
    )
    # qualification must not falsely claim "current" that is unverifiable
    assert "current aggregates" not in result.get("qualification", "").lower()


# ── Multi-currency org: stale rates -> disclosure present ────────────────────
def test_stale_rates_show_disclosure(db):
    """Base INR with a USD invoice, rates refreshed 48h ago (past the 24h
    threshold) -> the answer MUST carry a 'last updated ... hour(s) ago'
    disclosure and NOT label the figures current."""
    org = _seed_org(
        db, base_ccy="INR",
        exchange_rates={"USD": 1.0, "INR": 85.0},
        last_refreshed=datetime.now(timezone.utc) - timedelta(hours=48),
    )
    ctx = _make_ctx(db, org)
    ce = ConversationEngine(db, model_gateway=None)
    conv = _conv(db, org)
    intent, result = _ask(ce, conv, ctx, "Show financial summary")

    assert intent["intent"] == "dashboard_summary"
    answer = result["answer"]
    assert "exchange rates last updated" in answer.lower(), (
        f"stale rates MUST disclose staleness: {answer}"
    )
    assert "hour(s) ago" in answer.lower(), f"disclosure missing age: {answer}"
    # Never falsely labeled current
    assert "current aggregates" not in result.get("qualification", "").lower()
    # And the static 'current' claim is gone from the code path answer text too
    assert "Figures are current aggregates" not in answer


# ── Stale but no refresh timestamp at all -> disclose "no refresh time" ──────
def test_stale_no_timestamp_discloses(db):
    """Base INR with a USD invoice and NO recorded refresh time -> treated as
    stale; the answer must disclose that no refresh time is recorded."""
    org = _seed_org(
        db, base_ccy="INR",
        exchange_rates={"USD": 1.0, "INR": 85.0},
        last_refreshed=None,
    )
    ctx = _make_ctx(db, org)
    ce = ConversationEngine(db, model_gateway=None)
    conv = _conv(db, org)
    intent, result = _ask(ce, conv, ctx, "Show financial summary")

    assert intent["intent"] == "dashboard_summary"
    answer = result["answer"]
    assert "no exchange-rate refresh time is recorded" in answer.lower() or \
           "outdated rates" in answer.lower(), (
        f"missing refresh timestamp MUST disclose: {answer}"
    )
