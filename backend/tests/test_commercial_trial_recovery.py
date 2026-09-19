"""
Part 1 — §5 Free-Trial recovery-window regression tests.

Covers the mandated verification surface for the 14-day TRIAL_RECOVERY window:
  1. trial-expiry sweep enters TRIAL_RECOVERY (NOT SUSPENDED) and backfills
     recovery_ends_at = trial_ends_at + 14 days
  2. recovery sweep is a no-op while the window is still open
  3. recovery sweep -> SUSPENDED once recovery_ends_at passes, and the
     ZB-COM-014 (commercial.recovery_window_expired) email fires exactly once
  4. read/export gate: require_active_subscription lets TRIAL_RECOVERY through
     (only true SUSPENDED blocks the whole product)
  5. write gate: require_new_revenue_generation_allowed blocks new-invoice /
     new-customer / new-quote / new-subscription endpoints during
     TRIAL_RECOVERY but passes in TRIALING / ACTIVE
  6. state machine supports TRIAL_RECOVERY -> ACTIVE (conversion path) and
     TRIAL_RECOVERY -> SUSPENDED
  7. a TRIAL_RECOVERY subscription still resolves as the org's open
     subscription, so entitlement/usage surfaces stay alive during the window

No TestClient precedent exists anywhere in tests/ — dependencies and router
functions are invoked directly against the isolated in-memory SQLite fixture,
per the established convention (see test_commercial_subscription.py).
"""
import asyncio
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest

from app.core.dependencies import (
    require_active_subscription,
    require_new_revenue_generation_allowed,
)
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import User, UserRole
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.modules.commercial.service import CommercialSubscriptionService
from tests.conftest import make_organization

RECOVERY_WINDOW_DAYS = 14


def _reopen(db):
    """The sweep jobs close their SessionLocal in a finally block. Since the
    tests monkeypatch SessionLocal to return the shared db_session, that close
    tears down the fixture session — reopen a fresh session on the same
    in-memory engine (retained by the singleton pool) to read post-job state."""
    from sqlalchemy.orm import Session as _SaSession
    return _SaSession(bind=db.get_bind())


