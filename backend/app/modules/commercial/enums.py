"""
modules/commercial/enums.py
---------------------------
Commercial-plane (Plane 1) enums shared by the Organization model now and the
future Commercial Account / Commercial Subscription models (PHASE 6/8).

BillingClassification marks which workspace a tenant's billing belongs to.
BillingSource records how the tenant was onboarded; it is stamped
server-side at registration and feeds the double-charge prevention check.
"""

import enum


class BillingClassification(str, enum.Enum):
    COMMERCIAL_STANDALONE = "commercial_standalone"
    COMMERCIAL_ZOIKO_ONE = "commercial_zoiko_one"


class BillingSource(str, enum.Enum):
    REGISTERED_VIA_STANDALONE = "registered_via_standalone"
    REGISTERED_VIA_ZOIKO_ONE = "registered_via_zoiko_one"


class CommercialAccountStatus(str, enum.Enum):
    """Lifecycle of the commercial account (the org's relationship with Zoiko).

    The Zoiko One reference drives a richer PENDING/ACTIVE/EXPIRED/CANCELLED
    lifecycle, but those extra states are payment/subscription-driven and are
    deferred to the commercial subscription phase. For Phase 6 the smallest
    safe lifecycle is ACTIVE (created at provisioning) and SUSPENDED (set by a
    future Super Admin action)."""
    ACTIVE = "active"
    SUSPENDED = "suspended"


class CommercialPlanStatus(str, enum.Enum):
    """Lifecycle of a reusable commercial plan (PHASE 7).

    ACTIVE   — purchasable / assignable.
    INACTIVE — not sold anymore, but existing subscriptions still valid and
               history preserved.
    ARCHIVED — permanently unavailable; retained for audit only.
    """
    ACTIVE = "active"
    INACTIVE = "inactive"
    ARCHIVED = "archived"


class CommercialBillingInterval(str, enum.Enum):
    """Billing cadence for a commercial plan. Kept as a structural enum only —
    Phase 7 does NOT invent pricing, so the column stays NULL until an approved
    catalogue defines it."""
    MONTHLY = "monthly"
    ANNUAL = "annual"


class CommercialSubscriptionStatus(str, enum.Enum):
    """Lifecycle of a commercial subscription (PHASE 7).

    PENDING   — created awaiting activation (no approved default plan at
                registration, or awaiting payment confirmation).
    ACTIVE    — live; the org is entitled to the plan.
    SUSPENDED — paused by a future Super Admin action (mirrors
                CommercialAccountStatus.SUSPENDED).
    CANCELLED — terminal; preserved for audit/history.
    EXPIRED   — terminal; period ended without renewal; preserved.
    """
    PENDING = "pending"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
