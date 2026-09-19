"""
modules/commercial/entitlement_override_service.py
------------------------------------------------------
ZB-COM-ENT-001 Part 2, §16.1 — CommercialOverride lifecycle: draft -> submit
-> approve/reject, plus revoke. Mirrors CommercialPlanVersionService's
submit_for_approval/approve_and_publish/reject shape exactly, reusing the
same generic ApprovalRequest/ApprovalService maker-checker mechanism
(super_admin/approval_service.py) rather than a bespoke self-approval check
on this model — ApprovalService.approve() already raises SelfApprovalError
when approver_user_id == requested_by_user_id, so that invariant is enforced
in exactly one place across the whole codebase.

Every override, regardless of risk classification, goes through the full
draft -> submit -> approve lifecycle — no single-actor shortcut for
STANDARD-risk keys (even a STANDARD override, e.g. quietly raising one
customer's limit, is a real financial/governance risk worth a second
approver).

Never commits — the caller's transaction owns atomicity.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.modules.commercial.enums import CommercialOverrideStatus
from app.modules.commercial.models import CommercialOverride

logger = logging.getLogger("zoiko_billing.commercial.entitlement_override")


def _override_snapshot(override: CommercialOverride) -> dict:
    return {
        "organization_id": override.organization_id,
        "entitlement_definition_id": override.entitlement_definition_id,
        "value": override.value,
        "reason": override.reason,
        "status": override.status.value if hasattr(override.status, "value") else override.status,
        "expires_at": override.expires_at.isoformat() if override.expires_at else None,
    }


class CommercialOverrideService:
    def __init__(self, db: Session):
        self.db = db

    def get_override(self, override_id: int) -> CommercialOverride | None:
        return self.db.query(CommercialOverride).filter(CommercialOverride.id == override_id).first()

    def list_active_for_organization(self, organization_id: int) -> list[CommercialOverride]:
        now = datetime.utcnow()
        return (
            self.db.query(CommercialOverride)
            .filter(
                CommercialOverride.organization_id == organization_id,
                CommercialOverride.status == CommercialOverrideStatus.APPROVED,
            )
            .filter(
                (CommercialOverride.expires_at.is_(None)) | (CommercialOverride.expires_at > now)
            )
            .all()
        )

    def create_draft(
        self,
        *,
        organization_id: int,
        entitlement_definition_id: int,
        value,
        reason: str,
        requested_by_user_id: int | None = None,
        expires_at: datetime | None = None,
    ) -> CommercialOverride:
        if not reason or not reason.strip():
            raise ValueError("A reason is required to create a CommercialOverride.")

        existing_live = (
            self.db.query(CommercialOverride)
            .filter(
                CommercialOverride.organization_id == organization_id,
                CommercialOverride.entitlement_definition_id == entitlement_definition_id,
                CommercialOverride.status == CommercialOverrideStatus.APPROVED,
            )
            .filter(
                (CommercialOverride.expires_at.is_(None))
                | (CommercialOverride.expires_at > datetime.utcnow())
            )
            .first()
        )
        if existing_live is not None:
            raise ValueError(
                f"An active APPROVED override already exists for organization {organization_id}, "
                f"entitlement_definition {entitlement_definition_id} (override {existing_live.id}); "
                "revoke it before creating a replacement."
            )

        override = CommercialOverride(
            organization_id=organization_id,
            entitlement_definition_id=entitlement_definition_id,
            value=value,
            reason=reason.strip(),
            status=CommercialOverrideStatus.DRAFT,
            requested_by_user_id=requested_by_user_id,
            expires_at=expires_at,
        )
        self.db.add(override)
        self.db.flush()
        logger.info(
            "Created CommercialOverride %s (org=%s, definition=%s) in DRAFT",
            override.id, organization_id, entitlement_definition_id,
        )
        return override

    def submit_for_approval(self, override: CommercialOverride, *, requested_by_user_id: int, reason: str):
        from app.modules.super_admin.approval_service import ApprovalService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if override.status != CommercialOverrideStatus.DRAFT:
            raise ValueError(
                f"CommercialOverride {override.id} is {override.status.name}, not DRAFT; cannot submit."
            )

        request = ApprovalService(self.db).create_request(
            request_type="entitlement_override",
            requested_by_user_id=requested_by_user_id,
            reason=reason,
            scope={
                "organization_id": override.organization_id,
                "entitlement_definition_id": override.entitlement_definition_id,
            },
            proposed_state=_override_snapshot(override),
            correlation_id=f"commercial_override:{override.id}",
        )
        override.status = CommercialOverrideStatus.PENDING_APPROVAL
        override.approval_request_id = request.id
        override.requested_by_user_id = requested_by_user_id
        self.db.flush()

        PlatformAuditService(self.db).log_no_commit(
            actor_id=requested_by_user_id,
            actor_role="super_admin" if requested_by_user_id is not None else None,
            action=PlatformAuditAction.ENTITLEMENT_OVERRIDE_SUBMITTED,
            entity_type="CommercialOverride",
            entity_id=override.id,
            organization_id=override.organization_id,
            reason=reason,
            correlation_id=f"commercial_override:{override.id}",
        )
        return override, request

    def approve_and_activate(self, override: CommercialOverride, *, approver_user_id: int) -> CommercialOverride:
        """PENDING_APPROVAL -> APPROVED. Raises SelfApprovalError if the
        approver is the same user who submitted the request (enforced in
        ApprovalService.approve, not merely here)."""
        from app.modules.super_admin.approval_service import ApprovalService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if override.status != CommercialOverrideStatus.PENDING_APPROVAL:
            raise ValueError(
                f"CommercialOverride {override.id} is {override.status.name}, "
                "not PENDING_APPROVAL; cannot approve."
            )
        request = ApprovalService(self.db).get_request(override.approval_request_id)
        if request is None:
            raise ValueError(f"CommercialOverride {override.id} has no linked ApprovalRequest.")

        ApprovalService(self.db).approve(request, approver_user_id)  # raises SelfApprovalError if self

        override.status = CommercialOverrideStatus.APPROVED
        override.approved_by_user_id = approver_user_id
        self.db.flush()
        logger.info("CommercialOverride %s approved by %s", override.id, approver_user_id)

        PlatformAuditService(self.db).log_no_commit(
            actor_id=approver_user_id,
            actor_role="super_admin" if approver_user_id is not None else None,
            action=PlatformAuditAction.ENTITLEMENT_OVERRIDE_APPROVED,
            entity_type="CommercialOverride",
            entity_id=override.id,
            organization_id=override.organization_id,
            new_values=_override_snapshot(override),
            correlation_id=f"commercial_override:{override.id}",
        )

        from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService

        EntitlementSnapshotService(self.db).recompute_snapshot(
            override.organization_id, reason="override_approved",
        )

        try:
            from app.modules.auth.models import User
            from app.services.email_service import send_entitlement_override_decided_email
            admin = self.db.query(User).filter(User.organization_id == override.organization_id, User.is_active == True).first()
            if admin and admin.email:
                send_entitlement_override_decided_email(
                    email=admin.email,
                    recipient_first_name=admin.first_name or "there",
                    override_id=override.id,
                    status="approved",
                    organization_id=override.organization_id,
                    db=self.db,
                )
        except Exception as mail_exc:
            logger.warning("Failed to send override approved email: %s", mail_exc)

        return override

    def reject(self, override: CommercialOverride, *, approver_user_id: int, rejection_reason: str) -> CommercialOverride:
        from app.modules.super_admin.approval_service import ApprovalService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if override.status != CommercialOverrideStatus.PENDING_APPROVAL:
            raise ValueError(
                f"CommercialOverride {override.id} is {override.status.name}, "
                "not PENDING_APPROVAL; cannot reject."
            )
        request = ApprovalService(self.db).get_request(override.approval_request_id)
        if request is None:
            raise ValueError(f"CommercialOverride {override.id} has no linked ApprovalRequest.")

        ApprovalService(self.db).reject(request, approver_user_id, rejection_reason)  # raises SelfApprovalError if self

        override.status = CommercialOverrideStatus.REJECTED
        self.db.flush()

        PlatformAuditService(self.db).log_no_commit(
            actor_id=approver_user_id,
            actor_role="super_admin" if approver_user_id is not None else None,
            action=PlatformAuditAction.ENTITLEMENT_OVERRIDE_REJECTED,
            entity_type="CommercialOverride",
            entity_id=override.id,
            organization_id=override.organization_id,
            reason=rejection_reason,
            correlation_id=f"commercial_override:{override.id}",
        )

        try:
            from app.modules.auth.models import User
            from app.services.email_service import send_entitlement_override_decided_email
            admin = self.db.query(User).filter(User.organization_id == override.organization_id, User.is_active == True).first()
            if admin and admin.email:
                send_entitlement_override_decided_email(
                    email=admin.email,
                    recipient_first_name=admin.first_name or "there",
                    override_id=override.id,
                    status="rejected",
                    reason=rejection_reason,
                    organization_id=override.organization_id,
                    db=self.db,
                )
        except Exception as mail_exc:
            logger.warning("Failed to send override rejected email: %s", mail_exc)

        return override

    def revoke(self, override: CommercialOverride, *, actor_id: int | None, reason: str) -> CommercialOverride:
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        if override.status != CommercialOverrideStatus.APPROVED:
            raise ValueError(
                f"CommercialOverride {override.id} is {override.status.name}, not APPROVED; cannot revoke."
            )
        override.status = CommercialOverrideStatus.REVOKED
        override.revoked_at = datetime.utcnow()
        override.revoked_by_user_id = actor_id
        self.db.flush()
        logger.info("CommercialOverride %s revoked by %s", override.id, actor_id)

        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            actor_role="super_admin" if actor_id is not None else None,
            action=PlatformAuditAction.ENTITLEMENT_OVERRIDE_REVOKED,
            entity_type="CommercialOverride",
            entity_id=override.id,
            organization_id=override.organization_id,
            reason=reason,
            correlation_id=f"commercial_override:{override.id}",
        )

        from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService

        EntitlementSnapshotService(self.db).recompute_snapshot(
            override.organization_id, reason="override_revoked",
        )

        try:
            from app.modules.auth.models import User
            from app.services.email_service import send_entitlement_override_decided_email
            admin = self.db.query(User).filter(User.organization_id == override.organization_id, User.is_active == True).first()
            if admin and admin.email:
                send_entitlement_override_decided_email(
                    email=admin.email,
                    recipient_first_name=admin.first_name or "there",
                    override_id=override.id,
                    status="revoked",
                    reason=reason,
                    organization_id=override.organization_id,
                    db=self.db,
                )
        except Exception as mail_exc:
            logger.warning("Failed to send override revoked email: %s", mail_exc)

        return override


def draft_overrides_from_quote_items(db: Session, quote) -> list[CommercialOverride]:
    """§16.1 quote -> override linkage: for each CommercialQuoteItem on an
    accepted quote that carries a non-null entitlement_definition_id, create
    a DRAFT CommercialOverride from its entitlement_value. DRAFT only — an
    accepted commercial quote is not itself an approver; someone must still
    submit_for_approval() and a DIFFERENT user must approve_and_activate().

    A module-level function rather than a method on a CommercialQuoteService
    because no such service exists yet in this codebase (quotes are managed
    directly by commercial_billing_router) — this stays additive rather than
    introducing an unrelated refactor of quote management.
    """
    from app.modules.commercial.models import CommercialAccount

    account = db.query(CommercialAccount).filter(CommercialAccount.id == quote.commercial_account_id).first()
    if account is None:
        return []

    service = CommercialOverrideService(db)
    created = []
    for item in quote.items:
        if item.entitlement_definition_id is None:
            continue
        override = service.create_draft(
            organization_id=account.organization_id,
            entitlement_definition_id=item.entitlement_definition_id,
            value=item.entitlement_value,
            reason=f"Granted via accepted quote {quote.quote_number} (line {item.line_number}).",
            requested_by_user_id=quote.created_by,
        )
        created.append(override)
    return created
