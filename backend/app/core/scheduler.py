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
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.executors.pool import ThreadPoolExecutor

logger = logging.getLogger("zoiko_billing")

_scheduler: BackgroundScheduler | None = None


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


def _register_billing_jobs(scheduler: BackgroundScheduler) -> None:
    """Register every recurring billing job.

    Each entry is registered in its own try/except: a bad string reference in
    one job must not prevent the other jobs from being registered.
    """
    from app.config import settings

    jobs = [
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
    ]

    for func_ref, interval_minutes, job_id, name in jobs:
        try:
            scheduler.add_job(
                func=func_ref,
                trigger="interval",
                minutes=interval_minutes,
                id=job_id,
                name=name,
                replace_existing=True,
            )
            logger.info("Registered %s (every %d minutes)", name, interval_minutes)
        except Exception as exc:
            logger.error("Failed to register scheduler job %s (%s): %s", job_id, func_ref, exc, exc_info=True)
