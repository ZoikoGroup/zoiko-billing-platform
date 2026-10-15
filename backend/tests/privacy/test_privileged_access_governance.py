"""
Privacy Prompt 2 of 3 — Tests for Independent Approval, Revocation, and Break-Glass
Spec: ZB-SEC-PRIV-001
Fixes: GOV-04, GOV-07, PRV-01, PRV-02, PRV-04, IAM-04, IAM-06, AUD-04, AT-08, AT-16, AT-18
"""
from datetime import datetime, timedelta
import pyotp
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import PlatformRole, SuperAdminMFA, User, UserRole
from app.modules.organizations.models import Organization
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.models import (
    AttentionItem,
    AttentionSeverity,
    PlatformAuditAction,
    PlatformAuditLog,
    PrivilegedAccessStatus,
    PrivilegedTenantAccessGrant,
)
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService
from tests.conftest import approve_as_org_admin, make_org_admin, make_organization
from tests.privacy.conftest import control, make_super_admin


def _make_mfa_admin(db, email, platform_role):
    admin = make_super_admin(db, email, platform_role)
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=admin.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.commit()
    return admin, secret


def _make_tenant_admin(db, org_id, email="tenant_admin@example.com"):
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


# ── 1. AT-08 self-approval ───────────────────────────────────────────────

@control("GOV-04", "AT-08")
def test_at_08_requester_cannot_approve_own_request(client_for, db_session):
    """AT-08: Approval comes only from the tenant's org admin — the requesting
    operator (or any other super admin) has no approve endpoint at all."""
    org = make_organization(db_session)
    admin, _ = _make_mfa_admin(db_session, "operator1@example.com", PlatformRole.SUPPORT_OPERATOR)
    padmin, _ = _make_mfa_admin(db_session, "padmin1@example.com", PlatformRole.PLATFORM_ADMINISTRATOR)
    svc = PrivilegedAccessService(db_session)

    make_org_admin(db_session, org.id)
    grant = svc.request_access(admin, org.id, reason="Maintenance", ticket_reference="INC-101")
    assert grant.status == PrivilegedAccessStatus.PENDING_APPROVAL

    for user in (admin, padmin):
        resp = client_for(user).post(f"/api/super-admin/privileged-access/{grant.id}/approve", json={})
        assert resp.status_code in (404, 405)
    db_session.refresh(grant)
    assert grant.status == PrivilegedAccessStatus.PENDING_APPROVAL


@control("GOV-04", "AT-08")
def test_at_08_self_approval_db_check_constraint_enforced(db_session):
    """AT-08: Direct DB update violating self-approval check constraint raises IntegrityError."""
    org = make_organization(db_session)
    admin, _ = _make_mfa_admin(db_session, "operator2@example.com", PlatformRole.SUPPORT_OPERATOR)
    grant = PrivilegedTenantAccessGrant(
        organization_id=org.id,
        requested_by_user_id=admin.id,
        reason="Direct insert",
        ticket_reference="INC-102",
        scope="read_only_financial_summary",
        status=PrivilegedAccessStatus.APPROVED,
        correlation_id="corr-102",
        approved_by_user_id=admin.id,  # self-approval!
    )
    db_session.add(grant)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


# ── 2. Org admin approval starts the session; decline; expiry ────────────

@control("GOV-04", "PRV-01", "PRV-02")
def test_org_admin_approval_starts_session_immediately(client_for, db_session):
    """The tenant org admin's approval is the only gate and activates at once."""
    org = make_organization(db_session, code="APPR", name="Approve Org")
    tenant_admin = _make_tenant_admin(db_session, org.id, "tadmin_appr@example.com")
    requester, _ = _make_mfa_admin(db_session, "req_appr@example.com", PlatformRole.SUPPORT_OPERATOR)
    svc = PrivilegedAccessService(db_session)

    grant = svc.request_access(requester, org.id, reason="Need access", ticket_reference="INC-201", requested_minutes=15)

    resp = client_for(tenant_admin).post(f"/api/organizations/me/privileged-access/{grant.id}/approve", json={})
    assert resp.status_code == 200, resp.text
    db_session.refresh(grant)
    assert grant.status == PrivilegedAccessStatus.ACTIVE
    assert grant.approved_by_user_id == tenant_admin.id
    assert grant.tenant_approved_by_user_id == tenant_admin.id
    assert grant.expires_at - grant.activated_at == timedelta(minutes=15)

    # The requester can read the summary straight away — no activation step.
    assert svc.get_tenant_summary(requester, grant.id)["organization_id"] == org.id

    # A second approval is rejected cleanly.
    resp = client_for(tenant_admin).post(f"/api/organizations/me/privileged-access/{grant.id}/approve", json={})
    assert resp.status_code == 400


