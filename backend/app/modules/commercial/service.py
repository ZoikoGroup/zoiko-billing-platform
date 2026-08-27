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
import uuid
from datetime import datetime, timedelta

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
        "is_quote_only": plan.is_quote_only,
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
        """Double-charge-prevention check (ZB-COM-BILL-001 §O2-O3, COM-04).

        Only COMMERCIAL_STANDALONE may create a live standalone commercial
        charge (Table 9: every other classification is explicitly "No" /
        "no duplicate" / non-billable). billing_source must independently
        agree (REGISTERED_VIA_STANDALONE) — both server-stamped dimensions
        must align, so if they ever disagree (e.g. a classification change
        without a matching source update), charging fails CLOSED rather than
        guessing which one is authoritative (§32).
        """
        from app.modules.commercial.enums import BillingClassification, BillingSource

        return (
            organization.billing_classification == BillingClassification.COMMERCIAL_STANDALONE
            and organization.billing_source == BillingSource.REGISTERED_VIA_STANDALONE
        )


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
        is_quote_only: bool = False,
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

        if is_default and is_quote_only:
            raise ValueError("A quote-only plan cannot also be the self-serve default")

        if is_default:
            self._clear_defaults()

        plan = CommercialPlan(
            plan_code=plan_code,
            plan_name=plan_name,
            description=description,
            is_default=is_default,
            is_quote_only=is_quote_only,
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
            actor_role="super_admin" if actor_id is not None else None,
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
            actor_role="super_admin" if actor_id is not None else None,
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
            actor_role="super_admin" if actor_id is not None else None,
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
            actor_role="super_admin" if actor_id is not None else None,
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


def _version_snapshot(version: "CommercialPlanVersion") -> dict:
    """JSON-safe snapshot of a catalog version. Dates and Decimals are
    stringified because this dict lands directly in JSON columns
    (ApprovalRequest.proposed_state) as well as audit payloads."""
    def _safe(value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if hasattr(value, "isoformat"):  # date / datetime
            return value.isoformat()
        if hasattr(value, "value"):  # enums
            return value.value
        return str(value)

    return {
        "plan_name": version.plan_name,
        "description": version.description,
        "status": _safe(getattr(version.status, "value", version.status)),
        "billing_interval": _safe(
            getattr(version.billing_interval, "value", version.billing_interval)
        ),
        "currency": version.currency,
        "price_amount": _safe(version.price_amount),
        "effective_from": _safe(version.effective_from),
        "effective_to": _safe(version.effective_to),
        "max_users": version.max_users,
        "max_storage_gb": version.max_storage_gb,
        "features": version.features,
    }


class CommercialPlanVersionService:
    """Versioned price catalog (ZB-COM-BILL-001 §T1, Phase 4).

    A published version is immutable: once PUBLISHED, no field on it may be
    changed again — a correction creates a NEW draft version instead. This
    is enforced here (update_version raises if the version isn't DRAFT), not
    merely a UI convention. Publishing requires maker-checker approval via
    ApprovalService (a DIFFERENT Super Admin than the requester).
    """

    def __init__(self, db: Session):
        self.db = db

    def get_version(self, version_id: int) -> "CommercialPlanVersion | None":
        from app.modules.commercial.models import CommercialPlanVersion
        return self.db.query(CommercialPlanVersion).filter(CommercialPlanVersion.id == version_id).first()

    def list_versions_for_plan(self, plan_id: int) -> list:
        from app.modules.commercial.models import CommercialPlanVersion
        return (
            self.db.query(CommercialPlanVersion)
            .filter(CommercialPlanVersion.plan_id == plan_id)
            .order_by(CommercialPlanVersion.version_number.desc())
            .all()
        )

    def create_draft(
        self,
        plan: CommercialPlan,
        *,
        plan_name: str,
        description=None,
        billing_interval=None,
        currency: str | None = None,
        price_amount=None,
        effective_from=None,
        effective_to=None,
        max_users: int | None = None,
        max_storage_gb: int | None = None,
        features=None,
        actor_id: int | None = None,
    ):
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.commercial.models import CommercialPlanVersion

        last = (
            self.db.query(CommercialPlanVersion)
            .filter(CommercialPlanVersion.plan_id == plan.id)
            .order_by(CommercialPlanVersion.version_number.desc())
            .first()
        )
        next_number = (last.version_number + 1) if last else 1

        version = CommercialPlanVersion(
            plan_id=plan.id,
            version_number=next_number,
            status=CommercialPlanVersionStatus.DRAFT,
            plan_name=plan_name,
            description=description,
            billing_interval=billing_interval,
            currency=currency,
            price_amount=price_amount,
            effective_from=effective_from,
            effective_to=effective_to,
            max_users=max_users,
            max_storage_gb=max_storage_gb,
            features=features,
            created_by_user_id=actor_id,
        )
        self.db.add(version)
        self.db.flush()
        logger.info("Created CommercialPlanVersion draft v%s for plan %s", next_number, plan.plan_code)

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="super_admin" if actor_id is not None else None,
            action=PlatformAuditAction.CREATE,
            entity_type="CommercialPlanVersion",
            entity_id=version.id,
            new_values=_version_snapshot(version),
            reason=f"Draft version {next_number} created for plan {plan.plan_code}",
        )
        return version

    # ── ZB-COM-ENT-001 Part 3 (§16) — draft editing ─────────────────────────
    # No prior version of this service could edit a version's own fields or
    # its PlanEntitlement rows after create_draft() — Part 1 only ever
    # seeded these via a standalone script. Both new methods enforce
    # "publishing never edits a published version's rows in place" AT THE
    # SERVICE LAYER (raise, don't just rely on UI convention): editing is
    # rejected outright once status != DRAFT — publish always means a new
    # plan_version_id via create_draft(), never a mutation of this one.

    def update_draft(self, version, *, actor_id: int | None = None, **fields):
        """Update a DRAFT version's own scalar fields. Rejects any version
        whose status is not DRAFT (already PUBLISHED/PENDING_APPROVAL/etc
        rows are immutable via this method, full stop)."""
        from app.modules.commercial.enums import CommercialPlanVersionStatus

        if version.status != CommercialPlanVersionStatus.DRAFT:
            raise ValueError(
                f"CommercialPlanVersion {version.id} is {version.status.name}, not DRAFT; cannot edit."
            )
        allowed = {
            "plan_name", "description", "billing_interval", "currency", "price_amount",
            "effective_from", "effective_to", "max_users", "max_storage_gb", "features",
        }
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError(f"Cannot set unknown field(s) on a CommercialPlanVersion: {sorted(unknown)}")

        old_values = _version_snapshot(version)
        for key, value in fields.items():
            setattr(version, key, value)
        self.db.flush()

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="super_admin" if actor_id is not None else None,
            action=PlatformAuditAction.UPDATE,
            entity_type="CommercialPlanVersion",
            entity_id=version.id,
            old_values=old_values,
            new_values=_version_snapshot(version),
        )
        return version

    def set_plan_entitlement(
        self, version, entitlement_definition_id: int, value, *,
        is_contracted: bool = False, actor_id: int | None = None,
    ):
        """Upsert a PlanEntitlement row for a DRAFT version. Same DRAFT-only
        guard as update_draft() — once published, a version's entitlement
        rows are as immutable as its scalar fields."""
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.commercial.models import EntitlementDefinition, PlanEntitlement

        if version.status != CommercialPlanVersionStatus.DRAFT:
            raise ValueError(
                f"CommercialPlanVersion {version.id} is {version.status.name}, not DRAFT; "
                "cannot edit its entitlements."
            )
        definition = (
            self.db.query(EntitlementDefinition)
            .filter(EntitlementDefinition.id == entitlement_definition_id)
            .first()
        )
        if definition is None:
            raise ValueError(f"No EntitlementDefinition with id={entitlement_definition_id}.")

        row = (
            self.db.query(PlanEntitlement)
            .filter(
                PlanEntitlement.plan_version_id == version.id,
                PlanEntitlement.entitlement_definition_id == entitlement_definition_id,
            )
            .first()
        )
        old_value = row.value if row is not None else None
        if row is None:
            row = PlanEntitlement(
                plan_version_id=version.id, entitlement_definition_id=entitlement_definition_id,
                value=value, is_contracted=is_contracted,
            )
            self.db.add(row)
        else:
            row.value = value
            row.is_contracted = is_contracted
        self.db.flush()

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="super_admin" if actor_id is not None else None,
            action=PlatformAuditAction.UPDATE,
            entity_type="PlanEntitlement",
            entity_id=row.id,
            old_values={"value": old_value},
            new_values={"value": value, "is_contracted": is_contracted, "key": definition.key},
        )
        return row

    def submit_for_approval(self, version, *, requested_by_user_id: int, reason: str):
        """DRAFT -> PENDING_APPROVAL. Creates the ApprovalRequest that must be
        approved by a DIFFERENT Super Admin before this version can publish."""
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.super_admin.approval_service import ApprovalService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if version.status != CommercialPlanVersionStatus.DRAFT:
            raise ValueError(
                f"CommercialPlanVersion {version.id} is {version.status.name}, not DRAFT; cannot submit."
            )

        request = ApprovalService(self.db).create_request(
            request_type="catalog_version_publish",
            requested_by_user_id=requested_by_user_id,
            reason=reason,
            scope={"plan_id": version.plan_id, "version_id": version.id},
            proposed_state=_version_snapshot(version),
            correlation_id=f"commercial_plan_version:{version.id}",
        )
        version.status = CommercialPlanVersionStatus.PENDING_APPROVAL
        version.approval_request_id = request.id
        self.db.flush()

        PlatformAuditService(self.db).log_no_commit(
            actor_id=requested_by_user_id,
            actor_role="super_admin" if requested_by_user_id is not None else None,
            action=PlatformAuditAction.SUBMIT,
            entity_type="CommercialPlanVersion",
            entity_id=version.id,
            reason=reason,
            correlation_id=f"commercial_plan_version:{version.id}",
        )
        return version, request

    def approve_and_publish(self, version, *, approver_user_id: int):
        """PENDING_APPROVAL -> PUBLISHED. Raises SelfApprovalError if the
        approver is the same user who submitted the request (enforced in
        ApprovalService.approve, not merely here)."""
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.super_admin.approval_service import ApprovalService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if version.status != CommercialPlanVersionStatus.PENDING_APPROVAL:
            raise ValueError(
                f"CommercialPlanVersion {version.id} is {version.status.name}, not PENDING_APPROVAL; cannot publish."
            )
        request = ApprovalService(self.db).get_request(version.approval_request_id)
        if request is None:
            raise ValueError(f"CommercialPlanVersion {version.id} has no linked ApprovalRequest.")

        ApprovalService(self.db).approve(request, approver_user_id)  # raises SelfApprovalError if self

        version.status = CommercialPlanVersionStatus.PUBLISHED
        version.published_at = datetime.utcnow()
        self.db.flush()
        logger.info("CommercialPlanVersion %s published by %s", version.id, approver_user_id)

        PlatformAuditService(self.db).log_no_commit(
            actor_id=approver_user_id,
            actor_role="super_admin" if approver_user_id is not None else None,
            action=PlatformAuditAction.PUBLISH,
            entity_type="CommercialPlanVersion",
            entity_id=version.id,
            new_values=_version_snapshot(version),
            correlation_id=f"commercial_plan_version:{version.id}",
        )
        return version

    def reject(self, version, *, approver_user_id: int, rejection_reason: str):
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.super_admin.approval_service import ApprovalService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if version.status != CommercialPlanVersionStatus.PENDING_APPROVAL:
            raise ValueError(
                f"CommercialPlanVersion {version.id} is {version.status.name}, not PENDING_APPROVAL; cannot reject."
            )
        request = ApprovalService(self.db).get_request(version.approval_request_id)
        if request is None:
            raise ValueError(f"CommercialPlanVersion {version.id} has no linked ApprovalRequest.")

        ApprovalService(self.db).reject(request, approver_user_id, rejection_reason)  # raises SelfApprovalError if self

        version.status = CommercialPlanVersionStatus.REJECTED
        self.db.flush()

        PlatformAuditService(self.db).log_no_commit(
            actor_id=approver_user_id,
            actor_role="super_admin" if approver_user_id is not None else None,
            action=PlatformAuditAction.REJECT,
            entity_type="CommercialPlanVersion",
            entity_id=version.id,
            reason=rejection_reason,
            correlation_id=f"commercial_plan_version:{version.id}",
        )
        return version

    def archive(self, version, *, actor_id: int | None = None):
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if version.status != CommercialPlanVersionStatus.PUBLISHED:
            raise ValueError(
                f"CommercialPlanVersion {version.id} is {version.status.name}, not PUBLISHED; cannot archive."
            )
        version.status = CommercialPlanVersionStatus.ARCHIVED
        self.db.flush()

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="super_admin" if actor_id is not None else None,
            action=PlatformAuditAction.ARCHIVE,
            entity_type="CommercialPlanVersion",
            entity_id=version.id,
        )
        return version


