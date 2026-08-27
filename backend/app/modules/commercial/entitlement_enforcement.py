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
from app.modules.commercial.entitlement_catalog_spec import KNOWN_ENTITLEMENT_KEYS
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
        raise EntitlementBlockedException(
            f"This action requires the '{key}' entitlement, which is not enabled for your plan."
        )

    def assert_within_limit(
        self,
        *,
        organization_id: int | None,
        key: str,
        current_count: int,
        increment: int = 1,
        actor_id: int | None = None,
    ) -> None:
        """Gate an INTEGER limit. `resolved.value is None` means unlimited
        (Enterprise-contracted with no numeric cap configured, or the safe
        'no limit enforced' default) -> always allow."""
        if organization_id is None:
            return

        resolved = resolve_entitlement(self.db, organization_id, key)
        limit = resolved.value
        if limit is None:
            return

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
            raise EntitlementBlockedException(
                f"'{key}' limit ({limit}) exceeded and the grace period has elapsed."
            )

        if enforcement_type == EntitlementEnforcementType.THROTTLE:
            from app.modules.super_admin.models import AttentionSeverity

            _emit_usage_signal(
                self.db, organization_id=organization_id, key=key, event="usage.limit.reached",
                severity=AttentionSeverity.P3,
            )
            raise EntitlementThrottledException(f"'{key}' rate limit ({limit}) exceeded.")

        # HARD
        _emit_usage_signal(self.db, organization_id=organization_id, key=key, event="usage.limit.reached")
        raise EntitlementBlockedException(f"'{key}' limit ({limit}) exceeded.")


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
