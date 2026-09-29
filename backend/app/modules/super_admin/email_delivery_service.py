"""
modules/super_admin/email_delivery_service.py
-----------------------------------------------
B3 — real operational visibility into email/SMTP delivery health.

Data source: `CommunicationAuditLog` (app/services/email_foundation/models.py,
table communication_audit_logs). Direct grep confirmed every send attempt is
logged there (SENT/SUPPRESSED/FAILED/DUPLICATE/SUPERSEDED/QUEUED) but nothing
in the codebase reads it back — this module is that first read path.

Scope boundary (do not expand without re-checking with the email-reliability
work in progress elsewhere in this codebase):
  - This file only IMPORTS AND CALLS existing public functions
    (`send_*_email` / `send_approval_email` from app.services.email_service,
    and the existing per-record `send_*_via_email` methods on the billing
    services). It never imports from app.services.email_foundation.*
    internals beyond the `CommunicationAuditLog` model itself (a plain
    read), and it never edits email_service.py or email_foundation/*.
  - Known, documented limitation: CommunicationAuditLog does not store the
    full render context of a send (recipient name, amounts, line items,
    etc.). Where no existing, proper "resend" business code path recognizes
    the row's template family, the row is reported as NOT resendable from
    here rather than attempting an unsafe blind replay of a stale audit-log
    row.

DELIBERATE NON-GOAL: widening resend via the EmailOutbox table (Option 2)
--------------------------------------------------------------------------------
This is a considered decision, not an oversight or an unfinished feature. Do
NOT "fix" it by replaying from EmailOutbox.context_json without first
re-reading this section.

`EmailOutbox` (added by B1, same branch) does store everything a blind replay
would need — pre-render `context_json`, `template_name`, `attachments_json` —
and shares `dedupe_key` with CommunicationAuditLog, so the join is technically
possible. We still do not do it, for four reasons:

  1. Replay fidelity is not the actual binding constraint. `context_json` is
     the PRE-render context, and redelivery deliberately re-renders against
     the CURRENT template on disk. For most template families in this codebase
     that template is currently wrong (see the audit noted in
     `_resend_capability`'s comment) — so an outbox replay would faithfully
     re-send a broken body. Widening resend would make it EASIER to send bad
     mail at volume, not better mail. Fix the templates first; the resend
     surface then widens for free on the business-record path.
  2. Coverage would be partial and confusing regardless. Only sends dispatched
     with `async_send=True` ever write an outbox row. A synchronous send that
     fails has no outbox row to fall back on. So the same UI would show some
     failures as resendable and others not, for a reason invisible from the
     audit-log row alone.
  3. The four templates that ARE resendable today (ZB-INV-006, ZB-INV-018,
     ZB-PAY-013, ZB-COL-011) are precisely the ones that route through a
     real business record with its own `send_*_via_email`, so they already get
     correct, tenant-scoped, re-validated resends.
  4. An outbox replay would bypass the per-record validation those
     `send_*_via_email` methods perform (state re-checks, org scoping,
     re-reading current invoice/credit-note amounts). That validation is the
     reason this path is safe.

If this is revisited, it needs: (a) the template-rendering defects fixed
first; (b) an explicit `row.organization_id` == acting-admin-scope check,
mirroring what `resend()` already enforces for the four supported templates;
(c) a third UI capability state so operators can tell "outbox-resendable"
from "business-record-resendable" from "not resendable"; and (d) a test
proving cross-tenant resend is refused.
"""

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

FAILURE_STATUSES = ("FAILED", "SUPPRESSED")
ALL_TRACKED_STATUSES = ("SENT", "FAILED", "SUPPRESSED", "DUPLICATE", "SUPERSEDED", "QUEUED")

# Consecutive/rate-based SMTP health thresholds (§ report_or_update below).
# Deliberately simple — a fixed window + fixed ratio, not a statistical
# model — matching AttentionService's own documented "small, deterministic"
# philosophy rather than inventing inputs this module doesn't have.
_HEALTH_WINDOW = 20
_HEALTH_MIN_SAMPLE = 5
_HEALTH_FAILURE_RATIO = 0.5


