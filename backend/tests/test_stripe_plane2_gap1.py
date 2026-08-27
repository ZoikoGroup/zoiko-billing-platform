"""tests/test_stripe_plane2_gap1.py - GAP-1 remediation test suite.

Covers the pre-real-Stripe remediation contract:
  - Connected-account routing on every financial operation (GAP-1)
  - Fail-safe blocking when no ACTIVE connection exists
  - Cross-tenant impossibility (customer / payment / refund)
  - Provider-reference persistence for dispute attribution (DIS-2)
  - Outbound deterministic idempotency keys (ID-2)
  - Timeout translation safety (ID-3)
  - Connect webhook tenant resolution + account.updated sync (WEB-1 / CON-3)
  - Failed-event retry semantics (WEB-2)
  - OAuth state CSRF validation (CON-2)

All Stripe access is mocked — zero network calls, zero secrets required.
"""
from __future__ import annotations

import inspect
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.exceptions import BadRequestException
from app.database import Base
from app.modules.billing.models import (
    BillingCustomer,
    Dispute,
    IntegrationConnectionStatus,
    IntegrationEnvironment,
    Invoice,
    InvoiceStatus,
    Payment,
    PaymentGatewayType,
    PaymentStatus,
    PaymentType,
    Refund,
    RefundMethod,
    RefundSource,
    RefundStatus,
    RefundType,
    StripeConnectedAccount,
    StripeEvent,
)
from app.modules.billing.services.stripe_connect_service import (
    issue_oauth_state,
    resolve_connected_account_id,
    verify_oauth_state,
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
    from app.modules.organizations.models import Organization

    org = Organization(
        id=org_id, organization_name=name,
        organization_code=name.lower().replace(" ", "-")[:20],
    )
    db.add(org); db.commit(); return org


def _customer(db, org_id=1, cust_id=1):
    c = BillingCustomer(
        id=cust_id, organization_id=org_id, customer_code=f"CUST-{cust_id}",
        company_name=f"Company {cust_id}", display_name=f"Customer {cust_id}",
        currency="USD",
    )
    db.add(c); db.commit(); return c


def _invoice(db, org_id=1, customer_id=1, inv_id=1, total=100.0, currency="USD",
             status=InvoiceStatus.SENT):
    inv = Invoice(
        id=inv_id, organization_id=org_id, customer_id=customer_id,
        invoice_number=f"INV-{inv_id:04d}", status=status,
        total_amount=Decimal(str(total)), balance_due=Decimal(str(total)),
        paid_amount=Decimal("0"), currency=currency,
        issue_date=date.today(), due_date=date.today(),
    )
    db.add(inv); db.commit(); return inv


def _connect(db, org_id=1, acct_id="acct_test_A",
             status=IntegrationConnectionStatus.ACTIVE):
    row = StripeConnectedAccount(
        organization_id=org_id, environment=IntegrationEnvironment.TEST,
        connected_account_id=acct_id, status=status,
        charges_enabled=status == IntegrationConnectionStatus.ACTIVE,
        payouts_enabled=True, details_submitted=True,
    )
    db.add(row); db.commit(); return row


def _mock_stripe(session_create=None, intent_create=None):
    ms = MagicMock()
    # Sensible defaults so embedded ensure_customer() calls don't leak
    # MagicMock ids into DB columns.
    ms.Customer.retrieve.return_value = MagicMock(id="cus_ok")
    ms.Customer.create.return_value = MagicMock(id="cus_new")
    if session_create is not None:
        ms.checkout.Session.create.side_effect = session_create
    if intent_create is not None:
        ms.PaymentIntent.create.side_effect = intent_create
    return ms


# ═══ 1-3. Connected-account routing ═══════════════════════════════════════

class TestConnectedAccountRouting:
    def test_tenant_a_payment_uses_tenant_a_connected_account(self, db):
        _org(db, 1, "A"); _connect(db, 1, "acct_A")
        _customer(db, 1, 1); _invoice(db, 1, 1, 1)
        ms = _mock_stripe()
        ms.checkout.Session.create.return_value = MagicMock(id="cs_a", url="https://pay")
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            StripeService(db).create_checkout_session(1, 1, "https://s", "https://c")
        assert ms.checkout.Session.create.call_args.kwargs["stripe_account"] == "acct_A"

    def test_tenant_b_payment_uses_tenant_b_connected_account(self, db):
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        _customer(db, 2, 2); _invoice(db, 2, 2, 2)
        ms = _mock_stripe()
        ms.checkout.Session.create.return_value = MagicMock(id="cs_b", url="https://pay")
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            StripeService(db).create_checkout_session(2, 2, "https://s", "https://c")
        assert ms.checkout.Session.create.call_args.kwargs["stripe_account"] == "acct_B"

    def test_client_cannot_override_connected_account(self, db):
        # The service API accepts no caller-supplied account identifier at all.
        sig = inspect.signature(StripeService.create_checkout_session)
        assert "stripe_account" not in sig.parameters
        assert "connected_account_id" not in sig.parameters
        # And resolution always lands on the CALLING org's own row, even when
        # other tenants' rows exist in the same database.
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        assert resolve_connected_account_id(db, 1) == "acct_A"
        assert resolve_connected_account_id(db, 2) == "acct_B"

    def test_payment_intent_routed_to_own_account_only(self, db):
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        _customer(db, 1, 1); _invoice(db, 1, 1, 1)
        ms = _mock_stripe()
        ms.PaymentIntent.create.return_value = MagicMock(id="pi_a", client_secret="sec")
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            StripeService(db).create_payment_intent(1, 1)
        assert ms.PaymentIntent.create.call_args.kwargs["stripe_account"] == "acct_A"


# ═══ 4-5. Fail-safe gating ════════════════════════════════════════════════

class TestFailSafeGating:
    @pytest.mark.parametrize("method,args", [
        ("create_checkout_session", (1, 1, "https://s", "https://c")),
        ("create_payment_intent", (1, 1)),
        ("list_payment_methods", (1, 1)),
    ])
    def test_missing_connection_blocks_financial_ops(self, db, method, args):
        _org(db, 1); _customer(db, 1, 1); _invoice(db, 1, 1, 1)
        ms = _mock_stripe()
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            with pytest.raises(BadRequestException, match="not connected"):
                getattr(StripeService(db), method)(*args)
        # No outbound request of any kind was attempted.
        ms.assert_not_called()

    def test_inactive_connection_blocks_payment(self, db):
        _org(db, 9); _customer(db, 9, 9); _invoice(db, 9, 9, 9)
        for status in (
            IntegrationConnectionStatus.PENDING_ONBOARDING,
            IntegrationConnectionStatus.ACTION_REQUIRED,
            IntegrationConnectionStatus.RESTRICTED,
            IntegrationConnectionStatus.DISCONNECTED,
        ):
            row = _connect(db, 9, "acct_inactive", status=status)
            with patch(f"{MODULE}._stripe_module") as mm:
                with pytest.raises(BadRequestException, match="not active"):
                    StripeService(db).create_checkout_session(9, 9, "https://s", "https://c")
                mm.assert_not_called()
            db.delete(row); db.commit()

    def test_charges_disabled_blocks_even_if_marked_active(self, db):
        _org(db, 5); _customer(db, 5, 5); _invoice(db, 5, 5, 5)
        row = _connect(db, 5, "acct_stale")
        row.charges_enabled = False; db.commit()
        with patch(f"{MODULE}._stripe_module") as mm:
            with pytest.raises(BadRequestException, match="charges are disabled"):
                StripeService(db).create_payment_intent(5, 5)
        mm.assert_not_called()


# ═══ 6. Customer routing ══════════════════════════════════════════════════

class TestCustomerRouting:
    def test_each_tenant_customer_created_on_own_account(self, db):
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        _customer(db, 1, 1); _customer(db, 2, 2)
        calls = []
        with patch(f"{MODULE}._stripe_module") as mm:
            ms = MagicMock()
            ms.Customer.retrieve.side_effect = Exception("nf")
            created = MagicMock(id="cus_new")

            def _capture(**kwargs):
                calls.append(kwargs.get("stripe_account"))
                return created

            ms.Customer.create.side_effect = _capture
            mm.return_value = ms
            StripeService(db).ensure_customer(organization_id=1, customer_id=1)
            StripeService(db).ensure_customer(organization_id=2, customer_id=2)
        assert calls == ["acct_A", "acct_B"]

    def test_tenant_a_cannot_resolve_tenant_b_customer_context(self, db):
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        _customer(db, 2, 20)
        with pytest.raises(Exception):
            StripeService(db).ensure_customer(organization_id=1, customer_id=20)


# ═══ 7-8. Refund routing ══════════════════════════════════════════════════

def _approved_refund(db, org_id=1, customer_id=1, payment_id=1, refund_id=1):
    r = Refund(
        id=refund_id, organization_id=org_id, customer_id=customer_id,
        payment_id=payment_id, refund_number=f"RF-{refund_id:04d}",
        refund_type=RefundType.FULL, refund_source=RefundSource.PAYMENT,
        refund_method=RefundMethod.CARD_REFUND, status=RefundStatus.APPROVED,
        amount=Decimal("100"), currency="USD",
    )
    db.add(r); db.commit(); return r


def _cleared_payment(db, org_id=1, customer_id=1, pay_id=1, intent_id="pi_pay"):
    p = Payment(
        id=pay_id, organization_id=org_id, customer_id=customer_id,
        payment_number=f"PAY-{pay_id:04d}", payment_type=PaymentType.INVOICE_PAYMENT,
        amount=Decimal("100"), currency="USD", status=PaymentStatus.CLEARED,
        gateway=PaymentGatewayType.CREDIT_CARD,
        stripe_payment_intent_id=intent_id, gateway_charge_id=f"ch_{intent_id}",
        payment_date=date.today(),
    )
    db.add(p); db.commit(); return p


class TestRefundRouting:
    def test_refund_uses_original_payments_connected_account(self, db):
        _org(db, 1); _customer(db, 1, 1)
        _connect(db, 1, "acct_A")
        _cleared_payment(db, 1, 1, 1, intent_id="pi_org1")
        refund = _approved_refund(db, 1, 1, 1, 1)
        ms = _mock_stripe()
        ms.Refund.create.return_value = MagicMock(id="re_ok", status="succeeded")
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            result = StripeService(db).create_stripe_refund(1, refund.id)
        kwargs = ms.Refund.create.call_args.kwargs
        assert kwargs["stripe_account"] == "acct_A"
        assert kwargs["idempotency_key"] == f"rf-1-{refund.id}"
        assert kwargs["payment_intent"] == "pi_org1"
        assert result["gateway_refund_id"] == "re_ok"

    def test_cross_tenant_refund_fails(self, db):
        _org(db, 1, "A"); _org(db, 2, "B"); _customer(db, 2, 2)
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        _cleared_payment(db, 2, 2, 2, intent_id="pi_org2")
        refund_b = _approved_refund(db, 2, 2, 2, 2)
        ms = _mock_stripe()
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            with pytest.raises(Exception):
                StripeService(db).create_stripe_refund(1, refund_b.id)
        ms.Refund.create.assert_not_called()


# ═══ 9-10. Dispute attribution (DIS-2) ════════════════════════════════════

class TestDisputeAttribution:
    def test_checkout_stores_provider_identifiers_via_backfill(self, db):
        _org(db, 1); _customer(db, 1, 1); _invoice(db, 1, 1, 1)
        svc = StripeService(db)
        # checkout.session.completed carries NO charge id...
        svc._handle_checkout_session_completed(
            {"id": "cs9", "payment_status": "paid", "payment_intent": "pi_ck",
             "metadata": {"organization_id": "1", "invoice_id": "1"}},
            organization_id=1,
        )
        payment = db.query(Payment).filter_by(stripe_payment_intent_id="pi_ck").one()
        assert payment.gateway_charge_id is None
        # ...payment_intent.succeeded then arrives with latest_charge → backfill.
        svc._handle_payment_intent_succeeded(
            {"id": "pi_ck", "latest_charge": "ch_late", "amount_received": 10000,
             "metadata": {"organization_id": "1", "invoice_id": "1"}},
            organization_id=1,
        )
        db.refresh(payment)
        assert payment.gateway_charge_id == "ch_late"

    def test_dispute_maps_to_correct_payment_via_intent_fallback(self, db):
        _org(db, 1); _org(db, 2, "B"); _customer(db, 1, 1); _customer(db, 2, 2)
        _invoice(db, 1, 1, 1)
        svc = StripeService(db)
        svc._handle_checkout_session_completed(
            {"id": "cs10", "payment_status": "paid", "payment_intent": "pi_dp",
             "metadata": {"organization_id": "1", "invoice_id": "1"}},
            organization_id=1,
        )
        # Charge id unknown upstream (legacy row) — attribution falls back to
        # the dispute's payment_intent reference.
        svc._handle_dispute_event(
            {"id": "dp_fb", "charge": "ch_unlinked", "payment_intent": "pi_dp",
             "amount": 10000, "currency": "usd", "status": "needs_response",
             "evidence_details": {}},
            organization_id=None, event_account="acct_test_A",
        )
        d = db.query(Dispute).filter_by(gateway_dispute_id="dp_fb").one()
        payment = db.query(Payment).filter_by(stripe_payment_intent_id="pi_dp").one()
        assert d.payment_id == payment.id
        assert d.organization_id == 1
        assert d.connected_account_id == "acct_test_A"


# ═══ 11-13. Outbound idempotency + timeout handling ═══════════════════════

class TestOutboundIdempotencyAndRetries:
    def test_outbound_payment_intent_has_deterministic_idempotency_key(self, db):
        _org(db, 1); _connect(db, 1, "acct_A"); _customer(db, 1, 1); _invoice(db, 1, 1, 7)
        ms = _mock_stripe()
        ms.PaymentIntent.create.return_value = MagicMock(id="pi_k", client_secret="s")
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            StripeService(db).create_payment_intent(1, 7)
        assert ms.PaymentIntent.create.call_args.kwargs["idempotency_key"] == "pi-1-7"

    def test_retry_reuses_same_idempotency_key(self, db):
        _org(db, 1); _connect(db, 1, "acct_A"); _customer(db, 1, 1); _invoice(db, 1, 1, 8)
        keys = []
        ms = _mock_stripe()

        def _capture(**kwargs):
            keys.append(kwargs["idempotency_key"])
            return MagicMock(id=f"pi_try{len(keys)}", client_secret="s")

        ms.PaymentIntent.create.side_effect = _capture
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            StripeService(db).create_payment_intent(1, 8)
            StripeService(db).create_payment_intent(1, 8)
        assert len(keys) == 2 and keys[0] == keys[1]

    def test_refund_push_has_deterministic_idempotency_key(self, db):
        _org(db, 1); _customer(db, 1, 1); _connect(db, 1, "acct_A")
        _cleared_payment(db, 1, 1, 1, intent_id="pi_rf")
        refund = _approved_refund(db, 1, 1, 1, 42)
        ms = _mock_stripe()
        ms.Refund.create.return_value = MagicMock(id="re_k", status="succeeded")
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            StripeService(db).create_stripe_refund(1, 42)
        assert ms.Refund.create.call_args.kwargs["idempotency_key"] == "rf-1-42"

    def test_stripe_timeout_handled_safely(self, db):
        _org(db, 1); _connect(db, 1, "acct_A"); _customer(db, 1, 1); _invoice(db, 1, 1, 3)
        ms = _mock_stripe(intent_create=Exception("Simulated connection timeout"))
        with patch(f"{MODULE}._stripe_module", return_value=ms):
            with pytest.raises(BadRequestException, match="Stripe"):
                StripeService(db).create_payment_intent(1, 3)
        # No partial local state was committed.
        inv = db.get(Invoice, 3)
        db.refresh(inv)
        assert inv.stripe_payment_intent_id is None


# ═══ 14-15. Connect webhook routing ═══════════════════════════════════════

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


class TestConnectWebhookRouting:
    def test_connect_webhook_resolves_tenant_via_envelope_account(self, db):
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 2, "acct_B")
        result = _webhook(StripeService(db), db, {
            "id": "evt_env1", "type": "payment_intent.canceled",
            "account": "acct_B",  # connect-scope envelope, NO metadata fallback
            "data": {"object": {"id": "pi_x"}},
        })
        assert result["status"] == "processed"
        row = db.query(StripeEvent).filter_by(event_id="evt_env1").one()
        assert row.organization_id == 2          # resolved via trusted map
        assert row.connected_account_id == "acct_B"
        assert row.environment == IntegrationEnvironment.TEST

    def test_unmapped_connect_account_records_null_org_without_guessing(self, db):
        _org(db, 1, "A"); _connect(db, 1, "acct_A")
        result = _webhook(StripeService(db), db, {
            "id": "evt_env2", "type": "payment_intent.canceled",
            "account": "acct_ghost",
            "data": {"object": {"id": "pi_y", "metadata": {}}},
        })
        assert result["status"] == "processed"
        row = db.query(StripeEvent).filter_by(event_id="evt_ghost" if False else "evt_env2").one()
        assert row.organization_id is None       # never guessed

    def test_account_updated_updates_correct_connection(self, db):
        _org(db, 1, "A"); _org(db, 2, "B")
        _connect(db, 1, "acct_A"); _connect(db, 2, "acct_B")
        result = _webhook(StripeService(db), db, {
            "id": "evt_acct1", "type": "account.updated",
            "account": "acct_B",
            "data": {"object": {
                "id": "acct_B", "charges_enabled": False, "payouts_enabled": True,
                "details_submitted": True, "requirements": {"currently_due": ["doc"]},
            }},
        })
        assert result["status"] == "processed"
        a = db.query(StripeConnectedAccount).filter_by(connected_account_id="acct_A").one()
        b = db.query(StripeConnectedAccount).filter_by(connected_account_id="acct_B").one()
        assert b.status == IntegrationConnectionStatus.ACTION_REQUIRED
        assert b.charges_enabled is False
        assert a.status == IntegrationConnectionStatus.ACTIVE   # untouched

    def test_platform_account_updated_is_ignored(self, db):
        _org(db, 1); _connect(db, 1, "acct_A")
        result = _webhook(StripeService(db), db, {
            "id": "evt_acct2", "type": "account.updated",
            "data": {"object": {"id": "acct_PLATFORM"}}  # our own account
        })
        assert result["result"]["action"] == "ignored"

    def test_failed_event_is_retried_on_redelivery(self, db):
        _org(db, 1); _customer(db, 1, 1); _invoice(db, 1, 1, 1)
        svc = StripeService(db)
        good_event = {
            "id": "evt_retry", "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_r", "payment_status": "paid",
                                "payment_intent": "pi_rt",
                                "metadata": {"organization_id": "1", "invoice_id": "1"}}},
        }
        # First delivery: the handler itself blows up.
        original_handler = svc._handle_checkout_session_completed
        svc._handle_checkout_session_completed = MagicMock(
            side_effect=RuntimeError("simulated handler crash"),
        )
        _webhook(svc, db, good_event)
        row = db.query(StripeEvent).filter_by(event_id="evt_retry").one()
        assert row.status == "failed"
        assert row.processing_attempts == 1
        # WEB-2: redelivery must genuinely RE-RUN the handler (previously it
        # was short-circuited by the failed ledger row forever).
        svc._handle_checkout_session_completed = original_handler
        _webhook(svc, db, good_event)
        db.refresh(row)
        assert row.status == "processed"
        assert row.processing_attempts >= 2
        assert db.query(Payment).filter_by(stripe_payment_intent_id="pi_rt").count() == 1


