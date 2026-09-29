"""tests/test_stripe_plane2_phase_gaps.py

Test suite for the LAST remaining Plane 2 Stripe Connect gaps (all other
gaps in STRIPE_PLANE2_READINESS_REPORT.md were already remediated and are
covered by test_stripe_plane2.py / test_stripe_plane2_gap1.py):

  - API-1  — stripe.api_version pinned in configure_stripe_runtime()
  - SEC-3  — StripeEvent.correlation_id populated; webhook 500 carries event_id
  - WEB-4  — invoice.paid dedup guard when no PaymentIntent is present
  - DIS-3  — a lost dispute produces a financial adjustment + ops signal
  - WEB-2  — operator-triggered replay of one failed stripe_events row
  - REC-1  — missed-webhook recovery for a MISSING_IN_LEDGER PaymentIntent

All Stripe access is mocked — zero network calls, zero secrets required.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.exceptions import BadRequestException
from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingCustomer,
    Dispute,
    DisputeStatus,
    IntegrationConnectionStatus,
    IntegrationEnvironment,
    Invoice,
    InvoiceStatus,
    Payment,
    PaymentAllocation,
    PaymentGatewayType,
    PaymentStatus,
    PaymentType,
    Refund,
    StripeConnectedAccount,
    StripeEvent,
)
from app.modules.billing.services.stripe_service import StripeService

MODULE = "app.modules.billing.services.stripe_service"


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


def _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0, currency="USD", status=InvoiceStatus.SENT):
    inv = Invoice(id=inv_id, organization_id=org_id, customer_id=customer_id, invoice_number=f"INV-{inv_id:04d}", status=status, total_amount=Decimal(str(total)), balance_due=Decimal(str(total)), paid_amount=Decimal("0"), currency=currency, issue_date=date.today(), due_date=date.today())
    db.add(inv); db.commit(); return inv


def _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, currency="USD", status=PaymentStatus.CLEARED, intent_id=None, charge_id=None):
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
    row = StripeConnectedAccount(
        organization_id=org_id, environment=IntegrationEnvironment.TEST,
        connected_account_id=acct_id, status=status,
        charges_enabled=status == IntegrationConnectionStatus.ACTIVE,
        payouts_enabled=True, details_submitted=True,
    )
    db.add(row); db.commit(); return row


def _webhook(svc, db, event_dict):
    with patch(f"{MODULE}.settings") as s:
        s.STRIPE_WEBHOOK_SECRET = "whsec_test"
        s.STRIPE_SECRET_KEY = "sk_test_x"
        ms = MagicMock()
        me = MagicMock()
        me.to_dict.return_value = event_dict
        ms.Webhook.construct_event.return_value = me
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            return svc.handle_webhook(b"{}", "t=1,v1=sig")


# ═══ API-1 — stripe.api_version pinned ═════════════════════════════════════

class TestApiVersionPinning:
    def test_configure_stripe_runtime_pins_api_version(self):
        from app.modules.billing.services.stripe_connect_service import (
            _PINNED_STRIPE_API_VERSION,
            configure_stripe_runtime,
        )
        fake_stripe = MagicMock()
        fake_stripe.max_network_retries = None
        fake_stripe.default_http_client = MagicMock()  # skip the client-creation branch
        configure_stripe_runtime(fake_stripe)
        assert fake_stripe.api_version == _PINNED_STRIPE_API_VERSION

    def test_pinned_version_matches_installed_sdk_default(self):
        """Regression guard: if the installed stripe SDK's own bundled
        default API version ever changes (a package upgrade), this fails
        loudly instead of silently drifting — bumping the SDK and this pin
        must be one deliberate, joint change (see API-1 comment)."""
        import stripe as real_stripe
        from app.modules.billing.services.stripe_connect_service import _PINNED_STRIPE_API_VERSION
        assert _PINNED_STRIPE_API_VERSION == real_stripe._api_version._ApiVersion.CURRENT

    def test_both_stripe_service_and_connect_service_route_through_one_pin(self):
        """stripe_service.py's own _stripe_module() must call the SAME
        configure_stripe_runtime — no second, independently-drifting copy of
        the api_version pin."""
        import app.modules.billing.services.stripe_service as ss
        with patch(f"{MODULE}.settings") as s:
            s.STRIPE_SECRET_KEY = "sk_test_x"
            with patch(f"{MODULE}.configure_stripe_runtime") as mock_configure:
                with patch("stripe.Customer"):
                    ss._stripe_module()
            mock_configure.assert_called_once()


# ═══ SEC-3 — correlation_id population + operator-lookup on webhook 500 ═══

class TestCorrelationId:
    def test_correlation_id_set_on_new_event(self, db):
        _org(db, org_id=1)
        mock_event = {"id": "evt_corr1", "type": "some.unhandled.event", "data": {"object": {}}}
        result = _webhook(StripeService(db), db, mock_event)
        assert result["status"] == "processed"
        row = db.query(StripeEvent).filter_by(event_id="evt_corr1").one()
        assert row.correlation_id == "evt_corr1"

    def test_finalize_backfills_correlation_id_on_legacy_row(self, db):
        _org(db, org_id=1)
        db.add(StripeEvent(
            event_id="evt_legacy", event_type="payment_intent.canceled",
            organization_id=1, status="processing",
            payload={"id": "evt_legacy", "type": "payment_intent.canceled", "data": {"object": {}}},
            correlation_id=None,
        ))
        db.commit()
        StripeService(db)._finalize_event("evt_legacy", 1, "processed", None, None, "payment_intent.canceled", None)
        row = db.query(StripeEvent).filter_by(event_id="evt_legacy").one()
        assert row.correlation_id == "evt_legacy"

    def test_finalize_event_result_carries_event_id(self, db):
        _org(db, org_id=1)
        db.add(StripeEvent(event_id="evt_fail1", event_type="payment_intent.succeeded", organization_id=1, status="processing", payload={}))
        db.commit()
        result = StripeService(db)._finalize_event("evt_fail1", 1, "failed", None, "raw internal exception text", "payment_intent.succeeded", None)
        assert result["event_id"] == "evt_fail1"

    def test_webhook_router_failure_response_exposes_event_id_not_raw_error(self, db):
        """webhook_router.py must include event_id in the HTTP 500 detail
        (SEC-3's operator-lookup requirement) while never leaking the raw
        internal exception text onto the wire."""
        import asyncio
        from fastapi import HTTPException
        from app.modules.billing.routers.webhook_router import stripe_webhook

        class FakeRequest:
            async def body(self):
                return b"{}"

        with patch("app.modules.billing.routers.webhook_router.StripeService") as MockSvc:
            MockSvc.return_value.handle_webhook.return_value = {
                "received": True, "status": "failed", "type": "payment_intent.succeeded",
                "result": None, "error": "super-secret internal traceback detail",
                "event_id": "evt_wire_test",
            }
            with pytest.raises(HTTPException) as exc_info:
                asyncio.run(stripe_webhook(FakeRequest(), stripe_signature="t=1,v1=sig", db=db))
        assert exc_info.value.status_code == 500
        detail = exc_info.value.detail
        assert detail["event_id"] == "evt_wire_test"
        assert "super-secret" not in str(detail)


# ═══ WEB-4 — invoice.paid dedup guard with no PaymentIntent ═══════════════

class TestInvoicePaidDedupWithoutPaymentIntent:
    def test_redelivered_invoice_paid_without_pi_does_not_duplicate(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=75.0)
        evt = {
            "id": "in_no_pi", "payment_intent": None, "amount_paid": 7500,
            "metadata": {"organization_id": "1", "invoice_id": "1"},
        }
        svc = StripeService(db)
        r1 = svc._handle_invoice_paid(evt, organization_id=1)
        r2 = svc._handle_invoice_paid(evt, organization_id=1)
        assert r1["action"] == "payment_recorded"
        assert r2["payment_id"] == r1["payment_id"]
        payments = db.query(Payment).filter_by(organization_id=1).all()
        assert len(payments) == 1
        assert payments[0].stripe_payment_intent_id is None  # never poisoned with a fake PI value
        assert payments[0].transaction_id == "invpaid-in_no_pi"

    def test_invoice_paid_with_pi_still_dedupes_on_pi(self, db):
        """Existing (already-fixed) behavior must be unchanged: when a real
        PaymentIntent IS present, dedup still keys off it."""
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=30.0)
        evt = {
            "id": "in_with_pi", "payment_intent": "pi_invpaid_1", "amount_paid": 3000,
            "metadata": {"organization_id": "1", "invoice_id": "1"},
        }
        svc = StripeService(db)
        svc._handle_invoice_paid(evt, organization_id=1)
        svc._handle_invoice_paid(evt, organization_id=1)
        payments = db.query(Payment).filter_by(organization_id=1).all()
        assert len(payments) == 1
        assert payments[0].stripe_payment_intent_id == "pi_invpaid_1"

    def test_different_invoice_events_without_pi_each_record_once(self, db):
        """Two DIFFERENT invoice.paid events (no PI) must not collide with
        each other's fallback dedup key."""
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=10.0)
        _invoice(db, org_id=1, customer_id=1, inv_id=2, total=20.0)
        svc = StripeService(db)
        svc._handle_invoice_paid({"id": "in_a", "payment_intent": None, "amount_paid": 1000, "metadata": {"organization_id": "1", "invoice_id": "1"}}, organization_id=1)
        svc._handle_invoice_paid({"id": "in_b", "payment_intent": None, "amount_paid": 2000, "metadata": {"organization_id": "1", "invoice_id": "2"}}, organization_id=1)
        assert db.query(Payment).filter_by(organization_id=1).count() == 2


