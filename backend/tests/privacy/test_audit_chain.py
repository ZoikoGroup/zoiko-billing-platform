"""
tests/privacy/test_audit_chain.py
---------------------------------
ZB-SEC-PRIV-001 §AUD-01: Tamper-evident cryptographic hash chain for platform audit log.
"""

import pytest

from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.organizations.models import Organization
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from tests.privacy.conftest import control, make_super_admin


@control("AUD-01")
def test_genesis_first_row(db_session):
    audit_svc = PlatformAuditService(db_session)
    entry = audit_svc.log_no_commit(
        actor_id=None,
        action=PlatformAuditAction.PLATFORM_ACCESS_DENIED,
        entity_type="test",
        entity_id=1,
        reason="First entry",
    )
    db_session.commit()

    assert entry.prev_hash == "GENESIS"
    assert entry.row_hash is not None
    assert len(entry.row_hash) == 64


@control("AUD-01")
def test_chain_verifies_after_writes(db_session):
    audit_svc = PlatformAuditService(db_session)

    # Write 5 consecutive audit entries
    entries = []
    for i in range(5):
        entry = audit_svc.log_no_commit(
            actor_id=None,
            action=PlatformAuditAction.UPDATE,
            entity_type="BillingKillSwitch",
            entity_id=i + 1,
            reason=f"Action step {i}",
        )
        db_session.commit()
        entries.append(entry)

    # Verify chain links
    assert entries[0].prev_hash == "GENESIS"
    for i in range(1, 5):
        assert entries[i].prev_hash == entries[i - 1].row_hash

    # verify_audit_chain should return None (valid chain)
    broken_id = PlatformAuditService.verify_audit_chain(db_session)
    assert broken_id is None


@control("AUD-01")
def test_modified_row_breaks_chain(db_session):
    audit_svc = PlatformAuditService(db_session)

    entries = []
    for i in range(4):
        entry = audit_svc.log_no_commit(
            actor_id=None,
            action=PlatformAuditAction.UPDATE,
            entity_type="PlatformSetting",
            entity_id=i + 10,
            reason=f"Setting update {i}",
        )
        db_session.commit()
        entries.append(entry)

    # Verify valid before tampering
    assert PlatformAuditService.verify_audit_chain(db_session) is None

    # Tamper with row 2's content (e.g. reason) directly via raw update
    row_to_tamper = entries[1]
    row_to_tamper.reason = "TAMPERED REASON"
    db_session.commit()

    # Chain verification must fail at row_to_tamper.id
    broken_id = PlatformAuditService.verify_audit_chain(db_session)
    assert broken_id == row_to_tamper.id


@control("AUD-01")
def test_verify_empty_chain(db_session):
    broken_id = PlatformAuditService.verify_audit_chain(db_session)
    assert broken_id is None


@control("AUD-01")
def test_deleted_user_and_org_do_not_break_chain(db_session):
    """Foreign keys actor_id and organization_id are ON DELETE SET NULL cascades;
    neither must be included in the cryptographic hash so deletion never breaks verification.
    """
    org = Organization(id=99, organization_name="Cascade Org", organization_code="casc-99")
    db_session.add(org)
    user = User(
        id=999,
        email="cascade@example.com",
        first_name="Admin",
        last_name="User",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        platform_role=PlatformRole.PLATFORM_ADMINISTRATOR,
        is_active=True,
        is_verified=True,
    )
    db_session.add(user)
    db_session.commit()

    audit_svc = PlatformAuditService(db_session)
    entry1 = audit_svc.log_no_commit(
        actor_id=user.id,
        organization_id=org.id,
        action=PlatformAuditAction.CREATE,
        entity_type="PrivilegedTenantAccessGrant",
        entity_id=1,
        reason="Initial grant",
    )
    db_session.commit()

    entry2 = audit_svc.log_no_commit(
        actor_id=user.id,
        organization_id=org.id,
        action=PlatformAuditAction.PRIVILEGED_ACCESS_EXITED,
        entity_type="PrivilegedTenantAccessGrant",
        entity_id=1,
        reason="Grant exit",
    )
    db_session.commit()

    assert PlatformAuditService.verify_audit_chain(db_session) is None

    # Simulate ON DELETE SET NULL cascades
    entry1.actor_id = None
    entry1.organization_id = None
    entry2.actor_id = None
    entry2.organization_id = None
    db_session.commit()

    # Verification MUST still pass because actor_id/organization_id are excluded from hash
    assert PlatformAuditService.verify_audit_chain(db_session) is None


@control("AUD-01")
def test_verify_audit_chain_endpoint(client_for, db_session):
    admin = make_super_admin(db_session, "audit_admin@example.com", PlatformRole.PLATFORM_ADMINISTRATOR)
    client = client_for(admin)

    # Empty or initial state
    res = client.get("/api/super-admin/audit-logs/verify")
    assert res.status_code == 200
    data = res.json()
    assert data["verified"] is True
    assert data["broken_id"] is None

    # Write audit log
    audit_svc = PlatformAuditService(db_session)
    entry = audit_svc.log_no_commit(
        actor_id=admin.id,
        action=PlatformAuditAction.CREATE,
        entity_type="PlatformSetting",
        entity_id=1,
        reason="Created",
    )
    db_session.commit()

    res = client.get("/api/super-admin/audit-logs/verify")
    assert res.status_code == 200
    assert res.json()["verified"] is True
    assert res.json()["total_records"] >= 1

    # Tamper with row
    entry.reason = "TAMPERED"
    db_session.commit()

    res = client.get("/api/super-admin/audit-logs/verify")
    assert res.status_code == 200
    assert res.json()["verified"] is False
    assert res.json()["broken_id"] == entry.id
