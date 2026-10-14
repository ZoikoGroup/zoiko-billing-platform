"""
modules/super_admin/tasks/attention_maintenance.py
--------------------------------------------------
Scheduled job: return suppressed Attention items to OPEN once their
suppressed_until has passed. This used to run (as a WRITE) inside the polled
GET /attention/counts, /attention and /triage/summary reads; those are now
pure reads and this job (every minute, via _tracked_job_runner so it gets a
JobRunLog row and Attention failure reporting) owns the lift.
"""

import logging

logger = logging.getLogger("zoiko_billing.super_admin.attention_maintenance")


def run_attention_maintenance_job() -> None:
    from app.database import SessionLocal
    from app.modules.super_admin.attention_service import AttentionService

    db = SessionLocal()
    try:
        lifted = AttentionService(db).lift_expired_suppressions()
        db.commit()
        if lifted:
            logger.info("Lifted %d expired attention suppression(s)", lifted)
    except Exception:
        db.rollback()
        logger.exception("Attention maintenance job failed")
        raise
    finally:
        db.close()
