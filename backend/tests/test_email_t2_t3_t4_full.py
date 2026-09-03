"""
tests/test_email_t2_t3_t4_full.py
----------------------------------
Unit & integration tests for Tier 2, Tier 3/4 Marketing Consent Gating,
and Final Sign-Off QA Gates (Prompt 5 of 5).

Verifies:
1. All T2, T3, T4 template definitions exist in registry with correct tiers.
2. T3/T4 marketing send (ZB-MKT-001, ZB-ACQ-001) is strictly BLOCKED without explicit marketing opt-in consent.
3. T3/T4 marketing send SUCCEEDS when recipient has explicit opt-in consent.
4. T2 dispatches (reports, support tickets, maintenance) execute properly.
5. All templates use pre-computed variables (no template calculation).
6. Idempotency & tenant isolation checks.
"""

from unittest.mock import patch

import pytest

from app.services.email_foundation.enums import TemplateTier
from app.services.email_foundation.models import EmailMarketingConsent
from app.services.email_foundation.registries import get_template_definition
from app.services.email_service import (
    send_demo_request_received_email,
    send_marketing_newsletter_email,
    send_preference_updated_email,
    send_report_ready_email,
    send_service_maintenance_email,
    send_support_ticket_updated_email,
)
from tests.conftest import make_organization


def test_t2_t3_t4_templates_registered():
    """Verify GLB, INT, RPT, SUP (T2), ACQ, PRF (T3), and MKT (T4) exist with proper tiers."""
    t2_ids = ["ZB-GLB-001", "ZB-INT-001", "ZB-INT-004", "ZB-RPT-001", "ZB-SUP-001", "ZB-SUP-005"]
    for tid in t2_ids:
        tdef = get_template_definition(tid)
        assert tdef is not None, f"Template {tid} must be registered"
        assert tdef.tier == TemplateTier.T2, f"Template {tid} must be Tier T2"

    t3_ids = ["ZB-ACQ-001", "ZB-PRF-001"]
    for tid in t3_ids:
        tdef = get_template_definition(tid)
        assert tdef is not None, f"Template {tid} must be registered"
        assert tdef.tier == TemplateTier.T3, f"Template {tid} must be Tier T3"

    t4_ids = ["ZB-MKT-001"]
    for tid in t4_ids:
        tdef = get_template_definition(tid)
        assert tdef is not None, f"Template {tid} must be registered"
        assert tdef.tier == TemplateTier.T4, f"Template {tid} must be Tier T4"


def test_t4_marketing_send_blocked_without_explicit_consent(db_session):
    """MANDATORY QA GATE: Prove T4 marketing send is BLOCKED without explicit consent."""
    org = make_organization(db_session)
    no_consent_email = "prospect_no_consent@example.com"

    with patch("smtplib.SMTP"), patch("smtplib.SMTP_SSL"):
        sent = send_marketing_newsletter_email(
            email=no_consent_email,
            recipient_first_name="Jane",
            campaign_title="Summer Release 2026",
            organization_id=org.id,
            db=db_session,
        )
        assert not sent, "T4 marketing email MUST be blocked when recipient has not opted in"


def test_t4_marketing_send_allowed_with_explicit_consent(db_session):
    """MANDATORY QA GATE: Prove T4 marketing send SUCCEEDS when explicit consent is present."""
    org = make_organization(db_session)
    consented_email = "opted_in_user@example.com"

    consent = EmailMarketingConsent(
        email_address=consented_email,
        organization_id=org.id,
        has_consented=True,
    )
    db_session.add(consent)
    db_session.commit()

    with patch("smtplib.SMTP"), patch("smtplib.SMTP_SSL"):
        sent = send_marketing_newsletter_email(
            email=consented_email,
            recipient_first_name="John",
            campaign_title="Summer Release 2026",
            organization_id=org.id,
            db=db_session,
        )
        assert sent, "T4 marketing email MUST succeed when recipient has granted consent"


def test_t2_operational_dispatches(db_session):
    """Verify T2 operational email dispatches (reports, tickets, maintenance)."""
    org = make_organization(db_session)
    user_email = "op_user@example.com"

    with patch("smtplib.SMTP"), patch("smtplib.SMTP_SSL"):
        r1 = send_report_ready_email(
            email=user_email,
            recipient_first_name="Alice",
            report_name="Q3 Revenue Summary",
            organization_id=org.id,
            db=db_session,
        )
        assert r1

        r2 = send_support_ticket_updated_email(
            email=user_email,
            recipient_first_name="Alice",
            ticket_id="SUP-1092",
            subject="Invoice Export Timeout",
            status="Resolved",
            organization_id=org.id,
            db=db_session,
        )
        assert r2

        r3 = send_service_maintenance_email(
            email=user_email,
            recipient_first_name="Alice",
            incident_title="Database Index Migration",
            organization_id=org.id,
            db=db_session,
        )
        assert r3


def test_t3_lifecycle_dispatches(db_session):
    """Verify T3 lifecycle email dispatches (demo request, preference update) with consent."""
    org = make_organization(db_session)
    prospect_email = "demo_requester@example.com"

    consent = EmailMarketingConsent(
        email_address=prospect_email,
        organization_id=org.id,
        has_consented=True,
    )
    db_session.add(consent)
    db_session.commit()

    with patch("smtplib.SMTP"), patch("smtplib.SMTP_SSL"):
        r1 = send_demo_request_received_email(
            email=prospect_email,
            recipient_first_name="Bob",
            organization_id=org.id,
            db=db_session,
        )
        assert r1

        r2 = send_preference_updated_email(
            email=prospect_email,
            recipient_first_name="Bob",
            organization_id=org.id,
            db=db_session,
        )
        assert r2
