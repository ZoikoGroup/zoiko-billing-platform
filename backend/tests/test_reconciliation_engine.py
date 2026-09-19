"""
tests/test_reconciliation_engine.py
-----------------------------------
REC-01 ??? ledger reconciliation engine: run lifecycle, both internal checks,
exception ownership workflow, and the production-acceptance gate wiring.

ISS-017 (Phase 11): true ledger-vs-Stripe processor comparison. All Stripe
network access is replaced with `_FakeStripeModule` below — these tests
never touch live or even real test-mode Stripe; they prove the comparison
logic (matching, classification, pagination, error handling, tenant
isolation) in isolation, per Phase 11's explicit test-strategy requirement.
"""

from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest
import stripe as real_stripe

from app.core.capabilities import require_capability
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import (
    IntegrationConnectionStatus,
    IntegrationEnvironment,
    InvoiceStatus,
    PaymentAllocation,
    PaymentStatus,
    StripeConnectedAccount,
)
from app.modules.super_admin.models import (
    ReconciliationExceptionStatus,
    ReconciliationRunState,
)
from app.modules.super_admin.reconciliation_service import ReconciliationService
from tests.conftest import (
    make_customer,
    make_invoice,
    make_organization,
    make_payment,
)


def _run(db):
    svc = ReconciliationService(db)
    run = svc.run_reconciliation(trigger="manual")
    svc.report_to_attention_engine(run)
    return run


def test_clean_ledger_run_is_partial_with_no_exceptions(db_session):
    # This test asserts the "no processor/bank feed connected" scenario
    # (ISS-017) specifically, so pin STRIPE_SECRET_KEY blank here rather
    # than relying on the ambient .env — other suites (test_stripe_plane2*)
    # legitimately populate it for unrelated Stripe integration coverage,
    # and this test must not become environment-dependent.
    with patch("app.modules.super_admin.reconciliation_service.settings") as mock_settings:
        mock_settings.STRIPE_SECRET_KEY = ""
        run = _run(db_session)
    assert run.state == ReconciliationRunState.PARTIAL  # capped: no processor source
    assert run.exceptions_found == 0
    assert run.checks_total == 2
    assert run.processor_source == "none"
    assert run.finished_at is not None


def test_imbalanced_invoice_raises_exception_and_fails_run(db_session):
    org = make_organization(db_session)
    inv = make_invoice(db_session, org.id, make_customer(db_session, org.id).id)
    inv.balance_due = "999.00"  # corrupt the arithmetic invariant
    db_session.flush()

    run = _run(db_session)
    assert run.state == ReconciliationRunState.FAILED
    assert run.exceptions_found == 1
    exc = run.exceptions[0]
    assert exc.kind == "invoice_balance_mismatch"
    assert exc.entity_id == inv.id
    assert exc.status == ReconciliationExceptionStatus.OPEN
    assert exc.detail["expected_balance_due"] == 100.0


def test_exception_is_scoped_to_owning_organization(db_session):
    """Tenant isolation (Phase 9 Step 16): a discrepancy in org A's ledger
    must raise an exception tagged with org A's id only — org B, whose
    ledger is clean, must have no exception attributed to it."""
    org_a = make_organization(db_session, code="ORG-A")
    org_b = make_organization(db_session, code="ORG-B")
    make_invoice(db_session, org_b.id, make_customer(db_session, org_b.id, code="CUST-B").id)
    bad_inv = make_invoice(db_session, org_a.id, make_customer(db_session, org_a.id, code="CUST-A").id)
    bad_inv.balance_due = "999.00"
    db_session.flush()

    run = _run(db_session)
    assert run.exceptions_found == 1
    exc = run.exceptions[0]
    assert exc.organization_id == org_a.id
    assert exc.organization_id != org_b.id
    assert exc.entity_id == bad_inv.id


