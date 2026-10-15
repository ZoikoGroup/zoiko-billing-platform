"""
tests/privacy/test_access_denied_audit.py
-----------------------------------------
ZB-SEC-PRIV-001 §AUD-02: Audit denied capability access with deduplication window.
"""

import pytest
from fastapi.testclient import TestClient

from app.core.capabilities import _denial_cache, require_capability
from app.core.exceptions import ForbiddenException
from app.main import app
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from tests.privacy.conftest import control, make_super_admin


@control("AUD-02")
def test_denied_capability_writes_audit_log(db_session):
    _denial_cache.clear()

    # User with support_operator role has no financial_consistency.write capability
    support_op = make_super_admin(db_session, "support@example.com", PlatformRole.SUPPORT_OPERATOR)

    # Dependency for financial_consistency.write
    dep = require_capability("financial_consistency.write")

    # Call dependency directly
    with pytest.raises(ForbiddenException):
        dep(request=None, db=db_session, current_user=support_op)

    # Verify audit row was written
    denial_log = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.action == PlatformAuditAction.PLATFORM_ACCESS_DENIED,
            PlatformAuditLog.actor_id == support_op.id,
        )
        .first()
    )
    assert denial_log is not None
    assert denial_log.entity_type == "capability"
    assert denial_log.metadata_.get("capability") == "financial_consistency.write"


@control("AUD-02")
def test_denied_capability_deduplication(db_session):
    _denial_cache.clear()

    support_op = make_super_admin(db_session, "support2@example.com", PlatformRole.SUPPORT_OPERATOR)
    dep = require_capability("financial_consistency.write")

    # Call 5 times rapidly
    for _ in range(5):
        with pytest.raises(ForbiddenException):
            dep(request=None, db=db_session, current_user=support_op)

    # Exactly 1 audit record should have been written due to 60s dedup cache
    count = (
        db_session.query(PlatformAuditLog)
        .filter(
            PlatformAuditLog.action == PlatformAuditAction.PLATFORM_ACCESS_DENIED,
            PlatformAuditLog.actor_id == support_op.id,
        )
        .count()
    )
    assert count == 1

