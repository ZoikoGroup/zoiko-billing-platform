"""
modules/commercial/models.py
-----------------------------
Plane 1 (Zoiko Commercial Billing) models:

  - CommercialAccount       — the 1:1 record of "an organization that is a
                              commercial customer of Zoiko" (the tenant that
                              pays for the Billing product itself).
  - CommercialPlan          — a REUSABLE plan template (e.g. STARTER / GROWTH /
                              ENTERPRISE) shared across organizations. Phase 7
                              defines the structure only; NO pricing / limits /
                              entitlements are invented (columns are nullable
                              until an approved catalogue exists).
  - CommercialSubscription  — one organization's current/historical assignment
                              of a CommercialPlan. History is preserved: a new
                              subscription REPLACES the previous one logically
                              (the old row becomes CANCELLED/EXPIRED), rows are
                              never hard-deleted.

  ── Plane 1 transactional billing (new) ───────────────────────────────────
  - CommercialQuote             — Zoiko-to-org quote; no money moves yet.
  - CommercialQuoteItem         — line items on a quote.
  - PlatformInvoice             — Zoiko-invoicing-an-org (NOT a tenant invoice).
  - PlatformInvoiceItem         — line items on a platform invoice.
  - PlatformInvoiceNumberSequence — atomic invoice numbering (separate from
                                    Plane 2's billing_settings.invoice_number).
  - PlatformPayment             — Zoiko-receives-money-from-an-org.
  - PlatformPaymentAllocation   — links a payment to one or more invoices.
  - PlatformCreditNote          — Zoiko-issues-credit-to-an-org.
  - PlatformRefund              — Zoiko-returns-money-to-an-org.

These are deliberately DISTINCT from the Billing module's tenant-facing models
(BillingCustomer / SubscriptionPlan / Subscription / Invoice / ...):
BillingCustomer et al. are org-scoped data a tenant uses to charge ITS OWN
customers (Plane 2). CommercialAccount/Plan/Subscription are the platform-plane
relationship between the org and Zoiko (Plane 1).

Billing source / classification deliberately stay on the Organization
(Phase 1, server-stamped) — the source of truth consumed by the future
double-charge prevention check. They are NOT duplicated here.

DOCTRINE: No foreign key from any commercial_* table may reference a Plane 2
table (billing_customers, invoices, payments, credit_notes, refunds, etc.).
All financial relationships stay within the commercial schema.
"""

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.commercial.enums import (
    CommercialAccountStatus,
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
    CommercialQuoteStatus,
    CommercialSubscriptionStatus,
    PlatformCreditNoteStatus,
    PlatformInvoiceDeliveryStatus,
    PlatformInvoiceDisputeStatus,
    PlatformInvoicePaymentStatus,
    PlatformInvoiceStatus,
    PlatformInvoiceType,
    PlatformPaymentMethod,
    PlatformPaymentStatus,
    PlatformRefundStatus,
)


