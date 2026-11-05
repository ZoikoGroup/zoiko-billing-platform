"""
app/modules/tax/reconciliation_worker.py
----------------------------------------
The dedicated tax provider reconciliation worker (ZB-TAX-ARCH-001 Phase 4d-0).

    python -m app.modules.tax.reconciliation_worker [--once]

A separate process (systemd unit ``zoiko-billing-tax-worker``) that runs only
provider reconciliation and its heartbeat, every
TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS. With
TAX_PROVIDER_RECONCILIATION_MODE=worker the web app schedules nothing; a
stale heartbeat still blocks provider issuing (PROVIDER_UNAVAILABLE), so a
stopped worker fails closed.

Several workers (or a worker plus in-app runs) are safe: outbox rows are
claimed with FOR UPDATE SKIP LOCKED, so each row is worked by one process at
a time and delivered once.

Startup runs the same refusals as the web app (critical columns, the secret
store). SIGTERM/SIGINT finish the current run and exit 0.
"""
import argparse
import logging
import signal
import threading
import time
from typing import Optional

from app.config import settings

logger = logging.getLogger("zoiko_billing.tax.worker")

_stop = threading.Event()


def request_stop(*_args) -> None:
    _stop.set()


def run(once: bool = False, max_runs: Optional[int] = None, run_once=None) -> int:
    """The worker loop; returns the process exit code."""
    from app.database import verify_critical_columns_present
    from app.modules.tax.reconciliation_runner import reconciliation_mode
    from app.modules.tax.reconciliation_runner import run_once as default_run_once
    from app.modules.tax.secret_store import verify_secret_store_at_startup

    run_once = run_once or default_run_once
    verify_critical_columns_present()
    verify_secret_store_at_startup()
    mode = reconciliation_mode()
    if not settings.TAX_PROVIDER_RECONCILIATION_ENABLED:
        logger.warning("Tax provider reconciliation is disabled (TAX_PROVIDER_RECONCILIATION_ENABLED=false); "
                       "the worker exits and provider-taxed invoices cannot be issued.")
        return 0
    if mode != "worker":
        logger.warning("TAX_PROVIDER_RECONCILIATION_MODE=%s: the web app also runs reconciliation. That is safe "
                       "(rows are claimed with SKIP LOCKED) but set it to 'worker' once this unit is running.", mode)
    interval = max(1, int(settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS))
    logger.info("Tax reconciliation worker started (every %ss).", interval)
    runs = 0
    _stop.clear()
    while not _stop.is_set():
        started = time.monotonic()
        try:
            stats = run_once()
            logger.info("Tax reconciliation run: %s", {k: v for k, v in (stats or {}).items() if v})
        except Exception:                                       # the run records its own heartbeat
            logger.exception("Tax reconciliation run failed")
        runs += 1
        if once or (max_runs is not None and runs >= max_runs):
            break
        _stop.wait(max(0.0, interval - (time.monotonic() - started)))
    logger.info("Tax reconciliation worker stopped after %s run(s).", runs)
    return 0


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Tax provider reconciliation worker")
    parser.add_argument("--once", action="store_true", help="run one reconciliation pass and exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, str(settings.LOG_LEVEL).upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    raise SystemExit(run(once=args.once))


if __name__ == "__main__":
    main()
