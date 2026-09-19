"""
tests/test_email_foundation.py
-------------------------------
Unit & integration tests for Foundation Infrastructure (Prompt 1 of 5)
of the Zoiko Billing Email System.
"""

import time
import pytest
from unittest.mock import patch, MagicMock

from app.database import Base
from app.services.email_foundation import (
    TemplateTier,
    SendStatus,
    SuppressionReason,
    EmailSuppression,
    EmailMarketingConsent,
    CommunicationAuditLog,
    TierEnforcementError,
    VariableValidationError,
    validate_tier_compliance,
    validate_variable_contract,
    get_template_definition,
    ConsentSuppressionEngine,
    IdempotencySupersessionEngine,
)
from app.services.email_service import send_approval_email


@pytest.fixture(autouse=True)
def setup_tables(db_session):
    """Ensure foundation tables exist in test db_session."""
    Base.metadata.create_all(bind=db_session.get_bind())


def test_t0_tier_enforcement_blocks_promo_and_unsub():
    """Verification #4: Prove T0 template cannot render with promo content or unsubscribe link."""
    # Disallowed promo context key in T0
    with pytest.raises(TierEnforcementError) as exc_info:
        validate_tier_compliance(
            TemplateTier.T0,
            {"company_name": "Zoiko", "promotional_content": "20% Off sale!"},
        )
    assert "promotional content" in str(exc_info.value)

    # Disallowed unsubscribe link in T0 context
    with pytest.raises(TierEnforcementError) as exc_info:
        validate_tier_compliance(
            TemplateTier.T0,
            {"company_name": "Zoiko", "unsubscribe_url": "https://example.com/unsub"},
        )
    assert "unsubscribe links" in str(exc_info.value)

    # Disallowed unsubscribe link in T0 HTML body
    with pytest.raises(TierEnforcementError) as exc_info:
        validate_tier_compliance(
            TemplateTier.T0,
            {"company_name": "Zoiko"},
            html_content="<p>Welcome</p><a href='http://unsub.com'>Unsubscribe</a>",
        )
    assert "unsubscribe link" in str(exc_info.value)


def test_suppression_bounced_recipient_blocked(db_session):
    """Verification #3: Prove suppressed/bounced recipient never receives mail regardless of tier."""
    bounced_email = "bounced_user@example.com"
    db_session.add(EmailSuppression(email_address=bounced_email, reason="BOUNCE"))
    db_session.commit()

    # Check eligibility for T0 (Critical), T1 (Billing), and T4 (Marketing)
    for tier in (TemplateTier.T0, TemplateTier.T1, TemplateTier.T4):
        eligible, reason = ConsentSuppressionEngine.check_send_eligibility(
            db_session, bounced_email, organization_id=1, tier=tier, family="INV"
        )
        assert not eligible, f"Bounced recipient should be suppressed for tier {tier}"
        assert reason == SuppressionReason.BOUNCE

    # Verify send_approval_email returns False and logs SUPPRESSED audit record
    with patch("smtplib.SMTP"), patch("smtplib.SMTP_SSL"):
        result = send_approval_email(
            email=bounced_email,
            template_name="org_created.html",
            context={"company_name": "Test Org"},
            db=db_session,
            organization_id=1,
        )
        assert result is False

        log = (
            db_session.query(CommunicationAuditLog)
            .filter(CommunicationAuditLog.recipient == bounced_email)
            .first()
        )
        assert log is not None
        assert log.status == SendStatus.SUPPRESSED.value
        assert log.suppression_reason == SuppressionReason.BOUNCE.value


def test_idempotency_duplicate_event_blocked(db_session):
    """Verification #1: Prove duplicate event does not produce a duplicate send."""
    recipient = "duplicate_test@example.com"
    event_id = "evt_invoice_1001_send"

    with patch("smtplib.SMTP"), patch("smtplib.SMTP_SSL"):
        # First send should succeed
        res1 = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context={
                "invoice_number": "INV-1001",
                "company_name": "Acme Inc",
                "total_amount": "$100.00",
                "currency": "USD",
                "due_date": "2026-10-01",
            },
            db=db_session,
            event_id=event_id,
        )
        assert res1 is True

        # Second send with SAME event_id + recipient should be blocked as DUPLICATE
        res2 = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context={
                "invoice_number": "INV-1001",
                "company_name": "Acme Inc",
                "total_amount": "$100.00",
                "currency": "USD",
                "due_date": "2026-10-01",
            },
            db=db_session,
            event_id=event_id,
        )
        assert res2 is False

        # Check audit log records
        logs = (
            db_session.query(CommunicationAuditLog)
            .filter(CommunicationAuditLog.recipient == recipient)
            .order_by(CommunicationAuditLog.id.asc())
            .all()
        )
        assert len(logs) == 2
        assert logs[0].status == SendStatus.SENT.value
        assert logs[1].status == SendStatus.DUPLICATE.value


def test_supersession_suppresses_stale_event(db_session):
    """Verification #2: Prove superseded event suppresses the stale queued one."""
    recipient = "supersession_test@example.com"
    invoice_id = "INV-2002"

    # Create a queued audit log for a stale event (invoice.past_due)
    db_session.add(
        CommunicationAuditLog(
            recipient=recipient,
            template_id="ZB-INV-013",
            event_name="invoice.past_due",
            target_record_id=invoice_id,
            tier=TemplateTier.T1.value,
            status=SendStatus.QUEUED.value,
        )
    )
    db_session.commit()

    # Execute supersession when invoice.paid occurs for the same invoice_id
    count = IdempotencySupersessionEngine.apply_supersession(
        db_session, recipient=recipient, target_record_id=invoice_id, event_name="invoice.paid"
    )
    assert count == 1

    # Verify audit log updated to SUPERSEDED
    log = (
        db_session.query(CommunicationAuditLog)
        .filter(
            CommunicationAuditLog.recipient == recipient,
            CommunicationAuditLog.target_record_id == invoice_id,
        )
        .first()
    )
    assert log.status == SendStatus.SUPERSEDED.value


def test_async_send_does_not_block_thread(db_session):
    """Verification #5: Prove no send blocks the calling request thread."""
    recipient = "async_test@example.com"
    slow_smtp_mock = MagicMock()

    def slow_sendmail(*args, **kwargs):
        time.sleep(0.5)

    slow_smtp_mock.sendmail.side_effect = slow_sendmail

    with patch("smtplib.SMTP", return_value=slow_smtp_mock), patch("smtplib.SMTP_SSL", return_value=slow_smtp_mock):
        start_time = time.time()
        res = send_approval_email(
            email=recipient,
            template_name="invoice_sent.html",
            context={
                "invoice_number": "INV-3003",
                "company_name": "Acme Inc",
                "total_amount": "$300.00",
                "currency": "USD",
                "due_date": "2026-10-01",
            },
            db=db_session,
            async_send=True,
        )
        duration = time.time() - start_time

        # Should return immediately (< 0.2 seconds) even if SMTP takes 0.5s
        assert res is True
        assert duration < 0.2

        # Allow background thread worker to complete
        time.sleep(0.6)


def test_variable_contract_validation():
    """Verify required variables contract validation."""
    template_def = get_template_definition("ZB-INV-006")
    assert template_def is not None

    # Missing required variable 'total_amount'
    with pytest.raises(VariableValidationError) as exc_info:
        validate_variable_contract(
            template_def,
            {
                "invoice_number": "INV-001",
                "company_name": "Zoiko",
                "currency": "USD",
                "due_date": "2026-10-01",
            },
        )
    assert "total_amount" in str(exc_info.value)
