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
    A NULL `platform_role` (every super_admin account that existed before
    this column was added) is treated as PLATFORM_ADMINISTRATOR — full
    access, no data migration required, zero behavior change for existing
    accounts.

This replaces the session-5 scaffolding (where every capability resolved
to the same coarse `get_current_super_admin` check) with real
differentiation: a `support_operator` calling an `auditor`-only or
`platform_administrator`-only endpoint now gets a genuine 403, not a
documented-but-unenforced gap.
"""

from fastapi import Depends

from app.core.dependencies import get_current_super_admin
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import PlatformRole

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
    "incident.acknowledge": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "incident.assign": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "incident.transition": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
    "incident.suppress": {PlatformRole.SECURITY_OPERATOR, PlatformRole.RELIABILITY_OPERATOR},
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
}

CAPABILITIES = set(_CAPABILITY_ROLE_MAP.keys())


def _effective_platform_role(user) -> PlatformRole:
    return user.platform_role or PlatformRole.PLATFORM_ADMINISTRATOR


def has_capability(user, capability: str) -> bool:
    if capability not in _CAPABILITY_ROLE_MAP:
        raise ValueError(f"Unknown capability: {capability!r}. Add it to _CAPABILITY_ROLE_MAP first.")
    effective = _effective_platform_role(user)
    if effective == PlatformRole.PLATFORM_ADMINISTRATOR:
        return True
    return effective in _CAPABILITY_ROLE_MAP[capability]


def require_capability(capability: str):
    """Dependency factory. Raises ValueError at import time (not at
    request time) for an undeclared capability name."""
    if capability not in _CAPABILITY_ROLE_MAP:
        raise ValueError(f"Unknown capability: {capability!r}. Add it to _CAPABILITY_ROLE_MAP first.")

    def _dependency(current_user=Depends(get_current_super_admin)):
        if not has_capability(current_user, capability):
            raise ForbiddenException(
                f"Your platform role ({_effective_platform_role(current_user).value}) "
                f"does not include the '{capability}' capability."
            )
        return current_user

    return _dependency