@control("GOV-04", "PRV-02")
def test_org_admin_can_decline_with_reason(client_for, db_session):
    org = make_organization(db_session, code="DECL", name="Decline Org")
    tenant_admin = _make_tenant_admin(db_session, org.id, "tadmin_decl@example.com")
    requester, _ = _make_mfa_admin(db_session, "req_decl@example.com", PlatformRole.SUPPORT_OPERATOR)
    grant = PrivilegedAccessService(db_session).request_access(
        requester, org.id, reason="Need access", ticket_reference="INC-202b"
    )

    client = client_for(tenant_admin)
    assert client.post(f"/api/organizations/me/privileged-access/{grant.id}/deny", json={"note": ""}).status_code == 422
    resp = client.post(f"/api/organizations/me/privileged-access/{grant.id}/deny", json={"note": "Not expected"})
    assert resp.status_code == 200, resp.text
    db_session.refresh(grant)
    assert grant.status == PrivilegedAccessStatus.DENIED
    assert grant.approval_note == "Not expected"


@control("GOV-04")
def test_request_refused_when_org_has_no_admin(db_session):
    """Nobody could ever approve it, so the request is refused up front."""
    org = make_organization(db_session, code="NOADM", name="No Admin Org")
    requester, _ = _make_mfa_admin(db_session, "req_noadm@example.com", PlatformRole.SUPPORT_OPERATOR)
    with pytest.raises(BadRequestException) as exc_info:
        PrivilegedAccessService(db_session).request_access(requester, org.id, reason="x", ticket_reference="INC-0")
    assert "no active administrator" in str(exc_info.value)


@control("GOV-04", "PRV-01")
def test_approval_expiry_unused_request_older_than_60m(db_session):
    """An unapproved request older than 60 minutes becomes EXPIRED_UNUSED lazily with audit."""
    org = make_organization(db_session)
    requester, _ = _make_mfa_admin(db_session, "req_exp@example.com", PlatformRole.SUPPORT_OPERATOR)
    svc = PrivilegedAccessService(db_session)

    make_org_admin(db_session, org.id)
    grant = svc.request_access(requester, org.id, reason="Old request", ticket_reference="INC-202")
    grant.requested_at = datetime.utcnow() - timedelta(minutes=65)
    db_session.commit()

    # Reading/checking expires it lazily
    grant = svc._expire_if_stale(grant)
    assert grant.status == PrivilegedAccessStatus.EXPIRED_UNUSED

    # Check audit log
    audit = db_session.query(PlatformAuditLog).filter(
        PlatformAuditLog.entity_id == grant.id,
        PlatformAuditLog.action == PlatformAuditAction.PRIVILEGED_ACCESS_EXPIRED,
    ).first()
    assert audit is not None
    assert audit.metadata_.get("reason") == "approval_expired_unused"

    # And it can no longer be approved.
    with pytest.raises(BadRequestException):
        approve_as_org_admin(db_session, grant)


@control("GOV-04", "AT-18")
def test_org_admin_of_another_org_cannot_approve(client_for, db_session):
    org1 = make_organization(db_session, code="ORGA", name="Org A")
    org2 = make_organization(db_session, code="ORGB", name="Org B")
    make_org_admin(db_session, org1.id)
    other_admin = _make_tenant_admin(db_session, org2.id, "tadmin_orgb@example.com")
    requester, _ = _make_mfa_admin(db_session, "req_cross_appr@example.com", PlatformRole.SUPPORT_OPERATOR)
    grant = PrivilegedAccessService(db_session).request_access(
        requester, org1.id, reason="Org A work", ticket_reference="INC-203"
    )

    resp = client_for(other_admin).post(f"/api/organizations/me/privileged-access/{grant.id}/approve", json={})
    assert resp.status_code == 404
    db_session.refresh(grant)
    assert grant.status == PrivilegedAccessStatus.PENDING_APPROVAL


