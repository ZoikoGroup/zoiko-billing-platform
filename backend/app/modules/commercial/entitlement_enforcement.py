"""
modules/commercial/entitlement_enforcement.py
-------------------------------------------------
ZB-COM-ENT-001 Part 2, §11/§14 — turns a resolved entitlement into an actual
gate. Two entry points, deliberately not one:

  - require_entitlement(key)     — a Depends() factory mirroring
                                    require_capability()'s style, for
                                    unconditional BOOLEAN gates injected via
                                    a route's `dependencies=[...]`.
  - EntitlementEnforcementService — called explicitly inside a route body
                                    for conditional gates (the trigger can
                                    only be known after inspecting the
                                    request) and limit gates (the current
                                    count can only be computed by the route).

Fail-open vs fail-closed (§14, exact split):
  - Reads (CommercialEntitlementService.is_entitled/get_limit, the ops
    endpoint) wrap resolution in try/except and fail OPEN — a broken
    resolver must never break an unrelated read.
  - Writes (assert_boolean / assert_within_limit, here) do NOT catch
    resolver exceptions — they propagate to a 500, so a write whose
    entitlement couldn't be evaluated never silently completes.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user
from app.core.exceptions import ForbiddenException
from app.database import get_db
from app.modules.commercial.entitlement_catalog_spec import (
    ENTITLEMENT_DISPLAY_NAMES,
    KNOWN_ENTITLEMENT_KEYS,
)
from app.modules.commercial.entitlement_resolver import resolve_entitlement
from app.modules.commercial.enums import EntitlementEnforcementType

logger = logging.getLogger("zoiko_billing.commercial.entitlement_enforcement")

# Single platform-wide grace period for SOFT_THEN_HARD enforcement. Not
# per-key: no route wired in this pass actually uses SOFT_THEN_HARD, and a
# per-key column would be schema surface for a behavior nothing exercises
# yet. Revisit if/when a SOFT_THEN_HARD route is wired.
SOFT_THEN_HARD_GRACE_DAYS = 7


class EntitlementBlockedException(ForbiddenException):
    """403. Raised when a HARD (or grace-expired SOFT_THEN_HARD) entitlement
    gate denies a request."""


class EntitlementLimitExceededException(EntitlementBlockedException):
    """403 with a structured, stable business-level payload for a numeric
    limit gate (assert_within_limit's HARD / grace-expired SOFT_THEN_HARD
    paths). Still an EntitlementBlockedException — anything that only checks
    for that (e.g. existing tests) keeps working unchanged — but callers that
    pass `entity=` to assert_within_limit get this richer shape instead, so
    the frontend can render a proper "Subscription Limit Reached" UI instead
    of parsing the free-text message for the raw entitlement key.

    `error_code` deliberately overrides ForbiddenException's fixed "FORBIDDEN"
    to a distinct, frontend-detectable value — same JSON field ("error"),
    just a more specific value for this one case, matching how every other
    ZoikoException subclass already carries its own error_code."""

    def __init__(
        self, *, entity: str, current_usage: int, limit: int, plan_name: str | None,
        entitlement_key: str, message: str,
    ):
        super().__init__(message)
        self.error_code = "SUBSCRIPTION_LIMIT_REACHED"
        self.extra = {
            "error_type": "ENTITLEMENT_LIMIT",
            "entity": entity,
            "current_usage": current_usage,
            "limit": limit,
            "remaining": max(limit - current_usage, 0),
            "plan_name": plan_name,
            # Retained for engineering/support debugging via the Network tab
            # only — never rendered as the primary message to an org admin.
            "entitlement_key": entitlement_key,
        }


class PlanFeatureUnavailableException(EntitlementBlockedException):
    """403 for a denied BOOLEAN (or SET-membership) gate. Same idea as
    EntitlementLimitExceededException: a distinct error_code the frontend
    can detect, and a message written for an org admin rather than one that
    names the raw entitlement key."""

    def __init__(self, *, feature: str, plan_name: str | None, entitlement_key: str):
        plan = f"your {plan_name} plan" if plan_name else "your current plan"
        super().__init__(
            f"{feature} isn't included in {plan}. Upgrade your plan or contact your administrator."
        )
        self.error_code = "PLAN_FEATURE_UNAVAILABLE"
        self.extra = {
            "error_type": "ENTITLEMENT_FEATURE",
            "feature": feature,
            "plan_name": plan_name,
            "entitlement_key": entitlement_key,
        }


# Plural nouns for the `entity` slugs passed to assert_within_limit, used in
# the human-readable limit message.
_ENTITY_PLURALS = {
    "customer": "customers",
    "invoice": "invoices per month",
    "quote": "quotes",
    "product category": "product categories",
    "subscription plan": "subscription plans",
    "subscription": "subscriptions",
    "product": "products",
    "user": "team members",
    "currency": "currencies",
}

# billing.pricing_model_set is stored as plan-facing families; the billing
# module's PricingModel enum has two extra spellings that belong to them.
PRICING_MODEL_FAMILY = {
    "flat": "flat",
    "per_unit": "flat",
    "tiered": "tiered",
    "graduated": "tiered",
    "volume": "volume",
}


def _limit_message(entity: str | None, limit: int, plan_name: str | None, key: str) -> str:
    if entity is None:
        return f"'{key}' limit ({limit}) exceeded."
    noun = _ENTITY_PLURALS.get(entity, f"{entity}s")
    plan = f"Your {plan_name} plan" if plan_name else "Your current plan"
    return f"{plan} allows up to {limit} {noun}. Upgrade your plan to add more."


def _trial_limit_message(entity: str, limit: int) -> str:
    noun = "invoices" if entity == "invoice" else _ENTITY_PLURALS.get(entity, f"{entity}s")
    return f"Your trial allows up to {limit} {noun} during the trial. Upgrade your plan to add more."


def _enforcement_paused(db: Session) -> bool:
    from app.modules.super_admin.kill_switch_service import (
        ENTITLEMENT_ENFORCEMENT,
        BillingKillSwitchService,
    )

    return not BillingKillSwitchService(db).is_enabled(ENTITLEMENT_ENFORCEMENT)


def count_seats(db: Session, organization_id: int) -> int:
    """Seats in use: active users, including invited-but-not-yet-accepted
    ones (invite_user creates them active). Temporary support-access logins
    are not customer seats. Same rule as plan_change_compatibility's
    internal-users check, so a downgrade and an invite agree."""
    from app.modules.auth.models import User

    return (
        db.query(User)
        .filter(
            User.organization_id == organization_id,
            User.is_active.is_(True),
            User.access_expires_at.is_(None),
        )
        .count()
    )


def seat_limit(db: Session, organization_id: int) -> int | None:
    """The org's seat cap from its open subscription. Trials are capped at
    five even if the granted paid plan allows more seats."""
    from app.modules.commercial.entitlement_resolver import resolve_open_subscription
    from app.modules.commercial.enums import CommercialSubscriptionStatus

    subscription = resolve_open_subscription(db, organization_id)
    if subscription is None or subscription.plan is None:
        return None
    limit = subscription.plan.max_users
    if subscription.status == CommercialSubscriptionStatus.TRIALING:
        return 5 if limit is None else min(limit, 5)
    return limit


class EntitlementThrottledException(ForbiddenException):
    """429-flavored block for THROTTLE enforcement — distinct from
    EntitlementBlockedException since throttling is expected/routine, not
    exceptional."""

    def __init__(self, message: str = "Rate limit exceeded for this entitlement."):
        super().__init__(message)
        self.status_code = 429


def _emit_usage_signal(
    db: Session, *, organization_id: int | None, key: str, event: str, severity=None,
) -> None:
    """Compose the two mechanisms this codebase actually has for a
    'condition reached' signal — AttentionService for operator visibility,
    PlatformAuditService for the durable trail. No generic pub-sub exists
    here to hook into instead."""
    from app.modules.super_admin.attention_service import AttentionService
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import AttentionSeverity, PlatformAuditAction

    severity = severity or AttentionSeverity.P2
    action = (
        PlatformAuditAction.ENTITLEMENT_SOFT_LIMIT_BREACHED
        if event == "usage.threshold.reached"
        else PlatformAuditAction.ENTITLEMENT_BLOCKED
    )
    try:
        AttentionService(db).report_or_update(
            source="entitlement",
            source_key=f"entitlement:{organization_id}:{key}:{event}",
            title=f"{event}: {key}",
            description=f"Organization {organization_id} triggered {event} for entitlement {key!r}.",
            base_severity=severity,
            organization_id=organization_id,
        )
    except Exception:  # noqa: BLE001 - visibility bookkeeping must not block/break the caller
        logger.exception("AttentionService bookkeeping failed for %s on %s", event, key)
    try:
        PlatformAuditService(db).log_no_commit(
            actor_id=None,
            actor_role="system",
            action=action,
            entity_type="EntitlementDefinition",
            entity_id=None,
            organization_id=organization_id,
            metadata={"key": key, "event": event},
        )
    except Exception:  # noqa: BLE001
        logger.exception("Audit bookkeeping failed for %s on %s", event, key)


def _resolve_plan_name(db: Session, organization_id: int) -> str | None:
    """Best-effort plan display name for an EntitlementLimitExceededException
    payload. Deliberately swallows every failure and returns None instead —
    this is UX polish for an already-failing write; it must never itself
    become the reason a write fails or a different error is shown."""
    try:
        from app.modules.commercial.entitlement_resolver import resolve_open_subscription
        from app.modules.commercial.models import CommercialPlan

        subscription = resolve_open_subscription(db, organization_id)
        if subscription is None or subscription.commercial_plan_id is None:
            return None
        plan = db.query(CommercialPlan).filter(CommercialPlan.id == subscription.commercial_plan_id).first()
        return plan.plan_name if plan is not None else None
    except Exception:  # noqa: BLE001 - best-effort only, see docstring
        logger.exception("Failed to resolve plan name for organization %s", organization_id)
        return None


class EntitlementEnforcementService:
    def __init__(self, db: Session):
        self.db = db

    def assert_boolean(self, *, organization_id: int | None, key: str, actor_id: int | None = None) -> None:
        """Gate a BOOLEAN entitlement. A None organization_id (only possible
        for a super_admin caller, per get_current_user's invariant) is
        treated as not-gated — the entitlement system governs a tenant's
        plan-driven capabilities, and a super_admin isn't tied to one."""
        if organization_id is None:
            return

        resolved = resolve_entitlement(self.db, organization_id, key)
        enforcement_type = resolved.definition.enforcement_type
        allowed = bool(resolved.value)

        if allowed:
            return

        if enforcement_type == EntitlementEnforcementType.INFORMATIONAL:
            _emit_usage_signal(self.db, organization_id=organization_id, key=key, event="usage.limit.reached")
            return

        # HARD, SOFT_THEN_HARD, and THROTTLE all block a denied BOOLEAN gate
        # outright — grace/throttle semantics only apply to numeric limits.
        _emit_usage_signal(self.db, organization_id=organization_id, key=key, event="usage.limit.reached")
        raise PlanFeatureUnavailableException(
            feature=ENTITLEMENT_DISPLAY_NAMES.get(key, key),
            plan_name=_resolve_plan_name(self.db, organization_id),
            entitlement_key=key,
        )

    def assert_within_limit(
        self,
        *,
        organization_id: int | None,
        key: str,
        current_count: int,
        increment: int = 1,
        actor_id: int | None = None,
        entity: str | None = None,
    ) -> None:
        """Gate an INTEGER limit. `resolved.value is None` means unlimited
        (Enterprise-contracted with no numeric cap configured, or the safe
        'no limit enforced' default) -> always allow.

        `entity` is an optional, caller-supplied business-facing slug (e.g.
        "customer", "invoice") for the resource this limit actually gates.
        When given, an exceeded limit raises EntitlementLimitExceededException
        (a structured, frontend-detectable payload) instead of the plain
        EntitlementBlockedException — purely additive: omitting it (every
        caller before this) preserves the exact prior behavior."""
        if organization_id is None:
            return

        resolved = resolve_entitlement(self.db, organization_id, key)
        limit = resolved.value
        if limit is None:
            return

        # Trial invoice allowance is five invoices for the whole trial, not
        # five in each calendar month. Paid-plan behavior remains monthly.
        is_trial = False
        if entity is not None:
            from app.modules.commercial.enums import CommercialSubscriptionStatus
            from app.modules.commercial.entitlement_resolver import resolve_open_subscription

            subscription = resolve_open_subscription(self.db, organization_id)
            if subscription is not None and subscription.status == CommercialSubscriptionStatus.TRIALING:
                is_trial = True
            if entity == "invoice" and is_trial:
                current_count = count_invoices_during_trial(self.db, organization_id, subscription.created_at)

        projected = current_count + increment
        over_limit = projected > limit
        if not over_limit:
            return

        enforcement_type = resolved.definition.enforcement_type

        if enforcement_type == EntitlementEnforcementType.INFORMATIONAL:
            _emit_usage_signal(self.db, organization_id=organization_id, key=key, event="usage.limit.reached")
            return

        if enforcement_type == EntitlementEnforcementType.SOFT_THEN_HARD:
            from app.modules.commercial.usage_metering_service import UsageMeteringService

            counter = UsageMeteringService(self.db).get_or_create_counter(organization_id, resolved.definition.id)
            if counter.soft_warned_at is None:
                counter.soft_warned_at = datetime.utcnow()
                self.db.flush()
                _emit_usage_signal(
                    self.db, organization_id=organization_id, key=key, event="usage.threshold.reached",
                )
                return
            grace_elapsed = datetime.utcnow() - counter.soft_warned_at > timedelta(days=SOFT_THEN_HARD_GRACE_DAYS)
            if not grace_elapsed:
                return
            _emit_usage_signal(self.db, organization_id=organization_id, key=key, event="usage.limit.reached")
            if entity is not None:
                plan_name = _resolve_plan_name(self.db, organization_id)
                message = _trial_limit_message(entity, limit) if is_trial else _limit_message(entity, limit, plan_name, key)
                raise EntitlementLimitExceededException(
                    entity=entity, current_usage=current_count, limit=limit, plan_name=plan_name,
                    entitlement_key=key, message=message,
                )
            raise EntitlementBlockedException(f"'{key}' limit ({limit}) exceeded and the grace period has elapsed.")

        if enforcement_type == EntitlementEnforcementType.THROTTLE:
            from app.modules.super_admin.models import AttentionSeverity

            _emit_usage_signal(
                self.db, organization_id=organization_id, key=key, event="usage.limit.reached",
                severity=AttentionSeverity.P3,
            )
            raise EntitlementThrottledException(f"'{key}' rate limit ({limit}) exceeded.")

        # HARD
        _emit_usage_signal(self.db, organization_id=organization_id, key=key, event="usage.limit.reached")
        if entity is not None:
            plan_name = _resolve_plan_name(self.db, organization_id)
            message = _trial_limit_message(entity, limit) if is_trial else _limit_message(entity, limit, plan_name, key)
            raise EntitlementLimitExceededException(
                entity=entity, current_usage=current_count, limit=limit, plan_name=plan_name,
                entitlement_key=key, message=message,
            )
        raise EntitlementBlockedException(_limit_message(None, limit, None, key))

    def assert_seat_available(self, *, organization_id: int | None, increment: int = 1) -> None:
        """Gate adding (or reactivating) a user against the plan's max_users.
        Seats are a plan column, not a catalog entitlement, so this reads
        the plan directly, but it honours the same platform kill switch
        (L2) as every resolver-based gate."""
        if organization_id is None or _enforcement_paused(self.db):
            return
        limit = seat_limit(self.db, organization_id)
        if limit is None:
            return
        current = count_seats(self.db, organization_id)
        if current + increment <= limit:
            return
        _emit_usage_signal(self.db, organization_id=organization_id, key="max_users", event="usage.limit.reached")
        plan_name = _resolve_plan_name(self.db, organization_id)
        from app.modules.commercial.entitlement_resolver import resolve_open_subscription
        from app.modules.commercial.enums import CommercialSubscriptionStatus

        subscription = resolve_open_subscription(self.db, organization_id)
        message = (
            _trial_limit_message("user", limit)
            if subscription is not None and subscription.status == CommercialSubscriptionStatus.TRIALING
            else _limit_message("user", limit, plan_name, "max_users")
        )
        raise EntitlementLimitExceededException(
            entity="user", current_usage=current, limit=limit, plan_name=plan_name,
            entitlement_key="max_users", message=message,
        )

    def assert_pricing_model_allowed(self, *, organization_id: int | None, pricing_model) -> None:
        """Gate a pricing model against billing.pricing_model_set. A None
        set (Enterprise/contracted, or enforcement paused) allows all."""
        if organization_id is None or pricing_model is None:
            return
        model = str(getattr(pricing_model, "value", pricing_model)).lower()
        family = PRICING_MODEL_FAMILY.get(model, model)

        resolved = resolve_entitlement(self.db, organization_id, "billing.pricing_model_set")
        allowed = resolved.value
        if allowed is None or family in {str(v).lower() for v in allowed}:
            return
        _emit_usage_signal(
            self.db, organization_id=organization_id, key="billing.pricing_model_set", event="usage.limit.reached",
        )
        raise PlanFeatureUnavailableException(
            feature=f"{model.replace('_', '-').capitalize()} pricing",
            plan_name=_resolve_plan_name(self.db, organization_id),
            entitlement_key="billing.pricing_model_set",
        )


def count_customers(db: Session, organization_id: int) -> int:
    """Customers counted against billing.customer.max (soft-deleted ones
    don't count)."""
    from app.modules.billing.models import BillingCustomer

    return (
        db.query(BillingCustomer)
        .filter(BillingCustomer.organization_id == organization_id, BillingCustomer.deleted_at.is_(None))
        .count()
    )


def count_invoices_this_month(db: Session, organization_id: int) -> int:
    """Invoices counted against billing.invoice.monthly_limit: created in the
    current UTC calendar month, matching the key's own name."""
    from app.modules.billing.models import Invoice

    period_start = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return (
        db.query(Invoice)
        .filter(
            Invoice.organization_id == organization_id,
            Invoice.created_at >= period_start,
            Invoice.deleted_at.is_(None),
        )
        .count()
    )


def count_invoices_during_trial(db: Session, organization_id: int, trial_started_at) -> int:
    """Count invoice records created since this organization's trial began."""
    from app.modules.billing.models import Invoice

    query = db.query(Invoice).filter(
        Invoice.organization_id == organization_id,
        Invoice.deleted_at.is_(None),
    )
    if trial_started_at is not None:
        query = query.filter(Invoice.created_at >= trial_started_at)
    return query.count()


def count_invoice_usage(db: Session, organization_id: int) -> int:
    """Use the trial lifetime window for trial invoices and the calendar
    month window for paid subscriptions."""
    from app.modules.commercial.enums import CommercialSubscriptionStatus
    from app.modules.commercial.entitlement_resolver import resolve_open_subscription

    subscription = resolve_open_subscription(db, organization_id)
    if subscription is not None and subscription.status == CommercialSubscriptionStatus.TRIALING:
        return count_invoices_during_trial(db, organization_id, subscription.created_at)
    return count_invoices_this_month(db, organization_id)


def assert_trial_resource_limit(
    db: Session, *, organization_id: int | None, entity: str, model, increment: int = 1,
) -> None:
    """Apply the five-item lifetime trial cap to a tenant resource without
    requiring a paid-plan entitlement row for that resource (for example,
    quotations, which predate the entitlement catalog)."""
    if organization_id is None or _enforcement_paused(db):
        return

    from app.modules.commercial.enums import CommercialSubscriptionStatus
    from app.modules.commercial.entitlement_resolver import resolve_open_subscription

    subscription = resolve_open_subscription(db, organization_id)
    if subscription is None or subscription.status != CommercialSubscriptionStatus.TRIALING:
        return

    query = db.query(model).filter(model.organization_id == organization_id)
    created_at = getattr(model, "created_at", None)
    if created_at is not None and subscription.created_at is not None:
        query = query.filter(created_at >= subscription.created_at)
    current_count = query.count()
    if current_count + increment <= 5:
        return

    plan_name = _resolve_plan_name(db, organization_id)
    raise EntitlementLimitExceededException(
        entity=entity,
        current_usage=current_count,
        limit=5,
        plan_name=plan_name,
        entitlement_key=f"trial.{entity}.max",
        message=_trial_limit_message(entity, 5),
    )


def count_currencies(db: Session, organization_id: int) -> int:
    """Currencies counted against currency.enabled.max: distinct currencies
    in the org's active currency pricing."""
    from sqlalchemy import func

    from app.modules.billing.models import CurrencyPricing

    return (
        db.query(func.count(func.distinct(func.upper(CurrencyPricing.currency))))
        .filter(
            CurrencyPricing.organization_id == organization_id,
            CurrencyPricing.is_active.is_(True),
            CurrencyPricing.deleted_at.is_(None),
        )
        .scalar()
    ) or 0


# Live usage for every limit the platform can actually count, keyed by
# entitlement key. Read by the org's plan-limits page.
USAGE_COUNTERS = {
    "billing.customer.max": count_customers,
    "billing.invoice.monthly_limit": count_invoice_usage,
    "currency.enabled.max": count_currencies,
}


def customer_capacity(db: Session, organization_id: int | None) -> tuple[int | None, str | None]:
    """(remaining customer slots, message to show once they run out) for a
    bulk import, which can't use assert_within_limit's all-or-nothing raise:
    rows past the limit are reported as failed while earlier rows still
    import. remaining None = unlimited. A write path, so resolution errors
    propagate (fail closed), same as assert_within_limit."""
    if organization_id is None:
        return None, None
    limit = resolve_entitlement(db, organization_id, "billing.customer.max").value
    if limit is None:
        return None, None
    plan_name = _resolve_plan_name(db, organization_id)
    remaining = max(int(limit) - count_customers(db, organization_id), 0)
    return remaining, _limit_message("customer", int(limit), plan_name, "billing.customer.max")


def audit_search_cutoff(db: Session, organization_id: int | None) -> datetime | None:
    """Oldest timestamp the org's audit log may be searched back to, from
    audit.search_months. None = no cutoff. A read restriction, so it fails
    OPEN (§14): an unresolvable entitlement never hides the audit log."""
    if organization_id is None:
        return None
    try:
        months = resolve_entitlement(db, organization_id, "audit.search_months").value
    except Exception:  # noqa: BLE001 - fail-open read (§14)
        logger.exception("audit.search_months resolution failed for organization %s", organization_id)
        return None
    if months is None or int(months) <= 0:
        # 0 is the resolver's safe default for "nothing configured", not a
        # real plan value: no published plan sets a zero-month window.
        return None
    now = datetime.utcnow()
    month_index = now.year * 12 + (now.month - 1) - int(months)
    year, month = divmod(month_index, 12)
    return now.replace(year=year, month=month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)


def require_entitlement(key: str):
    """Dependency factory mirroring require_capability()'s style: validates
    `key` against the catalog at call time (a typo fails at router-definition
    time, not request time), resolves the actor via current_user.organization_id,
    raises EntitlementBlockedException on denial."""
    if key not in KNOWN_ENTITLEMENT_KEYS:
        raise ValueError(f"Unknown entitlement key: {key!r}. Add it to entitlement_catalog_spec.py first.")

    def _dependency(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        EntitlementEnforcementService(db).assert_boolean(
            organization_id=current_user.organization_id, key=key, actor_id=current_user.id,
        )
        return current_user

    return _dependency
