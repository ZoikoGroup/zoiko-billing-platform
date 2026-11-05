"""
app/modules/tax/reconciliation_runner.py
----------------------------------------
Provider reconciliation job (ZB-TAX-ARCH-001 Phase 4a-1). It has its own
registration and flag (TAX_PROVIDER_RECONCILIATION_ENABLED) and does NOT
depend on ENABLE_RECURRING_BILLING_SCHEDULER: without reconciliation,
provider-taxed invoices cannot be issued safely, so every run writes a
heartbeat and a stale heartbeat blocks provider issuing (PROVIDER_UNAVAILABLE).

A dedicated worker process replaces this in-process scheduler before any
provider market goes live (4d gate). Several app instances may run it at
once: rows are claimed with FOR UPDATE SKIP LOCKED.
"""
import logging
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings

logger = logging.getLogger("zoiko_billing.tax.provider")

JOB_ID = "tax_provider_reconciliation"
_scheduler: Optional[BackgroundScheduler] = None


def run_once() -> dict:
    from app.database import SessionLocal
    from app.modules.tax.provider_issuance import ProviderIssuanceService

    db = SessionLocal()
    try:
        return ProviderIssuanceService(db).reconcile()
    finally:
        db.close()


def start() -> None:
    global _scheduler
    if not settings.TAX_PROVIDER_RECONCILIATION_ENABLED:
        logger.warning("Tax provider reconciliation is disabled: provider-taxed invoices cannot be issued "
                       "(TAX_PROVIDER_RECONCILIATION_ENABLED=false).")
        return
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(run_once, "interval", seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS,
                       id=JOB_ID, max_instances=1, coalesce=True, replace_existing=True)
    _scheduler.start()
    logger.info("Tax provider reconciliation started (every %ss).", settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS)


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
