"""B4-08: Administration → Email Templates preview contract."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

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
