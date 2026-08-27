"""tests/test_stripe_plane2.py - Stripe Plane 2 comprehensive test suite."""
from __future__ import annotations
from decimal import Decimal
from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer, Dispute, DisputeStatus, Invoice, InvoiceStatus,
    IntegrationConnectionStatus, IntegrationEnvironment,
    Payment, PaymentAllocation, PaymentGatewayType, PaymentStatus, PaymentType,
    Refund, RefundMethod, RefundSource, RefundStatus, RefundType,
    StripeConnectedAccount, StripeEvent,
)
from app.modules.billing.services.payment_service import PaymentService
from app.modules.billing.services.refund_service import RefundService
from app.modules.billing.services.stripe_service import StripeService
from app.modules.billing.services.stripe_connect_service import StripeConnectService, _derive_status

@pytest.fixture(scope="function")
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()
    Base.metadata.drop_all(engine)

def _org(db, org_id=1, name="Tenant A"):
    org = Organization(id=org_id, organization_name=name, organization_code=name.lower().replace(" ", "-")[:20])
    db.add(org); db.commit(); return org

def _customer(db, org_id=1, cust_id=1):
    c = BillingCustomer(id=cust_id, organization_id=org_id, customer_code=f"CUST-{cust_id}", company_name=f"Company {cust_id}", display_name=f"Customer {cust_id}", currency="USD")
    db.add(c); db.commit(); return c

def _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0, currency="USD", status=InvoiceStatus.SENT, stripe_pi=None):
    from datetime import date
    inv = Invoice(id=inv_id, organization_id=org_id, customer_id=customer_id, invoice_number=f"INV-{inv_id:04d}", status=status, total_amount=Decimal(str(total)), balance_due=Decimal(str(total)), paid_amount=Decimal("0"), currency=currency, stripe_payment_intent_id=stripe_pi, issue_date=date.today(), due_date=date.today())
    db.add(inv); db.commit(); return inv

def _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, currency="USD", status=PaymentStatus.CLEARED, intent_id=None, charge_id=None):
    from datetime import date
    p = Payment(id=pay_id, organization_id=org_id, customer_id=customer_id, payment_number=f"PAY-{pay_id:04d}", payment_type=PaymentType.INVOICE_PAYMENT, amount=Decimal(str(amount)), currency=currency, status=status, gateway=PaymentGatewayType.CREDIT_CARD, stripe_payment_intent_id=intent_id, gateway_charge_id=charge_id, payment_date=date.today())
    db.add(p); db.commit(); return p

def _allocation(db, payment, invoice):
    alloc = PaymentAllocation(organization_id=payment.organization_id, payment_id=payment.id, invoice_id=invoice.id, amount=payment.amount)
    db.add(alloc)
    invoice.paid_amount = payment.amount
    invoice.balance_due = Decimal(str(invoice.total_amount)) - payment.amount
    invoice.status = InvoiceStatus.PAID
    db.commit(); return alloc

def _connect(db, org_id=1, acct_id="acct_test_A", status=IntegrationConnectionStatus.ACTIVE):
    """Seed an ACTIVE Stripe Connect account for GAP-1 routing tests."""
    row = StripeConnectedAccount(
        organization_id=org_id, environment=IntegrationEnvironment.TEST,
        connected_account_id=acct_id, status=status,
        charges_enabled=status == IntegrationConnectionStatus.ACTIVE,
        payouts_enabled=True, details_submitted=True,
    )
    db.add(row); db.commit(); return row

class TestStripeFoundation:
    def test_resolve_currency_valid(self, db):
        assert StripeService._resolve_and_validate_currency("USD") == "usd"
    def test_resolve_currency_invalid(self, db):
        from app.core.exceptions import BadRequestException
        with pytest.raises(BadRequestException, match="Unsupported"):
            StripeService._resolve_and_validate_currency("ZZZ")
    def test_stripe_service_boots_without_key(self, db):
        assert StripeService(db) is not None
    def test_stripe_module_raises_without_secret(self, db):
        from app.core.exceptions import BadRequestException
        from app.modules.billing.services.stripe_service import _stripe_module
        with patch("app.modules.billing.services.stripe_service.settings") as s:
            s.STRIPE_SECRET_KEY = ""
            with pytest.raises(BadRequestException, match="not configured"):
                _stripe_module()