def _make_user(db, *, email, org_id, role=UserRole.ORG_ADMIN):
    user = User(
        email=email,
        hashed_password="x",
        role=role,
        organization_id=org_id,
        first_name="Ada",
        last_name="Admin",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _make_commercial_account(db, org):
    acct = CommercialAccount(organization_id=org.id)
    db.add(acct)
    db.flush()
    return acct


def _make_subscription(db, acct, *, status, trial_ends_at=None, recovery_ends_at=None):
    sub = CommercialSubscription(
        commercial_account_id=acct.id,
        commercial_plan_id=1,
        status=status,
        trial_ends_at=trial_ends_at,
        recovery_ends_at=recovery_ends_at,
    )
    db.add(sub)
    db.flush()
    return sub


def _make_recovery_setup(db, *, email="admin@recovery.co", recovery_ends_at=None):
    org = make_organization(db, code="RECOV1", name="Recovery Co")
    user = _make_user(db, email=email, org_id=org.id)
    acct = _make_commercial_account(db, org)
    sub = _make_subscription(
        db,
        acct,
        status=CommercialSubscriptionStatus.TRIAL_RECOVERY,
        trial_ends_at=datetime.utcnow() - timedelta(days=1),
        recovery_ends_at=(
            recovery_ends_at if recovery_ends_at is not None else datetime.utcnow() + timedelta(days=13)
        ),
    )
    db.commit()
    return org, user, acct, sub


async def _run(gate_func, *, current_user, db):
    return await gate_func(current_user=current_user, db=db)


# ── 1. Trial expiry enters TRIAL_RECOVERY (not SUSPENDED) ────────────────────

def test_trial_expiry_sweep_enters_trial_recovery(db_session, monkeypatch):
    from app.modules.commercial.tasks import trial_expiry
    monkeypatch.setattr(trial_expiry, "SessionLocal", lambda: db_session)

    org = make_organization(db_session, code="TRIAL1", name="Trial Co")
    user = _make_user(db_session, email="owner@trial.co", org_id=org.id)
    acct = _make_commercial_account(db_session, org)

    past_trial_end = datetime.utcnow() - timedelta(hours=2)
    sub = _make_subscription(
        db_session,
        acct,
        status=CommercialSubscriptionStatus.TRIALING,
        trial_ends_at=past_trial_end,
        recovery_ends_at=None,
    )
    db_session.commit()

    with patch("app.services.email_service.send_trial_expired_email") as mock_send, \
         patch("app.config.settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT", True):
        mock_send.return_value = True
        summary = trial_expiry.run_commercial_trial_expiry_job()

    assert summary["recovery"] == 1
    assert mock_send.called
    assert mock_send.call_args[1]["email"] == "owner@trial.co"

    reopened = _reopen(db_session)
    fresh = reopened.query(CommercialSubscription).filter_by(
        commercial_account_id=acct.id
    ).first()
    assert fresh.status == CommercialSubscriptionStatus.TRIAL_RECOVERY
    assert fresh.status != CommercialSubscriptionStatus.SUSPENDED
    assert fresh.recovery_ends_at is not None
    assert fresh.recovery_ends_at >= past_trial_end + timedelta(
        days=RECOVERY_WINDOW_DAYS
    ) - timedelta(seconds=1)
    reopened.close()


# ── 2. Recovery sweep is a no-op while the window is open ────────────────────

def test_recovery_sweep_noop_while_window_open(db_session, monkeypatch):
    from app.modules.commercial.tasks import recovery_window_expiry
    monkeypatch.setattr(recovery_window_expiry, "SessionLocal", lambda: db_session)

    _, _, acct, _ = _make_recovery_setup(
        db_session, recovery_ends_at=datetime.utcnow() + timedelta(days=5)
    )
    acct_id = acct.id

    with patch("app.config.settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT", True):
        summary = recovery_window_expiry.run_commercial_recovery_window_expiry_job()

    assert summary["suspended"] == 0

    reopened = _reopen(db_session)
    fresh = reopened.query(CommercialSubscription).filter_by(
        commercial_account_id=acct_id
    ).first()
    assert fresh.status == CommercialSubscriptionStatus.TRIAL_RECOVERY
    reopened.close()


# ── 3. Recovery sweep -> SUSPENDED after the window, ZB-COM-014 exactly once ─

def test_recovery_sweep_suspends_and_emails_once_after_window(db_session, monkeypatch):
    from app.modules.commercial.tasks import recovery_window_expiry
    monkeypatch.setattr(recovery_window_expiry, "SessionLocal", lambda: db_session)

    org, user, acct, sub = _make_recovery_setup(
        db_session, email="admin@windowover.co",
        recovery_ends_at=datetime.utcnow() - timedelta(hours=1),
    )
    acct_id = acct.id

    with patch("app.services.email_service.send_recovery_window_expired_email") as mock_send, \
         patch("app.config.settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT", True):
        mock_send.return_value = True
        first = recovery_window_expiry.run_commercial_recovery_window_expiry_job()
        second = recovery_window_expiry.run_commercial_recovery_window_expiry_job()

    assert first["suspended"] == 1
    assert second["suspended"] == 0  # already SUSPENDED — no double transition
    assert mock_send.call_count == 1  # ZB-COM-014 fires exactly once
    assert mock_send.call_args[1]["email"] == "admin@windowover.co"

    reopened = _reopen(db_session)
    fresh = reopened.query(CommercialSubscription).filter_by(
        commercial_account_id=acct_id
    ).first()
    assert fresh.status == CommercialSubscriptionStatus.SUSPENDED
    reopened.close()


def test_recovery_sweep_requires_enforcement_flag(db_session, monkeypatch):
    from app.modules.commercial.tasks import recovery_window_expiry
    monkeypatch.setattr(recovery_window_expiry, "SessionLocal", lambda: db_session)

    _, _, acct, _ = _make_recovery_setup(
        db_session, recovery_ends_at=datetime.utcnow() - timedelta(days=1)
    )
    acct_id = acct.id

    with patch("app.config.settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT", False):
        summary = recovery_window_expiry.run_commercial_recovery_window_expiry_job()

    assert "skipped" in summary

    reopened = _reopen(db_session)
    fresh = reopened.query(CommercialSubscription).filter_by(
        commercial_account_id=acct_id
    ).first()
    assert fresh.status == CommercialSubscriptionStatus.TRIAL_RECOVERY
    reopened.close()


# ── 4. Read/export gate lets TRIAL_RECOVERY through ──────────────────────────

def test_read_gate_allows_trial_recovery(db_session):
    org, user, _, _ = _make_recovery_setup(db_session)
    db_session.refresh(org)

    result = asyncio.run(
        require_active_subscription("billing")(current_user=user, db=db_session)
    )
    assert result is user


def test_read_gate_still_blocks_true_suspended(db_session):
    org = make_organization(db_session, code="SUSP1", name="Suspended Co")
    user = _make_user(db_session, email="admin@susp.co", org_id=org.id)
    acct = _make_commercial_account(db_session, org)
    _make_subscription(
        db_session, acct, status=CommercialSubscriptionStatus.SUSPENDED,
    )
    db_session.commit()

    with pytest.raises(ForbiddenException):
        asyncio.run(
            require_active_subscription("billing")(current_user=user, db=db_session)
        )


# ── 5. Write gate blocks new revenue-generating state during TRIAL_RECOVERY ─

def test_write_gate_blocks_recovery_window(db_session):
    _, user, _, _ = _make_recovery_setup(db_session)

    with pytest.raises(ForbiddenException):
        asyncio.run(
            require_new_revenue_generation_allowed("billing")(current_user=user, db=db_session)
        )


def test_write_gate_passes_while_trialing(db_session):
    org = make_organization(db_session, code="TRIG1", name="Trialing Co")
    user = _make_user(db_session, email="admin@trial.co", org_id=org.id)
    acct = _make_commercial_account(db_session, org)
    _make_subscription(
        db_session, acct, status=CommercialSubscriptionStatus.TRIALING,
        trial_ends_at=datetime.utcnow() + timedelta(days=7),
    )
    db_session.commit()

    result = asyncio.run(
        require_new_revenue_generation_allowed("billing")(current_user=user, db=db_session)
    )
    assert result is user


def test_write_gate_passes_while_active(db_session):
    org = make_organization(db_session, code="ACTV1", name="Active Co")
    user = _make_user(db_session, email="admin@active.co", org_id=org.id)
    acct = _make_commercial_account(db_session, org)
    _make_subscription(db_session, acct, status=CommercialSubscriptionStatus.ACTIVE)
    db_session.commit()

    result = asyncio.run(
        require_new_revenue_generation_allowed("billing")(current_user=user, db=db_session)
    )
    assert result is user


# ── 6. State machine: conversion + suspension paths from TRIAL_RECOVERY ──────

def test_trial_recovery_allows_active_conversion_and_suspended(db_session):
    org, user, acct, sub = _make_recovery_setup(db_session)

    transitions = CommercialSubscriptionService._TRANSITIONS[CommercialSubscriptionStatus.TRIAL_RECOVERY]
    assert CommercialSubscriptionStatus.ACTIVE in transitions      # §5 self-serve conversion path
    assert CommercialSubscriptionStatus.SUSPENDED in transitions  # recovery sweep sink
    assert CommercialSubscriptionStatus.CANCELLED in transitions
    assert CommercialSubscriptionStatus.EXPIRED in transitions

    svc = CommercialSubscriptionService(db_session)
    svc.transition(sub, CommercialSubscriptionStatus.CANCELLED)
    db_session.commit()
    assert sub.status == CommercialSubscriptionStatus.CANCELLED
    assert user.organization_id == org.id


# ── 7. TRIAL_RECOVERY stays the org's open subscription ──────────────────────

def test_trial_recovery_remains_open_subscription_for_resolution(db_session):
    org, _, acct, sub = _make_recovery_setup(db_session)

    open_sub = CommercialSubscriptionService(db_session).get_active_subscription(acct.id)
    assert open_sub is not None
    assert open_sub.id == sub.id
    assert sub.status in CommercialSubscriptionService._OPEN_STATUSES