"""
modules/commercial/dunning_service.py
----------------------------------------
N1: Zoiko's own subscription (Plane 1) failed-payment schedule.

Schedule (days since CommercialSubscription.payment_failed_at was set):
    day 0  -> PAST_DUE    (no functional restriction yet)
    day 10 -> RESTRICTED  (blocks new paid expansion only)
    day 20 -> SUSPENDED   (read-only; N2 — never deletes records)
    day 45 -> CANCELLED   ("terminate"; still never a hard delete, per N2)

This is completely independent of billing/services/dunning_service.py
(Plane 2, tenant-to-customer dunning) — N4 explicitly prohibits any event
path from a tenant payment failure into this service, and this module must
never import from billing/services/dunning_service.py or
billing/services/payment_service.py.

Like the other commercial/ services, this service does not commit — the
caller (the scheduled task) owns the transaction.
"""

import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialSubscription
from app.modules.commercial.service import CommercialSubscriptionService

logger = logging.getLogger("zoiko_billing.commercial.dunning")

RESTRICT_AFTER_DAYS = 10
SUSPEND_AFTER_DAYS = 20
TERMINATE_AFTER_DAYS = 45

_SWEEPABLE_STATUSES = {
    CommercialSubscriptionStatus.ACTIVE,
    CommercialSubscriptionStatus.PAST_DUE,
    CommercialSubscriptionStatus.RESTRICTED,
    CommercialSubscriptionStatus.SUSPENDED,
}

# Ordered N1 schedule. The state machine (CommercialSubscriptionService.
# _TRANSITIONS) only allows moving one step at a time (e.g. ACTIVE cannot
# jump straight to RESTRICTED) — so a subscription that missed one or more
# sweeps (job was down, or this is its first run at day 20+) must walk
# forward through each intermediate status in the same pass, not attempt a
# single direct hop to the day-appropriate status.
_SCHEDULE = [
    (0, CommercialSubscriptionStatus.PAST_DUE),
    (RESTRICT_AFTER_DAYS, CommercialSubscriptionStatus.RESTRICTED),
    (SUSPEND_AFTER_DAYS, CommercialSubscriptionStatus.SUSPENDED),
    (TERMINATE_AFTER_DAYS, CommercialSubscriptionStatus.CANCELLED),
]


class CommercialDunningService:
    def __init__(self, db: Session):
        self.db = db
        self.subscription_service = CommercialSubscriptionService(db)

    def _log(self, subscription: CommercialSubscription, old_status: str, new_status: str, reason: str) -> None:
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=None,
            actor_role="system",
            action=PlatformAuditAction.UPDATE,
            entity_type="CommercialSubscription",
            entity_id=subscription.id,
            old_values={"status": old_status},
            new_values={"status": new_status},
            metadata={"reason": reason},
        )

    def sweep(self, db: Session) -> dict:
        """Advance every subscription with an open payment failure through
        the N1 schedule. Returns a summary dict for observability.

        Each subscription is evaluated independently under its own
        try/except so one bad row can't abort the sweep for the rest.
        """
        summary = {"checked": 0, "past_due": 0, "restricted": 0, "suspended": 0, "terminated": 0, "errors": []}

        candidates = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status.in_(list(_SWEEPABLE_STATUSES)),
                CommercialSubscription.payment_failed_at.isnot(None),
            )
            .all()
        )
        summary["checked"] = len(candidates)

        for subscription in candidates:
            try:
                days = (datetime.utcnow() - subscription.payment_failed_at).days

                # Determine the schedule step this subscription should be at
                # today, then walk forward through every intermediate status
                # between where it is now and that target — never a single
                # direct hop, since the state machine forbids skipping steps.
                target_status = None
                for threshold, status in _SCHEDULE:
                    if days >= threshold:
                        target_status = status

                if target_status is None:
                    continue

                target_index = next(i for i, (_, s) in enumerate(_SCHEDULE) if s == target_status)
                while subscription.status != target_status:
                    current_index = next(
                        (i for i, (_, s) in enumerate(_SCHEDULE) if s == subscription.status), -1,
                    )
                    if current_index >= target_index:
                        break  # already past the target on the schedule (e.g. manually restored higher) — leave it
                    next_status = _SCHEDULE[current_index + 1][1]
                    old_status = subscription.status
                    self.subscription_service.transition(subscription, next_status)
                    self._log(subscription, old_status.value, next_status.value, f"N1: {days}d past due")

                    if next_status == CommercialSubscriptionStatus.PAST_DUE:
                        summary["past_due"] += 1
                    elif next_status == CommercialSubscriptionStatus.RESTRICTED:
                        summary["restricted"] += 1
                    elif next_status == CommercialSubscriptionStatus.SUSPENDED:
                        summary["suspended"] += 1
                    elif next_status == CommercialSubscriptionStatus.CANCELLED:
                        summary["terminated"] += 1
            except Exception as exc:
                summary["errors"].append(f"subscription {subscription.id}: {exc}")
                logger.error(
                    "[N1] Dunning sweep failed for subscription %s: %s",
                    subscription.id, exc, exc_info=True,
                )
                db.rollback()

        return summary

    def restore(self, subscription: CommercialSubscription) -> CommercialSubscription:
        """N3: payment succeeds again — restore to ACTIVE from any of
        PAST_DUE/RESTRICTED/SUSPENDED and clear payment_failed_at. Logged
        (not silent), per N3's explicit instruction."""
        old_status = subscription.status
        self.subscription_service.transition(subscription, CommercialSubscriptionStatus.ACTIVE)
        subscription.payment_failed_at = None
        self.db.flush()
        self._log(subscription, old_status.value, CommercialSubscriptionStatus.ACTIVE.value,
                   "N3: payment succeeded, restored to active")
        logger.info("[N3] CommercialSubscription %s restored to ACTIVE", subscription.id)
        return subscription
