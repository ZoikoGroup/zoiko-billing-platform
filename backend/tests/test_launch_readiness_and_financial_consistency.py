"""
tests/test_launch_readiness_and_financial_consistency.py
------------------------------------------------------------
ZB-SA-CMD-003 §23 Launch Readiness + Phase 15 internal financial
consistency check.

Coverage:
  1. Financial consistency: healthy allocation state -> VERIFIED
  2. Financial consistency: over-allocation -> FAILED, with example detail
  3. Financial consistency: zero invoices -> UNKNOWN (never a fake PASS)
  4. Launch Readiness: every item runs a real check (not hardcoded)
  5. Launch Readiness: overall status escalates to FAIL when any item FAILs
  6. Launch Readiness: MFA enrollment check reflects real enrollment state
  7. Launch Readiness: open P0 attention item fails the TRIAGE-01 gate
"""

from decimal import Decimal

import pyotp

from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import SuperAdminMFA, User, UserRole
from app.modules.billing.models import InvoiceStatus, PaymentAllocation
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService
from app.modules.super_admin.launch_readiness_service import LaunchReadinessService
from app.modules.super_admin.models import AttentionSeverity
from tests.conftest import make_customer, make_invoice, make_organization, make_payment


def test_financial_consistency_healthy(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID, total_amount="100.00", paid_amount="100.00")
    pay = make_payment(db_session, org.id, cust.id, amount="100.00")
    db_session.add(PaymentAllocation(organization_id=org.id, payment_id=pay.id, invoice_id=inv.id, amount=Decimal("100.00")))
    db_session.commit()

    result = FinancialConsistencyService(db_session).check_allocation_consistency()
    assert result["state"] == "VERIFIED"
    assert result["over_allocated_count"] == 0


def test_financial_consistency_detects_over_allocation(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID, total_amount="100.00", paid_amount="100.00")
    pay = make_payment(db_session, org.id, cust.id, amount="150.00")
    db_session.add(PaymentAllocation(organization_id=org.id, payment_id=pay.id, invoice_id=inv.id, amount=Decimal("150.00")))
    db_session.commit()

    result = FinancialConsistencyService(db_session).check_allocation_consistency()
    assert result["state"] == "FAILED"
    assert result["over_allocated_count"] == 1
    assert result["over_allocated_examples"][0]["invoice_id"] == inv.id
    assert "not reconciliation against processor" in result["coverage_note"] or "not reconciliation" in result["coverage_note"]


def test_financial_consistency_no_invoices_is_unknown_not_pass(db_session):
    result = FinancialConsistencyService(db_session).check_allocation_consistency()
    assert result["state"] == "UNKNOWN"
    assert result["total_invoices_checked"] == 0


def test_launch_readiness_runs_real_checks(db_session):
    report = LaunchReadinessService(db_session).evaluate()
    ids = {item["id"] for item in report["items"]}
    assert {"DB-01", "SEC-CFG-01", "SEC-CFG-02", "SEC-MFA-01", "GOV-AUDIT-01", "REL-SCHED-01", "SEC-CFG-03", "TRIAGE-01", "FIN-01", "A11Y-01", "PERF-01"} == ids
    # Accessibility/performance are honestly UNKNOWN, never a fabricated PASS.
    a11y = next(i for i in report["items"] if i["id"] == "A11Y-01")
    perf = next(i for i in report["items"] if i["id"] == "PERF-01")
    assert a11y["status"] == "UNKNOWN"
    assert perf["status"] in {"UNKNOWN", "PASS", "WARNING"}


def test_launch_readiness_overall_fails_when_any_item_fails(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID, total_amount="100.00", paid_amount="100.00")
    pay = make_payment(db_session, org.id, cust.id, amount="500.00")
    db_session.add(PaymentAllocation(organization_id=org.id, payment_id=pay.id, invoice_id=inv.id, amount=Decimal("500.00")))
    db_session.commit()

    report = LaunchReadinessService(db_session).evaluate()
    assert report["overall_status"] == "FAIL"
    fin_item = next(i for i in report["items"] if i["id"] == "FIN-01")
    assert fin_item["status"] == "FAIL"


def test_launch_readiness_mfa_enrollment_reflects_real_state(db_session):
    user = User(
        email="sa-noenroll@readiness.example", hashed_password="x", role=UserRole.SUPER_ADMIN,
        organization_id=None, first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    report = LaunchReadinessService(db_session).evaluate()
    mfa_item = next(i for i in report["items"] if i["id"] == "SEC-MFA-01")
    assert mfa_item["status"] == "WARNING"  # active super_admin exists but has no enrolled MFA

    secret = pyotp.random_base32()
    db_session.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db_session.commit()

    report2 = LaunchReadinessService(db_session).evaluate()
    mfa_item2 = next(i for i in report2["items"] if i["id"] == "SEC-MFA-01")
    assert mfa_item2["status"] == "PASS"


def test_launch_readiness_fails_on_open_p0_attention(db_session):
    AttentionService(db_session).report_or_update(
        source="manual", source_key="manual:readiness-p0", title="Critical issue",
        base_severity=AttentionSeverity.P0,
    )
    report = LaunchReadinessService(db_session).evaluate()
    triage_item = next(i for i in report["items"] if i["id"] == "TRIAGE-01")
    assert triage_item["status"] == "FAIL"
    assert report["overall_status"] == "FAIL"
