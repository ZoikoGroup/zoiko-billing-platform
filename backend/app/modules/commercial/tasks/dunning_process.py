"""
commercial/tasks/dunning_process.py
--------------------------------------
N1: Plane-1 (Zoiko's own subscription) failed-payment dunning job.

Runs CommercialDunningService.sweep() on a configurable interval (default:
daily). Entirely independent of billing/tasks/dunning_process.py (Plane 2,
tenant-to-customer dunning) — see N4.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal

logger = logging.getLogger("zoiko_billing.commercial.dunning")


def run_commercial_dunning_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for
    observability."""
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Commercial (Plane-1) dunning sweep started")

    summary: Dict[str, Any] = {"started_at": datetime.utcnow().isoformat()}

    db = SessionLocal()
    try:
        from app.modules.commercial.dunning_service import CommercialDunningService

        result = CommercialDunningService(db).sweep(db)
        db.commit()
        summary.update(result)
    except Exception as exc:
        db.rollback()
        logger.error("[SCHEDULER] Fatal error in commercial dunning sweep: %s", exc, exc_info=True)
        summary["errors"] = summary.get("errors", []) + [str(exc)]
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Commercial dunning sweep completed in %.3fs — %s",
        elapsed, summary,
    )
    return summary
