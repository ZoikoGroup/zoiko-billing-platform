"""tests/test_stripe_public_checkout_e2e.py
-------------------------------------------
Comprehensive end-to-end tests for both Plane 1 (SaaS platform billing)
and Plane 2 (tenant-to-customer billing) Stripe public checkout & invoice flows.
"""
from decimal import Decimal
from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer, Invoice, InvoiceStatus,
    IntegrationConnectionStatus, IntegrationEnvironment,
    StripeConnectedAccount,
)
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.commercial.models import (
    CommercialAccount, PlatformInvoice,
)
from app.modules.commercial.enums import (
    CommercialAccountStatus, PlatformInvoiceStatus, PlatformPaymentStatus,
    PlatformInvoicePaymentStatus,
)
from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
from app.modules.commercial.platform_stripe_service import PlatformStripeService


@pytest.fixture(autouse=True)
def configure_stripe_keys(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "STRIPE_PUBLISHABLE_KEY", "pk_test_sample_key")
    monkeypatch.setattr(settings, "PLATFORM_STRIPE_SECRET_KEY", "sk_test_sample_key")
    monkeypatch.setattr(settings, "PLATFORM_STRIPE_WEBHOOK_SECRET", "whsec_sample_key")


@pytest.fixture(scope="function")
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()
    Base.metadata.drop_all(engine)


def _seed_plane2_data(db, org_id=1, has_connect=False):
    from datetime import date
    org = Organization(id=org_id, organization_name="Acme Corp", organization_code=f"acme-{org_id}")
    db.add(org)

    cust = BillingCustomer(
        id=org_id * 10,
        organization_id=org_id,
        customer_code=f"CUST-{org_id}",
        company_name="Buyer LLC",
        display_name="Buyer Customer",
        currency="USD",
    )
    db.add(cust)

    inv = Invoice(
        id=org_id * 100,
        organization_id=org_id,
        customer_id=cust.id,
        invoice_number=f"INV-{org_id:04d}",
        status=InvoiceStatus.SENT,
        total_amount=Decimal("150.00"),
        balance_due=Decimal("150.00"),
        paid_amount=Decimal("0.00"),
        currency="USD",
        issue_date=date.today(),
        due_date=date.today(),
    )
    db.add(inv)

    if has_connect:
        connect = StripeConnectedAccount(
            organization_id=org_id,
            environment=IntegrationEnvironment.TEST,
            connected_account_id=f"acct_test_{org_id}",
            status=IntegrationConnectionStatus.ACTIVE,
            charges_enabled=True,
            payouts_enabled=True,
            details_submitted=True,
        )
        db.add(connect)

    db.commit()
    return org, cust, inv


