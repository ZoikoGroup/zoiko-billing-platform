"""Quotation Settings: number format, customer-acceptance gate, discount
approval threshold, validation, and the expiry-reminder job."""
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.models import NumberFormat, QuoteStatus
from app.modules.billing.services.quote_service import QuoteService
from app.modules.billing.services.settings_service import BillingConfigurationService
from tests.conftest import make_customer, make_organization


def _config(db, org, **fields):
    BillingConfigurationService(db).update_configuration(org.id, updated_by=1, **fields)


def _prefs(db, org, **prefs):
    _config(db, org, quotation_extra_settings=prefs)


def _quote(db, org, cust, **kw):
    return QuoteService(db).create_quote(org.id, 1, cust.id, **kw)


# ── Quote Number Format ────────────────────────────────────────────────────

def test_number_generated_from_prefix_format_and_sequence(db_session):
    org = make_organization(db_session, "QN1")
    cust = make_customer(db_session, org.id)
    _config(db_session, org, quote_prefix="QOT-", quote_number_format=NumberFormat.PREFIX_YYYY_SEQ)
    q1 = _quote(db_session, org, cust)
    q2 = _quote(db_session, org, cust, quote_number="   ")
    year = str(date.today().year)
    assert q1.quote_number == f"QOT-{year}-00001"
    assert q2.quote_number == f"QOT-{year}-00002"


def test_number_format_changes_output_and_manual_number_wins(db_session):
    org = make_organization(db_session, "QN2")
    cust = make_customer(db_session, org.id)
    _config(db_session, org, quote_prefix="Q-", quote_number_format=NumberFormat.PREFIX_SEQ)
    assert _quote(db_session, org, cust).quote_number == "Q-00001"
    assert _quote(db_session, org, cust, quote_number="CUSTOM-9").quote_number == "CUSTOM-9"


def test_generator_skips_numbers_already_taken(db_session):
    org = make_organization(db_session, "QN3")
    cust = make_customer(db_session, org.id)
    _config(db_session, org, quote_prefix="Q-", quote_number_format=NumberFormat.PREFIX_SEQ)
    _quote(db_session, org, cust, quote_number="Q-00001")  # typed by hand
    assert _quote(db_session, org, cust).quote_number == "Q-00002"


# ── Settings validation / persistence ─────────────────────────────────────

def test_prefs_persist_and_merge(db_session):
    org = make_organization(db_session, "QP1")
    _prefs(db_session, org, require_customer_acceptance=False)
    _prefs(db_session, org, discount_approval_threshold=15, expiry_reminder_days=3)
    cfg = BillingConfigurationService(db_session).get_configuration(org.id)
    assert cfg.quotation_extra_settings == {
        "require_customer_acceptance": False, "discount_approval_threshold": 15.0, "expiry_reminder_days": 3,
    }
    _prefs(db_session, org, discount_approval_threshold=None, expiry_reminder_days=None)  # clear
    cfg = BillingConfigurationService(db_session).get_configuration(org.id)
    assert cfg.quotation_extra_settings["discount_approval_threshold"] is None
    assert cfg.quotation_extra_settings["expiry_reminder_days"] is None


@pytest.mark.parametrize("prefs", [
    {"discount_approval_threshold": 101}, {"discount_approval_threshold": -1}, {"discount_approval_threshold": "abc"},
    {"expiry_reminder_days": 0}, {"expiry_reminder_days": 91}, {"expiry_reminder_days": "x"},
])
def test_invalid_prefs_rejected(db_session, prefs):
    org = make_organization(db_session, "QP2")
    with pytest.raises(BadRequestException):
        _prefs(db_session, org, **prefs)


# ── Customer Acceptance Required ──────────────────────────────────────────

def _convert(db, org, quote):
    from datetime import date as d
    return QuoteService(db).convert_to_invoice(
        quote.id, org.id, 1, invoice_number=f"INV-{quote.id}", issue_date=d.today(), due_date=d.today(),
    )


def test_acceptance_required_by_default_blocks_sent_quote(db_session):
    org = make_organization(db_session, "QA1")
    cust = make_customer(db_session, org.id)
    q = _quote(db_session, org, cust)
    q.status = QuoteStatus.SENT
    db_session.flush()
    with pytest.raises(BadRequestException, match="Only accepted quotes"):
        _convert(db_session, org, q)


def test_acceptance_off_allows_sent_quote(db_session):
    org = make_organization(db_session, "QA2")
    cust = make_customer(db_session, org.id)
    _prefs(db_session, org, require_customer_acceptance=False)
    q = _quote(db_session, org, cust)
    q.status = QuoteStatus.SENT
    db_session.flush()
    inv = _convert(db_session, org, q)
    assert inv.id
    assert q.status == QuoteStatus.CONVERTED and q.accepted_at is not None


