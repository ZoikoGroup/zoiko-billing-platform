"""Hardening: user-facing errors never carry raw exception text (SQL, paths,
provider errors, internal class/enum names, circuit-breaker scope keys)."""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy.exc import IntegrityError

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.services.import_row_errors import GENERIC_ROW_ERROR, row_error_message

RAW = "(psycopg2.errors.UniqueViolation) duplicate key [SQL: INSERT INTO products ...] /app/data/x.xlsx"


def test_product_template_500_has_no_raw_exception_text():
    from app.modules.billing.routers import product_router

    with patch.object(product_router, "ProductImportService") as svc:
        svc.return_value.generate_template.side_effect = RuntimeError(RAW)
        with pytest.raises(HTTPException) as exc:
            product_router.import_template(format="csv", db=MagicMock(), current_user=SimpleNamespace(organization_id=1))
    assert exc.value.status_code == 500
    assert "SQL" not in exc.value.detail and "/app/" not in exc.value.detail
    assert exc.value.detail.startswith("Template generation failed.")


def test_router_lets_business_errors_keep_their_status():
    from app.modules.billing.routers import product_router

    with patch.object(product_router, "ProductImportService") as svc:
        svc.return_value.generate_template.side_effect = NotFoundException("Template", "format")
        with pytest.raises(NotFoundException):
            product_router.import_template(format="csv", db=MagicMock(), current_user=SimpleNamespace(organization_id=1))


class _Row(BaseModel):
    unit_price: float

    @field_validator("unit_price")
    @classmethod
    def _positive(cls, v):
        if v <= 0:
            raise ValueError("must be greater than 0")
        return v


def test_row_errors_keep_validation_text_but_hide_database_errors():
    assert row_error_message(BadRequestException("SKU already exists"), 3, "Product") == "SKU already exists"
    assert row_error_message(ValueError("Unknown currency 'XXX'"), 3, "Product") == "Unknown currency 'XXX'"
    with pytest.raises(ValidationError) as v:
        _Row(unit_price=-1)
    assert row_error_message(v.value, 3, "Product") == "Unit price: must be greater than 0"
    db_err = IntegrityError("INSERT INTO products ...", {"sku": "A"}, Exception("duplicate key"))
    assert row_error_message(db_err, 3, "Product") == GENERIC_ROW_ERROR


def test_kill_switch_message_has_no_internal_scope_key():
    from app.modules.super_admin.kill_switch_service import BillingKillSwitchService

    svc = BillingKillSwitchService.__new__(BillingKillSwitchService)
    with patch.object(BillingKillSwitchService, "is_enabled", return_value=False):
        with pytest.raises(Exception) as exc:
            svc.require_enabled("invoice.send")
    assert "invoice.send" not in str(exc.value)
    assert "circuit breaker" not in str(exc.value).lower()


def test_stripe_connect_provider_errors_are_not_echoed():
    from app.modules.billing.services import stripe_connect_service as scs

    stripe = MagicMock()
    stripe.OAuth.token.side_effect = RuntimeError("Request req_123: invalid_grant")
    svc = scs.StripeConnectService(MagicMock())
    with (
        patch.object(scs, "_stripe_module", return_value=stripe),
        patch.object(scs, "verify_oauth_state", return_value=True),
    ):
        with pytest.raises(BadRequestException) as exc:
            svc.complete_oauth(1, "code", state="s")
    stripe.OAuth.token.assert_called_once()  # reached the provider call, not the state check
    assert "req_123" not in exc.value.message and "invalid_grant" not in exc.value.message


def test_platform_checkout_message_has_no_status_prefix():
    """Production (Oct 9): Pay Now on PINV-000007 showed "400: Online payment
    is not available yet..." -- str(BadRequestException) adds the status."""
    from app.modules.commercial import platform_stripe_router as r

    with (
        patch.object(r, "PlatformInvoiceService") as inv_svc,
        patch.object(r, "PlatformStripeService") as stripe_svc,
    ):
        inv_svc.return_value.get_public_invoice.return_value = object()
        stripe_svc.return_value.create_checkout_session_for_invoice.side_effect = BadRequestException(
            "Online payment is not available yet. Please contact Zoiko support to complete payment."
        )
        with pytest.raises(HTTPException) as exc:
            r.create_checkout_session(token="tok", db=MagicMock())
    assert exc.value.status_code == 400
    assert exc.value.detail.startswith("Online payment is not available yet")
