"""
modules/commercial/entitlement_resolver.py
--------------------------------------------
ZB-COM-ENT-001 Part 2, §12.1 — the precedence-ordered entitlement resolution
engine. Given an organization and an entitlement key, walks a fixed,
seven-level precedence chain and returns the first level that resolves:

  L1  Legal/security prohibition      EntitlementDefinition.is_globally_disabled
  L2  Emergency platform safety       BillingKillSwitch(ENTITLEMENT_ENFORCEMENT)
  L3  Approved commercial override    CommercialOverride (APPROVED, unexpired)
  L4  Trial-specific grant            CommercialSubscription.trial_granted_entitlements
  L5  Materialized snapshot           EntitlementSnapshot.values
  L6  Live plan entitlement           PlanEntitlement (defense-in-depth)
  L7  Safe default                    always resolves, denies

Each level is a small, independently testable callable so the order itself
can be pinned down in a test (an override must beat a plan entitlement even
when both exist) rather than relying on prose.

This module never raises for a *resolvable* key — L7 always resolves. It
DOES raise EntitlementKeyNotFoundError for a key with no EntitlementDefinition
row at all, since that is a coding bug (a typo'd key), not a runtime tenant
condition — callers that need a safe-default-on-any-error read (Part D's
fail-open reads) catch this themselves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.modules.commercial.enums import CommercialSubscriptionStatus, EntitlementValueType
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialOverride,
    CommercialOverrideStatus,
    CommercialSubscription,
    EntitlementDefinition,
    EntitlementSnapshot,
    PlanEntitlement,
)


class EntitlementKeyNotFoundError(ValueError):
    """No EntitlementDefinition row exists for the given key — a coding bug
    (typo'd key), not a runtime tenant condition."""


def resolve_open_subscription(db: Session, organization_id: int) -> CommercialSubscription | None:
    """Organization -> CommercialAccount (1:1) -> most recent subscription in
    an OPEN status. Shared by the resolver, EntitlementSnapshotService, and
    CommercialEntitlementService (which used to keep a private copy of this
    same query) so there is exactly one definition of "the org's open
    subscription"."""
    from app.modules.commercial.service import CommercialSubscriptionService

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == organization_id)
        .first()
    )
    if account is None:
        return None
    return (
        db.query(CommercialSubscription)
        .filter(
            CommercialSubscription.commercial_account_id == account.id,
            CommercialSubscription.status.in_(list(CommercialSubscriptionService._OPEN_STATUSES)),
        )
        .order_by(CommercialSubscription.id.desc())
        .first()
    )


def _deny_value(value_type) -> Any:
    vt = value_type.value if hasattr(value_type, "value") else value_type
    return {
        "boolean": False,
        "integer": 0,
        "set": [],
        "enum": None,
    }.get(vt, None)


def _allow_value(value_type) -> Any:
    vt = value_type.value if hasattr(value_type, "value") else value_type
    return {
        "boolean": True,
        # None = "no limit enforced" — matches how get_limit already treats
        # a missing limit, and how an unlimited (Enterprise-contracted) row
        # resolves at L6.
        "integer": None,
        "set": None,
        "enum": None,
    }.get(vt, None)


@dataclass
class EntitlementResolutionContext:
    db: Session
    organization_id: int
    definition: EntitlementDefinition
    _subscription_loaded: bool = field(default=False, repr=False)
    _subscription: CommercialSubscription | None = field(default=None, repr=False)
    _snapshot_loaded: bool = field(default=False, repr=False)
    _snapshot: EntitlementSnapshot | None = field(default=None, repr=False)

    @property
    def subscription(self) -> CommercialSubscription | None:
        if not self._subscription_loaded:
            self._subscription = resolve_open_subscription(self.db, self.organization_id)
            self._subscription_loaded = True
        return self._subscription

    @property
    def snapshot(self) -> EntitlementSnapshot | None:
        if not self._snapshot_loaded:
            self._snapshot = (
                self.db.query(EntitlementSnapshot)
                .filter(EntitlementSnapshot.organization_id == self.organization_id)
                .first()
            )
            self._snapshot_loaded = True
        return self._snapshot


@dataclass
class ResolvedEntitlement:
    key: str
    value: Any
    value_type: EntitlementValueType
    source_level: int
    definition: EntitlementDefinition


ResolverResult = tuple[bool, Any]
ResolverFn = Callable[[EntitlementResolutionContext], ResolverResult]


def _resolve_L1_global_legal_block(ctx: EntitlementResolutionContext) -> ResolverResult:
    if ctx.definition.is_globally_disabled:
        return True, _deny_value(ctx.definition.value_type)
    return False, None