class CommercialSubscriptionService:
    def __init__(self, db: Session):
        self.db = db

    # Explicit lifecycle state machine. Only these transitions are allowed;
    # arbitrary status changes raise ValueError.
    #
    # PAST_DUE/RESTRICTED (N1, Plane-1 failed-payment dunning) sit between
    # ACTIVE and SUSPENDED: ACTIVE -> PAST_DUE (day 0) -> RESTRICTED (day 10)
    # -> SUSPENDED (day 20) -> CANCELLED (day 45, "terminate" — never a hard
    # delete, per N2). Each of PAST_DUE/RESTRICTED/SUSPENDED can also return
    # straight to ACTIVE (N3: payment succeeds again, at any point in the
    # sequence).
    _TRANSITIONS: dict[CommercialSubscriptionStatus, set[CommercialSubscriptionStatus]] = {
        CommercialSubscriptionStatus.PENDING: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
            # Free-trial expiry (trial_ends_at passed with no payment) — see
            # commercial/tasks/trial_expiry.py. Distinct from the N1 payment-
            # failure path (ACTIVE -> ... -> SUSPENDED), which never applies
            # to a subscription that was never activated in the first place.
            CommercialSubscriptionStatus.SUSPENDED,
            CommercialSubscriptionStatus.TRIALING,
            CommercialSubscriptionStatus.ENTERPRISE_PENDING,
        },
        CommercialSubscriptionStatus.ACTIVE: {
            CommercialSubscriptionStatus.PAST_DUE,
            CommercialSubscriptionStatus.SUSPENDED,
            CommercialSubscriptionStatus.CANCELLED,
            CommercialSubscriptionStatus.EXPIRED,
            CommercialSubscriptionStatus.SCHEDULED_CHANGE,
            CommercialSubscriptionStatus.CANCEL_AT_PERIOD_END,
        },
        CommercialSubscriptionStatus.PAST_DUE: {
            CommercialSubscriptionStatus.RESTRICTED,
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.RESTRICTED: {
            CommercialSubscriptionStatus.SUSPENDED,
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.SUSPENDED: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.CANCELLED: set(),
        CommercialSubscriptionStatus.EXPIRED: set(),
        CommercialSubscriptionStatus.TRIALING: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
            CommercialSubscriptionStatus.SUSPENDED,
            CommercialSubscriptionStatus.EXPIRED,
        },
        CommercialSubscriptionStatus.SCHEDULED_CHANGE: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.CANCEL_AT_PERIOD_END: {
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
        CommercialSubscriptionStatus.ENTERPRISE_PENDING: {
            CommercialSubscriptionStatus.PENDING,
            CommercialSubscriptionStatus.ACTIVE,
            CommercialSubscriptionStatus.CANCELLED,
        },
    }

    _OPEN_STATUSES = {
        CommercialSubscriptionStatus.PENDING,
        CommercialSubscriptionStatus.ACTIVE,
        CommercialSubscriptionStatus.PAST_DUE,
        CommercialSubscriptionStatus.RESTRICTED,
        CommercialSubscriptionStatus.SUSPENDED,
        CommercialSubscriptionStatus.TRIALING,
        # ZB-COM-ENT-001 Part 3 fix: SCHEDULED_CHANGE means "a downgrade is
        # pending at the next period boundary; current entitlements unchanged
        # until the change takes effect" (enums.py docstring) — omitting it
        # here made resolve_open_subscription() find "no open subscription"
        # for a subscription mid-scheduled-change, silently zeroing every
        # entitlement. Every consumer of _OPEN_STATUSES (the entitlement
        # resolver, get_active_subscription, provision_default_subscription's
        # idempotency guard) needs this subscription to still count as open.
        CommercialSubscriptionStatus.SCHEDULED_CHANGE,
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

    def _assert_may_charge_commercially(self, account_id: int) -> None:
        """Real, backend-enforced gate before a subscription may become
        ACTIVE (ZB-COM-BILL-001 COM-04 double-charge prevention + §30.1 kill
        switch). Called from create_subscription (status=ACTIVE) and
        transition (new_status=ACTIVE) — PENDING never reaches this check,
        since a PENDING subscription is not live charging.
        """
        from app.modules.organizations.models import Organization
        from app.modules.super_admin.kill_switch_service import (
            COMMERCIAL_SUBSCRIPTION_CHARGING,
            BillingKillSwitchService,
        )

        BillingKillSwitchService(self.db).require_enabled(COMMERCIAL_SUBSCRIPTION_CHARGING)

        account = self.db.query(CommercialAccount).filter(CommercialAccount.id == account_id).first()
        if account is None:
            raise ValueError(f"Cannot activate: no CommercialAccount with id={account_id}.")
        org = self.db.query(Organization).filter(Organization.id == account.organization_id).first()
        if org is None:
            raise ValueError(f"Cannot activate: no Organization for account {account_id}.")

        if not CommercialAccountService(self.db).can_charge(org):
            raise ValueError(
                f"Organization {org.organization_code} cannot be charged by the standalone "
                f"platform (billing_classification={org.billing_classification.value if hasattr(org.billing_classification, 'value') else org.billing_classification}, "
                f"billing_source={org.billing_source.value if hasattr(org.billing_source, 'value') else org.billing_source}). "
                "If this organization is entitled via Zoiko One, standalone charging for the "
                "same entitlement period is prohibited (ZB-COM-BILL-001 COM-04)."
            )

    def create_subscription(
        self,
        account_id: int,
        plan: CommercialPlan,
        *,
        status: CommercialSubscriptionStatus = CommercialSubscriptionStatus.PENDING,
        catalog_version_id: int | None = None,
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

        Creating with status=ACTIVE is real charging and is gated by
        _assert_may_charge_commercially (double-charge prevention + kill
        switch) — PENDING creation is not.
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
        if status == CommercialSubscriptionStatus.ACTIVE:
            self._assert_may_charge_commercially(account_id)

        if self.get_active_subscription(account_id) is not None:
            raise ValueError(
                "A non-terminal CommercialSubscription already exists for this account; "
                "terminate it (cancel/expire) before creating a replacement."
            )

        # ZB-COM-BILL-001 §T1: "every subscription must retain
        # catalog_version_id". Auto-derive it from the plan's current
        # PUBLISHED version when the caller doesn't explicitly supply one, so
        # existing call sites keep working unchanged while new subscriptions
        # still get a reproducible catalog reference wherever a published
        # version actually exists.
        if catalog_version_id is None:
            from app.modules.commercial.enums import CommercialPlanVersionStatus
            from app.modules.commercial.models import CommercialPlanVersion

            latest_published = (
                self.db.query(CommercialPlanVersion)
                .filter(
                    CommercialPlanVersion.plan_id == plan.id,
                    CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
                )
                .order_by(CommercialPlanVersion.version_number.desc())
                .first()
            )
            if latest_published is not None:
                catalog_version_id = latest_published.id

        subscription = CommercialSubscription(
            commercial_account_id=account_id,
            commercial_plan_id=plan.id,
            catalog_version_id=catalog_version_id,
            status=status,
        )
        self.db.add(subscription)
        self.db.flush()
        logger.info(
            "Created CommercialSubscription for account %s on plan %s (status=%s)",
            account_id, plan.plan_code, status.name,
        )
        self._recompute_snapshot_for_account(account_id, reason="subscription_created")
        return subscription

    def _organization_id_for_account(self, account_id: int) -> int | None:
        account = self.db.query(CommercialAccount).filter(CommercialAccount.id == account_id).first()
        return account.organization_id if account is not None else None

    def _recompute_snapshot_for_account(self, account_id: int, *, reason: str) -> None:
        """Part 2 (§11.1, §13): a stale EntitlementSnapshot after a known
        state change is a correctness bug, not just UX lag — recompute
        synchronously, in the caller's transaction, right after the state
        change that could affect resolution."""
        from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService

        organization_id = self._organization_id_for_account(account_id)
        if organization_id is not None:
            EntitlementSnapshotService(self.db).recompute_snapshot(organization_id, reason=reason)

    def resolve_price(self, subscription: CommercialSubscription):
        """Resolve (price_amount, currency, billing_interval) for a
        subscription's renewal invoice: prefer the pinned catalog_version_id
        (reproducible even after the plan's live version changes), falling
        back to the plan's own fields for legacy rows with no catalog
        version. Returns None if neither resolves to a real price — a
        renewal invoice is never generated with an invented amount."""
        from app.modules.commercial.models import CommercialPlanVersion

        if subscription.catalog_version_id:
            version = (
                self.db.query(CommercialPlanVersion)
                .filter(CommercialPlanVersion.id == subscription.catalog_version_id)
                .first()
            )
            if version and version.price_amount is not None:
                return (version.price_amount, version.currency, version.billing_interval)

        plan = subscription.plan
        if plan and plan.price_amount is not None:
            return (plan.price_amount, plan.currency, plan.billing_interval)

        return None

    def advance_billing_period(self, subscription: CommercialSubscription, interval) -> None:
        """Advance current_period_start/end by one billing interval
        (monthly/annual) after a renewal invoice is generated."""
        from app.modules.commercial.enums import CommercialBillingInterval

        start = subscription.current_period_end or datetime.utcnow()
        months = 12 if interval == CommercialBillingInterval.ANNUAL else 1

        subscription.current_period_start = start
        subscription.current_period_end = self._add_months(start, months)
        self.db.flush()

    @staticmethod
    def _add_months(start: datetime, months: int) -> datetime:
        import calendar
        target_month = start.month + months
        target_year = start.year + (target_month - 1) // 12
        target_month = ((target_month - 1) % 12) + 1
        max_day = calendar.monthrange(target_year, target_month)[1]
        return start.replace(year=target_year, month=target_month, day=min(start.day, max_day))

    def transition(
        self,
        subscription: CommercialSubscription,
        new_status: CommercialSubscriptionStatus,
    ) -> CommercialSubscription:
        """Apply a lifecycle transition after validating it against the state
        machine. Raises ValueError on any disallowed/terminal transition.

        PHASE 8 compatibility: a subscription may only be ACTIVATED when its
        plan is still ACTIVE (an INACTIVE/ARCHIVED plan cannot be newly
        activated; it may only be retained as history). Activating (PENDING
        or SUSPENDED -> ACTIVE) is real charging and is gated by
        _assert_may_charge_commercially (double-charge prevention + kill
        switch).
        """
        allowed = self._TRANSITIONS.get(subscription.status, set())
        if new_status not in allowed:
            raise ValueError(
                f"Illegal CommercialSubscription transition: "
                f"{subscription.status.name} -> {new_status.name}"
            )
        if new_status == CommercialSubscriptionStatus.ACTIVE:
            if subscription.plan is not None and subscription.plan.status != CommercialPlanStatus.ACTIVE:
                raise ValueError(
                    f"Cannot activate subscription {subscription.id}: plan "
                    f"{subscription.plan.plan_code} is {subscription.plan.status.name}, "
                    "not ACTIVE."
                )
            self._assert_may_charge_commercially(subscription.commercial_account_id)
        subscription.status = new_status
        self.db.flush()
        self._recompute_snapshot_for_account(
            subscription.commercial_account_id, reason=f"subscription_transition:{new_status.value}",
        )
        return subscription

    def provision_default_subscription(
        self, account_id: int, intended_plan_code: str | None = None,
    ) -> CommercialSubscription | None:
        """Provisioning path used by registration.

        When intended_plan_code names an ACTIVE, non-quote-only CommercialPlan
        (the registrant's actual dropdown selection — essentials/professional/
        business), that plan is provisioned. Otherwise falls back to the
        approved is_default plan. If neither resolves, leaves the account
        WITHOUT a subscription (returns None) rather than inventing one.

        The resulting subscription starts PENDING (CommercialSubscription's
        default status) — provisioning never auto-charges or auto-activates;
        entitlement must not race ahead of payment (§B4). Idempotent: if an
        open subscription already exists, it is returned untouched.

        When an active CommercialEvaluationProgram exists for the resolved
        plan and the org is eligible (§5: one standard trial per verified
        organization), the subscription starts as TRIALING with:
          - trial_ends_at computed from the program's duration_days
          - recovery_ends_at = trial_ends_at + 14 days
          - trial_granted_entitlements snapshot from granted_plan_id's
            PlanEntitlement rows (Professional by default, per §5)
        """
        existing = self.get_active_subscription(account_id)
        if existing is not None:
            return existing

        plan = None
        if intended_plan_code:
            plan = (
                self.db.query(CommercialPlan)
                .filter(
                    CommercialPlan.plan_code == intended_plan_code,
                    CommercialPlan.status == CommercialPlanStatus.ACTIVE,
                    CommercialPlan.is_quote_only.is_(False),
                )
                .first()
            )

        if plan is None:
            plan = (
                self.db.query(CommercialPlan)
                .filter(
                    CommercialPlan.is_default.is_(True),
                    CommercialPlan.status == CommercialPlanStatus.ACTIVE,
                )
                .first()
            )

        if plan is None:
            logger.info(
                "No matching or default CommercialPlan for account %s (intended_plan_code=%r) — "
                "leaving account without a subscription.",
                account_id, intended_plan_code,
            )
            return None

        subscription = self.create_subscription(account_id, plan)

        # §B3 + §5: a trial is granted ONLY when an explicitly-activated
        # CommercialEvaluationProgram exists for THIS plan AND the org is
        # eligible (one standard trial per verified organization).
        from app.modules.commercial.models import (
            CommercialEvaluationProgram,
            EntitlementDefinition,
            PlanEntitlement,
        )

        program = (
            self.db.query(CommercialEvaluationProgram)
            .filter(
                CommercialEvaluationProgram.plan_id == plan.id,
                CommercialEvaluationProgram.is_active.is_(True),
            )
            .first()
        )
        if program is not None:
            # §5 eligibility: one standard trial per verified organization.
            # Check whether this org (or any prior org on the same account)
            # has ever previously had trial_ends_at set on any subscription.
            if not self._is_trial_eligible(account_id):
                logger.warning(
                    "Subscription %s: evaluation program %s found but org already "
                    "had a trial — second trial blocked per §5 (one per org).",
                    subscription.id, program.id,
                )
                return subscription

            now = datetime.utcnow()
            trial_ends = now + timedelta(days=program.duration_days)

            # Compute recovery window: trial_ends_at + 14 days (§5).
            recovery_ends = trial_ends + timedelta(days=14)

            # Snapshot entitlements from the granted_plan_id's PlanEntitlement
            # rows, not the signup plan's own. Per §5, the standard trial
            # grants Professional's entitlement bundle regardless of signup plan.
            granted_entitlements = None
            if program.granted_plan_id is not None:
                granted_entitlements = self._snapshot_entitlements_for_plan(
                    program.granted_plan_id, cap_source_program=program,
                )

            subscription.trial_ends_at = trial_ends
            subscription.recovery_ends_at = recovery_ends
            subscription.status = CommercialSubscriptionStatus.TRIALING
            subscription.evaluation_payment_requirement = program.payment_requirement
            subscription.evaluation_conversion_policy = program.conversion_policy
            subscription.evaluation_expiry_action = program.expiry_action
            subscription.trial_granted_entitlements = granted_entitlements
            self.db.flush()
            logger.info(
                "Subscription %s: TRIALING under program %s (%s-day trial, "
                "granted_plan_id=%s, recovery_ends_at=%s).",
                subscription.id, program.id, program.duration_days,
                program.granted_plan_id, recovery_ends,
            )

        # Recompute once, after any TRIALING branch above has set its final
        # state — create_subscription() already recomputed against the
        # pre-trial state, so this second call is what actually captures the
        # trial grant (or confirms no trial applied).
        self._recompute_snapshot_for_account(account_id, reason="provisioning")
        return subscription

    def is_trial_eligible(self, account_id: int) -> bool:
        """Public wrapper around _is_trial_eligible — ZB-COM-ENT-001 Part 3
        (§16 trial controls) needs a read-only eligibility signal exposed to
        the Super Admin surface without touching the internal call site's
        naming."""
        return self._is_trial_eligible(account_id)

    def _is_trial_eligible(self, account_id: int) -> bool:
        """§5: one standard trial per verified organization.

        Checks whether this account's organization has ever previously had
        trial_ends_at set on ANY subscription (active or historical). If so,
        a second trial is blocked. Uses the organization_id already on the
        CommercialAccount — no new verification infrastructure invented.

        Returns True if eligible (no prior trial found), False otherwise.
        """
        from app.modules.organizations.models import Organization

        account = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.id == account_id)
            .first()
        )
        if account is None:
            return True

        org = (
            self.db.query(Organization)
            .filter(Organization.id == account.organization_id)
            .first()
        )
        if org is None:
            return True

        # Check ALL subscriptions for this account (and any other account
        # that might share the same organization — strictly one account per
        # org, but defensive).
        prior_trial = (
            self.db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.commercial_account_id == account_id,
                CommercialSubscription.trial_ends_at.isnot(None),
            )
            .first()
        )
        return prior_trial is None

    def _snapshot_entitlements_for_plan(self, plan_id: int, *, cap_source_program=None) -> list[dict]:
        """Snapshot PlanEntitlement rows for a plan's current PUBLISHED version.

        Returns a list of dicts suitable for JSON storage on
        CommercialSubscription.trial_granted_entitlements. Each dict contains
        the entitlement key, value, and value_type for reconstruction. Returns
        an empty list if no published version or no entitlements exist.

        Part 2 fix: when cap_source_program is supplied, each snapshotted
        value is clamped against that program's CommercialEvaluationProgramCap
        rows (matched by entitlement_definition_id) before being frozen.
        Previously these caps were never applied anywhere — configuration a
        platform_administrator could set up but that had no live effect.
        INTEGER values are clamped with min(); BOOLEAN values are AND'd; any
        other value_type (SET/ENUM) or a cap_value of None passes through
        unclamped (no defined clamp semantics for those types yet).
        """
        from app.modules.commercial.enums import CommercialPlanVersionStatus, EntitlementValueType
        from app.modules.commercial.models import (
            CommercialEvaluationProgramCap,
            CommercialPlanVersion,
            EntitlementDefinition,
            PlanEntitlement,
        )

        latest_published = (
            self.db.query(CommercialPlanVersion)
            .filter(
                CommercialPlanVersion.plan_id == plan_id,
                CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
            )
            .order_by(CommercialPlanVersion.version_number.desc())
            .first()
        )
        if latest_published is None:
            return []

        rows = (
            self.db.query(PlanEntitlement, EntitlementDefinition)
            .join(
                EntitlementDefinition,
                PlanEntitlement.entitlement_definition_id == EntitlementDefinition.id,
            )
            .filter(
                PlanEntitlement.plan_version_id == latest_published.id,
            )
            .all()
        )

        caps_by_definition_id: dict[int, object] = {}
        if cap_source_program is not None:
            caps = (
                self.db.query(CommercialEvaluationProgramCap)
                .filter(CommercialEvaluationProgramCap.evaluation_program_id == cap_source_program.id)
                .all()
            )
            caps_by_definition_id = {cap.entitlement_definition_id: cap for cap in caps}

        snapshot = []
        for pe, ed in rows:
            value = pe.value
            cap = caps_by_definition_id.get(ed.id)
            if cap is not None and cap.cap_value is not None and value is not None:
                if ed.value_type == EntitlementValueType.INTEGER:
                    try:
                        value = min(value, cap.cap_value)
                    except TypeError:
                        pass
                elif ed.value_type == EntitlementValueType.BOOLEAN:
                    value = bool(value) and bool(cap.cap_value)
            snapshot.append({
                "key": ed.key,
                "value": value,
                "value_type": ed.value_type.value if hasattr(ed.value_type, "value") else ed.value_type,
            })
        return snapshot

    def change_plan(
        self,
        subscription: CommercialSubscription,
        new_plan: CommercialPlan,
        *,
        actor_id: int | None = None,
        reason: str = "",
    ) -> CommercialSubscription:
        """Phase 3F F5: replace an open subscription with one on a different
        plan, preserving history.

        Mechanics (gap analysis 3F/F5 — "plan change (upgrade/downgrade) =
        new subscription replacing prior (history preserved), audited; reuse
        existing transitions"):
          1. Only OPEN subscriptions may change plan; terminal rows are
             immutable history.
          2. The current subscription is CANCELLED through the state machine
             (every open status can reach CANCELLED) — never mutated in place.
          3. A replacement is created on the target plan. When the previous
             subscription was ACTIVE the replacement is activated immediately,
             which re-runs every real-charging guard (_assert_may_charge_commercially
             + plan-status check) inside this same transaction. Any other
             previous status yields a PENDING replacement that the operator
             activates explicitly through the normal transition endpoint.
          4. Both audit trails are written on the caller's transaction: the
             platform-plane trail (actor/reason/correlation id per
             ZB-COM-BILL-001 §R3/§29) and the org-scoped billing trail.

        Raises ValueError for no-op changes, archived targets and terminal
        sources. Nothing commits here.
        """
        if not reason or not reason.strip():
            raise ValueError("A reason is required to change a subscription's plan.")
        if subscription.status not in self._OPEN_STATUSES:
            raise ValueError(
                f"Subscription {subscription.id} is {subscription.status.name} "
                "(terminal); its plan can no longer be changed."
            )
        if new_plan.status == CommercialPlanStatus.ARCHIVED:
            raise ValueError(
                f"Cannot change plan to {new_plan.plan_code}: archived plans "
                "cannot receive new subscriptions."
            )
        if new_plan.id == subscription.commercial_plan_id:
            raise ValueError(
                f"Subscription {subscription.id} is already on plan "
                f"{new_plan.plan_code}; nothing to change."
            )

        old_plan_id = subscription.commercial_plan_id
        old_status = subscription.status
        account_id = subscription.commercial_account_id

        # Fail fast BEFORE mutating anything: an ACTIVE subscription's
        # replacement will be activated immediately, so the real-charging
        # preconditions are validated up front (the state machine re-checks
        # them later as defense in depth).
        if old_status == CommercialSubscriptionStatus.ACTIVE:
            from app.modules.organizations.models import Organization

            if new_plan.status != CommercialPlanStatus.ACTIVE:
                raise ValueError(
                    f"Cannot change an ACTIVE subscription to plan "
                    f"{new_plan.plan_code} (status: {new_plan.status.name}): "
                    "only ACTIVE plans can be newly activated."
                )
            account = (
                self.db.query(CommercialAccount)
                .filter(CommercialAccount.id == account_id)
                .first()
            )
            org = (
                self.db.query(Organization)
                .filter(Organization.id == account.organization_id)
                .first()
                if account
                else None
            )
            if not CommercialAccountService(self.db).can_charge(org):
                raise ValueError(
                    "Plan change would reactivate charging, but this "
                    "organization cannot be charged by the standalone platform "
                    "(ZB-COM-BILL-001 COM-04 double-charge prevention)."
                )

        correlation_id = f"pc-{uuid.uuid4().hex[:12]}"

        # 1+2: cancel through the state machine (validated transition).
        cancelled = self.transition(subscription, CommercialSubscriptionStatus.CANCELLED)

        # 3: create + conditionally activate the replacement.
        replacement_status = (
            CommercialSubscriptionStatus.ACTIVE
            if old_status == CommercialSubscriptionStatus.ACTIVE
            else CommercialSubscriptionStatus.PENDING
        )
        replacement = self.create_subscription(
            account_id, new_plan, status=replacement_status
        )

        # 4a: platform-plane audit with full provenance.
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        account = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.id == account_id)
            .first()
        )
        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.UPDATE,
            entity_type="CommercialSubscription",
            entity_id=cancelled.id,
            organization_id=account.organization_id if account else None,
            old_values={
                "status": old_status.value if hasattr(old_status, "value") else str(old_status),
                "commercial_plan_id": old_plan_id,
            },
            new_values={
                "status": (
                    cancelled.status.value
                    if hasattr(cancelled.status, "value")
                    else str(cancelled.status)
                ),
                "replaced_by_subscription_id": replacement.id,
                "change": "plan_change",
            },
            metadata={"plane": "PLATFORM", "change_type": "PLAN_CHANGE"},
            actor_role="super_admin",
            reason=reason.strip(),
            correlation_id=correlation_id,
        )

        # 4b: org-scoped billing audit (same pattern as creation/status).
        from app.modules.billing.models import BillingAuditAction
        from app.modules.billing.services.audit_service import BillingAuditService

        BillingAuditService(self.db).log_no_commit(
            organization_id=account.organization_id if account else None,
            actor_id=actor_id,
            action=BillingAuditAction.UPDATE,
            entity_type="CommercialSubscription",
            entity_id=replacement.id,
            old_values={"commercial_plan_id": old_plan_id},
            new_values={"commercial_plan_id": new_plan.id},
            changes={
                "change": "plan_change",
                "reason": reason.strip(),
                "correlation_id": correlation_id,
            },
        )

        logger.info(
            "Plan change on subscription %s (%s -> %s); replacement %s created "
            "(correlation_id=%s)",
            cancelled.id, old_plan_id, new_plan.plan_code, replacement.id, correlation_id,
        )
        return replacement

    # ── ZB-COM-ENT-001 Part 3 (§6.1, §7, §8) — in-place plan-change ─────────
    # Deliberately NOT built on change_plan()/create_subscription(): those
    # cancel-then-recreate the subscription (a new row, new id), and
    # create_subscription() never sets current_period_start/end — a
    # downgrade scheduled against the replacement's (NULL) current_period_end
    # would be broken. apply_plan_change() mutates the SAME subscription row
    # in place, preserving period fields, so "subscription update, not
    # replace" (the spec's own wording) is literally true, not just in intent.

    def _resolve_default_catalog_version_id(self, plan_id: int) -> int | None:
        """Latest PUBLISHED CommercialPlanVersion for a plan, or None. Same
        fallback used inline by create_subscription/resolve_price/
        EntitlementSnapshotService — factored out here for the new plan-
        change methods rather than duplicated a fourth time."""
        from app.modules.commercial.enums import CommercialPlanVersionStatus
        from app.modules.commercial.models import CommercialPlanVersion

        latest_published = (
            self.db.query(CommercialPlanVersion)
            .filter(
                CommercialPlanVersion.plan_id == plan_id,
                CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
            )
            .order_by(CommercialPlanVersion.version_number.desc())
            .first()
        )
        return latest_published.id if latest_published is not None else None

    def _set_plan_fields(
        self, subscription: CommercialSubscription, target_plan: CommercialPlan,
        target_catalog_version_id: int | None = None,
    ) -> None:
        """The recompute-free half of apply_plan_change: mutates only the
        plan/version columns. Factored out so the scheduled job (Part 3's
        apply_scheduled_change task) can call this, then transition() the
        subscription itself (SCHEDULED_CHANGE -> ACTIVE), which gets the
        snapshot recompute for free via transition()'s own hook — avoiding a
        double recompute in that path."""
        subscription.commercial_plan_id = target_plan.id
        subscription.catalog_version_id = (
            target_catalog_version_id or self._resolve_default_catalog_version_id(target_plan.id)
        )
        self.db.flush()

    def apply_plan_change(
        self,
        subscription: CommercialSubscription,
        target_plan: CommercialPlan,
        target_catalog_version_id: int | None = None,
        *,
        actor_id: int | None = None,
        reason: str = "",
    ) -> CommercialSubscription:
        """Immediate, in-place plan swap — used directly by an upgrade
        commit, an immediate (zero-blocker, confirmed) downgrade commit, and
        nowhere else. Mutation + EntitlementSnapshot recompute happen in the
        SAME uncommitted transaction as the caller's; if recompute fails, the
        whole transaction (including the plan-field mutation) rolls back
        atomically on the caller's exception handling — there is no partial-
        applied state to retry, and no async job queue exists in this
        codebase to invent one for.

        No invoice/charge is generated here — that is the concrete answer to
        "never double-charge": the new price only takes effect at the next
        normal renewal-invoice cycle, which reads resolve_price() against the
        now-mutated plan fields naturally.
        """
        if subscription.status != CommercialSubscriptionStatus.ACTIVE:
            raise ValueError(
                f"Subscription {subscription.id} is {subscription.status.name}, not ACTIVE; "
                "only an ACTIVE subscription is upgrade/downgrade-eligible."
            )
        if target_plan.status != CommercialPlanStatus.ACTIVE:
            raise ValueError(
                f"Cannot change to plan {target_plan.plan_code} (status: {target_plan.status.name}): "
                "only ACTIVE plans can be newly activated."
            )
        if target_plan.id == subscription.commercial_plan_id:
            raise ValueError(f"Subscription {subscription.id} is already on plan {target_plan.plan_code}.")

        # Bypassing transition() means the charging guard it normally runs
        # automatically must be re-run explicitly here.
        self._assert_may_charge_commercially(subscription.commercial_account_id)

        old_plan_id = subscription.commercial_plan_id
        old_version_id = subscription.catalog_version_id
        self._set_plan_fields(subscription, target_plan, target_catalog_version_id)

        self._recompute_snapshot_for_account(
            subscription.commercial_account_id, reason="plan_change_applied",
        )

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        account = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.id == subscription.commercial_account_id)
            .first()
        )
        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="org_admin" if actor_id is not None else None,
            action=PlatformAuditAction.SUBSCRIPTION_PLAN_CHANGE_APPLIED,
            entity_type="CommercialSubscription",
            entity_id=subscription.id,
            organization_id=account.organization_id if account else None,
            old_values={"commercial_plan_id": old_plan_id, "catalog_version_id": old_version_id},
            new_values={
                "commercial_plan_id": target_plan.id,
                "catalog_version_id": subscription.catalog_version_id,
            },
            reason=reason,
        )
        logger.info(
            "Applied in-place plan change on subscription %s: plan %s -> %s",
            subscription.id, old_plan_id, target_plan.plan_code,
        )
        return subscription

    def reverse_scheduled_change(self, change, *, actor_id: int | None = None, reason: str = ""):
        """SCHEDULED -> REVERSED. Pure status flip: nothing financial or
        entitlement-affecting has happened while a change is only SCHEDULED
        (the subscription has been resolving entitlements off its CURRENT
        plan the whole time, per SCHEDULED_CHANGE's semantics) — so there is
        no compensating transaction to run, only a status update."""
        from app.modules.commercial.enums import SubscriptionChangeStatus
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if change.status != SubscriptionChangeStatus.SCHEDULED:
            raise ValueError(
                f"SubscriptionChange {change.id} is {change.status.name}, not SCHEDULED; cannot reverse."
            )
        change.status = SubscriptionChangeStatus.REVERSED
        change.reversed_at = datetime.utcnow()
        change.reversed_by_user_id = actor_id
        self.db.flush()

        subscription = change.subscription
        self.transition(subscription, CommercialSubscriptionStatus.ACTIVE)

        account = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.id == subscription.commercial_account_id)
            .first()
        )
        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="org_admin" if actor_id is not None else None,
            action=PlatformAuditAction.SUBSCRIPTION_PLAN_CHANGE_REVERSED,
            entity_type="SubscriptionChange",
            entity_id=change.id,
            organization_id=account.organization_id if account else None,
            reason=reason,
        )
        logger.info("SubscriptionChange %s reversed by %s", change.id, actor_id)
        return change


