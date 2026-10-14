"""
tests/test_email_defensive_read_savepoints.py
---------------------------------------------
Regression for a production incident class: a single defensive DB read that
fails mid-email-send (schema drift from an unapplied migration, a deadlock, a
transient network blip) used to poison the caller's WHOLE transaction on
Postgres. Every later query -- including the SMTP-settings read and the SENT
audit-log insert -- then failed with "current transaction is aborted", so
send_approval_email returned False and every invitation/notification resend
reported "Invitation link was regenerated, but the email could not be
delivered" even though SMTP was fine (sometimes even after the message had
actually left).

`_get_org_branding` and `_get_smtp_settings` now wrap their DB reads in a
savepoint (`db.begin_nested()`), so a failure rolls back only the nested
block and the outer session stays usable.

The behavioural tests drive REAL failing statements (a query against a table
that does not exist) -- not mocked exceptions -- so they also survive a
backend like Postgres where the first failed statement aborts the entire
current transaction.
"""
import pytest
from sqlalchemy import Column, Integer, String, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, declarative_base

from app.database import Base
from app.modules.organizations.models import Organization
from app.services.email_foundation.models import (
    CommunicationAuditLog,
    EmailMarketingConsent,
    EmailOrgPreference,
    EmailSuppression,
)
from app.services.email_service import _get_org_branding, _get_smtp_settings, send_user_invite_email
import app.services.email_service as email_service_module

# Imported for side effects: registers the PlatformSetting model on
# Base.metadata so the db_session create_all() provisions its table.
from app.modules.super_admin.models import PlatformSetting  # noqa: F401

HERE = "savepoint-qa@zoiko-demo.com"


@pytest.fixture(autouse=True)
def provision_foundation_tables(db_session):
    """Ensure the email-foundation + platform tables exist in the throwaway
    test DB (same pattern as test_invite_email_resend_dedupe.py)."""
    Base.metadata.create_all(bind=db_session.get_bind())


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
    monkeypatch.setattr(email_service_module.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(email_service_module.smtplib, "SMTP_SSL", FakeSMTP)


def _seed_org(db_session):
    org = Organization(organization_name="Savepoint Org", organization_code="SAVEPT1", is_active=True)
    db_session.add(org)
    db_session.flush()
    return org


def test_send_survives_branding_read_failure_and_still_audits_sent(db_session, monkeypatch):
    """A real DB error inside org-branding recovery (the unapplied-migration
    scenario) must not poison the send: message still delivered, SENT audit
    row still written, and the caller's session still usable."""
    from app.modules.billing.services import settings_service

    def _broken_get_configuration(self, organization_id, *args, **kwargs):
        # A REAL failing statement, exactly what an unapplied migration that
        # the ORM still references produces. This aborts the current
        # transaction on every SQL backend unless contained in a savepoint.
        db_session.execute(text("SELECT * FROM __no_such_branding_table__"))
        raise AssertionError("unreachable")

    monkeypatch.setattr(
        settings_service.BillingConfigurationService,
        "get_configuration",
        _broken_get_configuration,
    )

    org = _seed_org(db_session)
    result = send_user_invite_email(
        db=db_session,
        email=HERE,
        first_name="Savepoint",
        invite_link="https://app.zoikobilling.com/accept?token=probe",
        invited_by="Org Admin",
        organization_id=org.id,
    )

    # The send itself succeeded despite the poisoned-fragment read.
    assert result is True
    assert len(FakeSMTP.sent_messages) == 1

    # The SENT audit row was committed -- impossible if the branding error
    # had aborted the whole transaction (the pre-fix "could not be
    # delivered" symptom).
    logs = (
        db_session.query(CommunicationAuditLog)
        .filter(CommunicationAuditLog.recipient == HERE)
        .all()
    )
    assert len(logs) == 1
    assert logs[0].status == "SENT"

    # Caller's session stayed usable after the recovered failure.
    assert db_session.execute(text("SELECT 1")).scalar() == 1


def test_smtp_settings_query_failure_returns_defaults_and_keeps_session_usable(db_session, monkeypatch):
    """A real DB error in the PlatformSetting read must fall back to the
    process defaults and leave the session usable -- NOT make every later
    query fail."""

    FakeTableBase = declarative_base()

    class _MissingPlatformSettings(FakeTableBase):
        __tablename__ = "__no_such_platform_settings_table__"
        id = Column(Integer, primary_key=True)
        key = Column(String)
        value = Column(String)
        category = Column(String)

    monkeypatch.setattr(
        "app.modules.super_admin.models.PlatformSetting",
        _MissingPlatformSettings,
    )

    smtp = _get_smtp_settings(db=db_session)

    # Fell back to process env defaults instead of raising / aborting.
    from app.config import settings as real_settings

    assert smtp["host"] == real_settings.SMTP_HOST
    assert smtp["port"] == real_settings.SMTP_PORT
    assert smtp["username"] == real_settings.SMTP_USERNAME
    assert smtp["from_email"] == real_settings.SMTP_FROM_EMAIL

    # Session still usable: a subsequent real query works.
    assert db_session.execute(text("SELECT 1")).scalar() == 1


def test_defensive_reads_are_wrapped_in_savepoints(db_session, monkeypatch):
    """Pin the savepoint wrapping itself. The behavioural tests above prove
    recovery on SQLite, but Postgres is the backend that aborts the whole
    transaction on a failed statement -- so this structural guard keeps the
    fix in place even when CI/tests run on a forgiving engine."""

    from sqlalchemy.orm import Session as _Session

    calls = []
    original = _Session.begin_nested

    def _recording(self, *args, **kwargs):
        calls.append(True)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(_Session, "begin_nested", _recording)

    org = _seed_org(db_session)
    _get_org_branding(org.id, db=db_session)
    _get_smtp_settings(db=db_session)

    assert calls, "defensive email reads must be contained in a savepoint"