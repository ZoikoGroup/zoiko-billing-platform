"""
core/capabilities.py
----------------------
ZB-SA-CMD-003 §26 — real, enforced capability-based authorization.

Two-dimensional model:
  - `UserRole.SUPER_ADMIN` (auth/models.py) remains the FLOOR every
    Command Center endpoint requires — unchanged, still the base identity
    check (a super_admin belongs to no organization, requires MFA, etc.).
  - `PlatformRole` (auth/models.py) narrows WHICH capabilities that
    specific super_admin account holds within the Command Center surface.
    A NULL `platform_role` grants NO capabilities (GOV-01). Earlier
    versions treated NULL as PLATFORM_ADMINISTRATOR; migration a7c3e91d4b52
    backfilled every existing super_admin to an explicit
    `platform_administrator`, and every creation path now sets a platform
    role explicitly. A NULL role is logged as a warning and denied.

This replaces the session-5 scaffolding (where every capability resolved
to the same coarse `get_current_super_admin` check) with real
differentiation: a `support_operator` calling an `auditor`-only or
`platform_administrator`-only endpoint now gets a genuine 403, not a
documented-but-unenforced gap.
"""

import logging
import time
from typing import Any

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_super_admin
from app.core.exceptions import ForbiddenException
from app.database import get_db
from app.modules.auth.models import PlatformRole

logger = logging.getLogger(__name__)

