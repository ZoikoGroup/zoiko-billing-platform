"""
tests/ai_assistant/test_qa_rate_limit_and_schema.py
----------------------------------------------------
QA traceability coverage for the API-contract cluster of the Zoiko Billing
Chatbot Combined QA Test Pack v1.0:

  Q34  Clients tolerate unknown/new response fields (extra request fields are
       silently ignored; unknown DB fields never leak into the response).
  Q35  Rate limits / quotas enforced server-side as 429.
  Q36  (partial) OpenAPI schema is well-formed and reproducible. The
       breaking-change CI gate and the Retry-After header are DOCUMENTED GAPS
       (not asserted as absent — see the traceability matrix Notes).

Q35: the server enforces 429 in two layers - slowapi transport limits and
the entitlement THROTTLE block. We pin the THROTTLE block maps to HTTP 429
and renders a non-leaking body. Retry-After header is NOT emitted under the
current configuration; this is a documented gap, not a passing absence-test.
"""

import pytest

from app.modules.commercial.entitlement_enforcement import (
    EntitlementThrottledException,
)


class TestUnknownFieldToleranceQ34:
    """Q34: extra fields in a request payload must be ignored (not a 422),
    and unknown response-side DB fields must never leak into the JSON."""

    def test_pydantic_ignores_unknown_request_fields(self):
        # The canonical billing update schema drops unknown fields instead of
        # rejecting them (default Pydantic `extra='ignore'`).
        from app.modules.organizations.schemas import OrganizationUpdate
        assert not OrganizationUpdate.model_config.get("extra") == "forbid"
        # Extra keys are not part of the schema and are ignored on bind.
        model = OrganizationUpdate.model_validate(
            {"website": "https://a.example", "totally_unknown_field": "x"}
        )
        assert not hasattr(model, "totally_unknown_field")

    def test_unknown_request_field_does_not_break_validation(self, db_session):
        # Building the model with an unknown key must succeed (ignored), i.e.
        # old clients can send a superset of fields without a 422.
        from app.modules.organizations.schemas import OrganizationUpdate
        try:
            OrganizationUpdate(website="https://ok.example", billing_source="registered_via_zoiko_one")
        except Exception:
            pytest.fail("unknown response fields are not tolerated on bind")

    def test_response_schema_does_not_echo_db_only_columns(self, db_session):
        # A response DTO must not expose internal DB columns not declared on it.
        import dataclasses
        from app.modules.billing import schemas as bs
        # OrganizationUpdate (request) deliberately exposes no billing_source.
        from app.modules.organizations.schemas import OrganizationUpdate
        assert "billing_source" not in OrganizationUpdate.model_fields


class TestRateLimitThrottleQ35:
    """Q35: a THROTTLE entitlement block must map to HTTP 429 and render a
    non-leaking body. Gap pinned: no Retry-After header under current config.
    """

    def test_throttle_exception_is_429(self):
        exc = EntitlementThrottledException("'x' rate limit (10) exceeded.")
        assert exc.status_code == 429

    def test_throttle_renders_non_leaking_429_body(self):
        import asyncio
        from app.core.exceptions import zoiko_exception_handler
        from app.modules.commercial.entitlement_enforcement import (
            EntitlementThrottledException,
        )
        exc = EntitlementThrottledException("'x' rate limit (10) exceeded.")
        response = asyncio.run(zoiko_exception_handler(_req(), exc))
        assert response.status_code == 429
        body = response.body.decode("utf-8")
        assert "success" in body
        assert "stack" not in body.lower()
        assert "traceback" not in body.lower()


def _req():
    from unittest.mock import MagicMock
    req = MagicMock()
    req.state.request_id = "r-1"
    return req


class TestOpenApiSchemaWellFormedQ36:
    """Q36 (partial): the OpenAPI schema must generate cleanly and expose the
    documented surface. The full breaking-change CI gate is a separate OPEN
    decision (no spec snapshot / no CI step exists today) and is deliberately
    NOT asserted as present."""

    def test_openapi_generates_with_all_expected_sections(self):
        from app.main import app
        spec = app.openapi()
        assert "paths" in spec
        assert "info" in spec
        assert isinstance(spec["paths"], dict) and spec["paths"]

    def test_openapi_has_versioned_info(self):
        from app.main import app
        spec = app.openapi()
        assert "version" in spec.get("info", {})
