"""ZB-TAX-ARCH-001 Phase 5c PR 3: a governed mode change on a provider
connection. ESTIMATE_ONLY (safe mode) <-> COMMIT on the same connection and
credentials, proposed by a billing admin and approved by a different finance
approver with MFA step-up; estimate-only -> commit only when the connection
can go live; in-flight transactions untouched; audited; in the evidence
bundle."""
from datetime import timedelta

import pyotp
import pytest

from app.core.exceptions import BadRequestException, ForbiddenException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import PlatformRole, SuperAdminMFA, UserRole
from app.modules.billing.models import BillingAuditLog, InvoiceStatus
from app.modules.tax import connection_service as conn_mod
from app.modules.tax.connection_service import ProviderConnectionService
from app.modules.tax.enums import ConnectionStatus, OutboxState, ProviderEnvironment
from app.modules.tax.evidence_bundle import verify
from app.modules.tax.models import TaxRecordFrozenError
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_issuance import ProviderIssuanceBlocked, ProviderIssuanceService
from app.modules.tax.provider_models import TaxProviderOutbox
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world
from tests.test_tax_phase4a2 import issue_via_connection, provider_invoice

BASE = "/api/v1/tax/provider-connections"


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P5C3")
    secret = pyotp.random_base32()
    db_session.add(SuperAdminMFA(user_id=w["checker"].id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    w["approver2"] = _tenant_user(db_session, w["org"], UserRole.FINANCE_APPROVER, "fa2@p5c3.example")
    db_session.commit()
    w["totp"] = pyotp.TOTP(secret)
    w["svc"] = ProviderConnectionService(db_session)
    return w


def _audit(db, conn_id):
    return [a.new_values["mode_change"] for a in db.query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "TaxProviderConnection", BillingAuditLog.entity_id == conn_id)
        .order_by(BillingAuditLog.id) if (a.new_values or {}).get("mode_change")]


def _to_estimate(w):
    """Service path, two people (the step-up is on the HTTP route)."""
    conn = w["connection"]
    w["svc"].request_mode_change(w["org"].id, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "pause issuing")
    return w["svc"].decide_mode_change(w["org"].id, w["checker"].id, conn.id, approve=True)


# ── the flow over HTTP, with MFA step-up ─────────────────────────────────

def test_commit_to_safe_mode_keeps_the_connection_and_credentials_and_is_audited(db_session, client_for, w):
    conn = w["connection"]
    naive = lambda t: t.replace(tzinfo=None) if t else t  # noqa: E731  (SQLite drops the zone on refresh)
    before = (conn.id, conn.credential_ref, conn.credential_last4, naive(conn.credential_rotated_at))
    asked = client_for(w["maker"]).post(f"{BASE}/{conn.id}/mode-change", json={"mode": "ESTIMATE_ONLY", "reason": "pilot pause"})
    assert asked.status_code == 200, asked.text
    assert asked.json()["mode_change"]["to"] == "ESTIMATE_ONLY" and asked.json()["mode"] == "COMMIT"

    checker = client_for(w["checker"])
    missing = checker.post(f"{BASE}/{conn.id}/mode-change/approve", json={})
    assert missing.status_code == 400 and missing.json()["error"] == "TAX_REGISTRY_STEP_UP_REQUIRED"
    db_session.refresh(conn)
    assert conn.mode == "COMMIT"                                          # nothing changed without the factor

    done = checker.post(f"{BASE}/{conn.id}/mode-change/approve", json={"code": w["totp"].now()})
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["mode"] == "ESTIMATE_ONLY" and body["mode_change"] is None and body["mode_changed_by"] == w["checker"].id
    db_session.refresh(conn)
    assert (conn.id, conn.credential_ref, conn.credential_last4, naive(conn.credential_rotated_at)) == before
    events = _audit(db_session, conn.id)
    assert [e["event"] for e in events] == ["requested", "approved"]
    assert events[1]["from"] == "COMMIT" and events[1]["to"] == "ESTIMATE_ONLY" and events[1]["step_up"] == "verified"


def test_an_approver_without_mfa_is_refused(db_session, client_for, w):
    conn = w["connection"]
    w["svc"].request_mode_change(w["org"].id, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "pause")
    refused = client_for(w["approver2"]).post(f"{BASE}/{conn.id}/mode-change/approve", json={"code": "123456"})
    assert refused.status_code == 400 and "MFA is not enabled" in refused.text
    db_session.refresh(conn)
    assert conn.mode == "COMMIT" and conn.mode_change_to == "ESTIMATE_ONLY"


def test_roles_over_http(db_session, client_for, w):
    conn = w["connection"]
    auditor = client_for(_tenant_user(db_session, w["org"], UserRole.AUDITOR, "aud@p5c3.example"))
    assert auditor.post(f"{BASE}/{conn.id}/mode-change", json={"mode": "ESTIMATE_ONLY", "reason": "x"}).status_code == 403
    assert client_for(w["checker"]).post(f"{BASE}/{conn.id}/mode-change",
                                         json={"mode": "ESTIMATE_ONLY", "reason": "x"}).status_code == 403
    client_for(w["maker"]).post(f"{BASE}/{conn.id}/mode-change", json={"mode": "ESTIMATE_ONLY", "reason": "x"})
    assert client_for(w["maker"]).post(f"{BASE}/{conn.id}/mode-change/approve", json={}).status_code == 403
    staff = client_for(make_super_admin(db_session, "tp@p5c3.example", PlatformRole.TAX_PUBLISHER))
    assert staff.post(f"{BASE}/{conn.id}/mode-change/approve", json={}).status_code == 403          # T13
    assert client_for(w["maker"]).post(f"{BASE}/{conn.id}/mode-change",
                                       json={"mode": "COMMIT", "reason": "x", "base_url": "https://evil"}).status_code == 422


# ── rules ───────────────────────────────────────────────────────────────

def test_the_requester_never_decides(w):
    conn = w["connection"]
    w["svc"].request_mode_change(w["org"].id, w["checker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "pause")
    with pytest.raises(ForbiddenException, match="different user"):
        w["svc"].decide_mode_change(w["org"].id, w["checker"].id, conn.id, approve=True)


def test_one_pending_change_withdraw_and_reject(db_session, w):
    conn, svc, org = w["connection"], w["svc"], w["org"].id
    with pytest.raises(BadRequestException, match="reason is required"):
        svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "  ")
    with pytest.raises(BadRequestException, match="already COMMIT"):
        svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.COMMIT, "noop")
    svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "pause")
    with pytest.raises(BadRequestException, match="already waiting"):
        svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "again")
    svc.withdraw_mode_change(org, w["maker"].id, conn.id)
    assert conn.mode_change_to is None and conn.mode == "COMMIT"
    svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "pause")
    svc.decide_mode_change(org, w["checker"].id, conn.id, approve=False, reason="not now")
    assert conn.mode == "COMMIT" and conn.mode_change_to is None
    assert [e["event"] for e in _audit(db_session, conn.id)] == ["requested", "withdrawn", "requested", "rejected"]


