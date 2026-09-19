"""
commercial/tasks/trial_expiry.py
-----------------------------------
Plane 1 — free-trial expiry sweep (§B3). provision_default_subscription()
grants every eligible new CommercialSubscription a trial_ends_at deadline —
from an is_active=True CommercialEvaluationProgram's duration_days when one
exists for its plan, otherwise from settings.COMMERCIAL_DEFAULT_TRIAL_DAYS
(one standard trial per org, per §5). If a trial expires unpaid, this job
acts according to the subscription's snapshotted evaluation_expiry_action:
  - SUSPEND (default)   — transition to TRIAL_RECOVERY (§5). The org keeps
                           read/export access for a 14-day recovery window
                           (recovery_ends_at = trial_ends_at + 14 days, set by
                           start_trial_if_eligible), and may still self-serve
                           convert to a paid plan. Full suspension happens only
                           after the window passes — commercial/tasks/
                           recovery_window_expiry.py moves TRIAL_RECOVERY ->
                           SUSPENDED, after which require_active_subscription
                           blocks /billing/* access until a super admin
                           reactivates it (PATCH .../status) or the org pays.
                           The trial-expired email sent here must describe the
                           recovery window, not an immediate lockout.
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
from datetime import datetime, timedelta
from typing import Any, Dict

from app.database import SessionLocal
from app.services.email_service import send_trial_expired_email

logger = logging.getLogger("zoiko_billing.commercial.trial_expiry")


def run_commercial_trial_expiry_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for
    observability."""
    from app.config import settings

    start_time = time.monotonic()
    summary: Dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "recovery": 0,
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

        # §5: an expired trial that is already in its recovery window (or a
        # legacy row that somehow skipped it) must not be re-swept on every
        # run — only PENDING/TRIALING rows whose trial_ends_at is past are
        # this job's entry point. TRIAL_RECOVERY -> SUSPENDED belongs to
        # commercial/tasks/recovery_window_expiry.py.
        expired = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status.in_([
                    CommercialSubscriptionStatus.PENDING,
                    CommercialSubscriptionStatus.TRIALING,
                ]),
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

                # §5: transition to TRIAL_RECOVERY, NOT directly to SUSPENDED.
                # The subscription has its 14-day recovery window (recovery_
                # ends_at) to be read/export-only and to still self-convert.
                # Guarantee recovery_ends_at is set even for rows created
                # before the column existed.
                if subscription.recovery_ends_at is None and subscription.trial_ends_at is not None:
                    subscription.recovery_ends_at = subscription.trial_ends_at + timedelta(days=14)
                sub_svc.transition(subscription, CommercialSubscriptionStatus.TRIAL_RECOVERY)
                audit.log_no_commit(
                    actor_id=None,
                    action=PlatformAuditAction.UPDATE,
                    entity_type="commercial_subscription",
                    entity_id=subscription.id,
                    new_values={
                        "status": "trial_recovery",
                        "reason": "trial_expired",
                        "recovery_ends_at": subscription.recovery_ends_at.isoformat() if subscription.recovery_ends_at else None,
                    },
                    reason="Free-trial period ended with no payment; entering 14-day §5 recovery window.",
                )
                db.commit()
                summary["recovery"] += 1
                logger.info(
                    "Moved subscription %s into TRIAL_RECOVERY — trial expired (trial_ends_at=%s, recovery_ends_at=%s).",
                    subscription.id, subscription.trial_ends_at, subscription.recovery_ends_at,
                )

                # Send ZB-COM-004: Trial Expired Notification — copy describes
                # the 14-day recovery window per §5.
                try:
                    from app.modules.auth.models import User
                    from app.modules.commercial.models import CommercialAccount
                    from app.services.email_service import send_trial_expired_email

                    acct = db.query(CommercialAccount).filter(CommercialAccount.id == subscription.commercial_account_id).first()
                    if acct and acct.organization_id:
                        org_id = acct.organization_id
                        org_name = getattr(acct.organization, "name", "Your Organization")
                        admin_user = db.query(User).filter(User.organization_id == org_id, User.is_active == True).first()
                        if admin_user and admin_user.email:
                            send_trial_expired_email(
                                email=admin_user.email,
                                recipient_first_name=admin_user.first_name or "there",
                                organization_name=org_name,
                                organization_id=org_id,
                                db=db,
                            )
                except Exception as mail_exc:
                    logger.warning("Failed to dispatch trial expired email for subscription %s: %s", subscription.id, mail_exc)
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
