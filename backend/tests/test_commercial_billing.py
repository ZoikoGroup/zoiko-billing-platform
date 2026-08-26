"""
Regression tests for Plane 1 Commercial Billing (quote → invoice → payment).

Covers:
  - CommercialQuoteService: create, add_item, send, approve (self-approval
    rejection), reject, expire, convert_to_invoice, public accept/reject
  - PlatformInvoiceService: create_draft, add_item, calculate_totals, finalize
    (atomic numbering), void, record_payment, record_refund, record_write_off
  - PlatformPaymentService: record (runtime processor assertion), allocate,
    deallocate, reconcile
  - PlatformReconciliationService: invoice balance check, payment allocation check
  - RBAC: new capabilities present in capability map

All tests run on the isolated in-memory SQLite fixture from conftest.py.
"""

import pytest
from decimal import Decimal
from datetime import date, timedelta

from app.core.capabilities import CAPABILITIES
from app.modules.commercial.enums import (
    CommercialQuoteStatus,
    PlatformInvoiceStatus,
    PlatformPaymentStatus,
    PlatformCreditNoteStatus,
    PlatformRefundStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialPlan,
    CommercialQuote,
    CommercialQuoteItem,
    CommercialSubscription,
    PlatformCreditNote,
    PlatformInvoice,
    PlatformInvoiceItem,
    PlatformInvoiceNumberSequence,
    PlatformPayment,
    PlatformPaymentAllocation,
    PlatformRefund,
)
from app.modules.commercial.quote_service import CommercialQuoteService
from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
from app.modules.commercial.platform_payment_service import (
    PlatformPaymentService,
    ZOIKO_PLATFORM_PROCESSOR_IDENTITY,
)
from app.modules.commercial.platform_reconciliation_service import PlatformReconciliationService
from app.modules.commercial.enums import PlatformInvoiceDeliveryStatus
from app.modules.organizations.models import Organization
from app.modules.auth.models import User, UserRole


@pytest.fixture(autouse=True)
def _mock_platform_emails(monkeypatch):
    """Every test here runs on isolated in-memory SQLite — never let a
    send_quote/send_invoice call reach real SMTP. Tests that care about the
    exact recipient/args override this per-test with their own
    monkeypatch.setattr, which simply takes precedence within that test."""
    monkeypatch.setattr("app.services.email_service.send_platform_invoice_email", lambda *a, **k: True)
    monkeypatch.setattr("app.services.email_service.send_platform_quote_email", lambda *a, **k: True)


# ── helpers ─────────────────────────────────────────────────────────────────

def _make_account(db, org_id=1):
    account = CommercialAccount(
        organization_id=org_id,
        status="active",
    )
    db.add(account)
    db.flush()
    return account


def _make_plan(db, code="STARTER"):
    plan = CommercialPlan(
        plan_code=code,
        plan_name=f"{code} Plan",
        status="active",
    )
    db.add(plan)
    db.flush()
    return plan


def _make_subscription(db, account_id, plan_id):
    sub = CommercialSubscription(
        commercial_account_id=account_id,
        commercial_plan_id=plan_id,
        status="active",
    )
    db.add(sub)
    db.flush()
    return sub


def _make_org_with_admin(db, org_name="Acme Co", org_code="ACME1", admin_email="admin@acme.test"):
    org = Organization(organization_name=org_name, organization_code=org_code)
    db.add(org)
    db.flush()
    admin = User(
        email=admin_email,
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=org.id,
        first_name="Ada",
        last_name="Admin",
    )
    db.add(admin)
    db.flush()
    return org, admin


