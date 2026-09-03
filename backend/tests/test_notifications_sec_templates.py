"""
tests/test_notifications_sec_templates.py
------------------------------------------
Phase 1 template tests: the four newly-wired ZB-SEC-* hook points
(password changed, account locked, admin MFA reset, privileged-access
request), plus a dark-shell parity check against LoginPage.jsx's verified
color tokens.

Follows the existing repo convention of monkeypatching
email_service.send_approval_email directly (see
test_session8_login_currency_notification.py) rather than a captured-SMTP
outbox.
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy.orm import sessionmaker

from tests.conftest import make_organization

from app.config import settings
from app.core.security import hash_password
from app.modules.auth import mfa_service, service as auth_service
from app.modules.auth.models import SuperAdminMFA, User, UserRole
from app.modules.notifications.shell_renderer import render_t0_shell
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService


def _patch_send(monkeypatch, db_session):
    """Lets _execute_send run for real (own SessionLocal pointed at this
    test's in-memory engine) while capturing what would have been emailed."""
    calls = []

    def _fake_send(email, template_name, context, db=None, organization_id=None, **kwargs):
        calls.append({"email": email, "context": context, "html": kwargs.get("template_body")})
        return True

    monkeypatch.setattr("app.services.email_service.send_approval_email", _fake_send)
    monkeypatch.setattr(
        "app.database.SessionLocal",
        sessionmaker(bind=db_session.get_bind(), autoflush=False, autocommit=False),
    )
    return calls


def _make_user(db, *, email, org_id=None, role=UserRole.ORG_ADMIN, first_name="Alex"):
    user = User(
        email=email,
        hashed_password=hash_password("Sup3rSecret!"),
        role=role,
        organization_id=org_id,
        first_name=first_name,
        last_name="Test",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def test_zb_sec_004_password_changed(db_session, monkeypatch):
    calls = _patch_send(monkeypatch, db_session)
    org = make_organization(db_session)
    user = _make_user(db_session, email="pwchange@example.com", org_id=org.id)
    old_hash = user.hashed_password

    auth_service.change_password(db_session, user.id, "Sup3rSecret!", "N3wSecret!!")

    assert user.hashed_password != old_hash
    assert len(calls) == 1
    assert calls[0]["email"] == "pwchange@example.com"
    assert "unsubscribe" not in calls[0]["html"].lower()


def test_zb_sec_010_account_locked_fires_once(db_session, monkeypatch):
    calls = _patch_send(monkeypatch, db_session)
    user = _make_user(db_session, email="lockout@example.com", role=UserRole.ORG_ADMIN)
    db_session.commit()

    max_attempts = settings.LOGIN_MAX_FAILED_ATTEMPTS
    for _ in range(max_attempts):
        with pytest.raises(Exception):
            auth_service.login_user(db_session, "lockout@example.com", "wrong-password")

    assert len(calls) == 1  # fired exactly once, on the locking transition

    # A further attempt while still locked must not refire.
    with pytest.raises(Exception):
        auth_service.login_user(db_session, "lockout@example.com", "wrong-password")
    assert len(calls) == 1


def test_zb_sec_017_admin_mfa_reset(db_session, monkeypatch):
    calls = _patch_send(monkeypatch, db_session)
    actor = _make_user(db_session, email="actor-admin@example.com", role=UserRole.SUPER_ADMIN)
    target = _make_user(db_session, email="target-user@example.com", role=UserRole.SUPER_ADMIN)
    db_session.add(
        SuperAdminMFA(user_id=target.id, secret_encrypted="dummy", is_enabled=True)
    )
    db_session.commit()

    mfa_service.admin_reset_mfa(db_session, actor, target.id)

    assert len(calls) == 1
    assert calls[0]["email"] == "target-user@example.com"
    assert "unsubscribe" not in calls[0]["html"].lower()
    assert "promo" not in calls[0]["html"].lower()


def test_zb_sec_018_privileged_access_notifies_org_admin_not_actor(db_session, monkeypatch):
    calls = _patch_send(monkeypatch, db_session)
    org = make_organization(db_session)
    other_org = make_organization(db_session, code="ORG2", name="Other Org")

    org_admin = _make_user(db_session, email="org-admin@example.com", org_id=org.id, role=UserRole.ORG_ADMIN)
    unrelated_admin = _make_user(
        db_session, email="unrelated-admin@example.com", org_id=other_org.id, role=UserRole.ORG_ADMIN
    )
    actor = _make_user(db_session, email="support-actor@example.com", role=UserRole.SUPER_ADMIN)
    db_session.commit()

    PrivilegedAccessService(db_session).request_access(
        actor=actor,
        organization_id=org.id,
        reason="Investigating a billing discrepancy",
        ticket_reference="TICKET-123",
    )

    recipients = {c["email"] for c in calls}
    assert recipients == {"org-admin@example.com"}
    assert "unrelated-admin@example.com" not in recipients
    assert "support-actor@example.com" not in recipients


def test_t0_shell_matches_login_page_color_tokens():
    html = render_t0_shell(
        eyebrow="Security Notice", heading="Test heading", body_html="<p>Body</p>",
        cta_label="Continue", cta_url="https://example.com",
    )
    # Chrome matches org_created.html; CTA matches LoginPage.jsx exactly.
    assert "#0B0F19" in html
    assert "#0F172A" in html
    assert "#60A5FA" in html
    assert "linear-gradient(135deg, #2563EB, #1D4ED8)" in html
    assert "0 4px 16px rgba(37,99,235,0.35)" in html
    assert "border-radius: 50px" in html
    assert "unsubscribe" not in html.lower()
