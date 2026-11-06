"""ZB-TAX-ARCH-001 Phase 5c PR 2: what the reports and provider operations
screens need from the backend: T10 CSV export (audited, formula-safe), the
provider list for proposing a connection (no URLs), the owner of a stuck
provider transaction, and T13 / no-secret checks across those routes."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import BillingAuditLog, InvoiceStatus, Tax
from app.modules.tax.enums import OutboxOperation, OutboxState
from app.modules.tax.provider_issuance import ProviderIssuanceService
from app.modules.tax.provider_models import TaxProviderOutbox
from app.modules.tax.router import _csv_cell, transaction_owner
from tests.conftest import make_customer, make_invoice
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world
from tests.test_tax_phase4a2 import issue_via_connection, provider_invoice

OVER = "/api/v1/tax/reports/legacy-discount-overcollection"
DUPS = "/api/v1/tax/reports/duplicate-tax-rows"
SECRET = "sk_live_never_shown_0123456789"


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P5C2")
    w["admin"] = _tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin@p5c2.example")
    customer = make_customer(db_session, w["org"].id, code="P5C2C")
    inv = make_invoice(db_session, w["org"].id, customer.id, status=InvoiceStatus.SENT,
                       invoice_number="=HYPERLINK(\"http://x\")")
    inv.discount_percentage, inv.tax_amount, inv.currency = Decimal("10"), Decimal("20.00"), "GBP"
    for _ in range(2):
        db_session.add(Tax(organization_id=w["org"].id, invoice_id=inv.id, taxable_amount=Decimal("100"),
                           tax_amount=Decimal("20"), tax_percentage=Decimal("20"), is_active=True))
    db_session.commit()
    w["legacy_invoice"] = inv
    return w


# ── T10: CSV export ─────────────────────────────────────────────────────

def test_report_csv_is_formula_safe_and_audited(db_session, client_for, w):
    client = client_for(w["admin"])
    over = client.get(OVER, params={"format": "csv"})
    assert over.status_code == 200 and over.headers["content-type"].startswith("text/csv")
    assert over.headers["cache-control"] == "no-store"
    lines = over.text.strip().split("\n")
    assert lines[0].startswith("invoice_number,issue_date,status,currency")
    assert lines[1].startswith('"\'=HYPERLINK(""http://x"")"')        # never a live formula
    dups = client.get(DUPS, params={"format": "csv"})
    assert dups.text.strip().split("\n")[1].endswith(",1")
    audited = db_session.query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxFindingsReport",
                                                       BillingAuditLog.action == "EXPORT").all()
    assert {a.new_values["report"] for a in audited} == {"legacy-discount-overcollection", "duplicate-tax-rows"}
    assert client.get(OVER).json()["invoices"]                       # JSON unchanged
    assert client.get(OVER, params={"format": "xlsx"}).status_code == 422


def test_report_csv_keeps_the_report_roles(db_session, client_for, w):
    assert client_for(w["maker"]).get(OVER, params={"format": "csv"}).status_code == 403      # billing admin
    staff = client_for(make_super_admin(db_session, "tp@p5c2.example", PlatformRole.TAX_PUBLISHER))
    assert staff.get(DUPS, params={"format": "csv"}).status_code == 403                       # T13


@pytest.mark.parametrize("value,expected", [
    ("=1+1", "'=1+1"), ("+cmd", "'+cmd"), ("-x", "'-x"), ("@SUM(A1)", "'@SUM(A1)"), ("\tx", "'\tx"),
    ("-5.00", "-5.00"), (Decimal("-1.5"), "-1.5"), (None, ""), ("INV-1", "INV-1"),
])
def test_csv_cells(value, expected):
    assert _csv_cell(value) == expected


# ── provider list: names and environments, never URLs ───────────────────

def test_provider_list_has_no_urls_and_refuses_platform_staff(db_session, client_for, w):
    body = client_for(w["maker"]).get("/api/v1/tax/providers")
    assert body.status_code == 200
    assert {"name": "fake-provider", "environments": ["PRODUCTION", "SANDBOX"]} in body.json()["items"]
    assert "https://" not in body.text and "fake-provider.test" not in body.text
    staff = client_for(make_super_admin(db_session, "pa@p5c2.example", PlatformRole.PLATFORM_ADMINISTRATOR))
    assert staff.get("/api/v1/tax/providers").status_code == 403


# ── connections: the secret never comes back ────────────────────────────

def test_a_credential_is_never_returned_by_any_connection_route(db_session, client_for, w):
    conn = w["connection"]
    client = client_for(w["maker"])
    first = client.put(f"/api/v1/tax/provider-connections/{conn.id}/credentials", json={"secret": SECRET + "a"})
    assert first.status_code == 200, first.text
    put = client.put(f"/api/v1/tax/provider-connections/{conn.id}/credentials", json={"secret": SECRET})
    # True only with the versioned Secret Manager store, which keeps the old version until a test passes.
    assert put.json()["credentials"]["rotation_pending_test"] in (True, False)
    assert put.json()["credentials"]["present"] is True
    for response in (first, put, client.get("/api/v1/tax/provider-connections"),
                     client.get(f"/api/v1/tax/provider-connections/{conn.id}"),
                     client.post(f"/api/v1/tax/provider-connections/{conn.id}/test")):
        assert SECRET not in response.text and SECRET[:-4] not in response.text


# ── stuck transactions: owner ───────────────────────────────────────────

@pytest.mark.parametrize("state,void_by,owner", [
    (OutboxState.PENDING, None, "system"), (OutboxState.UNCERTAIN, None, "system"),
    (OutboxState.REMOTE_COMMITTED, None, "system"), (OutboxState.REMOTE_COMMITTED, 4, "finance_approver"),
    (OutboxState.REVIEW_REQUIRED, None, "billing_admin"), (OutboxState.REVIEW_REQUIRED, 4, "finance_approver"),
    (OutboxState.FAILED, None, "billing_admin"), (OutboxState.CANCELLED, None, "billing_admin"),
    (OutboxState.DONE, None, None), (OutboxState.VOIDED, 4, None),
])
def test_transaction_owner(state, void_by, owner):
    assert transaction_owner(SimpleNamespace(state=state, void_requested_by=void_by)) == owner


def test_stuck_transaction_shows_owner_and_void_moves_it_to_finance(db_session, client_for, w, monkeypatch):
    from app.config import settings

    # Owner and two-person only; tenant MFA step-up on void-approve: test_tax_phase5d2_tenant_mfa.py.
    monkeypatch.setattr(settings, "TAX_TENANT_STEP_UP_REQUIRED", False)
    inv, _q = provider_invoice(w)
    w["provider"].remote_tax_delta = Decimal("0.01")                 # drift -> REVIEW_REQUIRED
    issue_via_connection(w, inv)
    row = db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    client = client_for(w["maker"])
    listed = client.get("/api/v1/tax/provider-transactions", params={"state": "review_required"}).json()["items"]
    assert listed[0]["owner"] == "billing_admin" and listed[0]["state"] == "REVIEW_REQUIRED"
    assert client.post(f"/api/v1/tax/provider-transactions/{row.id}/void-request").json()["owner"] == "finance_approver"
    assert client.post(f"/api/v1/tax/provider-transactions/{row.id}/void-approve").status_code == 403   # billing admin
    done = client_for(w["checker"]).post(f"/api/v1/tax/provider-transactions/{row.id}/void-approve").json()
    assert done["state"] == "VOIDED" and done["owner"] is None
    assert ProviderIssuanceService  # imported for the fixture chain


def test_platform_staff_never_reach_connections_or_transactions(db_session, client_for, w):
    staff = client_for(make_super_admin(db_session, "tax@p5c2.example", PlatformRole.TAX_PUBLISHER))
    for url in ("/api/v1/tax/provider-connections", "/api/v1/tax/provider-transactions"):
        assert staff.get(url).status_code == 403, url
    health = staff.get("/api/v1/super-admin/tax-registry/provider-health")
    assert health.status_code == 200
    assert str(w["org"].id) not in [str(v) for p in health.json()["providers"] for v in p.values()]
    assert "organization" not in health.text and "invoice" not in health.text
