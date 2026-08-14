"""
modules/commercial/service.py
-------------------------------
Plane 1 (Zoiko Commercial Billing) services:

  - CommercialAccountService       — the org's platform-plane relationship with
                                     Zoiko (what the org pays Zoiko for using
                                     the Billing product).
  - CommercialPlanService          — reusable plan catalogue (structure only in
                                     Phase 7; no invented prices/limits).
  - CommercialSubscriptionService  — one org's assignment of a plan, with an
                                     explicit lifecycle state machine and
                                     history preservation.

Scope guard: these services NEVER touch the Billing module's customer-facing
rows (BillingCustomer / Invoice / Payment / Subscription / Contract / ...).
They operate only on the org <-> CommercialAccount <-> Subscription <-> Plan
relationships.

No pricing / payment / entitlement logic lives here yet. In particular, none of
these services commit: every caller owns its own transaction (registration
commits once; router endpoints commit; the lazy ensure paths are used by read
endpoints that persist via the caller).
"""

import logging

from sqlalchemy.orm import Session

from app.modules.commercial.enums import (
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialPlan,
    CommercialSubscription,
)

logger = logging.getLogger("zoiko_billing.commercial")


def _plan_snapshot(plan: "CommercialPlan") -> dict:
    """Auditable structural snapshot of a CommercialPlan.

    Only structural/entitlement-template fields are captured — this is the
    exact surface a Super Admin can mutate (plan_code is immutable). Values
    are normalized to JSON primitives by PlatformAuditService._json_safe.
    """
    return {
        "plan_code": plan.plan_code,
        "plan_name": plan.plan_name,
        "description": plan.description,
        "status": plan.status.value if hasattr(plan.status, "value") else plan.status,
        "is_default": plan.is_default,
        "billing_interval": (
            plan.billing_interval.value if hasattr(plan.billing_interval, "value") else plan.billing_interval
        ),
        "currency": plan.currency,
        "price_amount": plan.price_amount,
        "effective_from": plan.effective_from,
        "effective_to": plan.effective_to,
        "max_users": plan.max_users,
        "max_storage_gb": plan.max_storage_gb,
        "features": plan.features,
    }


class CommercialAccountService:
    def __init__(self, db: Session):
        self.db = db

    def get_commercial_account(self, organization_id: int) -> CommercialAccount | None:
        """Return the org's commercial account, or None. Organization scoped."""
        return (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.organization_id == organization_id)
            .first()
        )

    def ensure_commercial_account(self, organization_id: int) -> CommercialAccount:
        """Idempotent get-or-create (lazy backfill + provisioning path).

        Never duplicates an account: organization_id is unique, and an existing
        account is returned untouched (an existing tenant's account state is
        never reset by a re-ensure). Flushes but does NOT commit — callers own
        the transaction so registration stays all-or-nothing.
        """
        existing = self.get_commercial_account(organization_id)
        if existing:
            return existing

        from app.modules.organizations.models import Organization

        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise ValueError(f"Cannot create CommercialAccount for missing organization_id={organization_id}")

        account = CommercialAccount(organization_id=organization_id)
        self.db.add(account)
        self.db.flush()
        logger.info(
            "Created CommercialAccount for organization %s (%s)",
            org.organization_code, org.organization_name,
        )
        return account

    def determine_billing_source(self, organization) -> str:
        """Billing source of an org's account.

        Pass-through of the Organization's Phase 1 server-stamped column —
        the account intentionally does not duplicate it. The stamp is set
        server-side at provisioning and is never client-controlled.
        """
        return organization.billing_source

    def determine_billing_classification(self, organization) -> str:
        """Billing classification of an org's account.

        Pass-through of the Organization's Phase 1 server-stamped column.
        """
        return organization.billing_classification

    def can_charge(self, organization) -> bool:
        """PHASE 8 double-charge-prevention READINESS check (read-only).

        Returns whether the standalone platform is allowed to charge an
        organization commercially:

          REGISTERED_VIA_STANDALONE -> True  (standalone may charge)
          REGISTERED_VIA_ZOIKO_ONE   -> False (Zoiko One is the billing owner;
                                        the standalone platform must NOT
                                        independently charge the org)

        This is information preservation only — NO charging, invoicing, or
        payment logic exists yet (Phase 9+). The Organization's server-stamped
        billing_source remains the single source of truth.
        """
        from app.modules.commercial.enums import BillingSource

        return organization.billing_source == BillingSource.REGISTERED_VIA_STANDALONE


