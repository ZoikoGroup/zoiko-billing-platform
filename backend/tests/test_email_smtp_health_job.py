"""
tests/test_email_smtp_health_job.py
------------------------------------
A3 — SMTP delivery health must be detected on a SCHEDULE, not only when a
human opens a page.

The gap this closes: `evaluate_smtp_health()` used to be reached only via
`GET /email-delivery/overview`. That endpoint is called when a super admin
opens the Command Center Hub (it is a lens card there) or the Email
Delivery page directly. So a genuinely broken SMTP configuration — bad
host/username/password after a settings change — stayed invisible for the
entire duration of an outage in which nobody happened to log in, and was
only reported once somebody next visited a dashboard.

The acceptance bar is specifically "no page visits at all": these tests
seed the failure signal directly into the audit log, then invoke
`run_email_smtp_health_job()` itself. They never call get_overview(),
resend(), or any endpoint, so a regression that re-attached health
evaluation to the read path alone would fail here.
"""
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest

from app.database import Base
from app.services.email_foundation import CommunicationAuditLog
from app.services.email_foundation.health_task import run_email_smtp_health_job


@pytest.fixture(autouse=True)
def setup_tables(db_session):
    Base.metadata.create_all(bind=db_session.get_bind())


def _seed_attempts(db, sent=2, failed=8):
    """Seed the trailing window of SENT/FAILED attempts.

    evaluate_smtp_health() reads the most recent _HEALTH_WINDOW (20) rows
    ordered by sent_at DESC, and needs at least _HEALTH_MIN_SAMPLE (5)
    before it will claim healthy OR degraded.
    """
    now = datetime.utcnow()
    for i in range(sent):
        db.add(CommunicationAuditLog(
            dedupe_key=f"ok-{i}", recipient="a@example.com",
            organization_id=None, template_id="ZB-INV-006",
            event_name="test", tier="T1", status="SENT",
            sent_at=now - timedelta(minutes=i + 1),
        ))
    for i in range(failed):
        db.add(CommunicationAuditLog(
            dedupe_key=f"bad-{i}", recipient="a@example.com",
            organization_id=None, template_id="ZB-INV-006",
            event_name="test", tier="T1", status="FAILED",
            error_message="SMTP connect failed",
            sent_at=now - timedelta(minutes=sent + i + 1),
        ))
    db.commit()


def _attention_item(db, source_key="smtp_health"):
    from app.modules.super_admin.models import AttentionItem

    return (
        db.query(AttentionItem)
        .filter(AttentionItem.source_key == source_key)
        .first()
    )


def test_degraded_smtp_detected_with_no_page_visit(db_session):
    """A failing send stream opens the attention item on the job's schedule.

    No endpoint is called anywhere in this test. The ONLY thing that can
    create the attention item is the scheduled job itself.
    """
    _seed_attempts(db_session, sent=2, failed=8)

    with patch(
        "app.database.SessionLocal", return_value=db_session
    ), patch("app.config.settings.ENABLE_EMAIL_SMTP_HEALTH_CHECK", True):
        result = run_email_smtp_health_job()

    assert result.get("smtp_health") == "degraded", result
    assert "errors" not in result, result

    item = _attention_item(db_session)
    assert item is not None, (
        "No email_delivery/smtp_health attention item was created — health "
        "is still only being evaluated on-read."
    )
    assert item.source == "email_delivery"


def test_healthy_smtp_does_not_open_an_alert(db_session):
    _seed_attempts(db_session, sent=9, failed=1)

    with patch(
        "app.database.SessionLocal", return_value=db_session
    ), patch("app.config.settings.ENABLE_EMAIL_SMTP_HEALTH_CHECK", True):
        result = run_email_smtp_health_job()

    assert result.get("smtp_health") == "healthy", result
    assert _attention_item(db_session) is None


def test_thin_sample_reports_unknown_and_touches_nothing(db_session):
    """Below _HEALTH_MIN_SAMPLE there is no signal either way.

    Must NOT auto-resolve an item a human may already be working — the
    existing evaluate_smtp_health() contract, asserted here through the job
    so the job cannot quietly change it.
    """
    _seed_attempts(db_session, sent=1, failed=2)

    with patch(
        "app.database.SessionLocal", return_value=db_session
    ), patch("app.config.settings.ENABLE_EMAIL_SMTP_HEALTH_CHECK", True):
        result = run_email_smtp_health_job()

    assert result.get("smtp_health") == "unknown", result
    assert _attention_item(db_session) is None


def test_disabling_the_flag_skips_cleanly(db_session):
    """Independent kill switch.

    This is the concrete payoff of registering health as its OWN job rather
    than appending it to the recovery sweep: turning off crash-recovery
    (ENABLE_EMAIL_QUEUE_RECOVERY) must not take SMTP-health signal down
    with it, and turning off health must not stop the outbox sweep.
    """
    _seed_attempts(db_session, sent=1, failed=8)

    with patch(
        "app.database.SessionLocal", return_value=db_session
    ), patch("app.config.settings.ENABLE_EMAIL_SMTP_HEALTH_CHECK", False):
        result = run_email_smtp_health_job()

    assert result.get("skipped") is True, result
    assert _attention_item(db_session) is None


def test_job_is_registered_in_scheduler_with_its_own_interval():
    """The job must actually be SCHEDULED.

    A healthy run_email_smtp_health_job() proves nothing if no scheduler
    definition references it — that was the real on-read-only bug.
    """
    from app.core.scheduler import get_job_definitions

    defs = {d[2]: d for d in get_job_definitions()}

    assert "email_smtp_health_job" in defs, (
        "email_smtp_health_job is not in get_job_definitions() — it will "
        "never run on a schedule."
    )
    func_ref, interval, job_id, display_name = defs["email_smtp_health_job"]
    assert func_ref == (
        "app.services.email_foundation.health_task:run_email_smtp_health_job"
    )
    assert interval > 0
    assert "Email" in display_name

    # Independent of the recovery sweep: different job id, own interval.
    assert "email_queue_recovery_job" in defs
    assert defs["email_queue_recovery_job"][2] != job_id


def test_job_failure_is_contained_not_raised(db_session):
    """A raising evaluate_smtp_health must not take the scheduler down.

    Contained in the returned summary; _tracked_job_runner is what turns a
    genuinely dead job into an attention item.
    """
    with patch("app.database.SessionLocal", return_value=db_session), patch(
        "app.config.settings.ENABLE_EMAIL_SMTP_HEALTH_CHECK", True
    ), patch(
        "app.modules.super_admin.email_delivery_service.EmailDeliveryService"
        ".evaluate_smtp_health",
        side_effect=RuntimeError("boom"),
    ):
        result = run_email_smtp_health_job()

    assert "errors" in result, result
    assert "smtp_health" not in result
