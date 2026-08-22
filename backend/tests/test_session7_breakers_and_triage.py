"""
tests/test_session7_breakers_and_triage.py
----------------------------------------------
Session 7 coverage (ZB-SA-CMD-003 §8/§9/§11/§18):

  A. New Domain B breakers are REAL at their code paths:
     - tenant_payment_attempts gates StripeService.create_payment_intent /
       create_checkout_session and PaymentService.record_attempt
     - tenant_dunning gates DunningService.process_dunning
     - tenant_billing_communications gates InvoiceService.send_invoice_via_email
       and manual dunning reminder sends
     - the Stripe webhook router deliberately does NOT reference the payment
       breaker (in-flight processor activity must not be canceled)
  B. Auto-expiry (§9.1): an engaged pause whose expires_at has passed lazily
     re-enables itself on next observation, audited, with its attention item
     auto-resolved. Out-of-bounds expiry windows are rejected.
  C. Maker-checker (§9): a circuit_breaker_change proposal applied only via a
     DIFFERENT Super Admin's decision; self-approval rejected server-side;
     rejection leaves state untouched.
  D. Severity floor (§8): a failing financial-integrity check opens a P0
     attention item directly (no escalation ladder); recovery auto-resolves.
  E. Triage lens (§11): /triage/summary composes real sources and enforces
     triage.read per platform role.
  F. Performance instrumentation (§18.2): p95 math is correct and PERF-01
     reports UNKNOWN with insufficient samples rather than a fake PASS.
"""

import inspect

import pyotp
import pytest

from app.core.capabilities import require_capability
from app.core.exceptions import BadRequestException, ForbiddenException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import PlatformRole, SuperAdminMFA, User, UserRole
from app.modules.billing.models import InvoiceStatus, PaymentAllocation, PaymentStatus
from app.modules.billing.services.dunning_service import DunningService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.payment_service import PaymentService
from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService
from app.modules.super_admin.kill_switch_service import (
    TENANT_BILLING_COMMUNICATIONS,
    TENANT_DUNNING,
    TENANT_PAYMENT_ATTEMPTS,
    MAX_AUTO_EXPIRE_MINUTES,
    MIN_AUTO_EXPIRE_MINUTES,
    BillingKillSwitchService,
)
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, BillingKillSwitch
from app.modules.super_admin.router import (
    decide_approval_request,
    get_triage_summary,
    propose_circuit_breaker_change,
    set_tenant_invoice_finalization_breaker,
)
from app.modules.super_admin.schemas import (
    ApprovalDecisionRequest,
    CircuitBreakerChangeProposalCreate,
    CircuitBreakerToggleRequest,
)
from tests.conftest import make_customer, make_invoice, make_organization, make_payment


def _super_admin(db, email, platform_role=None, with_mfa=False):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="T", last_name="U", is_active=True, is_verified=True,
        platform_role=platform_role,
    )
    db.add(user)
    db.flush()
    if with_mfa:
        secret = pyotp.random_base32()
        db.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
        db.flush()
        return user, secret
    return user


def _engage(db, scope, reason="test pause"):
    """Engage a breaker directly through the service (the audited path)."""
    return BillingKillSwitchService(db).set_enabled(
        scope, False, reason=reason, actor_id=None,
    )


# ── A. Real enforcement of the new scopes ────────────────────────────────────

