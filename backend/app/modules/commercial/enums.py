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

    PENDING    — created awaiting activation (no approved default plan at
                 registration, or awaiting payment confirmation).
    ACTIVE     — live; the org is entitled to the plan.
    PAST_DUE   — N1 day 0: a Plane-1 (Zoiko's own subscription) payment
                 failed. Entitlements unaffected so far.
    RESTRICTED — N1 day 10: blocks new paid expansion only; existing
                 entitlements keep working.
    SUSPENDED  — N1 day 20 (also settable by a Super Admin action directly):
                 read-only — never deletes records (N2).
    CANCELLED  — terminal; preserved for audit/history. N1 day 45 (dunning
                 "termination") lands here, not a hard delete.
    EXPIRED    — terminal; period ended without renewal; preserved.
    """
    PENDING = "pending"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    RESTRICTED = "restricted"
    SUSPENDED = "suspended"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


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