# capability -> set of PlatformRoles that hold it. PLATFORM_ADMINISTRATOR
# is implicitly added to every capability below (see require_capability) —
# it is never listed explicitly to avoid the list silently drifting if a
# capability is added here without remembering to include it.
_CAPABILITY_ROLE_MAP: dict[str, set[PlatformRole]] = {
    "triage.read": {
        PlatformRole.SUPPORT_OPERATOR, PlatformRole.SECURITY_OPERATOR,
        PlatformRole.RELIABILITY_OPERATOR, PlatformRole.AUDITOR,
    },
    "reliability.read": {
        PlatformRole.RELIABILITY_OPERATOR, PlatformRole.SECURITY_OPERATOR,
        PlatformRole.AUDITOR, PlatformRole.SUPPORT_OPERATOR,
    },
    "governance.read": {
        PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR,
        PlatformRole.AUDITOR, PlatformRole.SUPPORT_OPERATOR,
    },
    "tenant_support.request": {PlatformRole.SUPPORT_OPERATOR},
    "tenant_support.activate": {PlatformRole.SUPPORT_OPERATOR},
    "tenant_support.exit": {PlatformRole.SUPPORT_OPERATOR},
    "tenant_support.approve": {PlatformRole.SECURITY_OPERATOR, PlatformRole.PLATFORM_ADMINISTRATOR},
    "tenant_support.revoke": {PlatformRole.SECURITY_OPERATOR, PlatformRole.PLATFORM_ADMINISTRATOR},
    "tenant_support.break_glass": {PlatformRole.SECURITY_OPERATOR},
    "tenant_support.review_break_glass": {PlatformRole.SECURITY_OPERATOR, PlatformRole.AUDITOR},
    "incident.acknowledge": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "incident.assign": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "incident.transition": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "incident.suppress": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "job.retry": {PlatformRole.RELIABILITY_OPERATOR},
    # B3 — manual resend of a failed/suppressed email delivery. Same
    # operational-write precedent as job.retry (RELIABILITY_OPERATOR), plus
    # SECURITY_OPERATOR since a resend can be the fix for a security-relevant
    # suppression review.
    "email_delivery.resend": {PlatformRole.RELIABILITY_OPERATOR, PlatformRole.SECURITY_OPERATOR},
    "audit.read": {PlatformRole.SECURITY_OPERATOR, PlatformRole.AUDITOR},
    "launch_readiness.read": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR, PlatformRole.AUDITOR},
    "global_search.read": {
        PlatformRole.SUPPORT_OPERATOR, PlatformRole.SECURITY_OPERATOR,
        PlatformRole.RELIABILITY_OPERATOR, PlatformRole.AUDITOR,
    },
    "metric_dictionary.read": {
        PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR,
        PlatformRole.AUDITOR, PlatformRole.FINANCE_READONLY,
    },
    "financial_consistency.read": {PlatformRole.AUDITOR, PlatformRole.FINANCE_READONLY},
    # MUTATING reconciliation actions (manually triggering a run — including
    # the Stripe-comparison leg — and acknowledging/resolving exceptions)
    # were previously gated behind the SAME `financial_consistency.read`
    # capability as the read-only report endpoints. That let a
    # FINANCE_READONLY account — a role whose own name promises read-only
    # access — actually mutate reconciliation state, breaking the read/write
    # split this file otherwise enforces everywhere else (circuit_breaker.read
    # vs .manage, platform_config.read vs .manage, commercial_financial.read
    # vs .write). SECURITY_OPERATOR is this codebase's established
    # "operational write" role for consequential platform mutations
    # (commercial_payment.write, commercial_financial.write,
    # circuit_breaker.manage, platform_config.manage) — reconciliation writes
    # follow the same precedent.
    "financial_consistency.write": {PlatformRole.SECURITY_OPERATOR},
    "circuit_breaker.read": {
        PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR, PlatformRole.AUDITOR,
    },
    "circuit_breaker.manage": {PlatformRole.SECURITY_OPERATOR},
    # ── Phase 4 (G-02/G-03) — configuration governance ────────────────────
    # Reading the configuration inventory is an operator-level need (every
    # platform role may need to see what thresholds/integrations exist);
    # MUTATING platform settings is a security-operator function, audited.
    "platform_config.read": {
        PlatformRole.SUPPORT_OPERATOR, PlatformRole.SECURITY_OPERATOR,
        PlatformRole.RELIABILITY_OPERATOR, PlatformRole.AUDITOR,
    },
    "platform_config.manage": {PlatformRole.SECURITY_OPERATOR},
    "platform_role.manage": set(),  # PLATFORM_ADMINISTRATOR only — see below
    # ── Plane 1 Commercial Billing capabilities ─────────────────────────────
    "commercial_quote.write": {PlatformRole.SUPPORT_OPERATOR},
    "commercial_quote.approve": {PlatformRole.AUDITOR},
    "commercial_payment.write": {PlatformRole.SECURITY_OPERATOR},
    "commercial_financial.read": {PlatformRole.AUDITOR, PlatformRole.FINANCE_READONLY},
    # Deliberately SECURITY_OPERATOR, not AUDITOR: AUDITOR already holds
    # commercial_quote.approve (independent-review role, §25 maker-checker),
    # so the same person must not also be the one authoring/finalizing/
    # sending the Plane 1 invoices those quotes convert into. SECURITY_OPERATOR
    # already holds commercial_payment.write (the operational money-movement
    # role) — invoice creation/finalize/void/send is the same class of
    # operational write the payment side already trusts it with, and every
    # payment allocation needs a finalized invoice to allocate against, so
    # splitting invoice-write into a third role would just force two operator
    # roles to complete one workflow with no separation-of-duties benefit.
    "commercial_financial.write": {PlatformRole.SECURITY_OPERATOR},
    # PLATFORM_ADMINISTRATOR only (empty explicit set, same pattern as
    # platform_role.manage) — activating a trial program is a commercial
    # policy decision, not a day-to-day operational task.
    "commercial_evaluation_program.write": set(),
}

CAPABILITIES = set(_CAPABILITY_ROLE_MAP.keys())

# Capabilities the implicit PLATFORM_ADMINISTRATOR grant does NOT cover: they
# are held only by the roles listed for them in _CAPABILITY_ROLE_MAP.
EXPLICIT_ONLY_CAPABILITIES: frozenset[str] = frozenset({"tenant_support.break_glass"})


def _effective_platform_role(user) -> PlatformRole | None:
    """The user's platform role, or None when unset (NULL grants nothing)."""
    return user.platform_role or None


def _describe_role(user) -> str:
    role = _effective_platform_role(user)
    return role.value if role is not None else "none assigned"


