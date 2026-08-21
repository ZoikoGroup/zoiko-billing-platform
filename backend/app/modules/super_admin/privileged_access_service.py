"""
modules/super_admin/privileged_access_service.py
--------------------------------------------------
Domain B (Tenant Financial) privileged, just-in-time support access
(ZB-SA-CMD-003 §6/§7).

Default OFF: a Super Admin has NO standing path into any tenant's billing
data (see core/dependencies.py — every billing router is scoped by
get_organization_id, which explicitly rejects super_admin tokens). This
service is the *only* way a Super Admin can read a tenant's billing summary,
and every grant it issues is:

  - tenant-scoped (one organization_id per grant)
  - reason + ticket/incident reference required
  - MFA step-up protected (a fresh TOTP/recovery code, not the login session)
  - time-limited (<=30 minutes, auto-expiring, never renewed silently)
  - fully audited (PlatformAuditLog, correlation_id-linked)
  - read-only, with no export/download surface at all (see router.py — the
    tenant-summary endpoint returns plain JSON with no CSV/Excel/export
    action wired to it anywhere in the frontend)

Deliberately does NOT open the tenant's real billing routes to Super Admin.
Widening every existing billing router's authorization to accept a grant
would multiply blast radius across ~15 routers for no product benefit; the
spec's own core product law ("the Command Center is not the book of
record... governed operational read models") is better served by one
narrow, purpose-built summary built from the same authoritative
BillingDashboardService the tenant's own dashboard already uses.
"""

import logging
import uuid
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.mfa_service import verify_step_up
from app.modules.auth.models import User
from app.modules.organizations.models import Organization
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import (
    PlatformAuditAction,
    PrivilegedAccessStatus,
    PrivilegedTenantAccessGrant,
)

logger = logging.getLogger("zoiko_billing.super_admin.privileged_access")

MAX_GRANT_MINUTES = 30
# A request that isn't stepped-up within this window is abandoned rather
# than left "pending" forever — it never silently becomes active later.
STEP_UP_WINDOW_MINUTES = 5
DEFAULT_SCOPE = "read_only_financial_summary"