# ═══ DIS-3 — lost dispute financial adjustment + ops signal ═══════════════

class TestLostDisputeAdjustment:
    def test_transition_into_lost_reverses_allocation_and_opens_attention(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        inv = _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, charge_id="ch_lost")
        _allocation(db, p, inv)
        db.add(Dispute(organization_id=1, payment_id=p.id, gateway_dispute_id="dp_lost", gateway_charge_id="ch_lost", amount=Decimal("100"), currency="USD", status=DisputeStatus.UNDER_REVIEW))
        db.commit()

        result = StripeService(db)._handle_dispute_event(
            {"id": "dp_lost", "charge": "ch_lost", "amount": 10000, "currency": "usd", "status": "lost", "evidence_details": {}},
            organization_id=1,
        )
        assert result["action"] == "dispute_updated" and result["status"] == "lost"

        db.refresh(p); db.refresh(inv)
        assert p.status == PaymentStatus.REFUNDED
        assert inv.status == InvoiceStatus.REFUNDED
        assert db.query(PaymentAllocation).filter_by(payment_id=p.id).count() == 0
        assert db.query(Refund).filter_by(gateway_refund_id="dp_lost").count() == 1

        from app.modules.super_admin.models import AttentionItem
        item = db.query(AttentionItem).filter_by(source_key="stripe_dispute_lost:dp_lost").first()
        assert item is not None
        assert item.organization_id == 1
        assert item.severity.value == "p2"

    def test_redelivered_lost_event_does_not_double_adjust(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        inv = _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, charge_id="ch_lost2")
        _allocation(db, p, inv)
        db.add(Dispute(organization_id=1, payment_id=p.id, gateway_dispute_id="dp_lost2", gateway_charge_id="ch_lost2", amount=Decimal("100"), currency="USD", status=DisputeStatus.UNDER_REVIEW))
        db.commit()

        evt = {"id": "dp_lost2", "charge": "ch_lost2", "amount": 10000, "currency": "usd", "status": "lost", "evidence_details": {}}
        svc = StripeService(db)
        svc._handle_dispute_event(evt, organization_id=1)
        # Re-delivery of the SAME already-LOST dispute event must not adjust twice.
        svc._handle_dispute_event(evt, organization_id=1)

        assert db.query(Refund).filter_by(gateway_refund_id="dp_lost2").count() == 1

    def test_won_after_lost_is_not_treated_as_a_new_lost_transition(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        p = _payment(db, org_id=1, customer_id=1, pay_id=1, amount=100.0, charge_id="ch_wl")
        db.add(Dispute(organization_id=1, payment_id=p.id, gateway_dispute_id="dp_wl", gateway_charge_id="ch_wl", amount=Decimal("100"), currency="USD", status=DisputeStatus.NEEDS_RESPONSE))
        db.commit()
        svc = StripeService(db)
        svc._handle_dispute_event({"id": "dp_wl", "charge": "ch_wl", "amount": 10000, "currency": "usd", "status": "needs_response", "evidence_details": {}}, organization_id=1)
        # never actually transitions to lost in this test — only exercises
        # that non-lost statuses never trigger the adjustment path.
        assert db.query(Refund).filter_by(gateway_refund_id="dp_wl").count() == 0

    def test_lost_dispute_without_matching_payment_only_raises_attention(self, db):
        _org(db, org_id=1)
        db.add(Dispute(organization_id=1, gateway_dispute_id="dp_orphan", gateway_charge_id="ch_missing", amount=Decimal("50"), currency="USD", status=DisputeStatus.NEEDS_RESPONSE))
        db.commit()
        StripeService(db)._handle_dispute_event(
            {"id": "dp_orphan", "charge": "ch_missing", "amount": 5000, "currency": "usd", "status": "lost", "evidence_details": {}},
            organization_id=1,
        )
        assert db.query(Refund).filter_by(gateway_refund_id="dp_orphan").count() == 0
        from app.modules.super_admin.models import AttentionItem
        item = db.query(AttentionItem).filter_by(source_key="stripe_dispute_lost:dp_orphan").first()
        assert item is not None


# ═══ WEB-2 completion — operator-triggered replay of one failed event ═════

class TestManualReplay:
    def test_replay_failed_event_reprocesses_and_records_payment(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=40.0)
        payload = {
            "id": "evt_replay1", "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_replay", "payment_status": "paid", "payment_intent": "pi_replay",
                "metadata": {"organization_id": "1", "invoice_id": "1"},
            }},
        }
        db.add(StripeEvent(event_id="evt_replay1", event_type="checkout.session.completed", organization_id=1, status="failed", payload=payload, processing_attempts=1))
        db.commit()

        with patch(f"{MODULE}._stripe_module"):
            result = StripeService(db).replay_failed_event("evt_replay1", organization_id=1)

        assert result["status"] == "processed"
        assert result["event_id"] == "evt_replay1"
        assert db.query(Payment).filter_by(stripe_payment_intent_id="pi_replay").count() == 1
        row = db.query(StripeEvent).filter_by(event_id="evt_replay1").one()
        assert row.status == "processed"
        assert row.processing_attempts == 2

    def test_replay_refuses_cross_organization(self, db):
        _org(db, org_id=1); _org(db, org_id=2, name="B")
        db.add(StripeEvent(
            event_id="evt_replay2", event_type="payment_intent.succeeded",
            organization_id=1, status="failed",
            payload={"id": "evt_replay2", "type": "payment_intent.succeeded", "data": {"object": {}}},
        ))
        db.commit()
        with pytest.raises(BadRequestException, match="does not belong"):
            StripeService(db).replay_failed_event("evt_replay2", organization_id=2)
        row = db.query(StripeEvent).filter_by(event_id="evt_replay2").one()
        assert row.status == "failed"  # untouched by the refused cross-org attempt

    def test_replay_refuses_non_failed_event(self, db):
        _org(db, org_id=1)
        db.add(StripeEvent(
            event_id="evt_replay3", event_type="payment_intent.succeeded",
            organization_id=1, status="processed",
            payload={"id": "evt_replay3", "type": "payment_intent.succeeded", "data": {"object": {}}},
        ))
        db.commit()
        with pytest.raises(BadRequestException, match="Only a 'failed'"):
            StripeService(db).replay_failed_event("evt_replay3", organization_id=1)

    def test_replay_missing_event_raises(self, db):
        _org(db, org_id=1)
        with pytest.raises(BadRequestException, match="not found"):
            StripeService(db).replay_failed_event("evt_ghost", organization_id=1)


