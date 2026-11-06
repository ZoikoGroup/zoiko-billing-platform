"""ZB-TAX-ARCH-001 Phase 5d PR 2: tenant MFA step-up.

Opt-in TOTP enrolment for tenant users (reusing the platform MFA code),
step-up on the four tenant tax approvals, TAX_TENANT_STEP_UP_REQUIRED
independent of TAX_REGISTRY_STEP_UP_REQUIRED, a two-person org-admin reset,
no cross-organization access, the MFA status fix (Phase 1 finding 8), and
login unchanged."""
import time
from datetime import date
from decimal import Decimal

import pyotp
import pytest

from app.config import settings
from app.core.security import hash_password
from app.modules.auth import mfa_service
from app.modules.auth.models import PlatformRole, SuperAdminMFA, UserRole
from app.modules.billing.models import BillingAuditLog
from app.modules.super_admin.models import PlatformAuditLog
from app.modules.tax.enums import EntityTaxRegime, OutboxOperation, TaxOperatingMode, TransactionClass
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_models import TaxProviderOutbox
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world
from tests.test_tax_phase4a2 import issue_via_connection, provider_invoice

T = "/api/v1/tax"
ENROL = "TAX_MFA_ENROLMENT_REQUIRED"
STEP = "TAX_REGISTRY_STEP_UP_REQUIRED"


def enrol(db, user):
    """Real enrolment through the service: start, then verify with a TOTP."""
    secret = mfa_service.start_enrollment(db, user)["secret"]
    codes = mfa_service.verify_enrollment(db, user, pyotp.TOTP(secret).now())["recovery_codes"]
    return secret, codes


def code(secret, shift=0):
    return pyotp.TOTP(secret).at(time.time() + shift)


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P5D2")
    w["admin"] = _tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin@p5d2.example")
    w["admin2"] = _tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin2@p5d2.example")
    w["approver2"] = _tenant_user(db_session, w["org"], UserRole.FINANCE_APPROVER, "fa2@p5d2.example")
    return w


def _regime_change(w):
    return TenantTaxService(w["db"]).request_regime(w["org"].id, w["maker"].id, w["entity"].id,
                                                    EntityTaxRegime.LEGACY_MANUAL, "pilot ended")


# ── enrolment, verification, recovery ───────────────────────────────────

def test_a_tenant_user_enrols_over_http_and_events_stay_in_their_org_log(db_session, client_for, w):
    client = client_for(w["checker"])
    assert client.get("/api/auth/mfa/status").json()["enrolled"] is False
    started = client.post("/api/auth/mfa/setup/start")
    assert started.status_code == 200, started.text
    secret = started.json()["secret"]
    done = client.post("/api/auth/mfa/setup/verify", json={"code": pyotp.TOTP(secret).now()})
    assert done.status_code == 200 and len(done.json()["recovery_codes"]) == 10
    status = client.get("/api/auth/mfa/status").json()
    assert status["enrolled"] is True and status["enabled"] is True and status["tax_tenant_step_up_required"] is True
    events = [a.new_values["mfa_event"] for a in db_session.query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "UserMFA", BillingAuditLog.organization_id == w["org"].id)]
    assert "mfa_enrolled" in events and "mfa_enabled" in events
    assert db_session.query(PlatformAuditLog).filter(PlatformAuditLog.actor_id == w["checker"].id).count() == 0


def test_a_recovery_code_works_once_for_step_up(db_session, client_for, w):
    _secret, codes = enrol(db_session, w["checker"])
    change = _regime_change(w)
    ok = client_for(w["checker"]).post(f"{T}/regime-changes/{change.id}/approve", json={"recovery_code": codes[0]})
    assert ok.status_code == 200, ok.text
    from app.modules.auth.models import SuperAdminMFARecoveryCode

    used = db_session.query(SuperAdminMFARecoveryCode).filter(SuperAdminMFARecoveryCode.used_at.isnot(None)).count()
    assert used == 1                                                   # spent: it can't be used again


# ── step-up on each of the four approvals ───────────────────────────────

def _three_ways(db, client, url, w, approver_key="checker"):
    """Not enrolled -> enrol prompt; enrolled without a code -> step-up prompt; with a code -> done."""
    first = client.post(url, json={})
    assert first.status_code == 400 and first.json()["error"] == ENROL, first.text
    assert "/billing/tax/governance/mfa" in first.text
    secret, _codes = enrol(db, w[approver_key])
    second = client.post(url, json={})
    assert second.status_code == 400 and second.json()["error"] == STEP
    third = client.post(url, json={"code": code(secret, -30)})
    assert third.status_code == 200, third.text
    return third.json()


