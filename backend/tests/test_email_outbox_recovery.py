"""
tests/test_email_outbox_recovery.py
------------------------------------
B1 (durable outbox / crash-recovery), B2 (bounded SMTP retry) and B5
(attachment MIME subtype) regression tests for the email reliability fixes.

The B1 acceptance bar (see the crash-recovery test below) is specifically:
a send queued via async_send=True must survive the background thread pool
NEVER running its task at all (the "process crashed mid-flight" scenario) --
proven here by mocking submit_email_task to a no-op and then invoking the
recovery sweep directly, rather than merely testing the happy path where the
thread pool runs normally.
"""

import base64
import json
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import pytest
import smtplib

from app.database import Base
from app.services.email_foundation import CommunicationAuditLog, EmailOutbox, SendStatus
from app.services.email_service import (
    send_approval_email,
    _infer_attachment_subtype,
    _build_attachment_part,
)
from app.services.email_foundation.recovery import sweep_stuck_outbox_rows


@pytest.fixture(autouse=True)
def setup_tables(db_session):
    """Ensure foundation tables (including the new email_outbox table) exist
    in the test db_session -- same convention as test_email_foundation.py."""
    Base.metadata.create_all(bind=db_session.get_bind())


def _make_context(invoice_number="INV-9001"):
    return {
        "invoice_number": invoice_number,
        "company_name": "Acme Inc",
        "total_amount": "$500.00",
        "currency": "USD",
        "due_date": "2026-11-01",
    }


# ── B1: the actual crash-recovery acceptance bar ────────────────────────────

def test_async_send_writes_queued_outbox_row_before_background_thread_runs(db_session):
    """(a)+(b) of the acceptance bar: the outbox row must exist BEFORE the
    background thread pool ever executes anything. We prove this by patching
    submit_email_task to a no-op that never calls its argument at all -- so
    if a row exists afterward, it can only have been written by the
    synchronous code path in send_approval_email, not by the (never-run)
    background delivery function."""
    recipient = "outbox_test@example.com"

    with patch("app.services.email_foundation.submit_email_task") as mock_submit:
        mock_submit.return_value = None  # never invokes the delivery callable
        result = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(),
            db=db_session,
            organization_id=7,
            event_id="evt_outbox_test_1",
            async_send=True,
        )

    assert result is True
    mock_submit.assert_called_once()

    row = (
        db_session.query(EmailOutbox)
        .filter(EmailOutbox.recipient == recipient)
        .first()
    )
    assert row is not None
    assert row.status == "QUEUED"
    assert row.attempts == 0
    assert row.template_name == "invoice_sent.html"
    assert row.organization_id == 7

    stored_context = json.loads(row.context_json)
    assert stored_context["invoice_number"] == "INV-9001"

    # Nothing ever ran the actual SMTP delivery (mock_submit was a no-op), so
    # no CommunicationAuditLog SENT/FAILED row exists yet -- only the QUEUED
    # outbox row proves the send was durably recorded.
    audit_rows = (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == recipient)
        .all()
    )
    assert audit_rows == []


def test_recovery_sweep_finds_and_redelivers_a_stuck_queued_row(db_session):
    """(c) of the acceptance bar: simulate "the process died mid-flight" by
    writing a QUEUED outbox row whose background thread never ran (same
    no-op patch as above), backdating it past the grace period, and then
    invoking the recovery sweep directly -- proving it finds and redelivers
    the stuck row rather than the send being silently lost forever."""
    recipient = "recovery_test@example.com"

    with patch("app.services.email_foundation.submit_email_task"):
        send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9002"),
            db=db_session,
            organization_id=None,
            event_id="evt_recovery_test_1",
            async_send=True,
        )

    row = db_session.query(EmailOutbox).filter(EmailOutbox.recipient == recipient).first()
    assert row is not None and row.status == "QUEUED"

    # Backdate it past the grace window -- this is what "crashed a while ago
    # and nobody ever came back to it" looks like in the data.
    row.created_at = datetime.utcnow() - timedelta(minutes=30)
    db_session.commit()

    smtp_mock = MagicMock()
    with patch("smtplib.SMTP", return_value=smtp_mock), patch("smtplib.SMTP_SSL", return_value=smtp_mock):
        summary = sweep_stuck_outbox_rows(db_session, grace_minutes=10, max_attempts=5)

    assert summary["found"] == 1
    assert summary["redelivered"] == 1
    assert summary["failed"] == 0

    db_session.refresh(row)
    assert row.status == SendStatus.SENT.value
    assert row.attempts == 1

    audit_row = (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == recipient, CommunicationAuditLog.status == SendStatus.SENT.value)
        .first()
    )
    assert audit_row is not None
    assert audit_row.dedupe_key == row.dedupe_key


def test_recovery_sweep_ignores_rows_still_within_grace_period(db_session):
    """A row queued moments ago is presumably still legitimately in flight in
    a live thread pool -- the sweep must not touch it."""
    recipient = "fresh_queue_test@example.com"
    with patch("app.services.email_foundation.submit_email_task"):
        send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9003"),
            db=db_session,
            event_id="evt_recovery_test_2",
            async_send=True,
        )

    with patch("smtplib.SMTP") as smtp_ctor, patch("smtplib.SMTP_SSL") as smtp_ssl_ctor:
        summary = sweep_stuck_outbox_rows(db_session, grace_minutes=10, max_attempts=5)

    assert summary["found"] == 0
    smtp_ctor.assert_not_called()
    smtp_ssl_ctor.assert_not_called()


