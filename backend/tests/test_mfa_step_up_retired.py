"""
tests/test_mfa_step_up_retired.py
---------------------------------
MFA step-up is retired by default (MFA_STEP_UP_ENABLED=false): privileged
actions no longer ask for a one-time code. These tests pin that default at
every enforcement point — request schemas, verify_step_up, the status
endpoint and Launch Readiness — so they cannot drift apart. The enforced
behaviour (switched back on) stays covered by test_mfa_service.py and
test_domain_b_circuit_breaker.py via the mfa_step_up_enabled fixture.
"""

from app.config import settings, step_up_required
from app.modules.auth import mfa_service
from app.modules.auth.models import User, UserRole
from app.modules.auth.router import mfa_status
from app.modules.super_admin.kill_switch_service import TENANT_INVOICE_FINALIZATION
from app.modules.super_admin.launch_readiness_service import LaunchReadinessService
from app.modules.super_admin.router import _apply_breaker_toggle
from app.modules.super_admin.schemas import (
    BreakGlassRequest,
    CircuitBreakerToggleRequest,
    PrivilegedAccessStepUp,
)


def _super_admin(db, email="sa@retired.example"):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="A", is_active=True, is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def test_step_up_is_off_by_default():
    assert settings.MFA_STEP_UP_ENABLED is False
    assert step_up_required() is False


def test_privileged_request_schemas_accept_no_factor():
    CircuitBreakerToggleRequest(enabled=True, reason="release")
    PrivilegedAccessStepUp(reason="activate")
    BreakGlassRequest(organization_id=1, reason="incident", incident_reference="INC-1")


def test_verify_step_up_passes_without_enrollment_or_code(db_session):
    user = _super_admin(db_session)
    # No SuperAdminMFA row and no code: must not raise.
    assert mfa_service.verify_step_up(db_session, user, code=None, recovery_code=None) is None


def test_status_endpoint_reports_step_up_not_required(db_session):
    user = _super_admin(db_session)
    assert mfa_status(current_user=user, db=db_session) == {"enabled": True, "bypassed": True}


def test_launch_readiness_flags_step_up_off_and_skips_key_check(db_session):
    _super_admin(db_session)
    items = {i["id"]: i for i in LaunchReadinessService(db_session).evaluate()["items"]}
    assert "SEC-CFG-02" not in items
    assert items["SEC-MFA-01"]["status"] == "WARNING"
    assert "turned off" in items["SEC-MFA-01"]["evidence"]


def test_breaker_can_be_paused_and_resumed_without_a_code(db_session):
    # The Governance "Pause" button: no MFA enrollment, no code — just a
    # reason (plus an incident reference to engage).
    user = _super_admin(db_session, email="breaker@retired.example")
    paused = _apply_breaker_toggle(
        TENANT_INVOICE_FINALIZATION,
        CircuitBreakerToggleRequest(enabled=False, reason="duplicate invoices", incident_reference="INC-1"),
        user, db_session,
    )
    assert paused.enabled is False
    resumed = _apply_breaker_toggle(
        TENANT_INVOICE_FINALIZATION,
        CircuitBreakerToggleRequest(enabled=True, reason="resolved"),
        user, db_session,
    )
    assert resumed.enabled is True