class CommercialAccount(Base):
    __tablename__ = "commercial_accounts"

    id = Column(Integer, primary_key=True, index=True)
    # Strict 1:1 with the organization — an org must never have two accounts.
    # ondelete=CASCADE matches the org-child pattern used by users/action
    # tokens; the Super Admin org hard-delete also removes this row explicitly.
    organization_id = Column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )

    # Smallest safe lifecycle for Phase 6 (see CommercialAccountStatus):
    # ACTIVE at provisioning; SUSPENDED reserved for a future Super Admin
    # action. PENDING/EXPIRED/CANCELLED arrive with the payment-driven
    # commercial subscription phase.
    status = Column(
        CaseInsensitiveEnum(CommercialAccountStatus),
        default=CommercialAccountStatus.ACTIVE,
        server_default="ACTIVE",
        nullable=False,
    )

    # Captured at registration (§B3): which plan the registrant said they
    # wanted, for Sales/onboarding visibility only. Never used to provision a
    # CommercialSubscription — Phase 7 seeds no plans, so registration still
    # leaves the account without one (see provision_default_subscription).
    intended_plan_code = Column(String(50), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    organization = relationship(
        "Organization",
        back_populates="commercial_account",
        uselist=False,
    )

    subscriptions = relationship(
        "CommercialSubscription",
        back_populates="account",
        # All history is retained; the relationship is a plain 1:N.
        uselist=True,
    )

    def __repr__(self):
        return (
            f"<CommercialAccount id={self.id} "
            f"organization_id={self.organization_id} status={self.status!r}>"
        )


class CommercialPlan(Base):
    __tablename__ = "commercial_plans"

    id = Column(Integer, primary_key=True, index=True)
    # Stable, reusable, globally-unique plan identifier. A plan is a shared
    # template: MANY organizations may be assigned the SAME plan code — there
    # is deliberately no organization_id here.
    plan_code = Column(String(50), unique=True, index=True, nullable=False)
    plan_name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)

    status = Column(
        CaseInsensitiveEnum(CommercialPlanStatus),
        default=CommercialPlanStatus.ACTIVE,
        server_default="ACTIVE",
        nullable=False,
    )

    # Structural marker: the plan that provisioning SHOULD assign automatically
    # when it exists. Phase 7 seeds NO plans, so registration leaves the
    # subscription absent unless an approved default plan is flagged later.
    is_default = Column(Boolean, default=False, nullable=False)

    # ── Pricing (PHASE 7: STRUCTURE ONLY — values NOT invented) ──────────────
    # These stay NULL until an approved catalogue defines them.
    billing_interval = Column(CaseInsensitiveEnum(CommercialBillingInterval), nullable=True)
    currency = Column(String(3), nullable=True)          # ISO-4217
    price_amount = Column(Numeric(14, 2), nullable=True)  # matching billing Numeric scale

    # ── Plan availability window ──────────────────────────────────────────────
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)

    # ── Entitlement structure (reference uses JSON features on the
    #    subscription; a reusable plan owns its entitlements, so they live
    #    here. Nullable / unset in Phase 7 — nothing invented.) ───────────────
    max_users = Column(Integer, nullable=True)
    max_storage_gb = Column(Integer, nullable=True)
    features = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    subscriptions = relationship("CommercialSubscription", back_populates="plan")

    def __repr__(self):
        return (
            f"<CommercialPlan id={self.id} plan_code={self.plan_code!r} "
            f"status={self.status!r}>"
        )


