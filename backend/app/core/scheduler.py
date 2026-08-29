"""
core/scheduler.py
-----------------
APScheduler singleton for background periodic jobs (billing dunning,
recurring subscription billing, overdue-invoice detection).

Uses BackgroundScheduler (thread-based) — no Redis/Celery required.
Integrates with FastAPI startup/shutdown lifecycle. Only started when
settings.ENABLE_RECURRING_BILLING_SCHEDULER is true — see app/main.py.
"""

import logging
from datetime import datetime
from typing import Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.executors.pool import ThreadPoolExecutor

logger = logging.getLogger("zoiko_billing")

_scheduler: BackgroundScheduler | None = None


def _tracked_job_runner(func_ref: str, job_id: str, display_name: str) -> None:
    """Wraps a scheduled job with real run-history telemetry (ZB-SA-CMD-003
    §8, Domain C — 'background job health'). Resolves func_ref lazily (same
    "import only when the job actually runs" behavior the string-based
    add_job() call had before this wrapper existed) and records exactly one
    JobRunLog row per execution: RUNNING at start, then SUCCEEDED/FAILED
    with timestamps and (on failure only) the error message. Never raises —
    a job's own failure must not crash the scheduler thread — but always
    re-logs it, matching the prior bare-call behavior's visibility.
    """
    import importlib

    from app.database import SessionLocal
    from app.modules.super_admin.models import JobRunLog, JobRunStatus

    module_path, func_name = func_ref.split(":")
    module = importlib.import_module(module_path)
    target = getattr(module, func_name)

    db = SessionLocal()
    run = JobRunLog(
        job_name=job_id,
        display_name=display_name,
        status=JobRunStatus.RUNNING,
        started_at=datetime.utcnow(),
    )
    try:
        db.add(run)
        db.commit()
        target()
        run.status = JobRunStatus.SUCCEEDED
    except Exception as exc:  # noqa: BLE001 - a job's failure must not crash the scheduler thread
        run.status = JobRunStatus.FAILED
        run.error_message = str(exc)[:2000]
        logger.error("[SCHEDULER] Job %s failed: %s", job_id, exc, exc_info=True)
    finally:
        run.finished_at = datetime.utcnow()
        try:
            db.commit()
        except Exception:
            db.rollback()

        # ZB-SA-CMD-003 §10 — real Attention Engine event ingestion. A
        # separate try/except: a bug in attention bookkeeping must never
        # mask the job's own real result above, nor crash the scheduler.
        try:
            from app.modules.super_admin.attention_service import AttentionService
            from app.modules.super_admin.models import AttentionSeverity, JobRunStatus as _JRS

            attention = AttentionService(db)
            if run.status == _JRS.FAILED:
                attention.report_or_update(
                    source="job_failure",
                    source_key=f"job:{job_id}",
                    title=f"{display_name} failing",
                    description=run.error_message,
                    base_severity=AttentionSeverity.P2,
                )
            else:
                attention.auto_resolve(source="job_failure", source_key=f"job:{job_id}")
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("[SCHEDULER] Attention-Engine bookkeeping failed for job %s", job_id)
        finally:
            db.close()


def get_scheduler() -> BackgroundScheduler | None:
    return _scheduler


def start_scheduler() -> None:
    """Start the global scheduler. Called once at application startup."""
    global _scheduler
    if _scheduler is not None:
        logger.warning("Scheduler already started — skipping")
        return

    jobstores = {"default": MemoryJobStore()}
    executors = {"default": ThreadPoolExecutor(max_workers=2)}
    job_defaults = {
        "coalesce": True,
        "max_instances": 1,
        "misfire_grace_time": 3600,
    }

    _scheduler = BackgroundScheduler(
        jobstores=jobstores,
        executors=executors,
        job_defaults=job_defaults,
    )

    _register_billing_jobs(_scheduler)

    _scheduler.start()
    logger.info("Recurring billing scheduler started")


def shutdown_scheduler() -> None:
    """Gracefully shut down the scheduler. Called at application shutdown."""
    global _scheduler
    if _scheduler is None:
        return
    try:
        _scheduler.shutdown(wait=False)
        logger.info("Recurring billing scheduler shut down")
    except Exception as exc:
        logger.warning("Scheduler shutdown error: %s", exc)
    finally:
        _scheduler = None


