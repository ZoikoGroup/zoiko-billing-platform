"""
tests/test_super_admin_command_center.py
-------------------------------------------
ZB-SA-CMD-003 — Domain B (privileged tenant access) and Domain C
(cross-tenant telemetry) + the Attention Engine.

Mandated coverage (per the implementation session's security review):
  1. valid grant request -> MFA step-up -> activation
  2. duplicate live grant rejected
  3-5. cross-actor IDOR denied on tenant-summary / exit / activate
  6. a grant is strictly scoped to its own organization
  7. post-exit (revoked) access denied
  8. wrong TOTP code rejected
  9. stale step-up window rejected (auto-DENIED, not left pending forever)
  10. expired grant lazily denied on next read
  11. full audit trail for the lifecycle (requested/granted/viewed/exited/expired)
  12. audit rows carry correlation_id + reason + organization_id
  13. Attention Engine: real job failure opens an item, escalates after
      repeated occurrences, auto-resolves on recovery, and reopens (not
      duplicates) on a later failure
  14. Attention Engine: kill-switch disable/re-enable reports/auto-resolves
  15. Attention Engine: full operator lifecycle (acknowledge/assign/
      transition/resolve/suppress) with correct forward-transition rules
  16. Telemetry: organization health counts are non-financial and accurate
  17. Telemetry: job freshness state machine (fresh/stale/unknown)

Runs against the isolated in-memory SQLite fixture (db_session), matching
every other test in this suite — never BILLING_DATABASE_URL.
"""

from datetime import datetime, timedelta

import pyotp
import pytest

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException
from app.core.mfa_crypto import encrypt_secret
from app.modules.auth.models import SuperAdminMFA, User, UserRole
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.kill_switch_service import BillingKillSwitchService
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus, PlatformAuditLog
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService
from app.modules.super_admin.telemetry_service import TelemetryService
from tests.conftest import make_organization


def _super_admin(db, email="sa@cmdcenter.example"):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="Super", last_name="Admin", is_active=True, is_verified=True,
    )
    db.add(user)
    db.flush()
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.flush()
    return user, secret


# ── Domain B lifecycle ──────────────────────────────────────────────────

def test_valid_grant_request_and_activation(db_session):
    org = make_organization(db_session)
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)

    grant = svc.request_access(admin, org.id, reason="Investigating INC-1", ticket_reference="INC-1")
    assert grant.status.value == "pending_step_up"

    grant = svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    assert grant.status.value == "active"
    assert grant.expires_at is not None
    assert grant.expires_at <= datetime.utcnow() + timedelta(minutes=30, seconds=5)


def test_duplicate_live_grant_rejected(db_session):
    org = make_organization(db_session)
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)
    svc.request_access(admin, org.id, reason="r", ticket_reference="INC-1")

    with pytest.raises(BadRequestException):
        svc.request_access(admin, org.id, reason="r2", ticket_reference="INC-2")


def test_cross_actor_idor_denied(db_session):
    org = make_organization(db_session)
    admin1, secret1 = _super_admin(db_session, "sa1@cmdcenter.example")
    admin2, secret2 = _super_admin(db_session, "sa2@cmdcenter.example")
    svc = PrivilegedAccessService(db_session)

    grant = svc.request_access(admin1, org.id, reason="r", ticket_reference="INC-1")
    grant = svc.activate(admin1, grant.id, code=pyotp.TOTP(secret1).now())

    with pytest.raises(NotFoundException):
        svc.get_tenant_summary(admin2, grant.id)
    with pytest.raises(NotFoundException):
        svc.exit_grant(admin2, grant.id)
    with pytest.raises(NotFoundException):
        svc.activate(admin2, grant.id, code=pyotp.TOTP(secret2).now())


def test_grant_scoped_to_its_own_organization(db_session):
    org_a = make_organization(db_session, code="ORGA", name="Tenant A")
    make_organization(db_session, code="ORGB", name="Tenant B")
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)

    grant = svc.request_access(admin, org_a.id, reason="r", ticket_reference="INC-1")
    grant = svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    summary = svc.get_tenant_summary(admin, grant.id)

    assert summary["organization_id"] == org_a.id
    assert summary["organization_name"] == "Tenant A"


def test_post_exit_access_denied(db_session):
    org = make_organization(db_session)
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)

    grant = svc.request_access(admin, org.id, reason="r", ticket_reference="INC-1")
    grant = svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    svc.exit_grant(admin, grant.id)

    with pytest.raises(ForbiddenException):
        svc.get_tenant_summary(admin, grant.id)


def test_wrong_totp_code_rejected(db_session):
    org = make_organization(db_session)
    admin, _secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)
    grant = svc.request_access(admin, org.id, reason="r", ticket_reference="INC-1")

    with pytest.raises(UnauthorizedException):
        svc.activate(admin, grant.id, code="000000")


