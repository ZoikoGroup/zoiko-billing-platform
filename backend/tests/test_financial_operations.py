"""
tests/test_financial_operations.py
-----------------------------------
Tests for Phase 2C Financial Operations aggregation (FinancialConsistencyService.get_financial_operations_summary).
Verifies:
- F1 Billings aggregate correctness (invoices, overdue amounts)
- F2 Recovery metrics (failed payments count)
- F3 Reconciliation composite state (honest UNKNOWN vs VERIFIED vs FAILED)
- F4 Revenue leakage counts (over-allocated invoices, active credits)
"""

from decimal import Decimal
import pytest

from app.modules.billing.models import InvoiceStatus, PaymentStatus, PaymentAllocation
from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService
from tests.conftest import make_customer, make_invoice, make_organization, make_payment


def test_financial_operations_empty_db_returns_unknown(db_session):
    result = FinancialConsistencyService(db_session).get_financial_operations_summary()

    # F3 composite verification must be UNKNOWN when no invoices exist (never fake VERIFIED)
    assert result["consistency"]["state"] == "UNKNOWN"
    assert result["consistency"]["total_invoices_checked"] == 0
    assert result["billings"]["total_invoices"] == 0
    assert result["recovery"]["failed_payments_count"] == 0
    assert result["recovery"]["dunning_cycle_status"] == "NOT CONFIGURED"
    assert result["recovery"]["active_dunning_cases_count"] == 0
    assert result["leakage"]["over_allocated_count"] == 0



def test_financial_operations_with_live_records(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)

    # 1 PAID invoice, perfectly allocated
    inv = make_invoice(
        db_session,
        org.id,
        cust.id,
        status=InvoiceStatus.PAID,
        total_amount="100.00",
        paid_amount="100.00",
    )
    pay = make_payment(db_session, org.id, cust.id, amount="100.00")
    db_session.add(
        PaymentAllocation(
            organization_id=org.id,
            payment_id=pay.id,
            invoice_id=inv.id,
            amount=Decimal("100.00"),
        )
    )

    # 1 OVERDUE invoice
    inv_overdue = make_invoice(
        db_session,
        org.id,
        cust.id,
        status=InvoiceStatus.OVERDUE,
        total_amount="50.00",
        paid_amount="0.00",
    )
    db_session.commit()

    result = FinancialConsistencyService(db_session).get_financial_operations_summary()

    assert result["consistency"]["state"] == "VERIFIED"
    assert result["consistency"]["total_invoices_checked"] == 2
    assert result["consistency"]["over_allocated_count"] == 0
    assert result["billings"]["total_invoices"] == 2
    assert Decimal(result["billings"]["invoiced_amount"]) == Decimal("150.00")
    assert Decimal(result["billings"]["collected_amount"]) == Decimal("100.00")
    assert result["billings"]["overdue_count"] == 1
    assert Decimal(result["billings"]["overdue_amount"]) == Decimal("50.00")