class EmailDeliveryService:
    def __init__(self, db: Session):
        self.db = db

    # ── helpers ──────────────────────────────────────────────────────────

    def _org_name_map(self, org_ids: List[Optional[int]]) -> Dict[int, str]:
        from app.modules.organizations.models import Organization

        ids = [i for i in set(org_ids) if i is not None]
        if not ids:
            return {}
        rows = (
            self.db.query(Organization.id, Organization.organization_name)
            .filter(Organization.id.in_(ids))
            .all()
        )
        return {oid: name for oid, name in rows}

    def _resend_capability(self, row) -> Tuple[bool, Optional[str]]:
        """Whether — and why (not) — this failed/suppressed row can be
        resent via an existing, proper business-record resend path.

        The template allowlist below is INTENTIONALLY narrow and is a
        deliberate non-goal to widen via EmailOutbox replay — see the
        "DELIBERATE NON-GOAL" section in this module's docstring for the
        reasoning and for what a future attempt would have to satisfy
        first. `test_email_delivery_resend_scope.py` locks this list so
        widening it has to be a conscious, tested change rather than a
        drive-by edit.
        """
        if row.status not in FAILURE_STATUSES:
            return False, "Only failed or suppressed sends can be resent."
        if row.status == "SUPPRESSED":
            reason = row.suppression_reason or "unknown reason"
            return False, (
                f"Suppressed ({reason}) — resolve the suppression (e.g. the "
                "recipient's bounce/opt-out record) first; resending a "
                "suppressed address would just be suppressed again."
            )
        if not row.target_record_id:
            return False, "No target record id was captured for this send — cannot map it back to a business record."
        try:
            int(row.target_record_id)
        except (TypeError, ValueError):
            return False, "Target record id is not a plain integer — cannot resolve it to a specific record."

        if row.template_id in ("ZB-INV-006", "ZB-INV-018", "ZB-PAY-013", "ZB-COL-011"):
            return True, None
        return False, (
            f"No existing resend code path recognizes template {row.template_id} — "
            "resend is not available from here. This is a deliberate scope limit, "
            "not a transient failure: replaying from the outbox is intentionally "
            "not supported (see the DELIBERATE NON-GOAL section in this module's "
            "docstring) because redelivery re-renders against the current template, "
            "which is not yet correct for this template family. Re-send from the "
            "record's own page instead."
        )

    # ── read models ──────────────────────────────────────────────────────

    def list_recent_failures(self, skip: int = 0, limit: int = 50) -> Dict[str, Any]:
        from app.services.email_foundation.models import CommunicationAuditLog

        query = self.db.query(CommunicationAuditLog).filter(
            CommunicationAuditLog.status.in_(FAILURE_STATUSES)
        )
        total = query.count()
        rows = (
            query.order_by(CommunicationAuditLog.sent_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        org_names = self._org_name_map([r.organization_id for r in rows])

        items = []
        for r in rows:
            resendable, note = self._resend_capability(r)
            items.append(
                {
                    "id": r.id,
                    "recipient": r.recipient,
                    "organization_id": r.organization_id,
                    "organization_name": org_names.get(r.organization_id),
                    "template_id": r.template_id,
                    "event_name": r.event_name,
                    "status": r.status,
                    "suppression_reason": r.suppression_reason,
                    "error_message": r.error_message,
                    "sent_at": r.sent_at,
                    "resendable": resendable,
                    "resend_note": note,
                }
            )
        return {"items": items, "total": total}

    def _window_stats(self, since: datetime) -> Dict[str, Any]:
        from app.services.email_foundation.models import CommunicationAuditLog

        rows = (
            self.db.query(CommunicationAuditLog.status, func.count(CommunicationAuditLog.id))
            .filter(CommunicationAuditLog.sent_at >= since)
            .group_by(CommunicationAuditLog.status)
            .all()
        )
        counts = {status: int(count) for status, count in rows}
        total_attempts = sum(counts.values())
        failed = counts.get("FAILED", 0)
        failure_rate = round((failed / total_attempts) * 100, 1) if total_attempts else None
        return {
            "total_attempts": total_attempts,
            "sent": counts.get("SENT", 0),
            "failed": failed,
            "suppressed": counts.get("SUPPRESSED", 0),
            "duplicate": counts.get("DUPLICATE", 0),
            "superseded": counts.get("SUPERSEDED", 0),
            "queued": counts.get("QUEUED", 0),
            "failure_rate_pct": failure_rate,
        }

    def get_overview(self) -> Dict[str, Any]:
        """Volume/failure-rate numbers over the last 24h and 7d, plus the
        current SMTP health verdict. Also lazily evaluates + reports the
        smtp_health attention item — cheap (one COUNT-style query over the
        last _HEALTH_WINDOW rows), so no separate scheduled job is needed."""
        now = datetime.utcnow()
        last_24h = self._window_stats(now - timedelta(hours=24))
        last_7d = self._window_stats(now - timedelta(days=7))
        smtp_health = self.evaluate_smtp_health()
        return {
            "generated_at": now,
            "last_24h": last_24h,
            "last_7d": last_7d,
            "smtp_health": smtp_health,
        }

    # ── SMTP health → AttentionService wiring ───────────────────────────

    def evaluate_smtp_health(self) -> str:
        """Returns "healthy" / "degraded" / "unknown" and opens/auto-resolves
        the `email_delivery` / `smtp_health` AttentionItem to match. Computed
        on-read from the last _HEALTH_WINDOW SENT/FAILED attempts — genuinely
        broken SMTP (bad host/username/password after a settings change)
        shows up here within the next few send attempts, not a full 24h
        window's wait."""
        from app.services.email_foundation.models import CommunicationAuditLog
        from app.modules.super_admin.attention_service import AttentionService
        from app.modules.super_admin.models import AttentionSeverity

        recent = (
            self.db.query(CommunicationAuditLog.status)
            .filter(CommunicationAuditLog.status.in_(("SENT", "FAILED")))
            .order_by(CommunicationAuditLog.sent_at.desc())
            .limit(_HEALTH_WINDOW)
            .all()
        )
        if len(recent) < _HEALTH_MIN_SAMPLE:
            # Too little signal to claim healthy OR degraded — and too
            # little to justify auto-resolving an item a human may already
            # be working, so this deliberately does not touch AttentionService
            # either way.
            return "unknown"

        failed = sum(1 for (status,) in recent if status == "FAILED")
        failure_rate = failed / len(recent)

        attention = AttentionService(self.db)
        if failure_rate > _HEALTH_FAILURE_RATIO:
            attention.report_or_update(
                source="email_delivery",
                source_key="smtp_health",
                title="SMTP delivery is failing",
                description=(
                    f"{failed} of the last {len(recent)} tracked send attempts failed. "
                    "This usually means SMTP host/username/password no longer match "
                    "(e.g. host or username was changed on the Platform Settings page "
                    "without also updating SMTP_PASSWORD in the environment)."
                ),
                base_severity=AttentionSeverity.P1,
            )
            self.db.commit()
            return "degraded"

        attention.auto_resolve(source="email_delivery", source_key="smtp_health")
        self.db.commit()
        return "healthy"

    # ── manual resend (B3) ───────────────────────────────────────────────

    def resend(self, log_id: int, actor) -> Dict[str, Any]:
        from app.core.exceptions import BadRequestException, NotFoundException
        from app.services.email_foundation.models import CommunicationAuditLog

        row = self.db.query(CommunicationAuditLog).filter(CommunicationAuditLog.id == log_id).first()
        if row is None:
            raise NotFoundException("CommunicationAuditLog", "id")

        resendable, note = self._resend_capability(row)
        if not resendable:
            raise BadRequestException(note or "This send is not resendable from here.")

        record_id = int(row.target_record_id)

        try:
            if row.template_id == "ZB-INV-006" and row.organization_id:
                from app.modules.billing.services.invoice_service import InvoiceService

                InvoiceService(self.db).send_invoice_via_email(
                    invoice_id=record_id, organization_id=row.organization_id, sent_by=actor.id,
                )
            elif row.template_id == "ZB-INV-006":
                # organization_id is None -> this was a Plane 1 (Zoiko-billing
                # -the-org) platform invoice, not a tenant invoice.
                from app.modules.commercial.platform_invoice_service import PlatformInvoiceService

                PlatformInvoiceService(self.db).send(invoice_id=record_id, actor_id=actor.id)
            elif row.template_id == "ZB-INV-018":
                from app.modules.billing.services.credit_note_service import CreditNoteService

                CreditNoteService(self.db).send_credit_note_via_email(
                    cn_id=record_id, organization_id=row.organization_id, sent_by=actor.id,
                )
            elif row.template_id == "ZB-PAY-013":
                from app.modules.billing.services.refund_service import RefundService

                RefundService(self.db).send_refund_via_email(
                    refund_id=record_id, organization_id=row.organization_id, sent_by=actor.id,
                )
            elif row.template_id == "ZB-COL-011":
                from app.modules.billing.services.write_off_service import WriteOffService

                WriteOffService(self.db).send_write_off_via_email(
                    write_off_id=record_id, organization_id=row.organization_id, sent_by=actor.id,
                )
            else:
                raise BadRequestException("This send is not resendable from here.")
        except (BadRequestException, NotFoundException):
            raise
        except ValueError as exc:
            # The existing per-record services raise ValueError for some
            # failure paths (e.g. PlatformInvoiceService.send's "no org_admin
            # found") — surface it the same way BadRequestException would.
            raise BadRequestException(str(exc))

        # The tenant-scoped send_*_via_email methods already commit
        # internally on success; PlatformInvoiceService.send() does not (its
        # own router commits after calling it) — commit here covers both
        # without double-committing anything meaningfully (a no-op commit on
        # an already-clean session is harmless).
        self.db.commit()
        return {
            "success": True,
            "message": "Resend triggered via the existing business record's own resend path.",
        }

    # ── B6(b): synchronous SMTP test send ───────────────────────────────

    def send_test_email(self, recipient_email: str) -> Dict[str, Any]:
        """Sends a real, synchronous test email using the CURRENT effective
        SMTP settings (env + PlatformSetting category="email" overrides,
        exactly what every other email in this platform uses) via the
        stable public `send_approval_email` entrypoint. No queueing, no
        background task — the whole point is immediate feedback on the
        settings page. On failure, the specific error is recorded on the
        CommunicationAuditLog row this write produces and is visible on the
        Email Delivery page (recent failures) moments later."""
        import uuid

        from app.services.email_service import send_approval_email

        test_body = (
            "<html><body style=\"font-family:Arial,sans-serif;color:#1e293b\">"
            "<h2>Zoiko Billing — SMTP test email</h2>"
            "<p>This is a test email sent from the Super Admin Platform Settings page "
            "to confirm the current SMTP configuration can deliver mail.</p>"
            "<p>If you received this, the configured SMTP host, port, username and "
            "password are all working together correctly.</p>"
            "</body></html>"
        )
        event_id = f"smtp-test-{uuid.uuid4().hex}"
        try:
            sent = send_approval_email(
                recipient_email,
                "smtp_test.html",
                {"subject": "Zoiko Billing — SMTP test email"},
                db=self.db,
                organization_id=None,
                template_body=test_body,
                event_name="platform.smtp_test",
                event_id=event_id,
                target_record_id=None,
            )
        except Exception as exc:  # send_approval_email normally swallows
            # delivery errors and returns False; this is a defensive catch
            # for anything raised before that point (e.g. a template/
            # validation error) so the settings page still gets a clean
            # success/failure answer instead of a 500.
            return {"success": False, "message": f"Test email failed: {exc}"}

        if sent:
            return {"success": True, "message": f"Test email sent to {recipient_email}."}
        return {
            "success": False,
            "message": (
                "Test email failed to send. Check the Email Delivery page's recent "
                "failures for the specific SMTP error, or confirm SMTP_PASSWORD in "
                "the environment matches the current host/username."
            ),
        }