class TestStripeConnect:
    def test_get_status_not_connected(self, db):
        _org(db, org_id=1)
        result = StripeConnectService(db).get_status_dict(1)
        assert result["connected"] is False
        assert result["status"] == "pending_onboarding"
    def test_derive_status_active(self):
        assert _derive_status({"charges_enabled": True, "payouts_enabled": True, "details_submitted": True, "requirements": {}}) == IntegrationConnectionStatus.ACTIVE
    def test_derive_status_onboarding_incomplete(self):
        assert _derive_status({"charges_enabled": False, "payouts_enabled": False, "details_submitted": False, "requirements": {}}) == IntegrationConnectionStatus.ONBOARDING_INCOMPLETE
    def test_derive_status_action_required(self):
        assert _derive_status({"charges_enabled": True, "payouts_enabled": True, "details_submitted": True, "requirements": {"currently_due": ["doc"]}}) == IntegrationConnectionStatus.ACTION_REQUIRED
    def test_account_persists(self, db):
        _org(db, org_id=1)
        db.add(StripeConnectedAccount(organization_id=1, environment=IntegrationEnvironment.TEST, connected_account_id="acct_abc", status=IntegrationConnectionStatus.ACTIVE, charges_enabled=True, payouts_enabled=True, details_submitted=True))
        db.commit()
        row = db.query(StripeConnectedAccount).filter_by(organization_id=1).first()
        assert row.connected_account_id == "acct_abc"
    def test_unique_per_org_env(self, db):
        from sqlalchemy.exc import IntegrityError
        _org(db, org_id=1)
        db.add(StripeConnectedAccount(organization_id=1, environment=IntegrationEnvironment.TEST, connected_account_id="acct_aaa", status=IntegrationConnectionStatus.ACTIVE, charges_enabled=True, payouts_enabled=True, details_submitted=True))
        db.commit()
        with pytest.raises(IntegrityError):
            db.add(StripeConnectedAccount(organization_id=1, environment=IntegrationEnvironment.TEST, connected_account_id="acct_bbb", status=IntegrationConnectionStatus.ACTIVE, charges_enabled=True, payouts_enabled=True, details_submitted=True))
            db.commit()
    def test_disconnect_sets_status(self, db):
        _org(db, org_id=1)
        db.add(StripeConnectedAccount(organization_id=1, environment=IntegrationEnvironment.TEST, connected_account_id="acct_xyz", status=IntegrationConnectionStatus.ACTIVE, charges_enabled=True, payouts_enabled=True, details_submitted=True))
        db.commit()
        row = StripeConnectService(db).disconnect(organization_id=1, updated_by=1)
        assert row.status == IntegrationConnectionStatus.DISCONNECTED
    def test_onboarding_url_raises_without_client_id(self, db):
        from app.core.exceptions import BadRequestException
        _org(db, org_id=1)
        with patch("app.modules.billing.services.stripe_connect_service.settings") as s:
            s.STRIPE_CONNECT_CLIENT_ID = ""; s.STRIPE_SECRET_KEY = "sk_test_x"
            with pytest.raises(BadRequestException, match="not configured"):
                StripeConnectService(db).get_onboarding_url(1, "https://example.com/cb")
    def test_onboarding_url_contains_client_id(self, db):
        _org(db, org_id=1)
        with patch("app.modules.billing.services.stripe_connect_service.settings") as s:
            s.STRIPE_CONNECT_CLIENT_ID = "ca_test_123"; s.STRIPE_SECRET_KEY = "sk_test_x"
            result = StripeConnectService(db).get_onboarding_url(1, "https://example.com/cb")
        assert "ca_test_123" in result["url"]
    def test_account_id_unique_across_orgs(self, db):
        from sqlalchemy.exc import IntegrityError
        _org(db, org_id=1); _org(db, org_id=2, name="B")
        db.add(StripeConnectedAccount(organization_id=1, environment=IntegrationEnvironment.TEST, connected_account_id="acct_shared", status=IntegrationConnectionStatus.ACTIVE, charges_enabled=True, payouts_enabled=True, details_submitted=True))
        db.commit()
        with pytest.raises(IntegrityError):
            db.add(StripeConnectedAccount(organization_id=2, environment=IntegrationEnvironment.TEST, connected_account_id="acct_shared", status=IntegrationConnectionStatus.ACTIVE, charges_enabled=True, payouts_enabled=True, details_submitted=True))
            db.commit()