def get_job_definitions() -> list[tuple[str, int, str, str]]:
    """(func_ref, interval_minutes, job_id, display_name) for every recurring
    job. Single source of truth — used both to register the jobs and by
    TelemetryService to compute each job's expected cadence for freshness
    (ZB-SA-CMD-003 §10.2), so the two can never silently drift apart."""
    from app.config import settings

    return [
        (
            "app.modules.billing.tasks.recurring_billing:run_recurring_billing_job",
            settings.RECURRING_BILLING_INTERVAL_MINUTES,
            "recurring_billing_job",
            "Recurring Subscription Billing",
        ),
        (
            "app.modules.billing.tasks.overdue_invoices:run_overdue_invoice_job",
            settings.OVERDUE_INVOICE_CHECK_INTERVAL_MINUTES,
            "overdue_invoice_job",
            "Overdue Invoice Detection",
        ),
        (
            "app.modules.billing.tasks.dunning_process:run_dunning_process_job",
            settings.DUNNING_PROCESS_INTERVAL_MINUTES,
            "dunning_process_job",
            "Dunning/Reminder Processing",
        ),
        (
            "app.modules.billing.tasks.escalation_to_collections:run_escalation_to_collections_job",
            settings.ESCALATION_TO_COLLECTIONS_INTERVAL_MINUTES,
            "escalation_to_collections_job",
            "Dunning-to-Collections Escalation",
        ),
        (
            "app.modules.billing.tasks.promise_to_pay_check:run_promise_to_pay_check_job",
            settings.PROMISE_TO_PAY_CHECK_INTERVAL_MINUTES,
            "promise_to_pay_check_job",
            "Promise-to-Pay Status Check",
        ),
        (
            "app.modules.commercial.tasks.dunning_process:run_commercial_dunning_job",
            settings.COMMERCIAL_DUNNING_INTERVAL_MINUTES,
            "commercial_dunning_job",
            "Commercial (Plane-1) Failed-Payment Dunning",
        ),
        (
            "app.modules.commercial.tasks.recurring_invoice:run_commercial_recurring_invoice_job",
            settings.COMMERCIAL_RECURRING_INVOICING_INTERVAL_MINUTES,
            "commercial_recurring_invoice_job",
            "Commercial (Plane-1) Recurring Invoice Generation",
        ),
        (
            "app.modules.commercial.tasks.trial_expiry:run_commercial_trial_expiry_job",
            settings.COMMERCIAL_TRIAL_EXPIRY_CHECK_INTERVAL_MINUTES,
            "commercial_trial_expiry_job",
            "Commercial (Plane-1) Free-Trial Expiry Sweep",
        ),
        (
            "app.modules.commercial.tasks.apply_scheduled_change:run_scheduled_plan_change_job",
            settings.SCHEDULED_PLAN_CHANGE_CHECK_INTERVAL_MINUTES,
            "scheduled_plan_change_job",
            "Commercial (Plane-1) Scheduled Plan-Change Apply Sweep",
        ),
        (
            "app.modules.super_admin.tasks.financial_consistency:run_financial_consistency_job",
            settings.FINANCIAL_CONSISTENCY_INTERVAL_MINUTES,
            "financial_consistency_job",
            "Financial Integrity Check",
        ),
        (
            "app.modules.super_admin.tasks.reconciliation:run_reconciliation_job",
            settings.RECONCILIATION_INTERVAL_MINUTES,
            "reconciliation_job",
            "Ledger Reconciliation (REC-01)",
        ),
    ]


def get_job_interval_minutes(job_id: str) -> Optional[int]:
    for _func_ref, interval_minutes, jid, _name in get_job_definitions():
        if jid == job_id:
            return interval_minutes
    return None


def _register_billing_jobs(scheduler: BackgroundScheduler) -> None:
    """Register every recurring billing job.

    Each entry is registered in its own try/except: a bad string reference in
    one job must not prevent the other jobs from being registered.
    """
    for func_ref, interval_minutes, job_id, name in get_job_definitions():
        try:
            scheduler.add_job(
                func=_tracked_job_runner,
                args=[func_ref, job_id, name],
                trigger="interval",
                minutes=interval_minutes,
                id=job_id,
                name=name,
                replace_existing=True,
            )
            logger.info("Registered %s (every %d minutes)", name, interval_minutes)
        except Exception as exc:
            logger.error("Failed to register scheduler job %s (%s): %s", job_id, func_ref, exc, exc_info=True)
