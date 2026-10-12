"""Polled super-admin endpoints stay cheap: constant query count, pure reads,
short-TTL caching, and get_counts parity with the old Python-loop result."""
import importlib
from datetime import datetime, timedelta

import pytest

from app.core import cache_service
from app.core.query_counter import count_queries
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.super_admin import attention_service as att
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.kill_switch_service import (
    DOMAIN_B_BREAKER_CATALOG,
    TENANT_DUNNING,
    BillingKillSwitchService,
)
from app.modules.super_admin.models import (
    AttentionItem,
    AttentionSeverity as S,
    AttentionStatus as St,
    PlatformAuditAction,
    PlatformAuditLog,
)
from app.modules.super_admin.router import get_attention_counts, get_triage_summary
from tests.query_helpers import assert_max_queries


def _admin(db, email="poll@x.example"):
    u = User(email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
             first_name="T", last_name="U", is_active=True, is_verified=True,
             platform_role=PlatformRole.SUPPORT_OPERATOR)
    db.add(u)
    db.flush()
    return u


def _item(db, n, sev, status, ack_deadline_delta=None, acked=False, suppressed_until=None):
    now = datetime.utcnow()
    db.add(AttentionItem(
        source="t", source_key=f"k{n}", title=f"t{n}", severity=sev, status=status,
        correlation_id=f"c{n}", opened_at=now, last_seen_at=now,
        sla_ack_deadline=None if ack_deadline_delta is None else now + ack_deadline_delta,
        acknowledged_at=now if acked else None, suppressed_until=suppressed_until,
    ))


def _mixed(db):
    h = timedelta(hours=1)
    _item(db, 1, S.P0, St.OPEN, -h)                      # breached
    _item(db, 2, S.P0, St.OPEN, +h)                      # not breached
    _item(db, 3, S.P1, St.ACKNOWLEDGED, -h, acked=True)  # acked -> no breach
    _item(db, 4, S.P1, St.ASSIGNED, -h)                  # breached
    _item(db, 5, S.P2, St.MITIGATING, None)              # no deadline
    _item(db, 6, S.P3, St.MONITORING, -h)                # breached
    _item(db, 7, S.P3, St.RESOLVED, -h)                  # excluded
    _item(db, 8, S.P2, St.CLOSED, -h)                    # excluded
    _item(db, 9, S.P2, St.SUPPRESSED, -h, suppressed_until=datetime.utcnow() + h)  # excluded
    _item(db, 10, S.P1, St.SUPPRESSED, -h, suppressed_until=datetime.utcnow() - h)  # expired
    db.commit()


def _legacy_counts(db):
    """The pre-optimisation Python-loop implementation (reference oracle)."""
    open_items = db.query(AttentionItem).filter(AttentionItem.status.in_(att._OPEN_LIKE_STATUSES)).all()
    now = datetime.utcnow()
    counts = {"p0": 0, "p1": 0, "p2": 0, "p3": 0}
    breaches = 0
    for i in open_items:
        counts[i.severity.value] += 1
        if i.sla_ack_deadline and i.acknowledged_at is None and now > i.sla_ack_deadline:
            breaches += 1
    return {**counts, "total_open": len(open_items), "sla_breaches": breaches}


def _guard_fallback_lift():
    """Mark the once-a-minute no-scheduler fallback lift as 'just ran' so polls are pure reads."""
    cache_service.cache_set(att._LIFT_GUARD_KEY, 1, ttl=60)


def _writes(counter):
    return [s for s in counter.statements if s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))]


def test_get_counts_matches_legacy_loop(db_session):
    _mixed(db_session)
    _guard_fallback_lift()
    svc = AttentionService(db_session)
    assert svc.get_counts() == _legacy_counts(db_session)
    assert svc.get_counts() == {"p0": 2, "p1": 2, "p2": 1, "p3": 1, "total_open": 6, "sla_breaches": 3}


def test_get_counts_empty(db_session):
    assert AttentionService(db_session).get_counts() == {
        "p0": 0, "p1": 0, "p2": 0, "p3": 0, "total_open": 0, "sla_breaches": 0}


def test_get_counts_is_pure_aggregate_read(db_session):
    _mixed(db_session)
    cache_service.cache_flush()
    _guard_fallback_lift()
    with assert_max_queries(2) as c:  # GROUP BY severity + SLA COUNT
        AttentionService(db_session).get_counts()
    assert not _writes(c)


def test_lift_expired_suppressions_job_path(db_session):
    _mixed(db_session)
    assert AttentionService(db_session).lift_expired_suppressions() == 1
    db_session.commit()
    item = db_session.query(AttentionItem).filter_by(source_key="k10").one()
    assert item.status == St.OPEN and item.suppressed_until is None
    assert AttentionService(db_session).get_counts()["total_open"] == 7


