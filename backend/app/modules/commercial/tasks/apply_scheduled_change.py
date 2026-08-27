"""
commercial/tasks/apply_scheduled_change.py
-----------------------------------------------
Plane 1 — scheduled plan-change apply sweep (ZB-COM-ENT-001 Part 3, §7-§8).
A downgrade's default path creates a SubscriptionChange row with
status=SCHEDULED and effective_at=subscription.current_period_end, and
transitions the subscription to SCHEDULED_CHANGE (current entitlements stay
resolved off the CURRENT plan the whole time it waits). This job applies
every SCHEDULED row whose effective_at has passed: swaps the subscription's
plan fields, transitions it back to ACTIVE (which recomputes the
EntitlementSnapshot for free via CommercialSubscriptionService.transition),
and marks the SubscriptionChange APPLIED.

If a subscription has drifted out of SCHEDULED_CHANGE by the time its row
comes due (e.g. reversed or otherwise transitioned elsewhere), the row is
marked REVERSED and skipped, loudly — never guessed, same convention
trial_expiry.py uses for its own unimplemented branches.

No-ops unless settings.ENABLE_SCHEDULED_PLAN_CHANGES is explicitly true.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal

logger = logging.getLogger("zoiko_billing.commercial.apply_scheduled_change")


def run_scheduled_plan_change_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for
    observability."""
    from app.config import settings

    start_time = time.monotonic()
    summary: Dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "applied": 0,
        "skipped_subscription_not_scheduled": 0,
        "errors": [],
    }

    if not settings.ENABLE_SCHEDULED_PLAN_CHANGES:
        summary["skipped"] = "ENABLE_SCHEDULED_PLAN_CHANGES is false"
        return summary

    logger.info("[SCHEDULER] Scheduled plan-change apply sweep started")

    db = SessionLocal()
    try:
        from app.modules.commercial.enums import CommercialSubscriptionStatus, SubscriptionChangeStatus
        from app.modules.commercial.models import CommercialPlan, SubscriptionChange
        from app.modules.commercial.service import CommercialSubscriptionService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        sub_svc = CommercialSubscriptionService(db)
        audit = PlatformAuditService(db)

        due = (
            db.query(SubscriptionChange)
            .filter(
                SubscriptionChange.status == SubscriptionChangeStatus.SCHEDULED,
                SubscriptionChange.effective_at.isnot(None),
                SubscriptionChange.effective_at <= datetime.utcnow(),
            )
            .all()
        )

        for change in due:
            try:
                subscription = change.subscription
                if subscription is None or subscription.status != CommercialSubscriptionStatus.SCHEDULED_CHANGE:
                    # Drifted (e.g. reversed or otherwise transitioned by
                    # another path in the meantime) — never guess; record it
                    # and move on.
                    change.status = SubscriptionChangeStatus.REVERSED
                    change.reversed_at = datetime.utcnow()
                    db.commit()
                    summary["skipped_subscription_not_scheduled"] += 1
                    logger.warning(
                        "SubscriptionChange %s is due but subscription %s is not in "
                        "SCHEDULED_CHANGE (status=%s) — marked REVERSED, not applied.",
                        change.id, change.commercial_subscription_id,
                        subscription.status.name if subscription else "MISSING",
                    )
                    continue

                target_plan = db.query(CommercialPlan).filter(CommercialPlan.id == change.to_plan_id).first()
                if target_plan is None:
                    raise ValueError(f"target plan {change.to_plan_id} no longer exists")

                sub_svc._set_plan_fields(subscription, target_plan, change.to_catalog_version_id)
                sub_svc.transition(subscription, CommercialSubscriptionStatus.ACTIVE)

                change.status = SubscriptionChangeStatus.APPLIED
                change.applied_at = datetime.utcnow()
                db.flush()

                account = subscription.account
                audit.log_no_commit(
                    actor_id=None,
                    actor_role="system",
                    action=PlatformAuditAction.SUBSCRIPTION_PLAN_CHANGE_APPLIED,
                    entity_type="SubscriptionChange",
                    entity_id=change.id,
                    organization_id=account.organization_id if account else None,
                    new_values={"to_plan_id": target_plan.id},
                    reason="Scheduled downgrade reached effective_at.",
                )
                db.commit()
                summary["applied"] += 1
                logger.info(
                    "Applied scheduled plan change %s on subscription %s -> plan %s",
                    change.id, subscription.id, target_plan.plan_code,
                )
            except Exception as row_exc:  # noqa: BLE001 - one row's failure must not block the rest
                db.rollback()
                summary["errors"].append(f"subscription_change {change.id}: {row_exc}")
                logger.error(
                    "Failed to apply SubscriptionChange %s: %s",
                    change.id, row_exc, exc_info=True,
                )
    except Exception as exc:
        db.rollback()
        logger.error("[SCHEDULER] Fatal error in scheduled plan-change apply job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Scheduled plan-change apply sweep completed in %.3fs — %s",
        elapsed, summary,
    )
    return summary
