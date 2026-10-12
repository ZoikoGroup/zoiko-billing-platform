"""tests/test_pdf_trial_banner.py
------------------------------------------
Invoices and quotes generated while the org is on its free trial carry a trial
banner (and watermark) on every page; a paying org's documents don't.
"""
import pytest

from app.modules.billing.services import pdf_service
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from tests.test_commercial_subscription_management import _org_with_plan

ROW = {"code": "", "hsn": "", "description": "Service", "qty": "1", "unit_price": "10.00", "tax": "0.00", "total": "10.00"}


def _invoice_kwargs(trial):
    return dict(
        org_name="Acme", org_lines=["1 Main St"], customer_name="Cust", customer_lines=["2 High St"],
        invoice_label="Invoice", invoice_number="INV-1", po_number="", currency="USD",
        issue_date="2026-10-01", due_date="2026-10-15", payment_terms="Net 14", balance_due="10.00",
        item_rows=[ROW], subtotal="10.00", discount="0.00", tax="0.00", total="10.00", amount_paid="0.00",
        bank_rows=[], terms_list=[], notes="", trial=trial,
    )


def _quote_kwargs(trial):
    return dict(
        org_name="Acme", org_lines=["1 Main St"], customer_name="Cust", customer_lines=["2 High St"],
        quote_number="Q-1", reference="", currency="USD", issue_date="2026-10-01", valid_until="2026-10-31",
        status_label="Draft", item_rows=[ROW], subtotal="10.00", discount="0.00", tax="0.00", total="10.00",
        terms_list=[], notes="", trial=trial,
    )


@pytest.fixture
def banner_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(pdf_service, "_draw_trial_banner", lambda canvas, doc: calls.append(1))
    return calls


@pytest.mark.parametrize("builder,kwargs", [
    (pdf_service._build_invoice_document, _invoice_kwargs),
    (pdf_service._build_quote_document, _quote_kwargs),
])
def test_trial_banner_drawn_only_when_trial(banner_calls, builder, kwargs):
    assert builder(**kwargs(False)).startswith(b"%PDF")
    assert banner_calls == []

    assert builder(**kwargs(True)).startswith(b"%PDF")
    assert len(banner_calls) >= 1


def test_trial_banner_really_renders_in_the_pdf():
    plain = pdf_service._build_invoice_document(**_invoice_kwargs(False))
    trial = pdf_service._build_invoice_document(**_invoice_kwargs(True))
    assert trial.startswith(b"%PDF") and len(trial) != len(plain)


def _set_status(db, account_id, status):
    sub = db.query(CommercialSubscription).filter_by(commercial_account_id=account_id).first()
    if sub is None:
        from tests.test_plan_change_orchestration import _plan_with_published_version
        from app.modules.commercial.service import CommercialSubscriptionService

        plan, _ = _plan_with_published_version(db, f"PDFPLAN{account_id}", price_amount=10)
        sub = CommercialSubscriptionService(db).create_subscription(account_id, plan)
    sub.status = status
    db.commit()


@pytest.mark.parametrize("status,expected", [
    (CommercialSubscriptionStatus.TRIALING, True),
    (CommercialSubscriptionStatus.TRIAL_RECOVERY, True),
    (CommercialSubscriptionStatus.ACTIVE, False),
    (CommercialSubscriptionStatus.PENDING, False),
])
def test_org_on_trial_follows_subscription_status(db_session, status, expected):
    org, plan, account = _org_with_plan(db_session, "PDFTRIAL", "PDFTRIALPLAN")
    _set_status(db_session, account.id, status)
    assert pdf_service._org_on_trial(db_session, org.id) is expected


def test_org_on_trial_is_safe_without_db_or_org():
    assert pdf_service._org_on_trial(None, 1) is False
    assert pdf_service._org_on_trial(object(), None) is False
