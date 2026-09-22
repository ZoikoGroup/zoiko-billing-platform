"""
tests/test_invite_email_resend_dedupe.py
----------------------------------------
Regression coverage for the Billing Admin invitation email flow.

Reported bug: when an Organization Admin invites a Billing Admin the UI
shows the invitation email failed ("Mail not sent"). The root cause, verified
live, is the wrong SMTP credentials configured for the GoDaddy relay
(smtpout.secureserver.net:465) -> SMTPAuthenticationError (535). That is an
external email configuration issue, NOT a code defect.

During triage a second, distinct CODE defect surfaced: re-sending an
invitation (after a session where the first email delivered successfully)
was silently blocked by the IdempotencySupersessionEngine. The invite email
was sent without an event_id, so the dedupe key collapsed to
sha256(template_id:email); the resend (new token already issued and linked)
therefore matched the previous send exactly and was logged as Status.DUPLICATE
instead of being re-delivered. `send_user_invite_email` now attaches a fresh
per-attempt event_id so every send (initial AND resend) is a distinct
occurrence while callers that supply their own event_id keep idempotency.

These tests drive the REAL send_user_invite_email / send_approval_email
pipeline (template render, contract validation, consent/suppression gate,
idempotency dedupe, audit logging) with only the SMTP transport faked in
memory -- no real network email is ever performed.
"""
import pytest

from app.database import Base
from app.modules.organizations.models import Organization
from app.services.email_foundation.models import (
    CommunicationAuditLog,
    EmailMarketingConsent,
    EmailOrgPreference,
    EmailSuppression,
)
from app.services.email_service import send_user_invite_email
import app.services.email_service as email_service_module

# Imported for side effects: registers the PlatformAuditLog (platform
# audit) model on Base.metadata at import time so the db_session
# create_all() fixture provisions its table for the router-level test.
from app.modules.super_admin.models import PlatformAuditLog  # noqa: F401

from app.modules.auth.models import User, UserRole, SecurityActionPurpose
from app.modules.auth import service as auth_service
from app.modules.auth.router import resend_invite

HERE = "resend-dedup@zoiko-demo.com"


@pytest.fixture(autouse=True)
def provision_foundation_tables(db_session):
    """Ensure the email-foundation tables exist in the throwaway test DB
    (same pattern as test_email_foundation.py)."""
    Base.metadata.create_all(bind=db_session.get_bind())


def _seed_org_admin(db_session, org_id, email):
    from app.core.security import hash_password

    owner = User(
        email=email,
        hashed_password=hash_password("CorrectPass123!"),
        role=UserRole.ORG_ADMIN,
        organization_id=org_id,
        first_name="Dedup",
        last_name="Admin",
        is_active=True,
        is_verified=True,
    )
    db_session.add(owner)
    db_session.flush()
    return owner


def _seed_invitee(db_session, org_id, email, role=UserRole.BILLING_ADMIN):
    from app.core.security import hash_password

    invitee = User(
        email=email,
        hashed_password=hash_password("CorrectPass123!"),
        role=role,
        organization_id=org_id,
        first_name="Dedup",
        last_name="Invitee",
        is_active=True,
        is_verified=False,
    )
    db_session.add(invitee)
    db_session.flush()
    return invitee


def _send_invite(db_session, org_id, invitee, actor):
    """Invoke the real invite pipeline (token issue + verified email send)
    exactly as the ORG_ADMIN invite router does. Returns the pipeline
    result."""
    raw_token, _ = auth_service._issue_action_token(
        db_session,
        invitee.email,
        org_id,
        SecurityActionPurpose.INVITE,
    )
    link = auth_service._action_link(SecurityActionPurpose.INVITE, raw_token)
    db_session.commit()
    return send_user_invite_email(
        db=db_session,
        email=invitee.email,
        first_name=invitee.first_name,
        invite_link=link,
        invited_by=actor.first_name + " " + actor.last_name,
        organization_id=org_id,
    )


def _audit_logs(db_session, email):
    return (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == email)
        .order_by(CommunicationAuditLog.id.asc())
        .all()
    )