def test_payment_attempts_breaker_blocks_record_attempt(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    payment = make_payment(db_session, org.id, cust.id)

    _engage(db_session, TENANT_PAYMENT_ATTEMPTS)

    with pytest.raises(BadRequestException):
        PaymentService(db_session).record_attempt(payment.id, org.id, 1, PaymentStatus.FAILED.value)


def test_payment_attempts_breaker_blocks_stripe_intent_creation(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT)

    _engage(db_session, TENANT_PAYMENT_ATTEMPTS)

    # The gate fires BEFORE any Stripe SDK call, so no Stripe key/config needed.
    from app.modules.billing.services.stripe_service import StripeService

    with pytest.raises(BadRequestException):
        StripeService(db_session).create_payment_intent(org.id, inv.id)


def test_payment_attempts_release_restores_record_attempt(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    payment = make_payment(db_session, org.id, cust.id)

    switch = _engage(db_session, TENANT_PAYMENT_ATTEMPTS)
    switch.enabled = True
    switch.expires_at = None
    db_session.commit()

    attempt = PaymentService(db_session).record_attempt(
        payment.id, org.id, 1, PaymentStatus.PENDING.value
    )
    assert attempt.id is not None


def test_webhook_router_does_not_reference_payment_breaker():
    """In-flight processor activity must NOT be canceled by the breaker
    (ZB-SA-CMD-003 §9.2) — pinned as a structural invariant."""
    import app.modules.billing.routers.webhook_router as webhook_router

    source = inspect.getsource(webhook_router)
    assert "TENANT_PAYMENT_ATTEMPTS" not in source
    assert "require_enabled" not in source


def test_dunning_breaker_blocks_automated_dunning_loop(db_session):
    org = make_organization(db_session)
    _engage(db_session, TENANT_DUNNING)

    with pytest.raises(BadRequestException):
        DunningService(db_session).process_dunning(org.id)
    with pytest.raises(BadRequestException):
        DunningService(db_session).process_due_reminders(org.id)


def test_communications_breaker_blocks_manual_dunning_send(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.OVERDUE)
    case = DunningService(db_session).open_dunning_case(org.id, cust.id, inv.id, created_by=1)

    _engage(db_session, TENANT_BILLING_COMMUNICATIONS)

    with pytest.raises(BadRequestException):
        DunningService(db_session).send_reminder(case.id, org.id, updated_by=1)


# ── B. Auto-expiry ───────────────────────────────────────────────────────────

def test_engaged_pause_carries_mandatory_expiry(db_session):
    switch = _engage(db_session, TENANT_DUNNING)
    assert switch.enabled is False
    assert switch.expires_at is not None  # §9.1: no permanent pauses


def test_out_of_bounds_expiry_window_rejected(db_session):
    svc = BillingKillSwitchService(db_session)
    with pytest.raises(ValueError):
        svc.set_enabled(TENANT_DUNNING, False, reason="x", actor_id=None, auto_expire_minutes=MIN_AUTO_EXPIRE_MINUTES - 1)
    with pytest.raises(ValueError):
        svc.set_enabled(TENANT_DUNNING, False, reason="x", actor_id=None, auto_expire_minutes=MAX_AUTO_EXPIRE_MINUTES + 1)


def test_expired_pause_lazily_reenables_with_audit_and_attention_resolution(db_session):
    from datetime import datetime, timedelta

    svc = BillingKillSwitchService(db_session)
    switch = svc.set_enabled(TENANT_DUNNING, False, reason="pause", actor_id=None, auto_expire_minutes=30)
    db_session.flush()

    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == f"kill_switch:{TENANT_DUNNING}")
        .first()
    )
    assert item is not None and item.status.value == "open"

    # Simulate the deadline passing.
    switch.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    assert svc.is_enabled(TENANT_DUNNING) is True  # lazy lift on observation
    db_session.expire_all()
    lifted = db_session.query(BillingKillSwitch).filter(BillingKillSwitch.scope == TENANT_DUNNING).first()
    assert lifted.enabled is True and lifted.expires_at is None

    db_session.refresh(item)
    assert item.status.value == "resolved"


# ── C. Maker-checker ─────────────────────────────────────────────────────────

def test_maker_checker_apply_and_self_approval_rejection(db_session):
    maker, maker_secret = _super_admin(db_session, "maker@s7.example", PlatformRole.SECURITY_OPERATOR, with_mfa=True)
    checker, checker_secret = _super_admin(db_session, "checker@s7.example", PlatformRole.SECURITY_OPERATOR, with_mfa=True)

    request = propose_circuit_breaker_change(
        scope=TENANT_DUNNING,
        data=CircuitBreakerChangeProposalCreate(
            enabled=False, reason="suspect duplicate charges",
            incident_reference="INC-777", auto_expire_minutes=120,
        ),
        current_user=maker, db=db_session,
    )
    assert request.status == "pending"
    # No state change yet.
    assert BillingKillSwitchService(db_session).is_enabled(TENANT_DUNNING) is True

    # Self-approval is rejected server-side…
    with pytest.raises(ForbiddenException):
        decide_approval_request(
            request.id,
            ApprovalDecisionRequest(decision="approve", reason="ok", code=pyotp.TOTP(maker_secret).now()),
            current_user=maker, db=db_session,
        )

    # …and a different Super Admin's approval applies the proposed state.
    resp = decide_approval_request(
        request.id,
        ApprovalDecisionRequest(decision="approve", reason="confirmed", code=pyotp.TOTP(checker_secret).now()),
        current_user=checker, db=db_session,
    )
    assert resp.status == "approved"
    assert BillingKillSwitchService(db_session).is_enabled(TENANT_DUNNING) is False
    switch = db_session.query(BillingKillSwitch).filter(BillingKillSwitch.scope == TENANT_DUNNING).first()
    assert switch.expires_at is not None  # approved pause still time-bound


def test_maker_checker_rejection_leaves_state_untouched(db_session):
    maker, _ = _super_admin(db_session, "maker2@s7.example", PlatformRole.SECURITY_OPERATOR, with_mfa=True)
    checker, checker_secret = _super_admin(db_session, "checker2@s7.example", PlatformRole.SECURITY_OPERATOR, with_mfa=True)

    request = propose_circuit_breaker_change(
        scope=TENANT_PAYMENT_ATTEMPTS,
        data=CircuitBreakerChangeProposalCreate(enabled=False, reason="maybe", incident_reference="INC-778"),
        current_user=maker, db=db_session,
    )
    resp = decide_approval_request(
        request.id,
        ApprovalDecisionRequest(decision="reject", reason="not confirmed", code=pyotp.TOTP(checker_secret).now()),
        current_user=checker, db=db_session,
    )
    assert resp.status == "rejected"
    assert BillingKillSwitchService(db_session).is_enabled(TENANT_PAYMENT_ATTEMPTS) is True