def test_going_to_commit_needs_a_passing_test_with_the_current_credential(db_session, w):
    conn, svc, org = w["connection"], w["svc"], w["org"].id
    _to_estimate(w)
    with pytest.raises(BadRequestException, match="passing Test connection"):
        svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.COMMIT, "go live")
    svc.test_connection(org, w["maker"].id, conn.id)
    assert conn.health_ok
    svc.set_credentials(org, w["maker"].id, conn.id, "fake-sandbox-credential-5678")     # new credential, untested
    conn.health_checked_at = conn.credential_rotated_at - timedelta(seconds=1)
    db_session.commit()
    with pytest.raises(BadRequestException, match="current credential"):
        svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.COMMIT, "go live")
    svc.test_connection(org, w["maker"].id, conn.id)
    svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.COMMIT, "go live")
    svc.decide_mode_change(org, w["approver2"].id, conn.id, approve=True)
    assert conn.mode == "COMMIT"


def test_going_to_commit_rechecks_the_gates_at_approval(db_session, w):
    conn, svc, org = w["connection"], w["svc"], w["org"].id
    _to_estimate(w)
    svc.test_connection(org, w["maker"].id, conn.id)
    svc.request_mode_change(org, w["maker"].id, conn.id, ProviderMode.COMMIT, "go live")
    svc.revoke_credentials(org, w["maker"].id, conn.id, "leaked")                          # suspends, removes the secret
    with pytest.raises(BadRequestException, match="usable connection"):
        svc.decide_mode_change(org, w["approver2"].id, conn.id, approve=True)
    assert conn.mode == "ESTIMATE_ONLY"


