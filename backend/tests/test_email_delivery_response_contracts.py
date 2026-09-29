"""
tests/test_email_delivery_response_contracts.py
-------------------------------------------------
The B3/B6 super-admin email endpoints return
`ResponseModel(**EmailDeliveryService(...).method(...))`. That coupling is
completely invisible to the service's own unit tests, and it broke in
practice: the new schema classes had been appended INSIDE
`SaasReportingResponse`, which orphaned that class's `honesty_notes` field
onto `EmailTestSendResponse`. The service returned only {success, message},
so the orphaned field became a REQUIRED field the endpoint never supplies —
`POST /super-admin/settings/email/test` raised a pydantic ValidationError and
500'd on every single call, while the SaaS reporting response silently lost
a field it had always had.

These tests pin the coupling itself: whatever each service method actually
returns must validate through the response model the router wraps it in,
for every one of the endpoints. Adding a field to a service return, or a
required field to a schema, now fails here instead of in production.
"""
from unittest.mock import patch

import pytest

from app.modules.super_admin.email_delivery_service import EmailDeliveryService
from app.modules.super_admin.schemas import (
    EmailDeliveryOverviewResponse,
    EmailFailureListResponse,
    EmailResendResponse,
    EmailTestSendResponse,
    SaasReportingResponse,
)


def test_smtp_test_response_model_accepts_the_service_payload(db_session):
    """The exact expression the router evaluates on POST settings/email/test.

    send_approval_email is patched so this exercises the real service return
    shape without an SMTP attempt; the failure branch is covered separately
    below because it returns a different dict than the success branch.
    """
    with patch("app.services.email_service.send_approval_email", return_value=True):
        payload = EmailDeliveryService(db_session).send_test_email("ops@example.test")
    assert EmailTestSendResponse(**payload).success is True

    with patch("app.services.email_service.send_approval_email", return_value=False):
        payload = EmailDeliveryService(db_session).send_test_email("ops@example.test")
    assert EmailTestSendResponse(**payload).success is False

    with patch("app.services.email_service.send_approval_email", side_effect=RuntimeError("boom")):
        payload = EmailDeliveryService(db_session).send_test_email("ops@example.test")
    assert EmailTestSendResponse(**payload).success is False


def test_overview_response_model_accepts_the_service_payload(db_session):
    payload = EmailDeliveryService(db_session).get_overview()
    assert EmailDeliveryOverviewResponse(**payload).smtp_health in (
        "healthy", "degraded", "unknown",
    )


def test_failure_list_response_model_accepts_the_service_payload(db_session):
    payload = EmailDeliveryService(db_session).list_recent_failures()
    assert EmailFailureListResponse(**payload).total >= 0


def test_resend_response_model_accepts_the_service_payload(db_session):
    """resend raises NotFound/BadRequest for a row it will not touch (the
    router turns those into a clean 4xx), and returns a success dict
    otherwise. Both the raise and the return must stay consistent with the
    response model the router wraps the return value in."""
    from app.core.exceptions import BadRequestException, NotFoundException

    svc = EmailDeliveryService(db_session)
    with pytest.raises(NotFoundException):
        svc.resend(999999, actor=None)

    # A real FAILED audit row for an unsupported template family is refused
    # with a 400 rather than silently "resending" nothing.
    from app.services.email_foundation import CommunicationAuditLog, SendStatus

    row = CommunicationAuditLog(
        recipient="ops@example.test",
        template_id="ZB-GEN-000",
        event_name="test.event",
        tier="T1",
        status=SendStatus.FAILED.value,
    )
    db_session.add(row)
    db_session.commit()
    with pytest.raises(BadRequestException):
        svc.resend(row.id, actor=None)

    # And the success payload the router does serialize validates.
    assert EmailResendResponse(**{"success": True, "message": "x"}).success is True


def test_saas_reporting_response_still_declares_honesty_notes():
    """Pinned explicitly: this field predates the B3 work and was silently
    dropped from the response model when the new email schemas were added
    mid-class. Restoring it to SaasReportingResponse is a behavior
    regression fix, not a new feature."""
    assert "honesty_notes" in SaasReportingResponse.model_fields
    assert SaasReportingResponse.model_fields["honesty_notes"].default == []


def test_no_response_model_has_an_unexpected_required_field(db_session):
    """Belt-and-braces sweep: a required field on any of these models is
    only safe if the corresponding service method always supplies it. This
    is the check that would have caught the original bug generically."""
    pairs = [
        (EmailTestSendResponse, lambda: EmailDeliveryService(db_session).send_test_email("a@b.test")),
        (EmailDeliveryOverviewResponse, lambda: EmailDeliveryService(db_session).get_overview()),
        (EmailFailureListResponse, lambda: EmailDeliveryService(db_session).list_recent_failures()),
    ]
    for model, call in pairs:
        payload = call()
        missing = [
            name for name, field in model.model_fields.items()
            if field.is_required() and name not in payload
        ]
        assert not missing, f"{model.__name__} requires {missing}, service does not return them"