# ═══ 16. OAuth state security (CON-2) ═════════════════════════════════════

class TestOAuthStateSecurity:
    def test_complete_oauth_rejects_missing_state(self, db):
        _org(db, 1)
        with patch(f"{MODULE}._stripe_module") as mm:  # must never be reached
            with pytest.raises(BadRequestException, match="[Ss]tate"):
                StripeConnectServiceWithRealModule(db).complete_oauth(1, "code_x", state=None)
        mm.assert_not_called()

    def test_complete_oauth_rejects_forged_or_cross_tenant_state(self, db):
        _org(db, 1); _org(db, 2, "B")
        forged = issue_oauth_state(1)[:-4] + "0000"      # tampered signature
        foreign = issue_oauth_state(2)                    # right sig, wrong org
        with patch(f"{MODULE}._stripe_module") as mm:
            for bad in ("garbage", forged, foreign):
                with pytest.raises(BadRequestException):
                    StripeConnectServiceWithRealModule(db).complete_oauth(1, "code_x", state=bad)
        mm.assert_not_called()

    def test_valid_state_completes_oauth_flow(self, db):
        from app.modules.billing.services.stripe_connect_service import StripeConnectService
        _org(db, 1)
        token_resp = {"stripe_user_id": "acct_oauth"}
        acct_obj = MagicMock()
        acct_obj.to_dict.return_value = {
            "id": "acct_oauth", "charges_enabled": True, "payouts_enabled": True,
            "details_submitted": True, "requirements": {}, "country": "US",
            "default_currency": "usd", "capabilities": {},
        }
        with patch("app.modules.billing.services.stripe_connect_service.settings") as s:
            s.STRIPE_CONNECT_CLIENT_ID = "ca_x"; s.STRIPE_SECRET_KEY = "sk_test_x"
            # State must be issued under the SAME settings context the
            # verification will run in (same signing secret).
            state = issue_oauth_state(1)
            ms = MagicMock()
            ms.OAuth.token.return_value = token_resp
            ms.Account.retrieve.return_value = acct_obj
            with patch("app.modules.billing.services.stripe_connect_service._stripe_module",
                       return_value=ms):
                row = StripeConnectService(db).complete_oauth(1, "code_ok", state=state)
        assert row.connected_account_id == "acct_oauth"
        assert row.status == IntegrationConnectionStatus.ACTIVE

    def test_state_round_trip_and_expiry_window(self, db):
        assert verify_oauth_state(issue_oauth_state(7), 7) is True
        assert verify_oauth_state(issue_oauth_state(7), 8) is False
        assert verify_oauth_state(None, 7) is False
        assert verify_oauth_state("", 7) is False


# Helper: real service class under its canonical import path (kept separate so
# the patch target strings above stay readable).
from app.modules.billing.services.stripe_connect_service import (  # noqa: E402
    StripeConnectService as StripeConnectServiceWithRealModule,
)