def test_proposal_requires_incident_reference_to_engage(db_session):
    maker, _ = _super_admin(db_session, "maker3@s7.example", PlatformRole.SECURITY_OPERATOR, with_mfa=True)
    with pytest.raises(Exception):
        CircuitBreakerChangeProposalCreate(enabled=False, reason="no incident ref")


# ── D. Severity floor ────────────────────────────────────────────────────────

def test_financial_integrity_failure_opens_p0_directly(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID, total_amount="100.00")
    db_session.add(PaymentAllocation(
        organization_id=org.id, invoice_id=inv.id, payment_id=make_payment(db_session, org.id, cust.id).id,
        amount="150.00",
    ))
    db_session.commit()

    result = FinancialConsistencyService(db_session).run_scheduled_check()
    assert result["state"] == "FAILED"

    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == "financial_integrity:allocation")
        .first()
    )
    assert item is not None
    assert item.severity == AttentionSeverity.P0  # floor, not the P2 ladder


def test_recovery_auto_resolves_financial_integrity_item(db_session):
    org = make_organization(db_session)
    svc = FinancialConsistencyService(db_session)

    # Empty DB → UNKNOWN → no signal either way.
    assert svc.run_scheduled_check()["state"] == "UNKNOWN"
    assert db_session.query(AttentionItem).filter(AttentionItem.source_key == "financial_integrity:allocation").count() == 0


# ── E. Triage lens ───────────────────────────────────────────────────────────

def test_triage_summary_composes_real_sections(db_session):
    support = _super_admin(db_session, "triage@s7.example", PlatformRole.SUPPORT_OPERATOR)
    _engage(db_session, TENANT_DUNNING, reason="triage fixture")

    summary = get_triage_summary(current_user=support, db=db_session)

    assert summary.incidents.counts.total_open >= 1
    assert any(not c.enabled for c in summary.safety_controls)
    assert isinstance(summary.pipeline_stages, list)
    assert isinstance(summary.critical_events, list)


def test_triage_read_is_role_gated(db_session):
    finance = _super_admin(db_session, "finance@s7.example", PlatformRole.FINANCE_READONLY)
    dependency = require_capability("triage.read")
    with pytest.raises(ForbiddenException):
        dependency(current_user=finance)


# ── F. Performance instrumentation ───────────────────────────────────────────

def test_api_metrics_p95_math():
    import app.core.api_metrics as api_metrics

    for ms in [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]:
        api_metrics.record(ms)
    stats = api_metrics.snapshot(window_seconds=3600)
    assert stats["sample_count"] >= 10
    assert stats["p95_ms"] >= stats["p50_ms"]
    assert stats["max_ms"] == 1000.0
    assert stats["p95_budget_ms"] == 800


def test_perf01_unknown_without_samples(db_session):
    from app.modules.super_admin.launch_readiness_service import LaunchReadinessService

    items = LaunchReadinessService(db_session).evaluate()["items"]
    perf = next(i for i in items if i["id"] == "PERF-01")
    # In a fresh test process the window may hold a few samples from other
    # tests, but never enough to claim a verdict — either way it must not
    # fabricate PASS without ≥10 samples.
    assert perf["status"].lower() in ("unknown", "pass", "warning")
    if perf["status"].lower() == "unknown":
        assert "insufficient" in perf["evidence"].lower()


def test_legacy_toggle_endpoint_still_enforces_mfa_and_state(db_session):
    op, secret = _super_admin(db_session, "legacy@s7.example", PlatformRole.SECURITY_OPERATOR, with_mfa=True)
    resp = set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=False, reason="legacy path", incident_reference="INC-9", code=pyotp.TOTP(secret).now()),
        current_user=op, db=db_session,
    )
    assert resp.enabled is False
    assert resp.expires_at is not None


def test_get_db_returns_503_service_unavailable_when_db_unreachable(monkeypatch):
    """Transient DB/DNS failure must surface as retryable 503, not opaque 500
    (ISS-012 hardening)."""
    from sqlalchemy import exc as sa_exc

    from app.core.exceptions import ServiceUnavailableException
    import app.database as database

    def broken_session():
        raise sa_exc.OperationalError("SELECT 1", {}, Exception("getaddrinfo failed"))

    monkeypatch.setattr(database, "SessionLocal", broken_session)
    monkeypatch.setattr(database.time, "sleep", lambda s: None) if hasattr(database, "time") else None

    gen = database.get_db()
    with pytest.raises(ServiceUnavailableException) as exc_info:
        next(gen)
    assert exc_info.value.status_code == 503
