"""
modules/commercial/usage_metering_service.py
-----------------------------------------------
ZB-COM-ENT-001 Part 2, §14 — usage counters for entitlements with no natural
underlying row to count (e.g. api.requests_per_day) or that need a rolling
time window distinct from "count everything ever". Idempotent increments
mirror PlatformStripeEvent's get-or-create-by-unique-id + status-flip
pattern (commercial/models.py PlatformStripeEvent, used by
platform_stripe_service.py) so a retried request never double-counts.

Not used by the 5 routes wired in this pass — routes 2/3 (invoice monthly
limit, org entity max) count already-persisted rows directly (Invoice,
BillingCustomer), which is exact and driftless where a real countable row
exists. UsageCounter is for keys with no such row, or a THROTTLE/
SOFT_THEN_HARD window. Built per spec, not yet exercised by a wired route —
not dead code, forward-looking infrastructure for the next keys wired.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.modules.commercial.models import UsageCounter, UsageIncrementEvent

logger = logging.getLogger("zoiko_billing.commercial.usage_metering")


class UsageMeteringService:
    def __init__(self, db: Session):
        self.db = db

    @staticmethod
    def current_window_key(granularity: str = "monthly") -> str:
        now = datetime.utcnow()
        if granularity == "daily":
            return now.strftime("%Y-%m-%d")
        return now.strftime("%Y-%m")

    def get_or_create_counter(
        self, organization_id: int, entitlement_definition_id: int, *, granularity: str = "monthly",
    ) -> UsageCounter:
        window_key = self.current_window_key(granularity)
        counter = (
            self.db.query(UsageCounter)
            .filter(
                UsageCounter.organization_id == organization_id,
                UsageCounter.entitlement_definition_id == entitlement_definition_id,
                UsageCounter.window_key == window_key,
            )
            .first()
        )
        if counter is None:
            counter = UsageCounter(
                organization_id=organization_id,
                entitlement_definition_id=entitlement_definition_id,
                window_key=window_key,
                count=0,
            )
            self.db.add(counter)
            self.db.flush()
        return counter

    def get_count(
        self, organization_id: int, entitlement_definition_id: int, *, granularity: str = "monthly",
    ) -> int:
        window_key = self.current_window_key(granularity)
        counter = (
            self.db.query(UsageCounter)
            .filter(
                UsageCounter.organization_id == organization_id,
                UsageCounter.entitlement_definition_id == entitlement_definition_id,
                UsageCounter.window_key == window_key,
            )
            .first()
        )
        return counter.count if counter is not None else 0

    def increment(
        self,
        organization_id: int,
        entitlement_definition_id: int,
        *,
        idempotency_key: str,
        granularity: str = "monthly",
        amount: int = 1,
    ) -> UsageCounter:
        """Idempotent increment: a retried call with the same idempotency_key
        is a no-op (mirrors PlatformStripeEvent's re-delivery handling)."""
        existing_event = (
            self.db.query(UsageIncrementEvent)
            .filter(
                UsageIncrementEvent.organization_id == organization_id,
                UsageIncrementEvent.entitlement_definition_id == entitlement_definition_id,
                UsageIncrementEvent.idempotency_key == idempotency_key,
            )
            .first()
        )
        if existing_event is not None and existing_event.status != "failed":
            return self.get_or_create_counter(
                organization_id, entitlement_definition_id, granularity=granularity,
            )

        window_key = self.current_window_key(granularity)
        if existing_event is None:
            existing_event = UsageIncrementEvent(
                organization_id=organization_id,
                entitlement_definition_id=entitlement_definition_id,
                idempotency_key=idempotency_key,
                window_key=window_key,
                amount=amount,
                status="processing",
            )
            self.db.add(existing_event)
        else:
            existing_event.status = "processing"
            existing_event.error = None
        self.db.flush()

        try:
            counter = self.get_or_create_counter(
                organization_id, entitlement_definition_id, granularity=granularity,
            )
            counter.count += amount
            existing_event.status = "processed"
            self.db.flush()
            return counter
        except Exception as exc:  # noqa: BLE001 - mirrors platform_stripe_service's failed-event handling
            existing_event.status = "failed"
            existing_event.error = str(exc)
            self.db.flush()
            logger.exception(
                "UsageMeteringService.increment failed for org=%s definition=%s key=%s",
                organization_id, entitlement_definition_id, idempotency_key,
            )
            raise
