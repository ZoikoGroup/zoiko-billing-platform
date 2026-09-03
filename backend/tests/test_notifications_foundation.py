"""
tests/test_notifications_foundation.py
------------------------------------------
Phase 0 pipeline tests for the ZB-* email-notification foundation:
idempotency, hard suppression overriding even T0 tier, tier-rule
enforcement, the background-vs-inline send-path split, and registry
self-validation.
"""

import copy

import pytest
from fastapi import BackgroundTasks
from sqlalchemy.orm import sessionmaker

from tests.conftest import make_organization

from app.modules.notifications.models import (
    CommunicationLog,
    CommunicationLogStatus,
    CommunicationSend,
    SuppressionReason,
)
from app.modules.notifications.service import (
    dispatch_email,
    enforce_tier_rules,
)
from app.modules.notifications.suppression_service import record_suppression
from app.modules.notifications.template_registry import (
    ControlRuleFlag,
    NotificationTier,
    TEMPLATE_REGISTRY,
    TemplateMeta,
    validate_template_registry,
)


def _base_context(**overrides):
    ctx = {"recipient_first_name": "Alex", "settings_url": "https://app.example.com/settings"}
    ctx.update(overrides)
    return ctx


def test_duplicate_dispatch_is_idempotent(db_session, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.send_approval_email",
        lambda *a, **k: sent.append(1) or True,
    )
    # _execute_send opens its OWN SessionLocal() (a real background-task
    # can't reuse a request-scoped session) — point that at the same
    # in-memory engine this test's db_session already uses, so the send
    # it records is visible to this test's assertions below. Safe under
    # SQLite's :memory: + SingletonThreadPool (same thread => same
    # connection => same data) since this test runs synchronously.
    monkeypatch.setattr(
        "app.database.SessionLocal",
        sessionmaker(bind=db_session.get_bind(), autoflush=False, autocommit=False),
    )
    org = make_organization(db_session)

    for _ in range(2):
        dispatch_email(
            template_id="ZB-SEC-004",
            recipient_email="user@example.com",
            context=_base_context(),
            event_name="identity.password_changed",
            entity_type="User",
            entity_id=42,
            organization_id=org.id,
            db=db_session,
        )

    rows = db_session.query(CommunicationSend).all()
    assert len(rows) == 1
    assert len(sent) == 1


def test_global_suppression_blocks_even_t0(db_session, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.services.email_service.send_approval_email",
        lambda *a, **k: sent.append(1) or True,
    )
    record_suppression(
        db_session, "blocked@example.com", reason=SuppressionReason.HARD_BOUNCE
    )
    db_session.commit()

    dispatch_email(
        template_id="ZB-SEC-004",
        recipient_email="blocked@example.com",
        context=_base_context(),
        event_name="identity.password_changed",
        entity_type="User",
        entity_id=1,
        organization_id=None,
        db=db_session,
    )

    assert sent == []
    log = db_session.query(CommunicationLog).order_by(CommunicationLog.id.desc()).first()
    assert log.status == CommunicationLogStatus.SUPPRESSED
    assert log.reason.startswith("suppressed:")


def test_enforce_tier_rules_raises_on_leaked_unsubscribe_key():
    meta = TEMPLATE_REGISTRY["ZB-SEC-004"]
    assert meta.tier == NotificationTier.T0
    with pytest.raises(ValueError):
        enforce_tier_rules(meta, {"unsubscribe_url": "https://example.com/unsub"})


def test_background_tasks_defers_execution(db_session, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.modules.notifications.service._execute_send",
        lambda *a, **k: calls.append(("executed", a, k)),
    )
    bt = BackgroundTasks()

    dispatch_email(
        template_id="ZB-SEC-004",
        recipient_email="user2@example.com",
        context=_base_context(),
        event_name="identity.password_changed",
        entity_type="User",
        entity_id=99,
        organization_id=None,
        db=db_session,
        background_tasks=bt,
    )

    # Not executed synchronously — queued onto the BackgroundTasks instance.
    assert calls == []
    assert len(bt.tasks) == 1


def test_no_background_tasks_executes_inline(db_session, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.modules.notifications.service._execute_send",
        lambda *a, **k: calls.append("executed"),
    )

    dispatch_email(
        template_id="ZB-SEC-004",
        recipient_email="user3@example.com",
        context=_base_context(),
        event_name="identity.password_changed",
        entity_type="User",
        entity_id=100,
        organization_id=None,
        db=db_session,
        background_tasks=None,
    )

    assert calls == ["executed"]


def test_validate_template_registry_passes_for_real_registry():
    validate_template_registry()  # should not raise


def test_validate_template_registry_raises_on_missing_t0_flag():
    broken = copy.deepcopy(TEMPLATE_REGISTRY)
    broken["ZB-SEC-004"] = TemplateMeta(
        template_id="ZB-SEC-004",
        tier=NotificationTier.T0,
        trigger_event_name="identity.password_changed",
        subject="Your Zoiko Billing password was changed",
        control_rule_flags=frozenset({ControlRuleFlag.NO_UNSUBSCRIBE_LINK}),  # missing NO_PROMOTIONAL_CONTENT
        active=True,
    )
    with pytest.raises(ValueError):
        validate_template_registry(broken)