def test_acceptance_off_still_blocks_draft(db_session):
    org = make_organization(db_session, "QA3")
    cust = make_customer(db_session, org.id)
    _prefs(db_session, org, require_customer_acceptance=False)
    q = _quote(db_session, org, cust)
    with pytest.raises(BadRequestException, match="sent or accepted"):
        _convert(db_session, org, q)


# ── Discount Approval Threshold ───────────────────────────────────────────

def test_discount_above_threshold_needs_org_admin(db_session):
    org = make_organization(db_session, "QD1")
    cust = make_customer(db_session, org.id)
    _prefs(db_session, org, discount_approval_threshold=10)
    q = _quote(db_session, org, cust, discount_percentage=25)
    svc = QuoteService(db_session)
    with pytest.raises(BadRequestException, match="approval threshold"):
        svc.send_quote(q.id, org.id, 1, actor_role="billing_admin")
    # an org admin passes the gate (it then proceeds to the normal send path,
    # which fails later for unrelated reasons in this bare fixture)
    with patch.object(QuoteService, "max_discount_percentage", return_value=25):
        try:
            svc.send_quote(q.id, org.id, 1, actor_role="org_admin")
        except BadRequestException as exc:
            assert "approval threshold" not in str(exc.message)


def test_discount_within_threshold_or_no_threshold_not_gated(db_session):
    org = make_organization(db_session, "QD2")
    cust = make_customer(db_session, org.id)
    svc = QuoteService(db_session)
    q = _quote(db_session, org, cust, discount_percentage=50)
    try:  # no threshold configured
        svc.send_quote(q.id, org.id, 1, actor_role="billing_admin")
    except BadRequestException as exc:
        assert "approval threshold" not in str(exc.message)
    _prefs(db_session, org, discount_approval_threshold=60)
    try:  # 50% <= 60%
        svc.send_quote(q.id, org.id, 1, actor_role="billing_admin")
    except BadRequestException as exc:
        assert "approval threshold" not in str(exc.message)


def test_max_discount_counts_line_amount_discounts(db_session):
    class Item:
        quantity, unit_price, discount_percentage, discount_amount = 2, 100, 0, 60  # 30%

    q = SimpleNamespace(discount_percentage=5, items=[Item()])
    assert float(QuoteService.max_discount_percentage(q)) == pytest.approx(30.0)


# ── Expiry Reminder Days ──────────────────────────────────────────────────

def test_expiry_reminders_sent_once_inside_window(db_session):
    from app.modules.billing.tasks import quote_expiry_reminder as job

    org = make_organization(db_session, "QE1")
    cust = make_customer(db_session, org.id)
    today = date.today()
    soon = _quote(db_session, org, cust, valid_until=today + timedelta(days=2))
    later = _quote(db_session, org, cust, valid_until=today + timedelta(days=20))
    past = _quote(db_session, org, cust, valid_until=today - timedelta(days=1))
    draft = _quote(db_session, org, cust, valid_until=today + timedelta(days=1))
    for q in (soon, later, past):
        q.status = QuoteStatus.SENT
    db_session.flush()

    sent = []
    summary = {"found": 0, "sent": 0, "failed": 0, "errors": []}
    with patch.object(job, "_send_reminder", side_effect=lambda db, q, d: sent.append((q.id, d)) or True):
        job._remind_org(db_session, org.id, 3, summary)
        job._remind_org(db_session, org.id, 3, summary)  # second run: nothing new

    assert sent == [(soon.id, 2)]
    assert soon.expiry_reminder_sent_at is not None
    assert later.expiry_reminder_sent_at is None and past.expiry_reminder_sent_at is None
    assert draft.expiry_reminder_sent_at is None
    assert summary["sent"] == 1 and summary["failed"] == 0


def test_failed_send_leaves_quote_eligible_for_retry(db_session):
    from app.modules.billing.tasks import quote_expiry_reminder as job

    org = make_organization(db_session, "QE2")
    cust = make_customer(db_session, org.id)
    q = _quote(db_session, org, cust, valid_until=date.today() + timedelta(days=1))
    q.status = QuoteStatus.SENT
    db_session.flush()
    summary = {"found": 0, "sent": 0, "failed": 0, "errors": []}
    with patch.object(job, "_send_reminder", return_value=False):
        job._remind_org(db_session, org.id, 3, summary)
    assert q.expiry_reminder_sent_at is None and summary["failed"] == 1
