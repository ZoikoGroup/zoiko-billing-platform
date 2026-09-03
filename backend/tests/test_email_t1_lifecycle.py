"""
tests/test_email_t1_lifecycle.py
---------------------------------
Unit & integration tests for Tier 1 Core Lifecycle Templates + Prior Lifecycle Gaps (Prompt 4 of 5).

Verifies:
1. All T1 catalog templates are properly registered and compliant.
2. ZB-INV-011 pre-due invoice reminder job fires at N lead days.
3. ZB-INV-011 pre-due invoice reminder job ignores invoices not at N lead days.
4. ZB-COM-001 / ZB-ORG-001 account created email is dispatched during register_enterprise.
5. ZB-COM-003 trial-ending warning job fires at N lead days.
6. ZB-COM-004 trial expired notification fires on trial_expiry job sweep.
7. ZB-COM-011 past-due subscription warning fires during commercial dunning sweep.
"""

from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest

from app.config import settings
from app.core.security import hash_password
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.billing.models import BillingCustomer, Invoice, InvoiceStatus
from app.modules.billing.tasks import invoice_reminder
from app.modules.commercial import tasks as commercial_tasks
from app.modules.commercial.dunning_service import CommercialDunningService
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.services.email_foundation.enums import TemplateTier
from app.services.email_foundation.registries import get_template_definition, TEMPLATE_REGISTRY
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


def test_t1_templates_registered():
    """Verify all key T1 templates exist in registry with correct tier."""
    t1_ids = [
        "ZB-ORG-001", "ZB-ONB-001", "ZB-CUS-001", "ZB-CHG-001", "ZB-INV-001",
        "ZB-PAY-001", "ZB-SUB-001", "ZB-COL-011", "ZB-COM-001", "ZB-COM-004", "ZB-COM-011"
    ]
    for tid in t1_ids:
        tdef = get_template_definition(tid)
        assert tdef is not None, f"Template {tid} must be registered"
        assert tdef.tier == TemplateTier.T1, f"Template {tid} must be Tier T1"


def test_invoice_pre_due_reminder_job_fires_at_lead_days(db_session, monkeypatch):
    """ZB-INV-011: Pre-due reminder job fires for invoice due in N days."""
    monkeypatch.setattr(invoice_reminder, "SessionLocal", lambda: db_session)

    org = make_organization(db_session)
    cust = BillingCustomer(
        organization_id=org.id,
        customer_code="CUST001",
        company_name="Acme Corp",
        display_name="Acme Corp",
        email="billing@acme.com",
    )
    db_session.add(cust)
    db_session.flush()

    lead_days = settings.INVOICE_REMINDER_LEAD_DAYS
    target_due = datetime.utcnow().date() + timedelta(days=lead_days)

    inv = Invoice(
        organization_id=org.id,
        customer_id=cust.id,
        invoice_number="INV-PRE-001",
        status=InvoiceStatus.SENT,
        issue_date=datetime.utcnow().date(),
        due_date=target_due,
        total_amount=100.00,
        balance_due=100.00,
        currency="USD",
    )
    db_session.add(inv)
    db_session.commit()

    with patch("app.modules.billing.tasks.invoice_reminder.send_invoice_reminder_email") as mock_send:
        mock_send.return_value = True
        summary = invoice_reminder.run_invoice_reminder_job()
        assert summary["reminders_sent"] == 1
        assert mock_send.called
        assert mock_send.call_args[1]["email"] == "billing@acme.com"
        assert mock_send.call_args[1]["invoice_number"] == "INV-PRE-001"


def test_invoice_pre_due_reminder_job_ignores_non_lead_days(db_session, monkeypatch):
    """ZB-INV-011: Pre-due reminder job ignores invoice due in N+1 days."""
    monkeypatch.setattr(invoice_reminder, "SessionLocal", lambda: db_session)

    org = make_organization(db_session)
    cust = BillingCustomer(
        organization_id=org.id,
        customer_code="CUST002",
        company_name="Acme Corp",
        display_name="Acme Corp",
        email="billing@acme.com",
    )
    db_session.add(cust)
    db_session.flush()

    lead_days = settings.INVOICE_REMINDER_LEAD_DAYS
    non_target_due = datetime.utcnow().date() + timedelta(days=lead_days + 1)

    inv = Invoice(
        organization_id=org.id,
        customer_id=cust.id,
        invoice_number="INV-PRE-002",
        status=InvoiceStatus.SENT,
        issue_date=datetime.utcnow().date(),
        due_date=non_target_due,
        total_amount=100.00,
        balance_due=100.00,
        currency="USD",
    )
    db_session.add(inv)
    db_session.commit()

    with patch("app.modules.billing.tasks.invoice_reminder.send_invoice_reminder_email") as mock_send:
        mock_send.return_value = True
        summary = invoice_reminder.run_invoice_reminder_job()
        assert summary["reminders_sent"] == 0
        assert not mock_send.called


