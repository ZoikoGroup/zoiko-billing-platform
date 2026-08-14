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

These are deliberately DISTINCT from the Billing module's tenant-facing models
(BillingCustomer / SubscriptionPlan / Subscription / Invoice / ...):
BillingCustomer et al. are org-scoped data a tenant uses to charge ITS OWN
customers (Plane 2). CommercialAccount/Plan/Subscription are the platform-plane
relationship between the org and Zoiko (Plane 1).

Billing source / classification deliberately stay on the Organization
(Phase 1, server-stamped) — the source of truth consumed by the future
double-charge prevention check. They are NOT duplicated here.
"""

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.commercial.enums import (
    CommercialAccountStatus,
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
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

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    account = relationship("CommercialAccount", back_populates="subscriptions")
    plan = relationship("CommercialPlan", back_populates="subscriptions")

    def __repr__(self):
        return (
            f"<CommercialSubscription id={self.id} "
            f"account_id={self.commercial_account_id} status={self.status!r}>"
        )