def test_production_commit_needs_the_flag_and_the_managed_store(db_session, w, monkeypatch):
    svc, org = w["svc"], w["org"].id
    prod = svc.propose(org, w["maker"].id, seller_entity_id=w["entity"].id, provider_name="fake-provider",
                       environment=ProviderEnvironment.PRODUCTION, mode=ProviderMode.ESTIMATE_ONLY)
    svc.decide(org, w["checker"].id, prod.id, approve=True)
    monkeypatch.setattr(conn_mod, "production_credentials_allowed", lambda: True)
    svc.set_credentials(org, w["maker"].id, prod.id, "fake-production-credential-1")
    svc.test_connection(org, w["maker"].id, prod.id)
    monkeypatch.setattr(conn_mod, "production_credentials_allowed", lambda: False)        # flag off or not the gcp store
    with pytest.raises(BadRequestException, match="production provider connections are not enabled"):
        svc.request_mode_change(org, w["maker"].id, prod.id, ProviderMode.COMMIT, "go live")
    monkeypatch.setattr(conn_mod, "production_credentials_allowed", lambda: True)
    svc.request_mode_change(org, w["maker"].id, prod.id, ProviderMode.COMMIT, "go live")
    svc.decide_mode_change(org, w["approver2"].id, prod.id, approve=True)
    assert prod.mode == "COMMIT" and prod.status == ConnectionStatus.APPROVED


def test_the_real_production_gate_is_the_flag_plus_gcp(monkeypatch):
    from app.config import settings
    from app.modules.tax import secret_store

    monkeypatch.setattr(settings, "TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED", True)
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "fernet")
    assert secret_store.production_credentials_allowed() is False
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "gcp")
    assert secret_store.production_credentials_allowed() is True
    monkeypatch.setattr(settings, "TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED", False)
    assert secret_store.production_credentials_allowed() is False


def test_safe_mode_never_touches_transactions_in_flight(db_session, w):
    inv, quote = provider_invoice(w)
    issuance = ProviderIssuanceService(db_session)
    row = issuance.begin(inv, quote, w["maker"].id)                    # in flight
    db_session.commit()
    assert row.state in (OutboxState.PENDING, OutboxState.UNCERTAIN)
    _to_estimate(w)
    issuance.reconcile()                                               # finishes under the connection it started on
    db_session.refresh(row)
    db_session.refresh(inv)
    assert row.state == OutboxState.DONE and inv.status == InvoiceStatus.SENT
    nxt, _q = provider_invoice(w)
    with pytest.raises(ProviderIssuanceBlocked, match="estimate-only"):
        issue_via_connection(w, nxt)                                   # new issuing stops
    assert db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.invoice_id == nxt.id).count() == 0


# ── the guard: mode changes only through the flow ───────────────────────

def test_mode_cannot_be_written_directly(db_session, w):
    conn = w["connection"]
    conn.mode = "ESTIMATE_ONLY"
    with pytest.raises(TaxRecordFrozenError):
        db_session.flush()
    db_session.rollback()
    w["svc"].request_mode_change(w["org"].id, w["maker"].id, conn.id, ProviderMode.ESTIMATE_ONLY, "pause")
    conn.mode, conn.mode_changed_by = "ESTIMATE_ONLY", w["maker"].id                # the requester as decider
    conn.mode_changed_at = conn.mode_change_requested_at
    with pytest.raises(TaxRecordFrozenError):
        db_session.flush()
    db_session.rollback()


# ── evidence bundle (gate 06) ───────────────────────────────────────────

def test_the_connection_bundle_carries_the_mode_change(db_session, client_for, w):
    conn = w["connection"]
    _to_estimate(w)
    body = client_for(w["checker"]).get(f"/api/v1/tax/evidence-bundles/provider_connection/{conn.id}").json()
    assert body["kind"] == "provider_connection" and verify(body)
    changes = [h["details"]["mode_change"] for h in body["history"] if (h["details"] or {}).get("mode_change")]
    assert [c["event"] for c in changes] == ["requested", "approved"]
    assert body["approvals"]["mode_changed_by"]["user_id"] == w["checker"].id
    assert "fake-sandbox-credential" not in str(body)                   # never the secret
