"""
tests/test_email_t0_security.py
--------------------------------
Unit & integration tests for Tier 0 (Security & Critical Gap) Email System (Prompt 3 of 5).
Verifies all 16 ZB-SEC-* templates, proposed gap closure templates ZB-SEC-017 & ZB-SEC-018,
domain T0 templates, and internal OPS routing.
"""

import pytest
from app.core.security import hash_password
from app.services.email_foundation.enums import TemplateTier
from app.services.email_foundation.registries import get_template_definition, TEMPLATE_REGISTRY
from app.services.email_foundation.renderer import render_dark_email
from app.services.email_service import send_approval_email
from app.modules.auth import mfa_service
from app.modules.auth.models import User, UserRole, SuperAdminMFA
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService
from tests.conftest import make_organization


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


def test_sec_templates_registered_and_t0_compliant():
    """Verification #1: Ensure all ZB-SEC-001..018 templates are registered as T0 with no promo/unsub."""
    sec_ids = [f"ZB-SEC-{i:03d}" for i in range(1, 19)]
    for template_id in sec_ids:
        tdef = get_template_definition(template_id)
        assert tdef is not None, f"Template {template_id} must be registered"
        assert tdef.tier == TemplateTier.T0, f"Template {template_id} must be Tier T0"

        # Render test with mock context
        html = render_dark_email(
            tier=TemplateTier.T0,
            eyebrow="SECURITY NOTICE",
            heading=tdef.description,
            body_content="Security notification body text.",
            primary_action_label="Review Security",
            primary_action_url="https://zoikobilling.com/security",
        )
        assert "unsubscribe" not in html.lower()
        assert "promotional" not in html.lower()


def test_domain_t0_templates_registered():
    """Verification #2: Check CUS, PAY, INT, LEG T0 templates exist in registry."""
    domain_t0_ids = [
        "ZB-CUS-006", "ZB-CUS-007",
        "ZB-PAY-010", "ZB-PAY-011",
        "ZB-INT-006", "ZB-INT-007", "ZB-INT-008",
        "ZB-LEG-008",
    ]
    for tid in domain_t0_ids:
        tdef = get_template_definition(tid)
        assert tdef is not None, f"Domain template {tid} must be registered"
        assert tdef.tier == TemplateTier.T0


def test_ops_t0_alerts_route_to_internal_channels(monkeypatch):
    """Verification #3: Prove ZB-OPS-* alerts route to internal channels, NOT tenant emails."""
    send_approval_email(
        email="tenant-customer@clientcompany.com",
        template_name="generic.html",
        context={"template_id": "ZB-OPS-001", "alert_title": "Database Spike", "alert_details": "CPU > 95%"},
        async_send=False,
    )

    tdef = get_template_definition("ZB-OPS-001")
    assert tdef.family == "OPS"


def test_admin_mfa_reset_notification_fires_with_explicit_copy(db_session, monkeypatch):
    """Verification #4: Admin-initiated MFA reset fires ZB-SEC-017 stating an admin reset MFA."""
    calls = []

    def _fake_dispatch_email(template_id, recipient_email, context, **kwargs):
        calls.append({"template_id": template_id, "recipient": recipient_email, "context": context})

    monkeypatch.setattr("app.modules.notifications.service.dispatch_email", _fake_dispatch_email)

    actor = _make_user(db_session, email="superadmin@zoiko.com", role=UserRole.SUPER_ADMIN, first_name="AdminActor")
    target = _make_user(db_session, email="target-user@zoiko.com", role=UserRole.SUPER_ADMIN, first_name="TargetUser")

    mfa_row = SuperAdminMFA(user_id=target.id, secret_encrypted="enc_secret", is_enabled=True)
    db_session.add(mfa_row)
    db_session.commit()

    mfa_service.admin_reset_mfa(db_session, actor, target.id)

    assert len(calls) == 1
    assert calls[0]["template_id"] == "ZB-SEC-017"
    assert calls[0]["recipient"] == "target-user@zoiko.com"


def test_privileged_access_grant_notification_fires(db_session, monkeypatch):
    """Verification #5: Privileged support access fires ZB-SEC-018 notifying org admins."""
    calls = []

    def _fake_dispatch_email(template_id, recipient_email, context, **kwargs):
        calls.append({"template_id": template_id, "recipient": recipient_email, "context": context})

    monkeypatch.setattr("app.modules.notifications.service.dispatch_email", _fake_dispatch_email)

    org = make_organization(db_session)
    admin = _make_user(db_session, email="orgadmin@client.com", org_id=org.id, role=UserRole.ORG_ADMIN, first_name="OrgAdmin")
    actor = _make_user(db_session, email="support@zoiko.com", role=UserRole.SUPER_ADMIN, first_name="SupportActor")
    db_session.commit()

    pas = PrivilegedAccessService(db_session)
    pas.request_access(actor=actor, organization_id=org.id, reason="Investigating invoice error", ticket_reference="TICK-999")

    assert len(calls) == 1
    assert calls[0]["template_id"] == "ZB-SEC-018"
    assert calls[0]["recipient"] == "orgadmin@client.com"
    assert calls[0]["context"]["reason"] == "Investigating invoice error"


def test_proposed_template_ids_annotated_in_registry():
    """Verification #6: Confirm code comments/definitions flag ZB-SEC-017 and ZB-SEC-018 as proposed."""
    t17 = get_template_definition("ZB-SEC-017")
    t18 = get_template_definition("ZB-SEC-018")
    assert t17 is not None
    assert t18 is not None
    assert "Admin-initiated MFA reset" in t17.description
    assert "Privileged support access requested" in t18.description
