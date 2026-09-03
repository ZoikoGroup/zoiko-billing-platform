"""
tests/test_reconciliation_engine.py
-----------------------------------
REC-01 ??? ledger reconciliation engine: run lifecycle, both internal checks,
exception ownership workflow, and the production-acceptance gate wiring.
"""

from datetime import datetime, timedelta

import pytest

from app.modules.billing.models import InvoiceStatus, PaymentAllocation
from app.modules.super_admin.models import (
    ReconciliationException,
    ReconciliationExceptionStatus,
    ReconciliationRun,
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
    run = _run(db_session)
    assert run.state == ReconciliationRunState.PARTIAL  # capped: no processor source
    assert run.exceptions_found == 0
    assert run.checks_total == 2
    assert run.processor_source in ("none", "stripe")
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


def test_stale_verified_run_downgrades_to_warning_not_pass(db_session):
    """A run that would otherwise report VERIFIED/PASS must not do so if it's
    old enough that the scheduled job (settings.RECONCILIATION_INTERVAL_MINUTES,
    default 24h) has plausibly stopped running since — REC-01 previously had
    no recency check at all, so a stale clean run could hide a dead scheduler
    behind a permanent PASS."""
    from app.config import settings
    from app.modules.super_admin.router import get_production_acceptance_report

    run = ReconciliationRun(
        plane="plane2",
        state=ReconciliationRunState.VERIFIED,
        processor_source="stripe",
        processor_environment="test",
        checks_total=3,
        exceptions_found=0,
    )
    stale_minutes = settings.RECONCILIATION_INTERVAL_MINUTES * 2 + 60
    run.started_at = datetime.utcnow() - timedelta(minutes=stale_minutes)
    run.finished_at = run.started_at
    db_session.add(run)
    db_session.flush()

    rep = get_production_acceptance_report(current_user=None, db=db_session)
    rec = [i for i in rep.model_dump()["items"] if i["id"] == "REC-01"][0]
    assert rec["status"] == "WARNING"
    assert f"#{run.id}" in rec["evidence"]
    assert "reconciliation_job" in rec["evidence"] or "scheduler" in rec["evidence"].lower()


def test_fresh_verified_run_reports_pass(db_session):
    """The counterpart to the staleness test above: a VERIFIED run within
    the expected cadence must still report PASS, proving the new staleness
    check doesn't downgrade every clean run — only genuinely old ones."""
    from app.modules.super_admin.router import get_production_acceptance_report

    run = ReconciliationRun(
        plane="plane2",
        state=ReconciliationRunState.VERIFIED,
        processor_source="stripe",
        processor_environment="test",
        checks_total=3,
        exceptions_found=0,
    )
    db_session.add(run)
    db_session.flush()

    rep = get_production_acceptance_report(current_user=None, db=db_session)
    rec = [i for i in rep.model_dump()["items"] if i["id"] == "REC-01"][0]
    assert rec["status"] == "PASS"


def test_fail_on_open_exceptions_is_not_masked_by_staleness_logic(db_session):
    """The FAIL branch (unresolved reconciliation exceptions on the latest
    run) is a legitimate money-doesn't-match signal, not a miscalibrated
    check — confirm the new staleness handling (which only touches the
    PASS branch) never downgrades or otherwise hides it, even when the
    failing run is itself old."""
    from app.modules.super_admin.router import get_production_acceptance_report

    run = ReconciliationRun(
        plane="plane2",
        state=ReconciliationRunState.FAILED,
        processor_source="none",
        checks_total=2,
        exceptions_found=1,
    )
    db_session.add(run)
    db_session.flush()
    db_session.add(ReconciliationException(
        run_id=run.id,
        kind="invoice_balance_mismatch",
        entity_type="invoice",
        entity_id=1,
        status=ReconciliationExceptionStatus.OPEN,
    ))
    run.started_at = datetime.utcnow() - timedelta(days=30)
    db_session.flush()

    rep = get_production_acceptance_report(current_user=None, db=db_session)
    rec = [i for i in rep.model_dump()["items"] if i["id"] == "REC-01"][0]
    assert rec["status"] == "FAIL"