def test_regime_switch_approval_needs_step_up(db_session, client_for, w):
    change = _regime_change(w)
    body = _three_ways(db_session, client_for(w["checker"]), f"{T}/regime-changes/{change.id}/approve", w)
    assert body["status"] == "APPROVED"


def test_provider_activation_approval_needs_step_up_native_does_not(db_session, client_for, w):
    svc = TenantTaxService(db_session)
    from app.modules.tax.models import EntityTaxRegistration

    reg = db_session.query(EntityTaxRegistration).filter(EntityTaxRegistration.organization_id == w["org"].id).first()
    native = svc.propose_activation(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id,
                                    jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                                    transaction_class=TransactionClass.B2B_SERVICES,
                                    mode=TaxOperatingMode.NATIVE_RULEPACK_APPROVED,
                                    effective_from=date(2027, 1, 1), registration_id=reg.id)
    plain = client_for(w["checker"]).post(f"{T}/activations/{native.id}/approve", json={})
    assert plain.status_code == 200, plain.text                         # native: no step-up
    provider = svc.propose_activation(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id,
                                      jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                                      transaction_class=TransactionClass.B2B_DIGITAL,
                                      mode=TaxOperatingMode.PROVIDER_APPROVED, effective_from=date(2027, 1, 1),
                                      registration_id=reg.id, provider_connection_id=w["connection"].id)
    body = _three_ways(db_session, client_for(w["checker"]), f"{T}/activations/{provider.id}/approve", w)
    assert body["status"] == "APPROVED"


def test_connection_mode_change_approval_needs_tenant_step_up(db_session, client_for, w):
    from app.modules.tax.connection_service import ProviderConnectionService

    conn = w["connection"]
    ProviderConnectionService(db_session).request_mode_change(w["org"].id, w["maker"].id, conn.id,
                                                              ProviderMode.ESTIMATE_ONLY, "pause")
    body = _three_ways(db_session, client_for(w["checker"]), f"{T}/provider-connections/{conn.id}/mode-change/approve", w)
    assert body["mode"] == "ESTIMATE_ONLY"


def test_void_remote_approval_needs_step_up(db_session, client_for, w):
    inv, _q = provider_invoice(w)
    w["provider"].remote_tax_delta = Decimal("0.01")                 # drift -> REVIEW_REQUIRED
    issue_via_connection(w, inv)
    row = db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    client_for(w["maker"]).post(f"{T}/provider-transactions/{row.id}/void-request")
    body = _three_ways(db_session, client_for(w["checker"]), f"{T}/provider-transactions/{row.id}/void-approve", w)
    assert body["state"] == "VOIDED"


def test_the_requester_of_a_void_is_refused_before_any_factor(db_session, client_for, w):
    inv, _q = provider_invoice(w)
    w["provider"].remote_tax_delta = Decimal("0.01")
    issue_via_connection(w, inv)
    row = db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    row.void_requested_by = w["checker"].id
    db_session.commit()
    assert client_for(w["checker"]).post(f"{T}/provider-transactions/{row.id}/void-approve", json={}).status_code == 403


# ── the two settings are independent ───────────────────────────────────

def test_tenant_setting_off_does_not_turn_off_the_registry_and_vice_versa(db_session, client_for, w, monkeypatch):
    from app.modules.tax.registry_router import TaxStepUpRequired, require_tax_step_up
    from app.modules.tax.registry_schemas import StepUpRequest
    from app.modules.tax.tenant_step_up import TaxMfaEnrolmentRequired, require_tenant_tax_step_up

    staff = make_super_admin(db_session, "tp@p5d2.example", PlatformRole.TAX_PUBLISHER)
    monkeypatch.setattr(settings, "TAX_TENANT_STEP_UP_REQUIRED", False)
    assert require_tenant_tax_step_up(db_session, w["checker"]) == "not_required"
    with pytest.raises(TaxStepUpRequired):
        require_tax_step_up(db_session, staff, StepUpRequest())                   # registry still enforced
    change = _regime_change(w)
    assert client_for(w["checker"]).post(f"{T}/regime-changes/{change.id}/approve", json={}).status_code == 200

    monkeypatch.setattr(settings, "TAX_TENANT_STEP_UP_REQUIRED", True)
    monkeypatch.setattr(settings, "TAX_REGISTRY_STEP_UP_REQUIRED", False)
    require_tax_step_up(db_session, staff, StepUpRequest())                       # registry off
    with pytest.raises(TaxMfaEnrolmentRequired):
        require_tenant_tax_step_up(db_session, w["checker"])                       # tenant still enforced


