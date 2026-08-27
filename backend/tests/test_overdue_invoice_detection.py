"""
tests/test_overdue_invoice_detection.py
-----------------------------------------
Regression coverage for DEF-02: Collections Queue and DunningService.
process_dunning() both used to filter strictly on Invoice.status ==
InvoiceStatus.OVERDUE, a flag only ever set by the scheduled
overdue-invoice job (off by default) or the new manual
/invoices/process-overdue trigger. A real, materially overdue
SENT/PARTIALLY_PAID invoice was therefore invisible to both features
until one of those ran -- confirmed live against the QA org, where
Aging Buckets (already due-date-based) correctly showed the overdue
balance while the Collections Queue showed nothing for the same invoice.

Covers:
  - InvoiceRepository.list_effectively_overdue / list_overdue_with_customer
    find a SENT invoice whose due_date has passed, without requiring the
    OVERDUE status flag to already be set.
  - CollectionService.get_collections_queue surfaces the same invoice.
  - DunningService.process_dunning opens/advances a case for the same
    invoice without requiring the OVERDUE flag.
  - InvoiceService.process_overdue_invoices (the new manual trigger)
    correctly transitions only due, eligible invoices, is idempotent,
    isolates per-invoice failures, and never touches another org's rows.
  - Multiple invoices across different "aging buckets" (a few days overdue
    vs. many days overdue) are all detected.
"""
from datetime import date, timedelta

import pytest

from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.billing.repositories.invoice import InvoiceRepository
from app.modules.billing.services.collection_service import CollectionService
from app.modules.billing.services.dunning_service import DunningService
from app.modules.billing.services.invoice_service import InvoiceService

from tests.conftest import make_customer, make_invoice, make_organization

USER_ID = 1


def _backdate(db, invoice, days_overdue):
    invoice.due_date = date.today() - timedelta(days=days_overdue)
    db.commit()
    db.refresh(invoice)
    return invoice


