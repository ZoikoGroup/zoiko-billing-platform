"""
tests/test_super_admin_bugs.py
-------------------------------
Targeted regression tests for Super Admin Bug Batch:
- Bug 1: Attention unread count & idempotent acknowledge
- Bug 2: Organization directory service excludes internal platform org
- Bug 3 & 4: Super Admin AI assistant conversation creation & question answering
"""

import pytest
from unittest.mock import MagicMock
from datetime import datetime

from app.database import SessionLocal
from app.modules.auth.models import User, UserRole, PlatformRole
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.organization_service import OrganizationDirectoryService
from app.modules.organizations.models import Organization
from app.modules.chatbot.context.ai_context import get_ai_context
from app.modules.chatbot.conversation.engine import ConversationEngine


@pytest.fixture
def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.rollback()
        db.close()


def _get_or_create_super_admin(db_session, email="sa_bugs_test@example.com"):
    actor = db_session.query(User).filter(User.role == UserRole.SUPER_ADMIN).first()
    if not actor:
        actor = User(
            email=email,
            hashed_password="test_password_hash",
            role=UserRole.SUPER_ADMIN,
            platform_role=PlatformRole.PLATFORM_ADMIN,
            first_name="Super",
            last_name="Admin",
            is_active=True,
            is_verified=True,
            organization_id=None,
        )
        db_session.add(actor)
        db_session.commit()
    return actor


def test_bug1_attention_unread_count_and_idempotent_acknowledge(db_session):
    """Verify get_counts() accurately tracks unread items and acknowledge() is idempotent."""
    svc = AttentionService(db_session)
    actor = _get_or_create_super_admin(db_session)
    assert actor is not None, "Super Admin user required"

    # Create a test open attention item
    item = AttentionItem(
        source="job_failure",
        source_key=f"test_item_{datetime.utcnow().timestamp()}",
        title="Test Incident for Unread Count",
        severity=AttentionSeverity.P1,
        status=AttentionStatus.OPEN,
        correlation_id=f"corr_{datetime.utcnow().timestamp()}",
    )
    db_session.add(item)
    db_session.flush()

    counts_before = svc.get_counts(include_unread=True)
    assert counts_before["unread"] >= 1

    # Acknowledge the item
    acked = svc.acknowledge(actor, item.id)
    assert acked.status == AttentionStatus.ACKNOWLEDGED
    assert acked.acknowledged_at is not None

    # Idempotent: repeated acknowledge does not raise exception
    repeated = svc.acknowledge(actor, item.id)
    assert repeated.id == item.id

    # Clean up test item
    db_session.delete(item)
    db_session.commit()


def test_bug2_organization_directory_excludes_platform_org(db_session):
    """Verify that OrganizationDirectoryService does not show ZOIKO_PLATFORM in customer directory."""
    # Ensure platform org exists
    p_org = db_session.query(Organization).filter(Organization.organization_code == "ZOIKO_PLATFORM").first()
    if not p_org:
        p_org = Organization(organization_name="Zoiko Platform", organization_code="ZOIKO_PLATFORM", is_active=True)
        db_session.add(p_org)
        db_session.commit()

    dir_svc = OrganizationDirectoryService(db_session)
    result = dir_svc.list_organizations(limit=100)
    org_codes = [o["organization_code"] for o in result["organizations"]]
    assert "ZOIKO_PLATFORM" not in org_codes


def test_bug3_and_bug4_super_admin_assistant_flow(db_session):
    """Verify that Super Admin can create conversations and receive grounded answers."""
    su = _get_or_create_super_admin(db_session)
    assert su is not None

    # Resolve AIContext for Super Admin
    req = MagicMock()
    req.state = MagicMock()
    req.state.request_id = "test-ai-req"
    ctx = get_ai_context(req, db_session, su)

    assert ctx.is_super_admin is True
    assert ctx.organization_id is not None
    assert ctx.tenant_context_id is not None
    assert ctx.tenant_name == "Zoiko Platform"

    ce = ConversationEngine(db_session)
    # Bug 4 verification: create_conversation succeeds
    conv = ce.create_conversation(ctx=ctx, title="New Conversation")
    assert conv["conversation_uid"] is not None

    # Bug 3 verification: send message regarding invoice statuses returns answer
    res = ce.send_message(
        conversation_uid=conv["conversation_uid"],
        message="What do the different invoice statuses mean?",
        ctx=ctx,
    )
    assert res.get("answer") is not None
    assert "Draft" in res["answer"]
    assert "Sent" in res["answer"]
    assert "Paid" in res["answer"]