class CommercialPlanVersion(Base):
    """Immutable-once-published catalog snapshot (ZB-COM-BILL-001 §T1, Phase 4).

    A CommercialPlan is the stable, reusable identity (plan_code/plan_name);
    a CommercialPlanVersion is a versioned, point-in-time snapshot of its
    priceable/entitlement fields. Editing a PUBLISHED price/limit is
    prohibited — create a new version instead. Historical subscriptions keep
    referencing their original catalog_version_id so past invoices/entitlements
    remain reproducible even after the plan's live version changes.

    No prices are invented here: fields stay NULL exactly like CommercialPlan
    until an approved catalog supplies them.
    """

    __tablename__ = "commercial_plan_versions"

    id = Column(Integer, primary_key=True, index=True)
    plan_id = Column(
        Integer,
        ForeignKey("commercial_plans.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # 1, 2, 3... per plan_id — assigned atomically by the service, never reused.
    version_number = Column(Integer, nullable=False)

    status = Column(
        CaseInsensitiveEnum(CommercialPlanVersionStatus),
        default=CommercialPlanVersionStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
    )

    # ── Versioned snapshot fields (structure only — no invented values) ──────
    plan_name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    billing_interval = Column(CaseInsensitiveEnum(CommercialBillingInterval), nullable=True)
    currency = Column(String(3), nullable=True)
    price_amount = Column(Numeric(14, 2), nullable=True)
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)
    max_users = Column(Integer, nullable=True)
    max_storage_gb = Column(Integer, nullable=True)
    features = Column(JSON, nullable=True)

    # ── Maker-checker linkage ────────────────────────────────────────────────
    created_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approval_request_id = Column(Integer, ForeignKey("approval_requests.id", ondelete="SET NULL"), nullable=True)
    published_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    plan = relationship("CommercialPlan", backref="versions")

    def __repr__(self):
        return (
            f"<CommercialPlanVersion id={self.id} plan_id={self.plan_id} "
            f"v{self.version_number} status={self.status!r}>"
        )


class CommercialSubscription(Base):
    __tablename__ = "commercial_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    commercial_account_id = Column(
        Integer,
        ForeignKey("commercial_accounts.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    commercial_plan_id = Column(
        Integer,
        ForeignKey("commercial_plans.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    # Nullable: existing/historical subscriptions predate catalog versioning
    # and reference commercial_plan_id only. New subscriptions record the
    # specific PUBLISHED version they were created against (ZB-COM-BILL-001
    # §T1 — "every subscription must retain catalog_version_id").
    catalog_version_id = Column(
        Integer,
        ForeignKey("commercial_plan_versions.id", ondelete="RESTRICT"),
        index=True,
        nullable=True,
    )

    status = Column(
        CaseInsensitiveEnum(CommercialSubscriptionStatus),
        default=CommercialSubscriptionStatus.PENDING,
        server_default="PENDING",
        nullable=False,
    )

    start_at = Column(DateTime, nullable=True)
    end_at = Column(DateTime, nullable=True)
    current_period_start = Column(DateTime, nullable=True)
    current_period_end = Column(DateTime, nullable=True)

    # N1: set when a Plane-1 (Zoiko's own subscription) payment fails; cleared
    # on the N3 restoration path when payment succeeds again. Drives
    # CommercialDunningService's day 0/10/20/45 sweep — entirely independent
    # of Plane-2's tenant-facing dunning (N4).
    payment_failed_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    account = relationship("CommercialAccount", back_populates="subscriptions")
    plan = relationship("CommercialPlan", back_populates="subscriptions")

    def __repr__(self):
        return (
            f"<CommercialSubscription id={self.id} "
            f"account_id={self.commercial_account_id} status={self.status!r}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Commercial Quote
# ═══════════════════════════════════════════════════════════════════════════════


class CommercialQuote(Base):
    """Zoiko-to-org quote. No money moves until converted to a PlatformInvoice.

    FKs point ONLY to commercial_accounts / commercial_subscriptions / users.
    Never references Plane 2 tables.
    """

    __tablename__ = "commercial_quotes"

    id = Column(Integer, primary_key=True, index=True)
    commercial_account_id = Column(
        Integer,
        ForeignKey("commercial_accounts.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    commercial_subscription_id = Column(
        Integer,
        ForeignKey("commercial_subscriptions.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )

    quote_number = Column(String(50), nullable=False)
    status = Column(
        CaseInsensitiveEnum(CommercialQuoteStatus),
        default=CommercialQuoteStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
        index=True,
    )

    subject = Column(String(500), nullable=True)
    notes = Column(Text, nullable=True)
    terms = Column(Text, nullable=True)

    # ── Money fields (mirrored at invoice-finalize from line items) ────────
    subtotal = Column(Numeric(14, 2), default=0, nullable=False)
    discount_amount = Column(Numeric(14, 2), default=0, nullable=False)
    discount_reason = Column(Text, nullable=True)
    discount_approver_id = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    tax_amount = Column(Numeric(14, 2), default=0, nullable=False)
    total_amount = Column(Numeric(14, 2), default=0, nullable=False)
    currency = Column(String(3), default="USD", nullable=False)

    # ── Lifecycle timestamps ────────────────────────────────────────────────
    valid_until = Column(Date, nullable=True)
    public_token = Column(String(64), unique=True, index=True, nullable=True)

    # ── Conversion linkage ──────────────────────────────────────────────────
    converted_platform_invoice_id = Column(
        Integer,
        ForeignKey("platform_invoices.id", ondelete="SET NULL"),
        nullable=True,
    )
    converted_subscription_id = Column(
        Integer,
        ForeignKey("commercial_subscriptions.id", ondelete="SET NULL"),
        nullable=True,
    )

    # ── Audit ───────────────────────────────────────────────────────────────
    created_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # ── Relationships ───────────────────────────────────────────────────────
    account = relationship("CommercialAccount", backref="quotes")
    subscription = relationship("CommercialSubscription", foreign_keys=[commercial_subscription_id])
    items = relationship("CommercialQuoteItem", back_populates="quote", cascade="all, delete-orphan")
    converted_invoice = relationship("PlatformInvoice", foreign_keys=[converted_platform_invoice_id])

    __table_args__ = (
        UniqueConstraint("commercial_account_id", "quote_number", name="uq_cquotes_acct_number"),
        CheckConstraint("subtotal >= 0", name="ck_cquotes_subtotal"),
        CheckConstraint("total_amount >= 0", name="ck_cquotes_total"),
    )

    def __repr__(self):
        return (
            f"<CommercialQuote id={self.id} number={self.quote_number!r} "
            f"status={self.status!r}>"
        )


class CommercialQuoteItem(Base):
    """Line item on a CommercialQuote."""

    __tablename__ = "commercial_quote_items"

    id = Column(Integer, primary_key=True, index=True)
    quote_id = Column(
        Integer,
        ForeignKey("commercial_quotes.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    line_number = Column(Integer, nullable=False)
    description = Column(String(1000), nullable=False)
    quantity = Column(Numeric(12, 2), default=1, nullable=False)
    unit_price = Column(Numeric(16, 4), nullable=False)
    discount_amount = Column(Numeric(14, 2), default=0, nullable=False)
    tax_amount = Column(Numeric(14, 2), default=0, nullable=False)
    total = Column(Numeric(14, 2), nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)

    quote = relationship("CommercialQuote", back_populates="items")

    __table_args__ = (
        UniqueConstraint("quote_id", "line_number", name="uq_cquote_items_quote_line"),
        CheckConstraint("quantity > 0", name="ck_cquote_items_qty"),
        CheckConstraint("unit_price >= 0", name="ck_cquote_items_price"),
    )

    def __repr__(self):
        return (
            f"<CommercialQuoteItem id={self.id} quote={self.quote_id} "
            f"line={self.line_number}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Platform Invoice
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformInvoiceNumberSequence(Base):
    """Atomic sequence for platform invoice numbering.

    Separate from Plane 2's billing_settings.invoice_number. The prefix
    defaults to 'PINV-' to visually distinguish platform invoices.
    """

    __tablename__ = "platform_invoice_number_sequences"

    id = Column(Integer, primary_key=True, index=True)
    prefix = Column(String(20), default="PINV-", nullable=False)
    next_number = Column(Integer, default=1, nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    def __repr__(self):
        return (
            f"<PlatformInvoiceNumberSequence prefix={self.prefix!r} "
            f"next={self.next_number}>"
        )


class PlatformInvoice(Base):
    """Zoiko-invoicing-an-org. The financial source of truth for Plane 1.

    Delivery/payment/dispute are separate columns — NOT merged into a single
    status field — per the Two-Plane Billing Doctrine.

    FKs point ONLY to commercial_accounts / commercial_subscriptions / users.
    Never references Plane 2 tables (invoices, billing_customers, etc.).
    """

    __tablename__ = "platform_invoices"

    id = Column(Integer, primary_key=True, index=True)
    commercial_account_id = Column(
        Integer,
        ForeignKey("commercial_accounts.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    commercial_subscription_id = Column(
        Integer,
        ForeignKey("commercial_subscriptions.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )

    invoice_number = Column(String(50), unique=True, index=True, nullable=True)
    status = Column(
        CaseInsensitiveEnum(PlatformInvoiceStatus),
        default=PlatformInvoiceStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
        index=True,
    )
    invoice_type = Column(
        CaseInsensitiveEnum(PlatformInvoiceType),
        default=PlatformInvoiceType.STANDARD,
        server_default="STANDARD",
        nullable=False,
        index=True,
    )

    issue_date = Column(Date, nullable=True)
    due_date = Column(Date, nullable=True, index=True)

    # ── Money fields ────────────────────────────────────────────────────────
    subtotal = Column(Numeric(14, 2), default=0, nullable=False)
    discount_amount = Column(Numeric(14, 2), default=0, nullable=False)
    tax_amount = Column(Numeric(14, 2), default=0, nullable=False)
    total_amount = Column(Numeric(14, 2), default=0, nullable=False)
    paid_amount = Column(Numeric(14, 2), default=0, nullable=False)
    balance_due = Column(Numeric(14, 2), default=0, nullable=False)
    currency = Column(String(3), default="USD", nullable=False)

    # ── Separate lifecycle columns (not merged into status) ─────────────────
    delivery_status = Column(
        CaseInsensitiveEnum(PlatformInvoiceDeliveryStatus),
        default=PlatformInvoiceDeliveryStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
    )
    payment_status = Column(
        CaseInsensitiveEnum(PlatformInvoicePaymentStatus),
        default=PlatformInvoicePaymentStatus.NONE,
        server_default="NONE",
        nullable=False,
    )
    dispute_status = Column(
        CaseInsensitiveEnum(PlatformInvoiceDisputeStatus),
        default=PlatformInvoiceDisputeStatus.NONE,
        server_default="NONE",
        nullable=False,
    )

    # ── Lifecycle timestamps ────────────────────────────────────────────────
    sent_at = Column(DateTime, nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    delivery_failed_at = Column(DateTime, nullable=True)
    paid_at = Column(DateTime, nullable=True)
    voided_at = Column(DateTime, nullable=True)
    voided_reason = Column(Text, nullable=True)

    notes = Column(Text, nullable=True)

    # Signed link for the org to view/pay this invoice with no login —
    # mirrors CommercialQuote.public_token. Generated on first send().
    public_token = Column(String(64), unique=True, index=True, nullable=True)

    # ── Audit ───────────────────────────────────────────────────────────────
    created_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # ── Relationships ───────────────────────────────────────────────────────
    account = relationship("CommercialAccount", backref="platform_invoices")
    subscription = relationship("CommercialSubscription", foreign_keys=[commercial_subscription_id])
    items = relationship("PlatformInvoiceItem", back_populates="invoice", cascade="all, delete-orphan")
    allocations = relationship("PlatformPaymentAllocation", back_populates="invoice")

    __table_args__ = (
        CheckConstraint("subtotal >= 0", name="ck_pinvoices_subtotal"),
        CheckConstraint("total_amount >= 0", name="ck_pinvoices_total"),
        CheckConstraint("paid_amount >= 0", name="ck_pinvoices_paid"),
    )

    def __repr__(self):
        return (
            f"<PlatformInvoice id={self.id} number={self.invoice_number!r} "
            f"status={self.status!r}>"
        )


class PlatformInvoiceItem(Base):
    """Line item on a PlatformInvoice."""

    __tablename__ = "platform_invoice_items"

    id = Column(Integer, primary_key=True, index=True)
    platform_invoice_id = Column(
        Integer,
        ForeignKey("platform_invoices.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    line_number = Column(Integer, nullable=False)
    description = Column(String(1000), nullable=False)
    quantity = Column(Numeric(12, 2), default=1, nullable=False)
    unit_price = Column(Numeric(16, 4), nullable=False)
    discount_amount = Column(Numeric(14, 2), default=0, nullable=False)
    tax_amount = Column(Numeric(14, 2), default=0, nullable=False)
    total = Column(Numeric(14, 2), nullable=False)

    invoice = relationship("PlatformInvoice", back_populates="items")

    __table_args__ = (
        UniqueConstraint("platform_invoice_id", "line_number", name="uq_pinvoice_items_inv_line"),
        CheckConstraint("quantity > 0", name="ck_pinvoice_items_qty"),
        CheckConstraint("unit_price >= 0", name="ck_pinvoice_items_price"),
    )

    def __repr__(self):
        return (
            f"<PlatformInvoiceItem id={self.id} invoice={self.platform_invoice_id} "
            f"line={self.line_number}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Platform Payment
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformPayment(Base):
    """Zoiko-receives-money-from-an-org.

    Runtime assertion: processor_account_identity must always equal Zoiko's
    platform processor identity. This is enforced in the service layer —
    never a tenant's processor ID.
    """

    __tablename__ = "platform_payments"

    id = Column(Integer, primary_key=True, index=True)
    commercial_account_id = Column(
        Integer,
        ForeignKey("commercial_accounts.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )

    payment_number = Column(String(50), unique=True, index=True, nullable=False)
    transaction_id = Column(String(255), nullable=True)

    status = Column(
        CaseInsensitiveEnum(PlatformPaymentStatus),
        default=PlatformPaymentStatus.PENDING,
        server_default="PENDING",
        nullable=False,
        index=True,
    )

    amount = Column(Numeric(14, 2), nullable=False)
    currency = Column(String(3), default="USD", nullable=False)
    payment_method = Column(
        CaseInsensitiveEnum(PlatformPaymentMethod),
        nullable=True,
    )

    gateway_payment_intent_id = Column(String(255), nullable=True, index=True)
    gateway_checkout_session_id = Column(String(255), nullable=True, index=True)

    cleared_at = Column(DateTime, nullable=True)
    failure_reason = Column(Text, nullable=True)

    # ── Runtime processor assertion ─────────────────────────────────────────
    # MUST always equal ZOIKO_PLATFORM_PROCESSOR_IDENTITY. Enforced in
    # PlatformPaymentService.record(). Never a tenant's processor.
    processor_account_identity = Column(String(255), nullable=False)

    notes = Column(Text, nullable=True)

    # ── Audit ───────────────────────────────────────────────────────────────
    created_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # ── Relationships ───────────────────────────────────────────────────────
    account = relationship("CommercialAccount", backref="platform_payments")
    allocations = relationship("PlatformPaymentAllocation", back_populates="payment")

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_ppayments_amount"),
    )

    def __repr__(self):
        return (
            f"<PlatformPayment id={self.id} number={self.payment_number!r} "
            f"status={self.status!r}>"
        )


class PlatformPaymentAllocation(Base):
    """Links a PlatformPayment to one or more PlatformInvoices."""

    __tablename__ = "platform_payment_allocations"

    id = Column(Integer, primary_key=True, index=True)
    platform_payment_id = Column(
        Integer,
        ForeignKey("platform_payments.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    platform_invoice_id = Column(
        Integer,
        ForeignKey("platform_invoices.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    amount = Column(Numeric(14, 2), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    payment = relationship("PlatformPayment", back_populates="allocations")
    invoice = relationship("PlatformInvoice", back_populates="allocations")

    __table_args__ = (
        UniqueConstraint(
            "platform_payment_id",
            "platform_invoice_id",
            name="uq_ppalloc_payment_invoice",
        ),
        CheckConstraint("amount > 0", name="ck_ppalloc_amount"),
    )

    def __repr__(self):
        return (
            f"<PlatformPaymentAllocation id={self.id} "
            f"payment={self.platform_payment_id} "
            f"invoice={self.platform_invoice_id}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Platform Credit Note
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformCreditNote(Base):
    """Zoiko-issues-credit-to-an-org.

    approved_by is always a DIFFERENT user than created_by (maker-checker).
    Enforced in the service layer.
    """

    __tablename__ = "platform_credit_notes"

    id = Column(Integer, primary_key=True, index=True)
    commercial_account_id = Column(
        Integer,
        ForeignKey("commercial_accounts.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    platform_invoice_id = Column(
        Integer,
        ForeignKey("platform_invoices.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )

    credit_note_number = Column(String(50), unique=True, index=True, nullable=False)
    status = Column(
        CaseInsensitiveEnum(PlatformCreditNoteStatus),
        default=PlatformCreditNoteStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
        index=True,
    )
    reason = Column(Text, nullable=True)

    # ── Money fields ────────────────────────────────────────────────────────
    subtotal = Column(Numeric(14, 2), default=0, nullable=False)
    discount_amount = Column(Numeric(14, 2), default=0, nullable=False)
    tax_amount = Column(Numeric(14, 2), default=0, nullable=False)
    total_amount = Column(Numeric(14, 2), nullable=False)
    remaining_amount = Column(Numeric(14, 2), nullable=False)
    currency = Column(String(3), default="USD", nullable=False)

    # ── Approval (maker-checker) ────────────────────────────────────────────
    approved_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at = Column(DateTime, nullable=True)

    issued_at = Column(DateTime, nullable=True)
    voided_at = Column(DateTime, nullable=True)
    voided_reason = Column(Text, nullable=True)

    # ── Audit ───────────────────────────────────────────────────────────────
    created_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # ── Relationships ───────────────────────────────────────────────────────
    account = relationship("CommercialAccount", backref="credit_notes")
    invoice = relationship("PlatformInvoice", foreign_keys=[platform_invoice_id])

    __table_args__ = (
        CheckConstraint("total_amount > 0", name="ck_pcredit_notes_total"),
    )

    def __repr__(self):
        return (
            f"<PlatformCreditNote id={self.id} number={self.credit_note_number!r} "
            f"status={self.status!r}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Platform Refund
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformRefund(Base):
    """Zoiko-returns-money-to-an-org.

    approved_by is always a DIFFERENT user than created_by (maker-checker).
    Enforced in the service layer.
    """

    __tablename__ = "platform_refunds"

    id = Column(Integer, primary_key=True, index=True)
    commercial_account_id = Column(
        Integer,
        ForeignKey("commercial_accounts.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    platform_invoice_id = Column(
        Integer,
        ForeignKey("platform_invoices.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    platform_payment_id = Column(
        Integer,
        ForeignKey("platform_payments.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    platform_credit_note_id = Column(
        Integer,
        ForeignKey("platform_credit_notes.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )

    refund_number = Column(String(50), unique=True, index=True, nullable=False)
    status = Column(
        CaseInsensitiveEnum(PlatformRefundStatus),
        default=PlatformRefundStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
        index=True,
    )

    amount = Column(Numeric(14, 2), nullable=False)
    currency = Column(String(3), default="USD", nullable=False)
    reason = Column(Text, nullable=True)

    # ── Approval (maker-checker) ────────────────────────────────────────────
    approved_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at = Column(DateTime, nullable=True)

    completed_at = Column(DateTime, nullable=True)
    failure_reason = Column(Text, nullable=True)

    # ── Audit ───────────────────────────────────────────────────────────────
    created_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # ── Relationships ───────────────────────────────────────────────────────
    account = relationship("CommercialAccount", backref="refunds")
    invoice = relationship("PlatformInvoice", foreign_keys=[platform_invoice_id])
    payment = relationship("PlatformPayment", foreign_keys=[platform_payment_id])
    credit_note = relationship("PlatformCreditNote", foreign_keys=[platform_credit_note_id])

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_prefunds_amount"),
    )

    def __repr__(self):
        return (
            f"<PlatformRefund id={self.id} number={self.refund_number!r} "
            f"status={self.status!r}>"
        )
