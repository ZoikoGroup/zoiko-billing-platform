"""
billing/tasks/recurring_billing.py
-----------------------------------
Automatic recurring billing job.

Runs on a configurable interval (default: every hour).
Processes ALL organisations in a single pass.
Each subscription is processed independently — failures are isolated.

Idempotency:
  - Invoice number is deterministic: SUB-{subscription_number}-{next_billing_at:YYYYMMDD}
  - Unique constraint (organization_id, invoice_number) at DB level prevents duplicates
  - Concurrent scheduler instances are safe: one wins, others get IntegrityError → skip

Concurrency:
  - APScheduler max_instances=1 prevents same job overlapping
  - Database unique constraint prevents duplicate invoices across app instances
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.database import SessionLocal
from app.modules.billing.models import (
    BillingSubscriptionStatus,
    Subscription,
)
from app.modules.billing.repositories.subscription import SubscriptionRepository

logger = logging.getLogger("zoiko")

SYSTEM_USER_ID = None


def _local_today(tz_name: Optional[str]) -> date:
    """Today's date in the organization's configured timezone (fallback UTC)."""
    tz_name = (tz_name or "UTC").strip()
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        logger.warning("[SCHEDULER] Invalid org timezone %r, falling back to UTC", tz_name)
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date()


def run_recurring_billing_job() -> Dict[str, Any]:
    """
    Entry point called by APScheduler.

    Processes due subscriptions across ALL organisations.
    Returns a summary dict for observability.
    """
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Recurring billing job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_processed": 0,
        "total_subscriptions_found": 0,
        "total_processed": 0,
        "total_skipped": 0,
        "total_failed": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        due_subs_by_org = _find_all_due_subscriptions(db)
        summary["organisations_processed"] = len(due_subs_by_org)
        summary["total_subscriptions_found"] = sum(
            len(subs) for subs in due_subs_by_org.values()
        )

        for org_id, subs in due_subs_by_org.items():
            org_result = _process_org_subscriptions(db, org_id, subs)
            summary["total_processed"] += org_result["processed"]
            summary["total_skipped"] += org_result["skipped"]
            summary["total_failed"] += org_result["failed"]
            summary["errors"].extend(org_result["errors"])

    except Exception as exc:
        logger.error("[SCHEDULER] Fatal error in billing job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)

    logger.info(
        "[SCHEDULER] Billing job completed in %.3fs — "
        "orgs=%d, found=%d, processed=%d, skipped=%d, failed=%d",
        elapsed,
        summary["organisations_processed"],
        summary["total_subscriptions_found"],
        summary["total_processed"],
        summary["total_skipped"],
        summary["total_failed"],
    )
    return summary


def _find_all_due_subscriptions(db) -> Dict[int, List[Subscription]]:
    """
    Find all subscriptions due for billing across ALL organisations.

    Query criteria:
      - is_active = True
      - status = 'active'
      - next_billing_at IS NOT NULL
      - next_billing_at <= today in the ORGANIZATION's timezone

    Timezone safety: "today" is evaluated per organization using the org's
    configured timezone (Organization.timezone), not a global UTC day. To avoid
    a per-org query storm, one broad query fetches rows up to UTC-today+1
    (the maximum UTC offset is +14, so no due subscription can fall outside
    [utc_today-1, utc_today+1]) and then rows are filtered in Python against
    each org's local date.

    Returns dict keyed by organization_id.
    """
    from app.modules.organizations.models import Organization

    org_tz: Dict[int, str] = {}
    for org_id, tz in db.query(Organization.id, Organization.timezone).all():
        org_tz[org_id] = tz or "UTC"

    # Upper bound: local date in any timezone is at most utc_today + 1.
    upper_bound = date.today() + timedelta(days=1)
    rows = (
        db.query(Subscription)
        .filter(
            Subscription.is_active == True,
            Subscription.status == BillingSubscriptionStatus.ACTIVE,
            Subscription.next_billing_at.isnot(None),
            Subscription.next_billing_at <= upper_bound,
        )
        .all()
    )

    by_org: Dict[int, List[Subscription]] = {}
    for sub in rows:
        local_today = _local_today(org_tz.get(sub.organization_id))
        if sub.next_billing_at <= local_today:
            by_org.setdefault(sub.organization_id, []).append(sub)
    return by_org


def _process_org_subscriptions(
    db, organization_id: int, subs: List[Subscription]
) -> Dict[str, Any]:
    """
    Process all due subscriptions for one organisation.

    Each subscription is processed independently.
    Failures are caught and logged — they do NOT stop other subscriptions.
    """
    from app.modules.billing.services.subscription_service import SubscriptionService

    result = {"processed": 0, "skipped": 0, "failed": 0, "errors": []}

    for sub in subs:
        try:
            svc = SubscriptionService(db)
            billing_result = svc.generate_invoice(
                sub_id=sub.id,
                organization_id=organization_id,
                created_by=SYSTEM_USER_ID,
            )
            if billing_result.get("skipped"):
                result["skipped"] += 1
                logger.info(
                    "[SCHEDULER] Skipped sub %s (org %d): %s",
                    sub.subscription_number, organization_id,
                    billing_result.get("reason", "already billed"),
                )
            else:
                result["processed"] += 1
                logger.info(
                    "[SCHEDULER] Generated invoice for sub %s (org %d): invoice_id=%s, amount=%s %s",
                    sub.subscription_number, organization_id,
                    billing_result.get("invoice_id"),
                    billing_result.get("amount"),
                    billing_result.get("currency"),
                )
        except Exception as exc:
            result["failed"] += 1
            error_msg = f"Sub {sub.id} (org {organization_id}): {exc}"
            result["errors"].append(error_msg)
            logger.error(
                "[SCHEDULER] Failed to process subscription %d (org %d): %s",
                sub.id, organization_id, exc,
                exc_info=True,
            )
            try:
                db.rollback()
            except Exception:
                pass

    return result


def process_single_subscription(
    db, subscription_id: int, organization_id: int
) -> Dict[str, Any]:
    """
    Process a single subscription. Used by manual admin trigger.

    Returns the result dict from generate_invoice.
    """
    from app.modules.billing.services.subscription_service import SubscriptionService

    svc = SubscriptionService(db)
    return svc.generate_invoice(
        sub_id=subscription_id,
        organization_id=organization_id,
        created_by=SYSTEM_USER_ID,
    )