class TestStripeCustomerMapping:
    def test_ensure_customer_creates(self, db):
        _org(db, org_id=1); _connect(db, org_id=1); cust = _customer(db, org_id=1, cust_id=1)
        mock_c = MagicMock(); mock_c.id = "cus_test_abc"
        with patch("app.modules.billing.services.stripe_service._stripe_module") as mm:
            ms = MagicMock(); ms.Customer.retrieve.side_effect = Exception("nf"); ms.Customer.create.return_value = mock_c; mm.return_value = ms
            StripeService(db).ensure_customer(organization_id=1, customer_id=1)
            # GAP-1: customer creation must execute in the tenant's connected account
            assert ms.Customer.create.call_args.kwargs.get("stripe_account") == "acct_test_A"
        db.refresh(cust); assert cust.stripe_customer_id == "cus_test_abc"
    def test_ensure_customer_reuses_existing(self, db):
        _org(db, org_id=1); _connect(db, org_id=1); cust = _customer(db, org_id=1, cust_id=1)
        cust.stripe_customer_id = "cus_existing"; db.commit()
        with patch("app.modules.billing.services.stripe_service._stripe_module") as mm:
            ms = MagicMock(); ms.Customer.retrieve.return_value = MagicMock(id="cus_existing"); mm.return_value = ms
            result = StripeService(db).ensure_customer(organization_id=1, customer_id=1)
            assert ms.Customer.retrieve.call_args.kwargs.get("stripe_account") == "acct_test_A"
        ms.Customer.create.assert_not_called(); assert result.stripe_customer_id == "cus_existing"
    def test_ensure_customer_requires_connection(self, db):
        from app.core.exceptions import BadRequestException
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        with patch("app.modules.billing.services.stripe_service._stripe_module") as mm:
            with pytest.raises(BadRequestException, match="not connected"):
                StripeService(db).ensure_customer(organization_id=1, customer_id=1)
        mm.assert_not_called()
    def test_ensure_customer_wrong_org_raises(self, db):
        _org(db, org_id=1); _org(db, org_id=2, name="B"); _customer(db, org_id=2, cust_id=10)
        with pytest.raises(Exception):
            StripeService(db).ensure_customer(organization_id=1, customer_id=10)

class TestInvoicePaymentFlow:
    def test_checkout_completed_records_payment_and_allocates(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        inv = _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0)
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            StripeService(db)._handle_checkout_session_completed({"id":"cs1","payment_status":"paid","payment_intent":"pi_001","metadata":{"organization_id":"1","invoice_id":"1"}}, organization_id=1)
        db.refresh(inv); payments = db.query(Payment).filter_by(organization_id=1).all()
        assert len(payments) == 1 and payments[0].status == PaymentStatus.CLEARED
        assert db.query(PaymentAllocation).filter_by(payment_id=payments[0].id).count() == 1
        assert inv.status == InvoiceStatus.PAID
    def test_checkout_completed_idempotent(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1); _invoice(db, org_id=1, customer_id=1, inv_id=1, total=50.0)
        evt = {"id":"cs2","payment_status":"paid","payment_intent":"pi_002","metadata":{"organization_id":"1","invoice_id":"1"}}
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            svc = StripeService(db); svc._handle_checkout_session_completed(evt, organization_id=1); svc._handle_checkout_session_completed(evt, organization_id=1)
        assert db.query(Payment).filter_by(organization_id=1).count() == 1
    def test_checkout_missing_org_rejected(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1); _invoice(db, org_id=1, customer_id=1, inv_id=1)
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            result = StripeService(db)._handle_checkout_session_completed({"id":"cs3","payment_status":"paid","payment_intent":"pi_003","metadata":{"invoice_id":"1"}}, organization_id=None)
        assert result["action"] == "ignored" and db.query(Payment).count() == 0
    def test_payment_intent_failed_marks_failed(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, status=PaymentStatus.PROCESSING, intent_id="pi_fail")
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            result = StripeService(db)._handle_payment_intent_payment_failed({"id":"pi_fail","last_payment_error":{"message":"declined","code":"declined"}}, organization_id=1)
        db.refresh(p); assert p.status == PaymentStatus.FAILED and result["action"] == "payment_failed"