def test_over_allocated_payment_raises_exception(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(
        db_session, org.id, cust.id,
        total_amount="100.00", paid_amount="150.00",
        status=InvoiceStatus.PAID,
    )
    pay = make_payment(db_session, org.id, cust.id, amount="50.00")
    db_session.add(PaymentAllocation(
        organization_id=org.id, payment_id=pay.id, invoice_id=inv.id, amount="75.00"
    ))
    db_session.flush()

    run = _run(db_session)
    kinds = {e.kind for e in run.exceptions}
    assert run.state == ReconciliationRunState.FAILED
    assert "payment_over_allocation" in kinds


def test_repeated_runs_never_mutate_ledger_data(db_session):
    """Idempotency (Phase 9 Step 17): the engine is read-only detection —
    it must never write to Invoice/Payment/PaymentAllocation. Running it
    twice against an unresolved discrepancy must not change the underlying
    financial data. The latest run supersedes the active exception row rather
    than creating an unbounded duplicate ownership item."""
    org = make_organization(db_session)
    inv = make_invoice(db_session, org.id, make_customer(db_session, org.id).id)
    inv.balance_due = "999.00"
    db_session.flush()

    before = (str(inv.total_amount), str(inv.paid_amount), str(inv.balance_due), inv.status)

    run1 = _run(db_session)
    run2 = _run(db_session)

    after = (str(inv.total_amount), str(inv.paid_amount), str(inv.balance_due), inv.status)
    assert before == after  # no financial data mutated by either run

    # Each run is its own audit record, while the unresolved discrepancy has
    # one active exception row that is moved to the latest run.
    assert run1.id != run2.id
    assert run1.exceptions_found == 1
    assert run2.exceptions_found == 1
    assert run1.exceptions[0].id == run2.exceptions[0].id


def test_repeated_discrepancy_updates_one_attention_item(db_session):
    org = make_organization(db_session)
    inv = make_invoice(db_session, org.id, make_customer(db_session, org.id).id)
    inv.balance_due = "999.00"
    db_session.flush()

    run1 = _run(db_session)
    run2 = _run(db_session)

    from app.modules.super_admin.models import AttentionItem

    items = (
        db_session.query(AttentionItem)
        .filter(
            AttentionItem.source == ReconciliationService.ATTENTION_SOURCE,
            AttentionItem.source_key.like("ledger_reconciliation:exception:%"),
        )
        .all()
    )
    assert len(items) == 1
    assert items[0].occurrence_count == 2
    assert str(run2.id) in items[0].description


def test_exception_ownership_workflow(db_session):
    org = make_organization(db_session)
    inv = make_invoice(db_session, org.id, make_customer(db_session, org.id).id)
    inv.balance_due = "42.00"
    db_session.flush()
    run = _run(db_session)
    exc = run.exceptions[0]

    svc = ReconciliationService(db_session)
    acked = svc.acknowledge_exception(exc.id, owner_user_id=7)
    assert acked.status == ReconciliationExceptionStatus.ACKNOWLEDGED
    assert acked.owner_user_id == 7
    assert acked.acknowledged_at is not None

    resolved = svc.resolve_exception(exc.id, note="Corrected balance via credit note")
    assert resolved.status == ReconciliationExceptionStatus.RESOLVED
    assert resolved.resolved_at is not None

    with pytest.raises(ValueError):
        svc.resolve_exception(exc.id, note="double resolve")
    with pytest.raises(ValueError):
        svc.acknowledge_exception(exc.id, owner_user_id=8)


def test_latest_run_selection_breaks_started_at_ties_by_id(db_session):
    """Regression: started_at (datetime.utcnow()) can resolve to the exact
    same value for runs created milliseconds apart (observed on this
    platform's clock resolution during this same test file), which made
    "most recent run" ambiguous for both the REC-01 gate and the runs list
    endpoint. Both must break the tie using id (creation order), not return
    whichever row the database happens to return first for equal keys.
    """
    from datetime import datetime

    from app.modules.super_admin.router import (
        get_production_acceptance_report,
        list_reconciliation_runs,
    )

    run1 = _run(db_session)
    run2 = _run(db_session)
    tied_time = datetime.utcnow()
    run1.started_at = tied_time
    run2.started_at = tied_time
    db_session.flush()

    listed = list_reconciliation_runs(limit=10, current_user=None, db=db_session)
    assert listed["items"][0]["id"] == run2.id

    rep = get_production_acceptance_report(current_user=None, db=db_session)
    rec = [i for i in rep.model_dump()["items"] if i["id"] == "REC-01"][0]
    assert str(run2.id) in rec["evidence"] or f"run #{run2.id}" in rec["evidence"]


def test_production_gate_reflects_reconciliation_state(db_session):
    from app.modules.super_admin.router import get_production_acceptance_report

    def rec_status():
        rep = get_production_acceptance_report(current_user=None, db=db_session)
        items = rep.model_dump()["items"]
        return [i for i in items if i["id"] == "REC-01"][0]

    # No runs yet -> WARNING (implemented but never executed here).
    assert rec_status()["status"] == "WARNING"

    # Clean run -> WARNING (honest PARTIAL cap without a processor source).
    clean = _run(db_session)
    assert rec_status()["status"] == "WARNING"

    # Failing run with unresolved exceptions -> FAIL (blocks go-live).
    org = make_organization(db_session)
    inv = make_invoice(db_session, org.id, make_customer(db_session, org.id).id)
    inv.balance_due = "13.37"
    db_session.flush()
    failing = _run(db_session)
    assert rec_status()["status"] == "FAIL"

    # Repair the ledger, resolve the exception and re-run -> WARNING/PARTIAL.
    inv.balance_due = "100.00"
    ReconciliationService(db_session).resolve_exception(
        failing.exceptions[0].id, note="fixed"
    )
    db_session.expire_all()
    _run(db_session)
    status = rec_status()["status"]
    assert status in ("WARNING", "PASS")


# ═══════════════════════════════════════════════════════════════════════════
# ISS-017 — true ledger-vs-Stripe processor comparison (Phase 11)
# ═══════════════════════════════════════════════════════════════════════════

# Bracket "today" dynamically — `make_payment` hardcodes `payment_date=date.today()`.
_RANGE_START = date.today() - timedelta(days=1)
_RANGE_END = date.today() + timedelta(days=1)


class _FakePage:
    def __init__(self, data, has_more=False):
        self.data = data
        self.has_more = has_more


class _FakePI:
    """Minimal stand-in for a Stripe PaymentIntent — attribute access only,
    matching how stripe_reconciliation.py reads real StripeObjects."""
    def __init__(self, id, status="succeeded", amount=10000, currency="usd"):
        self.id = id
        self.status = status
        self.amount_received = amount
        self.amount = amount
        self.currency = currency


class _FakeStripeModule:
    """Test double for the `stripe` module. Reuses the REAL installed
    stripe SDK's exception classes (imported from `stripe` directly) so
    `classify_stripe_error`'s isinstance checks exercise genuine Stripe
    error types, not fakes — this module makes zero network calls."""

    def __init__(self, responses_by_account: dict | None = None, default_pages: list | None = None):
        for name in (
            "StripeError", "APIError", "APIConnectionError", "AuthenticationError",
            "RateLimitError", "InvalidRequestError", "PermissionError",
        ):
            setattr(self, name, getattr(real_stripe, name))
        self._responses_by_account = {k: list(v) for k, v in (responses_by_account or {}).items()}
        self._default_pages = list(default_pages or [])
        self.calls: list[dict] = []
        self.PaymentIntent = self

    def list(self, **kwargs):
        self.calls.append(kwargs)
        acct = kwargs.get("stripe_account")
        queue = self._responses_by_account.get(acct) if acct in self._responses_by_account else self._default_pages
        if not queue:
            return _FakePage([], has_more=False)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _connect_org(db, organization_id, connected_account_id, status=IntegrationConnectionStatus.ACTIVE):
    row = StripeConnectedAccount(
        organization_id=organization_id, environment=IntegrationEnvironment.TEST,
        connected_account_id=connected_account_id, status=status,
        charges_enabled=status == IntegrationConnectionStatus.ACTIVE,
        payouts_enabled=True, details_submitted=True,
    )
    db.add(row)
    db.flush()
    return row


def _run_with_stripe(db, fake_module, range_start=_RANGE_START, range_end=_RANGE_END, trigger="manual"):
    with patch("app.modules.super_admin.stripe_reconciliation._stripe_module", return_value=fake_module):
        svc = ReconciliationService(db)
        run = svc.run_reconciliation(
            trigger=trigger, compare_processor=True, range_start=range_start, range_end=range_end,
        )
        svc.report_to_attention_engine(run)
    return run


# ── Step 18: the mandatory VERIFIED-vs-PARTIAL distinction ──────────────────

def test_stripe_key_present_but_comparison_not_requested_stays_partial():
    """STRIPE_SECRET_KEY exists (real ambient test-mode key, unmodified) but
    compare_processor is NOT passed -> PARTIAL, never VERIFIED. This is the
    exact fabrication Phase 9 removed; Phase 11 must not reintroduce it."""
    from app.config import settings
    assert settings.STRIPE_SECRET_KEY.startswith("sk_test_")  # test-mode safety precondition


def test_stripe_key_present_but_comparison_not_requested_stays_partial_run(db_session):
    run = _run(db_session)  # compare_processor defaults False
    assert run.state == ReconciliationRunState.PARTIAL
    assert run.processor_source == "stripe"  # key IS configured
    assert run.processor_environment is None  # but no comparison ran
    assert run.processor_stats is None


def test_stripe_comparison_executed_and_clean_yields_verified(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_verified")
    pay = make_payment(db_session, org.id, cust.id, amount="100.00", stripe_payment_intent_id="pi_match_1")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_match_1", amount=10000)])])
    run = _run_with_stripe(db_session, fake)

    assert run.state == ReconciliationRunState.VERIFIED
    assert run.exceptions_found == 0
    assert run.processor_environment == "test"
    assert run.processor_stats["fully_verified"] is True
    assert run.processor_stats["records_matched"] == 1
    assert org.id in run.processor_stats["organizations_compared"]


# ── Step 19: the mandated discrepancy example (₹1000 ledger vs ₹900 Stripe) ─

def test_amount_mismatch_is_recorded_without_mutating_either_side(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_amt")
    pay = make_payment(db_session, org.id, cust.id, amount="1000.00", stripe_payment_intent_id="pi_amt_mismatch")
    original_amount = str(pay.amount)

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_amt_mismatch", amount=90000)])])  # Stripe: 900.00
    run = _run_with_stripe(db_session, fake)

    assert run.state == ReconciliationRunState.FAILED
    assert str(pay.amount) == original_amount  # ledger NEVER auto-corrected
    kinds = {e.kind for e in run.exceptions}
    assert "stripe_amount_mismatch" in kinds
    exc = next(e for e in run.exceptions if e.kind == "stripe_amount_mismatch")
    assert exc.detail["ledger_amount"] == "1000.00"
    assert exc.detail["stripe_amount"] == "900.00"
    assert exc.entity_id == pay.id  # both records identified, ledger side preserved


# ── Step 17 required scenarios ───────────────────────────────────────────────

def test_exact_match_no_discrepancy(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_exact")
    make_payment(db_session, org.id, cust.id, amount="250.00", currency="USD", stripe_payment_intent_id="pi_exact")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_exact", amount=25000, currency="usd")])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.VERIFIED
    assert run.exceptions_found == 0


def test_missing_in_stripe(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_mis_stripe")
    pay = make_payment(db_session, org.id, cust.id, amount="50.00", stripe_payment_intent_id="pi_never_in_stripe")

    fake = _FakeStripeModule(default_pages=[_FakePage([])])  # Stripe has nothing
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.FAILED
    exc = next(e for e in run.exceptions if e.kind == "stripe_missing_in_stripe")
    assert exc.entity_id == pay.id


def test_missing_in_ledger(db_session):
    org = make_organization(db_session)
    make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_mis_ledger")
    # No ledger Payment row created at all.

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_ghost")])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.FAILED
    exc = next(e for e in run.exceptions if e.kind == "stripe_missing_in_ledger")
    assert exc.detail["stripe_payment_intent_id"] == "pi_ghost"


def test_status_mismatch(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_status")
    make_payment(
        db_session, org.id, cust.id, amount="75.00",
        status=PaymentStatus.CLEARED, stripe_payment_intent_id="pi_status",
    )

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_status", status="requires_payment_method", amount=7500)])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.FAILED
    exc = next(e for e in run.exceptions if e.kind == "stripe_status_mismatch")
    assert exc.detail["ledger_status"] == "cleared"
    assert exc.detail["stripe_status"] == "requires_payment_method"


def test_refunded_ledger_status_compatible_with_succeeded_stripe_status(db_session):
    """Step 7: Stripe's PaymentIntent stays 'succeeded' forever even after
    the charge is refunded (refunds live on Charge/Refund, not
    PaymentIntent). A REFUNDED ledger Payment matched against a 'succeeded'
    PaymentIntent is NOT a discrepancy."""
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_refund_ok")
    make_payment(
        db_session, org.id, cust.id, amount="20.00",
        status=PaymentStatus.REFUNDED, stripe_payment_intent_id="pi_refunded",
    )
    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_refunded", status="succeeded", amount=2000)])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.VERIFIED
    assert run.exceptions_found == 0


def test_duplicate_processor_record(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_dup_stripe")
    make_payment(db_session, org.id, cust.id, amount="10.00", stripe_payment_intent_id="pi_dup")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_dup", amount=1000), _FakePI("pi_dup", amount=1000)])])
    run = _run_with_stripe(db_session, fake)
    kinds = [e.kind for e in run.exceptions]
    assert "stripe_duplicate_processor_record" in kinds


def test_duplicate_ledger_record(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_dup_ledger")
    make_payment(db_session, org.id, cust.id, amount="10.00", payment_number="PAY-A", stripe_payment_intent_id="pi_shared")
    make_payment(db_session, org.id, cust.id, amount="10.00", payment_number="PAY-B", stripe_payment_intent_id="pi_shared")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_shared", amount=1000)])])
    run = _run_with_stripe(db_session, fake)
    kinds = [e.kind for e in run.exceptions]
    assert "stripe_duplicate_ledger_record" in kinds


def test_identifier_mismatch(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_bad_id")
    make_payment(db_session, org.id, cust.id, amount="10.00", stripe_payment_intent_id="not-a-real-stripe-id")

    fake = _FakeStripeModule(default_pages=[_FakePage([])])
    run = _run_with_stripe(db_session, fake)
    kinds = [e.kind for e in run.exceptions]
    assert "stripe_identifier_mismatch" in kinds


def test_currency_mismatch_does_not_attempt_amount_comparison(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_ccy")
    make_payment(db_session, org.id, cust.id, amount="10.00", currency="USD", stripe_payment_intent_id="pi_ccy")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_ccy", amount=1000, currency="eur")])])
    run = _run_with_stripe(db_session, fake)
    kinds = [e.kind for e in run.exceptions]
    assert "stripe_currency_mismatch" in kinds
    assert "stripe_amount_mismatch" not in kinds  # no exchange rate assumed


def test_unsupported_mapping_checkout_session_only(db_session):
    """A Payment that only ever reached 'checkout session created' (no
    PaymentIntent id yet) cannot be compared as if it were a PaymentIntent —
    must be flagged UNSUPPORTED_MAPPING, not a false MISSING_IN_STRIPE."""
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_checkout")
    pay = make_payment(db_session, org.id, cust.id, amount="10.00")
    pay.stripe_checkout_session_id = "cs_test_only"
    db_session.flush()

    fake = _FakeStripeModule(default_pages=[_FakePage([])])
    run = _run_with_stripe(db_session, fake)
    kinds = [e.kind for e in run.exceptions]
    assert "stripe_unsupported_mapping" in kinds
    assert "stripe_missing_in_stripe" not in kinds


def test_stripe_authentication_failure_keeps_run_partial(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_auth_fail")
    make_payment(db_session, org.id, cust.id, amount="10.00", stripe_payment_intent_id="pi_x")

    fake = _FakeStripeModule(default_pages=[real_stripe.AuthenticationError("bad key")])
    run = _run_with_stripe(db_session, fake)
    assert run.state != ReconciliationRunState.VERIFIED
    assert run.state == ReconciliationRunState.PARTIAL  # error, no exceptions raised from unverifiable data
    errors = run.processor_stats["processor_errors"]
    assert any(e["category"] == "authentication_failure" for e in errors)


def test_stripe_timeout_classified_as_network_or_timeout(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_timeout")
    make_payment(db_session, org.id, cust.id, amount="10.00", stripe_payment_intent_id="pi_x")

    fake = _FakeStripeModule(default_pages=[real_stripe.APIConnectionError("timed out")])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.PARTIAL
    errors = run.processor_stats["processor_errors"]
    assert any(e["category"] == "network_or_timeout" for e in errors)


def test_stripe_pagination_consumes_every_page(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_paginate")
    make_payment(db_session, org.id, cust.id, amount="1.00", payment_number="P1", stripe_payment_intent_id="pi_page1")
    make_payment(db_session, org.id, cust.id, amount="1.00", payment_number="P2", stripe_payment_intent_id="pi_page2")

    fake = _FakeStripeModule(default_pages=[
        _FakePage([_FakePI("pi_page1", amount=100)], has_more=True),
        _FakePage([_FakePI("pi_page2", amount=100)], has_more=False),
    ])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.VERIFIED
    assert len(fake.calls) == 2
    assert fake.calls[1]["starting_after"] == "pi_page1"


def test_partial_stripe_retrieval_never_yields_false_missing_exceptions(db_session):
    """If retrieval fails partway, records not yet fetched must NOT be
    accused of being missing on either side (Step 11)."""
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_partial")
    make_payment(db_session, org.id, cust.id, amount="1.00", payment_number="P1", stripe_payment_intent_id="pi_seen")
    make_payment(db_session, org.id, cust.id, amount="1.00", payment_number="P2", stripe_payment_intent_id="pi_unseen")

    fake = _FakeStripeModule(default_pages=[
        _FakePage([_FakePI("pi_seen", amount=100)], has_more=True),
        real_stripe.APIConnectionError("dropped mid-pagination"),
    ])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.PARTIAL
    kinds = [e.kind for e in run.exceptions]
    assert "stripe_missing_in_stripe" not in kinds
    assert "stripe_missing_in_ledger" not in kinds
    assert any(e["category"] == "network_or_timeout" for e in run.processor_stats["processor_errors"])


def test_tenant_isolation_across_two_orgs(db_session):
    """Org A's Stripe data must never be compared against Org B's ledger,
    and vice versa — each org is queried with its OWN connected_account_id
    and its OWN ledger scope only."""
    org_a = make_organization(db_session, code="ORG-A-STRIPE")
    org_b = make_organization(db_session, code="ORG-B-STRIPE")
    cust_a = make_customer(db_session, org_a.id, code="CUST-A-S")
    cust_b = make_customer(db_session, org_b.id, code="CUST-B-S")
    _connect_org(db_session, org_a.id, "acct_org_a")
    _connect_org(db_session, org_b.id, "acct_org_b")
    make_payment(db_session, org_a.id, cust_a.id, amount="10.00", stripe_payment_intent_id="pi_org_a_only")
    make_payment(db_session, org_b.id, cust_b.id, amount="20.00", stripe_payment_intent_id="pi_org_b_only")

    fake = _FakeStripeModule(responses_by_account={
        "acct_org_a": [_FakePage([_FakePI("pi_org_a_only", amount=1000)])],
        "acct_org_b": [_FakePage([_FakePI("pi_org_b_only", amount=2000)])],
    })
    run = _run_with_stripe(db_session, fake)

    assert run.state == ReconciliationRunState.VERIFIED
    assert run.exceptions_found == 0
    # Every call was scoped to exactly one org's own connected account.
    accounts_used = {c["stripe_account"] for c in fake.calls}
    assert accounts_used == {"acct_org_a", "acct_org_b"}
    assert set(run.processor_stats["organizations_compared"]) == {org_a.id, org_b.id}


def test_tenant_isolation_cross_org_mismatch_is_still_caught_correctly(db_session):
    """If org A's ledger id were (hypothetically) looked up against org B's
    Stripe data, a real mismatch would surface as MISSING_IN_STRIPE for A —
    proves the scoping is enforced, not merely coincidentally passing."""
    org_a = make_organization(db_session, code="ORG-A-XT")
    org_b = make_organization(db_session, code="ORG-B-XT")
    cust_a = make_customer(db_session, org_a.id, code="CUST-A-XT")
    _connect_org(db_session, org_a.id, "acct_xt_a")
    _connect_org(db_session, org_b.id, "acct_xt_b")
    make_payment(db_session, org_a.id, cust_a.id, amount="10.00", stripe_payment_intent_id="pi_only_in_b")

    # pi_only_in_b exists ONLY under org B's connected account.
    fake = _FakeStripeModule(responses_by_account={
        "acct_xt_a": [_FakePage([])],
        "acct_xt_b": [_FakePage([_FakePI("pi_only_in_b", amount=1000)])],
    })
    run = _run_with_stripe(db_session, fake)
    kinds_by_org = {}
    for e in run.exceptions:
        kinds_by_org.setdefault(e.organization_id, set()).add(e.kind)
    # Org A's ledger row points at an id that only exists under org B's own
    # connected account -> looked up against org A's OWN account it is
    # correctly missing there (tenant scoping, not a cross-org lookup).
    assert "stripe_missing_in_stripe" in kinds_by_org.get(org_a.id, set())
    # Org B's own Stripe account genuinely has this PaymentIntent with no
    # matching ledger row under org B -> correctly its own, separate,
    # same-tenant discrepancy (proves org B's ledger was checked against
    # org B's OWN Stripe data, not silently skipped or merged with org A).
    assert "stripe_missing_in_ledger" in kinds_by_org.get(org_b.id, set())


def test_unauthorized_role_cannot_trigger_reconciliation_capability():
    """The new compare_processor path is exposed on the SAME endpoint,
    behind the SAME `require_capability('financial_consistency.read')`
    dependency, unmodified. SUPPORT_OPERATOR does not hold that
    capability; AUDITOR does."""
    dependency = require_capability("financial_consistency.read")
    unauthorized = User(
        email="support@example.com", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="O", is_active=True, is_verified=True,
        platform_role=PlatformRole.SUPPORT_OPERATOR,
    )
    with pytest.raises(ForbiddenException):
        dependency(current_user=unauthorized)

    authorized = User(
        email="auditor@example.com", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="A", last_name="U", is_active=True, is_verified=True,
        platform_role=PlatformRole.AUDITOR,
    )
    assert dependency(current_user=authorized) is authorized


def test_idempotent_repeated_processor_reconciliation_does_not_mutate_ledger(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_idem")
    pay = make_payment(db_session, org.id, cust.id, amount="10.00", stripe_payment_intent_id="pi_idem")
    before = (str(pay.amount), pay.status, pay.stripe_payment_intent_id)

    fake1 = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_idem", amount=1000)])])
    run1 = _run_with_stripe(db_session, fake1)
    fake2 = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_idem", amount=1000)])])
    run2 = _run_with_stripe(db_session, fake2)

    after = (str(pay.amount), pay.status, pay.stripe_payment_intent_id)
    assert before == after
    assert run1.id != run2.id
    assert run1.state == ReconciliationRunState.VERIFIED
    assert run2.state == ReconciliationRunState.VERIFIED


def test_decimal_safe_amount_comparison_rejects_naive_float_equality(db_session):
    """0.1 + 0.2 != 0.3 in binary float — the comparator must be Decimal-safe
    and must not flag a genuinely-equal cents amount as a mismatch due to
    float artifacts."""
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_decimal")
    make_payment(db_session, org.id, cust.id, amount="19.99", stripe_payment_intent_id="pi_decimal")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_decimal", amount=1999)])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.VERIFIED


def test_empty_reconciliation_range_is_verified_when_clean(db_session):
    org = make_organization(db_session)
    make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_empty")
    # No ledger payments, no Stripe records at all.

    fake = _FakeStripeModule(default_pages=[_FakePage([])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.VERIFIED
    assert run.processor_stats["records_inspected"] == 0


def test_bounded_range_within_limit_is_accepted(db_session):
    org = make_organization(db_session)
    make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_bounded")
    fake = _FakeStripeModule(default_pages=[_FakePage([])])
    run = _run_with_stripe(
        db_session, fake,
        range_start=date.today() - timedelta(days=30), range_end=date.today(),
    )
    assert run.state == ReconciliationRunState.VERIFIED


def test_range_exceeding_max_is_rejected_before_any_stripe_call(db_session):
    svc = ReconciliationService(db_session)
    with patch("app.modules.super_admin.stripe_reconciliation._stripe_module") as mock_stripe_mod:
        with pytest.raises(ValueError):
            svc.run_reconciliation(
                compare_processor=True,
                range_start=date.today() - timedelta(days=200),
                range_end=date.today(),
            )
        mock_stripe_mod.assert_not_called()


def test_range_start_after_end_is_rejected(db_session):
    svc = ReconciliationService(db_session)
    with pytest.raises(ValueError):
        svc.run_reconciliation(
            compare_processor=True, range_start=date.today(), range_end=date.today() - timedelta(days=1),
        )


def test_missing_range_with_compare_processor_is_rejected(db_session):
    svc = ReconciliationService(db_session)
    with pytest.raises(ValueError):
        svc.run_reconciliation(compare_processor=True)


def test_no_organization_connected_stays_partial_and_makes_zero_stripe_calls(db_session):
    """compare_processor=True but zero organizations have an ACTIVE Stripe
    connection -> no Stripe API call was made at all -> PARTIAL, not
    vacuously VERIFIED (Step 10's rule requires an actual comparison)."""
    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_unreachable")])])
    run = _run_with_stripe(db_session, fake)
    assert run.state == ReconciliationRunState.PARTIAL
    assert fake.calls == []
    assert run.processor_stats["any_comparison_performed"] is False


def test_stripe_not_configured_at_all_degrades_gracefully(db_session):
    """compare_processor=True requested, but STRIPE_SECRET_KEY itself is
    blank platform-wide -> must not raise, must not call Stripe, stays
    PARTIAL exactly like the pre-Phase-11 (Phase 9) behavior."""
    with patch("app.modules.super_admin.reconciliation_service.settings") as mock_settings:
        mock_settings.STRIPE_SECRET_KEY = ""
        svc = ReconciliationService(db_session)
        run = svc.run_reconciliation(
            trigger="manual", compare_processor=True,
            range_start=_RANGE_START, range_end=_RANGE_END,
        )
    assert run.state == ReconciliationRunState.PARTIAL
    assert run.processor_source == "none"
    assert run.processor_environment is None


def test_processor_run_serialization_never_leaks_the_secret_key(db_session):
    """Auditability (Step 14): the run's audit trail must never contain the
    Stripe secret key or authorization headers."""
    from app.config import settings as real_settings

    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    _connect_org(db_session, org.id, "acct_no_leak")
    make_payment(db_session, org.id, cust.id, amount="1.00", stripe_payment_intent_id="pi_no_leak")

    fake = _FakeStripeModule(default_pages=[_FakePage([_FakePI("pi_no_leak", amount=100)])])
    run = _run_with_stripe(db_session, fake)

    import json
    serialized = json.dumps(run.processor_stats) + (run.processor_note or "")
    assert real_settings.STRIPE_SECRET_KEY not in serialized
    for call in fake.calls:
        assert "authorization" not in {k.lower() for k in call.keys()}
