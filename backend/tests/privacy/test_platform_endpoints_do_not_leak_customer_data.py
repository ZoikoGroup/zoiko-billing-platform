"""Leak test: two tenants carry unmistakable customer / document strings; none
may appear anywhere in any platform aggregate endpoint's JSON, for a Platform
Administrator, an Auditor or a Finance read-only operator."""
import json

import pytest

from app.modules.super_admin.reconciliation_service import ReconciliationService
from tests.privacy.conftest import AGGREGATE_ENDPOINTS, SECRET_STRINGS_PREFIXES, control, seed_tenant

FORBIDDEN_KEYS = {
    "customer_name", "customer_id", "customer_email", "invoice_id", "invoice_number", "payment_id",
    "payment_number", "credit_note_number", "refund_number", "write_off_number", "entity_id",
}


def _walk_keys(node):
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_keys(v)


@pytest.fixture()
def seeded(db_session):
    a = seed_tenant(db_session, "A", "Tenant Alpha", 6)
    b = seed_tenant(db_session, "B", "Tenant Beta", 6, currency="EUR")
    run = ReconciliationService(db_session).run_reconciliation(trigger="manual")
    db_session.commit()
    return a, b, run


def _assert_clean(resp, label):
    assert resp.status_code == 200, f"{label}: {resp.status_code} {resp.text[:300]}"
    text = json.dumps(resp.json())
    for prefix in SECRET_STRINGS_PREFIXES + ("secret-a@", "secret-b@", "card declined"):
        assert prefix not in text, f"{label} leaked {prefix!r}: {text[:400]}"
    leaked = set(_walk_keys(resp.json())) & FORBIDDEN_KEYS
    assert not leaked, f"{label} returned forbidden keys {leaked}"


@control("PRV-03")
@pytest.mark.parametrize("who", ["platform_admin", "auditor", "finance_readonly"])
def test_aggregate_endpoints_do_not_leak(request, seeded, client_for, who):
    client = client_for(request.getfixturevalue(who))
    for path in AGGREGATE_ENDPOINTS:
        _assert_clean(client.get(path), f"{who} {path}")


@control("PRV-03")
@pytest.mark.parametrize("who", ["platform_admin", "auditor"])
def test_reconciliation_run_detail_does_not_leak(request, seeded, client_for, who):
    _, _, run = seeded
    client = client_for(request.getfixturevalue(who))
    resp = client.get(f"/api/super-admin/reconciliation-runs/{run.id}")
    _assert_clean(resp, f"{who} reconciliation run")
    body = resp.json()
    assert body["exceptions"], "seed should have produced reconciliation exceptions"
    assert body["exception_summary"]
    for row in body["exception_summary"]:
        assert {"organization_id", "organization_name", "exception_kind", "count", "discrepancy_total_by_currency"} <= set(row)


@control("PRV-03")
def test_aggregate_rows_are_per_tenant(seeded, client_for, platform_admin):
    client = client_for(platform_admin)
    body = client.get("/api/super-admin/billing-command-center/overdue-invoices").json()
    rows = {r["organization_name"]: r for r in body["invoices"]}
    assert set(rows) == {"Tenant Alpha", "Tenant Beta"}
    assert rows["Tenant Alpha"]["overdue_invoice_count"] == 6
    # totals stay per currency — never summed across tenants' currencies
    assert set(rows["Tenant Alpha"]["overdue_total_by_currency"]) == {"USD"}
    assert set(rows["Tenant Beta"]["overdue_total_by_currency"]) == {"EUR"}
    assert rows["Tenant Alpha"]["oldest_days_overdue_bucket"] == "31-60"
