"""B4-08: Administration → Email Templates preview contract."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.modules.billing.models import TaxCalculationMethod, TaxRoundingMethod
from app.modules.billing.routers.settings_router import preview_email_template as preview_route
from app.modules.billing.services.admin_service import BillingAdminService


def _svc():
    return BillingAdminService(MagicMock())


def test_layout_partials_are_not_listed_as_templates():
    names = [t.name for t in _svc().list_email_templates()]
    assert "invoice_sent" in names
    assert not [n for n in names if n.startswith("_")]


def test_subject_uses_rendered_title():
    res = _svc().preview_email_template(
        "invoice_sent", {"invoice_number": "INV-1", "company_name": "Acme"}
    )
    assert res.subject == "Invoice INV-1 from Acme"


@pytest.mark.parametrize("raw", ["[]", '"x"', "1"])
def test_non_object_variables_are_a_400_not_a_500(raw):
    with pytest.raises(HTTPException) as exc:
        preview_route(
            template_name="invoice_sent", variables=raw, db=MagicMock(),
            current_user=SimpleNamespace(organization_id=1),
        )
    assert exc.value.status_code == 400


# ── Live-service regressions found while fixing the Administration tab ──────

def test_preview_fills_html_slots_so_preview_matches_the_real_email():
    """Invoice/quote layouts interpolate {{line_items_html}}/{{totals_html}}
    on real sends; the preview used to leave the raw tokens in place, so it
    looked nothing like the email that would be sent."""
    res = _svc().preview_email_template("invoice_sent", {})
    assert "{{line_items_html}}" not in res.rendered_html
    assert "{{totals_html}}" not in res.rendered_html
    assert "preview sample" in res.rendered_html
    # Still reported as missing so users know to supply real values.
    assert "line_items_html" in res.variables_missing


def test_exchange_rate_diagnostics_survives_a_string_json_cache():
    """exchange_rates used to be persisted as a JSON string in some tenants;
    every diagnostics read ran `dict(<string>)` and 500'd the Load button."""
    svc = _svc()
    svc.repo.get_by_organization = lambda org: SimpleNamespace(
        exchange_rate_provider=None,
        exchange_rate_base_currency="INR",
        base_currency=None,
        exchange_rate_last_refreshed=None,
        exchange_rates='{"USD": 83.1, "EUR": "bad"}',
        supported_currencies=["INR", "USD", "EUR"],
    )
    diag = svc.get_exchange_rate_diagnostics(1)
    assert diag.cached_rates == {"USD": 83.1}
    assert any("invalid value 'bad'" in w for w in diag.rate_warnings)


def test_exchange_rate_diagnostics_survives_a_list_of_pairs_cache():
    svc = _svc()
    svc.repo.get_by_organization = lambda org: SimpleNamespace(
        exchange_rate_provider=None,
        exchange_rate_base_currency="USD",
        base_currency=None,
        exchange_rate_last_refreshed=None,
        exchange_rates=[("INR", 86.2)],
        supported_currencies=["USD", "INR"],
    )
    diag = svc.get_exchange_rate_diagnostics(1)
    assert diag.cached_rates == {"INR": 86.2}


def test_tax_diagnostics_shows_human_enum_values_not_class_names():
    """str(SomeEnum) yields 'TaxCalculationMethod.EXCLUSIVE' in the UI;
    the diagnostics now spell values the way the config UI does."""
    svc = _svc()
    svc.repo.get_by_organization = lambda org: SimpleNamespace(
        country=None,
        tax_calculation_method=TaxCalculationMethod.EXCLUSIVE,
        tax_label="GST",
        tax_number=None,
        tax_rounding_method=TaxRoundingMethod.PER_LINE,
        default_tax_rate_id=None,
        is_tax_inclusive_default=True,
        show_tax_on_invoice=True,
        enable_auto_tax_calculation=True,
    )
    svc.db.query.return_value.filter.return_value.all.return_value = []
    items = {i.field: i.value for i in svc.get_tax_diagnostics(1)}
    assert items["tax_calculation_method"] == "exclusive"
    assert items["tax_rounding_method"] == "per_line"