# ═══ REC-1 completion — missed-webhook recovery ═══════════════════════════

class TestRecoverMissingPaymentIntent:
    def test_recover_records_payment_via_shared_handler(self, db):
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=60.0)
        _connect(db, org_id=1, acct_id="acct_recover")
        from app.modules.super_admin.stripe_reconciliation import recover_missing_payment_intent

        fake_intent = MagicMock()
        fake_intent.to_dict.return_value = {
            "id": "pi_recover", "status": "succeeded", "amount_received": 6000,
            "latest_charge": "ch_recover", "payment_method": None,
            "metadata": {"organization_id": "1", "invoice_id": "1"},
        }
        with patch("app.modules.super_admin.stripe_reconciliation._stripe_module") as mm:
            ms = MagicMock(); ms.PaymentIntent.retrieve.return_value = fake_intent; mm.return_value = ms
            result = recover_missing_payment_intent(db, 1, "pi_recover")

        assert ms.PaymentIntent.retrieve.call_args.kwargs.get("stripe_account") == "acct_recover"
        assert result["organization_id"] == 1
        assert result["payment_intent_id"] == "pi_recover"
        assert db.query(Payment).filter_by(stripe_payment_intent_id="pi_recover").count() == 1

    def test_recover_requires_active_connection(self, db):
        _org(db, org_id=1)
        from app.modules.super_admin.stripe_reconciliation import recover_missing_payment_intent
        with pytest.raises(RuntimeError, match="no ACTIVE Stripe connection"):
            recover_missing_payment_intent(db, 1, "pi_missing_conn")

    def test_recover_refuses_non_succeeded_intent(self, db):
        _org(db, org_id=1); _connect(db, org_id=1, acct_id="acct_recover2")
        from app.modules.super_admin.stripe_reconciliation import recover_missing_payment_intent

        fake_intent = MagicMock()
        fake_intent.to_dict.return_value = {"id": "pi_pending", "status": "requires_payment_method"}
        with patch("app.modules.super_admin.stripe_reconciliation._stripe_module") as mm:
            ms = MagicMock(); ms.PaymentIntent.retrieve.return_value = fake_intent; mm.return_value = ms
            with pytest.raises(RuntimeError, match="not 'succeeded'"):
                recover_missing_payment_intent(db, 1, "pi_pending")

    def test_recover_is_idempotent_on_replay(self, db):
        """The recovery handler reuses _handle_payment_intent_succeeded,
        which is itself idempotent — recovering the same PaymentIntent twice
        must not create a second Payment."""
        _org(db, org_id=1); _customer(db, org_id=1, cust_id=1)
        _invoice(db, org_id=1, customer_id=1, inv_id=1, total=15.0)
        _connect(db, org_id=1, acct_id="acct_recover3")
        from app.modules.super_admin.stripe_reconciliation import recover_missing_payment_intent

        fake_intent = MagicMock()
        fake_intent.to_dict.return_value = {
            "id": "pi_recover3", "status": "succeeded", "amount_received": 1500,
            "latest_charge": "ch_recover3", "payment_method": None,
            "metadata": {"organization_id": "1", "invoice_id": "1"},
        }
        with patch("app.modules.super_admin.stripe_reconciliation._stripe_module") as mm:
            ms = MagicMock(); ms.PaymentIntent.retrieve.return_value = fake_intent; mm.return_value = ms
            recover_missing_payment_intent(db, 1, "pi_recover3")
            recover_missing_payment_intent(db, 1, "pi_recover3")

        assert db.query(Payment).filter_by(stripe_payment_intent_id="pi_recover3").count() == 1
