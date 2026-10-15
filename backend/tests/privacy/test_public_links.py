"""
tests/privacy/test_public_links.py
----------------------------------
ZB-SEC-PRIV-001 §FIN-07 / AT-15: Public invoice & estimate links that expire and can be revoked.
"""

import base64
import hashlib
import hmac
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.config import settings
from app.core.exceptions import NotFoundException
from app.modules.billing.models import (
    BillingCustomer,
    Invoice,
    InvoiceStatus,
    Quotation,
    QuoteStatus,
)
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.quote_service import QuoteService
from app.modules.organizations.models import Organization
from tests.privacy.conftest import control


def _seed_test_invoice(db, org_id=1, inv_id=101):
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if not org:
        org = Organization(id=org_id, organization_name=f"Org {org_id}", organization_code=f"org-{org_id}")
        db.add(org)

    cust = db.query(BillingCustomer).filter(BillingCustomer.organization_id == org_id).first()
    if not cust:
        cust = BillingCustomer(
            id=org_id * 10,
            organization_id=org_id,
            customer_code=f"CUST-{org_id}",
            company_name="Client Corp",
            display_name="Client Customer",
            currency="USD",
        )
        db.add(cust)
        db.flush()

    inv = Invoice(
        id=inv_id,
        organization_id=org_id,
        customer_id=cust.id,
        invoice_number=f"INV-{inv_id}",
        status=InvoiceStatus.SENT,
        total_amount=Decimal("200.00"),
        balance_due=Decimal("200.00"),
        paid_amount=Decimal("0.00"),
        currency="USD",
        issue_date=date.today(),
        due_date=date.today() + timedelta(days=30),
        public_link_version=1,
    )
    db.add(inv)
    db.commit()
    return inv


def _seed_test_quote(db, org_id=1, quote_id=201):
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if not org:
        org = Organization(id=org_id, organization_name=f"Org {org_id}", organization_code=f"org-{org_id}")
        db.add(org)

    cust = db.query(BillingCustomer).filter(BillingCustomer.organization_id == org_id).first()
    if not cust:
        cust = BillingCustomer(
            id=org_id * 10 + 5,
            organization_id=org_id,
            customer_code=f"CUST-Q-{org_id}",
            company_name="Quote Client Corp",
            display_name="Quote Customer",
            currency="USD",
        )
        db.add(cust)
        db.flush()

    quote = Quotation(
        id=quote_id,
        organization_id=org_id,
        customer_id=cust.id,
        quote_number=f"Q-{quote_id}",
        status=QuoteStatus.SENT,
        total_amount=Decimal("350.00"),
        subtotal=Decimal("350.00"),
        currency="USD",
        valid_until=date.today() + timedelta(days=30),
        public_link_version=1,
    )
    db.add(quote)
    db.commit()
    return quote


@control("FIN-07", "AT-15")
def test_v2_token_valid(db_session):
    inv = _seed_test_invoice(db_session, org_id=10, inv_id=1001)
    svc = InvoiceService(db_session)
    token = svc._public_invoice_token(inv)

    resolved = svc._resolve_public_invoice(token)
    assert resolved.id == inv.id
    assert resolved.invoice_number == inv.invoice_number


@control("FIN-07", "AT-15")
def test_v2_token_tampered(db_session):
    inv = _seed_test_invoice(db_session, org_id=11, inv_id=1002)
    svc = InvoiceService(db_session)
    token = svc._public_invoice_token(inv)

    raw = base64.urlsafe_b64decode(token + "==").decode()
    parts = raw.split(".")
    parts[-1] = "badmac" + parts[-1][6:]
    tampered_token = base64.urlsafe_b64encode(".".join(parts).encode()).decode().rstrip("=")

    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(tampered_token)


@control("FIN-07", "AT-15")
def test_v2_token_expired(db_session):
    inv = _seed_test_invoice(db_session, org_id=12, inv_id=1003)
    svc = InvoiceService(db_session)

    # Manually craft an expired token
    secret = settings.BILLING_SECRET_KEY or "change-me-billing-platform-secret"
    past_ts = int((datetime.now(timezone.utc) - timedelta(days=1)).timestamp())
    payload = f"v2|{inv.id}|{inv.public_link_version}|{past_ts}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    raw = f"v2.{inv.id}.{inv.public_link_version}.{past_ts}.{sig}"
    expired_token = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")

    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(expired_token)


@control("FIN-07", "AT-15")
def test_v2_token_wrong_version(db_session):
    inv = _seed_test_invoice(db_session, org_id=13, inv_id=1004)
    svc = InvoiceService(db_session)
    token_v1 = svc._public_invoice_token(inv)

    # Bump version in DB
    inv.public_link_version = 2
    db_session.commit()

    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(token_v1)