def test_register_enterprise_dispatches_account_created_email(db_session):
    """ZB-COM-001 / ZB-ORG-001: register_enterprise sends organization created email."""
    req = RegisterRequest(
        organization="Global Corp",
        name="Global Admin",
        email="admin@globalcorp.com",
        password="Password123!",
        intended_plan="essentials",
        country="US",
    )

    with patch("app.services.email_service.send_org_created_email") as mock_send_org, \
         patch("app.services.email_service.send_product_welcome_email") as mock_send_wel:
        mock_send_org.return_value = True
        mock_send_wel.return_value = True

        res = register_enterprise(db_session, req)
        assert res is not None
        assert mock_send_org.called
        assert mock_send_org.call_args[1]["email"] == "admin@globalcorp.com"


def test_commercial_trial_warning_job_fires_at_lead_days(db_session, monkeypatch):
    """ZB-COM-003: Commercial trial ending warning job fires N days before trial_ends_at."""
    from app.modules.commercial.tasks import trial_warning
    monkeypatch.setattr(trial_warning, "SessionLocal", lambda: db_session)

    org = make_organization(db_session)
    user = _make_user(db_session, email="owner@testco.com", org_id=org.id, first_name="Owner")

    acct = CommercialAccount(organization_id=org.id)
    db_session.add(acct)
    db_session.flush()

    lead_days = settings.TRIAL_WARNING_LEAD_DAYS
    target_trial_end = datetime.utcnow() + timedelta(days=lead_days)

    sub = CommercialSubscription(
        commercial_account_id=acct.id,
        commercial_plan_id=1,
        status=CommercialSubscriptionStatus.TRIALING,
        trial_ends_at=target_trial_end,
    )
    db_session.add(sub)
    db_session.commit()

    with patch("app.modules.commercial.tasks.trial_warning.send_trial_ending_warning_email") as mock_send:
        mock_send.return_value = True
        summary = trial_warning.run_commercial_trial_warning_job()
        assert summary["warnings_sent"] == 1
        assert mock_send.called
        assert mock_send.call_args[1]["email"] == "owner@testco.com"


def test_commercial_trial_expiry_job_sends_zb_com_004(db_session, monkeypatch):
    """ZB-COM-004: Trial expiry job suspends sub and dispatches ZB-COM-004 email."""
    from app.modules.commercial.tasks import trial_expiry
    monkeypatch.setattr(trial_expiry, "SessionLocal", lambda: db_session)

    org = make_organization(db_session)
    user = _make_user(db_session, email="admin@expiredco.com", org_id=org.id)

    acct = CommercialAccount(organization_id=org.id)
    db_session.add(acct)
    db_session.flush()

    sub = CommercialSubscription(
        commercial_account_id=acct.id,
        commercial_plan_id=1,
        status=CommercialSubscriptionStatus.TRIALING,
        trial_ends_at=datetime.utcnow() - timedelta(hours=1),
    )
    db_session.add(sub)
    db_session.commit()

    with patch("app.services.email_service.send_trial_expired_email") as mock_send, \
         patch("app.config.settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT", True):
        mock_send.return_value = True
        summary = trial_expiry.run_commercial_trial_expiry_job()
        assert summary["suspended"] == 1
        assert mock_send.called
        assert mock_send.call_args[1]["email"] == "admin@expiredco.com"


def test_commercial_dunning_sweep_sends_zb_com_011(db_session):
    """ZB-COM-011: Commercial dunning sweep dispatches past-due warning when entering PAST_DUE / RESTRICTED."""
    org = make_organization(db_session)
    user = _make_user(db_session, email="admin@dunningco.com", org_id=org.id)

    acct = CommercialAccount(organization_id=org.id)
    db_session.add(acct)
    db_session.flush()

    sub = CommercialSubscription(
        commercial_account_id=acct.id,
        commercial_plan_id=1,
        status=CommercialSubscriptionStatus.ACTIVE,
        payment_failed_at=datetime.utcnow() - timedelta(days=1),
    )
    db_session.add(sub)
    db_session.commit()

    dunning_svc = CommercialDunningService(db_session)

    with patch("app.services.email_service.send_past_due_suspension_warning_email") as mock_send:
        mock_send.return_value = True
        summary = dunning_svc.sweep(db_session)
        assert summary["past_due"] == 1
        assert mock_send.called
        assert mock_send.call_args[1]["email"] == "admin@dunningco.com"
