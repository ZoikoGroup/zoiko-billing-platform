"""
modules/super_admin/privileged_access_service.py
--------------------------------------------------
Domain B (Tenant Financial) privileged, just-in-time support access
(ZB-SA-CMD-003 §6/§7, ZB-SEC-PRIV-001).

Default OFF: a Super Admin has NO standing path into any tenant's billing
data (see core/dependencies.py — every billing router is scoped by
get_organization_id, which explicitly rejects super_admin tokens). This
service is the *only* way a Super Admin can read a tenant's billing summary,
and every grant it issues is:

  - tenant-scoped (one organization_id per grant)
  - reason + ticket/incident reference required
  - approved by an administrator of the tenant organization itself — the
    org admin's approval starts the session; nobody on the platform side can
    grant it (break-glass, with fresh MFA and mandatory review, is the only
    emergency path that skips it)
  - time-limited (<=30 minutes, auto-expiring, never renewed silently)
  - revocable at any moment by approver, security, or tenant admin
  - fully audited (PlatformAuditLog, correlation_id-linked, approver/revoker recorded)
  - read-only, with no export/download surface at all
"""

import logging
import secrets
import string
import uuid
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.mfa_service import verify_step_up
from app.modules.auth.models import User, UserRole
from app.modules.organizations.models import Organization
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import (
    AttentionSeverity,
    PlatformAuditAction,
    PrivilegedAccessStatus,
    PrivilegedTenantAccessGrant,
)

logger = logging.getLogger("zoiko_billing.super_admin.privileged_access")

MAX_GRANT_MINUTES = 30
APPROVAL_EXPIRY_MINUTES = 60
STEP_UP_WINDOW_MINUTES = 5
DEFAULT_SCOPE = "read_only_financial_summary"
BREAK_GLASS_REVIEW_HOURS = 24


