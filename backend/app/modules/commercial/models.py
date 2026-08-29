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
    CommercialEvaluationConversionPolicy,
    CommercialEvaluationExpiryAction,
    CommercialEvaluationPaymentRequirement,
    CommercialOverrideStatus,
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
    CommercialQuoteStatus,
    CommercialSubscriptionStatus,
    EntitlementEnforcementType,
    SubscriptionChangeDirection,
    SubscriptionChangeStatus,
    EntitlementRiskClassification,
    EntitlementValueType,
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
    # wanted. For essentials/professional/business this is now the plan
    # provision_default_subscription() actually assigns (falling back to the
    # is_default plan if it doesn't resolve to an ACTIVE, non-quote-only
    # plan). Kept on the account regardless, for Sales/onboarding visibility.
    intended_plan_code = Column(String(50), nullable=True)

    # Stripe Customer id under ZOIKO's own Stripe account — never a tenant's
    # StripeConnectedAccount. One per org, created lazily on first checkout
    # (PlatformStripeService.get_or_create_customer).
    stripe_customer_id = Column(String(255), nullable=True, index=True)

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

    # Enterprise-tier marker: price is quote/order-form controlled (§2) — this
    # plan may never be auto-provisioned by self-serve registration or picked
    # up by provision_default_subscription's is_default lookup, even if it
    # were ever mistakenly flagged is_default.
    is_quote_only = Column(Boolean, default=False, server_default="0", nullable=False)

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

    # Seeded pricing that has NOT been through Finance/legal approval yet —
    # distinguishes a real approved catalog from placeholder numbers so
    # /production-acceptance's COM-01 check never reports PASS on invented
    # prices (see scripts/seed_commercial_plans.py).
    is_placeholder_pricing = Column(Boolean, default=False, server_default="0", nullable=False)

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


