"""
app/services/email_foundation/health_task.py
---------------------------------------------
APScheduler entry point for periodic SMTP-health evaluation (A3).

Why this exists as its OWN job rather than being appended to the end of
`run_email_queue_recovery_job`: `app/core/scheduler.py` registers one
concern per job, each with its own interval setting, its own display name
(for the Telemetry freshness check), and — via `_tracked_job_runner — its
own JobRunLog row. Every existing definition in `get_job_definitions()`
follows that shape (recurring billing, exchange rates, overdue invoices,
dunning, escalation, promise-to-pay, commercial equivalents, financial
consistency, reconciliation, invoice reminder, trial warning, outbox
recovery). Piggybacking health onto the recovery sweep would have broken
that convention in three ways:

  1. The sweep is gated by `ENABLE_EMAIL_QUEUE_RECOVERY`. An operator who
     disables crash-recovery (a reasonable thing to do on a single-node
     deploy) would silently stop getting SMTP-health signal, which is an
     unrelated concern.
  2. The sweep's return value is the outbox sweep's summary, consumed by
     telemetry. Mixing a health verdict into it would make the JobRunLog
     summary ambiguous about what actually ran.
  3. The two have genuinely different cadences: the sweep is about stuck
     rows (every 10 min by default), health is a trend over the last
     _HEALTH_WINDOW attempts (15 min is plenty and cheaper).

The gap this closes: health used to be computed ONLY on-read, from
`GET /email-delivery/overview`. That endpoint is hit when a super admin
opens the Command Center Hub (it is a lens card there) or the Email
Delivery page directly — so during an SMTP outage with nobody logged in,
a genuinely broken mail configuration (bad host/username/password after a
settings change) stayed invisible until somebody happened to visit. This
job makes detection independent of page views, which was the actual point.
"""
import logging
import time
from typing import Any, Dict

logger = logging.getLogger(__name__)


def run_email_smtp_health_job() -> Dict[str, Any]:
    """Recompute SMTP delivery health and sync the AttentionService item.

    Opens its own DB session — the same pattern `run_email_queue_recovery_job`
    and every other job entry point in this codebase follows. Any failure is
    contained and reported in the returned summary rather than raised, so a
    transient DB problem degrades this job alone; `_tracked_job_runner` still
    records the failure and raises a job-failure attention item.
    """
    from app.config import settings as _settings
    from app.database import SessionLocal

    if not getattr(_settings, "ENABLE_EMAIL_SMTP_HEALTH_CHECK", True):
        return {"skipped": True, "reason": "ENABLE_EMAIL_SMTP_HEALTH_CHECK is False"}

    start_time = time.monotonic()
    logger.info("[SCHEDULER] Email SMTP health check started")

    db = SessionLocal()
    try:
        # Imported at call time: email_delivery_service lives in the
        # super_admin module and pulls in the attention/audit stack. A
        # module-level import would make this lightweight job file import
        # the whole super_admin import graph on every scheduler boot.
        from app.modules.super_admin.email_delivery_service import EmailDeliveryService

        status = EmailDeliveryService(db).evaluate_smtp_health()
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(
            f"[SCHEDULER] Fatal error in email SMTP health check: {exc}",
            exc_info=True,
        )
        return {
            "errors": [str(exc)],
            "duration_seconds": round(time.monotonic() - start_time, 3),
        }
    finally:
        db.close()

    summary = {
        "smtp_health": status,
        "duration_seconds": round(time.monotonic() - start_time, 3),
    }
    logger.info(f"[SCHEDULER] Email SMTP health check completed: {summary}")
    return summary