class PrivilegedAccessService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = PlatformAuditService(db)

    # ── Notification Helper ──────────────────────────────────────────────

    def _notify_all_org_admins(
        self,
        org: Organization,
        grant: PrivilegedTenantAccessGrant,
        action: str,  # "requested" | "exited" | "revoked" | "break_glass"
        background_tasks=None,
    ) -> None:
        """Sends security notification emails to ALL active org admins for the tenant.
        Uses org.display_name or org.organization_name properly.
        """
        from app.config import settings as _settings
        from app.modules.notifications.service import dispatch_email
        from app.services.email_service import send_privileged_access_ended_email

        org_name = org.display_name or org.organization_name or "Your Organization"
        admins = (
            self.db.query(User)
            .filter(
                User.organization_id == org.id,
                User.role == UserRole.ORG_ADMIN,
                User.is_active == True,  # noqa: E712
            )
            .all()
        )

        for admin in admins:
            first_name = admin.first_name or "there"
            if action == "requested":
                dispatch_email(
                    template_id="ZB-SEC-018",
                    recipient_email=admin.email,
                    context={
                        "recipient_first_name": first_name,
                        "organization_name": org_name,
                        "reason": grant.reason,
                        "ticket_reference": grant.ticket_reference,
                        "requested_minutes": grant.requested_minutes,
                        "access_review_url": f"{_settings.FRONTEND_URL.rstrip('/')}/organization-admin/privileged-access-log",
                    },
                    event_name="privileged_access.requested",
                    entity_type="PrivilegedTenantAccessGrant",
                    entity_id=grant.id,
                    organization_id=org.id,
                    db=self.db,
                    background_tasks=background_tasks,
                    correlation_id=grant.correlation_id,
                    idempotency_key=f"privileged_access.requested:PrivilegedTenantAccessGrant:{grant.id}:{admin.id}",
                )
            elif action in ("exited", "revoked"):
                try:
                    send_privileged_access_ended_email(
                        email=admin.email,
                        recipient_first_name=first_name,
                        organization_name=org_name,
                        organization_id=grant.organization_id,
                        db=self.db,
                    )
                except Exception as mail_exc:
                    logger.warning("Failed to send privileged access ended email to %s: %s", admin.email, mail_exc)
            elif action == "break_glass":
                # Emergency notification to tenant admins
                try:
                    from app.services.email_service import send_approval_email
                    from app.config import settings as _settings
                    support_url = f"{_settings.FRONTEND_URL.rstrip('/')}/support"
                    send_approval_email(
                        admin.email,
                        "account_notification.html",
                        {
                            "subject": f"EMERGENCY NOTICE: Break-glass privileged access opened for {org_name}",
                            "preheader": "Emergency elevated access opened.",
                            "recipient_first_name": first_name,
                            "notification_title": "Emergency break-glass access opened",
                            "notification_body": (
                                f"An authorized operator opened emergency break-glass support access to {org_name} "
                                f"under incident reference {grant.ticket_reference}. Reason: {grant.reason}. "
                                "This access is time-limited to 30 minutes, read-only, fully audited, and subject to mandatory 24-hour security review."
                            ),
                            "primary_action_url": support_url,
                            "primary_action_label": "Contact support",
                            "fact_1_label": "Organization",
                            "fact_1_value": org_name,
                            "fact_2_label": "Incident Reference",
                            "fact_2_value": grant.ticket_reference,
                            "template_id": "ZB-SEC-018",
                        },
                        db=self.db,
                        organization_id=grant.organization_id,
                        event_name="support.break_glass_opened",
                    )
                except Exception as mail_exc:
                    logger.warning("Failed to send break-glass notice to %s: %s", admin.email, mail_exc)

    def _notify_platform_security(
        self,
        grant: PrivilegedTenantAccessGrant,
        event_type: str,
        note: Optional[str] = None,
    ) -> None:
        """Notifies platform security / security operators of high-priority events (e.g., break-glass, tenant revoke)."""
        logger.warning(
            "PLATFORM SECURITY ALERT [%s]: grant=%s org=%s ticket=%s note=%s",
            event_type, grant.id, grant.organization_id, grant.ticket_reference, note,
        )

    def _email_requester_revocation(self, grant: PrivilegedTenantAccessGrant, revoker: Optional[User], reason: str) -> None:
        """Emails the requester that their grant has been revoked."""
        if not grant.requested_by_user_id:
            return
        requester = self.db.query(User).filter(User.id == grant.requested_by_user_id).first()
        if not requester or not requester.email:
            return
        try:
            from app.services.email_service import send_approval_email
            revoker_desc = "Tenant Administrator" if grant.revoked_by_tenant else (revoker.email if revoker else "Platform Administrator")
            send_approval_email(
                requester.email,
                "account_notification.html",
                {
                    "subject": f"Notice: Privileged access grant #{grant.id} revoked",
                    "preheader": "Privileged access grant revoked.",
                    "recipient_first_name": requester.first_name or "there",
                    "notification_title": "Privileged access grant revoked",
                    "notification_body": f"Your privileged tenant access grant #{grant.id} was revoked by {revoker_desc}. Reason: {reason}",
                    "primary_action_url": "#",
                    "primary_action_label": "View details",
                    "fact_1_label": "Grant ID",
                    "fact_1_value": str(grant.id),
                    "fact_2_label": "Revoked By",
                    "fact_2_value": revoker_desc,
                    "fact_3_label": "Reason",
                    "fact_3_value": reason,
                    "template_id": "ZB-SEC-REVOKED",
                },
                db=self.db,
                event_name="privileged_access.revoked",
            )
        except Exception as exc:
            logger.warning("Failed to email requester about revocation: %s", exc)

    # ── Lifecycle ────────────────────────────────────────────────────────

    def request_access(
        self,
        actor: User,
        organization_id: int,
        reason: str,
        ticket_reference: str,
        requested_minutes: int = MAX_GRANT_MINUTES,
        background_tasks=None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
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

        if not self._active_org_admins(org.id):
            raise BadRequestException(
                "This organization has no active administrator who could approve support access. "
                "Ask the customer to add an organization admin, or use break-glass for a genuine emergency."
            )

        minutes = max(1, min(int(requested_minutes or MAX_GRANT_MINUTES), MAX_GRANT_MINUTES))
        correlation_id = uuid.uuid4().hex

        grant = PrivilegedTenantAccessGrant(
            organization_id=organization_id,
            requested_by_user_id=actor.id,
            reason=reason,
            ticket_reference=ticket_reference,
            scope=DEFAULT_SCOPE,
            status=PrivilegedAccessStatus.PENDING_APPROVAL,
            correlation_id=correlation_id,
            requested_minutes=minutes,
            requested_at=datetime.utcnow(),
        )
        self.db.add(grant)
        self.db.flush()

        metadata = {
            "ticket_reference": ticket_reference,
            "requested_minutes": minutes,
            "scope": DEFAULT_SCOPE,
        }
        if ip_address:
            metadata["ip_address"] = ip_address
        if user_agent:
            metadata["user_agent"] = user_agent

        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_REQUESTED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=organization_id,
            reason=reason,
            correlation_id=correlation_id,
            metadata=metadata,
        )

        self.db.commit()
        logger.info(
            "Privileged tenant access requested: grant=%s org=%s actor=%s ticket=%s",
            grant.id, organization_id, actor.email, ticket_reference,
        )
        self._notify_all_org_admins(org, grant, action="requested", background_tasks=background_tasks)
        return grant

    def _active_org_admins(self, organization_id: int) -> list[User]:
        return (
            self.db.query(User)
            .filter(
                User.organization_id == organization_id,
                User.role == UserRole.ORG_ADMIN,
                User.is_active == True,  # noqa: E712
            )
            .all()
        )

    def _load_tenant_grant(self, organization_id: int, grant_id: int) -> PrivilegedTenantAccessGrant:
        """A grant of the caller's own organization; 404 for any other org."""
        grant = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(
                PrivilegedTenantAccessGrant.id == grant_id,
                PrivilegedTenantAccessGrant.organization_id == organization_id,
            )
            .first()
        )
        if grant is None:
            raise NotFoundException("PrivilegedTenantAccessGrant", "id")
        return grant

    def list_pending_reviews(self, actor: User) -> list[PrivilegedTenantAccessGrant]:
        """Lists break-glass grants needing independent review, EXCLUDING the opener's own."""
        return (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(
                PrivilegedTenantAccessGrant.is_break_glass.is_(True),
                PrivilegedTenantAccessGrant.reviewed_at.is_(None),
                PrivilegedTenantAccessGrant.requested_by_user_id != actor.id,
            )
            .order_by(PrivilegedTenantAccessGrant.review_due_at.asc())
            .all()
        )

    def tenant_approve_grant(
        self,
        tenant_user: User,
        organization_id: int,
        grant_id: int,
        note: Optional[str] = None,
    ) -> PrivilegedTenantAccessGrant:
        """An admin of the tenant organization approves a support access
        request. This is the one and only approval: it starts the read-only
        session immediately, for the duration the operator requested."""
        grant = self._expire_if_stale(self._load_tenant_grant(organization_id, grant_id))
        if grant.status != PrivilegedAccessStatus.PENDING_APPROVAL:
            raise BadRequestException(
                f"This request can no longer be approved (status: {grant.status.value})."
            )
        if grant.requested_by_user_id == tenant_user.id:
            raise ForbiddenException("Self-approval is forbidden.")

        now = datetime.utcnow()
        note = (note or "").strip() or None
        grant.tenant_approved_by_user_id = tenant_user.id
        grant.tenant_approved_at = now
        grant.approved_by_user_id = tenant_user.id
        grant.approved_at = now
        grant.approval_note = note
        grant.status = PrivilegedAccessStatus.ACTIVE
        grant.activated_at = now
        grant.expires_at = now + timedelta(minutes=grant.requested_minutes)
        self._issue_support_account(grant)

        self.audit.log_no_commit(
            actor_id=tenant_user.id,
            actor_role="org_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_TENANT_APPROVED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=organization_id,
            reason=note or "Organization admin approved support access",
            correlation_id=grant.correlation_id,
            metadata={"tenant_approver_id": tenant_user.id, "status": grant.status.value},
        )
        self.audit.log_no_commit(
            actor_id=tenant_user.id,
            actor_role="org_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_GRANTED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=organization_id,
            correlation_id=grant.correlation_id,
            metadata={"expires_at": grant.expires_at.isoformat(), "granted_on_approval": True},
        )
        self._resolve_request_attention(grant)
        self.db.commit()
        logger.warning(
            "Privileged tenant access GRANTED by org admin: grant=%s org=%s approver=%s expires_at=%s",
            grant.id, organization_id, tenant_user.email, grant.expires_at,
        )
        self._email_requester_decision(grant, approved=True, note=note)
        return grant

    def tenant_deny_grant(
        self,
        tenant_user: User,
        organization_id: int,
        grant_id: int,
        note: str,
    ) -> PrivilegedTenantAccessGrant:
        """An admin of the tenant organization declines a pending request."""
        grant = self._expire_if_stale(self._load_tenant_grant(organization_id, grant_id))
        if grant.status != PrivilegedAccessStatus.PENDING_APPROVAL:
            raise BadRequestException(
                f"This request can no longer be declined (status: {grant.status.value})."
            )
        note = (note or "").strip()
        if not note:
            raise BadRequestException("Please give a reason for declining the request.")

        grant.status = PrivilegedAccessStatus.DENIED
        grant.approval_note = note
        self.audit.log_no_commit(
            actor_id=tenant_user.id,
            actor_role="org_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_DENIED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=organization_id,
            reason=note,
            correlation_id=grant.correlation_id,
            metadata={"tenant_approver_id": tenant_user.id, "decision": "denied"},
        )
        self._resolve_request_attention(grant)
        self.db.commit()
        self._email_requester_decision(grant, approved=False, note=note)
        return grant

    def _email_requester_decision(self, grant: PrivilegedTenantAccessGrant, approved: bool, note: Optional[str]) -> None:
        """Tells the requesting operator the organization's decision."""
        requester = self.db.query(User).filter(User.id == grant.requested_by_user_id).first()
        if not requester or not requester.email:
            return
        try:
            from app.config import settings as _settings
            from app.services.email_service import send_approval_email

            org = self.db.query(Organization).filter(Organization.id == grant.organization_id).first()
            org_name = (org.display_name or org.organization_name) if org else "the organization"
            if approved:
                title = f"{org_name} approved your support access"
                body = (
                    f"An administrator of {org_name} approved your support access request "
                    f"(ticket {grant.ticket_reference}). Your temporary read-only login for {org_name} "
                    f"is ready on the Support Access page and stops working after "
                    f"{grant.requested_minutes} minutes. (For security, the password is never sent by email.)"
                )
            else:
                title = f"{org_name} declined your support access request"
                body = (
                    f"An administrator of {org_name} declined your support access request "
                    f"(ticket {grant.ticket_reference}). Reason: {note}"
                )
            send_approval_email(
                requester.email,
                "account_notification.html",
                {
                    "subject": title,
                    "preheader": title,
                    "recipient_first_name": requester.first_name or "there",
                    "notification_title": title,
                    "notification_body": body,
                    "primary_action_url": f"{_settings.FRONTEND_URL.rstrip('/')}/super-admin/support-access",
                    "primary_action_label": "Open Support Access",
                    "fact_1_label": "Organization",
                    "fact_1_value": org_name,
                    "fact_2_label": "Ticket",
                    "fact_2_value": grant.ticket_reference,
                    "template_id": "ZB-SEC-DECISION",
                },
                db=self.db,
                event_name="privileged_access.approved" if approved else "privileged_access.denied",
            )
        except Exception as exc:
            logger.warning("Failed to email requester about the access decision: %s", exc)

    def revoke_grant(
        self,
        actor: Optional[User],
        grant_id: int,
        reason: str,
        is_tenant: bool = False,
        tenant_org_id: Optional[int] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> PrivilegedTenantAccessGrant:
        query = self.db.query(PrivilegedTenantAccessGrant).filter(PrivilegedTenantAccessGrant.id == grant_id)
        if is_tenant and tenant_org_id is not None:
            query = query.filter(PrivilegedTenantAccessGrant.organization_id == tenant_org_id)
        grant = query.first()
        if grant is None:
            raise NotFoundException("PrivilegedTenantAccessGrant", "id")

        grant = self._expire_if_stale(grant)
        if grant.status not in (
            PrivilegedAccessStatus.PENDING_APPROVAL,
            PrivilegedAccessStatus.APPROVED,
            PrivilegedAccessStatus.ACTIVE,
            PrivilegedAccessStatus.PENDING_STEP_UP,
        ):
            raise BadRequestException(f"Grant cannot be revoked in status {grant.status.value}.")

        now = datetime.utcnow()
        was_active = (grant.status == PrivilegedAccessStatus.ACTIVE)
        grant.status = PrivilegedAccessStatus.REVOKED
        grant.revoked_at = now
        grant.revoke_reason = reason
        grant.revoked_by_tenant = is_tenant
        if actor:
            grant.revoked_by_user_id = actor.id

        if was_active:
            grant.exited_at = now
        self._retire_support_account(grant, now)

        metadata = {
            "revoker_id": actor.id if actor else None,
            "revoked_by_tenant": is_tenant,
            "revoke_reason": reason,
        }
        if ip_address:
            metadata["ip_address"] = ip_address
        if user_agent:
            metadata["user_agent"] = user_agent

        self.audit.log_no_commit(
            actor_id=actor.id if actor else None,
            actor_role="org_admin" if is_tenant else "super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_REVOKED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=grant.organization_id,
            reason=reason,
            correlation_id=grant.correlation_id,
            metadata=metadata,
        )

        self._resolve_request_attention(grant)

        org = self.db.query(Organization).filter(Organization.id == grant.organization_id).first()
        self.db.commit()

        # Email requester
        self._email_requester_revocation(grant, actor, reason)

        # If revoked by tenant, alert platform security
        if is_tenant:
            self._notify_platform_security(grant, event_type="tenant_revoked", note=reason)

        # If it was active, send exit notification to org admins
        if was_active and org:
            self._notify_all_org_admins(org, grant, action="revoked")

        return grant

    def open_break_glass(
        self,
        actor: User,
        organization_id: int,
        reason: str,
        incident_reference: str,
        code: Optional[str] = None,
        recovery_code: Optional[str] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        background_tasks=None,
    ) -> PrivilegedTenantAccessGrant:
        """Step 5: Break-glass emergency path.
        Requires capability tenant_support.break_glass + fresh MFA in the same request.
        Directly opens an ACTIVE grant for 30 minutes, sets review_due_at = now + 24h,
        creates P1 attention item, emails tenant admins and platform security.
        """
        reason = (reason or "").strip()
        incident_reference = (incident_reference or "").strip()
        if not reason:
            raise BadRequestException("A business reason is required for break-glass emergency access.")
        if not incident_reference:
            raise BadRequestException("An incident reference is required for break-glass emergency access.")

        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", "id")

        existing = self.get_active_or_pending_grant(actor)
        if existing is not None:
            raise BadRequestException(
                "You already have a pending or active privileged access session. "
                "Exit it before requesting break-glass access."
            )

        # Verify MFA step-up immediately in the same request
        try:
            verify_step_up(self.db, actor, code, recovery_code)
        except Exception:
            correlation_id = uuid.uuid4().hex
            self.audit.log_no_commit(
                actor_id=actor.id,
                actor_role="super_admin",
                action=PlatformAuditAction.PRIVILEGED_ACCESS_STEP_UP_FAILED,
                entity_type="PrivilegedTenantAccessGrant",
                entity_id=None,
                organization_id=organization_id,
                correlation_id=correlation_id,
                metadata={"reason": "break_glass_mfa_failed"},
            )
            self.db.commit()
            raise

        now = datetime.utcnow()
        correlation_id = uuid.uuid4().hex
        grant = PrivilegedTenantAccessGrant(
            organization_id=organization_id,
            requested_by_user_id=actor.id,
            reason=reason,
            ticket_reference=incident_reference,
            scope=DEFAULT_SCOPE,
            status=PrivilegedAccessStatus.ACTIVE,
            correlation_id=correlation_id,
            requested_minutes=MAX_GRANT_MINUTES,
            requested_at=now,
            activated_at=now,
            expires_at=now + timedelta(minutes=MAX_GRANT_MINUTES),
            is_break_glass=True,
            review_due_at=now + timedelta(hours=BREAK_GLASS_REVIEW_HOURS),
        )
        self.db.add(grant)
        self.db.flush()
        self._issue_support_account(grant)

        metadata = {
            "incident_reference": incident_reference,
            "is_break_glass": True,
            "review_due_at": grant.review_due_at.isoformat(),
            "expires_at": grant.expires_at.isoformat(),
        }
        if ip_address:
            metadata["ip_address"] = ip_address
        if user_agent:
            metadata["user_agent"] = user_agent

        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.BREAK_GLASS_OPENED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=organization_id,
            reason=reason,
            correlation_id=correlation_id,
            metadata=metadata,
        )

        # Create P1 attention item ("Break-glass access opened for {tenant}")
        try:
            from app.modules.super_admin.attention_service import AttentionService
            attention = AttentionService(self.db)
            org_name = org.display_name or org.organization_name
            attention.report_or_update(
                source="break_glass",
                source_key=f"break_glass:{grant.id}",
                title=f"Break-glass access opened for {org_name}",
                description=f"Operator {actor.email} opened emergency break-glass access under incident {incident_reference}. Mandatory review due within 24 hours.",
                base_severity=AttentionSeverity.P1,
                organization_id=org.id,
            )
        except Exception as exc:
            logger.warning("Failed to create attention item for break-glass: %s", exc)

        self.db.commit()
        logger.warning(
            "BREAK-GLASS access opened: grant=%s org=%s actor=%s incident=%s",
            grant.id, organization_id, actor.email, incident_reference,
        )

        # Email tenant admins marked emergency and email platform security
        self._notify_all_org_admins(org, grant, action="break_glass", background_tasks=background_tasks)
        self._notify_platform_security(grant, event_type="break_glass_opened", note=reason)
        return grant

    def review_break_glass(
        self,
        reviewer: User,
        grant_id: int,
        outcome: str,
        note: str,
    ) -> PrivilegedTenantAccessGrant:
        """Step 5: Review break-glass access. Reviewer MUST NOT be the opener."""
        grant = self.db.query(PrivilegedTenantAccessGrant).filter(PrivilegedTenantAccessGrant.id == grant_id).first()
        if grant is None:
            raise NotFoundException("PrivilegedTenantAccessGrant", "id")

        if not grant.is_break_glass:
            raise BadRequestException("This grant is not a break-glass session.")

        if grant.requested_by_user_id == reviewer.id:
            raise ForbiddenException("Self-review of break-glass access is prohibited. An independent reviewer is required.")

        if grant.reviewed_at is not None:
            raise BadRequestException("This break-glass session has already been reviewed.")

        outcome = (outcome or "").strip().lower()
        if outcome not in ("justified", "not_justified"):
            raise BadRequestException("Review outcome must be 'justified' or 'not_justified'.")
        note = (note or "").strip()
        if not note:
            raise BadRequestException("A review note is required.")

        now = datetime.utcnow()
        grant.reviewed_by_user_id = reviewer.id
        grant.reviewed_at = now
        grant.review_outcome = outcome
        grant.review_note = note

        self.audit.log_no_commit(
            actor_id=reviewer.id,
            actor_role="super_admin",
            action=PlatformAuditAction.BREAK_GLASS_REVIEWED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=grant.organization_id,
            reason=note,
            correlation_id=grant.correlation_id,
            metadata={"reviewer_id": reviewer.id, "outcome": outcome, "review_note": note},
        )

        # Resolves the attention item
        try:
            from app.modules.super_admin.attention_service import AttentionService
            AttentionService(self.db).auto_resolve(
                source="break_glass",
                source_key=f"break_glass:{grant.id}",
            )
        except Exception:
            pass

        self.db.commit()
        logger.info(
            "BREAK-GLASS reviewed: grant=%s reviewer=%s outcome=%s",
            grant.id, reviewer.email, outcome,
        )
        return grant

    def exit_grant(self, actor: User, grant_id: int) -> PrivilegedTenantAccessGrant:
        grant = self._load_owned_grant(actor, grant_id)
        grant = self._expire_if_stale(grant)
        if grant.status == PrivilegedAccessStatus.ACTIVE:
            now = datetime.utcnow()
            grant.exited_at = now
            grant.status = PrivilegedAccessStatus.EXITED
            self._retire_support_account(grant, now)
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

            org = self.db.query(Organization).filter(Organization.id == grant.organization_id).first()
            if org:
                self._notify_all_org_admins(org, grant, action="exited")

        return grant

    def exit_all_active_for(self, actor: User) -> list[PrivilegedTenantAccessGrant]:
        """Idempotently exits all ACTIVE privileged grants held by actor (used on logout)."""
        active_grants = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(
                PrivilegedTenantAccessGrant.requested_by_user_id == actor.id,
                PrivilegedTenantAccessGrant.status == PrivilegedAccessStatus.ACTIVE,
            )
            .all()
        )
        exited = []
        for g in active_grants:
            g = self._expire_if_stale(g)
            if g.status == PrivilegedAccessStatus.ACTIVE:
                now = datetime.utcnow()
                g.exited_at = now
                g.status = PrivilegedAccessStatus.EXITED
                self._retire_support_account(g, now)
                self.db.flush()
                self.audit.log_no_commit(
                    actor_id=actor.id,
                    actor_role="super_admin",
                    action=PlatformAuditAction.PRIVILEGED_ACCESS_EXITED,
                    entity_type="PrivilegedTenantAccessGrant",
                    entity_id=g.id,
                    organization_id=g.organization_id,
                    correlation_id=g.correlation_id,
                    metadata={"reason": "user_logout"},
                )
                org = self.db.query(Organization).filter(Organization.id == g.organization_id).first()
                if org:
                    self._notify_all_org_admins(org, g, action="exited")
                exited.append(g)
        if exited:
            self.db.commit()
        return exited

    def _expire_if_stale(self, grant: PrivilegedTenantAccessGrant) -> PrivilegedTenantAccessGrant:
        """Lazy expiry: checks both active grant duration and unapproved request age."""
        now = datetime.utcnow()

        # Check unapproved request older than 60 minutes
        if grant.status == PrivilegedAccessStatus.PENDING_APPROVAL:
            if now - grant.requested_at > timedelta(minutes=APPROVAL_EXPIRY_MINUTES):
                grant.status = PrivilegedAccessStatus.EXPIRED_UNUSED
                self.db.flush()
                self.audit.log_no_commit(
                    actor_id=grant.requested_by_user_id,
                    actor_role="super_admin",
                    action=PlatformAuditAction.PRIVILEGED_ACCESS_EXPIRED,
                    entity_type="PrivilegedTenantAccessGrant",
                    entity_id=grant.id,
                    organization_id=grant.organization_id,
                    correlation_id=grant.correlation_id,
                    metadata={"reason": "approval_expired_unused"},
                )
                self.db.commit()
                return grant

        # Legacy PENDING_STEP_UP rows predate independent approval: nothing
        # creates that status any more, and activation requires APPROVED, so
        # such a grant can never become active. Left alone it would block the
        # operator from ever requesting again — retire it as unused.
        if grant.status == PrivilegedAccessStatus.PENDING_STEP_UP:
            grant.status = PrivilegedAccessStatus.EXPIRED_UNUSED
            self.db.flush()
            self.audit.log_no_commit(
                actor_id=grant.requested_by_user_id,
                actor_role="super_admin",
                action=PlatformAuditAction.PRIVILEGED_ACCESS_EXPIRED,
                entity_type="PrivilegedTenantAccessGrant",
                entity_id=grant.id,
                organization_id=grant.organization_id,
                correlation_id=grant.correlation_id,
                metadata={"reason": "legacy_pending_step_up_without_approval"},
            )
            self.db.commit()
            return grant

        # Approved but never activated within the step-up window
        if grant.status == PrivilegedAccessStatus.APPROVED:
            deadline = self.activation_deadline(grant)
            if deadline is not None and now > deadline:
                grant.status = PrivilegedAccessStatus.EXPIRED_UNUSED
                self.db.flush()
                self.audit.log_no_commit(
                    actor_id=grant.requested_by_user_id,
                    actor_role="super_admin",
                    action=PlatformAuditAction.PRIVILEGED_ACCESS_EXPIRED,
                    entity_type="PrivilegedTenantAccessGrant",
                    entity_id=grant.id,
                    organization_id=grant.organization_id,
                    correlation_id=grant.correlation_id,
                    metadata={"reason": "step_up_window_expired"},
                )
                self.db.commit()
                return grant

        # Check active session duration
        if grant.status == PrivilegedAccessStatus.ACTIVE and grant.expires_at and now >= grant.expires_at:
            grant.status = PrivilegedAccessStatus.EXPIRED
            grant.exited_at = grant.expires_at
            self._retire_support_account(grant, now)
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

    @staticmethod
    def activation_deadline(grant: PrivilegedTenantAccessGrant) -> Optional[datetime]:
        """When an APPROVED grant stops being activatable. Measured from the
        LAST approval that made it activatable: when the tenant approves after
        the platform, the window starts at the tenant's approval."""
        if grant.status != PrivilegedAccessStatus.APPROVED:
            return None
        approvals = [t for t in (grant.approved_at, grant.tenant_approved_at) if t is not None]
        ref_time = max(approvals) if approvals else grant.requested_at
        return ref_time + timedelta(minutes=STEP_UP_WINDOW_MINUTES)

    @staticmethod
    def approval_deadline(grant: PrivilegedTenantAccessGrant) -> Optional[datetime]:
        """When a PENDING_APPROVAL request lapses unused."""
        if grant.status != PrivilegedAccessStatus.PENDING_APPROVAL or grant.requested_at is None:
            return None
        return grant.requested_at + timedelta(minutes=APPROVAL_EXPIRY_MINUTES)

    def _resolve_request_attention(self, grant: PrivilegedTenantAccessGrant) -> None:
        try:
            from app.modules.super_admin.attention_service import AttentionService
            AttentionService(self.db).auto_resolve(
                source="privileged_access",
                source_key=f"privileged_access:request:{grant.id}",
            )
        except Exception:
            pass

    def cancel_request(self, actor: User, grant_id: int) -> PrivilegedTenantAccessGrant:
        """The requester withdraws their own not-yet-active request.

        Distinct from revoke_grant (a security/approver power over anyone's
        grant): this only ever touches the caller's own grant and only before
        it becomes active. An active session is ended with exit_grant.
        """
        grant = self._load_owned_grant(actor, grant_id)
        grant = self._expire_if_stale(grant)
        if grant.status not in (
            PrivilegedAccessStatus.PENDING_APPROVAL,
            PrivilegedAccessStatus.APPROVED,
            PrivilegedAccessStatus.PENDING_STEP_UP,
        ):
            raise BadRequestException(
                f"Only a request that is not yet active can be cancelled (status: {grant.status.value})."
            )

        reason = "Cancelled by requester before activation"
        grant.status = PrivilegedAccessStatus.REVOKED
        grant.revoked_at = datetime.utcnow()
        grant.revoked_by_user_id = actor.id
        grant.revoke_reason = reason
        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_REVOKED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=grant.organization_id,
            reason=reason,
            correlation_id=grant.correlation_id,
            metadata={"cancelled_by_requester": True},
        )
        self._resolve_request_attention(grant)
        self.db.commit()
        return grant

    def list_live_grants(self) -> list[PrivilegedTenantAccessGrant]:
        """Every grant that is pending, approved or active, across all
        operators: the oversight view for holders of tenant_support.revoke."""
        live = (
            PrivilegedAccessStatus.PENDING_APPROVAL,
            PrivilegedAccessStatus.APPROVED,
            PrivilegedAccessStatus.PENDING_STEP_UP,
            PrivilegedAccessStatus.ACTIVE,
        )
        grants = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(PrivilegedTenantAccessGrant.status.in_(live))
            .order_by(PrivilegedTenantAccessGrant.requested_at.desc())
            .all()
        )
        return [g for g in (self._expire_if_stale(g) for g in grants) if g.status in live]

    # ── Temporary tenant credentials ─────────────────────────────────────

    @staticmethod
    def _generate_password(length: int = 16) -> str:
        """Readable but strong: no look-alike characters, always mixed."""
        lower = "abcdefghijkmnpqrstuvwxyz"
        upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        digits = "23456789"
        symbols = "!@#$%*?"
        pool = lower + upper + digits + symbols
        chars = [secrets.choice(lower), secrets.choice(upper), secrets.choice(digits), secrets.choice(symbols)]
        chars += [secrets.choice(pool) for _ in range(length - len(chars))]
        secrets.SystemRandom().shuffle(chars)
        return "".join(chars)

    def _issue_support_account(self, grant: PrivilegedTenantAccessGrant) -> None:
        """Create the temporary, read-only tenant login for an active grant.

        The account is a tenant AUDITOR (read-only) in the grant's organization
        and stops working at grant.expires_at: login, refresh and every request
        enforce users.access_expires_at, and the account is deactivated the
        moment the grant ends for any reason.
        """
        from app.config import settings as _settings
        from app.core.mfa_crypto import encrypt_secret
        from app.core.security import hash_password

        suffix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        username = f"support-{grant.id}-{suffix}@{_settings.SUPPORT_ACCESS_ACCOUNT_DOMAIN}"
        password = self._generate_password()
        account = User(
            email=username,
            hashed_password=hash_password(password),
            role=UserRole.AUDITOR,
            organization_id=grant.organization_id,
            first_name="Zoiko Support",
            last_name=f"(temporary, ticket {grant.ticket_reference})"[:120],
            is_active=True,
            is_verified=True,
            access_expires_at=grant.expires_at,
        )
        self.db.add(account)
        self.db.flush()
        grant.support_user_id = account.id
        grant.support_username = username
        grant.support_password_encrypted = encrypt_secret(password)

    def _retire_support_account(self, grant: PrivilegedTenantAccessGrant, now: datetime) -> None:
        """Switch the temporary login off immediately (idempotent)."""
        if not grant.support_user_id:
            return
        account = self.db.query(User).filter(User.id == grant.support_user_id).first()
        if account is not None:
            account.is_active = False
            if account.access_expires_at is None or account.access_expires_at > now:
                account.access_expires_at = now
        # The password is useless from here on; don't keep it around.
        grant.support_password_encrypted = None

    def get_support_credentials(self, actor: User, grant_id: int) -> dict:
        """The temporary login for the caller's own ACTIVE grant. Audited."""
        from app.config import settings as _settings
        from app.core.mfa_crypto import decrypt_secret

        grant = self.require_active_grant(actor, grant_id)
        if not grant.support_username or not grant.support_password_encrypted:
            raise BadRequestException("No temporary login was issued for this session.")
        self.audit.log_no_commit(
            actor_id=actor.id,
            actor_role="super_admin",
            action=PlatformAuditAction.PRIVILEGED_ACCESS_VIEWED,
            entity_type="PrivilegedTenantAccessGrant",
            entity_id=grant.id,
            organization_id=grant.organization_id,
            correlation_id=grant.correlation_id,
            metadata={"credentials_viewed": True},
        )
        self.db.commit()
        return {
            "grant_id": grant.id,
            "username": grant.support_username,
            "password": decrypt_secret(grant.support_password_encrypted),
            "login_url": f"{_settings.FRONTEND_URL.rstrip('/')}/login",
            "role": "auditor",
            "access": "Read-only",
            "expires_at": grant.expires_at,
        }

    def expire_due_grants(self) -> int:
        """Background sweep: end every ACTIVE grant past its expiry (which
        retires its temporary login), and switch off any temporary account
        whose time is up. Returns how many grants were ended."""
        now = datetime.utcnow()
        due = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(
                PrivilegedTenantAccessGrant.status == PrivilegedAccessStatus.ACTIVE,
                PrivilegedTenantAccessGrant.expires_at <= now,
            )
            .all()
        )
        for grant in due:
            self._expire_if_stale(grant)

        stray = (
            self.db.query(User)
            .filter(User.access_expires_at.isnot(None), User.access_expires_at <= now, User.is_active == True)  # noqa: E712
            .all()
        )
        for account in stray:
            account.is_active = False
        if stray:
            self.db.commit()
        return len(due)

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
        """A Super Admin holds at most one live grant at a time."""
        grant = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(
                PrivilegedTenantAccessGrant.requested_by_user_id == actor.id,
                PrivilegedTenantAccessGrant.status.in_(
                    [
                        PrivilegedAccessStatus.PENDING_APPROVAL,
                        PrivilegedAccessStatus.APPROVED,
                        PrivilegedAccessStatus.PENDING_STEP_UP,
                        PrivilegedAccessStatus.ACTIVE,
                    ]
                ),
            )
            .order_by(PrivilegedTenantAccessGrant.requested_at.desc())
            .first()
        )
        if grant is None:
            return None
        grant = self._expire_if_stale(grant)
        # Lazy expiry may have just ended it; an ended grant is not live and
        # must not block a fresh request or show as the current session.
        if grant.status in (
            PrivilegedAccessStatus.EXPIRED,
            PrivilegedAccessStatus.EXPIRED_UNUSED,
        ):
            return None
        return grant

    def list_my_grants(self, actor: User, limit: int = 20) -> list[PrivilegedTenantAccessGrant]:
        grants = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(PrivilegedTenantAccessGrant.requested_by_user_id == actor.id)
            .order_by(PrivilegedTenantAccessGrant.requested_at.desc())
            .limit(limit)
            .all()
        )
        return [self._expire_if_stale(g) for g in grants]

    def require_active_grant(self, actor: User, grant_id: int) -> PrivilegedTenantAccessGrant:
        """Defense-in-depth re-check used immediately before returning any tenant data."""
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
            "organization_name": org.display_name or org.organization_name if org else None,
            "organization_code": org.organization_code if org else None,
            "domain": "B",
            "scope": grant.scope,
            "expires_at": grant.expires_at,
            "is_break_glass": grant.is_break_glass,
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