def test_stale_step_up_window_denied(db_session):
    org = make_organization(db_session)
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)
    grant = svc.request_access(admin, org.id, reason="r", ticket_reference="INC-1")
    grant.requested_at = datetime.utcnow() - timedelta(minutes=10)
    db_session.commit()

    with pytest.raises(BadRequestException):
        svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    db_session.refresh(grant)
    assert grant.status.value == "denied"

    # Self-healing: a fresh request is allowed once the prior one is DENIED.
    grant2 = svc.request_access(admin, org.id, reason="r2", ticket_reference="INC-2")
    assert grant2.status.value == "pending_step_up"


def test_expired_grant_denied_on_next_read(db_session):
    org = make_organization(db_session)
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)
    grant = svc.request_access(admin, org.id, reason="r", ticket_reference="INC-1")
    grant = svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    grant.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    with pytest.raises(ForbiddenException):
        svc.get_tenant_summary(admin, grant.id)
    db_session.refresh(grant)
    assert grant.status.value == "expired"


def test_audit_trail_complete_and_correlated(db_session):
    org = make_organization(db_session)
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)
    grant = svc.request_access(admin, org.id, reason="Investigating INC-9", ticket_reference="INC-9")
    grant = svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    svc.get_tenant_summary(admin, grant.id)
    svc.exit_grant(admin, grant.id)

    rows = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.entity_type == "PrivilegedTenantAccessGrant", PlatformAuditLog.entity_id == grant.id)
        .all()
    )
    actions = {r.action.value for r in rows}
    assert {"privileged_access_requested", "privileged_access_granted", "privileged_access_viewed", "privileged_access_exited"}.issubset(actions)
    for row in rows:
        assert row.correlation_id == grant.correlation_id
        assert row.organization_id == org.id
    requested_row = next(r for r in rows if r.action.value == "privileged_access_requested")
    assert requested_row.reason == "Investigating INC-9"


# ── Attention Engine ─────────────────────────────────────────────────────

def test_attention_job_failure_lifecycle(db_session):
    svc = AttentionService(db_session)

    item = svc.report_or_update(
        source="job_failure", source_key="job:flaky", title="Flaky job failing",
        description="boom", base_severity=AttentionSeverity.P2, escalate_after_occurrences=3,
    )
    assert item.status == AttentionStatus.OPEN
    assert item.severity == AttentionSeverity.P2
    assert item.occurrence_count == 1
    assert item.correlation_id

    for _ in range(2):
        item = svc.report_or_update(
            source="job_failure", source_key="job:flaky", title="Flaky job failing",
            description="boom", base_severity=AttentionSeverity.P2, escalate_after_occurrences=3,
        )
    assert item.occurrence_count == 3
    assert item.severity == AttentionSeverity.P1  # escalated after 3 occurrences

    resolved = svc.auto_resolve(source="job_failure", source_key="job:flaky")
    assert resolved.status == AttentionStatus.RESOLVED
    assert resolved.resolution_code == "auto_cleared"

    reopened = svc.report_or_update(
        source="job_failure", source_key="job:flaky", title="Flaky job failing again",
        base_severity=AttentionSeverity.P2,
    )
    assert reopened.id == item.id  # same row reopened, not a duplicate
    assert reopened.status == AttentionStatus.OPEN
    assert reopened.reopened_at is not None
    assert reopened.occurrence_count == 4  # history preserved, not reset

    only_one_row = db_session.query(AttentionItem).filter(AttentionItem.source_key == "job:flaky").count()
    assert only_one_row == 1


def test_attention_kill_switch_signal(db_session):
    admin, _secret = _super_admin(db_session)
    kss = BillingKillSwitchService(db_session)

    kss.set_enabled("commercial_subscription_charging", False, reason="manual test", actor_id=admin.id)
    item = db_session.query(AttentionItem).filter(AttentionItem.source_key == "kill_switch:commercial_subscription_charging").first()
    assert item is not None
    assert item.severity == AttentionSeverity.P1
    assert item.status == AttentionStatus.OPEN

    kss.set_enabled("commercial_subscription_charging", True, reason="re-enable", actor_id=admin.id)
    db_session.refresh(item)
    assert item.status == AttentionStatus.RESOLVED


def test_attention_operator_lifecycle(db_session):
    admin, _secret = _super_admin(db_session)
    svc = AttentionService(db_session)
    item = svc.report_or_update(source="manual", source_key="manual:t1", title="Test issue", base_severity=AttentionSeverity.P2)

    item = svc.acknowledge(admin, item.id)
    assert item.status == AttentionStatus.ACKNOWLEDGED

    item = svc.assign(admin, item.id, admin.id)
    assert item.status == AttentionStatus.ASSIGNED
    assert item.owner_user_id == admin.id

    item = svc.transition(admin, item.id, AttentionStatus.MITIGATING)
    assert item.status == AttentionStatus.MITIGATING

    # Re-assigning from MITIGATING must not regress status backward.
    item = svc.assign(admin, item.id, admin.id)
    assert item.status == AttentionStatus.MITIGATING

    with pytest.raises(BadRequestException):
        svc.transition(admin, item.id, AttentionStatus.RESOLVED)  # missing resolution_code

    item = svc.transition(admin, item.id, AttentionStatus.RESOLVED, resolution_code="fixed")
    assert item.status == AttentionStatus.RESOLVED
    assert item.resolution_code == "fixed"

    item = svc.transition(admin, item.id, AttentionStatus.CLOSED)
    assert item.status == AttentionStatus.CLOSED

    with pytest.raises(BadRequestException):
        svc.transition(admin, item.id, AttentionStatus.OPEN)  # no transitions out of CLOSED