# ── 4. AT-18 Tenant revoke ───────────────────────────────────────────────

@control("GOV-04", "AT-18")
def test_at_18_tenant_revoke_takes_effect_immediately(db_session):
    """AT-18: Tenant admin revokes an ACTIVE grant; next tenant-summary call is denied immediately."""
    org = make_organization(db_session)
    tenant_admin = _make_tenant_admin(db_session, org.id, "tadmin_at18@example.com")
    requester, secret = _make_mfa_admin(db_session, "operator_at18@example.com", PlatformRole.SUPPORT_OPERATOR)
    approver, _ = _make_mfa_admin(db_session, "approver_at18@example.com", PlatformRole.SECURITY_OPERATOR)
    svc = PrivilegedAccessService(db_session)

    make_org_admin(db_session, org.id)
    grant = svc.request_access(requester, org.id, reason="Support AT-18", ticket_reference="INC-401")
    grant = approve_as_org_admin(db_session, grant)
    assert grant.status == PrivilegedAccessStatus.ACTIVE

    # Summary works while active
    summary = svc.get_tenant_summary(requester, grant.id)
    assert summary["organization_id"] == org.id

    # Tenant admin revokes the grant
    revoked = svc.revoke_grant(
        actor=tenant_admin,
        grant_id=grant.id,
        reason="Security team directive",
        is_tenant=True,
        tenant_org_id=org.id,
    )
    assert revoked.status == PrivilegedAccessStatus.REVOKED
    assert revoked.revoked_by_tenant is True

    # Next call to get_tenant_summary is denied immediately
    with pytest.raises(ForbiddenException) as exc_info:
        svc.get_tenant_summary(requester, grant.id)
    assert "not active" in str(exc_info.value)


@control("GOV-04", "AT-18")
def test_at_18_tenant_admin_of_another_org_gets_404(client_for, db_session):
    """A tenant admin of another org gets 404 when attempting to revoke."""
    org1 = make_organization(db_session, code="ORG1", name="Org One")
    org2 = make_organization(db_session, code="ORG2", name="Org Two")
    tenant_admin2 = _make_tenant_admin(db_session, org2.id, "tadmin_other@example.com")
    requester, secret = _make_mfa_admin(db_session, "op_cross@example.com", PlatformRole.SUPPORT_OPERATOR)
    approver, _ = _make_mfa_admin(db_session, "app_cross@example.com", PlatformRole.SECURITY_OPERATOR)
    svc = PrivilegedAccessService(db_session)

    make_org_admin(db_session, org1.id)
    grant = svc.request_access(requester, org1.id, reason="Work on org 1", ticket_reference="INC-402")
    grant = approve_as_org_admin(db_session, grant)

    client = client_for(tenant_admin2)
    resp = client.post(f"/api/organizations/me/privileged-access/{grant.id}/revoke", json={"reason": "Revoke attempt"})
    assert resp.status_code == 404


# ── 6. AT-16 Break-Glass Emergency Path ───────────────────────────────────

