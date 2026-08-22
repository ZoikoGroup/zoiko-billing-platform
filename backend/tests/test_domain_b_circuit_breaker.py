"""
tests/test_domain_b_circuit_breaker.py
------------------------------------------
ZB-SA-CMD-003 §18 — the first REAL Domain B circuit breaker
("pause invoice finalization" from the spec's launch catalog, §9.2).

Honest scope: this is ONE breaker, chosen because InvoiceService.
finalize_invoice() is a single, well-bounded, already-tested entry point
(mark_sent() delegates to it, so both are covered). The full breaker
catalog (pause payment attempts, suspend dunning, pause communications,
freeze connector sync) remains NOT IMPLEMENTED — each would require the
same audit of its own live code path before a real (non-fake) guard could
be added; see SUPER_ADMIN_IMPLEMENTATION_STATUS.md.

Coverage:
  1. finalize_invoice works when the breaker is enabled (default)
  2. a non-security-operator (support_operator) cannot manage the breaker
  3. security_operator can pause it with valid MFA step-up
  4. finalize_invoice is ACTUALLY blocked while paused — real enforcement,
     not a UI-only flag (the assertion calls the billing service directly,
     not the Super Admin router)
  5. wrong MFA code cannot toggle the breaker
  6. correct (fresh) MFA re-enables it
  7. finalize_invoice works again after resume
  8. pausing opens a real Attention item; resuming auto-resolves it
  9. mark_sent() (which delegates to finalize_invoice) is also blocked
"""

import time

import pyotp
import pytest

from app.core.capabilities import require_capability
from app.core.exceptions import BadRequestException, ForbiddenException, UnauthorizedException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import PlatformRole, SuperAdminMFA, User, UserRole
from app.modules.billing.models import InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.super_admin.models import AttentionItem
from app.modules.super_admin.router import (
    get_tenant_invoice_finalization_breaker,
    set_tenant_invoice_finalization_breaker,
)
from app.modules.super_admin.schemas import CircuitBreakerToggleRequest
from tests.conftest import make_customer, make_invoice, make_organization


def _security_operator(db, email="security@breaker.example"):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="O", is_active=True, is_verified=True,
        platform_role=PlatformRole.SECURITY_OPERATOR,
    )
    db.add(user)
    db.flush()
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.flush()
    return user, secret


def test_finalize_works_by_default(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT)

    result = InvoiceService(db_session).finalize_invoice(inv.id, org.id, updated_by=1)
    assert result.status == InvoiceStatus.SENT


def test_support_operator_cannot_manage_breaker(db_session):
    support = User(
        email="support@breaker.example", hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="U", is_active=True, is_verified=True,
        platform_role=PlatformRole.SUPPORT_OPERATOR,
    )
    db_session.add(support)
    db_session.commit()

    dependency = require_capability("circuit_breaker.manage")
    with pytest.raises(ForbiddenException):
        dependency(current_user=support)


def test_pause_blocks_real_invoice_finalization(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT, invoice_number="INV-PAUSE-1")
    security_op, secret = _security_operator(db_session)

    set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=False, reason="Investigating duplicate invoices", incident_reference="INC-1234", code=pyotp.TOTP(secret).now()),
        current_user=security_op, db=db_session,
    )

    with pytest.raises(BadRequestException):
        InvoiceService(db_session).finalize_invoice(inv.id, org.id, updated_by=1)


def test_wrong_mfa_cannot_toggle_breaker(db_session):
    security_op, _secret = _security_operator(db_session)
    with pytest.raises(UnauthorizedException):
        set_tenant_invoice_finalization_breaker(
            data=CircuitBreakerToggleRequest(enabled=False, reason="test", incident_reference="INC-TEST", code="000000"),
            current_user=security_op, db=db_session,
        )


def test_resume_restores_real_finalization(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT, invoice_number="INV-RESUME-1")
    security_op, secret = _security_operator(db_session)

    set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=False, reason="pause", incident_reference="INC-PAUSE", code=pyotp.TOTP(secret).now()),
        current_user=security_op, db=db_session,
    )
    resume_code = pyotp.TOTP(secret).at(int(time.time()) + 30)  # different time-step: avoids replay rejection
    resp = set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=True, reason="resolved", code=resume_code),
        current_user=security_op, db=db_session,
    )
    assert resp.enabled is True

    result = InvoiceService(db_session).finalize_invoice(inv.id, org.id, updated_by=1)
    assert result.status == InvoiceStatus.SENT


def test_pause_opens_and_resume_resolves_attention_item(db_session):
    security_op, secret = _security_operator(db_session)

    set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=False, reason="pause", incident_reference="INC-PAUSE", code=pyotp.TOTP(secret).now()),
        current_user=security_op, db=db_session,
    )
    item = db_session.query(AttentionItem).filter(AttentionItem.source_key == "kill_switch:tenant_invoice_finalization").first()
    assert item is not None
    assert item.status.value == "open"
    assert item.severity.value == "p1"

    resume_code = pyotp.TOTP(secret).at(int(time.time()) + 30)
    set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=True, reason="resolved", code=resume_code),
        current_user=security_op, db=db_session,
    )
    db_session.refresh(item)
    assert item.status.value == "resolved"


def test_mark_sent_also_blocked_since_it_delegates_to_finalize(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)
    inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.DRAFT, invoice_number="INV-MARKSENT-1")
    security_op, secret = _security_operator(db_session)

    set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=False, reason="pause", incident_reference="INC-PAUSE", code=pyotp.TOTP(secret).now()),
        current_user=security_op, db=db_session,
    )

    with pytest.raises(BadRequestException):
        InvoiceService(db_session).mark_sent(inv.id, org.id, updated_by=1)


def test_get_breaker_status_reflects_real_state(db_session):
    security_op, secret = _security_operator(db_session)
    initial = get_tenant_invoice_finalization_breaker(current_user=security_op, db=db_session)
    assert initial.enabled is True  # default: not paused

    set_tenant_invoice_finalization_breaker(
        data=CircuitBreakerToggleRequest(enabled=False, reason="pause", incident_reference="INC-PAUSE", code=pyotp.TOTP(secret).now()),
        current_user=security_op, db=db_session,
    )
    after = get_tenant_invoice_finalization_breaker(current_user=security_op, db=db_session)
    assert after.enabled is False
    assert after.reason == "pause"
    assert after.changed_by_email == security_op.email
