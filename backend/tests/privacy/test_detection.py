"""
tests/privacy/test_detection.py
-------------------------------
ZB-SEC-PRIV-001 §AUD-03 / GOV-08: Anomaly detection scheduled job and Attention Engine integration.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.config import settings
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.organizations.models import Organization
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import (
    AttentionItem,
    AttentionSeverity,
    PlatformAuditAction,
    PlatformAuditLog,
    PrivilegedAccessStatus,
    PrivilegedTenantAccessGrant,
)
from app.modules.super_admin.tasks.security_detection import run_security_detection_job
from tests.privacy.conftest import control, make_super_admin


@control("AUD-03", "GOV-08")
def test_detection_repeated_denials(db_session, monkeypatch):
    monkeypatch.setattr(settings, "DETECTION_REPEATED_DENIALS_THRESHOLD", 3)
    monkeypatch.setattr(settings, "DETECTION_REPEATED_DENIALS_WINDOW_MINUTES", 10)

    user = make_super_admin(db_session, "denied_actor@example.com", PlatformRole.SUPPORT_OPERATOR)
    audit_svc = PlatformAuditService(db_session)

    # Log 3 access denials
    for _ in range(3):
        audit_svc.log_no_commit(
            actor_id=user.id,
            action=PlatformAuditAction.PLATFORM_ACCESS_DENIED,
            entity_type="capability",
            entity_id=None,
            reason="Denied",
        )
    db_session.commit()

    # Run detection
    res = run_security_detection_job(db=db_session)
    assert res["repeated_denials"] >= 1

    # Verify AttentionItem created
    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == f"sec:repeated_denials:{user.id}")
        .first()
    )
    assert item is not None
    assert item.severity == AttentionSeverity.P1
    assert "Repeated access denials" in item.title


@control("AUD-03", "GOV-08")
def test_detection_many_tenants_short_window(db_session, monkeypatch):
    monkeypatch.setattr(settings, "DETECTION_MANY_TENANTS_THRESHOLD", 3)

    operator = make_super_admin(db_session, "hopper@example.com", PlatformRole.SECURITY_OPERATOR)
    audit_svc = PlatformAuditService(db_session)

    # Touch 3 distinct tenants in last 5 minutes
    for org_id in (101, 102, 103):
        org = Organization(id=org_id, organization_name=f"Tenant {org_id}", organization_code=f"t-{org_id}")
        db_session.add(org)
        audit_svc.log_no_commit(
            actor_id=operator.id,
            organization_id=org_id,
            action=PlatformAuditAction.UPDATE,
            entity_type="TenantConfig",
            entity_id=org_id,
            reason=f"Inspection of tenant {org_id}",
        )
    db_session.commit()

    res = run_security_detection_job(db=db_session)
    assert res["many_tenants"] >= 1

    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == f"sec:many_tenants:{operator.id}")
        .first()
    )
    assert item is not None
    assert "accessed 3 distinct tenants" in item.title or "rapidly" in item.title


@control("AUD-03", "GOV-08")
def test_detection_heavy_viewing(db_session, monkeypatch):
    monkeypatch.setattr(settings, "DETECTION_HEAVY_VIEWING_THRESHOLD", 5)

    viewer = make_super_admin(db_session, "heavy_viewer@example.com", PlatformRole.AUDITOR)
    audit_svc = PlatformAuditService(db_session)

    for i in range(5):
        audit_svc.log_no_commit(
            actor_id=viewer.id,
            action=PlatformAuditAction.PRIVILEGED_ACCESS_VIEWED,
            entity_type="CustomerData",
            entity_id=i,
            reason="Mass export",
        )
    db_session.commit()

    res = run_security_detection_job(db=db_session)
    assert res["heavy_viewing"] >= 1

    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == f"sec:heavy_viewing:{viewer.id}")
        .first()
    )
    assert item is not None
    assert "Heavy activity volume" in item.title


@control("AUD-03", "GOV-08")
def test_detection_audit_chain_tamper(db_session):
    audit_svc = PlatformAuditService(db_session)
    entry = audit_svc.log_no_commit(
        actor_id=None,
        action=PlatformAuditAction.CREATE,
        entity_type="TestChain",
        entity_id=1,
        reason="Genuine row",
    )
    db_session.commit()

    # Tamper with row
    entry.reason = "TAMPERED ROW CONTENT"
    db_session.commit()

    res = run_security_detection_job(db=db_session)
    assert res["audit_chain_broken"] is True

    # Must raise a P0 attention item
    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == f"audit_chain_broken:{entry.id}")
        .first()
    )
    assert item is not None
    assert item.severity == AttentionSeverity.P0
    assert "Tamper-evident audit log chain broken" in item.title


@control("AUD-03", "GOV-08")
def test_detection_dormant_account(db_session, monkeypatch):
    monkeypatch.setattr(settings, "DETECTION_DORMANT_DAYS_THRESHOLD", 60)

    dormant_user = User(
        id=777,
        email="dormant@example.com",
        first_name="Old",
        last_name="User",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        platform_role=PlatformRole.SUPPORT_OPERATOR,
        last_login_at=datetime.utcnow() - timedelta(days=90),
        is_active=True,
        is_verified=True,
    )
    db_session.add(dormant_user)
    db_session.commit()

    # Activity from this dormant user in the last 10 minutes
    audit_svc = PlatformAuditService(db_session)
    audit_svc.log_no_commit(
        actor_id=dormant_user.id,
        action=PlatformAuditAction.UPDATE,
        entity_type="Config",
        entity_id=1,
        reason="Sudden activity after 90 days",
    )
    db_session.commit()

    res = run_security_detection_job(db=db_session)
    assert res["dormant_activity"] >= 1

    item = (
        db_session.query(AttentionItem)
        .filter(AttentionItem.source_key == f"sec:dormant_account:{dormant_user.id}")
        .first()
    )
    assert item is not None
    assert "dormant account" in item.title.lower()

