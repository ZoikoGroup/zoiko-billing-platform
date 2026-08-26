"""
commercial/tasks/trial_expiry.py
-----------------------------------
Plane 1 — free-trial expiry sweep. A self-serve CommercialSubscription is
created PENDING with a trial_ends_at deadline (provision_default_
subscription). If it hasn't been paid (transitioned to ACTIVE) by then, this
job suspends it — require_active_subscription then blocks /billing/* access
until a super admin reactivates it (PATCH .../status) or the org pays.

Entirely independent of the N1 payment-failure dunning sweep (commercial/
dunning_service.py) — that path only ever applies to a subscription that was
ACTIVE and then failed payment; a subscription that was never activated
never enters that state machine branch at all.

No-ops unless settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT is explicitly
true — the trial_ends_at deadline is always stamped, but nothing acts on it
until this is turned on.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal

logger = logging.getLogger("zoiko_billing.commercial.trial_expiry")


def run_commercial_trial_expiry_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for
    observability."""
    from app.config import settings

    start_time = time.monotonic()
    summary: Dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "suspended": 0,
        "errors": [],
    }

    if not settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT:
        summary["skipped"] = "ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT is false"
        return summary

    logger.info("[SCHEDULER] Commercial (Plane-1) trial expiry sweep started")

    db = SessionLocal()
    try:
        from app.modules.commercial.enums import CommercialSubscriptionStatus
        from app.modules.commercial.models import CommercialSubscription
        from app.modules.commercial.service import CommercialSubscriptionService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        sub_svc = CommercialSubscriptionService(db)
        audit = PlatformAuditService(db)

        expired = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status == CommercialSubscriptionStatus.PENDING,
                CommercialSubscription.trial_ends_at.isnot(None),
                CommercialSubscription.trial_ends_at <= datetime.utcnow(),
            )
            .all()
        )

        for subscription in expired:
            try:
                sub_svc.transition(subscription, CommercialSubscriptionStatus.SUSPENDED)
                audit.log_no_commit(
                    actor_id=None,
                    action=PlatformAuditAction.UPDATE,
                    entity_type="commercial_subscription",
                    entity_id=subscription.id,
                    new_values={"status": "suspended", "reason": "trial_expired"},
                    reason="Free-trial period ended with no payment.",
                )
                db.commit()
                summary["suspended"] += 1
                logger.info(
                    "Suspended subscription %s — trial expired (trial_ends_at=%s) with no payment.",
                    subscription.id, subscription.trial_ends_at,
                )
            except Exception as row_exc:  # noqa: BLE001 - one subscription's failure must not block the rest
                db.rollback()
                summary["errors"].append(f"subscription {subscription.id}: {row_exc}")
                logger.error(
                    "Failed to suspend subscription %s on trial expiry: %s",
                    subscription.id, row_exc, exc_info=True,
                )
    except Exception as exc:
        db.rollback()
        logger.error("[SCHEDULER] Fatal error in commercial trial expiry job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Commercial trial expiry sweep completed in %.3fs — %s",
        elapsed, summary,
    )
    return summary