class FakeSMTP:
    """In-memory SMTP stand-in: accepts connection/login, captures every
    sendmail payload on the class attribute; never touches the network."""

    sent_messages = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False

    def login(self, user, password):
        return (235, b"auth ok")

    def starttls(self, *args, **kwargs):
        return (220, b"tls ready")

    def sendmail(self, from_addr, to_addrs, msg):
        FakeSMTP.sent_messages.append((from_addr, to_addrs, msg))
        return {}

    def quit(self):
        pass


@pytest.fixture(autouse=True)
def fake_smtp_transport(monkeypatch):
    FakeSMTP.sent_messages = []
    # Patch both classes: send_approval_email picks SMTP_SSL for
    # port 465, SMTP otherwise, depending on the active .env settings.
    monkeypatch.setattr(email_service_module.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(email_service_module.smtplib, "SMTP_SSL", FakeSMTP)


class TestInviteSendAndResendAreNotMisDeduped:
    def test_first_invite_send_result_true_and_audited_as_sent(self, db_session):
        org = Organization(organization_name="Dedup Org", organization_code="DEDUP1", is_active=True)
        db_session.add(org)
        db_session.flush()
        actor = _seed_org_admin(db_session, org.id, "dedup-owner@zoiko-demo.com")
        invitee = _seed_invitee(db_session, org.id, HERE)

        result = _send_invite(db_session, org.id, invitee, actor)

        assert result is True
        logs = _audit_logs(db_session, HERE)
        assert len(logs) == 1
        assert logs[0].status == "SENT"
        assert logs[0].template_id == "ZB-COM-002"
        assert len(FakeSMTP.sent_messages) == 1

    def test_resend_after_successful_send_is_delivered_not_marked_duplicate(self, db_session):
        """REGRESSION: resend with a previously-successful send was returned
        False + Status.DUPLICATE (silently swallowed) before the event_id fix.
        It must now be delivered again and audited as SENT, with distinct
        dedupe keys proving each attempt is its own occurrence."""
        org = Organization(organization_name="Dedup Org", organization_code="DEDUP2", is_active=True)
        db_session.add(org)
        db_session.flush()
        actor = _seed_org_admin(db_session, org.id, "dedup-owner2@zoiko-demo.com")
        invitee = _seed_invitee(db_session, org.id, HERE)

        first = _send_invite(db_session, org.id, invitee, actor)
        second = _send_invite(db_session, org.id, invitee, actor)

        assert first is True
        assert second is True, "resend to an already-successfully-invited recipient must be sent"
        logs = _audit_logs(db_session, HERE)
        assert [log.status for log in logs] == ["SENT", "SENT"]
        assert logs[0].dedupe_key != logs[1].dedupe_key
        assert len(FakeSMTP.sent_messages) == 2


class TestDiscourageInviteResendRouter:
    def test_resend_endpoint_reports_email_sent_truthfully(self, db_session):
        """End-to-end through the ORG_ADMIN resend-invite router with the
        real email pipeline and a healthy (faked) SMTP transport: the route
        must return email_sent=True / a resend confirmation."""
        org = Organization(organization_name="Dedup Org", organization_code="DEDUP3", is_active=True)
        db_session.add(org)
        db_session.flush()
        actor = _seed_org_admin(db_session, org.id, "dedup-owner3@zoiko-demo.com")
        invitee = _seed_invitee(db_session, org.id, HERE)

        result = resend_invite(invitee.id, current_user=actor, db=db_session)

        assert result["email_sent"] is True
        assert result["message"]
        logs = _audit_logs(db_session, HERE)
        assert logs and logs[-1].status == "SENT"

    def test_resend_is_rejected_for_never_invited_user(self, db_session):
        """Guardrail kept intact: resending an invitation for a user with no
        invite-to-pending state must fail cleanly (reference behavior for the
        PoC -- the router raises a 404 & safe email never goes out)."""
        org = Organization(organization_name="Dedup Org", organization_code="DEDUP4", is_active=True)
        db_session.add(org)
        db_session.flush()
        actor = _seed_org_admin(db_session, org.id, "dedup-owner4@zoiko-demo.com")
        verified_user = _seed_invitee(
            db_session, org.id, "dedup-verified@zoiko-demo.com", role=UserRole.BILLING_ADMIN
        )
        verified_user.is_verified = True
        db_session.flush()

        from fastapi import HTTPException

        with pytest.raises(HTTPException):
            resend_invite(verified_user.id, current_user=actor, db=db_session)