def test_suppression_job_registered():
    from app.core.scheduler import get_job_definitions

    d = {x[2]: x for x in get_job_definitions()}["attention_maintenance_job"]
    assert d[1] == 1
    mod, fn = d[0].split(":")
    assert callable(getattr(importlib.import_module(mod), fn))


def _seed_events(db, actor, n):
    for i in range(n):
        db.add(PlatformAuditLog(actor_id=actor.id if i % 2 == 0 else None, action=PlatformAuditAction.ACTIVATE,
                                entity_type="X", entity_id=i,
                                created_at=datetime.utcnow() - timedelta(seconds=i)))
    db.commit()


@pytest.mark.parametrize("events", [1, 25])
def test_triage_summary_constant_queries(db_session, events):
    admin = _admin(db_session, f"a{events}@x.example")
    _mixed(db_session)
    _seed_events(db_session, admin, events)
    cache_service.cache_flush()
    _guard_fallback_lift()
    with assert_max_queries(12, "triage/summary") as c:
        resp = get_triage_summary(current_user=admin, db=db_session)
    assert len(resp.critical_events) == min(events, 10)
    assert len(resp.safety_controls) == len(DOMAIN_B_BREAKER_CATALOG) + 1
    assert not _writes(c), c.statements  # no ensure_switch INSERTs, no suppression UPDATE


def test_triage_summary_actor_email_mapped(db_session):
    admin = _admin(db_session)
    _seed_events(db_session, admin, 4)
    cache_service.cache_flush()
    resp = get_triage_summary(current_user=admin, db=db_session)
    emails = [e.actor_email for e in resp.critical_events]
    assert emails.count(admin.email) == 2 and emails.count(None) == 2


def test_cache_hit_issues_no_queries(db_session):
    admin = _admin(db_session)
    cache_service.cache_flush()
    first = get_triage_summary(current_user=admin, db=db_session)
    counts1 = get_attention_counts(current_user=admin, db=db_session)
    with count_queries() as c:
        second = get_triage_summary(current_user=admin, db=db_session)
        counts2 = get_attention_counts(current_user=admin, db=db_session)
    assert c.count == 0
    assert second.model_dump(mode="json") == first.model_dump(mode="json")
    assert counts2 == counts1


def test_invalidation_on_attention_write_and_breaker_change(db_session):
    admin = _admin(db_session)
    _mixed(db_session)
    cache_service.cache_flush()
    before = get_attention_counts(current_user=admin, db=db_session)
    get_triage_summary(current_user=admin, db=db_session)

    item = db_session.query(AttentionItem).filter_by(source_key="k1").one()
    AttentionService(db_session).acknowledge(admin, item.id)
    db_session.commit()
    after = get_attention_counts(current_user=admin, db=db_session)
    assert after.sla_breaches == before.sla_breaches - 1

    BillingKillSwitchService(db_session).set_enabled(TENANT_DUNNING, False, reason="x", actor_id=None)
    db_session.commit()
    summary = get_triage_summary(current_user=admin, db=db_session)
    assert any(not s.enabled for s in summary.safety_controls)


def test_cache_failure_falls_back_to_live_read(db_session, monkeypatch):
    admin = _admin(db_session)
    monkeypatch.setattr(cache_service, "cache_get", lambda *a, **k: "garbage")
    monkeypatch.setattr(cache_service, "cache_set", lambda *a, **k: None)
    resp = get_triage_summary(current_user=admin, db=db_session)
    assert resp.incidents.counts.total_open == 0
    assert get_attention_counts(current_user=admin, db=db_session).total_open == 0


def test_effective_states_defaults_without_insert(db_session):
    scopes = list(DOMAIN_B_BREAKER_CATALOG)
    with count_queries() as c:
        states = BillingKillSwitchService(db_session).effective_states(scopes)
    assert c.count == 1 and not _writes(c)
    assert all(s.enabled and s.expires_at is None for s in states.values())


def test_effective_states_lifts_expired_pause(db_session):
    svc = BillingKillSwitchService(db_session)
    sw = svc.set_enabled(TENANT_DUNNING, False, reason="p", actor_id=None, auto_expire_minutes=30)
    sw.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert svc.effective_states([TENANT_DUNNING])[TENANT_DUNNING].enabled is True


def test_fallback_lift_when_scheduler_absent_is_throttled(db_session):
    _mixed(db_session)
    cache_service.cache_flush()
    svc = AttentionService(db_session)
    assert svc.get_counts()["total_open"] == 7  # lifted on first read (no scheduler running)
    db_session.commit()
    with count_queries() as c:
        svc.get_counts()
    assert c.count == 2 and not _writes(c)  # guard active: no further lift query
