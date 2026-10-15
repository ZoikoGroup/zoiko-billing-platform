"""Small-cell suppression: 0 < n < 5 is masked (no count, no amount); n >= 5
and n == 0 are shown."""
import pytest

from app.modules.super_admin.privacy import (
    count_cells,
    currency_totals,
    mask_small_cell,
)
from tests.privacy.conftest import control, seed_tenant


@control("PRV-03")
@pytest.mark.parametrize("n", [1, 2, 3, 4])
def test_mask_small_cell_masks_below_threshold(n):
    assert mask_small_cell(n, "10.00") == {"count": None, "count_label": "fewer than 5", "amount": None}


@control("PRV-03")
@pytest.mark.parametrize("n", [5, 6, 100])
def test_mask_small_cell_shows_at_or_above_threshold(n):
    assert mask_small_cell(n, "10.00") == {"count": n, "count_label": None, "amount": "10.00"}


@control("PRV-03")
def test_zero_stays_zero():
    assert mask_small_cell(0, "0") == {"count": 0, "count_label": None, "amount": "0"}


@control("PRV-03")
def test_threshold_is_configurable(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "PLATFORM_MIN_CELL_SIZE", 3)
    assert mask_small_cell(2)["count"] is None
    assert mask_small_cell(3)["count"] == 3


@control("PRV-03")
def test_helpers_mask_cells_and_never_merge_currencies():
    cells = count_cells({"open": 2, "paid": 9})
    assert cells["open"] == {"count": None, "count_label": "fewer than 5"}
    assert cells["paid"] == {"count": 9, "count_label": None}
    totals = currency_totals([("USD", 7, "70.00"), ("EUR", 2, "20.00"), ("USD", 1, "1.00")])
    assert totals["USD"] == {"count": 8, "count_label": None, "amount": "71.00"}
    assert totals["EUR"] == {"count": None, "count_label": "fewer than 5", "amount": None}


@control("PRV-03")
def test_endpoint_masks_small_tenant_and_shows_large_tenant(db_session, client_for, platform_admin):
    seed_tenant(db_session, "A", "Small Tenant", 3)
    seed_tenant(db_session, "B", "Large Tenant", 6)
    client = client_for(platform_admin)

    body = client.get("/api/super-admin/billing-command-center/overdue-invoices").json()
    rows = {r["organization_name"]: r for r in body["invoices"]}
    small, large = rows["Small Tenant"], rows["Large Tenant"]
    assert small["overdue_invoice_count"] is None
    assert small["overdue_invoice_count_label"] == "fewer than 5"
    assert small["overdue_total_by_currency"]["USD"] == {"count": None, "count_label": "fewer than 5", "amount": None}
    assert large["overdue_invoice_count"] == 6
    assert large["overdue_total_by_currency"]["USD"]["amount"] == "600.00"

    refunds = {r["organization_name"]: r for r in client.get("/api/super-admin/financial-operations/refunds").json()["items"]}
    assert refunds["Small Tenant"]["count_by_status"]["completed"]["count"] is None
    assert refunds["Small Tenant"]["total_by_currency"]["USD"]["amount"] is None
    assert refunds["Large Tenant"]["count_by_status"]["completed"]["count"] == 6
    assert refunds["Large Tenant"]["total_by_currency"]["USD"]["amount"] == "42.00"

    failed = {r["organization_name"]: r for r in client.get("/api/super-admin/financial-operations/failed-payments").json()["items"]}
    assert failed["Small Tenant"]["failed_count"] is None
    assert failed["Small Tenant"]["top_failure_reasons"][0]["count"] is None
    assert failed["Large Tenant"]["failed_count"] == 6
    assert failed["Large Tenant"]["top_failure_reasons"][0] == {
        "reason": "card_declined", "count": 6, "count_label": None,
    }


@control("PRV-03")
def test_limit_means_max_tenants(db_session, client_for, platform_admin):
    seed_tenant(db_session, "A", "Tenant One", 6)
    seed_tenant(db_session, "B", "Tenant Two", 7)
    client = client_for(platform_admin)
    body = client.get("/api/super-admin/financial-operations/refunds?limit=1").json()
    assert [r["organization_name"] for r in body["items"]] == ["Tenant Two"]
