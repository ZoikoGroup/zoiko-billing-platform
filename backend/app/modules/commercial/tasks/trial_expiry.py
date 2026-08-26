"""
commercial/tasks/trial_expiry.py
-----------------------------------
Plane 1 — free-trial expiry sweep (§B3). A self-serve CommercialSubscription
only ever gets a trial_ends_at deadline when provision_default_subscription()
finds an is_active=True CommercialEvaluationProgram for its plan — no program,
no trial, by default. If a trial expires unpaid, this job acts according to
the subscription's snapshotted evaluation_expiry_action:
  - SUSPEND (default)   — transition to SUSPENDED; require_active_subscription
                           then blocks /billing/* access until a super admin
                           reactivates it (PATCH .../status) or the org pays.
  - DOWNGRADE            — NOT implemented (no downgrade-target plan exists
                           anywhere in the schema yet); skipped and logged,
                           never silently suspended instead.
evaluation_conversion_policy == AUTO_CHARGE_ON_EXPIRY is also NOT
implemented — skipped and logged, never silently treated as MANUAL/SUSPEND.

Entirely independent of the N1 payment-failure dunning sweep (commercial/
dunning_service.py) — that path only ever applies to a subscription that was
ACTIVE and then failed payment; a subscription that was never activated
never enters that state machine branch at all.

No-ops unless settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT is explicitly
true.
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
        "skipped_auto_charge_unimplemented": 0,
        "skipped_downgrade_unimplemented": 0,
        "errors": [],
    }

    if not settings.ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT:
        summary["skipped"] = "ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT is false"
        return summary

    logger.info("[SCHEDULER] Commercial (Plane-1) trial expiry sweep started")

    db = SessionLocal()
    try:
        from app.modules.commercial.enums import (
            CommercialEvaluationConversionPolicy,
            CommercialEvaluationExpiryAction,
            CommercialSubscriptionStatus,
        )
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
                # AUTO_CHARGE_ON_EXPIRY is NOT implemented — a subscription
                # configured this way must never be silently treated as
                # MANUAL/SUSPEND. Skip it, loudly, every sweep, until a real
                # charge-attempt path exists.
                if subscription.evaluation_conversion_policy == CommercialEvaluationConversionPolicy.AUTO_CHARGE_ON_EXPIRY:
                    summary["skipped_auto_charge_unimplemented"] += 1
                    logger.warning(
                        "Subscription %s trial expired with conversion_policy=AUTO_CHARGE_ON_EXPIRY, "
                        "which trial_expiry.py does not yet implement — left untouched (NOT suspended).",
                        subscription.id,
                    )
                    continue

                action = subscription.evaluation_expiry_action or CommercialEvaluationExpiryAction.SUSPEND

                if action == CommercialEvaluationExpiryAction.DOWNGRADE:
                    # No downgrade-target plan is captured anywhere in the
                    # current schema (CommercialEvaluationProgram carries no
                    # target plan reference) — implementing this would mean
                    # guessing a plan. Skip, loudly, rather than guess or
                    # silently suspend instead.
                    summary["skipped_downgrade_unimplemented"] += 1
                    logger.warning(
                        "Subscription %s trial expired with expiry_action=DOWNGRADE, which "
                        "trial_expiry.py does not yet implement (no downgrade-target plan in the "
                        "schema) — left untouched (NOT suspended).",
                        subscription.id,
                    )
                    continue

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
                    "Failed to process subscription %s on trial expiry: %s",
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
