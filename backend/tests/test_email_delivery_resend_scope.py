"""
tests/test_email_delivery_resend_scope.py
------------------------------------------
Locks the DELIBERATE NON-GOAL documented in
`app/modules/super_admin/email_delivery_service.py`: resend is scoped to the
four template families that route through a real business record's own
`send_*_via_email` method, and is intentionally NOT widened by replaying
`EmailOutbox.context_json`.

Why this needs a test rather than just a docstring: the outbox table (B1,
same branch) *does* store pre-render context + template_name + attachments
and shares `dedupe_key` with CommunicationAuditLog, so "just replay from the
outbox" is an obvious-looking improvement that a future maintainer could
make in a few lines. It is wrong for now — redelivery re-renders against
the CURRENT template, which is not yet correct for most families, so it
would make it easier to send broken mail in volume.

These tests assert the allowlist itself. If someone widens it, the failure
message tells them to re-read the non-goal section and satisfy its
prerequisites (template fixes, tenant-isolation check, a third UI capability
state, a cross-tenant refusal test) rather than to simply delete a test.
"""
from types import SimpleNamespace

import pytest

from app.modules.super_admin.email_delivery_service import EmailDeliveryService

# The four supported families, and the business-record method each routes to.
SUPPORTED = {
    "ZB-INV-006": "invoice",
    "ZB-INV-018": "credit_note",
    "ZB-PAY-013": "refund",
    "ZB-COL-011": "write_off",
}

# A representative unsupported family. ZB-GAP-007 (user role changed) is a
# good pick: it IS dispatched in production (super_admin/user_admin_service),
# so this row is a realistic "an operator sees a failure they cannot resend"
# case rather than a synthetic one.
UNSUPPORTED = "ZB-GAP-007"


def _row(**kw):
    base = dict(
        status="FAILED",
        suppression_reason=None,
        target_record_id="42",
        template_id="ZB-INV-006",
        organization_id=7,
    )
    base.update(kw)
    return SimpleNamespace(**base)


@pytest.fixture
def svc():
    # _resend_capability is pure — it only reads attributes off the row, so
    # no DB session is needed and none of these tests can accidentally pass
    # because "the database said yes".
    return EmailDeliveryService.__new__(EmailDeliveryService)


@pytest.mark.parametrize("template_id", sorted(SUPPORTED))
def test_supported_families_remain_resendable(svc, template_id):
    ok, note = svc._resend_capability(_row(template_id=template_id))
    assert ok is True, f"{template_id} should stay resendable, got: {note}"
    assert note is None


@pytest.mark.parametrize("template_id", sorted(SUPPORTED))
def test_resend_dispatch_covers_every_supported_family(svc, template_id):
    """Every allowlisted family must actually have a branch in resend().

    A template can be added to the allowlist without a matching dispatch
    branch, which would report "resendable" and then fall through to the
    generic BadRequestException at the end of resend(). This reads resend()
    and asserts each allowlisted id has its own explicit branch.
    """
    import inspect

    from app.modules.super_admin import email_delivery_service as mod

    src = inspect.getsource(mod.EmailDeliveryService.resend)
    for tid in SUPPORTED:
        assert f'== "{tid}"' in src, (
            f"{tid} is in the resend allowlist but resend() has no dispatch "
            f"branch for it — it would report resendable then fail."
        )


def test_unsupported_family_is_refused_with_actionable_reason(svc):
    ok, note = svc._resend_capability(_row(template_id=UNSUPPORTED))
    assert ok is False
    # The operator-facing note must explain this is a scope decision, not a
    # transient error, and must point at the record's own page as the
    # actual path. A bare "not resendable" is what this replaces.
    assert "deliberate" in note.lower()
    assert "record's own page" in note


def test_allowlist_is_exactly_four_families(svc):
    """Pins the allowlist size so a widening cannot happen silently.

    The four are all business-record-backed and currently render from their
    own bespoke template. A fifth entry is a deliberate act that should
    arrive with the template fix it depends on — not as a drive-by edit.
    """
    resendable = {
        tid for tid in [
            "ZB-INV-006", "ZB-INV-018", "ZB-PAY-013", "ZB-COL-011",
            UNSUPPORTED, "ZB-COM-004", "ZB-SUB-005", "ZB-PAY-002",
        ]
        if svc._resend_capability(_row(template_id=tid))[0]
    }
    assert resendable == set(SUPPORTED), (
        f"Resend allowlist changed to {sorted(resendable)}. If this is "
        f"intentional, re-read the DELIBERATE NON-GOAL section in "
        f"email_delivery_service.py and satisfy its prerequisites first."
    )


def test_suppressed_rows_never_resend_even_for_supported_templates(svc):
    """Suppression must be resolved before resend, not worked around.

    Guards the ordering in _resend_capability: the SUPPRESSED check runs
    before the allowlist check, so adding templates can never accidentally
    make a bounced/opted-out address resendable.
    """
    ok, note = svc._resend_capability(
        _row(template_id="ZB-INV-006", status="SUPPRESSED",
             suppression_reason="hard_bounce")
    )
    assert ok is False
    assert "hard_bounce" in note


def test_non_failure_status_never_resends(svc):
    for status in ("SENT", "DUPLICATE", "SUPERSEDED", "QUEUED"):
        ok, note = svc._resend_capability(_row(status=status))
        assert ok is False, f"{status} must not be resendable"
        assert "failed or suppressed" in note.lower()


def test_missing_or_non_integer_target_record_is_refused(svc):
    """Without an int target_record_id there is no record to re-read.

    This is the guard that keeps a blind outbox replay from being the only
    option for these rows — there is deliberately nothing to fall back to.
    """
    ok, note = svc._resend_capability(_row(target_record_id=None))
    assert ok is False and "target record id" in note.lower()

    ok, note = svc._resend_capability(_row(target_record_id="not-an-int"))
    assert ok is False and "plain integer" in note.lower()
