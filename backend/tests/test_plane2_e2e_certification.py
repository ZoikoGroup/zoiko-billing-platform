"""
tests/test_plane2_e2e_certification.py
----------------------------------------
Plane 2 (tenant revenue operations) end-to-end certification.

Written for the 2026-09-19 production-readiness re-certification pass
(docs/FINAL_PRODUCTION_READINESS_CERTIFICATION.md). Exercises the REAL
service layer (CustomerService, InvoiceService, PaymentService,
CreditNoteService, RefundService, WriteOffService) against a real (in-memory
SQLite) database — the same layer every FastAPI router in
backend/app/modules/billing/routers/*.py calls through
Depends(get_organization_id). This is deliberately NOT a TestClient/HTTP
test: it follows this repo's established convention (see
test_auth_token_security.py's docstring) of exercising the service layer
directly, since every protected route's authorization ultimately reduces to
the same organization_id-scoped repository calls tested here.

Two things this file intentionally does NOT chain together, documented
rather than faked: Quote -> Contract -> Subscription -> auto-generated
Invoice. That conversion chain exists in quote_service.convert_to_invoice /
contract_service.convert_quotation_to_contract / subscription_service, but
was not exercised end-to-end in this pass -- the invoice lifecycle below is
built directly (create_invoice -> bulk_set_items -> finalize_invoice), which
is also a fully real, independently-used path (manual/one-off invoicing).
"""
from datetime import date
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.core.security import hash_password
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import InvoiceStatus
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.payment_service import PaymentService
from app.modules.billing.services.credit_note_service import CreditNoteService
from app.modules.billing.services.refund_service import RefundService
from app.modules.billing.services.write_off_service import WriteOffService
from app.modules.billing.services.product_service import ProductService
from app.modules.billing.services.quote_service import QuoteService
from app.modules.billing.services.dashboard_service import BillingDashboardService

from tests.conftest import make_organization


