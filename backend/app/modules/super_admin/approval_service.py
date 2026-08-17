"""
modules/super_admin/approval_service.py
------------------------------------------
Generic maker-checker approval engine (ZB-COM-BILL-001 Phase 5).

Deliberately domain-agnostic: `request_type` names the material operation
(this pass wires up exactly one: "catalog_version_publish"), and
`scope`/`before_state`/`proposed_state` carry the domain payload as JSON so
new request types never require a schema change.

CRITICAL invariant, enforced HERE (not just in the UI, per the standard's
explicit instruction): the approver can never be the same user as the
requester. This is checked server-side in `approve()` and cannot be bypassed
by any caller.

Like PlatformAuditService, this service never commits — the caller's
transaction owns atomicity.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.commercial.enums import ApprovalStatus
from app.modules.super_admin.models import ApprovalRequest

logger = logging.getLogger("zoiko_billing.super_admin.approval")


class SelfApprovalError(ValueError):
    """Raised when a user attempts to approve/reject their own request."""


class ApprovalService:
    def __init__(self, db: Session):
        self.db = db

    def get_request(self, request_id: int) -> Optional[ApprovalRequest]:
        return self.db.query(ApprovalRequest).filter(ApprovalRequest.id == request_id).first()

    def list_requests(
        self,
        *,
        request_type: Optional[str] = None,
        status: Optional[ApprovalStatus] = None,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[ApprovalRequest], int]:
        query = self.db.query(ApprovalRequest)
        if request_type:
            query = query.filter(ApprovalRequest.request_type == request_type)
        if status is not None:
            query = query.filter(ApprovalRequest.status == status)
        total = query.count()
        rows = (
            query.order_by(ApprovalRequest.requested_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return rows, total

    def create_request(
        self,
        *,
        request_type: str,
        requested_by_user_id: int,
        reason: str,
        scope: Optional[dict] = None,
        before_state: Optional[dict] = None,
        proposed_state: Optional[dict] = None,
        evidence: Optional[dict] = None,
        correlation_id: Optional[str] = None,
    ) -> ApprovalRequest:
        request = ApprovalRequest(
            request_type=request_type,
            requested_by_user_id=requested_by_user_id,
            requested_at=datetime.utcnow(),
            reason=reason,
            scope=scope,
            before_state=before_state,
            proposed_state=proposed_state,
            evidence=evidence,
            status=ApprovalStatus.PENDING,
            correlation_id=correlation_id,
        )
        self.db.add(request)
        self.db.flush()
        logger.info(
            "ApprovalRequest %s created (type=%s, requested_by=%s)",
            request.id, request_type, requested_by_user_id,
        )
        return request

    def approve(self, request: ApprovalRequest, approver_user_id: int) -> ApprovalRequest:
        """Approve a PENDING request.

        Raises SelfApprovalError if approver_user_id == requested_by_user_id
        — this is the server-side maker-checker guarantee; it is checked
        here regardless of what the frontend does or does not enforce.
        """
        if request.status != ApprovalStatus.PENDING:
            raise ValueError(
                f"ApprovalRequest {request.id} is {request.status.name}, not PENDING; cannot approve."
            )
        if request.requested_by_user_id is not None and approver_user_id == request.requested_by_user_id:
            raise SelfApprovalError(
                "You cannot approve your own request. A different Super Admin must approve it."
            )
        request.status = ApprovalStatus.APPROVED
        request.approver_user_id = approver_user_id
        request.approved_at = datetime.utcnow()
        self.db.flush()
        logger.info("ApprovalRequest %s approved by %s", request.id, approver_user_id)
        return request

    def reject(self, request: ApprovalRequest, approver_user_id: int, rejection_reason: str) -> ApprovalRequest:
        if request.status != ApprovalStatus.PENDING:
            raise ValueError(
                f"ApprovalRequest {request.id} is {request.status.name}, not PENDING; cannot reject."
            )
        if request.requested_by_user_id is not None and approver_user_id == request.requested_by_user_id:
            raise SelfApprovalError(
                "You cannot reject your own request. A different Super Admin must review it."
            )
        request.status = ApprovalStatus.REJECTED
        request.approver_user_id = approver_user_id
        request.approved_at = datetime.utcnow()
        request.rejection_reason = rejection_reason
        self.db.flush()
        logger.info("ApprovalRequest %s rejected by %s", request.id, approver_user_id)
        return request

    def cancel(self, request: ApprovalRequest) -> ApprovalRequest:
        if request.status != ApprovalStatus.PENDING:
            raise ValueError(
                f"ApprovalRequest {request.id} is {request.status.name}, not PENDING; cannot cancel."
            )
        request.status = ApprovalStatus.CANCELLED
        self.db.flush()
        return request
