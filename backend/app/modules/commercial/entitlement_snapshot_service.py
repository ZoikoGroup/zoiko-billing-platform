"""
modules/commercial/entitlement_snapshot_service.py
------------------------------------------------------
ZB-COM-ENT-001 Part 2, §11.1/§13 — maintains the materialized
EntitlementSnapshot cache. Recomputation is synchronous, inside the
caller's transaction, triggered from CommercialSubscriptionService at the
points a subscription's entitlements could have changed (create, transition,
provisioning) and from CommercialOverrideService when an override is
approved/revoked. Never commits — the caller's transaction owns atomicity,
same convention as every other service in this module.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import EntitlementSnapshot


class EntitlementSnapshotService:
    def __init__(self, db: Session):
        self.db = db

    def get_snapshot(self, organization_id: int) -> EntitlementSnapshot | None:
        return (
            self.db.query(EntitlementSnapshot)
            .filter(EntitlementSnapshot.organization_id == organization_id)
            .first()
        )

    def recompute_snapshot(self, organization_id: int, *, reason: str) -> EntitlementSnapshot:
        from app.modules.commercial.entitlement_resolver import resolve_open_subscription

        snapshot = self.get_snapshot(organization_id)
        if snapshot is None:
            snapshot = EntitlementSnapshot(organization_id=organization_id, values={})
            self.db.add(snapshot)

        subscription = resolve_open_subscription(self.db, organization_id)

        if subscription is None:
            snapshot.commercial_subscription_id = None
            snapshot.values = {}
        elif subscription.status == CommercialSubscriptionStatus.TRIALING:
            snapshot.commercial_subscription_id = subscription.id
            snapshot.values = self._values_from_trial_grant(subscription)
        else:
            snapshot.commercial_subscription_id = subscription.id
            snapshot.values = self._values_from_plan_entitlements(subscription)

        snapshot.computed_at = datetime.utcnow()
        snapshot.computed_reason = reason
        # ZB-COM-ENT-001 Part 3 (AC-03) — bumped on every recompute, so a
        # caller can assert "exactly one recompute happened" across a
        # transaction (e.g. a plan-change commit) without relying on
        # computed_at's timestamp resolution.
        snapshot.snapshot_version = (snapshot.snapshot_version or 0) + 1
        self.db.flush()
        return snapshot

    @staticmethod
    def _values_from_trial_grant(subscription) -> dict:
        grants = subscription.trial_granted_entitlements
        if not isinstance(grants, list):
            return {}
        values = {}
        for grant in grants:
            if not isinstance(grant, dict) or "key" not in grant:
                continue
            values[grant["key"]] = {
                "value": grant.get("value"),
                "value_type": grant.get("value_type"),
                "is_contracted": False,
                "source": "trial_grant",
            }
        return values

    def _values_from_plan_entitlements(self, subscription) -> dict:
        from app.modules.commercial.cache import get_latest_published_version_id
        from app.modules.commercial.models import (
            EntitlementDefinition,
            PlanEntitlement,
        )

        version_id = subscription.catalog_version_id
        if version_id is None and subscription.commercial_plan_id is not None:
            version_id = get_latest_published_version_id(self.db, subscription.commercial_plan_id)

        if version_id is None:
            return {}

        rows = (
            self.db.query(PlanEntitlement, EntitlementDefinition)
            .join(
                EntitlementDefinition,
                PlanEntitlement.entitlement_definition_id == EntitlementDefinition.id,
            )
            .filter(PlanEntitlement.plan_version_id == version_id)
            .all()
        )
        values = {}
        for pe, ed in rows:
            values[ed.key] = {
                "value": pe.value,
                "value_type": ed.value_type.value if hasattr(ed.value_type, "value") else ed.value_type,
                "is_contracted": pe.is_contracted,
                "source": "plan_entitlement",
            }
        return values