def _make_user(db, organization, role, email):
    user = User(
        email=email,
        hashed_password=hash_password("CertPass123!"),
        role=role,
        organization_id=organization.id,
        first_name="Cert",
        last_name="User",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture()
def org_a(db_session):
    return make_organization(db_session, code="E2EORGA", name="Org A (Certification)")


@pytest.fixture()
def org_b(db_session):
    return make_organization(db_session, code="E2EORGB", name="Org B (Certification)")


class TestPlane2FinancialLifecycleE2E:
    """Section 7/8 of the certification brief: the core business + financial
    lifecycle, with the exact figures the brief specifies (EUR 1,000.00
    invoice, EUR 400 then EUR 600 payments)."""

    def test_full_invoice_payment_lifecycle_exact_amounts(self, db_session, org_a):
        db = db_session
        org_admin = _make_user(db, org_a, UserRole.ORG_ADMIN, "orgadmin@acme-e2e.test")
        finance_approver = _make_user(db, org_a, UserRole.FINANCE_APPROVER, "finance@acme-e2e.test")

        customer_svc = CustomerService(db)
        invoice_svc = InvoiceService(db)
        payment_svc = PaymentService(db)

        # --- Customer -------------------------------------------------
        customer = customer_svc.create_customer(
            org_a.id, org_admin.id,
            company_name="ACME GmbH", display_name="ACME GmbH",
            email="billing@acme-gmbh.test", currency="EUR",
            customer_code="ACME-GMBH",
        )
        assert customer.organization_id == org_a.id

        # --- Invoice: 1 line item, EUR 1,000.00, 19% VAT (Germany) -----
        invoice = invoice_svc.create_invoice(
            org_a.id, org_admin.id,
            customer_id=customer.id,
            invoice_number="auto",
            issue_date=date.today(),
            due_date=date.today(),
            currency="EUR",
        )
        assert invoice.status == InvoiceStatus.DRAFT

        invoice_svc.bulk_set_items(invoice.id, org_a.id, items=[
            {
                "description": "Professional Subscription (Monthly)",
                "quantity": Decimal("1"),
                "unit_price": Decimal("1000.00"),
                "discount_percentage": Decimal("0"),
                "tax_percentage": Decimal("19"),
            },
        ])

        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        # Order of operations per calculation_service.py: subtotal -> discount
        # -> taxable amount -> tax -> total. No discount here, so:
        #   subtotal = 1000.00, tax = 190.00, total = 1190.00
        assert invoice.subtotal == Decimal("1000.00")
        assert invoice.discount_amount in (Decimal("0.00"), Decimal("0"), None) or Decimal(str(invoice.discount_amount or 0)) == Decimal("0.00")
        assert Decimal(str(invoice.tax_amount)) == Decimal("190.00")
        assert Decimal(str(invoice.total_amount)) == Decimal("1190.00")
        assert Decimal(str(invoice.balance_due)) == Decimal("1190.00")

        # --- Finalize: line items become immutable ---------------------
        invoice = invoice_svc.finalize_invoice(invoice.id, org_a.id, org_admin.id)
        assert invoice.status == InvoiceStatus.SENT
        with pytest.raises(BadRequestException):
            invoice_svc.bulk_set_items(invoice.id, org_a.id, items=[
                {"description": "Sneaky post-finalization edit", "quantity": Decimal("1"), "unit_price": Decimal("1"), "tax_percentage": Decimal("0")},
            ])

        # --- Payment 1: EUR 400.00 (partial) -----------------------------
        payment_1 = payment_svc.record_payment(
            org_a.id, customer.id, "PAY-E2E-001",
            amount=Decimal("400.00"), payment_date=date.today(), created_by=org_admin.id,
            currency="EUR",
        )
        payment_svc.allocate_payment(payment_1.id, org_a.id, invoice.id, Decimal("400.00"), org_admin.id)

        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        assert Decimal(str(invoice.paid_amount)) == Decimal("400.00")
        assert Decimal(str(invoice.balance_due)) == Decimal("790.00")
        assert invoice.status == InvoiceStatus.PARTIALLY_PAID

        # --- Payment 2: EUR 600.00 completes the invoice -----------------
        # 400 + 600 = 1000, but the invoice total is 1190 (with 19% VAT) --
        # so per the brief's own worked example (which ignores tax), the
        # true remaining amount after 400+600=1000 is EUR 190.00, not 0.
        # This is the CORRECT behavior: it proves tax is not silently
        # dropped from the outstanding-balance calculation.
        payment_2 = payment_svc.record_payment(
            org_a.id, customer.id, "PAY-E2E-002",
            amount=Decimal("600.00"), payment_date=date.today(), created_by=org_admin.id,
            currency="EUR",
        )
        payment_svc.allocate_payment(payment_2.id, org_a.id, invoice.id, Decimal("600.00"), org_admin.id)

        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        assert Decimal(str(invoice.paid_amount)) == Decimal("1000.00")
        assert Decimal(str(invoice.balance_due)) == Decimal("190.00")
        assert invoice.status == InvoiceStatus.PARTIALLY_PAID  # not fully settled yet -- tax remains outstanding

        # --- Settle the remaining EUR 190.00 (the VAT) -------------------
        payment_3 = payment_svc.record_payment(
            org_a.id, customer.id, "PAY-E2E-003",
            amount=Decimal("190.00"), payment_date=date.today(), created_by=org_admin.id,
            currency="EUR",
        )
        payment_svc.allocate_payment(payment_3.id, org_a.id, invoice.id, Decimal("190.00"), org_admin.id)

        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        assert Decimal(str(invoice.paid_amount)) == Decimal("1190.00")
        assert Decimal(str(invoice.balance_due)) == Decimal("0")
        assert invoice.status == InvoiceStatus.PAID

        # --- No over-allocation / no double settlement -------------------
        # A payment cannot be allocated twice to the same invoice, and an
        # allocation exceeding the remaining balance must be rejected.
        with pytest.raises(BadRequestException):
            payment_svc.allocate_payment(payment_3.id, org_a.id, invoice.id, Decimal("0.01"), org_admin.id)
        extra_payment = payment_svc.record_payment(
            org_a.id, customer.id, "PAY-E2E-004",
            amount=Decimal("50.00"), payment_date=date.today(), created_by=org_admin.id,
            currency="EUR",
        )
        with pytest.raises(BadRequestException):
            # Invoice balance is now 0 -- any further allocation must fail,
            # not silently drive balance_due negative.
            payment_svc.allocate_payment(extra_payment.id, org_a.id, invoice.id, Decimal("50.00"), org_admin.id)
        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        assert Decimal(str(invoice.balance_due)) == Decimal("0")  # unchanged -- no negative-balance corruption

        # --- Partial refund of Payment 1 (maker-checker) ------------------
        refund_svc = RefundService(db)
        refund = refund_svc.create_refund(
            org_a.id, org_admin.id, customer.id, "auto",
            refund_type="partial", amount=Decimal("100.00"),
            payment_id=payment_1.id, currency="EUR",
            reason="Customer goodwill adjustment",
        )
        refund = refund_svc.submit_for_approval(refund.id, org_a.id, org_admin.id)
        # Segregation of duties: the requester (org_admin) cannot approve
        # their own refund, even though ORG_ADMIN could approve someone
        # else's (get_current_finance_approver also accepts super_admin, but
        # org_admin is not in that allow-list at the router layer -- and the
        # service layer additionally blocks same-user approval regardless).
        with pytest.raises(ForbiddenException):
            refund_svc.approve_refund(refund.id, org_a.id, org_admin.id)
        refund = refund_svc.approve_refund(refund.id, org_a.id, finance_approver.id)
        # approved -> processing -> completed (matches the state machine in
        # refund_service._validate_status_transition and the 3-button UI flow
        # in refund-detail.jsx: Approve, then Start Processing, then Mark
        # Completed).
        refund = refund_svc.process_refund(refund.id, org_a.id, finance_approver.id)
        refund = refund_svc.complete_refund(refund.id, org_a.id, finance_approver.id)
        assert Decimal(str(refund.amount)) == Decimal("100.00")

        # --- Write-off on a SEPARATE, not-yet-paid invoice -----------------
        # (write_off_service explicitly forbids writing off a PAID invoice --
        # verified by reading write_off_service.create_write_off -- so this
        # uses a second invoice, not the one just fully settled above.)
        invoice_2 = invoice_svc.create_invoice(
            org_a.id, org_admin.id, customer_id=customer.id, invoice_number="auto",
            issue_date=date.today(), due_date=date.today(), currency="EUR",
        )
        invoice_svc.bulk_set_items(invoice_2.id, org_a.id, items=[
            {"description": "Overdue small balance", "quantity": Decimal("1"), "unit_price": Decimal("25.00"), "tax_percentage": Decimal("0")},
        ])
        invoice_2 = invoice_svc.finalize_invoice(invoice_2.id, org_a.id, org_admin.id)
        assert Decimal(str(invoice_2.balance_due)) == Decimal("25.00")

        write_off_svc = WriteOffService(db)
        write_off = write_off_svc.create_write_off(
            org_a.id, org_admin.id, customer.id, "auto",
            write_off_type="bad_debt", amount=Decimal("25.00"),
            invoice_id=invoice_2.id, currency="EUR", reason="Uncollectible small balance",
        )
        write_off = write_off_svc.submit_for_approval(write_off.id, org_a.id, org_admin.id)
        write_off = write_off_svc.approve_write_off(write_off.id, org_a.id, finance_approver.id)
        write_off = write_off_svc.execute_write_off(write_off.id, org_a.id, finance_approver.id)

        invoice_2 = invoice_svc.get_invoice(invoice_2.id, org_a.id)
        assert Decimal(str(invoice_2.balance_due)) == Decimal("0")

        # A written-off invoice's balance cannot go negative if a second
        # write-off/allocation is attempted against it.
        with pytest.raises(BadRequestException):
            write_off_svc.create_write_off(
                org_a.id, org_admin.id, customer.id, "auto",
                write_off_type="bad_debt", amount=Decimal("10.00"),
                invoice_id=invoice_2.id, currency="EUR", reason="Duplicate write-off attempt",
            )

        # --- Credit note (independent of the invoice above) ---------------
        credit_note_svc = CreditNoteService(db)
        credit_note = credit_note_svc.create_credit_note(
            org_a.id, org_admin.id, customer.id, "auto",
            credit_note_type="adjustment", total_amount=Decimal("50.00"),
            issue_date=date.today(), currency="EUR", subtotal=Decimal("50.00"),
            tax_amount=Decimal("0"),
        )
        assert Decimal(str(credit_note.remaining_amount)) == Decimal("50.00")


class TestPlane2MultiTenantIsolationE2E:
    """Section 9: Organization A must never be able to read Organization B's
    financial records, via the exact repository/service layer every router
    calls through Depends(get_organization_id). Tests both directions."""

    @pytest.fixture()
    def two_orgs_with_data(self, db_session, org_a, org_b):
        db = db_session
        user_a = _make_user(db, org_a, UserRole.ORG_ADMIN, "admin@org-a-e2e.test")
        user_b = _make_user(db, org_b, UserRole.ORG_ADMIN, "admin@org-b-e2e.test")

        customer_svc = CustomerService(db)
        invoice_svc = InvoiceService(db)
        payment_svc = PaymentService(db)

        customer_a = customer_svc.create_customer(
            org_a.id, user_a.id, company_name="Org A Customer", display_name="Org A Customer",
            email="customer@org-a-e2e.test", currency="USD", customer_code="ORGA-CUST",
        )
        customer_b = customer_svc.create_customer(
            org_b.id, user_b.id, company_name="Org B Customer", display_name="Org B Customer",
            email="customer@org-b-e2e.test", currency="USD", customer_code="ORGB-CUST",
        )

        invoice_a = invoice_svc.create_invoice(
            org_a.id, user_a.id, customer_id=customer_a.id, invoice_number="auto",
            issue_date=date.today(), due_date=date.today(), currency="USD",
        )
        invoice_svc.bulk_set_items(invoice_a.id, org_a.id, items=[
            {"description": "Org A service", "quantity": Decimal("1"), "unit_price": Decimal("500.00"), "tax_percentage": Decimal("0")},
        ])
        invoice_a = invoice_svc.finalize_invoice(invoice_a.id, org_a.id, user_a.id)

        invoice_b = invoice_svc.create_invoice(
            org_b.id, user_b.id, customer_id=customer_b.id, invoice_number="auto",
            issue_date=date.today(), due_date=date.today(), currency="USD",
        )
        invoice_svc.bulk_set_items(invoice_b.id, org_b.id, items=[
            {"description": "Org B service", "quantity": Decimal("1"), "unit_price": Decimal("750.00"), "tax_percentage": Decimal("0")},
        ])
        invoice_b = invoice_svc.finalize_invoice(invoice_b.id, org_b.id, user_b.id)

        payment_a = payment_svc.record_payment(
            org_a.id, customer_a.id, "PAY-A-001", amount=Decimal("500.00"),
            payment_date=date.today(), created_by=user_a.id, currency="USD",
        )
        payment_b = payment_svc.record_payment(
            org_b.id, customer_b.id, "PAY-B-001", amount=Decimal("750.00"),
            payment_date=date.today(), created_by=user_b.id, currency="USD",
        )
        return {
            "user_a": user_a, "user_b": user_b,
            "customer_a": customer_a, "customer_b": customer_b,
            "invoice_a": invoice_a, "invoice_b": invoice_b,
            "payment_a": payment_a, "payment_b": payment_b,
        }

    def test_org_a_cannot_read_org_b_customer(self, db_session, two_orgs_with_data):
        d = two_orgs_with_data
        customer_svc = CustomerService(db_session)
        with pytest.raises(NotFoundException):
            customer_svc.get_customer(d["customer_b"].id, d["user_a"].organization_id)
        # And the reverse direction.
        with pytest.raises(NotFoundException):
            customer_svc.get_customer(d["customer_a"].id, d["user_b"].organization_id)

    def test_org_a_cannot_read_org_b_invoice(self, db_session, two_orgs_with_data):
        d = two_orgs_with_data
        invoice_svc = InvoiceService(db_session)
        with pytest.raises(NotFoundException):
            invoice_svc.get_invoice(d["invoice_b"].id, d["user_a"].organization_id)
        with pytest.raises(NotFoundException):
            invoice_svc.get_invoice(d["invoice_a"].id, d["user_b"].organization_id)

    def test_org_a_cannot_read_org_b_payment(self, db_session, two_orgs_with_data):
        d = two_orgs_with_data
        payment_svc = PaymentService(db_session)
        with pytest.raises(Exception):
            # get_payment raises NotFoundException via BaseRepository.get_by_id
            payment_svc.get_payment(d["payment_b"].id, d["user_a"].organization_id)
        with pytest.raises(Exception):
            payment_svc.get_payment(d["payment_a"].id, d["user_b"].organization_id)

    def test_org_a_cannot_allocate_its_payment_to_org_b_invoice(self, db_session, two_orgs_with_data):
        """IDOR-style attack: Org A user has a valid, cleared payment of their
        own, and tries to allocate it directly against Org B's invoice id by
        (incorrectly) passing Org A's organization_id -- the invoice lookup
        inside allocate_payment is scoped to organization_id, so Org B's
        invoice simply does not exist from Org A's perspective."""
        d = two_orgs_with_data
        payment_svc = PaymentService(db_session)
        with pytest.raises(BadRequestException):
            payment_svc.allocate_payment(
                d["payment_a"].id, d["user_a"].organization_id, d["invoice_b"].id,
                Decimal("1.00"), d["user_a"].id,
            )

    def test_org_a_cannot_search_into_org_b_customers(self, db_session, two_orgs_with_data):
        d = two_orgs_with_data
        customer_svc = CustomerService(db_session)
        results = customer_svc.search_customers(d["user_a"].organization_id, "Org B", limit=20)
        assert d["customer_b"].id not in [c.id for c in results]
        assert all(c.organization_id == d["user_a"].organization_id for c in results)


class TestPlane2Phase16FinancialSanityCheck:
    """Phase 16 go-live certification's own worked example: a EUR 1,190.00
    invoice (EUR 1,000.00 subtotal + 19% VAT), settled across three payments
    of EUR 300 + 400 + 490 = EUR 1,190.00 exactly. Also touches product
    creation, quote creation, and the reporting/dashboard aggregation layer,
    to broaden deployment-rehearsal coverage beyond the customer/invoice/
    payment/refund/write-off/credit-note path the first E2E class covers."""

    def test_exact_1190_invoice_three_payment_settlement_and_reporting(self, db_session, org_a):
        db = db_session
        org_admin = _make_user(db, org_a, UserRole.ORG_ADMIN, "orgadmin@phase16-e2e.test")

        customer_svc = CustomerService(db)
        product_svc = ProductService(db)
        quote_svc = QuoteService(db)
        invoice_svc = InvoiceService(db)
        payment_svc = PaymentService(db)
        dashboard_svc = BillingDashboardService(db)

        customer = customer_svc.create_customer(
            org_a.id, org_admin.id,
            company_name="Phase16 GmbH", display_name="Phase16 GmbH",
            email="billing@phase16-gmbh.test", currency="EUR",
            customer_code="PHASE16-GMBH",
        )

        # Touches the product catalog (deployment-rehearsal coverage).
        product = product_svc.create_product(
            org_a.id, org_admin.id,
            name="Phase16 Professional Plan", code="PHASE16-PRO",
            default_price=Decimal("1000.00"), is_active=True,
        )

        # Touches quote creation (deployment-rehearsal coverage). Not
        # converted to an invoice -- see the module docstring's documented
        # scope decision on the Quote -> Contract -> Subscription chain.
        quote = quote_svc.create_quote(
            org_a.id, org_admin.id, customer.id, "Q-PHASE16-001",
            currency="EUR", notes="Phase 16 go-live rehearsal quote",
        )
        assert quote.status.value == "draft"

        invoice = invoice_svc.create_invoice(
            org_a.id, org_admin.id, customer_id=customer.id, invoice_number="auto",
            issue_date=date.today(), due_date=date.today(), currency="EUR",
        )
        invoice_svc.bulk_set_items(invoice.id, org_a.id, items=[
            {
                "description": "Phase16 Professional Plan",
                "product_id": product.id,
                "quantity": Decimal("1"),
                "unit_price": Decimal("1000.00"),
                "tax_percentage": Decimal("19"),
            },
        ])
        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        assert Decimal(str(invoice.total_amount)) == Decimal("1190.00")

        invoice = invoice_svc.finalize_invoice(invoice.id, org_a.id, org_admin.id)
        assert invoice.status == InvoiceStatus.SENT

        for i, amount in enumerate((Decimal("300.00"), Decimal("400.00"), Decimal("490.00")), start=1):
            payment = payment_svc.record_payment(
                org_a.id, customer.id, f"PAY-P16-{i:03d}",
                amount=amount, payment_date=date.today(), created_by=org_admin.id,
                currency="EUR",
            )
            payment_svc.allocate_payment(payment.id, org_a.id, invoice.id, amount, org_admin.id)

        invoice = invoice_svc.get_invoice(invoice.id, org_a.id)
        assert Decimal(str(invoice.paid_amount)) == Decimal("1190.00")
        assert Decimal(str(invoice.balance_due)) == Decimal("0")
        assert invoice.status == InvoiceStatus.PAID

        # Reporting/reconciliation-layer check: the dashboard aggregation
        # (what an operator's Reports/Reconciliation screens read from) must
        # reflect this invoice, not just the invoice row itself.
        summary = dashboard_svc.get_invoice_summary(org_a.id)
        assert summary["paid_count"] >= 1
        assert Decimal(str(summary["paid_amount"])) >= Decimal("1190.00")
        assert summary["total_invoices"] >= 1