class PrivilegedAccessService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = PlatformAuditService(db)

    # ── Lifecycle ────────────────────────────────────────────────────────

    def request_access(
        self,
        actor: User,
        organization_id: int,
        reason: str,
        ticket_reference: str,
        requested_minutes: int = MAX_GRANT_MINUTES,
    ) -> PrivilegedTenantAccessGrant:
        reason = (reason or "").strip()
        ticket_reference = (ticket_reference or "").strip()
        if not reason:
            raise BadRequestException("A business reason is required to request tenant support access.")
        if not ticket_reference:
            raise BadRequestException("A ticket/incident reference is required to request tenant support access.")

        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", "id")

        existing = self.get_active_or_pending_grant(actor)
        if existing is not None:
            raise BadRequestException(
                "You already have a pending or active privileged access session. "
                "Exit it before requesting a new one."
            )

        minutes = max(1, min(int(requested_minutes or MAX_GRANT_MINUTES), MAX_GRANT_MINUTES))
        correlation_id = uuid.uuid4().hex

        grant = PrivilegedTenantAccessGrant(
            organization_id=organization_id,
            requested_by_user_id=actor.id,
            reason=reason,
            ticket_reference=ticket_reference,
            scope=DEFAULT_SCOPE,
            status=PrivilegedAccessStatus.PENDING_STEP_UP,
            correlation_id=correlation_id,
            requested_minutes=minutes,
            requested_at=datetime.utcnow(),
        )
        self.db.add(grant)
        self.db.flush()

        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_REQUESTED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=organization_id,
            reason=reason,
            correlation_id=correlation_id,
            metadata={"ticket_reference": ticket_reference, "requested_minutes": minutes, "scope": DEFAULT_SCOPE},
        )
        self.db.commit()
        logger.info(
            "Privileged tenant access requested: grant=%s org=%s actor=%s ticket=%s",
            grant.id, organization_id, actor.email, ticket_reference,
        )
        return grant

    def activate(
        self,
        actor: User,
        grant_id: int,
        code: Optional[str] = None,
        recovery_code: Optional[str] = None,
    ) -> PrivilegedTenantAccessGrant:
        grant = self._load_owned_grant(actor, grant_id)

        if grant.status != PrivilegedAccessStatus.PENDING_STEP_UP:
            raise BadRequestException(f"This request is no longer awaiting step-up (status: {grant.status.value}).")

        if datetime.utcnow() - grant.requested_at > timedelta(minutes=STEP_UP_WINDOW_MINUTES):
            grant.status = PrivilegedAccessStatus.DENIED
            self.audit.log_no_commit(
                actor_id=actor.id,
                actor_role="super_admin",
                action=PlatformAuditAction.PRIVILEGED_ACCESS_DENIED,
                entity_type="PrivilegedTenantAccessGrant",
                entity_id=grant.id,
                organization_id=grant.organization_id,
                correlation_id=grant.correlation_id,
                metadata={"reason": "step_up_window_expired"},
            )
            self.db.commit()
            raise BadRequestException(
                f"Step-up window expired ({STEP_UP_WINDOW_MINUTES} minutes). Request access again."
            )

        try:
            verify_step_up(self.db, actor, code, recovery_code)
        except Exception:
            self.audit.log_no_commit(
                actor_id=actor.id,
                actor_role="super_admin",
                action=PlatformAuditAction.PRIVILEGED_ACCESS_STEP_UP_FAILED,
                entity_type="PrivilegedTenantAccessGrant",
                entity_id=grant.id,
                organization_id=grant.organization_id,
                correlation_id=grant.correlation_id,
            )
            self.db.commit()
            raise

        now = datetime.utcnow()
        grant.status = PrivilegedAccessStatus.ACTIVE
        grant.activated_at = now
        grant.expires_at = now + timedelta(minutes=grant.requested_minutes)
        self.db.flush()

        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_GRANTED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=grant.organization_id,
            correlation_id=grant.correlation_id,
            metadata={"expires_at": grant.expires_at.isoformat()},
        )
        self.db.commit()
        logger.warning(
            "Privileged tenant access GRANTED: grant=%s org=%s actor=%s expires_at=%s",
            grant.id, grant.organization_id, actor.email, grant.expires_at,
        )
        return grant

    def exit_grant(self, actor: User, grant_id: int) -> PrivilegedTenantAccessGrant:
        grant = self._load_owned_grant(actor, grant_id)
        grant = self._expire_if_stale(grant)
        if grant.status == PrivilegedAccessStatus.ACTIVE:
            grant.exited_at = datetime.utcnow()
            grant.status = PrivilegedAccessStatus.EXITED
            self.db.flush()
            self.audit.log_no_commit(
                actor_id=actor.id,
                actor_role="super_admin",
                action=PlatformAuditAction.PRIVILEGED_ACCESS_EXITED,
                entity_type="PrivilegedTenantAccessGrant",
                entity_id=grant.id,
                organization_id=grant.organization_id,
                correlation_id=grant.correlation_id,
            )
            self.db.commit()
        return grant

    def _expire_if_stale(self, grant: PrivilegedTenantAccessGrant) -> PrivilegedTenantAccessGrant:
        """Lazy expiry: no background job needed — every read of a grant
        re-checks its own clock, so a grant can never be observed ACTIVE
        past its expires_at, regardless of when the next request happens."""
        if grant.status == PrivilegedAccessStatus.ACTIVE and grant.expires_at and datetime.utcnow() >= grant.expires_at:
            grant.status = PrivilegedAccessStatus.EXPIRED
            grant.exited_at = grant.expires_at
            self.db.flush()
            self.audit.log_no_commit(
                actor_id=grant.requested_by_user_id,
                actor_role="super_admin",
                action=PlatformAuditAction.PRIVILEGED_ACCESS_EXPIRED,
                entity_type="PrivilegedTenantAccessGrant",
                entity_id=grant.id,
                organization_id=grant.organization_id,
                correlation_id=grant.correlation_id,
            )
            self.db.commit()
        return grant

    def _load_owned_grant(self, actor: User, grant_id: int) -> PrivilegedTenantAccessGrant:
        grant = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(PrivilegedTenantAccessGrant.id == grant_id)
            .first()
        )
        if grant is None:
            raise NotFoundException("PrivilegedTenantAccessGrant", "id")
        if grant.requested_by_user_id != actor.id:
            # Never leaks whether the grant exists for another actor.
            raise NotFoundException("PrivilegedTenantAccessGrant", "id")
        return grant

    # ── Queries ──────────────────────────────────────────────────────────

    def get_active_or_pending_grant(self, actor: User) -> Optional[PrivilegedTenantAccessGrant]:
        """A Super Admin holds at most one live grant at a time — starting a
        new request while one is pending/active is rejected by the router,
        so tenant context can never silently stack or leak across an actor's
        own concurrent requests."""
        grant = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(
                PrivilegedTenantAccessGrant.requested_by_user_id == actor.id,
                PrivilegedTenantAccessGrant.status.in_(
                    [PrivilegedAccessStatus.PENDING_STEP_UP, PrivilegedAccessStatus.ACTIVE]
                ),
            )
            .order_by(PrivilegedTenantAccessGrant.requested_at.desc())
            .first()
        )
        if grant is None:
            return None
        return self._expire_if_stale(grant)

    def list_my_grants(self, actor: User, limit: int = 20) -> list[PrivilegedTenantAccessGrant]:
        return (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(PrivilegedTenantAccessGrant.requested_by_user_id == actor.id)
            .order_by(PrivilegedTenantAccessGrant.requested_at.desc())
            .limit(limit)
            .all()
        )

    def require_active_grant(self, actor: User, grant_id: int) -> PrivilegedTenantAccessGrant:
        """Defense-in-depth re-check used immediately before returning any
        tenant data — never trusts a status observed even a moment earlier."""
        grant = self._load_owned_grant(actor, grant_id)
        grant = self._expire_if_stale(grant)
        if grant.status != PrivilegedAccessStatus.ACTIVE:
            raise ForbiddenException(
                f"This privileged access session is not active (status: {grant.status.value})."
            )
        return grant

    def get_tenant_summary(self, actor: User, grant_id: int) -> dict:
        grant = self.require_active_grant(actor, grant_id)

        from app.modules.billing.services.dashboard_service import BillingDashboardService

        org = self.db.query(Organization).filter(Organization.id == grant.organization_id).first()
        dashboard = BillingDashboardService(self.db)
        summary = {
            "grant_id": grant.id,
            "organization_id": grant.organization_id,
            "organization_name": org.organization_name if org else None,
            "organization_code": org.organization_code if org else None,
            "domain": "B",
            "scope": grant.scope,
            "expires_at": grant.expires_at,
            "customer_summary": dashboard.get_customer_summary(grant.organization_id),
            "subscription_summary": dashboard.get_subscription_summary(grant.organization_id),
            "invoice_summary": dashboard.get_invoice_summary(grant.organization_id),
        }

        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_VIEWED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=grant.organization_id,
            correlation_id=grant.correlation_id,
        )
        self.db.commit()
        return summary
