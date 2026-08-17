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
    """Per ZB-COM-BILL-001 Table 9 (Commercial Billing & Subscription
    Operating Standard) — the canonical, approved classification set. Every
    workspace must carry one of these; only COMMERCIAL_STANDALONE may create
    a live standalone commercial charge (see CommercialAccountService.can_charge
    and the double-charge prevention check in CommercialSubscriptionService).
    """
    COMMERCIAL_STANDALONE = "commercial_standalone"
    COMMERCIAL_ZOIKO_ONE = "commercial_zoiko_one"
    LEGACY_MIGRATION = "legacy_migration"
    PILOT_NON_BILLABLE = "pilot_non_billable"
    INTERNAL = "internal"
    DEMO = "demo"
    SANDBOX = "sandbox"
    QA_AUTOMATION = "qa_automation"


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


class CommercialPlanVersionStatus(str, enum.Enum):
    """Lifecycle of a versioned catalog snapshot (ZB-COM-BILL-001 §T1, Phase
    4). A published version is immutable; changing a published price/limit
    creates a NEW version rather than mutating history.

    DRAFT             — editable, not yet submitted for approval.
    PENDING_APPROVAL   — submitted; awaiting a second Super Admin (maker-checker).
    PUBLISHED          — approved and live; immutable from this point on.
    REJECTED           — declined by the approver; terminal, not re-editable.
    ARCHIVED           — retired from new subscriptions; history preserved.
    """
    DRAFT = "draft"
    PENDING_APPROVAL = "pending_approval"
    PUBLISHED = "published"
    REJECTED = "rejected"
    ARCHIVED = "archived"


class ApprovalStatus(str, enum.Enum):
    """Generic maker-checker request status (ZB-COM-BILL-001 Phase 5)."""
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


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
