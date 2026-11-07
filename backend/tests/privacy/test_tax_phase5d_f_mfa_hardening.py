"""ZB-TAX-ARCH-001 Phase 5d-F: MFA hardening (one code path, tenant and platform).

1. Disabling MFA needs a current TOTP or recovery code as well as the password.
2. Enrolment, disable, re-enrolment and admin reset email the user (when,
   masked IP) and the org's admins / the platform security contact (ZB-SEC-019).
3. A newly enrolled or re-enrolled factor can't satisfy tax step-up (tenant
   or platform) until TAX_STEP_UP_NEW_FACTOR_DELAY_HOURS have passed. Audited.
"""
import time
from datetime import datetime, timedelta

import pyotp
import pytest

from app.config import settings
from app.core.exceptions import BadRequestException
from app.core.security import hash_password
from app.modules.auth import mfa_service
from app.modules.auth.models import PlatformRole, SuperAdminMFA, UserRole
from app.modules.billing.models import BillingAuditLog
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.tax.enums import EntityTaxRegime
from app.modules.tax.registry_router import require_tax_step_up
from app.modules.tax.registry_schemas import StepUpRequest
from app.modules.tax.tenant_step_up import TaxMfaFactorCoolingOff, require_tenant_tax_step_up
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world

T = "/api/v1/tax"
PASSWORD = "Correct-Horse-9!"


@pytest.fixture()
def emails(monkeypatch):
    sent = []
    from app.modules.notifications import service as notifications

    monkeypatch.setattr(notifications, "dispatch_email", lambda **kw: sent.append(kw))
    return sent


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P5DF")
    w["admin"] = _tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin@p5df.example")
    w["admin2"] = _tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin2@p5df.example")
    w["checker"].hashed_password = hash_password(PASSWORD)
    db_session.commit()
    return w


def enrol(db, user):
    secret = mfa_service.start_enrollment(db, user)["secret"]
    codes = mfa_service.verify_enrollment(db, user, pyotp.TOTP(secret).now(), ip="203.0.113.7")["recovery_codes"]
    return secret, codes


def age(db, user, hours):
    """Pretend the factor was enabled `hours` ago."""
    row = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).one()
    row.enabled_at = datetime.utcnow() - timedelta(hours=hours)
    db.commit()


def code(secret, shift=0):
    return pyotp.TOTP(secret).at(time.time() + shift)


# ── 1. disabling needs a factor ─────────────────────────────────────────

def test_disable_needs_a_current_code_as_well_as_the_password(db_session, w, emails):
    user = w["checker"]
    secret, codes = enrol(db_session, user)
    with pytest.raises(BadRequestException, match="current code"):
        mfa_service.disable_mfa_self(db_session, user, PASSWORD)                        # password alone
    with pytest.raises(Exception, match="Incorrect verification code"):
        mfa_service.disable_mfa_self(db_session, user, PASSWORD, code="000000")
    with pytest.raises(BadRequestException, match="password is incorrect"):
        mfa_service.disable_mfa_self(db_session, user, "wrong", code=code(secret, -30))
    assert mfa_service.is_mfa_enabled(db_session, user.id)
    mfa_service.disable_mfa_self(db_session, user, PASSWORD, recovery_code=codes[0], ip="198.51.100.20")
    assert not mfa_service.is_mfa_enabled(db_session, user.id)


def test_disable_over_http_needs_the_factor_too(db_session, client_for, w, emails):
    user = w["checker"]
    secret, _codes = enrol(db_session, user)
    client = client_for(user)
    refused = client.post("/api/auth/mfa/disable", json={"current_password": PASSWORD})
    assert refused.status_code == 400 and mfa_service.is_mfa_enabled(db_session, user.id)
    ok = client.post("/api/auth/mfa/disable", json={"current_password": PASSWORD, "code": code(secret, -30)})
    assert ok.status_code == 200, ok.text
    assert not mfa_service.is_mfa_enabled(db_session, user.id)