class TestIdempotency:
    def test_payment_idempotency_key(self, db):
        from datetime import date
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1); svc = PaymentService(db)
        for _ in range(3):
            svc.record_payment(organization_id=1, customer_id=1, payment_number="PAY-IDEM-001", amount=Decimal("50"), payment_date=date.today(), created_by=1, idempotency_key="idem-001", payment_type=PaymentType.INVOICE_PAYMENT, status=PaymentStatus.CLEARED, currency="USD")
        assert db.query(Payment).filter_by(organization_id=1).count() == 1
    def test_refund_idempotency_key(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1); _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0)
        svc = RefundService(db)
        r1 = svc.create_refund(organization_id=1, created_by=1, customer_id=1, refund_number="RF-001", refund_type="FULL", amount=Decimal("100"), payment_id=1, refund_source="payment", refund_method="card_refund", currency="USD", idempotency_key="idem-ref-001")
        r2 = svc.create_refund(organization_id=1, created_by=1, customer_id=1, refund_number="RF-DIFF", refund_type="FULL", amount=Decimal("100"), payment_id=1, refund_source="payment", refund_method="card_refund", currency="USD", idempotency_key="idem-ref-001")
        assert r1.id == r2.id
    def test_stripe_event_dedup(self, db):
        _org(db, org_id=1)
        db.add(StripeEvent(event_id="evt_dedup", event_type="payment_intent.succeeded", organization_id=1, status="processed", payload={})); db.commit()
        with patch("app.modules.billing.services.stripe_service.settings") as s:
            s.STRIPE_WEBHOOK_SECRET = "whsec_test"; s.STRIPE_SECRET_KEY = "sk_test_x"
            ms = MagicMock(); me = MagicMock(); me.to_dict.return_value = {"id":"evt_dedup","type":"payment_intent.succeeded","data":{"object":{}}}; ms.Webhook.construct_event.return_value = me
            with patch("app.modules.billing.services.stripe_service._stripe_module", return_value=ms):
                result = StripeService(db).handle_webhook(b"{}", "t=1,v1=sig")
        assert result.get("idempotent") is True

class TestWebhookSecurity:
    def test_invalid_signature_raises(self, db):
        from app.core.exceptions import BadRequestException
        with patch("app.modules.billing.services.stripe_service.settings") as s:
            s.STRIPE_WEBHOOK_SECRET = "whsec_secret"; s.STRIPE_SECRET_KEY = "sk_test_x"
            ms = MagicMock(); ms.Webhook.construct_event.side_effect = Exception("bad sig")
            with patch("app.modules.billing.services.stripe_service._stripe_module", return_value=ms):
                with pytest.raises(BadRequestException, match="Invalid Stripe webhook signature"):
                    StripeService(db).handle_webhook(b'{}', "t=1,v1=badsig")
    def test_missing_webhook_secret_raises(self, db):
        from app.core.exceptions import BadRequestException
        with patch("app.modules.billing.services.stripe_service.settings") as s:
            s.STRIPE_WEBHOOK_SECRET = ""
            with pytest.raises(BadRequestException, match="not configured"):
                StripeService(db).handle_webhook(b'{}', "t=1,v1=sig")
    def test_unknown_event_safely_recorded(self, db):
        _org(db, org_id=1)
        mock_event = {"id":"evt_unk","type":"some.future.event","data":{"object":{"metadata":{"organization_id":"1"}}}}
        with patch("app.modules.billing.services.stripe_service.settings") as s:
            s.STRIPE_WEBHOOK_SECRET = "whsec_test"; s.STRIPE_SECRET_KEY = "sk_test_x"; s.STRIPE_CURRENCY_DEFAULT = "usd"; s.STRIPE_PAYMENT_METHOD_TYPES = "card"; s.STRIPE_BILLING_ADDRESS_COLLECTION = "auto"
            ms = MagicMock(); me = MagicMock(); me.to_dict.return_value = mock_event; ms.Webhook.construct_event.return_value = me
            with patch("app.modules.billing.services.stripe_service._stripe_module", return_value=ms):
                result = StripeService(db).handle_webhook(b"{}", "t=1,v1=sig")
        assert result["status"] == "processed" and db.query(StripeEvent).filter_by(event_id="evt_unk").count() == 1
    def test_forged_org_cannot_pay_other_tenant_invoice(self, db):
        _org(db, org_id=1); _org(db, org_id=2, name="Victim"); _customer(db, org_id=2, cust_id=10); _invoice(db, org_id=2, customer_id=10, inv_id=10, total=500.0)
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            result = StripeService(db)._handle_checkout_session_completed({"id":"cs_forged","payment_status":"paid","payment_intent":"pi_forged","metadata":{"organization_id":"1","invoice_id":"10"}}, organization_id=1)
        assert result["action"] == "ignored" and db.query(Payment).filter_by(organization_id=2).count() == 0

