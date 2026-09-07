"""
commercial/tasks/recovery_window_expiry.py
-------------------------------------------
Plane 1 — §5 recovery-window expiry sweep.

trial_expiry.py moves an expired-trial subscription into TRIAL_RECOVERY (not
directly to SUSPENDED) and records recovery_ends_at = trial_ends_at + 14
days. THIS job is the enforcement back-stop for that window: once
recovery_ends_at passes with no conversion, "post-recovery the workspace is
suspended from active use" (§5) becomes real by transitioning the
TRIAL_RECOVERY subscription to SUSPENDED — after which
require_active_subscription blocks /billing/* access until a super admin
reactivates it or the org pays.

The ZB-COM-014 email (commercial.recovery_window_expired) fires exactly once
at this transition — the org is being told the recovery window is over, the
conversion surface is gone, and retention follows the applicable
account/data-retention policy. Requires the same
ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT gate trial_expiry.py uses, so the two
sweeps share a single on/off switch for trial lifecycle enforcement.

Registered in app/core/scheduler.py alongside the trial-expiry sweep.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal

logger = logging.getLogger("zoiko_billing.commercial.recovery_window_expiry")


def run_commercial_recovery_window_expiry_job() -> Dict[str, Any]:
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

    logger.info("[SCHEDULER] Commercial (§5) recovery-window expiry sweep started")

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
                CommercialSubscription.status == CommercialSubscriptionStatus.TRIAL_RECOVERY,
                CommercialSubscription.recovery_ends_at.isnot(None),
                CommercialSubscription.recovery_ends_at <= datetime.utcnow(),
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
                    new_values={"status": "suspended", "reason": "recovery_window_expired"},
                    reason="§5 recovery window ended with no conversion; workspace suspended from active use.",
                )
                db.commit()
                summary["suspended"] += 1
                logger.info(
                    "Suspended subscription %s — recovery window expired (recovery_ends_at=%s) with no conversion.",
                    subscription.id, subscription.recovery_ends_at,
                )

                # Send ZB-COM-014: Recovery Window Expired Notification — fires
                # exactly once, at this TRIAL_RECOVERY -> SUSPENDED transition.
                try:
                    from app.modules.auth.models import User
                    from app.modules.commercial.models import CommercialAccount
                    from app.services.email_service import send_recovery_window_expired_email

                    acct = db.query(CommercialAccount).filter(CommercialAccount.id == subscription.commercial_account_id).first()
                    if acct and acct.organization_id:
                        org_id = acct.organization_id
                        org_name = getattr(acct.organization, "name", "Your Organization")
                        admin_user = db.query(User).filter(User.organization_id == org_id, User.is_active == True).first()
                        if admin_user and admin_user.email:
                            send_recovery_window_expired_email(
                                email=admin_user.email,
                                recipient_first_name=admin_user.first_name or "there",
                                organization_name=org_name,
                                organization_id=org_id,
                                db=db,
                            )
                except Exception as mail_exc:
                    logger.warning(
                        "Failed to dispatch recovery-window-expired email for subscription %s: %s",
                        subscription.id, mail_exc,
                    )
            except Exception as row_exc:  # noqa: BLE001 - one subscription's failure must not block the rest
                db.rollback()
                summary["errors"].append(f"subscription {subscription.id}: {row_exc}")
                logger.error(
                    "Failed to process subscription %s on recovery-window expiry: %s",
                    subscription.id, row_exc, exc_info=True,
                )
    except Exception as exc:
        db.rollback()
        logger.error("[SCHEDULER] Fatal error in commercial recovery-window expiry job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Commercial recovery-window expiry sweep completed in %.3fs — %s",
        elapsed, summary,
    )
    return summary