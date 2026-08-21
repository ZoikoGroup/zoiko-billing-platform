"""
billing/tasks/recurring_billing.py
-----------------------------------
Automatic recurring billing job.

Runs on a configurable interval (default: every hour).
Processes ALL organisations in a single pass, in bounded batches (see
BATCH_SIZE) rather than loading every due subscription across every
organization into memory at once.
Each subscription is processed independently — failures are isolated.

Idempotency:
  - Invoice number is deterministic: SUB-{subscription_number}-{next_billing_at:YYYYMMDD}
  - Unique constraint (organization_id, invoice_number) at DB level prevents duplicates
  - Concurrent scheduler instances are safe: one wins, others get IntegrityError → skip

Concurrency:
  - APScheduler max_instances=1 prevents same job overlapping
  - Database unique constraint prevents duplicate invoices across app instances

Batching (Phase 4.1 remediation):
  - Due subscriptions are fetched with keyset pagination on Subscription.id
    (WHERE id > last_seen_id ORDER BY id LIMIT BATCH_SIZE), not one
    unbounded `.all()` across every organization.
  - Each batch is grouped by organization_id and processed (and its
    per-subscription commits flushed) before the next batch is fetched, so
    at most BATCH_SIZE subscription rows are held in memory at a time.
  - Keyset pagination on a monotonically increasing primary key guarantees
    each subscription is visited at most once per job run even though
    processing a subscription mutates its own next_billing_at/status: once
    a row's id has been paged past, it is never re-fetched in a later page
    of the same run, regardless of how its own columns change afterward.
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterator, List, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import or_

from app.database import SessionLocal
from app.modules.billing.models import (
    BillingSubscriptionStatus,
    CONTRACT_BLOCKED_STATUSES,
    Contract,
    Subscription,
)
from app.modules.billing.repositories.subscription import SubscriptionRepository

logger = logging.getLogger("zoiko_billing")

SYSTEM_USER_ID = None

# Upper bound on how many Subscription rows are loaded into memory at once.
# Tenant isolation, idempotency, and duplicate prevention are unaffected by
# batch size — they're enforced per-subscription (row lock + unique
# constraint) in SubscriptionService.generate_invoice, not by this loop.
BATCH_SIZE = 500


def _local_today(tz_name: Optional[str]) -> date:
    """Today's date in the organization's configured timezone (fallback UTC)."""
    tz_name = (tz_name or "UTC").strip()
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        logger.warning("[SCHEDULER] Invalid org timezone %r, falling back to UTC", tz_name)
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date()


def run_recurring_billing_job(batch_size: int = BATCH_SIZE) -> Dict[str, Any]:
    """
    Entry point called by APScheduler.

    Processes due subscriptions across ALL organisations, one bounded batch
    at a time (see _iter_due_subscription_batches) instead of loading every
    due subscription into memory up front.
    Returns a summary dict for observability.
    """
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Recurring billing job started (batch_size=%d)", batch_size)

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_processed": 0,
        "total_subscriptions_found": 0,
        "total_processed": 0,
        "total_skipped": 0,
        "total_failed": 0,
        "batches_processed": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        org_tz = _load_org_timezones(db)
        orgs_seen: set = set()

        for batch in _iter_due_subscription_batches(db, org_tz, batch_size):
            summary["batches_processed"] += 1
            summary["total_subscriptions_found"] += len(batch)

            by_org: Dict[int, List[Subscription]] = {}
            for sub in batch:
                by_org.setdefault(sub.organization_id, []).append(sub)

            for org_id, subs in by_org.items():
                orgs_seen.add(org_id)
                org_result = _process_org_subscriptions(db, org_id, subs)
                summary["total_processed"] += org_result["processed"]
                summary["total_skipped"] += org_result["skipped"]
                summary["total_failed"] += org_result["failed"]
                summary["errors"].extend(org_result["errors"])

        summary["organisations_processed"] = len(orgs_seen)

    except Exception as exc:
        logger.error("[SCHEDULER] Fatal error in billing job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)

    logger.info(
        "[SCHEDULER] Billing job completed in %.3fs — "
        "batches=%d, orgs=%d, found=%d, processed=%d, skipped=%d, failed=%d",
        elapsed,
        summary["batches_processed"],
        summary["organisations_processed"],
        summary["total_subscriptions_found"],
        summary["total_processed"],
        summary["total_skipped"],
        summary["total_failed"],
    )
    return summary


def _load_org_timezones(db) -> Dict[int, str]:
    from app.modules.organizations.models import Organization

    return {
        org_id: (tz or "UTC")
        for org_id, tz in db.query(Organization.id, Organization.timezone).all()
    }


def _due_subscriptions_base_query(db, upper_bound: date):
    """Shared eligibility filter for "is this subscription due for
    billing", independent of pagination. Must stay in agreement with
    SubscriptionRepository.list_due_for_billing (used by the manual
    process-billing endpoint) — a subscription must never be selected by
    one path and rejected by the other."""
    return (
        db.query(Subscription)
        .outerjoin(Subscription.contract)
        .filter(
            Subscription.is_active == True,
            Subscription.status == BillingSubscriptionStatus.ACTIVE,
            Subscription.next_billing_at.isnot(None),
            Subscription.next_billing_at <= upper_bound,
            or_(
                Subscription.contract_id.is_(None),
                Contract.status.notin_(CONTRACT_BLOCKED_STATUSES),
            ),
        )
    )


def _iter_due_subscription_batches(
    db, org_tz: Dict[int, str], batch_size: int = BATCH_SIZE
) -> Iterator[List[Subscription]]:
    """
    Yield due subscriptions across ALL organisations in bounded batches,
    instead of one unbounded `.all()` across every organization.

    Query criteria (same as before batching was introduced):
      - is_active = True
      - status = 'active'
      - next_billing_at IS NOT NULL
      - next_billing_at <= today in the ORGANIZATION's timezone

    Timezone safety: "today" is evaluated per organization using the org's
    configured timezone (Organization.timezone), not a global UTC day. To
    avoid a per-org query storm, each page fetches rows up to UTC-today+1
    (the maximum UTC offset is +14, so no due subscription can fall outside
    [utc_today-1, utc_today+1]) and then rows are filtered in Python against
    each org's local date.

    Pagination: keyset pagination on Subscription.id (WHERE id > last_seen_id
    ORDER BY id LIMIT batch_size), not OFFSET-based — offset pagination would
    re-scan and re-skip an ever-growing prefix as batch count grows, and
    would also risk skipping/duplicating rows if a row's own eligibility
    changes mid-run (which happens here: processing a subscription updates
    its own next_billing_at). Keyset-by-id has neither problem: a row is
    fetched at most once per run because id is monotonically increasing and
    never reassigned.

    Eligibility guard: a subscription linked to a CANCELLED/TERMINATED
    contract must never be selected here, even if its own status is still
    ACTIVE — contract and subscription lifecycles are independent (see
    CONTRACT_BLOCKED_STATUSES on the Subscription/Contract models).
    Standalone subscriptions (contract_id IS NULL) are unaffected.
    """
    upper_bound = date.today() + timedelta(days=1)
    last_seen_id = 0

    while True:
        page = (
            _due_subscriptions_base_query(db, upper_bound)
            .filter(Subscription.id > last_seen_id)
            .order_by(Subscription.id)
            .limit(batch_size)
            .all()
        )
        if not page:
            return

        last_seen_id = page[-1].id
        eligible = [
            sub for sub in page
            if sub.next_billing_at <= _local_today(org_tz.get(sub.organization_id))
        ]
        if eligible:
            yield eligible

        if len(page) < batch_size:
            return


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