def test_platform_accounts_use_the_same_rule(db_session, emails):
    admin = make_super_admin(db_session, "sa@p5df.example", PlatformRole.TAX_PUBLISHER)
    admin.hashed_password = hash_password(PASSWORD)
    db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == admin.id).delete()
    db_session.commit()
    secret, _codes = enrol(db_session, admin)
    with pytest.raises(BadRequestException, match="current code"):
        mfa_service.disable_mfa_self(db_session, admin, PASSWORD)
    mfa_service.disable_mfa_self(db_session, admin, PASSWORD, code=code(secret, -30))
    assert not mfa_service.is_mfa_enabled(db_session, admin.id)


# ── 2. notices: user + org admins / security contact, with when and masked IP ──

def test_enrol_disable_re_enrol_and_reset_notify_the_user_and_the_org_admins(db_session, client_for, w, emails,
                                                                               monkeypatch):
    user = w["checker"]
    secret, _codes = enrol(db_session, user)
    mine = [e for e in emails if e["recipient_email"] == user.email]
    admins = [e for e in emails if e["template_id"] == "ZB-SEC-019"]
    assert mine[0]["template_id"] == "ZB-SEC-005" and mine[0]["context"]["ip_hint"] == "203.0.113.x"
    assert {e["recipient_email"] for e in admins} == {"admin@p5df.example", "admin2@p5df.example"}
    assert admins[0]["context"]["change_description"] == "MFA was set up" and admins[0]["context"]["changed_at"]
    assert "203.0.113.7" not in str(emails)                                       # never a complete IP

    emails.clear()
    mfa_service.disable_mfa_self(db_session, user, PASSWORD, code=code(secret, -30), ip="198.51.100.20")
    assert {e["template_id"] for e in emails} == {"ZB-SEC-006", "ZB-SEC-019"}
    assert all(e["context"]["ip_hint"] == "198.51.100.x" for e in emails)

    emails.clear()
    enrol(db_session, user)
    changes = [e["context"]["change_description"] for e in emails if e["template_id"] == "ZB-SEC-019"]
    assert changes and all("re-enrolled" in c for c in changes)

    emails.clear()
    monkeypatch.setattr(settings, "TAX_STEP_UP_NEW_FACTOR_DELAY_HOURS", 0)
    client_for(w["admin"]).post(f"{T}/mfa/users/{user.id}/reset-request", json={"reason": "lost phone"})
    client_for(w["admin2"]).post(f"{T}/mfa/users/{user.id}/reset-approve")
    assert any(e["template_id"] == "ZB-SEC-019" and "reset" in e["context"]["change_description"] for e in emails)
    assert any(e["recipient_email"] == user.email for e in emails)