class TestRefundAllocatedPayment:
    def test_reverse_allocations_flips_payment_to_refunded(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        inv = _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0)
        _allocation(db, p, inv)
        db.add(Refund(organization_id=1, customer_id=1, payment_id=1, refund_number="RF-AUTO", refund_type=RefundType.FULL, refund_source=RefundSource.PAYMENT, refund_method=RefundMethod.CARD_REFUND, status=RefundStatus.COMPLETED, amount=Decimal("100"), currency="USD"))
        db.commit()
        result = PaymentService(db).reverse_allocations_for_refund(1, 1, Decimal("100"))
        db.refresh(p); db.refresh(inv)
        assert result.status == PaymentStatus.REFUNDED
        assert inv.status == InvoiceStatus.REFUNDED
        assert db.query(PaymentAllocation).filter_by(payment_id=1).count() == 0
    def test_refund_webhook_reverses_allocation(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        inv = _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, intent_id="pi_ref", charge_id="ch_ref")
        _allocation(db, p, inv)
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            StripeService(db)._handle_charge_refunded({"id":"ch_ref","payment_intent":"pi_ref","refunds":{"data":[{"id":"re_001","status":"succeeded","payment_intent":"pi_ref","amount":10000}]}}, organization_id=1)
        db.refresh(p); assert p.status == PaymentStatus.REFUNDED and db.query(Refund).filter_by(payment_id=p.id).count() == 1
    def test_duplicate_gateway_refund_idempotent(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        inv = _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, intent_id="pi_dup", charge_id="ch_dup")
        _allocation(db, p, inv); cd = {"id":"ch_dup","payment_intent":"pi_dup","refunds":{"data":[{"id":"re_dup","status":"succeeded","payment_intent":"pi_dup","amount":10000}]}}
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            svc = StripeService(db); svc._handle_charge_refunded(cd, 1); svc._handle_charge_refunded(cd, 1)
        assert db.query(Refund).filter_by(gateway_refund_id="re_dup").count() == 1

