"""
Part 2 — ZB-COM §5.2 trial->paid conversion tests.

Covers the mandated verification surface for the self-serve conversion:
  1. state machine: CONVERTED marker in TRIALING/TRIAL_RECOVERY transitions,
     CONVERTED -> ACTIVE, illegal CONVERTED entries blocked
  2. complete_trial_conversion() — genuine CONVERTED -> ACTIVE sequence,
     converted_at stamped, entitlement snapshot recomputed to plan
     entitlements, SUBSCRIPTION_TRIAL_CONVERTED audit row, usage counters
     untouched; non-trial subscriptions rejected
  3. prepare_trial_conversion() — checkout route (Stripe configured),
     invoice_due route (Stripe not configured), assisted_quote route
     (quote-only plan / unresolvable price); never invents pricing
  4. Stripe webhook: first cleared payment on TRIALING / TRIAL_RECOVERY
     completes the conversion; PENDING/SUSPENDED keeps plain activation
  5. manual-invoicing path: allocating a payment that pays off the
     conversion invoice completes the conversion
  6. ZB-COM-015 confirmation email is dispatched post-commit and failure is
     isolated

No TestClient precedent exists anywhere in tests/ — services, router
functions and webhook handlers are invoked directly against the isolated
in-memory SQLite fixture, per the established convention.
"""
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest

from app.modules.auth.models import User, UserRole
from app.modules.commercial.enums import (
    BillingClassification,
    BillingSource,
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
    PlatformPaymentStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialSubscription,
    PlatformInvoice,
    PlatformPayment,
)
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.commercial.trial_conversion_service import (
    TrialConversionService,
    notify_trial_converted_after_commit,
)
from app.modules.super_admin.models import PlatformAuditAction
from tests.conftest import make_organization


def _chargeable_org(db, code="CVT1", name="Convert Co"):
    org = make_organization(db, code=code, name=name)
    org.billing_classification = BillingClassification.COMMERCIAL_STANDALONE
    org.billing_source = BillingSource.REGISTERED_VIA_STANDALONE
    db.flush()
    return org


