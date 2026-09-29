"""
email_foundation/recovery.py
-----------------------------
B1 crash-recovery sweep for the durable email outbox (EmailOutbox,
app/services/email_foundation/models.py).

send_approval_email's async_send=True path writes a QUEUED EmailOutbox row
BEFORE handing the send off to the in-process ThreadPoolExecutor (see
email_service.py's _create_outbox_row / _deliver_smtp_standalone). That
ordering means a row can be genuinely stuck in QUEUED for one of two
reasons: the process crashed/restarted between the commit and the
background thread actually running, or the background thread ran but never
got a chance to flip the row's status (crashed mid-send). Either way,
nothing else in the codebase ever revisits a QUEUED row on its own -- this
module is what does that, on a schedule (registered in
app/core/scheduler.py) and is also safe to invoke directly (e.g. once at
process startup, or from a test proving the crash-recovery guarantee).
"""

import base64
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Dict

logger = logging.getLogger("zoiko_billing")


def sweep_stuck_outbox_rows(db, grace_minutes: int = None, max_attempts: int = None) -> Dict[str, Any]:
    """Finds EmailOutbox rows stuck in QUEUED for longer than the grace
    period and attempts redelivery for each, via _deliver_smtp_standalone --
    the SAME render+send+audit-log code path send_approval_email's own
    sync/async delivery uses, so a recovered send behaves identically to a
    normal one (correct branding/template, B2 retry, B5 attachment
    subtypes, a CommunicationAuditLog row).

    Bounded: a row that has already failed max_attempts times is marked
    FAILED and left alone -- never retried forever. A human investigates it
    from there (the outbox table is readable by the admin dashboard other
    work in this codebase is building).

    Returns a summary dict: {found, redelivered, failed, exhausted, errors}.
    """
    from app.config import settings as _settings
    from app.services.email_foundation import EmailOutbox
    from app.services.email_service import _deliver_smtp_standalone

    grace_minutes = grace_minutes if grace_minutes is not None else _settings.EMAIL_QUEUE_RECOVERY_GRACE_MINUTES
    max_attempts = max_attempts if max_attempts is not None else _settings.EMAIL_QUEUE_MAX_DELIVERY_ATTEMPTS

    cutoff = datetime.utcnow() - timedelta(minutes=grace_minutes)
    summary: Dict[str, Any] = {"found": 0, "redelivered": 0, "failed": 0, "exhausted": 0, "errors": []}

    stuck_rows = (
        db.query(EmailOutbox)
        .filter(EmailOutbox.status == "QUEUED", EmailOutbox.created_at < cutoff)
        .all()
    )
    summary["found"] = len(stuck_rows)

    for row in stuck_rows:
        try:
            if (row.attempts or 0) >= max_attempts:
                # Bounded retries exhausted -- stop retrying, leave FAILED for
                # a human rather than looping on a permanently-broken send
                # (bad address, template deleted, etc) forever.
                row.status = "FAILED"
                row.last_error = ((row.last_error or "") + f" | recovery: max attempts ({max_attempts}) exhausted").strip(" |")
                db.commit()
                summary["exhausted"] += 1
                continue

            try:
                context = json.loads(row.context_json) if row.context_json else {}
            except Exception:
                logger.exception(f"[email_recovery] Failed to decode context_json for outbox row {row.id}")
                context = {}

            attachments = None
            if row.attachments_json:
                try:
                    raw_attachments = json.loads(row.attachments_json)
                    attachments = [
                        (filename, base64.b64decode(b64_data))
                        for filename, b64_data in raw_attachments
                    ]
                except Exception:
                    logger.exception(f"[email_recovery] Failed to decode attachments_json for outbox row {row.id}")
                    attachments = None

            delivered = _deliver_smtp_standalone(
                email=row.recipient,
                template_name=row.template_name,
                context=context,
                db=db,
                organization_id=row.organization_id,
                template_id=row.template_id,
                event_name=row.event_name,
                event_id=row.event_id,
                target_record_id=row.target_record_id,
                dedupe_key=row.dedupe_key,
                attachments=attachments,
                from_email_override=row.from_email_override,
                from_display_name_override=row.from_display_name_override,
                outbox_id=row.id,
            )
            if delivered:
                summary["redelivered"] += 1
            else:
                summary["failed"] += 1
        except Exception as exc:
            summary["errors"].append(f"outbox row {row.id}: {exc}")
            logger.error(f"[email_recovery] Failed to redeliver outbox row {row.id}: {exc}", exc_info=True)
            try:
                db.rollback()
            except Exception:
                pass

    return summary


def run_email_queue_recovery_job() -> Dict[str, Any]:
    """APScheduler entry point -- registered as a (func_ref, interval, id,
    name) tuple in app/core/scheduler.py's get_job_definitions(), which wraps
    every call in _tracked_job_runner (JobRunLog + AttentionService
    bookkeeping) automatically. Opens its own DB session, same pattern every
    other job in this file follows, and delegates to sweep_stuck_outbox_rows.
    """
    from app.config import settings as _settings
    from app.database import SessionLocal

    if not getattr(_settings, "ENABLE_EMAIL_QUEUE_RECOVERY", True):
        return {"skipped": True, "reason": "ENABLE_EMAIL_QUEUE_RECOVERY is False"}

    start_time = time.monotonic()
    logger.info("[SCHEDULER] Email queue recovery sweep started")

    db = SessionLocal()
    try:
        summary = sweep_stuck_outbox_rows(db)
    except Exception as exc:
        db.rollback()
        logger.error(f"[SCHEDULER] Fatal error in email queue recovery sweep: {exc}", exc_info=True)
        summary = {"errors": [str(exc)]}
    finally:
        db.close()

    summary["duration_seconds"] = round(time.monotonic() - start_time, 3)
    logger.info(f"[SCHEDULER] Email queue recovery sweep completed: {summary}")
    return summary