def test_attention_assign_rejects_nonexistent_owner(db_session):
    admin, _secret = _super_admin(db_session)
    svc = AttentionService(db_session)
    item = svc.report_or_update(source="manual", source_key="manual:t3", title="Test issue", base_severity=AttentionSeverity.P2)

    with pytest.raises(NotFoundException):
        svc.assign(admin, item.id, owner_user_id=999999)


def test_attention_suppress_is_time_bound(db_session):
    admin, _secret = _super_admin(db_session)
    svc = AttentionService(db_session)
    item = svc.report_or_update(source="manual", source_key="manual:t2", title="Noisy issue", base_severity=AttentionSeverity.P3)

    with pytest.raises(BadRequestException):
        svc.suppress(admin, item.id, "", 60)  # reason required
    with pytest.raises(BadRequestException):
        svc.suppress(admin, item.id, "known issue", 0)  # must be time-bound

    item = svc.suppress(admin, item.id, "known issue, tracked separately", 60)
    assert item.status == AttentionStatus.SUPPRESSED
    assert item.suppressed_until is not None

    # Simulate expiry and confirm list_open() lifts it back to OPEN.
    item.suppressed_until = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()
    svc.list_open()
    db_session.refresh(item)
    assert item.status == AttentionStatus.OPEN


# ── Domain C telemetry ───────────────────────────────────────────────────

def test_organization_telemetry_is_non_financial_and_accurate(db_session):
    make_organization(db_session, code="ORG1", name="Org One")
    org2 = make_organization(db_session, code="ORG2", name="Org Two")
    org2.is_active = False
    db_session.commit()

    health = TelemetryService(db_session).get_organization_health()
    assert health == {"total_organizations": 2, "active_organizations": 1, "suspended_organizations": 1}
    # No monetary/financial keys anywhere in the payload.
    assert not any("revenue" in k or "amount" in k or "balance" in k for k in health)


def test_job_freshness_state_machine(db_session):
    from app.modules.super_admin.freshness import FreshnessState, compute_freshness

    state, age = compute_freshness(None, 60)
    assert state == FreshnessState.UNKNOWN and age is None

    state, _ = compute_freshness(datetime.utcnow(), 60)
    assert state == FreshnessState.FRESH

    state, _ = compute_freshness(datetime.utcnow() - timedelta(seconds=180), 60)
    assert state == FreshnessState.STALE  # > 2x(60s) but <= 4x(60s)

    state, _ = compute_freshness(datetime.utcnow() - timedelta(seconds=600), 60)
    assert state == FreshnessState.UNKNOWN  # > 4x(60s) -- never silently healthy


# ── Tenant-visible privileged-access log (ISS-021) ───────────────────────

def test_tenant_visible_access_log_shows_own_sessions(db_session):
    from app.modules.organizations.router import get_my_privileged_access_log

    org = make_organization(db_session)
    tenant_user = User(
        email="billing_admin@tenantlog.example", hashed_password="x", role=UserRole.BILLING_ADMIN,
        organization_id=org.id, first_name="B", last_name="A", is_active=True, is_verified=True,
    )
    db_session.add(tenant_user)
    db_session.commit()
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)

    grant = svc.request_access(admin, org.id, reason="Investigating INC-777", ticket_reference="INC-777")
    grant = svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())
    svc.get_tenant_summary(admin, grant.id)
    svc.exit_grant(admin, grant.id)

    log = get_my_privileged_access_log(limit=50, current_user=tenant_user, db=db_session)
    assert len(log.entries) == 1
    entry = log.entries[0]
    assert entry.status == "exited"
    assert entry.reason == "Investigating INC-777"
    assert entry.ticket_reference == "INC-777"
    assert entry.activated_at is not None and entry.ended_at is not None
    assert entry.correlation_id == grant.correlation_id


def test_tenant_visible_access_log_cross_tenant_isolation(db_session):
    from app.modules.organizations.router import get_my_privileged_access_log

    org_a = make_organization(db_session, code="LOGA", name="Log Org A")
    org_b = make_organization(db_session, code="LOGB", name="Log Org B")
    admin, secret = _super_admin(db_session)
    svc = PrivilegedAccessService(db_session)
    grant = svc.request_access(admin, org_a.id, reason="r", ticket_reference="INC-1")
    svc.activate(admin, grant.id, code=pyotp.TOTP(secret).now())

    user_b = User(
        email="user@orgb.example", hashed_password="x", role=UserRole.BILLING_ADMIN,
        organization_id=org_b.id, first_name="U", last_name="B", is_active=True, is_verified=True,
    )
    db_session.add(user_b)
    db_session.commit()

    log = get_my_privileged_access_log(limit=50, current_user=user_b, db=db_session)
    assert log.entries == []  # Org B never sees Org A's access history
