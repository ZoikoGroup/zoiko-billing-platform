"""
modules/super_admin/lifecycle_service.py
----------------------------------------
ZB-SA-P3 (Phase 3C) — governed tenant lifecycle state machine.

The single authoritative writer of Organization.lifecycle_state. Routers
never assign lifecycle_state directly; every move goes through
TenantLifecycleService.transition(), which:

  1. validates authorization is enforced upstream (router dependency);
  2. validates the CURRENT state allows the requested target
     (invalid transitions fail loudly with BadRequestException — never a
     silent no-op or a partial write);
  3. keeps Organization.is_active in lockstep so every existing auth check
     that reads is_active keeps its exact meaning:
        is_active False  <=>  state in {SUSPENDED, DEACTIVATING, DEACTIVATED}
  4. records actor id + role, wall-clock timestamp, mandatory human reason,
     from/to states and a fresh correlation_id in an append-only platform
     audit event written transactionally (log_no_commit — all-or-nothing
     with the transition itself).

Onboarding readiness is evidence-based only: each readiness signal is
computed from real rows that exist in this database (an active org admin,
a seeded BillingConfiguration, an assigned commercial subscription).
Signals this codebase cannot observe (external integrations) are reported
as UNKNOWN — never guessed green.
"""

import uuid
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.organizations.models import Organization, TenantLifecycleState

LifecycleState = TenantLifecycleState

# Forward-only-ish transition map. Anything not listed here is invalid.
_ALLOWED_TRANSITIONS: dict[LifecycleState, set[LifecycleState]] = {
    LifecycleState.PROVISIONING: {
        LifecycleState.ONBOARDING,
        LifecycleState.ACTIVE,
        LifecycleState.SUSPENDED,
        LifecycleState.DEACTIVATING,
    },
    LifecycleState.ONBOARDING: {
        LifecycleState.ACTIVE,
        LifecycleState.SUSPENDED,
        LifecycleState.DEACTIVATING,
    },
    LifecycleState.ACTIVE: {
        LifecycleState.SUSPENDED,
        LifecycleState.DEACTIVATING,
    },
    # Reactivation paths (Super Admin actions, reason-mandated + audited).
    LifecycleState.SUSPENDED: {
        LifecycleState.ACTIVE,
        LifecycleState.DEACTIVATING,
    },
    # Grace period: an in-flight deactivation may still be aborted back to
    # ACTIVE by explicit operator action before it reaches DEACTIVATED.
    LifecycleState.DEACTIVATING: {
        LifecycleState.DEACTIVATED,
        LifecycleState.ACTIVE,
    },
    # Terminal. History is preserved; billing data is never hard-deleted.
    LifecycleState.DEACTIVATED: set(),
}

# States in which tenant users are blocked at login (is_active=False sync).
_ACCESS_BLOCKED_STATES = {
    LifecycleState.SUSPENDED,
    LifecycleState.DEACTIVATING,
    LifecycleState.DEACTIVATED,
}

# Open commercial subscription statuses — single source of truth stays
# CommercialSubscriptionService._OPEN_STATUSES; mirrored here as a literal
# set so this module has no import cycle with commercial.service at module
# load time.
_OPEN_SUBSCRIPTION_STATUSES = {
    CommercialSubscriptionStatus.PENDING,
    CommercialSubscriptionStatus.ACTIVE,
    CommercialSubscriptionStatus.PAST_DUE,
    CommercialSubscriptionStatus.RESTRICTED,
    CommercialSubscriptionStatus.SUSPENDED,
}

READINESS_READY = "ready"
READINESS_PENDING = "pending"
READINESS_UNKNOWN = "unknown"


