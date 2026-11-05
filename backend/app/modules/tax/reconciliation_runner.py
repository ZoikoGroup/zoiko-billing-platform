"""
app/modules/tax/reconciliation_runner.py
----------------------------------------
Provider reconciliation job (ZB-TAX-ARCH-001 Phase 4a-1). It has its own
registration and flag (TAX_PROVIDER_RECONCILIATION_ENABLED) and does NOT
depend on ENABLE_RECURRING_BILLING_SCHEDULER: without reconciliation,
provider-taxed invoices cannot be issued safely, so every run writes a
heartbeat and a stale heartbeat blocks provider issuing (PROVIDER_UNAVAILABLE).

Phase 4d-0: TAX_PROVIDER_RECONCILIATION_MODE chooses where it runs.
``worker`` — the dedicated process (app.modules.tax.reconciliation_worker,
systemd unit zoiko-billing-tax-worker) runs it and the web app schedules
nothing. ``in_app`` — this in-process scheduler runs it. In both modes a
stale heartbeat blocks provider issuing. Several processes may run it at
once: rows are claimed with FOR UPDATE SKIP LOCKED.
"""
import logging
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings

logger = logging.getLogger("zoiko_billing.tax.provider")

JOB_ID = "tax_provider_reconciliation"
MODES = ("worker", "in_app")
_scheduler: Optional[BackgroundScheduler] = None


def reconciliation_mode() -> str:
    mode = (getattr(settings, "TAX_PROVIDER_RECONCILIATION_MODE", "") or "in_app").strip().lower()
    if mode not in MODES:
        raise SystemExit(f"TAX_PROVIDER_RECONCILIATION_MODE must be one of {', '.join(MODES)}, not {mode!r}.")
    return mode


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
    if reconciliation_mode() == "worker":
        logger.info("Tax provider reconciliation runs in the dedicated worker (zoiko-billing-tax-worker); "
                    "the web app does not schedule it.")
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
