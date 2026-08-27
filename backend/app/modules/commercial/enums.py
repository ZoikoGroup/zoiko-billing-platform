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

    PENDING              — created awaiting activation (no approved default
                           plan at registration, or awaiting payment
                           confirmation).
    ACTIVE               — live; the org is entitled to the plan.
    PAST_DUE             — N1 day 0: a Plane-1 (Zoiko's own subscription)
                           payment failed. Entitlements unaffected so far.
    RESTRICTED           — N1 day 10: blocks new paid expansion only;
                           existing entitlements keep working.
    SUSPENDED            — N1 day 20 (also settable by a Super Admin action
                           directly): read-only — never deletes records (N2).
    CANCELLED            — terminal; preserved for audit/history. N1 day 45
                           (dunning "termination") lands here, not a hard
                           delete.
    EXPIRED              — terminal; period ended without renewal; preserved.
    TRIALING             — trial is active under a CommercialEvaluationProgram;
                           entitlements sourced from the granted plan's bundle.
    SCHEDULED_CHANGE     — a plan change (upgrade/downgrade) is pending at the
                           next period boundary; current entitlements unchanged
                           until the change takes effect.
    CANCEL_AT_PERIOD_END — cancellation requested but effective only at the
                           current period boundary; entitlements remain until
                           then.
    ENTERPRISE_PENDING   — enterprise onboarding in progress; awaiting
                           signed order form / contract before activation.
    """
    PENDING = "pending"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    RESTRICTED = "restricted"
    SUSPENDED = "suspended"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    TRIALING = "trialing"
    SCHEDULED_CHANGE = "scheduled_change"
    CANCEL_AT_PERIOD_END = "cancel_at_period_end"
    ENTERPRISE_PENDING = "enterprise_pending"


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Commercial Quote / Invoice / Payment / Credit / Refund enums
# ═══════════════════════════════════════════════════════════════════════════════


class CommercialQuoteStatus(str, enum.Enum):
    """Lifecycle of a commercial quote.

    DRAFT      — editable; not yet sent to the customer.
    SENT       — delivered; awaiting customer decision.
    ACCEPTED   — customer approved; ready to convert to PlatformInvoice.
    REJECTED   — customer declined; terminal.
    EXPIRED    — valid_until passed without decision; terminal.
    CONVERTED  — converted to a PlatformInvoice; terminal.
    """
    DRAFT = "draft"
    SENT = "sent"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    EXPIRED = "expired"
    CONVERTED = "converted"


class PlatformInvoiceStatus(str, enum.Enum):
    """Lifecycle of a Platform Invoice (Zoiko billing an org).

    State machine:
      DRAFT → [ISSUED, VOIDED]
      ISSUED → [DELIVERED, DELIVERY_FAILED, DUE, VOIDED]
      DUE → [PARTIALLY_PAID, PAID, OVERDUE, VOIDED]
      PARTIALLY_PAID → [PAID, OVERDUE, VOIDED]
      OVERDUE → [PAID, DISPUTED, CREDITED, VOIDED]
      DISPUTED → [PAID, CREDITED, VOIDED]
      CREDITED → terminal
      VOIDED → terminal
      DELIVERY_FAILED → [SENT_RETRY, VOIDED]
    """
    DRAFT = "draft"
    REVIEW_REQUIRED = "review_required"
    APPROVED = "approved"
    ISSUED = "issued"
    DELIVERED = "delivered"
    DELIVERY_FAILED = "delivery_failed"
    DUE = "due"
    PARTIALLY_PAID = "partially_paid"
    PAID = "paid"
    OVERDUE = "overdue"
    DISPUTED = "disputed"
    CREDITED = "credited"
    VOIDED = "voided"


class PlatformInvoiceType(str, enum.Enum):
    """Classification of a Platform Invoice.

    STANDARD              — manual or quote-converted invoice.
    SUBSCRIPTION_RENEWAL  — auto-generated on CommercialSubscription renewal.
    PLAN_CHANGE           — pro-rata invoice from a plan upgrade/downgrade.
    CREDIT                — credit-note-backed invoice (negative amounts).
    """
    STANDARD = "standard"
    SUBSCRIPTION_RENEWAL = "subscription_renewal"
    PLAN_CHANGE = "plan_change"
    CREDIT = "credit"


class PlatformInvoiceDeliveryStatus(str, enum.Enum):
    """Delivery lifecycle column (separate from main status per doctrine)."""
    DRAFT = "draft"
    SENT = "sent"
    DELIVERED = "delivered"
    FAILED = "failed"


class PlatformInvoicePaymentStatus(str, enum.Enum):
    """Payment lifecycle column (separate from main status per doctrine)."""
    NONE = "none"
    PARTIAL = "partial"
    FULL = "full"


class PlatformInvoiceDisputeStatus(str, enum.Enum):
    """Dispute lifecycle column (separate from main status per doctrine)."""
    NONE = "none"
    DISPUTED = "disputed"
    RESOLVED = "resolved"


class PlatformPaymentStatus(str, enum.Enum):
    """Lifecycle of a Platform Payment (Zoiko receives money from an org).

    PENDING     — checkout session created, awaiting completion.
    PROCESSING  — payment captured, awaiting gateway confirmation.
    CLEARED     — funds confirmed received.
    FAILED      — payment attempt failed.
    CANCELLED   — payment cancelled before completion.
    REFUNDED    — fully refunded via PlatformRefund.
    """
    PENDING = "pending"
    PROCESSING = "processing"
    CLEARED = "cleared"
    FAILED = "failed"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"


class PlatformPaymentMethod(str, enum.Enum):
    """Payment method used for a Platform Payment."""
    CARD = "card"
    ACH = "ach"
    WIRE_TRANSFER = "wire_transfer"
    MANUAL = "manual"


class PlatformCreditNoteStatus(str, enum.Enum):
    """Lifecycle of a Platform Credit Note (Zoiko issues credit to an org).

    DRAFT              — created, not yet approved.
    APPROVED           — approved; ready to apply against invoices.
    ISSUED             — issued to the customer.
    PARTIALLY_APPLIED  — some balance allocated to invoices.
    FULLY_APPLIED      — remaining balance is zero.
    VOIDED             — cancelled after issue; terminal.
    """
    DRAFT = "draft"
    APPROVED = "approved"
    ISSUED = "issued"
    PARTIALLY_APPLIED = "partially_applied"
    FULLY_APPLIED = "fully_applied"
    VOIDED = "voided"


class PlatformRefundStatus(str, enum.Enum):
    """Lifecycle of a Platform Refund (Zoiko returns money to an org).

    DRAFT            — created, not yet submitted.
    PENDING_APPROVAL — awaiting maker-checker approval (separate from creator).
    APPROVED         — approved; ready to process.
    PROCESSING       — refund submitted to gateway.
    COMPLETED        — funds returned successfully.
    FAILED           — refund attempt failed.
    REJECTED         — approver rejected; terminal.
    CANCELLED        — cancelled before processing; terminal.
    """
    DRAFT = "draft"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Commercial Evaluation Program (§B3 — bounded, explicitly-activated
# trial configuration; distinct from the ad-hoc trial_ends_at stamp it replaces)
# ═══════════════════════════════════════════════════════════════════════════════


class CommercialEvaluationPaymentRequirement(str, enum.Enum):
    """Whether a card must be on file before the evaluation period starts."""
    NONE = "none"
    CARD_REQUIRED_UPFRONT = "card_required_upfront"


class CommercialEvaluationConversionPolicy(str, enum.Enum):
    """What happens at the end of the evaluation period.

    MANUAL                 — the org must actively pay; nothing happens
                              automatically.
    AUTO_CHARGE_ON_EXPIRY  — attempt to charge the card on file at expiry.
                              NOT YET IMPLEMENTED by trial_expiry.py — a
                              subscription configured this way is logged/
                              skipped, never silently treated as MANUAL/
                              SUSPEND.
    """
    MANUAL = "manual"
    AUTO_CHARGE_ON_EXPIRY = "auto_charge_on_expiry"


class CommercialEvaluationExpiryAction(str, enum.Enum):
    """What trial_expiry.py does to a subscription whose trial_ends_at has
    passed with no payment (MANUAL conversion_policy) or after a failed
    auto-charge attempt."""
    SUSPEND = "suspend"
    DOWNGRADE = "downgrade"


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Entitlement Catalog (§12–§13, ZB-COM-ENT-001)
# ═══════════════════════════════════════════════════════════════════════════════


class EntitlementValueType(str, enum.Enum):
    """The data type of an entitlement's value column.

    BOOLEAN — true/false feature flag (e.g. billing.invoice.create).
    INTEGER — numeric limit (e.g. billing.invoice.monthly_limit).
    ENUM    — single allowed string value.
    SET     — collection of allowed strings (e.g. currency.enabled.max).
    """
    BOOLEAN = "boolean"
    INTEGER = "integer"
    ENUM = "enum"
    SET = "set"


class EntitlementRiskClassification(str, enum.Enum):
    """Risk classification driving approval requirements (§16.1).

    STANDARD    — normal entitlement; single-approval path.
    HIGH_RISK   — identity/security-adjacent; dual-approval trigger
                  (security.sso, security.custom_roles, api.write).
    """
    STANDARD = "standard"
    HIGH_RISK = "high_risk"


class EntitlementEnforcementType(str, enum.Enum):
    """How the platform enforces this entitlement at runtime (Part 2).

    INFORMATIONAL    — logged only; no blocking.
    SOFT_THEN_HARD   — warn first, then enforce after a grace period.
    THROTTLE         — rate-limit rather than block.
    HARD             — immediate hard block when exceeded.
    """
    INFORMATIONAL = "informational"
    SOFT_THEN_HARD = "soft_then_hard"
    THROTTLE = "throttle"
    HARD = "hard"


class CommercialOverrideStatus(str, enum.Enum):
    """Lifecycle of a CommercialOverride (§16.1, ZB-COM-ENT-001 Part 2).

    DRAFT             — editable, not yet submitted for approval.
    PENDING_APPROVAL  — submitted; awaiting a different user's approval
                        (maker-checker, enforced by ApprovalService).
    APPROVED          — approved and live; the resolver's L3 reads only
                        APPROVED, unexpired rows.
    REJECTED          — declined by the approver; terminal.
    REVOKED           — manually withdrawn after being APPROVED; terminal.
    EXPIRED           — administrative marker for bookkeeping only; the
                        resolver already excludes any APPROVED row whose
                        expires_at has passed without needing this status
                        to be set (no cleanup job required, AC-10).
    """
    DRAFT = "draft"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    REVOKED = "revoked"
    EXPIRED = "expired"


class SubscriptionChangeStatus(str, enum.Enum):
    """Lifecycle of a SubscriptionChange (ZB-COM-ENT-001 Part 3, §7-§8).

    PENDING    — construction-time-only default; every code path that
                 creates a row sets its final status before flush, so this
                 is never actually observed at rest.
    BLOCKED    — an IMMEDIATE downgrade attempt hit a compatibility
                 blocker; recorded (not silently rejected) so it's a real,
                 investigable row in the Super Admin plan-change queue.
    SCHEDULED  — a downgrade queued for effective_at (the subscription's
                 next renewal); the subscription's own status mirrors this
                 via CommercialSubscriptionStatus.SCHEDULED_CHANGE.
    APPLIED    — the plan swap executed (immediately, or by the scheduled
                 sweep at effective_at).
    REVERSED   — a SCHEDULED change was cancelled before effective_at; pure
                 status flip, since nothing financial/entitlement-affecting
                 happens while a change is only SCHEDULED.
    """
    PENDING = "pending"
    BLOCKED = "blocked"
    SCHEDULED = "scheduled"
    APPLIED = "applied"
    REVERSED = "reversed"


class SubscriptionChangeDirection(str, enum.Enum):
    UPGRADE = "upgrade"
    DOWNGRADE = "downgrade"
    EXPIRED = "expired"