class CommercialPlanService:
    def __init__(self, db: Session):
        self.db = db

    def get_plan(self, plan_id: int) -> CommercialPlan | None:
        return self.db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()

    def get_plan_by_code(self, plan_code: str) -> CommercialPlan | None:
        return (
            self.db.query(CommercialPlan)
            .filter(CommercialPlan.plan_code == plan_code)
            .first()
        )

    def list_plans(self) -> list[CommercialPlan]:
        return self.db.query(CommercialPlan).order_by(CommercialPlan.id).all()

    def create_plan(
        self,
        *,
        plan_code: str,
        plan_name: str,
        description: str | None = None,
        is_default: bool = False,
        billing_interval=None,
        currency: str | None = None,
        price_amount=None,
        effective_from=None,
        effective_to=None,
        max_users: int | None = None,
        max_storage_gb: int | None = None,
        features=None,
        actor_id: int | None = None,
    ) -> CommercialPlan:
        """Create a plan in the reusable catalogue (structure only).

        Pricing / currency / billing interval / limits / features are NOT
        invented here — they stay NULL unless an approved catalogue explicitly
        supplies them through this Super Admin surface. A plan is a shared
        template; it is never created per-organization.

        Raises ValueError if plan_code already exists (unique catalogue code)
        or if an ACTIVE default already exists and is_default=True is requested
        for a different plan.

        PHASE 11: on success a CREATE platform-audit row is flushed into the
        caller's transaction (actor_id = the Super Admin). The caller owns the
        commit, so a failed/rolled-back create leaves zero audit rows.
        """
        existing = self.get_plan_by_code(plan_code)
        if existing:
            raise ValueError(f"CommercialPlan plan_code already exists: {plan_code}")

        if is_default:
            self._clear_defaults()

        plan = CommercialPlan(
            plan_code=plan_code,
            plan_name=plan_name,
            description=description,
            is_default=is_default,
            status=CommercialPlanStatus.ACTIVE,
            billing_interval=billing_interval,
            currency=currency,
            price_amount=price_amount,
            effective_from=effective_from,
            effective_to=effective_to,
            max_users=max_users,
            max_storage_gb=max_storage_gb,
            features=features,
        )
        self.db.add(plan)
        self.db.flush()
        logger.info("Created CommercialPlan %s (%s)", plan_code, plan_name)

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.CREATE,
            entity_type="CommercialPlan",
            entity_id=plan.id,
            new_values=_plan_snapshot(plan),
        )
        return plan

    def _clear_defaults(self) -> None:
        """Unset the default flag on every plan (atomic in the current tx).

        The existing database strategy (shared Base.metadata.create_all schema
        on PostgreSQL or dev SQLite) cannot carry a cross-DB partial UNIQUE
        index on `is_default`, so "at most one ACTIVE default" is enforced
        transactionally here: a single UPDATE clears the flag everywhere, then
        the caller sets exactly one plan as default in the same transaction.
        Callers own the commit, so the change is all-or-nothing.
        """
        self.db.query(CommercialPlan).filter(
            CommercialPlan.is_default.is_(True)
        ).update({CommercialPlan.is_default: False})

    def update_plan(
        self,
        plan: CommercialPlan,
        *,
        plan_name: str | None = None,
        description: str | None = None,
        billing_interval=None,
        currency: str | None = None,
        price_amount=None,
        effective_from=None,
        effective_to=None,
        max_users: int | None = None,
        max_storage_gb: int | None = None,
        features=None,
        actor_id: int | None = None,
    ) -> CommercialPlan:
        """Update the structural fields of a reusable plan.

        `plan_code` is immutable once created — it is the stable unique
        identity that subscription history references. Only descriptive /
        structural / entitlement-template fields are editable. This never
        rewrites CommercialSubscription rows: existing history keeps its
        commercial_plan_id, status, and period fields untouched.

        PHASE 11: an UPDATE platform-audit row is flushed when at least one
        provided field actually changed. No-op updates write no audit row.
        """
        snapshot_before = _plan_snapshot(plan)
        if plan_name is not None:
            plan.plan_name = plan_name
        if description is not None:
            plan.description = description
        if billing_interval is not None:
            plan.billing_interval = billing_interval
        if currency is not None:
            plan.currency = currency
        if price_amount is not None:
            plan.price_amount = price_amount
        if effective_from is not None:
            plan.effective_from = effective_from
        if effective_to is not None:
            plan.effective_to = effective_to
        if max_users is not None:
            plan.max_users = max_users
        if max_storage_gb is not None:
            plan.max_storage_gb = max_storage_gb
        if features is not None:
            plan.features = features
        self.db.flush()
        logger.info("Updated CommercialPlan %s", plan.plan_code)

        snapshot_after = _plan_snapshot(plan)
        editable_fields = (
            "plan_name",
            "description",
            "billing_interval",
            "currency",
            "price_amount",
            "effective_from",
            "effective_to",
            "max_users",
            "max_storage_gb",
            "features",
        )
        changed = {
            key: {"old": snapshot_before[key], "new": snapshot_after[key]}
            for key in editable_fields
            if snapshot_before[key] != snapshot_after[key]
        }
        if not changed:
            return plan

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.UPDATE,
            entity_type="CommercialPlan",
            entity_id=plan.id,
            old_values={key: change["old"] for key, change in changed.items()},
            new_values={key: change["new"] for key, change in changed.items()},
        )
        return plan

    def set_status(
        self,
        plan: CommercialPlan,
        new_status: CommercialPlanStatus,
        *,
        actor_id: int | None = None,
    ) -> CommercialPlan:
        """Transition a plan's lifecycle.

        ACTIVE <-> INACTIVE, and -> ARCHIVED (terminal). Moving a plan OFF
        ACTIVE automatically clears its default flag so an INACTIVE/ARCHIVED
        plan can never remain the approved default (an approved default must be
        ACTIVE). Existing subscriptions keep their historical references to the
        plan regardless of its lifecycle.

        PHASE 11: a status-change platform-audit row is flushed into the
        caller's transaction. No-op transitions (same status) and illegal /
        failed transitions write no audit row.
        """
        if new_status == plan.status:
            return plan
        if plan.status == CommercialPlanStatus.ARCHIVED:
            raise ValueError(
                f"CommercialPlan {plan.plan_code} is ARCHIVED and cannot change status."
            )
        if new_status not in {
            CommercialPlanStatus.ACTIVE,
            CommercialPlanStatus.INACTIVE,
            CommercialPlanStatus.ARCHIVED,
        }:
            raise ValueError(f"Unknown CommercialPlan status: {new_status}")

        old_status = plan.status
        old_is_default = plan.is_default
        if new_status != CommercialPlanStatus.ACTIVE and plan.is_default:
            plan.is_default = False
            logger.info(
                "Cleared default flag on %s while moving it to %s",
                plan.plan_code, new_status.name,
            )
        plan.status = new_status
        self.db.flush()
        logger.info("CommercialPlan %s status -> %s", plan.plan_code, new_status.name)

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        action = {
            CommercialPlanStatus.ACTIVE: PlatformAuditAction.ACTIVATE,
            CommercialPlanStatus.INACTIVE: PlatformAuditAction.DEACTIVATE,
            CommercialPlanStatus.ARCHIVED: PlatformAuditAction.ARCHIVE,
        }[new_status]

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            action=action,
            entity_type="CommercialPlan",
            entity_id=plan.id,
            old_values={"status": old_status.value, "is_default": old_is_default},
            new_values={"status": plan.status.value, "is_default": plan.is_default},
            metadata={"transition": f"{old_status.value}->{plan.status.value}"},
        )
        return plan

    def set_default(
        self,
        plan: CommercialPlan,
        is_default: bool,
        *,
        actor_id: int | None = None,
    ) -> CommercialPlan:
        """Atomically select / clear the approved default plan.

        A default plan must be ACTIVE. Selecting a new default clears the flag
        on every other plan in the same transaction, so there is never more
        than one default. Clearing the flag on the current default leaves the
        catalogue with NO default (registration then provisions nothing).

        PHASE 11: a SET_DEFAULT / CLEAR_DEFAULT platform-audit row is flushed
        into the caller's transaction when the plan's default flag actually
        changes; no-op calls write no audit row.
        """
        old_is_default = plan.is_default
        if is_default:
            if plan.status != CommercialPlanStatus.ACTIVE:
                raise ValueError(
                    f"Cannot make plan {plan.plan_code} the default: "
                    f"only ACTIVE plans may be default (current status: {plan.status.name})."
                )
            self._clear_defaults()
            plan.is_default = True
        else:
            plan.is_default = False
        self.db.flush()
        logger.info("CommercialPlan %s is_default=%s", plan.plan_code, is_default)

        if old_is_default == plan.is_default:
            return plan

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            action=(
                PlatformAuditAction.SET_DEFAULT
                if plan.is_default
                else PlatformAuditAction.CLEAR_DEFAULT
            ),
            entity_type="CommercialPlan",
            entity_id=plan.id,
            old_values={"is_default": old_is_default},
            new_values={"is_default": plan.is_default},
        )
        return plan


