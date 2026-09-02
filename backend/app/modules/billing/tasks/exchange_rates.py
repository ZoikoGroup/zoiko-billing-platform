"""
billing/tasks/exchange_rates.py
-------------------------------
Background job that refreshes stale live exchange rates for organizations.

WHY THIS IS A BACKGROUND JOB (not an inline request-path call): fetching rates
from open.er-api.com is a synchronous third-party HTTP call with a 10s timeout.
Doing it inside a dashboard/balance request (the old `_build_currency_rates`
inline refresh) meant a slow or unreachable FX API added latency to every page
load that touched currency data. The request path now only *reads* cached
rates; this job keeps them fresh on a fixed schedule instead.

Tradeoff: rates can be up to one refresh-interval stale rather than refreshed
"on demand". For a billing dashboard this is fine — FX rates move fractions of
a percent per hour and the platform already treated 24h as acceptable
(EXCHANGE_RATE_MAX_AGE_HOURS). We refresh on a conservative interval (default
60 minutes) and only for organizations that have opted into auto-refresh and
whose cached rates are actually stale.

Session ownership: this job opens its OWN SessionLocal and owns its
transaction. ExchangeRateService.refresh_rates writes through a savepoint
(begin_nested) and never commits/rolls back a session it is only handed — so
the job is responsible for the final commit, exactly as it would be for any
writer it uses a fresh session for.
"""

import logging
import time
from datetime import datetime
from typing import Dict, List

from app.database import SessionLocal
from app.modules.billing.models import BillingConfiguration
from app.modules.billing.services.exchange_rate_service import ExchangeRateService

logger = logging.getLogger("zoiko_billing")


def _collect_stale_configs(db) -> List[BillingConfiguration]:
    """Return every BillingConfiguration whose cached rates are stale AND that
    has auto-refresh enabled. Loads the config rows (bounded: one per org) and
    re-checks staleness through the service so the decision and the write use
    the same definition (EXCHANGE_RATE_MAX_AGE_HOURS)."""
    stale = []
    for config in db.query(BillingConfiguration).all():
        if not getattr(config, "exchange_rate_auto_refresh", False):
            continue
        try:
            svc = ExchangeRateService(db)
            if svc.is_rate_stale(config.organization_id, config=config):
                stale.append(config)
        except Exception as exc:  # noqa: BLE001 - one bad org must not abort the sweep
            logger.warning(
                "[SCHEDULER] Skipping exchange-rate staleness check for org %s: %s",
                config.organization_id, exc,
            )
    return stale


def run_exchange_rate_refresh_job() -> Dict[str, str]:
    """Entry point called by APScheduler. Refreshes stale cached exchange rates
    for auto-refresh-enabled organizations. Fails per-org, never wholesale."""
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Exchange-rate refresh job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_checked": 0,
        "organisations_refreshed": 0,
        "organisations_failed": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        stale_configs = _collect_stale_configs(db)
        summary["organisations_checked"] = len(stale_configs)
        svc = ExchangeRateService(db)
        for config in stale_configs:
            org_id = config.organization_id
            try:
                svc.refresh_rates(org_id)  # savepoint-scoped write
                db.commit()                # job owns its session -> commit here
                summary["organisations_refreshed"] += 1
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                summary["organisations_failed"] += 1
                summary["errors"].append(f"org={org_id}: {exc}")
                logger.warning(
                    "[SCHEDULER] Exchange-rate refresh failed for org %s: %s",
                    org_id, exc,
                )
    except Exception as exc:  # noqa: BLE001
        logger.error("[SCHEDULER] Fatal error in exchange-rate job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Exchange-rate job completed in %.3fs | checked=%s refreshed=%s failed=%s",
        elapsed,
        summary["organisations_checked"],
        summary["organisations_refreshed"],
        summary["organisations_failed"],
    )
    return summary
