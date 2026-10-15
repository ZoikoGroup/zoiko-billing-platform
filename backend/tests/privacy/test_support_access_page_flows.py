"""
Support Access page end-to-end flows (ZB-SEC-PRIV-001).

Covers the gaps the /super-admin/support-access page hit in practice:
  - a requester (SUPPORT_OPERATOR) can cancel their own pending request
    without holding tenant_support.revoke;
  - a break-glass opener (SECURITY_OPERATOR) can see, read and exit the
    session they opened;
  - an approved grant that is never activated expires on read, with a clear
    message, and the window starts at the LAST approval;
  - a platform-approved grant awaiting tenant approval leaves the approval
    queue and is flagged as such;
  - revokers get a cross-operator live view.
"""
from datetime import datetime, timedelta

import pyotp
import pytest

from app.core.exceptions import BadRequestException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import PlatformRole, SuperAdminMFA, User, UserRole
from app.modules.super_admin.models import AttentionItem, PrivilegedAccessStatus
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService
from tests.conftest import approve_as_org_admin, make_org_admin, make_organization
from tests.privacy.conftest import make_super_admin


def _make_mfa_admin(db, email, platform_role):
    admin = make_super_admin(db, email, platform_role)
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=admin.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.commit()
    return admin, secret


def _make_tenant_admin(db, org_id, email):
    user = User(
        email=email,
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=org_id,
        first_name="Org",
        last_name="Admin",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.commit()
    return user


def test_requester_can_cancel_own_pending_request(client_for, db_session):
    org = make_organization(db_session, code="CANCELORG", name="Cancel Org")
    requester, _ = _make_mfa_admin(db_session, "cancel_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    other, _ = _make_mfa_admin(db_session, "cancel_other@example.com", PlatformRole.SUPPORT_OPERATOR)
    make_org_admin(db_session, org.id)
    grant = PrivilegedAccessService(db_session).request_access(
        requester, org.id, reason="Investigate invoice", ticket_reference="SUP-1"
    )

    # Another operator cannot cancel it — and cannot even learn it exists.
    resp = client_for(other).post(f"/api/super-admin/privileged-access/{grant.id}/cancel")
    assert resp.status_code == 404

    resp = client_for(requester).post(f"/api/super-admin/privileged-access/{grant.id}/cancel")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "revoked"

    # The approver attention item is resolved with it.
    item = db_session.query(AttentionItem).filter(
        AttentionItem.source_key == f"privileged_access:request:{grant.id}"
    ).first()
    assert item is None or item.status.value in ("resolved", "closed")

    # Cancelling twice is a clear 400, not a crash.
    resp = client_for(requester).post(f"/api/super-admin/privileged-access/{grant.id}/cancel")
    assert resp.status_code == 400


def test_break_glass_opener_can_view_and_exit_own_session(client_for, db_session):
    org = make_organization(db_session, code="BGVIEW", name="BG View Org")
    sec_op, secret = _make_mfa_admin(db_session, "bg_view@example.com", PlatformRole.SECURITY_OPERATOR)
    client = client_for(sec_op)

    resp = client.post(
        "/api/super-admin/privileged-access/break-glass",
        json={
            "organization_id": org.id,
            "reason": "Payment outage",
            "incident_reference": "INC-P1-1",
            "code": pyotp.TOTP(secret).now(),
        },
    )
    assert resp.status_code == 200, resp.text
    grant_id = resp.json()["id"]
    assert resp.json()["organization_code"] == "BGVIEW"

    active = client.get("/api/super-admin/privileged-access/active")
    assert active.status_code == 200
    assert active.json()["id"] == grant_id

    mine = client.get("/api/super-admin/privileged-access/mine")
    assert mine.status_code == 200
    assert [g["id"] for g in mine.json()["grants"]] == [grant_id]

    summary = client.get(f"/api/super-admin/privileged-access/{grant_id}/tenant-summary")
    assert summary.status_code == 200, summary.text

    exited = client.post(f"/api/super-admin/privileged-access/{grant_id}/exit")
    assert exited.status_code == 200
    assert exited.json()["status"] == "exited"


def test_auditor_cannot_reach_own_grant_endpoints(client_for, db_session):
    auditor = make_super_admin(db_session, "aud_mine@example.com", PlatformRole.AUDITOR)
    assert client_for(auditor).get("/api/super-admin/privileged-access/mine").status_code == 403


def test_requester_sees_pending_then_active_after_org_admin_approves(client_for, db_session):
    org = make_organization(db_session, code="TAFLOW", name="Tenant Approval Org")
    tenant_admin = _make_tenant_admin(db_session, org.id, "taflow_admin@example.com")
    requester, _ = _make_mfa_admin(db_session, "taflow_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    svc = PrivilegedAccessService(db_session)
    client = client_for(requester)

    grant = svc.request_access(requester, org.id, reason="Needs tenant OK", ticket_reference="SUP-4")
    mine = client.get("/api/super-admin/privileged-access/mine").json()["grants"]
    assert mine[0]["status"] == "pending_approval"
    assert mine[0]["awaiting_tenant_approval"] is True
    assert mine[0]["approval_expires_at"] is not None

    svc.tenant_approve_grant(tenant_admin, org.id, grant.id)
    active = client.get("/api/super-admin/privileged-access/active").json()
    assert active["status"] == "active"
    assert active["approved_by_email"] == "taflow_admin@example.com"
    assert active["awaiting_tenant_approval"] is False


def test_live_grants_view_for_revokers(client_for, db_session):
    org = make_organization(db_session, code="LIVEORG", name="Live Org")
    requester, _ = _make_mfa_admin(db_session, "live_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    sec_op, _ = _make_mfa_admin(db_session, "live_sec@example.com", PlatformRole.SECURITY_OPERATOR)
    make_org_admin(db_session, org.id)
    grant = PrivilegedAccessService(db_session).request_access(
        requester, org.id, reason="Live view", ticket_reference="SUP-5"
    )

    assert client_for(requester).get("/api/super-admin/privileged-access/live").status_code == 403

    resp = client_for(sec_op).get("/api/super-admin/privileged-access/live")
    assert resp.status_code == 200
    rows = resp.json()["grants"]
    assert [r["id"] for r in rows] == [grant.id]
    assert rows[0]["requested_by_email"] == "live_req@example.com"
    assert rows[0]["approval_expires_at"] is not None


def test_legacy_pending_step_up_grant_is_retired_and_unblocks_requests(db_session):
    org = make_organization(db_session, code="LEGACY", name="Legacy Org")
    requester, _ = _make_mfa_admin(db_session, "legacy_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    svc = PrivilegedAccessService(db_session)
    make_org_admin(db_session, org.id)
    grant = svc.request_access(requester, org.id, reason="Old flow", ticket_reference="SUP-OLD")
    # A row left over from the pre-approval flow.
    grant.status = PrivilegedAccessStatus.PENDING_STEP_UP
    db_session.commit()

    assert svc.get_active_or_pending_grant(requester) is None
    assert grant.status == PrivilegedAccessStatus.EXPIRED_UNUSED

    make_org_admin(db_session, org.id)
    fresh = svc.request_access(requester, org.id, reason="New request", ticket_reference="SUP-NEW")
    assert fresh.status == PrivilegedAccessStatus.PENDING_APPROVAL


# ── Temporary tenant credentials issued on org-admin approval ────────────

def _real_auth_client(db_session):
    """A client that authenticates with real bearer tokens (no user override)."""
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.main import app

    from app.core.dependencies import get_current_user

    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app, raise_server_exceptions=False)


def _login(client, username, password):
    return client.post("/api/auth/login", json={"email": username, "password": password})


def test_org_admin_approval_issues_working_temporary_login(client_for, db_session):
    from app.database import get_db
    from app.main import app

    org = make_organization(db_session, code="CREDS", name="Creds Org")
    tenant_admin = _make_tenant_admin(db_session, org.id, "creds_admin@example.com")
    requester, _ = _make_mfa_admin(db_session, "creds_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    grant = PrivilegedAccessService(db_session).request_access(
        requester, org.id, reason="Customer ticket", ticket_reference="SUP-77", requested_minutes=15
    )

    # Nothing to read before the organization approves.
    assert client_for(requester).get(f"/api/super-admin/privileged-access/{grant.id}/credentials").status_code == 403

    assert client_for(tenant_admin).post(
        f"/api/organizations/me/privileged-access/{grant.id}/approve", json={}
    ).status_code == 200

    creds = client_for(requester).get(f"/api/super-admin/privileged-access/{grant.id}/credentials")
    assert creds.status_code == 200, creds.text
    data = creds.json()
    assert data["username"].startswith(f"support-{grant.id}-")
    assert len(data["password"]) >= 12
    assert data["access"] == "Read-only"

    # Another operator cannot read them.
    other, _ = _make_mfa_admin(db_session, "creds_other@example.com", PlatformRole.SUPPORT_OPERATOR)
    assert client_for(other).get(f"/api/super-admin/privileged-access/{grant.id}/credentials").status_code == 404

    # The org admin sees which account support is using.
    log = client_for(tenant_admin).get("/api/organizations/me/privileged-access-log").json()["entries"]
    assert log[0]["support_username"] == data["username"]

    try:
        client = _real_auth_client(db_session)
        login = _login(client, data["username"], data["password"])
        assert login.status_code == 200, login.text
        token = login.json()["access_token"]
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200
        assert me.json()["role"] == "auditor"
        assert me.json()["organization_id"] == org.id

        # The operator ends the session: the login and the live token both die.
        PrivilegedAccessService(db_session).exit_grant(requester, grant.id)
        assert _login(client, data["username"], data["password"]).status_code == 401
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_temporary_login_stops_at_expiry_even_before_the_sweep(db_session):
    from app.database import get_db
    from app.main import app
    from app.modules.auth.models import User

    org = make_organization(db_session, code="EXPC", name="Expiry Creds Org")
    make_org_admin(db_session, org.id)
    requester, _ = _make_mfa_admin(db_session, "expc_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    svc = PrivilegedAccessService(db_session)
    grant = svc.request_access(requester, org.id, reason="x", ticket_reference="SUP-78", requested_minutes=5)
    grant = approve_as_org_admin(db_session, grant)
    creds = svc.get_support_credentials(requester, grant.id)

    try:
        client = _real_auth_client(db_session)
        token = _login(client, creds["username"], creds["password"]).json()["access_token"]

        # Time passes: the account is past its expiry but nothing has swept it yet.
        account = db_session.query(User).filter(User.id == grant.support_user_id).first()
        account.access_expires_at = datetime.utcnow() - timedelta(seconds=1)
        db_session.commit()
        assert account.is_active is True

        resp = _login(client, creds["username"], creds["password"])
        assert resp.status_code == 401
        assert "temporary support access has ended" in resp.json()["message"]
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    finally:
        app.dependency_overrides.pop(get_db, None)

    # The sweep then records it: grant expired, account switched off, password dropped.
    grant.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert svc.expire_due_grants() == 1
    db_session.refresh(grant)
    db_session.refresh(account)
    assert grant.status == PrivilegedAccessStatus.EXPIRED
    assert account.is_active is False
    assert grant.support_password_encrypted is None


def test_tenant_revoke_switches_off_temporary_login(db_session):
    from app.modules.auth.models import User

    org = make_organization(db_session, code="REVC", name="Revoke Creds Org")
    tenant_admin = make_org_admin(db_session, org.id)
    requester, _ = _make_mfa_admin(db_session, "revc_req@example.com", PlatformRole.SUPPORT_OPERATOR)
    svc = PrivilegedAccessService(db_session)
    grant = approve_as_org_admin(
        db_session, svc.request_access(requester, org.id, reason="x", ticket_reference="SUP-79")
    )

    svc.revoke_grant(tenant_admin, grant.id, reason="Done", is_tenant=True, tenant_org_id=org.id)
    account = db_session.query(User).filter(User.id == grant.support_user_id).first()
    assert account.is_active is False
    with pytest.raises(Exception):
        svc.get_support_credentials(requester, grant.id)


def test_break_glass_also_issues_temporary_login(client_for, db_session):
    org = make_organization(db_session, code="BGC", name="BG Creds Org")
    sec_op, secret = _make_mfa_admin(db_session, "bgc@example.com", PlatformRole.SECURITY_OPERATOR)
    resp = client_for(sec_op).post(
        "/api/super-admin/privileged-access/break-glass",
        json={"organization_id": org.id, "reason": "Outage", "incident_reference": "INC-1", "code": pyotp.TOTP(secret).now()},
    )
    assert resp.status_code == 200, resp.text
    creds = client_for(sec_op).get(f"/api/super-admin/privileged-access/{resp.json()['id']}/credentials")
    assert creds.status_code == 200
    assert creds.json()["username"].startswith("support-")