class TenantLifecycleService:
    def __init__(self, db: Session):
        self.db = db

    # ── State machine ────────────────────────────────────────────────────────

    @staticmethod
    def allowed_transitions(state: LifecycleState) -> list[LifecycleState]:
        return sorted(_ALLOWED_TRANSITIONS.get(state, set()), key=lambda s: s.value)

    def transition(
        self,
        *,
        actor: User,
        organization: Organization,
        target: LifecycleState,
        reason: str,
    ) -> tuple[Organization, LifecycleState]:
        """Move an organization to `target` through the governed map.

        Returns (organization, previous_state). Raises BadRequestException on
        an invalid transition or missing reason; NotFoundException is the
        caller's concern (the router resolves the org first).
        """
        if not reason or not reason.strip():
            raise BadRequestException("A documented reason is required for every lifecycle transition.")

        current = organization.lifecycle_state or LifecycleState.ACTIVE
        if target == current:
            raise BadRequestException(f"Organization is already in lifecycle state '{current.value}'.")

        allowed = _ALLOWED_TRANSITIONS.get(current, set())
        if target not in allowed:
            raise BadRequestException(
                f"Invalid lifecycle transition: {current.value} -> {target.value}. "
                f"Allowed targets from '{current.value}': "
                f"{[s.value for s in self.allowed_transitions(current)]}"
            )

        previous = current
        previous_is_active = organization.is_active
        organization.lifecycle_state = target
        organization.is_active = target not in _ACCESS_BLOCKED_STATES

        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        correlation_id = f"lc-{uuid.uuid4().hex[:12]}"
        PlatformAuditService(self.db).log_no_commit(
            actor_id=getattr(actor, "id", None),
            actor_role="super_admin",
            action=PlatformAuditAction.LIFECYCLE_TRANSITION,
            entity_type="Organization",
            entity_id=organization.id,
            organization_id=organization.id,
            old_values={"lifecycle_state": previous.value, "is_active": previous_is_active},
            new_values={"lifecycle_state": target.value, "is_active": organization.is_active},
            metadata={
                "transition": f"{previous.value}->{target.value}",
                "plane": "PLATFORM",
            },
            reason=reason.strip(),
            correlation_id=correlation_id,
        )
        return organization, previous

    # ── Evidence-based onboarding readiness ─────────────────────────────────

    def onboarding_readiness(self, organization: Organization) -> dict:
        """Checklist computed ONLY from rows that exist in this database.

        integration_readiness has no observable backing store today (there is
        no integration registry model), so it is honestly UNKNOWN rather than
        inferred from absence.
        """
        org_id = organization.id

        administrator_ready = (
            self.db.query(User)
            .filter(
                User.organization_id == org_id,
                User.role == UserRole.ORG_ADMIN,
                User.is_active.is_(True),
            )
            .count()
            > 0
        )

        # Direct query — deliberately NOT BillingConfigurationService.get_configuration(),
        # which lazily seeds a row; existence must be measured, never created by the probe.
        from app.modules.billing.models import BillingConfiguration

        configuration_ready = (
            self.db.query(BillingConfiguration.id).filter(BillingConfiguration.organization_id == org_id).first()
            is not None
        )

        from app.modules.commercial.models import CommercialAccount, CommercialSubscription

        billing_ready = (
            self.db.query(CommercialSubscription.id)
            .join(CommercialAccount, CommercialAccount.id == CommercialSubscription.commercial_account_id)
            .filter(
                CommercialAccount.organization_id == org_id,
                CommercialSubscription.status.in_(list(_OPEN_SUBSCRIPTION_STATUSES)),
            )
            .first()
            is not None
        )

        return {
            "administrator": READINESS_READY if administrator_ready else READINESS_PENDING,
            "configuration": READINESS_READY if configuration_ready else READINESS_PENDING,
            "billing": READINESS_READY if billing_ready else READINESS_PENDING,
            # No integration registry exists anywhere in this codebase yet.
            "integration": READINESS_UNKNOWN,
        }

    def onboarding_blockers(self, organization: Organization) -> list[str]:
        return self._blockers_from_readiness(self.onboarding_readiness(organization))

    @staticmethod
    def _blockers_from_readiness(readiness: dict) -> list[str]:
        labels = {
            "administrator": "No active organization administrator",
            "configuration": "Billing configuration not seeded",
            "billing": "No open commercial subscription",
            "integration": "Integration status unknown",
        }
        return [labels[k] for k, v in readiness.items() if v != READINESS_READY]

    # ── Platform-wide lifecycle view (Phase 3C) ──────────────────────────────

    def platform_overview(self) -> dict:
        """Fleet-wide lifecycle composition for the Lifecycle & Onboarding page.

        Everything here is read from real rows: per-state organization counts,
        the PROVISIONING/ONBOARDING pipeline with evidence-based readiness,
        access-blocked tenants with their latest recorded transition, and the
        most recent LIFECYCLE_TRANSITION audit events. No projections.
        """
        from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog

        orgs = self.db.query(Organization).order_by(Organization.created_at.desc()).all()

        counts_by_state = {state.value: 0 for state in LifecycleState}
        pipeline: list[dict] = []
        blocked_ids: list[int] = []
        blocked_items: list[dict] = []

        for org in orgs:
            state = self.effective_state(org)
            counts_by_state[state.value] = counts_by_state.get(state.value, 0) + 1

            if state in (LifecycleState.PROVISIONING, LifecycleState.ONBOARDING):
                readiness = self.onboarding_readiness(org)
                pipeline.append(
                    {
                        "id": org.id,
                        "organization_code": org.organization_code,
                        "organization_name": org.organization_name,
                        "state": state.value,
                        "registered_at": org.created_at,
                        "onboarding_readiness": readiness,
                        "blockers": self._blockers_from_readiness(readiness),
                    }
                )

            if self.access_blocked(state):
                blocked_ids.append(org.id)
                blocked_items.append(
                    {
                        "id": org.id,
                        "organization_code": org.organization_code,
                        "organization_name": org.organization_name,
                        "lifecycle_state": state.value,
                        "last_transition_reason": None,
                        "last_transition_at": None,
                    }
                )

        # Latest recorded transition per blocked org — real audit evidence for
        # "why is this tenant blocked", never inferred from state alone.
        if blocked_ids:
            rows = (
                self.db.query(PlatformAuditLog)
                .filter(
                    PlatformAuditLog.action == PlatformAuditAction.LIFECYCLE_TRANSITION,
                    PlatformAuditLog.organization_id.in_(blocked_ids),
                )
                .order_by(PlatformAuditLog.id.desc())
                .all()
            )
            seen: set[int] = set()
            for row in rows:
                if row.organization_id in seen:
                    continue
                seen.add(row.organization_id)
                for item in blocked_items:
                    if item["id"] == row.organization_id:
                        item["last_transition_reason"] = row.reason
                        item["last_transition_at"] = row.created_at
                        break

        recent_rows = (
            self.db.query(PlatformAuditLog, Organization, User)
            .outerjoin(Organization, Organization.id == PlatformAuditLog.organization_id)
            .outerjoin(User, User.id == PlatformAuditLog.actor_id)
            .filter(PlatformAuditLog.action == PlatformAuditAction.LIFECYCLE_TRANSITION)
            .order_by(PlatformAuditLog.id.desc())
            .limit(25)
            .all()
        )
        recent_transitions = [
            {
                "id": log.id,
                "organization_id": log.organization_id,
                "organization_code": org.organization_code if org else None,
                "organization_name": org.organization_name if org else None,
                "from_state": (log.old_values or {}).get("lifecycle_state"),
                "to_state": (log.new_values or {}).get("lifecycle_state"),
                "reason": log.reason,
                "correlation_id": log.correlation_id,
                "actor_email": actor.email if actor else None,
                "created_at": log.created_at,
            }
            for log, org, actor in recent_rows
        ]

        return {
            "total_organizations": len(orgs),
            "counts_by_state": counts_by_state,
            "onboarding_pipeline": pipeline,
            "blocked_organizations": blocked_items,
            "recent_transitions": recent_transitions,
            "generated_at": datetime.utcnow(),
            "plane": "PLATFORM",
        }

    # ── Convenience resolution ───────────────────────────────────────────────

    def get_organization(self, organization_id: int) -> Organization:
        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", "id")
        return org

    @staticmethod
    def effective_state(organization: Organization) -> LifecycleState:
        """Rows created before the column existed carry the server default;
        NULL/UNSET can only appear on detached objects — normalize to ACTIVE."""
        return organization.lifecycle_state or LifecycleState.ACTIVE

    @staticmethod
    def access_blocked(state: LifecycleState) -> bool:
        return state in _ACCESS_BLOCKED_STATES

    @staticmethod
    def now() -> datetime:
        return datetime.utcnow()