class CommercialSubscriptionService:
    def __init__(self, db: Session):
        self.db = db

    # Explicit lifecycle state machine. Only these transitions are allowed;
    # arbitrary status changes raise ValueError.
    _TRANSITIONS: dict[CommercialSubscriptionStatus, set[CommercialSubscriptionStatus]] = {
        CommercialSubscriptionStatus.PENDING: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.ACTIVE: {
            CommercialSubscriptionStatus.SUSPENDED,
            CommercialSubscriptionStatus.CANCELLED,
            CommercialSubscriptionStatus.EXPIRED,
        },
        CommercialSubscriptionStatus.SUSPENDED: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.CANCELLED: set(),
        CommercialSubscriptionStatus.EXPIRED: set(),
    }

    _OPEN_STATUSES = {
        CommercialSubscriptionStatus.PENDING,
        CommercialSubscriptionStatus.ACTIVE,
        CommercialSubscriptionStatus.SUSPENDED,
    }

    def get_subscription(self, subscription_id: int) -> CommercialSubscription | None:
        return (
            self.db.query(CommercialSubscription)
            .filter(CommercialSubscription.id == subscription_id)
            .first()
        )

    def get_active_subscription(self, account_id: int) -> CommercialSubscription | None:
        """Current open (non-terminal) subscription for the account, if any."""
        return (
            self.db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.commercial_account_id == account_id,
                CommercialSubscription.status.in_(list(self._OPEN_STATUSES)),
            )
            .order_by(CommercialSubscription.id.desc())
            .first()
        )

    def get_most_recent_subscription(self, account_id: int) -> CommercialSubscription | None:
        """Most recent subscription row (including historical/terminal ones)."""
        return (
            self.db.query(CommercialSubscription)
            .filter(CommercialSubscription.commercial_account_id == account_id)
            .order_by(CommercialSubscription.id.desc())
            .first()
        )

    def create_subscription(
        self,
        account_id: int,
        plan: CommercialPlan,
        *,
        status: CommercialSubscriptionStatus = CommercialSubscriptionStatus.PENDING,
    ) -> CommercialSubscription:
        """Create a subscription for an account, guarding against duplicates.

        At most ONE open (PENDING/ACTIVE/SUSPENDED) subscription may exist per
        account. Historical (CANCELLED/EXPIRED) rows are preserved and never
        block a new subscription — a replacement is created only after the
        previous one is terminated.

        Plan/status compatibility (PHASE 8):
          - an ARCHIVED plan can never receive a new subscription (history may
            still reference it)
          - an INACTIVE plan cannot receive a new ACTIVE subscription (a PENDING
            subscription is allowed, but it cannot be activated later)
        """
        if plan.status == CommercialPlanStatus.ARCHIVED:
            raise ValueError(
                f"Cannot create a CommercialSubscription on archived plan "
                f"{plan.plan_code}: archived plans cannot receive new subscriptions."
            )
        if status not in {
            CommercialSubscriptionStatus.PENDING,
            CommercialSubscriptionStatus.ACTIVE,
        }:
            raise ValueError(
                f"Cannot create a CommercialSubscription in status {status.name}; "
                "new subscriptions may only start as PENDING or ACTIVE."
            )
        if status == CommercialSubscriptionStatus.ACTIVE and plan.status != CommercialPlanStatus.ACTIVE:
            raise ValueError(
                f"Cannot create an ACTIVE CommercialSubscription on plan "
                f"{plan.plan_code} (status: {plan.status.name}): "
                "only ACTIVE plans can be newly activated."
            )

        if self.get_active_subscription(account_id) is not None:
            raise ValueError(
                "A non-terminal CommercialSubscription already exists for this account; "
                "terminate it (cancel/expire) before creating a replacement."
            )

        subscription = CommercialSubscription(
            commercial_account_id=account_id,
            commercial_plan_id=plan.id,
            status=status,
        )
        self.db.add(subscription)
        self.db.flush()
        logger.info(
            "Created CommercialSubscription for account %s on plan %s (status=%s)",
            account_id, plan.plan_code, status.name,
        )
        return subscription

    def transition(
        self,
        subscription: CommercialSubscription,
        new_status: CommercialSubscriptionStatus,
    ) -> CommercialSubscription:
        """Apply a lifecycle transition after validating it against the state
        machine. Raises ValueError on any disallowed/terminal transition.

        PHASE 8 compatibility: a subscription may only be ACTIVATED when its
        plan is still ACTIVE (an INACTIVE/ARCHIVED plan cannot be newly
        activated; it may only be retained as history).
        """
        allowed = self._TRANSITIONS.get(subscription.status, set())
        if new_status not in allowed:
            raise ValueError(
                f"Illegal CommercialSubscription transition: "
                f"{subscription.status.name} -> {new_status.name}"
            )
        if (
            new_status == CommercialSubscriptionStatus.ACTIVE
            and subscription.plan is not None
            and subscription.plan.status != CommercialPlanStatus.ACTIVE
        ):
            raise ValueError(
                f"Cannot activate subscription {subscription.id}: plan "
                f"{subscription.plan.plan_code} is {subscription.plan.status.name}, "
                "not ACTIVE."
            )
        subscription.status = new_status
        self.db.flush()
        return subscription

    def provision_default_subscription(self, account_id: int) -> CommercialSubscription | None:
        """Provisioning path used by registration.

        Assigns the approved default plan when one exists; otherwise leaves the
        account WITHOUT a subscription (returns None).

        Phase 7 seeds NO plans, so no approved default plan exists and the
        subscription is intentionally absent — a free/paid plan is never
        invented merely to satisfy the flow. Idempotent: if an open
        subscription already exists, it is returned untouched.
        """
        existing = self.get_active_subscription(account_id)
        if existing is not None:
            return existing

        default_plan = (
            self.db.query(CommercialPlan)
            .filter(
                CommercialPlan.is_default.is_(True),
                CommercialPlan.status == CommercialPlanStatus.ACTIVE,
            )
            .first()
        )
        if default_plan is None:
            logger.info(
                "No approved default CommercialPlan — leaving account %s without a subscription.",
                account_id,
            )
            return None

        return self.create_subscription(account_id, default_plan)