class EntitlementDefinition(Base):
    """§12–§13 — typed entitlement key registry for the commercial catalog.

    Each row is a single entitlement key (e.g. billing.invoice.create) with
    its value type, risk classification, and enforcement type. This replaces
    the untyped CommercialPlan.features JSON blob with a queryable, seeded
    catalog that CommercialEntitlementService methods can resolve against.
    """

    __tablename__ = "entitlement_definitions"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(200), unique=True, index=True, nullable=False)
    value_type = Column(
        CaseInsensitiveEnum(EntitlementValueType),
        nullable=False,
    )
    risk_classification = Column(
        CaseInsensitiveEnum(EntitlementRiskClassification),
        default=EntitlementRiskClassification.STANDARD,
        server_default="STANDARD",
        nullable=False,
    )
    enforcement_type = Column(
        CaseInsensitiveEnum(EntitlementEnforcementType),
        default=EntitlementEnforcementType.HARD,
        server_default="HARD",
        nullable=False,
    )
    description = Column(Text, nullable=True)
    # §16.1 Level 1 (legal/security prohibition) — a permanent, per-key deny
    # that survives even an ENTITLEMENT_ENFORCEMENT kill-switch pause (Part
    # 2 L1, checked before L2). Kept separate from BillingKillSwitch on
    # purpose: every kill-switch scope carries a mandatory bounded
    # expires_at (auto-lifts within 14 days, §9.1) — the right shape for
    # "pause while we investigate", the wrong shape for "this key is
    # permanently, legally prohibited" which must never silently auto-lift.
    is_globally_disabled = Column(Boolean, default=False, server_default="0", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return (
            f"<EntitlementDefinition id={self.id} key={self.key!r} "
            f"value_type={self.value_type!r}>"
        )


class PlanEntitlement(Base):
    """§13 — binds an EntitlementDefinition to a CommercialPlanVersion with a
    concrete value. One row per (plan_version, entitlement_key).

    For Enterprise plans, is_contracted=True and value=NULL indicate the
    entitlement is governed by the signed order form, not this catalog row.
    """

    __tablename__ = "plan_entitlements"

    id = Column(Integer, primary_key=True, index=True)
    plan_version_id = Column(
        Integer,
        ForeignKey("commercial_plan_versions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    entitlement_definition_id = Column(
        Integer,
        ForeignKey("entitlement_definitions.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    value = Column(JSON, nullable=True)
    is_contracted = Column(Boolean, default=False, server_default="0", nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    plan_version = relationship("CommercialPlanVersion", backref="plan_entitlements")
    entitlement_definition = relationship("EntitlementDefinition")

    __table_args__ = (
        UniqueConstraint(
            "plan_version_id",
            "entitlement_definition_id",
            name="uq_plan_entitlements_version_definition",
        ),
    )

    def __repr__(self):
        return (
            f"<PlanEntitlement id={self.id} version={self.plan_version_id} "
            f"definition={self.entitlement_definition_id} contracted={self.is_contracted}>"
        )


class CommercialEvaluationProgram(Base):
    """§B3 — a bounded, explicitly-activated trial/evaluation configuration
    for exactly one plan. No program existing (or none with is_active=True)
    is the default state: self-serve registration then grants NO trial —
    trial_ends_at stays NULL. Creating a row here is a deliberate future
    business decision this fix does not make on the codebase's behalf (no
    row is seeded).

    is_active is the explicit on/off switch, independent of row existence —
    a program can be configured, reviewed, and left OFF, or deactivated
    later without deleting its (auditable) history."""

    __tablename__ = "commercial_evaluation_programs"

    id = Column(Integer, primary_key=True, index=True)
    plan_id = Column(
        Integer,
        ForeignKey("commercial_plans.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    is_active = Column(Boolean, default=False, server_default="0", nullable=False)
    duration_days = Column(Integer, nullable=False)
    payment_requirement = Column(
        CaseInsensitiveEnum(CommercialEvaluationPaymentRequirement),
        default=CommercialEvaluationPaymentRequirement.NONE,
        server_default="NONE",
        nullable=False,
    )
    conversion_policy = Column(
        CaseInsensitiveEnum(CommercialEvaluationConversionPolicy),
        default=CommercialEvaluationConversionPolicy.MANUAL,
        server_default="MANUAL",
        nullable=False,
    )
    expiry_action = Column(
        CaseInsensitiveEnum(CommercialEvaluationExpiryAction),
        default=CommercialEvaluationExpiryAction.SUSPEND,
        server_default="SUSPEND",
        nullable=False,
    )

    # §B3 governance: an active program must be traceable to who configured
    # it and who signed off — COM-02 (production-acceptance) fails an active
    # program with no approved_by.
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # §5: the plan whose entitlement bundle is GRANTED during the trial.
    # Separate from plan_id (which plan's signup triggers the program).
    # Per §5, the standard trial grants Professional's entitlement bundle
    # regardless of which plan the org signed up under.
    granted_plan_id = Column(
        Integer,
        ForeignKey("commercial_plans.id", ondelete="RESTRICT"),
        nullable=True,
    )

    plan = relationship("CommercialPlan", backref="evaluation_programs", foreign_keys=[plan_id])
    granted_plan = relationship("CommercialPlan", foreign_keys=[granted_plan_id])

    def __repr__(self):
        return (
            f"<CommercialEvaluationProgram id={self.id} plan_id={self.plan_id} "
            f"is_active={self.is_active} duration_days={self.duration_days}>"
        )


class CommercialEvaluationProgramCap(Base):
    """§5 — per-entitlement cap configuration for an evaluation program.

    One row per capped key (not a JSON blob), so caps stay typed and
    queryable. These exist as configuration a platform_administrator could
    activate, NOT as something live out of the box (is_active=False by
    default on the parent program).
    """

    __tablename__ = "commercial_evaluation_program_caps"

    id = Column(Integer, primary_key=True, index=True)
    evaluation_program_id = Column(
        Integer,
        ForeignKey("commercial_evaluation_programs.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    entitlement_definition_id = Column(
        Integer,
        ForeignKey("entitlement_definitions.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    cap_value = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    evaluation_program = relationship("CommercialEvaluationProgram", backref="caps")
    entitlement_definition = relationship("EntitlementDefinition")

    __table_args__ = (
        UniqueConstraint(
            "evaluation_program_id",
            "entitlement_definition_id",
            name="uq_eval_caps_program_definition",
        ),
    )

    def __repr__(self):
        return (
            f"<CommercialEvaluationProgramCap id={self.id} "
            f"program={self.evaluation_program_id} "
            f"definition={self.entitlement_definition_id}>"
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

    # Self-serve free-trial deadline (§B3): set ONLY when
    # provision_default_subscription() finds an is_active=True
    # CommercialEvaluationProgram for the resolved plan — NOT unconditional.
    # NULL is the default/expected value for every subscription unless a
    # program has been explicitly configured and activated for its plan.
    # Drives commercial/tasks/trial_expiry.py.
    trial_ends_at = Column(DateTime, nullable=True)

    # Snapshot of the CommercialEvaluationProgram's policy fields at the
    # moment it applied — copied rather than re-resolved via a live FK so a
    # program that's later edited/deactivated can't retroactively change the
    # terms a subscription already committed to. NULL together with
    # trial_ends_at whenever no program applied.
    evaluation_payment_requirement = Column(
        CaseInsensitiveEnum(CommercialEvaluationPaymentRequirement), nullable=True,
    )
    evaluation_conversion_policy = Column(
        CaseInsensitiveEnum(CommercialEvaluationConversionPolicy), nullable=True,
    )
    evaluation_expiry_action = Column(
        CaseInsensitiveEnum(CommercialEvaluationExpiryAction), nullable=True,
    )

    # §5: recovery window end — computed as trial_ends_at + 14 days whenever
    # trial_ends_at is set. The recovery-window *behavior* is a Part 2
    # enforcement concern; this pass only computes and stores the value.
    recovery_ends_at = Column(DateTime, nullable=True)

    # §5: snapshot of the granted entitlement bundle from the trial program's
    # granted_plan_id PlanEntitlement rows. Stored as JSON because Part 2's
    # EntitlementSnapshot model will supersede it; this pass just captures
    # the data at trial-grant time.
    trial_granted_entitlements = Column(JSON, nullable=True)

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

    # Part 2 (§16.1) — lets an Enterprise quote explicitly grant/override an
    # entitlement key as a negotiated line item, without a bigger quote-model
    # rewrite. Nullable: most quote line items are ordinary priced items with
    # no entitlement meaning. Acceptance of the quote drafts (DRAFT only, not
    # auto-approved) a CommercialOverride per non-null row — see
    # CommercialQuoteService.draft_overrides_from_quote_items.
    entitlement_definition_id = Column(
        Integer,
        ForeignKey("entitlement_definitions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    entitlement_value = Column(JSON, nullable=True)

    quote = relationship("CommercialQuote", back_populates="items")
    entitlement_definition = relationship("EntitlementDefinition")

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


class PlatformInvoiceDeliveryAttempt(Base):
    """Append-only delivery evidence for a PlatformInvoice send (§E5).

    One row per send attempt (success or failure) — never overwritten, unlike
    the scalar sent_at/delivered_at/delivery_failed_at columns on
    PlatformInvoice which only capture the latest state. Evidence of delivery
    only: never records that the recipient read or accepted the invoice.
    """

    __tablename__ = "platform_invoice_delivery_attempts"

    id = Column(Integer, primary_key=True, index=True)
    platform_invoice_id = Column(
        Integer,
        ForeignKey("platform_invoices.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    channel = Column(String(30), default="email", nullable=False)
    provider = Column(String(100), nullable=True)
    attempted_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    result = Column(String(20), nullable=False)  # "success" | "failure"
    error_detail = Column(Text, nullable=True)

    invoice = relationship("PlatformInvoice", backref="delivery_attempts")

    def __repr__(self):
        return (
            f"<PlatformInvoiceDeliveryAttempt id={self.id} "
            f"invoice={self.platform_invoice_id} result={self.result!r}>"
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


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Platform Stripe Event (webhook idempotency)
# ═══════════════════════════════════════════════════════════════════════════════


class PlatformStripeEvent(Base):
    """One row per Stripe event id processed by the Plane-1 webhook handler
    (POST /api/commercial/stripe/webhook). Entirely separate from Plane 2's
    billing_* stripe_events table/webhook/secret — a re-delivered event is
    skipped and the original outcome returned, same idempotency guarantee as
    Plane 2's StripeEvent, on an isolated table."""

    __tablename__ = "platform_stripe_events"

    id = Column(Integer, primary_key=True, index=True)
    stripe_event_id = Column(String(255), unique=True, index=True, nullable=False)
    event_type = Column(String(100), nullable=False, index=True)
    status = Column(String(20), nullable=False, default="processed")
    payload = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    received_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    processed_at = Column(DateTime(timezone=True), nullable=True)

    def __repr__(self):
        return (
            f"<PlatformStripeEvent id={self.id} "
            f"stripe_event_id={self.stripe_event_id!r} status={self.status!r}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Entitlement Enforcement (ZB-COM-ENT-001 Part 2)
# ═══════════════════════════════════════════════════════════════════════════════


class EntitlementSnapshot(Base):
    """Materialized read cache of an org's resolved entitlements (§11.1, §13).

    One row per organization (unique), overwritten on every recompute — a
    cache, not an audit trail. History of *why* an entitlement changed
    already lives in PlanEntitlement / CommercialOverride / subscription
    rows plus the platform audit trail. Recomputed synchronously whenever a
    subscription is created/activated/transitioned, an override is
    approved/revoked, or provisioning completes (see
    EntitlementSnapshotService.recompute_snapshot and its call sites in
    CommercialSubscriptionService) — a stale snapshot after a known state
    change is a correctness bug, not just UX lag.

    `values` shape: {key: {"value", "value_type", "is_contracted", "source"}}.
    A key absent from `values` means "not resolvable at snapshot time" — the
    resolver falls through to a live lookup (L6), never to an error.
    """

    __tablename__ = "entitlement_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )
    commercial_subscription_id = Column(
        Integer,
        ForeignKey("commercial_subscriptions.id", ondelete="SET NULL"),
        nullable=True,
    )
    values = Column(JSON, nullable=False, default=dict)
    computed_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    computed_reason = Column(String(100), nullable=True)
    # ZB-COM-ENT-001 Part 3 (AC-03) — incremented by EntitlementSnapshotService
    # on every recompute. This row is still overwritten in place (not an
    # append-only history table); the counter exists purely so a caller can
    # assert "exactly one recompute happened" across a transaction (e.g. a
    # plan-change commit), not to reconstruct historical values.
    snapshot_version = Column(Integer, default=0, server_default="0", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return (
            f"<EntitlementSnapshot id={self.id} organization_id={self.organization_id} "
            f"computed_at={self.computed_at!r} snapshot_version={self.snapshot_version}>"
        )


class CommercialOverride(Base):
    """§16.1 — a per-org, per-entitlement override of the plan's default
    value, with maker-checker approval (via the generic ApprovalRequest/
    ApprovalService mechanism, not a bespoke self-approval check here).

    No unique constraint on (organization_id, entitlement_definition_id):
    history of rejected/expired/revoked overrides is preserved, the same
    way CommercialSubscription preserves CANCELLED rows. "At most one live
    APPROVED override per org+key" is enforced in CommercialOverrideService
    (check-then-raise), not a DB constraint, since a DB constraint can't
    express "APPROVED and not expired".

    The resolver's L3 reads only status == APPROVED and
    (expires_at IS NULL OR expires_at > now()) — an expired override simply
    stops matching with no cleanup step required (AC-10).
    """

    __tablename__ = "commercial_overrides"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False,
    )
    entitlement_definition_id = Column(
        Integer, ForeignKey("entitlement_definitions.id", ondelete="RESTRICT"), index=True, nullable=False,
    )
    value = Column(JSON, nullable=True)
    reason = Column(Text, nullable=False)
    status = Column(
        CaseInsensitiveEnum(CommercialOverrideStatus),
        default=CommercialOverrideStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
        index=True,
    )
    # Nullable: an Enterprise override may be permanent (no expiry).
    expires_at = Column(DateTime, nullable=True)

    requested_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approval_request_id = Column(Integer, ForeignKey("approval_requests.id", ondelete="SET NULL"), nullable=True)
    approved_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    revoked_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    entitlement_definition = relationship("EntitlementDefinition")

    def __repr__(self):
        return (
            f"<CommercialOverride id={self.id} organization_id={self.organization_id} "
            f"definition={self.entitlement_definition_id} status={self.status!r}>"
        )


class UsageIncrementEvent(Base):
    """Idempotency ledger for usage increments (Part 2, §14). Mirrors
    PlatformStripeEvent's get-or-create-by-unique-id + status-flip pattern
    exactly: a retried increment with the same idempotency_key is a no-op,
    never a double-count.
    """

    __tablename__ = "usage_increment_events"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False,
    )
    entitlement_definition_id = Column(
        Integer, ForeignKey("entitlement_definitions.id", ondelete="RESTRICT"), index=True, nullable=False,
    )
    # Caller-supplied natural id, e.g. f"invoice:{invoice.id}".
    idempotency_key = Column(String(255), nullable=False)
    window_key = Column(String(32), nullable=False)
    amount = Column(Integer, default=1, nullable=False)
    status = Column(String(20), default="processed", nullable=False)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "organization_id", "entitlement_definition_id", "idempotency_key",
            name="uq_usage_increment_events_dedupe",
        ),
    )

    def __repr__(self):
        return (
            f"<UsageIncrementEvent id={self.id} organization_id={self.organization_id} "
            f"idempotency_key={self.idempotency_key!r} status={self.status!r}>"
        )


class UsageCounter(Base):
    """Fast aggregate read model for a (org, entitlement, window), upserted
    by UsageMeteringService.increment as UsageIncrementEvent rows are
    processed. `soft_warned_at` tracks the start of a SOFT_THEN_HARD grace
    period once a soft limit is first breached in this window.
    """

    __tablename__ = "usage_counters"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False,
    )
    entitlement_definition_id = Column(
        Integer, ForeignKey("entitlement_definitions.id", ondelete="RESTRICT"), index=True, nullable=False,
    )
    window_key = Column(String(32), nullable=False)
    count = Column(Integer, default=0, nullable=False)
    soft_warned_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "organization_id", "entitlement_definition_id", "window_key",
            name="uq_usage_counters_org_def_window",
        ),
    )

    def __repr__(self):
        return (
            f"<UsageCounter id={self.id} organization_id={self.organization_id} "
            f"window_key={self.window_key!r} count={self.count}>"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Plane 1 — Plan-Change Orchestration (ZB-COM-ENT-001 Part 3, §7-§8)
# ═══════════════════════════════════════════════════════════════════════════════


class SubscriptionChange(Base):
    """One row per upgrade/downgrade event against a CommercialSubscription
    (§6.1, §7, §8). `from_plan_id`/`to_plan_id` are captured explicitly at
    creation time rather than derived later, because
    CommercialSubscriptionService.apply_plan_change() mutates the
    subscription's own commercial_plan_id in place — the "from" fact would
    otherwise be lost once the change applies.

    No direct organization_id column: reached via
    subscription.account.organization_id, matching CommercialSubscription
    itself (which has no direct organization_id either).
    """

    __tablename__ = "subscription_changes"

    id = Column(Integer, primary_key=True, index=True)
    commercial_subscription_id = Column(
        Integer,
        ForeignKey("commercial_subscriptions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    from_plan_id = Column(Integer, ForeignKey("commercial_plans.id", ondelete="RESTRICT"), nullable=False)
    to_plan_id = Column(Integer, ForeignKey("commercial_plans.id", ondelete="RESTRICT"), nullable=False)
    from_catalog_version_id = Column(
        Integer, ForeignKey("commercial_plan_versions.id", ondelete="RESTRICT"), nullable=True,
    )
    to_catalog_version_id = Column(
        Integer, ForeignKey("commercial_plan_versions.id", ondelete="RESTRICT"), nullable=True,
    )
    direction = Column(CaseInsensitiveEnum(SubscriptionChangeDirection), nullable=False)
    status = Column(
        CaseInsensitiveEnum(SubscriptionChangeStatus),
        default=SubscriptionChangeStatus.PENDING,
        server_default="PENDING",
        nullable=False,
        index=True,
    )
    effective_at = Column(DateTime, nullable=True)
    requested_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    requested_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    applied_at = Column(DateTime, nullable=True)
    reversed_at = Column(DateTime, nullable=True)
    reversed_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reason = Column(Text, nullable=True)
    # Frozen copies at commit time — snapshots, not live-reresolved, so the
    # rationale for a change stays auditable even if pricing/entitlements
    # change later (same "snapshot, don't re-resolve live" principle already
    # used for CommercialSubscription.evaluation_payment_requirement etc).
    blockers = Column(JSON, nullable=True)
    price_impact = Column(JSON, nullable=True)
    correlation_id = Column(String(100), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_subscription_changes_status_effective_at", "status", "effective_at"),
    )

    subscription = relationship("CommercialSubscription", backref="plan_changes")
    from_plan = relationship("CommercialPlan", foreign_keys=[from_plan_id])
    to_plan = relationship("CommercialPlan", foreign_keys=[to_plan_id])

    def __repr__(self):
        return (
            f"<SubscriptionChange id={self.id} subscription={self.commercial_subscription_id} "
            f"direction={self.direction!r} status={self.status!r}>"
        )