class CommercialEntitlementService:
    """Entitlement read API (Part 1 foundation + Part 2 resolution engine).

    Answers the two questions:

      "Is this organization entitled to use feature X?"
        -> is_entitled(organization_id, feature)

      "What limit applies to this organization?"
        -> get_limit(organization_id, "max_users" | "max_storage_gb" | ...)

    Part 2: when `feature`/`limit_key` names one of the 19 typed catalog
    keys (entitlement_catalog_spec.KNOWN_ENTITLEMENT_KEYS), resolution goes
    through entitlement_resolver.resolve_entitlement — the full
    precedence-ordered engine (overrides, trial grants, snapshot, live plan
    entitlement, safe default). For any other key (legacy/ad-hoc feature
    flags on CommercialPlan.features, e.g. "export"), resolution falls back
    to the original untyped plan.features / max_users / max_storage_gb
    lookup unchanged — the typed catalog is a governed subset, not a
    replacement for arbitrary feature flags other code may already depend on.

    SAFETY (fail-open reads, §14): every lookup is tolerant of a missing
    account, missing open subscription, missing plan, unset entitlement
    data, OR a resolver error — it returns None / False / the safe-allowed
    default, never raises. A broken resolver must never break an unrelated
    read. Writes must use EntitlementEnforcementService instead, which does
    NOT fail open.
    """

    _LIMIT_KEYS = {"max_users", "max_storage_gb"}

    def __init__(self, db: Session):
        self.db = db

    def _open_subscription_for_organization(self, organization_id: int):
        from app.modules.commercial.entitlement_resolver import resolve_open_subscription

        return resolve_open_subscription(self.db, organization_id)

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
        """Feature entitlement check.

        For a known catalog key, resolves through the full Part 2 precedence
        engine — fails open (returns True) on any resolver error, logged.
        For any other key, falls back to the legacy plan.features lookup:
        a feature is enabled when the org has an open subscription whose
        plan declares the feature key with a truthy value. Missing plan /
        subscription / feature resolves to False in both paths — no
        exception ever escapes this method.
        """
        if not feature:
            return False

        from app.modules.commercial.entitlement_catalog_spec import KNOWN_ENTITLEMENT_KEYS
        from app.modules.commercial.entitlement_resolver import resolve_entitlement

        if feature in KNOWN_ENTITLEMENT_KEYS:
            try:
                resolved = resolve_entitlement(self.db, organization_id, feature)
                return bool(resolved.value)
            except Exception:  # noqa: BLE001 - fail-open read, §14
                logger.exception(
                    "is_entitled: resolver failed for org=%s feature=%s; failing open (True).",
                    organization_id, feature,
                )
                return True

        subscription = self._open_subscription_for_organization(organization_id)
        if subscription is None or subscription.plan is None:
            return False
        features = subscription.plan.features
        if not isinstance(features, dict):
            return False
        return bool(features.get(feature))

    def get_limit(self, organization_id: int, limit_key: str):
        """Limit lookup.

        For a known catalog key, resolves through the full Part 2 precedence
        engine — fails open (returns None, "no limit enforced") on any
        resolver error, logged. For any other key, falls back to the legacy
        lookup: max_users / max_storage_gb columns, or the plan's features
        dict. None = no limit set / no active entitlement; never raises.
        """
        if not limit_key:
            return None

        from app.modules.commercial.entitlement_catalog_spec import KNOWN_ENTITLEMENT_KEYS
        from app.modules.commercial.entitlement_resolver import resolve_entitlement

        if limit_key in KNOWN_ENTITLEMENT_KEYS:
            try:
                resolved = resolve_entitlement(self.db, organization_id, limit_key)
                return resolved.value
            except Exception:  # noqa: BLE001 - fail-open read, §14
                logger.exception(
                    "get_limit: resolver failed for org=%s limit_key=%s; failing open (None).",
                    organization_id, limit_key,
                )
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