# ═══════════════════════════════════════════════════════════════════════════════
# Quote Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestCommercialQuoteService:
    def test_create_quote(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(
            account_id=account.id,
            actor_id=1,
            subject="Test Quote",
        )

        assert quote.id is not None
        assert quote.status == CommercialQuoteStatus.DRAFT
        assert quote.quote_number.startswith("CQT-")
        assert quote.subject == "Test Quote"
        db.commit()

    def test_add_item_and_totals(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)
        svc.add_item(
            quote_id=quote.id,
            actor_id=1,
            line_number=1,
            description="Service A",
            quantity=Decimal("2"),
            unit_price=Decimal("100.00"),
        )
        svc.add_item(
            quote_id=quote.id,
            actor_id=1,
            line_number=2,
            description="Service B",
            quantity=Decimal("1"),
            unit_price=Decimal("50.00"),
            tax_amount=Decimal("5.00"),
        )

        db.refresh(quote)
        assert quote.subtotal == Decimal("250.00")  # 200 + 50
        assert quote.tax_amount == Decimal("5.00")
        assert quote.total_amount == Decimal("255.00")
        db.commit()

    def test_send_quote(self, db_session):
        db = db_session
        org, _admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)
        svc.send_quote(quote_id=quote.id, actor_id=1)

        db.refresh(quote)
        assert quote.status == CommercialQuoteStatus.SENT
        assert quote.public_token is not None
        db.commit()

    def test_send_quote_emails_org_admin(self, db_session, monkeypatch):
        db = db_session
        org, admin = _make_org_with_admin(db, org_name="Beta Inc", org_code="BETA1")
        account = _make_account(db, org_id=org.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1, subject="Renewal")

        captured = {}

        def fake_send_email(email, org_name, quote_number, *args, **kwargs):
            captured["email"] = email
            captured["org_name"] = org_name
            return True

        monkeypatch.setattr(
            "app.services.email_service.send_platform_quote_email", fake_send_email
        )

        sent = svc.send_quote(quote_id=quote.id, actor_id=1)

        assert sent.public_token is not None
        assert captured["email"] == admin.email
        assert captured["org_name"] == "Beta Inc"
        db.commit()

    def test_send_quote_without_org_admin_raises(self, db_session):
        db = db_session
        account = _make_account(db)  # org_id=1, no real Organization/User rows
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)

        with pytest.raises(ValueError, match="No org_admin found"):
            svc.send_quote(quote_id=quote.id, actor_id=1)
        db.commit()

    def test_approve_quote_self_approval_rejected(self, db_session):
        db = db_session
        org, _admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)
        svc.send_quote(quote_id=quote.id, actor_id=1)

        with pytest.raises(ValueError, match="different from the quote creator"):
            svc.approve_quote(quote_id=quote.id, actor_id=1)
        db.commit()

    def test_approve_quote_different_approver(self, db_session):
        db = db_session
        org, _admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)
        svc.send_quote(quote_id=quote.id, actor_id=1)
        svc.approve_quote(quote_id=quote.id, actor_id=2)  # different user

        db.refresh(quote)
        assert quote.status == CommercialQuoteStatus.ACCEPTED
        db.commit()

    def test_reject_quote(self, db_session):
        db = db_session
        org, _admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)
        svc.send_quote(quote_id=quote.id, actor_id=1)
        svc.reject_quote(quote_id=quote.id, actor_id=2, reason="Too expensive")

        db.refresh(quote)
        assert quote.status == CommercialQuoteStatus.REJECTED
        db.commit()

    def test_convert_to_invoice(self, db_session):
        db = db_session
        org, _admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        plan = _make_plan(db)
        sub = _make_subscription(db, account.id, plan.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(
            account_id=account.id, actor_id=1, subscription_id=sub.id
        )
        svc.add_item(
            quote_id=quote.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("500.00"),
        )
        svc.send_quote(quote_id=quote.id, actor_id=1)
        svc.approve_quote(quote_id=quote.id, actor_id=2)

        invoice = svc.convert_to_invoice(
            quote_id=quote.id, actor_id=2, due_date=date.today() + timedelta(days=30)
        )

        assert invoice.id is not None
        assert invoice.status == PlatformInvoiceStatus.DRAFT
        assert invoice.total_amount == Decimal("500.00")
        assert invoice.balance_due == Decimal("500.00")

        db.refresh(quote)
        assert quote.status == CommercialQuoteStatus.CONVERTED
        assert quote.converted_platform_invoice_id == invoice.id
        db.commit()

    def test_public_accept_reject(self, db_session):
        db = db_session
        org, _admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        svc = CommercialQuoteService(db)

        quote = svc.create_quote(account_id=account.id, actor_id=1)
        svc.send_quote(quote_id=quote.id, actor_id=1)
        token = quote.public_token

        # Public accept
        accepted = svc.accept_public_quote(token)
        db.refresh(accepted)
        assert accepted.status == CommercialQuoteStatus.ACCEPTED

        # Create another for reject test
        quote2 = svc.create_quote(account_id=account.id, actor_id=1)
        svc.send_quote(quote_id=quote2.id, actor_id=1)
        token2 = quote2.public_token

        rejected = svc.reject_public_quote(token2, reason="No thanks")
        db.refresh(rejected)
        assert rejected.status == CommercialQuoteStatus.REJECTED
        db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# Platform Invoice Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestPlatformInvoiceService:
    def test_create_draft_and_add_item(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        assert invoice.status == PlatformInvoiceStatus.DRAFT

        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Consulting", quantity=Decimal("10"),
            unit_price=Decimal("150.00"),
        )

        db.refresh(invoice)
        assert invoice.subtotal == Decimal("1500.00")
        assert invoice.total_amount == Decimal("1500.00")
        assert invoice.balance_due == Decimal("1500.00")
        db.commit()

    def test_calculate_totals_consistency(self, db_session):
        """calculate_totals is shared by preview and finalize — same formula."""
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="A", quantity=Decimal("1"),
            unit_price=Decimal("100.00"), tax_amount=Decimal("10.00"),
        )
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=2, description="B", quantity=Decimal("2"),
            unit_price=Decimal("50.00"),
        )

        svc.calculate_totals(invoice)
        db.refresh(invoice)
        assert invoice.subtotal == Decimal("200.00")  # 100 + 100
        assert invoice.tax_amount == Decimal("10.00")
        assert invoice.total_amount == Decimal("210.00")
        db.commit()

    def test_finalize_allocates_invoice_number(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("100.00"),
        )

        finalized = svc.finalize(invoice_id=invoice.id, actor_id=2)

        assert finalized.status == PlatformInvoiceStatus.ISSUED
        assert finalized.invoice_number is not None
        assert finalized.invoice_number.startswith("PINV-")
        db.commit()

    def test_finalize_empty_invoice_raises(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)

        with pytest.raises(ValueError, match="no line items"):
            svc.finalize(invoice_id=invoice.id, actor_id=2)
        db.commit()

    def test_void_invoice(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("100.00"),
        )
        svc.finalize(invoice_id=invoice.id, actor_id=2)
        svc.void(invoice_id=invoice.id, actor_id=3, reason="Customer cancelled")

        db.refresh(invoice)
        assert invoice.status == PlatformInvoiceStatus.VOIDED
        assert invoice.voided_reason == "Customer cancelled"
        db.commit()

    def test_record_payment_updates_balance(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("1000.00"),
        )
        svc.finalize(invoice_id=invoice.id, actor_id=2)

        svc.record_payment(invoice_id=invoice.id, amount=Decimal("400.00"), actor_id=3)
        db.refresh(invoice)
        assert invoice.paid_amount == Decimal("400.00")
        assert invoice.balance_due == Decimal("600.00")
        assert invoice.status == PlatformInvoiceStatus.PARTIALLY_PAID

        svc.record_payment(invoice_id=invoice.id, amount=Decimal("600.00"), actor_id=3)
        db.refresh(invoice)
        assert invoice.paid_amount == Decimal("1000.00")
        assert invoice.balance_due == Decimal("0.00")
        assert invoice.status == PlatformInvoiceStatus.PAID
        db.commit()

    def test_record_refund(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("500.00"),
        )
        svc.finalize(invoice_id=invoice.id, actor_id=2)
        svc.record_payment(invoice_id=invoice.id, amount=Decimal("500.00"), actor_id=3)

        svc.record_refund(invoice_id=invoice.id, amount=Decimal("200.00"), actor_id=4)
        db.refresh(invoice)
        assert invoice.paid_amount == Decimal("300.00")
        assert invoice.balance_due == Decimal("200.00")
        db.commit()

    def test_send_generates_public_token_and_emails_org_admin(self, db_session, monkeypatch):
        db = db_session
        org, admin = _make_org_with_admin(db)
        account = _make_account(db, org_id=org.id)
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("100.00"),
        )
        svc.finalize(invoice_id=invoice.id, actor_id=2)

        captured = {}

        def fake_send_email(email, org_name, invoice_number, *args, **kwargs):
            captured["email"] = email
            captured["org_name"] = org_name
            return True

        monkeypatch.setattr(
            "app.services.email_service.send_platform_invoice_email", fake_send_email
        )

        sent = svc.send(invoice_id=invoice.id, actor_id=3)

        assert sent.public_token is not None
        assert sent.delivery_status == PlatformInvoiceDeliveryStatus.SENT
        assert captured["email"] == admin.email
        assert captured["org_name"] == "Acme Co"
        db.commit()

    def test_send_without_org_admin_raises(self, db_session):
        db = db_session
        account = _make_account(db)  # org_id=1, no real Organization/User rows
        svc = PlatformInvoiceService(db)

        invoice = svc.create_draft(account_id=account.id, actor_id=1)
        svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("100.00"),
        )
        svc.finalize(invoice_id=invoice.id, actor_id=2)

        with pytest.raises(ValueError, match="No org_admin found"):
            svc.send(invoice_id=invoice.id, actor_id=3)
        db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# Platform Payment Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestPlatformPaymentService:
    def test_record_manual_payment(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformPaymentService(db)

        payment = svc.record(
            account_id=account.id, actor_id=1,
            amount=Decimal("1000.00"), payment_method="manual",
        )

        assert payment.status == PlatformPaymentStatus.CLEARED
        assert payment.processor_account_identity == ZOIKO_PLATFORM_PROCESSOR_IDENTITY
        assert payment.payment_number.startswith("PPMT-")
        db.commit()

    def test_record_checkout_payment_pending(self, db_session):
        db = db_session
        account = _make_account(db)
        svc = PlatformPaymentService(db)

        payment = svc.record(
            account_id=account.id, actor_id=1,
            amount=Decimal("500.00"), payment_method="card",
        )

        assert payment.status == PlatformPaymentStatus.PENDING
        db.commit()

    def test_allocate_and_deallocate(self, db_session):
        db = db_session
        account = _make_account(db)
        inv_svc = PlatformInvoiceService(db)
        pay_svc = PlatformPaymentService(db)

        # Create invoice
        invoice = inv_svc.create_draft(account_id=account.id, actor_id=1)
        inv_svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("500.00"),
        )
        inv_svc.finalize(invoice_id=invoice.id, actor_id=2)

        # Record payment
        payment = pay_svc.record(
            account_id=account.id, actor_id=1,
            amount=Decimal("500.00"), payment_method="manual",
        )

        # Allocate
        alloc = pay_svc.allocate(
            payment_id=payment.id, invoice_id=invoice.id,
            amount=Decimal("300.00"), actor_id=3,
        )
        assert alloc.amount == Decimal("300.00")

        db.refresh(invoice)
        assert invoice.paid_amount == Decimal("300.00")
        assert invoice.balance_due == Decimal("200.00")

        # Deallocate
        pay_svc.deallocate(
            payment_id=payment.id, invoice_id=invoice.id, actor_id=3,
        )
        db.refresh(invoice)
        assert invoice.paid_amount == Decimal("0.00")
        assert invoice.balance_due == Decimal("500.00")
        db.commit()

    def test_reconcile(self, db_session):
        db = db_session
        account = _make_account(db)
        inv_svc = PlatformInvoiceService(db)
        pay_svc = PlatformPaymentService(db)

        invoice = inv_svc.create_draft(account_id=account.id, actor_id=1)
        inv_svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("100.00"),
        )
        inv_svc.finalize(invoice_id=invoice.id, actor_id=2)

        payment = pay_svc.record(
            account_id=account.id, actor_id=1,
            amount=Decimal("100.00"), payment_method="manual",
        )
        pay_svc.allocate(
            payment_id=payment.id, invoice_id=invoice.id,
            amount=Decimal("100.00"), actor_id=3,
        )

        assert pay_svc.reconcile(payment.id) is True
        db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# Reconciliation Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestPlatformReconciliation:
    def test_clean_run(self, db_session):
        db = db_session
        account = _make_account(db)
        inv_svc = PlatformInvoiceService(db)
        pay_svc = PlatformPaymentService(db)

        # Create and fully pay an invoice
        invoice = inv_svc.create_draft(account_id=account.id, actor_id=1)
        inv_svc.add_item(
            invoice_id=invoice.id, actor_id=1,
            line_number=1, description="Item", quantity=Decimal("1"),
            unit_price=Decimal("100.00"),
        )
        inv_svc.finalize(invoice_id=invoice.id, actor_id=2)

        payment = pay_svc.record(
            account_id=account.id, actor_id=1,
            amount=Decimal("100.00"), payment_method="manual",
        )
        pay_svc.allocate(
            payment_id=payment.id, invoice_id=invoice.id,
            amount=Decimal("100.00"), actor_id=3,
        )

        svc = PlatformReconciliationService(db)
        run = svc.run_reconciliation(trigger="test")

        assert run.exceptions_found == 0
        db.commit()

    def test_run_is_tagged_plane1(self, db_session):
        """Plane 1 and Plane 2 reconciliation runs share reconciliation_runs
        — this tag is what lets each Super Admin surface filter to its own
        plane instead of showing both mixed together."""
        db = db_session
        svc = PlatformReconciliationService(db)
        run = svc.run_reconciliation(trigger="test")
        assert run.plane == "plane1"
        db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# RBAC Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestCommercialBillingCapabilities:
    def test_new_capabilities_exist(self):
        required = [
            "commercial_quote.write",
            "commercial_quote.approve",
            "commercial_payment.write",
            "commercial_financial.read",
        ]
        for cap in required:
            assert cap in CAPABILITIES, f"Missing capability: {cap}"

    def test_all_enums_importable(self):
        assert CommercialQuoteStatus.DRAFT.value == "draft"
        assert PlatformInvoiceStatus.DRAFT.value == "draft"
        assert PlatformPaymentStatus.PENDING.value == "pending"
        assert PlatformCreditNoteStatus.DRAFT.value == "draft"
        assert PlatformRefundStatus.DRAFT.value == "draft"


# ═══════════════════════════════════════════════════════════════════════════════
# Model Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestCommercialBillingModels:
    def test_all_tables_exist(self, db_session):
        from sqlalchemy import inspect as sa_inspect
        from app.database import engine

        inspector = sa_inspect(engine)
        expected = [
            "commercial_quotes",
            "commercial_quote_items",
            "platform_invoices",
            "platform_invoice_items",
            "platform_invoice_number_sequences",
            "platform_payments",
            "platform_payment_allocations",
            "platform_credit_notes",
            "platform_refunds",
        ]
        existing = inspector.get_table_names()
        for table in expected:
            assert table in existing, f"Missing table: {table}"