@control("FIN-07", "AT-15")
def test_v2_token_revocation_and_resend(db_session):
    inv = _seed_test_invoice(db_session, org_id=14, inv_id=1005)
    svc = InvoiceService(db_session)
    old_token = svc._public_invoice_token(inv)

    # Revoke
    res = svc.revoke_public_link(inv.id, inv.organization_id)
    assert res["status"] == "revoked"
    assert res["public_link_version"] == 2

    # Old token must 404
    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(old_token)

    # Resending / issuing new token works
    new_token = svc._public_invoice_token(inv.id)
    resolved = svc._resolve_public_invoice(new_token)
    assert resolved.id == inv.id


@control("FIN-07", "AT-15")
def test_v2_token_voided_and_cancelled_invoice(db_session):
    inv1 = _seed_test_invoice(db_session, org_id=15, inv_id=1006)
    svc = InvoiceService(db_session)
    token1 = svc._public_invoice_token(inv1)

    svc.cancel_invoice(inv1.id, inv1.organization_id, reason="Customer cancelled")
    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(token1)

    inv2 = _seed_test_invoice(db_session, org_id=16, inv_id=1007)
    token2 = svc._public_invoice_token(inv2)
    svc.void_invoice(inv2.id, inv2.organization_id, reason="Billed in error")
    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(token2)


@control("FIN-07", "AT-15")
def test_token_invoice_a_never_returns_b(db_session):
    inv_a = _seed_test_invoice(db_session, org_id=17, inv_id=1008)
    inv_b = _seed_test_invoice(db_session, org_id=17, inv_id=1009)
    svc = InvoiceService(db_session)

    token_a = svc._public_invoice_token(inv_a)
    resolved = svc._resolve_public_invoice(token_a)
    assert resolved.id == inv_a.id
    assert resolved.id != inv_b.id


@control("FIN-07", "AT-15")
def test_cross_type_token_confusion_blocked(db_session):
    inv = _seed_test_invoice(db_session, org_id=18, inv_id=1010)
    quote = _seed_test_quote(db_session, org_id=18, quote_id=1010)
    inv_svc = InvoiceService(db_session)
    quote_svc = QuoteService(db_session)

    inv_token = inv_svc._public_invoice_token(inv)
    quote_token = quote_svc._public_quote_token(quote)

    # Invoice token cannot resolve as a quote
    with pytest.raises(NotFoundException):
        quote_svc._resolve_public_quote(inv_token)

    # Quote token cannot resolve as an invoice
    with pytest.raises(NotFoundException):
        inv_svc._resolve_public_invoice(quote_token)


@control("FIN-07", "AT-15")
def test_legacy_token_behavior_and_cutoff(db_session, monkeypatch):
    inv = _seed_test_invoice(db_session, org_id=19, inv_id=1011)
    svc = InvoiceService(db_session)

    # Legacy token: {id}.{hmac}
    secret = settings.BILLING_SECRET_KEY or "change-me-billing-platform-secret"
    legacy_mac = hmac.new(secret.encode(), str(inv.id).encode(), hashlib.sha256).hexdigest()
    raw = f"{inv.id}.{legacy_mac}"
    legacy_token = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")

    # Before cutoff: legacy token works
    future_date = (date.today() + timedelta(days=30)).isoformat()
    monkeypatch.setattr(settings, "PUBLIC_INVOICE_LEGACY_TOKEN_UNTIL", future_date)
    resolved = svc._resolve_public_invoice(legacy_token)
    assert resolved.id == inv.id

    # After cutoff: legacy token rejected (404)
    past_date = (date.today() - timedelta(days=1)).isoformat()
    monkeypatch.setattr(settings, "PUBLIC_INVOICE_LEGACY_TOKEN_UNTIL", past_date)
    with pytest.raises(NotFoundException):
        svc._resolve_public_invoice(legacy_token)


@control("FIN-07", "AT-15")
def test_quote_v2_token_lifecycle(db_session):
    quote = _seed_test_quote(db_session, org_id=20, quote_id=2001)
    svc = QuoteService(db_session)
    token = svc._public_quote_token(quote)

    # Valid token resolves
    resolved = svc._resolve_public_quote(token)
    assert resolved.id == quote.id

    # Revoke
    res = svc.revoke_public_link(quote.id, quote.organization_id)
    assert res["status"] == "revoked"

    # Old token fails
    with pytest.raises(NotFoundException):
        svc._resolve_public_quote(token)

    # Cancel quote fails
    svc.cancel_quote(quote.id, quote.organization_id, updated_by=1)
    new_token = svc._public_quote_token(quote.id)
    with pytest.raises(NotFoundException):
        svc._resolve_public_quote(new_token)