def _resolve_L2_kill_switch(ctx: EntitlementResolutionContext) -> ResolverResult:
    from app.modules.super_admin.kill_switch_service import (
        ENTITLEMENT_ENFORCEMENT,
        BillingKillSwitchService,
    )

    if not BillingKillSwitchService(ctx.db).is_enabled(ENTITLEMENT_ENFORCEMENT):
        # Enforcement itself is paused platform-wide -> resolve fully-allowed.
        return True, _allow_value(ctx.definition.value_type)
    return False, None


def _resolve_L3_override(ctx: EntitlementResolutionContext) -> ResolverResult:
    now = datetime.utcnow()
    override = (
        ctx.db.query(CommercialOverride)
        .filter(
            CommercialOverride.organization_id == ctx.organization_id,
            CommercialOverride.entitlement_definition_id == ctx.definition.id,
            CommercialOverride.status == CommercialOverrideStatus.APPROVED,
        )
        .filter(
            (CommercialOverride.expires_at.is_(None)) | (CommercialOverride.expires_at > now)
        )
        .order_by(CommercialOverride.id.desc())
        .first()
    )
    if override is not None:
        return True, override.value
    return False, None


def _resolve_L4_trial_grant(ctx: EntitlementResolutionContext) -> ResolverResult:
    subscription = ctx.subscription
    if subscription is None or subscription.status != CommercialSubscriptionStatus.TRIALING:
        return False, None
    grants = subscription.trial_granted_entitlements
    if not isinstance(grants, list):
        return False, None
    for grant in grants:
        if isinstance(grant, dict) and grant.get("key") == ctx.definition.key:
            return True, grant.get("value")
    return False, None


def _resolve_L5_snapshot(ctx: EntitlementResolutionContext) -> ResolverResult:
    snapshot = ctx.snapshot
    if snapshot is None or not isinstance(snapshot.values, dict):
        return False, None
    entry = snapshot.values.get(ctx.definition.key)
    if entry is None:
        return False, None
    return True, entry.get("value")


def _resolve_L6_live_plan_entitlement(ctx: EntitlementResolutionContext) -> ResolverResult:
    from app.modules.commercial.cache import get_latest_published_version_id

    subscription = ctx.subscription
    if subscription is None:
        return False, None

    version_id = subscription.catalog_version_id
    if version_id is None and subscription.commercial_plan_id is not None:
        version_id = get_latest_published_version_id(ctx.db, subscription.commercial_plan_id)

    if version_id is None:
        return False, None

    row = (
        ctx.db.query(PlanEntitlement)
        .filter(
            PlanEntitlement.plan_version_id == version_id,
            PlanEntitlement.entitlement_definition_id == ctx.definition.id,
        )
        .first()
    )
    if row is None:
        return False, None
    return True, row.value


def _resolve_L7_safe_default(ctx: EntitlementResolutionContext) -> ResolverResult:
    return True, _deny_value(ctx.definition.value_type)


_RESOLVER_CHAIN: list[ResolverFn] = [
    _resolve_L1_global_legal_block,
    _resolve_L2_kill_switch,
    _resolve_L3_override,
    _resolve_L4_trial_grant,
    _resolve_L5_snapshot,
    _resolve_L6_live_plan_entitlement,
    _resolve_L7_safe_default,
]


def resolve_entitlement(db: Session, organization_id: int, key: str) -> ResolvedEntitlement:
    """Run the 7-level precedence chain for (organization_id, key) and
    return the first level that resolves. L7 always resolves, so this never
    returns without a value for a KNOWN key — it only raises
    EntitlementKeyNotFoundError when the key itself doesn't exist in the
    catalog."""
    definition = (
        db.query(EntitlementDefinition).filter(EntitlementDefinition.key == key).first()
    )
    if definition is None:
        raise EntitlementKeyNotFoundError(f"No EntitlementDefinition for key {key!r}.")

    ctx = EntitlementResolutionContext(db=db, organization_id=organization_id, definition=definition)

    for level, resolver in enumerate(_RESOLVER_CHAIN, start=1):
        resolved, value = resolver(ctx)
        if resolved:
            return ResolvedEntitlement(
                key=key, value=value, value_type=definition.value_type,
                source_level=level, definition=definition,
            )

    # Unreachable: L7 always resolves. Kept as a defensive fallback rather
    # than trusting chain composition never regresses.
    return ResolvedEntitlement(
        key=key, value=_deny_value(definition.value_type), value_type=definition.value_type,
        source_level=7, definition=definition,
    )
