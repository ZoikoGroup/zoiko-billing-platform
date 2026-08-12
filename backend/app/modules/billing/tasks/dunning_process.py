"""
billing/tasks/dunning_process.py
---------------------------------
Automatic dunning (reminder) processing job.

Processes dunning for overdue invoices across ALL organisations.
Runs on a configurable interval (default: daily), reusing the
existing DunningService.process_dunning() method.

Each organisation is processed independently — failures are isolated.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal
from app.modules.billing.repositories.settings import BillingConfigurationRepository

logger = logging.getLogger("zoiko")


def run_dunning_process_job() -> Dict[str, Any]:
    """
    Entry point called by APScheduler.

    Processes dunning for every organisation that has auto_dunning enabled.
    Returns a summary dict for observability.
    """
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Dunning process job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_processed": 0,
        "organisations_checked": 0,
        "total_actions_taken": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        from app.modules.billing.models import Organization

        org_ids = [row[0] for row in db.query(Organization.id).all()]
        summary["organisations_checked"] = len(org_ids)

        config_repo = BillingConfigurationRepository(db)

        for org_id in org_ids:
            try:
                config = config_repo.get_by_organization(org_id)
                if config and not getattr(config, "auto_dunning", False):
                    continue

                from app.modules.billing.services.dunning_service import DunningService

                svc = DunningService(db)
                results = svc.process_dunning(org_id)
                if results:
                    summary["total_actions_taken"] += len(results)
                    logger.info(
                        "[SCHEDULER] Org %d: %d dunning actions taken",
                        org_id, len(results),
                    )
                summary["organisations_processed"] += 1
            except Exception as exc:
                error_msg = f"Org {org_id}: {exc}"
                summary["errors"].append(error_msg)
                logger.error("[SCHEDULER] Dunning process failed for org %d: %s", org_id, exc, exc_info=True)
                try:
                    db.rollback()
                except Exception:
                    pass

    except Exception as exc:
        logger.error("[SCHEDULER] Fatal error in dunning process job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)

    logger.info(
        "[SCHEDULER] Dunning process job completed in %.3fs — "
        "orgs_checked=%d, processed=%d, actions=%d, errors=%d",
        elapsed,
        summary["organisations_checked"],
        summary["organisations_processed"],
        summary["total_actions_taken"],
        len(summary["errors"]),
    )
    return summary