def test_platform_changes_go_to_the_security_contact(db_session, emails, monkeypatch):
    monkeypatch.setattr(settings, "SECURITY_CONTACT_EMAIL", "security@zoiko.example")
    admin = make_super_admin(db_session, "sa2@p5df.example", PlatformRole.TAX_PUBLISHER)
    db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == admin.id).delete()
    db_session.commit()
    enrol(db_session, admin)
    notices = [e for e in emails if e["template_id"] == "ZB-SEC-019"]
    assert [e["recipient_email"] for e in notices] == ["security@zoiko.example"]
    other = make_super_admin(db_session, "sa3@p5df.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    emails.clear()
    mfa_service.admin_reset_mfa(db_session, other, admin.id, ip="192.0.2.44")
    assert {e["template_id"] for e in emails} == {"ZB-SEC-017", "ZB-SEC-019"}
    assert all(e["context"]["ip_hint"] == "192.0.2.x" for e in emails)


def test_the_new_template_renders_and_masks(db_session):
    from app.modules.notifications.templates.zb_sec import RENDERERS

    subject, html = RENDERERS["ZB-SEC-019"]({"recipient_first_name": "Ana", "account_label": "Fay (fay@x.example)",
                                             "change_description": "MFA was turned off",
                                             "changed_at": "2026-11-06 10:00 UTC", "ip_hint": "203.0.113.x"})
    assert "MFA changed" in subject and "MFA was turned off" in html and "203.0.113.x" in html
    assert mfa_service.mask_ip("2001:db8:85a3::8a2e:370:7334") == "2001:db8:85a3::x"
    assert mfa_service.mask_ip(None) == "unknown"


# ── 3. cooling-off for a new factor ─────────────────────────────────────

def test_a_new_factor_cannot_approve_tenant_tax_changes_until_the_delay(db_session, client_for, w, emails):
    user = w["checker"]
    secret, _codes = enrol(db_session, user)
    change = TenantTaxService(db_session).request_regime(w["org"].id, w["maker"].id, w["entity"].id,
                                                         EntityTaxRegime.LEGACY_MANUAL, "pilot ended")
    refused = client_for(user).post(f"{T}/regime-changes/{change.id}/approve", json={"code": code(secret)})
    assert refused.status_code == 400 and refused.json()["error"] == "TAX_MFA_FACTOR_COOLING_OFF"
    assert "UTC" in refused.json()["message"]
    status = client_for(user).get("/api/auth/mfa/status").json()
    assert status["tax_step_up_usable_at"] and status["tax_step_up_new_factor_delay_hours"] == 24
    audited = [a.new_values for a in db_session.query(BillingAuditLog).filter(BillingAuditLog.entity_type == "UserMFA")
               if (a.new_values or {}).get("mfa_event") == "mfa_step_up_refused_new_factor"]
    assert audited and audited[0]["control"] == "tax_tenant"
    age(db_session, user, 25)
    ok = client_for(user).post(f"{T}/regime-changes/{change.id}/approve", json={"code": code(secret, -30)})
    assert ok.status_code == 200, ok.text
    assert client_for(user).get("/api/auth/mfa/status").json()["tax_step_up_usable_at"] is None


def test_disable_then_re_enrol_then_approve_is_refused_within_the_delay(db_session, client_for, w, emails):
    """The attack: with the password, turn MFA off, enrol your own factor, approve."""
    user = w["checker"]
    secret, codes = enrol(db_session, user)
    age(db_session, user, 48)                                                      # the real factor is old
    mfa_service.disable_mfa_self(db_session, user, PASSWORD, recovery_code=codes[0])   # (now needs a factor)
    new_secret, _ = enrol(db_session, user)                                        # attacker's new factor
    change = TenantTaxService(db_session).request_regime(w["org"].id, w["maker"].id, w["entity"].id,
                                                         EntityTaxRegime.LEGACY_MANUAL, "attack")
    refused = client_for(user).post(f"{T}/regime-changes/{change.id}/approve", json={"code": code(new_secret)})
    assert refused.status_code == 400 and refused.json()["error"] == "TAX_MFA_FACTOR_COOLING_OFF"
    db_session.refresh(change)
    assert change.status.name == "PROPOSED"


def test_platform_tax_step_up_has_the_same_cooling_off(db_session, emails):
    admin = make_super_admin(db_session, "tp@p5df.example", PlatformRole.TAX_PUBLISHER)
    db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == admin.id).delete()
    db_session.commit()
    secret, _ = enrol(db_session, admin)
    with pytest.raises(TaxMfaFactorCoolingOff):
        require_tax_step_up(db_session, admin, StepUpRequest(code=code(secret)))
    assert db_session.query(PlatformAuditLog).filter(
        PlatformAuditLog.action == PlatformAuditAction.MFA_STEP_UP_REFUSED_NEW_FACTOR,
        PlatformAuditLog.actor_id == admin.id).count() == 1
    age(db_session, admin, 25)
    require_tax_step_up(db_session, admin, StepUpRequest(code=code(secret, -30)))      # passes now


def test_the_delay_is_configurable_and_old_factors_are_not_affected(db_session, w, emails, monkeypatch):
    user = w["checker"]
    secret, _ = enrol(db_session, user)
    monkeypatch.setattr(settings, "TAX_STEP_UP_NEW_FACTOR_DELAY_HOURS", 1)
    with pytest.raises(TaxMfaFactorCoolingOff):
        require_tenant_tax_step_up(db_session, user, code(secret))
    age(db_session, user, 2)
    assert require_tenant_tax_step_up(db_session, user, code(secret, -30)) == "verified"
    row = db_session.query(SuperAdminMFA).filter(SuperAdminMFA.user_id == user.id).one()
    row.enabled_at = None                                                          # enabled before 5d-F
    db_session.commit()
    assert mfa_service.tax_step_up_usable_at(db_session, user.id) is None