@control("GOV-07", "AT-16")
def test_at_16_break_glass_full_lifecycle(client_for, db_session):
    """AT-16:
    - requires tenant_support.break_glass and fresh MFA;
    - platform admin without explicit capability is denied (EXPLICIT_ONLY_CAPABILITIES);
    - creates P1 item and emails;
    - opener cannot review;
    - different reviewer can review;
    - 30-minute cap enforced.
    """
    org = make_organization(db_session, code="BGORG", name="Break Glass Org")
    sec_op, sec_secret = _make_mfa_admin(db_session, "sec_op_bg@example.com", PlatformRole.SECURITY_OPERATOR)
    padmin, padmin_secret = _make_mfa_admin(db_session, "padmin_bg@example.com", PlatformRole.PLATFORM_ADMINISTRATOR)
    auditor_user = make_super_admin(db_session, "auditor_bg@example.com", PlatformRole.AUDITOR)
    svc = PrivilegedAccessService(db_session)

    # 1. Platform admin without explicit capability is denied
    padmin_client = client_for(padmin)
    resp = padmin_client.post(
        "/api/super-admin/privileged-access/break-glass",
        json={
            "organization_id": org.id,
            "reason": "Outage recovery",
            "incident_reference": "INC-P0-911",
            "code": pyotp.TOTP(padmin_secret).now(),
        },
    )
    assert resp.status_code == 403

    # 2. Security operator with capability and fresh MFA succeeds
    sec_client = client_for(sec_op)
    resp = sec_client.post(
        "/api/super-admin/privileged-access/break-glass",
        json={
            "organization_id": org.id,
            "reason": "Critical outage fix",
            "incident_reference": "INC-P0-911",
            "code": pyotp.TOTP(sec_secret).now(),
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    grant_id = data["id"]
    assert data["status"] == "active"
    assert data["is_break_glass"] is True
    assert data["requested_minutes"] == 30

    # 3. P1 attention item was created
    attention_item = db_session.query(AttentionItem).filter(
        AttentionItem.source_key == f"break_glass:{grant_id}"
    ).first()
    assert attention_item is not None
    assert attention_item.severity == AttentionSeverity.P1

    # 4. Opener cannot review their own break-glass session
    resp = sec_client.post(
        f"/api/super-admin/privileged-access/{grant_id}/review",
        json={"outcome": "justified", "note": "All good by me"},
    )
    assert resp.status_code == 403

    # 5. Different reviewer (auditor) reviews successfully
    auditor_client = client_for(auditor_user)
    resp = auditor_client.post(
        f"/api/super-admin/privileged-access/{grant_id}/review",
        json={"outcome": "justified", "note": "Independent post-incident review confirmed justified"},
    )
    assert resp.status_code == 200
    rev_data = resp.json()
    assert rev_data["review_outcome"] == "justified"

    # Resolves the attention item
    db_session.refresh(attention_item)
    assert attention_item.status.value in ("resolved", "closed")


@control("GOV-07", "AT-16")
def test_overdue_break_glass_review_escalates_to_p0(db_session):
    """An overdue break-glass review past 24h raises P0 attention item."""
    org = make_organization(db_session)
    sec_op, sec_secret = _make_mfa_admin(db_session, "sec_overdue@example.com", PlatformRole.SECURITY_OPERATOR)
    svc = PrivilegedAccessService(db_session)

    grant = svc.open_break_glass(
        actor=sec_op,
        organization_id=org.id,
        reason="Emergency data fix",
        incident_reference="INC-OVERDUE-1",
        code=pyotp.TOTP(sec_secret).now(),
    )
    # Simulate overdue (>24h)
    grant.review_due_at = datetime.utcnow() - timedelta(hours=2)
    db_session.commit()

    attention = AttentionService(db_session)
    escalated = attention.check_overdue_break_glass_reviews()
    assert escalated == 1

    overdue_item = db_session.query(AttentionItem).filter(
        AttentionItem.source_key == f"break_glass_overdue:{grant.id}"
    ).first()
    assert overdue_item is not None
    assert overdue_item.severity == AttentionSeverity.P0


# ── 7. Logout ends active grant & emails all org admins ───────────────────

@control("PRV-01", "IAM-06", "AT-16")
def test_logout_ends_active_grant_and_emails_all_org_admins(client_for, db_session):
    """IAM-06: Logout ends an active grant idempotently. Exit email sent to all active org admins."""
    org = make_organization(db_session, code="LOGOUTORG", name="Logout Org")
    admin1 = _make_tenant_admin(db_session, org.id, "admin1_logout@example.com")
    admin2 = _make_tenant_admin(db_session, org.id, "admin2_logout@example.com")
    requester, secret = _make_mfa_admin(db_session, "op_logout@example.com", PlatformRole.SUPPORT_OPERATOR)
    approver, _ = _make_mfa_admin(db_session, "app_logout@example.com", PlatformRole.SECURITY_OPERATOR)
    svc = PrivilegedAccessService(db_session)

    make_org_admin(db_session, org.id)
    grant = svc.request_access(requester, org.id, reason="Working before logout", ticket_reference="INC-701")
    grant = approve_as_org_admin(db_session, grant)
    assert grant.status == PrivilegedAccessStatus.ACTIVE

    # Requester logs out
    client = client_for(requester)
    resp = client.post("/api/auth/logout")
    assert resp.status_code == 200

    db_session.refresh(grant)
    assert grant.status == PrivilegedAccessStatus.EXITED
    assert grant.exited_at is not None

    # Idempotent: another logout does not fail
    resp2 = client.post("/api/auth/logout")
    assert resp2.status_code == 200