def _plan(db, code, *, price=Decimal("49.00"), quote_only=False, currency="USD"):
    plan = CommercialPlanService(db).create_plan(
        plan_code=code,
        plan_name=f"{code} Plan",
        billing_interval=CommercialBillingInterval.MONTHLY,
        currency=currency,
        price_amount=price,
        is_quote_only=quote_only,
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db.commit()
    return plan


def _admin(db, org_id, email="admin@convert.co"):
    user = User(
        email=email,
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=org_id,
        first_name="Ada",
        last_name="Admin",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _trial_setup(db, *, status=CommercialSubscriptionStatus.TRIALING, plan=None, code="CVT1", email=None):
    plan = plan or _plan(db, f"{code}P")
    org = _chargeable_org(db, code=code)
    user = _admin(db, org.id, email=email or f"admin@{code.lower()}.co")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    sub = CommercialSubscription(
        commercial_account_id=account.id,
        commercial_plan_id=plan.id,
        status=status,
        trial_ends_at=datetime.utcnow() + timedelta(days=10),
        recovery_ends_at=datetime.utcnow() + timedelta(days=24),
    )
    db.add(sub)
    db.commit()
    return org, user, account, plan, sub


def _latest_audit(db, action: PlatformAuditAction):
    from app.modules.super_admin.models import PlatformAuditLog

    return (
        db.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == action)
        .order_by(PlatformAuditLog.id.desc())
        .first()
    )


# ── 1. State machine ─────────────────────────────────────────────────────────

def test_trialing_and_recovery_may_enter_converted(db_session):
    _, _, _, _, sub = _trial_setup(db_session, code="SM1")
    svc = CommercialSubscriptionService(db_session)
    svc.transition(sub, CommercialSubscriptionStatus.CONVERTED)
    svc.transition(sub, CommercialSubscriptionStatus.ACTIVE)
    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    db_session.commit()

    # TRIAL_RECOVERY -> CONVERTED is also legal (recovery-window conversion).
    _, _, _, _, sub2 = _trial_setup(
        db_session, status=CommercialSubscriptionStatus.TRIAL_RECOVERY, code="SM2",
    )
    svc.transition(sub2, CommercialSubscriptionStatus.CONVERTED)
    assert sub2.status == CommercialSubscriptionStatus.CONVERTED


def test_illegal_converted_entries_blocked(db_session):
    _, user, account, plan, sub = _trial_setup(db_session, code="SM3")
    # Move the trial sub to ACTIVE first — ACTIVE -> CONVERTED is illegal.
    svc = CommercialSubscriptionService(db_session)
    svc.transition(sub, CommercialSubscriptionStatus.ACTIVE)
    with pytest.raises(ValueError):
        svc.transition(sub, CommercialSubscriptionStatus.CONVERTED)
    db_session.rollback()

    # PENDING -> CONVERTED is also illegal.
    pending = CommercialSubscription(
        commercial_account_id=account.id,
        commercial_plan_id=plan.id,
        status=CommercialSubscriptionStatus.PENDING,
    )
    db_session.add(pending)
    db_session.flush()
    with pytest.raises(ValueError):
        svc.transition(pending, CommercialSubscriptionStatus.CONVERTED)
    db_session.rollback()


# ── 2. complete_trial_conversion ─────────────────────────────────────────────

def test_complete_conversion_trialing_marks_active_and_snapshot(db_session):
    org, user, account, plan, sub = _trial_setup(db_session, code="CV1")
    assert sub.status == CommercialSubscriptionStatus.TRIALING
    from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService

    sub2 = TrialConversionService(db_session).complete_trial_conversion(
        subscription=sub, actor_id=user.id,
    )
    db_session.commit()

    assert sub2.status == CommercialSubscriptionStatus.ACTIVE
    assert sub2.converted_at is not None
    snap = EntitlementSnapshotService(db_session).get_snapshot(org.id)
    assert snap.commercial_subscription_id == sub.id
    assert snap.computed_reason == "subscription_transition:active"
    entry = _latest_audit(db_session, PlatformAuditAction.SUBSCRIPTION_TRIAL_CONVERTED)
    assert entry is not None
    assert entry.entity_id == sub.id
    assert entry.organization_id == org.id


def test_complete_conversion_from_recovery(db_session):
    _, user, _, _, sub = _trial_setup(
        db_session, status=CommercialSubscriptionStatus.TRIAL_RECOVERY, code="CV2",
    )
    result = TrialConversionService(db_session).complete_trial_conversion(
        subscription=sub, actor_id=user.id,
    )
    db_session.commit()
    assert result.status == CommercialSubscriptionStatus.ACTIVE
    assert result.converted_at is not None


def test_complete_conversion_idempotent_when_already_converted(db_session):
    _, user, _, _, sub = _trial_setup(db_session, code="CV3")
    svc = TrialConversionService(db_session)
    svc.complete_trial_conversion(subscription=sub, actor_id=user.id)
    db_session.commit()
    again = svc.complete_trial_conversion(subscription=sub, actor_id=user.id)
    assert again.status == CommercialSubscriptionStatus.ACTIVE


def test_complete_conversion_rejects_non_trial_states(db_session):
    _, user, account, plan, sub = _trial_setup(db_session, code="CV4")
    # Move straight to plain activation (non-conversion path) -> no conversion.
    from app.modules.commercial.service import CommercialSubscriptionService

    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db_session.commit()
    with pytest.raises(ValueError):
        TrialConversionService(db_session).complete_trial_conversion(
            subscription=sub, actor_id=user.id,
        )
    db_session.rollback()

    suspended = CommercialSubscription(
        commercial_account_id=account.id,
        commercial_plan_id=plan.id,
        status=CommercialSubscriptionStatus.SUSPENDED,
    )
    db_session.add(suspended)
    db_session.commit()
    with pytest.raises(ValueError):
        TrialConversionService(db_session).complete_trial_conversion(
            subscription=suspended, actor_id=user.id,
        )
    db_session.rollback()


# ── 3. prepare_trial_conversion routing ──────────────────────────────────────

def test_prepare_routes_to_invoice_due_when_stripe_unavailable(db_session):
    _, user, account, _, sub = _trial_setup(db_session, code="PV1")
    from app.core.exceptions import BadRequestException
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    # Stripe not configured / unpayable -> the BadRequestException from
    # create_checkout_session_for_invoice routes the org to a manual invoice.
    with patch.object(
        PlatformStripeService,
        "create_checkout_session_for_invoice",
        side_effect=BadRequestException("Platform Stripe is not configured"),
    ):
        result = TrialConversionService(db_session).prepare_trial_conversion(
            account=account, subscription=sub, actor_id=user.id,
        )
    db_session.commit()

    assert result["mode"] == "invoice_due"
    assert result["plan_name"] == "PV1P Plan"
    assert result["price_amount"] == "49.00"
    assert result["currency"] == "USD"
    assert result["billing_interval"] == "monthly"
    assert result["public_token"]  # invoice link usable without Stripe
    # Subscription untouched by prepare — payment still pending.
    assert sub.status == CommercialSubscriptionStatus.TRIALING

    invoice = (
        db_session.query(PlatformInvoice)
        .filter(PlatformInvoice.commercial_account_id == account.id)
        .first()
    )
    assert invoice is not None
    assert invoice.status.value == "issued"
    assert invoice.balance_due == Decimal("49.00")
    from app.modules.commercial.models import CommercialQuote

    quote = db_session.query(CommercialQuote).filter(
        CommercialQuote.commercial_account_id == account.id,
    ).first()
    assert quote.status.value == "converted"
    assert quote.commercial_subscription_id == sub.id


def test_prepare_routes_to_checkout_when_stripe_configured(db_session):
    _, user, account, _, sub = _trial_setup(db_session, code="PV2")
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    fake = {"checkout_url": "https://stripe.test/cs_x", "session_id": "cs_test_x"}
    with patch.object(PlatformStripeService, "create_checkout_session_for_invoice", return_value=fake):
        result = TrialConversionService(db_session).prepare_trial_conversion(
            account=account, subscription=sub, actor_id=user.id,
        )
    db_session.commit()
    assert result["mode"] == "checkout"
    assert result["checkout_url"] == fake["checkout_url"]
    assert result["session_id"] == "cs_test_x"


def test_prepare_routes_to_assisted_quote_for_quote_only_plan(db_session):
    plan = _plan(db_session, "PV3P", price=None, quote_only=True)
    _, user, account, _, sub = _trial_setup(db_session, code="PV3", plan=plan)

    with patch("app.services.email_service.send_platform_quote_email", return_value=True):
        result = TrialConversionService(db_session).prepare_trial_conversion(
            account=account, subscription=sub, actor_id=user.id,
        )
    db_session.commit()
    assert result["mode"] == "assisted_quote"
    assert result["quote_number"]
    assert sub.status == CommercialSubscriptionStatus.TRIALING  # untouched


def test_prepare_routes_to_assisted_quote_when_no_price_resolves(db_session):
    plan = _plan(db_session, "PV4P", price=None)
    _, user, account, _, sub = _trial_setup(db_session, code="PV4", plan=plan)

    with patch("app.services.email_service.send_platform_quote_email", return_value=True):
        result = TrialConversionService(db_session).prepare_trial_conversion(
            account=account, subscription=sub, actor_id=user.id,
        )
    db_session.commit()
    assert result["mode"] == "assisted_quote"


# ── 4. Stripe webhook conversion trigger ─────────────────────────────────────

def _conversion_invoice(db, account, sub, user):
    return TrialConversionService(db).prepare_trial_conversion(
        account=account, subscription=sub, actor_id=user.id,
    )


def _pending_payment(db, account, invoice, session_id="cs_test_1"):
    from app.modules.commercial.platform_payment_service import PlatformPaymentService

    payment = PlatformPaymentService(db).record(
        account_id=account.id,
        actor_id=None,
        amount=invoice.balance_due,
        currency=invoice.currency,
        payment_method="card",
        notes=f"Checkout for invoice {invoice.invoice_number}",
    )
    payment.gateway_checkout_session_id = session_id
    db.flush()
    return payment


def test_webhook_trialing_first_payment_converts(db_session):
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    org, user, account, _, sub = _trial_setup(db_session, code="WH1")
    _conversion_invoice(db_session, account, sub, user)
    invoice = db_session.query(PlatformInvoice).filter(
        PlatformInvoice.commercial_account_id == account.id,
    ).first()
    _pending_payment(db_session, account, invoice)
    db_session.commit()

    svc = PlatformStripeService(db_session)
    result = svc._handle_checkout_completed({
        "id": "cs_test_1",
        "payment_intent": "pi_test_1",
        "metadata": {"platform_invoice_id": str(invoice.id)},
    })
    db_session.commit()

    assert result["trial_converted"] == sub.id
    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    assert sub.converted_at is not None
    assert invoice.balance_due == 0
    assert invoice.paid_amount == invoice.total_amount


def test_webhook_recovery_payment_converts(db_session):
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    _, user, account, _, sub = _trial_setup(
        db_session, status=CommercialSubscriptionStatus.TRIAL_RECOVERY, code="WH2",
    )
    _conversion_invoice(db_session, account, sub, user)
    invoice = db_session.query(PlatformInvoice).filter(
        PlatformInvoice.commercial_account_id == account.id,
    ).first()
    _pending_payment(db_session, account, invoice, session_id="cs_test_2")
    db_session.commit()

    result = PlatformStripeService(db_session)._handle_checkout_completed({
        "id": "cs_test_2",
        "payment_intent": "pi_test_2",
        "metadata": {"platform_invoice_id": str(invoice.id)},
    })
    db_session.commit()
    assert result["trial_converted"] == sub.id
    assert sub.status == CommercialSubscriptionStatus.ACTIVE


def test_webhook_pending_subscription_plain_activation(db_session):
    from app.modules.commercial.platform_payment_service import PlatformPaymentService
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    # Build a fresh account with ONLY a PENDING subscription (no trial row).
    plan = _plan(db_session, "WH3P")
    org = _chargeable_org(db_session, code="WH3")
    user = _admin(db_session, org.id, email="admin@wh3.co")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    pending = CommercialSubscription(
        commercial_account_id=account.id,
        commercial_plan_id=plan.id,
        status=CommercialSubscriptionStatus.PENDING,
    )
    db_session.add(pending)
    db_session.flush()
    payment = PlatformPaymentService(db_session).record(
        account_id=account.id,
        actor_id=None,
        amount=Decimal("49.00"),
        currency="USD",
        payment_method="card",
        notes="First payment",
    )
    payment.gateway_checkout_session_id = "cs_plain_1"
    db_session.commit()

    result = PlatformStripeService(db_session)._handle_checkout_completed({
        "id": "cs_plain_1",
    })
    db_session.commit()
    assert "trial_converted" not in result
    assert pending.status == CommercialSubscriptionStatus.ACTIVE
    assert pending.converted_at is None


def test_webhook_converts_when_not_first_cleared_payment(db_session):
    """§5.2 invoice-linkage hardening: an account that already has a cleared
    payment (manual record, earlier invoice) must STILL auto-convert on the
    Stripe payment of its conversion invoice. The old `cleared_count == 1`
    gate alone would leave the subscription TRIALING forever."""
    from app.modules.commercial.platform_payment_service import PlatformPaymentService
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    _, user, account, _, sub = _trial_setup(db_session, code="WH4")
    _conversion_invoice(db_session, account, sub, user)
    invoice = db_session.query(PlatformInvoice).filter(
        PlatformInvoice.commercial_account_id == account.id,
    ).first()

    # A prior cleared payment NOT tied to the conversion checkout — this makes
    # the conversion payment the account's SECOND cleared payment.
    prior = PlatformPaymentService(db_session).record(
        account_id=account.id,
        actor_id=user.id,
        amount=Decimal("5.00"),
        currency="USD",
        payment_method="wire_transfer",  # clears immediately
        notes="Unrelated earlier payment",
    )
    assert prior.status == PlatformPaymentStatus.CLEARED
    _pending_payment(db_session, account, invoice, session_id="cs_test_wh4")
    db_session.commit()

    result = PlatformStripeService(db_session)._handle_checkout_completed({
        "id": "cs_test_wh4",
        "payment_intent": "pi_test_wh4",
        "metadata": {"platform_invoice_id": str(invoice.id)},
    })
    db_session.commit()

    assert result["trial_converted"] == sub.id
    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    assert sub.converted_at is not None
    assert invoice.balance_due == 0


# ── 5. Manual-invoicing path (allocation drives conversion) ──────────────────

def test_allocate_payment_triggers_conversion(db_session):
    from app.modules.commercial.commercial_billing_router import (
        _maybe_complete_trial_conversion_on_allocation,
    )
    from app.modules.commercial.platform_payment_service import PlatformPaymentService

    _, user, account, _, sub = _trial_setup(db_session, code="ALL1")
    _conversion_invoice(db_session, account, sub, user)
    invoice = db_session.query(PlatformInvoice).filter(
        PlatformInvoice.commercial_account_id == account.id,
    ).first()
    payment = PlatformPaymentService(db_session).record(
        account_id=account.id,
        actor_id=user.id,
        amount=invoice.balance_due,
        currency=invoice.currency,
        payment_method="wire_transfer",  # clears immediately
        notes="Manual conversion payment",
    )
    db_session.commit()
    PlatformPaymentService(db_session).allocate(
        payment_id=payment.id, invoice_id=invoice.id,
        amount=invoice.balance_due, actor_id=user.id,
    )
    db_session.commit()

    converted_id = _maybe_complete_trial_conversion_on_allocation(
        db_session, invoice.id, user.id,
    )
    db_session.commit()
    assert converted_id == sub.id
    assert sub.status == CommercialSubscriptionStatus.ACTIVE
    assert sub.converted_at is not None
    assert invoice.balance_due == 0


def test_allocate_partial_payment_skips_conversion(db_session):
    from app.modules.commercial.commercial_billing_router import (
        _maybe_complete_trial_conversion_on_allocation,
    )
    from app.modules.commercial.platform_payment_service import PlatformPaymentService

    _, user, account, _, sub = _trial_setup(db_session, code="ALL2")
    _conversion_invoice(db_session, account, sub, user)
    invoice = db_session.query(PlatformInvoice).filter(
        PlatformInvoice.commercial_account_id == account.id,
    ).first()
    payment = PlatformPaymentService(db_session).record(
        account_id=account.id,
        actor_id=user.id,
        amount=invoice.balance_due,
        currency=invoice.currency,
        payment_method="wire_transfer",
    )
    db_session.commit()
    PlatformPaymentService(db_session).allocate(
        payment_id=payment.id, invoice_id=invoice.id,
        amount=Decimal("10.00"), actor_id=user.id,
    )
    db_session.commit()

    converted_id = _maybe_complete_trial_conversion_on_allocation(
        db_session, invoice.id, user.id,
    )
    db_session.commit()
    assert converted_id is None
    assert sub.status == CommercialSubscriptionStatus.TRIALING  # untouched


# ── 6. ZB-COM-015 confirmation email ─────────────────────────────────────────

def test_dispatches_converted_email_once(db_session):
    _, _, account, plan, sub = _trial_setup(db_session, code="EM1")
    sub.converted_at = datetime.utcnow()
    db_session.flush()
    from app.services.email_service import send_trial_converted_email

    with patch("app.services.email_service.send_trial_converted_email") as mock_send:
        mock_send.return_value = True
        notify_trial_converted_after_commit(db_session, sub)

    assert mock_send.call_count == 1
    kwargs = mock_send.call_args[1]
    assert kwargs["email"] == "admin@em1.co"
    assert kwargs["plan_name"] == "EM1P Plan"
    assert kwargs["organization_id"] == account.organization_id


def test_converted_email_failure_is_isolated(db_session):
    _, _, _, _, sub = _trial_setup(db_session, code="EM2")
    sub.converted_at = datetime.utcnow()
    db_session.flush()
    from app.services.email_service import send_trial_converted_email

    with patch("app.services.email_service.send_trial_converted_email") as mock_send:
        mock_send.side_effect = RuntimeError("smtp down")
        notify_trial_converted_after_commit(db_session, sub)  # must not raise
    assert mock_send.call_count == 1


# ── 7. Org-scoped resolution ─────────────────────────────────────────────────

def test_resolve_org_subscription_only_returns_trial_states(db_session):
    _, user, account, plan, sub = _trial_setup(db_session, code="RS1")

    acct, resolved = TrialConversionService(db_session).resolve_org_subscription(
        organization_id=account.organization_id,
    )
    assert resolved.id == sub.id

    # ACTIVE is no longer convertible.
    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db_session.commit()
    _, resolved = TrialConversionService(db_session).resolve_org_subscription(
        organization_id=account.organization_id,
    )
    assert resolved is None


# ── 8. Registration initial quote for TRIALING orgs (§B4 fix) ────────────────


def test_registration_trialing_org_creates_initial_quote(db_session):
    """Fresh (trial-eligible) orgs provisioned TRIALING must STILL get a
    first-period quote — the old PENDING-only gate left them without a
    quote and therefore without an invoice path."""
    from unittest.mock import patch as _patch

    from app.modules.auth.schemas import RegisterRequest
    from app.modules.auth.service import register_enterprise
    from app.modules.commercial.models import CommercialQuote
    from app.modules.commercial.enums import CommercialQuoteStatus

    _plan(db_session, "essentials", price=Decimal("39.00"))

    with _patch("app.services.email_service.send_platform_quote_email", return_value=True):
        register_enterprise(
            db_session,
            RegisterRequest(
                organization="Initial Quote Co",
                name="Ada Admin",
                email="admin@iq1.co",
                password="StrongPass123!",
                currency="USD",
                intended_plan="essentials",
            ),
        )
    db_session.commit()

    sub = (
        db_session.query(CommercialSubscription)
        .join(CommercialAccount)
        .filter(CommercialAccount.organization_id ==
                db_session.query(User).filter_by(email="admin@iq1.co").first().organization_id)
        .first()
    )
    assert sub.status == CommercialSubscriptionStatus.TRIALING

    quote = (
        db_session.query(CommercialQuote)
        .filter(CommercialQuote.commercial_subscription_id == sub.id)
        .first()
    )
    assert quote is not None
    assert quote.status == CommercialQuoteStatus.SENT
    assert len(quote.items) == 1
    assert quote.items[0].unit_price == Decimal("39.00")


def test_registration_trialing_quote_acceptance_generates_invoice(db_session):
    """Accepting the registration initial quote on a TRIALING subscription
    produces a PlatformInvoice — the full end-to-end billing path."""
    from unittest.mock import patch as _patch

    from app.modules.auth.schemas import RegisterRequest
    from app.modules.auth.service import register_enterprise
    from app.modules.commercial.commercial_billing_router import _convert_and_invoice_accepted_quote
    from app.modules.commercial.enums import CommercialQuoteStatus
    from app.modules.commercial.models import CommercialQuote
    from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
    from app.modules.commercial.quote_service import CommercialQuoteService

    _plan(db_session, "essentials", price=Decimal("39.00"))

    with _patch("app.services.email_service.send_platform_quote_email", return_value=True):
        register_enterprise(
            db_session,
            RegisterRequest(
                organization="Accept Quote Co",
                name="Ada Admin",
                email="admin@iq2.co",
                password="StrongPass123!",
                currency="USD",
                intended_plan="essentials",
            ),
        )
    db_session.commit()

    admin = db_session.query(User).filter_by(email="admin@iq2.co").first()
    account = (
        db_session.query(CommercialAccount)
        .filter_by(organization_id=admin.organization_id)
        .first()
    )
    sub = (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account.id)
        .first()
    )
    quote = (
        db_session.query(CommercialQuote)
        .filter_by(commercial_subscription_id=sub.id)
        .first()
    )
    assert quote.status == CommercialQuoteStatus.SENT

    quote_svc = CommercialQuoteService(db_session)
    quote = quote_svc.accept_public_quote(quote.public_token)
    db_session.commit()

    with _patch.object(PlatformInvoiceService, "send", return_value=None):
        _convert_and_invoice_accepted_quote(db_session, quote, admin.id)
    db_session.commit()

    invoice = (
        db_session.query(PlatformInvoice)
        .filter(PlatformInvoice.commercial_subscription_id == sub.id)
        .first()
    )
    assert invoice is not None
    assert invoice.status.value == "issued"
    assert invoice.balance_due == Decimal("39.00")
    assert quote.status == CommercialQuoteStatus.CONVERTED