def test_recovery_sweep_stops_retrying_after_max_attempts(db_session):
    """Bounded retries: a row that has already failed max_attempts times is
    marked FAILED and left alone -- never retried forever."""
    recipient = "exhausted_test@example.com"
    with patch("app.services.email_foundation.submit_email_task"):
        send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9004"),
            db=db_session,
            event_id="evt_recovery_test_3",
            async_send=True,
        )

    row = db_session.query(EmailOutbox).filter(EmailOutbox.recipient == recipient).first()
    row.created_at = datetime.utcnow() - timedelta(minutes=30)
    row.attempts = 5
    db_session.commit()

    with patch("smtplib.SMTP") as smtp_ctor, patch("smtplib.SMTP_SSL") as smtp_ssl_ctor:
        summary = sweep_stuck_outbox_rows(db_session, grace_minutes=10, max_attempts=5)

    assert summary["exhausted"] == 1
    smtp_ctor.assert_not_called()
    smtp_ssl_ctor.assert_not_called()

    db_session.refresh(row)
    assert row.status == "FAILED"


def test_idempotency_blocks_duplicate_while_row_is_still_queued(db_session):
    """The dedup guarantee (IdempotencySupersessionEngine.is_duplicate) must
    hold end-to-end: while a send sits QUEUED in the outbox (background
    thread hasn't run / hasn't updated CommunicationAuditLog yet), a second
    send for the same dedupe_key must still be blocked as a duplicate."""
    recipient = "dedupe_outbox_test@example.com"
    event_id = "evt_dedupe_outbox_1"

    with patch("app.services.email_foundation.submit_email_task"):
        first = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9005"),
            db=db_session,
            event_id=event_id,
            async_send=True,
        )
        second = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9005"),
            db=db_session,
            event_id=event_id,
            async_send=True,
        )

    assert first is True
    assert second is False

    outbox_rows = db_session.query(EmailOutbox).filter(EmailOutbox.recipient == recipient).all()
    assert len(outbox_rows) == 1

    dup_log = (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == recipient, CommunicationAuditLog.status == SendStatus.DUPLICATE.value)
        .first()
    )
    assert dup_log is not None


# ── B2: bounded retry for transient SMTP failures ───────────────────────────

def test_transient_smtp_failure_is_retried_then_succeeds(db_session):
    recipient = "transient_retry_test@example.com"
    smtp_mock = MagicMock()
    smtp_mock.__enter__.return_value = smtp_mock
    smtp_mock.sendmail.side_effect = [
        smtplib.SMTPServerDisconnected("Connection unexpectedly closed"),
        None,  # second attempt succeeds
    ]

    with patch("smtplib.SMTP", return_value=smtp_mock), patch("smtplib.SMTP_SSL", return_value=smtp_mock), \
         patch("app.services.email_service.time.sleep"):
        result = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9006"),
            db=db_session,
            event_id="evt_transient_retry_1",
        )

    assert result is True
    assert smtp_mock.sendmail.call_count == 2

    audit_row = (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == recipient, CommunicationAuditLog.status == SendStatus.SENT.value)
        .first()
    )
    assert audit_row is not None


def test_permanent_smtp_failure_is_not_retried(db_session):
    recipient = "permanent_failure_test@example.com"
    smtp_mock = MagicMock()
    smtp_mock.__enter__.return_value = smtp_mock
    smtp_mock.sendmail.side_effect = smtplib.SMTPRecipientsRefused({recipient: (550, b"No such user")})

    with patch("smtplib.SMTP", return_value=smtp_mock), patch("smtplib.SMTP_SSL", return_value=smtp_mock), \
         patch("app.services.email_service.time.sleep") as mock_sleep:
        result = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context=_make_context(invoice_number="INV-9007"),
            db=db_session,
            event_id="evt_permanent_failure_1",
        )

    assert result is False
    assert smtp_mock.sendmail.call_count == 1  # never retried
    mock_sleep.assert_not_called()

    audit_row = (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == recipient, CommunicationAuditLog.status == SendStatus.FAILED.value)
        .first()
    )
    assert audit_row is not None


# ── B5: attachment MIME subtype derived from filename, not hardcoded "pdf" ──

@pytest.mark.parametrize("filename,expected_subtype,expected_content_type", [
    ("invoice.pdf", "pdf", "application/pdf"),
    ("export.csv", "csv", "application/csv"),
    ("logo.png", "png", "application/png"),
    ("photo.jpg", "jpeg", "application/jpeg"),
    ("photo.jpeg", "jpeg", "application/jpeg"),
    ("mystery.xyz", "octet-stream", "application/octet-stream"),
    ("no_extension", "octet-stream", "application/octet-stream"),
])
def test_attachment_subtype_derived_from_filename(filename, expected_subtype, expected_content_type):
    assert _infer_attachment_subtype(filename) == expected_subtype

    part = _build_attachment_part(filename, b"dummy-bytes")
    assert part.get_content_type() == expected_content_type