class TestDisputes:
    def test_dispute_model_persists(self, db):
        _org(db, org_id=1)
        db.add(Dispute(organization_id=1, gateway_dispute_id="dp_001", gateway_charge_id="ch_001", amount=Decimal("100"), currency="USD", status=DisputeStatus.NEEDS_RESPONSE, reason="fraudulent"))
        db.commit()
        assert db.query(Dispute).filter_by(gateway_dispute_id="dp_001").first() is not None
    def test_dispute_created_records(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, charge_id="ch_disp")
        result = StripeService(db)._handle_dispute_event({"id":"dp_disp","charge":"ch_disp","amount":10000,"currency":"usd","status":"needs_response","reason":"fraudulent","evidence_details":{}}, organization_id=1)
        assert result["action"] == "dispute_recorded"
        d = db.query(Dispute).filter_by(gateway_dispute_id="dp_disp").first()
        assert d.payment_id == p.id; db.refresh(p); assert p.status == PaymentStatus.CLEARED
    def test_dispute_updated_upserts(self, db):
        _org(db, org_id=1)
        db.add(Dispute(organization_id=1, gateway_dispute_id="dp_upsert", amount=Decimal("50"), currency="USD", status=DisputeStatus.NEEDS_RESPONSE)); db.commit()
        result = StripeService(db)._handle_dispute_event({"id":"dp_upsert","charge":None,"amount":5000,"currency":"usd","status":"under_review","evidence_details":{}}, organization_id=1)
        assert result["action"] == "dispute_updated" and db.query(Dispute).filter_by(gateway_dispute_id="dp_upsert").count() == 1
    def test_dispute_won_sets_closed_at(self, db):
        _org(db, org_id=1)
        db.add(Dispute(organization_id=1, gateway_dispute_id="dp_won", amount=Decimal("75"), currency="USD", status=DisputeStatus.UNDER_REVIEW)); db.commit()
        StripeService(db)._handle_dispute_event({"id":"dp_won","charge":None,"amount":7500,"currency":"usd","status":"won","evidence_details":{}}, organization_id=1)
        d = db.query(Dispute).filter_by(gateway_dispute_id="dp_won").first()
        assert d.status == DisputeStatus.WON and d.closed_at is not None
    def test_dispute_unique_constraint(self, db):
        from sqlalchemy.exc import IntegrityError
        _org(db, org_id=1)
        db.add(Dispute(organization_id=1, gateway_dispute_id="dp_dup", amount=Decimal("10"), currency="USD", status=DisputeStatus.NEEDS_RESPONSE)); db.commit()
        with pytest.raises(IntegrityError):
            db.add(Dispute(organization_id=1, gateway_dispute_id="dp_dup", amount=Decimal("10"), currency="USD", status=DisputeStatus.NEEDS_RESPONSE)); db.commit()

class TestCurrencySafety:
    def test_unsupported_currency_raises(self, db):
        from app.core.exceptions import BadRequestException
        with pytest.raises(BadRequestException): StripeService._resolve_and_validate_currency("XYZ")
    def test_allocation_currency_mismatch_rejected(self, db):
        from app.core.exceptions import BadRequestException
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0, currency="EUR")
        _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, currency="USD")
        with pytest.raises((BadRequestException, Exception)):
            PaymentService(db).allocate_payment(payment_id=1, organization_id=1, invoice_id=1, amount=Decimal("100"), created_by=1)

class TestTenantIsolation:
    def test_org1_cannot_pay_org2_invoice(self, db):
        _org(db, org_id=1); _org(db, org_id=2, name="B"); _customer(db, org_id=2, cust_id=2); _invoice(db, org_id=2, customer_id=2, inv_id=2, total=200.0)
        with patch("app.modules.billing.services.stripe_service._stripe_module"):
            result = StripeService(db)._handle_checkout_session_completed({"id":"cs_idor","payment_status":"paid","payment_intent":"pi_idor","metadata":{"organization_id":"1","invoice_id":"2"}}, organization_id=1)
        assert result["action"] == "ignored" and db.query(Payment).filter_by(organization_id=2).count() == 0
    def test_get_payment_wrong_org_raises(self, db):
        _org(db, org_id=1); _org(db, org_id=2, name="B"); _customer(db, org_id=2, cust_id=2); _payment(db, org_id=2, customer_id=2, pay_id=2, amount=200.0)
        with pytest.raises(Exception): PaymentService(db).get_payment(payment_id=2, organization_id=1)
    def test_dispute_resolves_org_from_payment_not_metadata(self, db):
        _org(db, org_id=1); _org(db, org_id=2, name="B"); _customer(db, org_id=2, cust_id=2)
        _payment(db, org_id=2, customer_id=2, pay_id=2, charge_id="ch_tenant_b")
        StripeService(db)._handle_dispute_event({"id":"dp_iso","charge":"ch_tenant_b","amount":5000,"currency":"usd","status":"needs_response","evidence_details":{}}, organization_id=1)
        d = db.query(Dispute).filter_by(gateway_dispute_id="dp_iso").first()
        assert d is not None and d.organization_id == 2