class CommercialEntitlementService:
    """PHASE 8 entitlement FOUNDATION (read-only; NOT enforced anywhere yet).

    Answers the two future questions:

      "Is this organization entitled to use feature X?"
        -> is_entitled(organization_id, feature)

      "What limit applies to this organization?"
        -> get_limit(organization_id, "max_users" | "max_storage_gb" | ...)

    Resolution chain:  Organization -> CommercialAccount (1:1)
                       -> open CommercialSubscription -> CommercialPlan
                       -> plan.features (feature flags) / max_users /
                          max_storage_gb (limits).

    Design note vs Zoiko One: the reference keeps features/limits on the
    subscription itself (OrgSubscription.max_users/max_storage_gb/features)
    because it has no reusable plan table. Standalone has a reusable
    CommercialPlan, so the plan owns the entitlements and every subscription
    to that plan inherits them (see models.py). Deliberately NOT a copy of
    Zoiko One.

    SAFETY: every lookup is tolerant of a missing account, missing open
    subscription, missing plan, or unset entitlement data — it returns None /
    False / the empty default, never raises. This is the foundation only:
    nothing here is wired into tenant Billing modules, and nothing is enforced.
    """

    _LIMIT_KEYS = {"max_users", "max_storage_gb"}

    def __init__(self, db: Session):
        self.db = db

    def _open_subscription_for_organization(self, organization_id: int):
        from app.modules.organizations.models import Organization

        account = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.organization_id == organization_id)
            .first()
        )
        if account is None:
            return None
        return (
            self.db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.commercial_account_id == account.id,
                CommercialSubscription.status.in_(
                    list(CommercialSubscriptionService._OPEN_STATUSES)
                ),
            )
            .order_by(CommercialSubscription.id.desc())
            .first()
        )

    def get_organization_entitlements(self, organization_id: int) -> dict:
        """Entitlement view for an org's CURRENT open subscription.

        Returns {"plan": {...}, "limits": {...}, "features": {...}} or an
        empty-safe view when no plan is currently entitled. Never raises.
        """
        subscription = self._open_subscription_for_organization(organization_id)
        if subscription is None or subscription.plan is None:
            return {"plan": None, "limits": {}, "features": {}}
        plan = subscription.plan
        return {
            "plan": {
                "id": plan.id,
                "plan_code": plan.plan_code,
                "plan_name": plan.plan_name,
                "status": plan.status,
            },
            "limits": {
                "max_users": plan.max_users,
                "max_storage_gb": plan.max_storage_gb,
            },
            "features": plan.features or {},
        }

    def is_entitled(self, organization_id: int, feature: str) -> bool:
        """Feature entitlement check (foundation only).

        A feature is enabled when the org has an open subscription whose plan
        declares the feature key with a truthy value. Missing plan /
        subscription / feature resolves to False — no exception.
        """
        if not feature:
            return False
        subscription = self._open_subscription_for_organization(organization_id)
        if subscription is None or subscription.plan is None:
            return False
        features = subscription.plan.features
        if not isinstance(features, dict):
            return False
        return bool(features.get(feature))

    def get_limit(self, organization_id: int, limit_key: str):
        """Limit lookup (foundation only).

        Returns the numeric limit for max_users / max_storage_gb (or any other
        named limit present on the plan's features dict). None = no limit set /
        no active entitlement; never raises.
        """
        if not limit_key:
            return None
        subscription = self._open_subscription_for_organization(organization_id)
        if subscription is None or subscription.plan is None:
            return None
        plan = subscription.plan
        if limit_key in self._LIMIT_KEYS:
            return getattr(plan, limit_key, None)
        if isinstance(plan.features, dict):
            return plan.features.get(limit_key)
        return None