def has_capability(user, capability: str) -> bool:
    if capability not in _CAPABILITY_ROLE_MAP:
        raise ValueError(f"Unknown capability: {capability!r}. Add it to _CAPABILITY_ROLE_MAP first.")
    effective = _effective_platform_role(user)
    if effective is None:
        logger.warning(
            "Super admin %s has no platform_role; denying capability %r. "
            "Assign an explicit platform role.",
            getattr(user, "email", getattr(user, "id", "?")), capability,
        )
        return False
    if (
        effective == PlatformRole.PLATFORM_ADMINISTRATOR
        and capability not in EXPLICIT_ONLY_CAPABILITIES
    ):
        return True
    return effective in _CAPABILITY_ROLE_MAP[capability]


_denial_cache: dict[tuple, float] = {}
_DENIAL_DEDUP_SECONDS = 60


def _should_audit_denial(actor_id: Any, capability: str) -> bool:
    """Rate-limit denial audit events to one per (actor, capability) per minute window."""
    key = (str(actor_id), capability)
    now = time.time()
    last = _denial_cache.get(key, 0.0)
    if now - last < _DENIAL_DEDUP_SECONDS:
        return False
    _denial_cache[key] = now
    if len(_denial_cache) > 2000:
        cutoff = now - _DENIAL_DEDUP_SECONDS
        to_del = [k for k, v in _denial_cache.items() if v <= cutoff]
        for k in to_del:
            _denial_cache.pop(k, None)
    return True


def _deny(request, db, current_user, capability: str):
    """Audit (rate-limited) and raise the 403 for a missing capability."""
    actor_id = getattr(current_user, "id", None)
    if actor_id and _should_audit_denial(actor_id, capability):
        try:
            from app.modules.super_admin.audit_service import PlatformAuditService
            from app.modules.super_admin.models import PlatformAuditAction

            path = request.url.path if request and hasattr(request, "url") else None
            corr_id = getattr(request.state, "correlation_id", None) if request and hasattr(request, "state") else None
            audit_svc = PlatformAuditService(db)
            audit_svc.log_no_commit(
                actor_id=actor_id,
                action=PlatformAuditAction.PLATFORM_ACCESS_DENIED,
                entity_type="capability",
                entity_id=None,
                metadata={"capability": capability, "request_path": path},
                correlation_id=corr_id,
                reason=f"Missing required capability: {capability}",
            )
            db.commit()
        except Exception as audit_err:
            logger.warning("Failed to record PLATFORM_ACCESS_DENIED audit: %s", audit_err)
            try:
                db.rollback()
            except Exception:
                pass

    raise ForbiddenException(
        f"Your platform role ({_describe_role(current_user)}) "
        f"does not include the '{capability}' capability."
    )


def require_capability(capability: str):
    """Dependency factory. Raises ValueError at import time (not at
    request time) for an undeclared capability name."""
    if capability not in _CAPABILITY_ROLE_MAP:
        raise ValueError(f"Unknown capability: {capability!r}. Add it to _CAPABILITY_ROLE_MAP first.")

    def _dependency(
        request: Request = None,
        db: Session = Depends(get_db),
        current_user=Depends(get_current_super_admin),
    ):
        if not has_capability(current_user, capability):
            _deny(request, db, current_user, capability)
        return current_user

    return _dependency


def require_any_capability(*capabilities: str):
    """Like require_capability, but passes when the caller holds ANY of the
    listed capabilities. Used where two roles legitimately reach the same
    owner-scoped endpoint by different paths (e.g. a break-glass opener and
    a normal requester both need to view and exit their own grant)."""
    for capability in capabilities:
        if capability not in _CAPABILITY_ROLE_MAP:
            raise ValueError(f"Unknown capability: {capability!r}. Add it to _CAPABILITY_ROLE_MAP first.")

    def _dependency(
        request: Request = None,
        db: Session = Depends(get_db),
        current_user=Depends(get_current_super_admin),
    ):
        if not any(has_capability(current_user, c) for c in capabilities):
            _deny(request, db, current_user, " or ".join(capabilities))
        return current_user

    return _dependency