def test_the_dev_bypass_is_refused_outside_debug():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises((ValidationError, ValueError)):
        Settings(MFA_STEP_UP_BYPASS=True, DEBUG=False)


# ── two-person reset by org admins ──────────────────────────────────────

def test_a_reset_needs_two_org_admins_and_never_your_own(db_session, client_for, w):
    enrol(db_session, w["checker"])
    enrol(db_session, w["admin"])
    target = w["checker"].id
    # client_for sets one app-wide user, so each client is made just before use.
    assert client_for(w["maker"]).post(f"{T}/mfa/users/{target}/reset-request", json={"reason": "x"}).status_code == 403
    a1 = client_for(w["admin"])
    assert a1.post(f"{T}/mfa/users/{w['admin'].id}/reset-request", json={"reason": "lost phone"}).status_code == 403
    assert a1.post(f"{T}/mfa/users/{target}/reset-request", json={"reason": "lost phone"}).status_code == 200
    assert a1.post(f"{T}/mfa/users/{target}/reset-approve").status_code == 403      # the requester
    assert mfa_service.is_mfa_enabled(db_session, target)
    done = client_for(w["admin2"]).post(f"{T}/mfa/users/{target}/reset-approve")
    assert done.status_code == 200 and done.json()["enrolled"] is False
    assert not mfa_service.is_mfa_enabled(db_session, target)
    events = [a.new_values["mfa_event"] for a in db_session.query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "UserMFA", BillingAuditLog.entity_id == target)]
    assert "mfa_reset_requested" in events and "mfa_reset_approved" in events


def test_admins_see_who_is_enrolled_and_nothing_crosses_organizations(db_session, client_for, w):
    enrol(db_session, w["checker"])
    users = {u["user_id"]: u for u in client_for(w["admin"]).get(f"{T}/mfa/users").json()["items"]}
    assert users[w["checker"].id]["enrolled"] is True and users[w["approver2"].id]["enrolled"] is False
    assert client_for(w["checker"]).get(f"{T}/mfa/users").status_code == 403         # org admins only
    other = make_organization(db_session, code="P5D2X", name="Other")
    stranger = _tenant_user(db_session, other, UserRole.ORG_ADMIN, "admin@p5d2x.example")
    listed = client_for(stranger).get(f"{T}/mfa/users").json()["items"]
    assert w["checker"].id not in {u["user_id"] for u in listed}
    assert client_for(stranger).post(f"{T}/mfa/users/{w['checker'].id}/reset-request",
                                     json={"reason": "x"}).status_code == 404
    staff = client_for(make_super_admin(db_session, "pa@p5d2.example", PlatformRole.PLATFORM_ADMINISTRATOR))
    assert staff.get(f"{T}/mfa/users").status_code == 403                            # T13


# ── finding 8 and login ─────────────────────────────────────────────────

def test_status_reports_real_enrolment_even_while_platform_step_up_is_retired(db_session, client_for, monkeypatch):
    monkeypatch.setattr(settings, "MFA_STEP_UP_ENABLED", False)
    admin = make_super_admin(db_session, "sa@p5d2.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    body = client_for(admin).get("/api/auth/mfa/status").json()
    assert body["enabled"] is False and body["enrolled"] is False and body["step_up_required"] is False
    db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == admin.id).delete()
    enrol(db_session, admin)
    assert client_for(admin).get("/api/auth/mfa/status").json()["enrolled"] is True


def test_login_is_unchanged_for_an_enrolled_tenant_user(db_session, w):
    from fastapi.testclient import TestClient

    from app.core.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    user = w["checker"]
    user.hashed_password = hash_password("Correct-Horse-9!")
    db_session.commit()
    enrol(db_session, user)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        response = TestClient(app).post("/api/auth/login", json={"email": user.email, "password": "Correct-Horse-9!"})
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 200, response.text
    assert response.json().get("access_token")                                    # no MFA challenge at login
