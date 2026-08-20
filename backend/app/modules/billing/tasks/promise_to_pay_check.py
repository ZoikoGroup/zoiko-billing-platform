"""
billing/tasks/promise_to_pay_check.py
----------------------------------------
Automatic promise-to-pay status detection job.

Re-checks every still-open (PENDING/OVERDUE) promise-to-pay against its
linked invoice's live balance and against today's date, transitioning it to
FULFILLED (invoice paid), OVERDUE (promise date passed, still in the grace
window), or BROKEN (grace window elapsed) as appropriate — reusing
PromiseToPayService.process_promise_to_pay, not reimplementing the detection
logic here.

Runs on a configurable interval (default: daily), mirroring
tasks/dunning_process.py. Each organisation is processed independently —
failures are isolated.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal
from app.modules.billing.repositories.settings import BillingConfigurationRepository

logger = logging.getLogger("zoiko_billing")


def run_promise_to_pay_check_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for observability."""
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Promise-to-pay check job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_checked": 0,
        "total_transitions": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        from app.modules.billing.models import Organization
        from app.modules.billing.services.promise_to_pay_service import PromiseToPayService

        org_ids = [row[0] for row in db.query(Organization.id).all()]
        summary["organisations_checked"] = len(org_ids)
        config_repo = BillingConfigurationRepository(db)

        for org_id in org_ids:
            try:
                config = config_repo.get_by_organization(org_id)
                grace_days = getattr(config, "grace_days", 0) or 0 if config else 0
                svc = PromiseToPayService(db)
                results = svc.process_promise_to_pay(org_id, grace_days=grace_days)
                if results:
                    summary["total_transitions"] += len(results)
                    logger.info("[SCHEDULER] Org %d: %d promise-to-pay transitions", org_id, len(results))
            except Exception as exc:
                error_msg = f"Org {org_id}: {exc}"
                summary["errors"].append(error_msg)
                logger.error("[SCHEDULER] Promise-to-pay check failed for org %d: %s", org_id, exc, exc_info=True)
                try:
                    db.rollback()
                except Exception:
                    pass

    except Exception as exc:
        logger.error("[SCHEDULER] Fatal error in promise-to-pay check job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Promise-to-pay check job completed in %.3fs — orgs=%d, transitions=%d, errors=%d",
        elapsed, summary["organisations_checked"], summary["total_transitions"], len(summary["errors"]),
    )
    return summary