def test_trial_convert_reuses_registration_quote_no_duplicate(db_session):
    """When a registration initial quote already exists (SENT), clicking
    the in-app 'Convert to paid' banner reuses that quote and its invoice
    rather than creating a second first-period bill."""
    from unittest.mock import patch as _patch

    from app.core.exceptions import BadRequestException
    from app.modules.auth.schemas import RegisterRequest
    from app.modules.auth.service import register_enterprise
    from app.modules.commercial.models import CommercialQuote
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    _plan(db_session, "essentials", price=Decimal("49.00"))

    with _patch("app.services.email_service.send_platform_quote_email", return_value=True):
        register_enterprise(
            db_session,
            RegisterRequest(
                organization="Dedup Co",
                name="Ada Admin",
                email="admin@dedup1.co",
                password="StrongPass123!",
                currency="USD",
                intended_plan="essentials",
            ),
        )
    db_session.commit()

    admin = db_session.query(User).filter_by(email="admin@dedup1.co").first()
    account = (
        db_session.query(CommercialAccount)
        .filter_by(organization_id=admin.organization_id)
        .first()
    )
    sub = (
        db_session.query(CommercialSubscription)
        .filter_by(commercial_account_id=account.id)
        .first()
    )

    quotes_before = (
        db_session.query(CommercialQuote)
        .filter(CommercialQuote.commercial_subscription_id == sub.id)
        .count()
    )
    assert quotes_before == 1

    with _patch.object(
        PlatformStripeService,
        "create_checkout_session_for_invoice",
        side_effect=BadRequestException("Stripe not configured"),
    ):
        result = TrialConversionService(db_session).prepare_trial_conversion(
            account=account, subscription=sub, actor_id=admin.id,
        )
    db_session.commit()

    assert result["mode"] == "invoice_due"

    quotes_after = (
        db_session.query(CommercialQuote)
        .filter(CommercialQuote.commercial_subscription_id == sub.id)
        .count()
    )
    assert quotes_after == 1  # reuses registration quote, no duplicate

    invoices = (
        db_session.query(PlatformInvoice)
        .filter(PlatformInvoice.commercial_subscription_id == sub.id)
        .all()
    )
    assert len(invoices) == 1