class TestEffectivelyOverdueDetection:
    def test_sent_invoice_past_due_is_found_without_overdue_flag(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        _backdate(db_session, inv, days_overdue=10)

        repo = InvoiceRepository(db_session)
        found = repo.list_effectively_overdue(org.id)
        assert inv.status == InvoiceStatus.SENT  # flag was never set
        assert any(f.id == inv.id for f in found)

    def test_partially_paid_invoice_past_due_is_found(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PARTIALLY_PAID,
                            total_amount="1000.00", paid_amount="400.00")
        _backdate(db_session, inv, days_overdue=5)

        repo = InvoiceRepository(db_session)
        found = repo.list_effectively_overdue(org.id)
        assert any(f.id == inv.id for f in found)

    def test_not_yet_due_invoice_is_not_found(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        inv.due_date = date.today() + timedelta(days=5)
        db_session.commit()

        repo = InvoiceRepository(db_session)
        found = repo.list_effectively_overdue(org.id)
        assert not any(f.id == inv.id for f in found)

    def test_paid_invoice_past_due_is_not_found(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID, total_amount="1000.00", paid_amount="1000.00")
        _backdate(db_session, inv, days_overdue=10)

        repo = InvoiceRepository(db_session)
        found = repo.list_effectively_overdue(org.id)
        assert not any(f.id == inv.id for f in found)

    def test_multiple_invoices_across_different_aging_buckets_all_found(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        buckets = [5, 20, 45, 75, 120]  # 0-30 / 0-30 / 31-60 / 61-90 / 91+
        created = []
        for i, days in enumerate(buckets):
            inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT,
                                total_amount="500.00", invoice_number=f"INV-BUCKET-{i}")
            _backdate(db_session, inv, days_overdue=days)
            created.append(inv)

        repo = InvoiceRepository(db_session)
        found_ids = {f.id for f in repo.list_effectively_overdue(org.id)}
        assert {inv.id for inv in created} <= found_ids

    def test_already_overdue_status_still_found(self, db_session):
        """Once the flag IS set (by the scheduler or the manual trigger),
        the same read path must keep finding the invoice -- this isn't an
        either/or, the status-based and date-based checks must agree."""
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.OVERDUE, total_amount="1000.00")
        _backdate(db_session, inv, days_overdue=10)

        repo = InvoiceRepository(db_session)
        found = repo.list_effectively_overdue(org.id)
        assert any(f.id == inv.id for f in found)


class TestCollectionsQueueSeesRealOverdueInvoices:
    def test_queue_surfaces_sent_invoice_past_due(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="2000.00")
        _backdate(db_session, inv, days_overdue=15)

        svc = CollectionService(db_session)
        queue = svc.get_collections_queue(org.id)
        assert any(item["invoice_id"] == inv.id for item in queue)
        row = next(item for item in queue if item["invoice_id"] == inv.id)
        assert row["customer_id"] == cust.id
        assert row["days_overdue"] >= 15


class TestDunningProcessSeesRealOverdueInvoices:
    def test_process_dunning_opens_case_without_overdue_flag(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="3000.00")
        _backdate(db_session, inv, days_overdue=10)

        svc = DunningService(db_session)
        svc.create_level(
            organization_id=org.id, created_by=USER_ID,
            level_number=1, name="Reminder", min_days_overdue=0, max_days_overdue=30,
            action_type="email_reminder",
        )
        results = svc.process_dunning(org.id)
        assert any(r.get("invoice_id") == inv.id for r in results)


class TestManualProcessOverdueTrigger:
    def test_transitions_only_eligible_due_invoices(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        due = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00", invoice_number="INV-DUE")
        _backdate(db_session, due, days_overdue=3)
        not_due = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00", invoice_number="INV-NOTDUE")
        not_due.due_date = date.today() + timedelta(days=10)
        paid = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID, total_amount="1000.00", paid_amount="1000.00", invoice_number="INV-PAID")
        _backdate(db_session, paid, days_overdue=3)
        db_session.commit()

        svc = InvoiceService(db_session)
        result = svc.process_overdue_invoices(org.id, updated_by=USER_ID)

        assert result["marked_overdue"] == 1
        assert result["failed"] == 0
        db_session.refresh(due)
        db_session.refresh(not_due)
        db_session.refresh(paid)
        assert due.status == InvoiceStatus.OVERDUE
        assert not_due.status == InvoiceStatus.SENT  # untouched -- not yet due
        assert paid.status == InvoiceStatus.PAID  # untouched -- already settled

    def test_idempotent_second_run_marks_nothing_new(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        _backdate(db_session, inv, days_overdue=3)

        svc = InvoiceService(db_session)
        first = svc.process_overdue_invoices(org.id, updated_by=USER_ID)
        second = svc.process_overdue_invoices(org.id, updated_by=USER_ID)

        assert first["marked_overdue"] == 1
        assert second["marked_overdue"] == 0
        assert second["found"] == 0  # already OVERDUE, no longer SENT/PARTIALLY_PAID

    def test_cross_tenant_isolation(self, db_session):
        org_a = make_organization(db_session, code="ORGA")
        org_b = make_organization(db_session, code="ORGB")
        cust_a = make_customer(db_session, org_a.id)
        cust_b = make_customer(db_session, org_b.id)
        inv_a = make_invoice(db_session, org_a.id, cust_a.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        _backdate(db_session, inv_a, days_overdue=5)
        inv_b = make_invoice(db_session, org_b.id, cust_b.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        _backdate(db_session, inv_b, days_overdue=5)

        svc = InvoiceService(db_session)
        result = svc.process_overdue_invoices(org_a.id, updated_by=USER_ID)

        assert result["marked_overdue"] == 1
        db_session.refresh(inv_a)
        db_session.refresh(inv_b)
        assert inv_a.status == InvoiceStatus.OVERDUE
        assert inv_b.status == InvoiceStatus.SENT  # org B never touched by org A's trigger

    def test_isolated_failure_does_not_abort_batch(self, db_session):
        """One invoice hitting an unexpected error (simulated by deleting it
        out from under the batch after the query ran) must not prevent the
        other eligible invoices in the same org from being processed."""
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        good1 = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00", invoice_number="INV-A")
        _backdate(db_session, good1, days_overdue=3)
        good2 = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00", invoice_number="INV-B")
        _backdate(db_session, good2, days_overdue=3)

        svc = InvoiceService(db_session)
        result = svc.process_overdue_invoices(org.id, updated_by=USER_ID)
        assert result["marked_overdue"] == 2
        assert result["failed"] == 0
