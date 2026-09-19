"""
backend/app/modules/commercial/tasks/trial_warning.py
-------------------------------------------------------
Scheduled job for ZB-COM-003: Commercial trial ending soon warning.

Proactively notifies organization administrators when their trial period is
settings.TRIAL_WARNING_LEAD_DAYS days away from expiring.
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict

from app.config import settings
from app.database import SessionLocal
from app.modules.auth.models import User
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.services.email_service import send_trial_ending_warning_email

logger = logging.getLogger("zoiko_billing.commercial.trial_warning")


def run_commercial_trial_warning_job() -> Dict[str, Any]:
    """Entry point called by APScheduler for ZB-COM-003 trial ending warnings.

    Queries commercial subscriptions whose trial ends in settings.TRIAL_WARNING_LEAD_DAYS days.
    """
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Commercial trial ending warning job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "subscriptions_checked": 0,
        "warnings_sent": 0,
        "errors": [],
    }

    if not settings.ENABLE_TRIAL_WARNING_JOB:
        logger.info("[SCHEDULER] Commercial trial warning job is disabled in settings")
        summary["duration_seconds"] = round(time.monotonic() - start_time, 3)
        return summary

    db = SessionLocal()
    try:
        lead_days = settings.TRIAL_WARNING_LEAD_DAYS
        target_date = datetime.utcnow().date() + timedelta(days=lead_days)

        # Query subscriptions whose trial_ends_at falls on target_date
        subs = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status.in_([
                    CommercialSubscriptionStatus.PENDING,
                    CommercialSubscriptionStatus.TRIALING,
                ]),
                CommercialSubscription.trial_ends_at.isnot(None),
            )
            .all()
        )

        matching_subs = [
            s for s in subs
            if s.trial_ends_at and s.trial_ends_at.date() == target_date
        ]

        summary["subscriptions_checked"] = len(matching_subs)

        for sub in matching_subs:
            try:
                account = (
                    db.query(CommercialAccount)
                    .filter(CommercialAccount.id == sub.commercial_account_id)
                    .first()
                )
                if not account or not account.organization_id:
                    continue

                org = account.organization
                org_name = getattr(org, "name", "Your Organization")
                org_id = account.organization_id

                admin_user = (
                    db.query(User)
                    .filter(User.organization_id == org_id, User.is_active == True)
                    .first()
                )
                if not admin_user or not admin_user.email:
                    logger.warning(
                        f"[SCHEDULER] No active admin email found for org #{org_id}; skipping trial warning"
                    )
                    continue

                trial_ends_str = sub.trial_ends_at.strftime("%Y-%m-%d")
                sent = send_trial_ending_warning_email(
                    email=admin_user.email,
                    recipient_first_name=admin_user.first_name or "there",
                    organization_name=org_name,
                    trial_ends_at=trial_ends_str,
                    days_remaining=lead_days,
                    organization_id=org_id,
                    db=db,
                )
                if sent:
                    summary["warnings_sent"] += 1
            except Exception as row_exc:
                db.rollback()
                err_msg = f"Failed to send trial warning for subscription #{sub.id}: {row_exc}"
                logger.exception(err_msg)
                summary["errors"].append(err_msg)

    except Exception as exc:
        err_msg = f"Error in run_commercial_trial_warning_job: {exc}"
        logger.exception(err_msg)
        summary["errors"].append(err_msg)
    finally:
        db.close()

    summary["duration_seconds"] = round(time.monotonic() - start_time, 3)
    logger.info(
        f"[SCHEDULER] Commercial trial ending warning job finished. Sent {summary['warnings_sent']} warnings."
    )
    return summary