class TestPlane2PublicInvoiceStripe:
    def test_public_invoice_view_unconfigured_when_no_connect(self, db):
        org, cust, inv = _seed_plane2_data(db, org_id=1, has_connect=False)
        svc = InvoiceService(db)
        token = svc._public_invoice_token(inv.id)

        view = svc.get_public_invoice(token)
        assert view["id"] == inv.id
        assert view["invoice_number"] == inv.invoice_number
        assert view["payment"]["stripe"]["configured"] is False
        assert view["payment"]["stripe"]["publishable_key"] is None

    def test_public_invoice_view_configured_when_connect_active(self, db):
        org, cust, inv = _seed_plane2_data(db, org_id=2, has_connect=True)
        svc = InvoiceService(db)
        token = svc._public_invoice_token(inv.id)

        view = svc.get_public_invoice(token)
        assert view["id"] == inv.id
        assert view["payment"]["stripe"]["configured"] is True
        assert view["payment"]["stripe"]["publishable_key"] is not None

    def test_public_checkout_graceful_response_when_no_connect(self, db):
        org, cust, inv = _seed_plane2_data(db, org_id=3, has_connect=False)
        svc = InvoiceService(db)
        token = svc._public_invoice_token(inv.id)

        result = svc.create_public_checkout_session(
            token=token,
            success_url="https://app.zoikobilling.com/success",
            cancel_url="https://app.zoikobilling.com/cancel",
        )
        assert result["configured"] is False
        assert result["checkout_url"] is None
        assert "not enabled yet for this merchant" in result["message"]

    @patch("stripe.Customer.create")
    @patch("stripe.checkout.Session.create")
    def test_public_checkout_succeeds_when_connect_active(self, mock_session_create, mock_cust_create, db):
        mock_cust_create.return_value = MagicMock(id="cus_test_999")
        mock_session_create.return_value = MagicMock(
            id="cs_test_session_123",
            url="https://checkout.stripe.com/pay/cs_test_session_123",
        )

        org, cust, inv = _seed_plane2_data(db, org_id=4, has_connect=True)
        svc = InvoiceService(db)
        token = svc._public_invoice_token(inv.id)

        result = svc.create_public_checkout_session(
            token=token,
            success_url="https://app.zoikobilling.com/success",
            cancel_url="https://app.zoikobilling.com/cancel",
        )
        assert result["configured"] is True
        assert result["checkout_url"] == "https://checkout.stripe.com/pay/cs_test_session_123"
        assert result["session_id"] == "cs_test_session_123"

        # Verify stripe_account parameter was passed to ensure Plane 2 isolation
        mock_session_create.assert_called_once()
        assert mock_session_create.call_args.kwargs.get("stripe_account") == "acct_test_4"


class TestPlane1PlatformInvoiceStripe:
    @patch("stripe.Customer.create")
    @patch("stripe.checkout.Session.create")
    def test_plane1_checkout_and_webhook_settlement(self, mock_session_create, mock_cust_create, db):
        from datetime import date
        org = Organization(id=10, organization_name="Tenant Ten", organization_code="tenant-ten")
        db.add(org)

        account = CommercialAccount(
            id=10,
            organization_id=org.id,
            status=CommercialAccountStatus.ACTIVE,
        )
        db.add(account)

        pinv = PlatformInvoice(
            id=50,
            commercial_account_id=account.id,
            invoice_number="PINV-0050",
            status=PlatformInvoiceStatus.ISSUED,
            payment_status=PlatformInvoicePaymentStatus.NONE,
            total_amount=Decimal("299.00"),
            balance_due=Decimal("299.00"),
            paid_amount=Decimal("0.00"),
            currency="USD",
            issue_date=date.today(),
            due_date=date.today(),
            public_token="test_token_pinv_50",
        )
        db.add(pinv)
        db.commit()

        mock_cust_create.return_value = MagicMock(id="cus_platform_10")
        mock_session_create.return_value = MagicMock(
            id="cs_platform_session_50",
            url="https://checkout.stripe.com/pay/cs_platform_session_50",
        )

        stripe_svc = PlatformStripeService(db)
        res = stripe_svc.create_checkout_session_for_invoice(pinv)

        assert res["session_id"] == "cs_platform_session_50"
        assert res["checkout_url"] == "https://checkout.stripe.com/pay/cs_platform_session_50"

        # Webhook processing for checkout.session.completed
        event_payload = {
            "id": "evt_platform_cs_completed_50",
            "type": "checkout.session.completed",
            "livemode": False,
            "data": {
                "object": {
                    "id": "cs_platform_session_50",
                    "payment_status": "paid",
                    "amount_total": 29900,
                    "currency": "usd",
                    "metadata": {"platform_invoice_id": str(pinv.id)},
                }
            },
        }

        with patch("stripe.Webhook.construct_event", return_value=event_payload):
            hook_res = stripe_svc.handle_webhook_event(b"{}", "dummy_sig")
            assert hook_res.get("received") is True

        # Refresh pinv and verify paid status
        db.refresh(pinv)
        assert pinv.payment_status == PlatformInvoicePaymentStatus.FULL
        assert pinv.status == PlatformInvoiceStatus.PAID
        assert pinv.balance_due == Decimal("0.00")
        assert pinv.paid_amount == Decimal("299.00")
