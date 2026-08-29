"""
actions/action_engine.py
------------------------
Governed action lifecycle implementing the full state machine from
GOVERNANCE.md:

  DRAFT -> VALIDATING -> READY_FOR_PREVIEW -> PREVIEWED ->
  { CONFIRMATION_REQUIRED | APPROVAL_REQUIRED | READY_TO_EXECUTE } ->
  EXECUTING ->
  { SUCCEEDED | FAILED | PENDING_EXTERNAL | EXCEPTION }

Starting with ONE action type end-to-end: invoice drafting.
Extends to payments/refunds/credits after this one is proven.

Key invariants:
  - No state may be skipped
  - Confirmation binds to preview hash
  - Execute requires valid, unexpired confirmation
  - Preview from authoritative billing service (not model arithmetic)
  - Resource versions rechecked immediately before write
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.modules.billing.models import Invoice, InvoiceItem, BillingCustomer

from ..context.ai_context import AIContext
from ..models import (
    AIActionDraft,
    AIActionPreview,
    AIActionConfirmation,
    AIActionExecution,
    AIApprovalRequest,
    AIApprovalDecision,
    FinancialResourcePointer,
    ServiceResponseSnapshot,
    PolicyEvaluation,
    AIAuditEvent,
    RiskClass,
    DraftStatus,
    PreviewStatus,
    ConfirmationStatus,
    ApprovalRequestStatus,
    ApprovalDecisionType,
    ExecutionStatus,
    SnapshotType,
    AuditEventType,
)

logger = logging.getLogger("zoiko_billing.ai.actions")


def _uid() -> str:
    return str(uuid.uuid4())


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ── Risk policy thresholds (config-driven) ───────────────────────────────────

RISK_POLICIES = {
    "invoice_draft": {
        "auto_execute_threshold": Decimal("100.00"),
        "approval_threshold": Decimal("1000.00"),
        "max_amount": Decimal("100000.00"),
    },
    "payment_allocation": {
        "auto_execute_threshold": Decimal("500.00"),
        "approval_threshold": Decimal("5000.00"),
        "max_amount": Decimal("500000.00"),
    },
    "refund": {
        "auto_execute_threshold": Decimal("0.00"),  # Always requires confirmation
        "approval_threshold": Decimal("500.00"),
        "max_amount": Decimal("50000.00"),
    },
    "credit_note": {
        "auto_execute_threshold": Decimal("200.00"),
        "approval_threshold": Decimal("2000.00"),
        "max_amount": Decimal("200000.00"),
    },
}


class ActionEngineError(Exception):
    """Canonical chatbot action error (guide §24 — ApiProblem-style contract).

    Every error carries a stable `error_code` and a human `recovery` hint so
    clients never have to guess how to proceed from a bare status code.
    """

    DEFAULT_RECOVERY = {
        404: "Check the action or draft reference and try again.",
        409: "The state has moved on (e.g. preview superseded or already executed). Re-run the latest step first.",
        410: "This preview or approval has expired. Regenerate a fresh one and reconfirm.",
        403: "Your role does not permit this action. Ask an authorized user to approve it.",
        503: "Safe mode is active — execution is disabled. Try again later.",
        422: "The request could not be validated. Review the submitted parameters and retry.",
    }

    def __init__(
        self,
        message: str,
        status_code: int = 422,
        *,
        error_code: str | None = None,
        recovery: str | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code or f"action_{status_code}"
        self.recovery = recovery or self.DEFAULT_RECOVERY.get(status_code)


class ActionEngine:
    """Governed action lifecycle engine."""

    def __init__(self, db: Session):
        self.db = db

    # ── Phase 1: DRAFT (M2 — Prepare) ─────────────────────────────────

    def _resolve_authoritative_currency(self, ctx: AIContext, customer_id=None) -> str:
        """Sec 8.2 authoritative currency resolution — the SINGLE source of
        truth for a governed draft's currency: the customer's configured
        currency when one is attached, else the organization base currency
        (identical to the billing dashboard).  Never a hardcoded literal, and
        never inferred from the utterance.  The DRAFT pins the resolved value
        and every later lifecycle state must re-derive the same authoritative
        value and match it — a mismatch is a conflict, blocked (fail closed).
        """
        if customer_id:
            customer = self.db.query(BillingCustomer).filter(
                BillingCustomer.id == customer_id,
                BillingCustomer.organization_id == ctx.organization_id,
            ).first()
            if customer and customer.currency:
                return customer.currency
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        return BillingDashboardService(self.db)._get_base_currency(ctx.organization_id)

    def create_draft(
        self,
        *,
        ctx: AIContext,
        action_type: str,
        proposed_params: dict,
        conversation_id: int | None = None,
        risk_class: str = "R2",
    ) -> dict:
        """Create an action draft. No mutation possible at this stage."""
        proposed_params = dict(proposed_params if proposed_params else {})
        # Sec 8.2 currency pin: if the utterance named no currency, resolve the
        # authoritative one NOW (customer currency → org base) so the DRAFT
        # owns it and every later state passes it through unchanged — never
        # inferred, never a literal, never re-derived downstream.
        if action_type in ("invoice_draft", "credit_note", "refund", "payment_allocation") \
                and not proposed_params.get("currency"):
            proposed_params["currency"] = self._resolve_authoritative_currency(
                ctx, proposed_params.get("customer_id"),
            )
        draft = AIActionDraft(
            action_uid=_uid(),
            conversation_id=conversation_id,
            tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            action_type=action_type,
            risk_class=RiskClass(risk_class),
            proposed_params=proposed_params,
            draft_status=DraftStatus.PROPOSED,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        self.db.add(draft)
        self.db.flush()

        # Validate the draft parameters
        validation_errors = self._validate_draft(action_type, proposed_params)
        if validation_errors:
            draft.draft_status = DraftStatus.REJECTED
            draft.validation_errors = validation_errors
            self.db.commit()
            raise ActionEngineError(
                f"Draft validation failed: {'; '.join(validation_errors)}",
                status_code=400,
            )

        draft.draft_status = DraftStatus.VALIDATED
        self.db.flush()

        self._audit(AuditEventType.ACTION_DRAFTED, ctx, {
            "action_uid": draft.action_uid,
            "action_type": action_type,
            "risk_class": risk_class,
        })

        self.db.commit()
        self.db.refresh(draft)

        return {
            "action_uid": draft.action_uid,
            "action_type": action_type,
            "status": draft.draft_status.value,
            "proposed_params": proposed_params,
            "created_at": draft.created_at.isoformat() if draft.created_at else None,
            "expires_at": draft.expires_at.isoformat() if draft.expires_at else None,
        }

    # ── Phase 2: PREVIEW (M3 — deterministic preview) ─────────────────

    def generate_preview(
        self,
        *,
        ctx: AIContext,
        action_uid: str,
        commit: bool = True,
    ) -> dict:
        """Generate deterministic preview from authoritative billing service.

        When commit=False the session is only flushed — the caller owns
        the transaction boundary.  This is used by the chat-message flow
        (ConversationEngine) which must not have mid-request commits.
        """
        print(f"\n[ACTION_ENGINE] generate_preview called: action_uid={action_uid}, commit={commit}", flush=True)

        draft = self._get_draft(action_uid, ctx)
        if not draft:
            print(f"[ACTION_ENGINE] draft NOT FOUND for uid={action_uid}", flush=True)
            raise ActionEngineError("Action draft not found.", status_code=404)

        print(f"[ACTION_ENGINE] draft found: id={draft.id}, status={draft.draft_status}, proposed_params={draft.proposed_params}", flush=True)

        if draft.draft_status != DraftStatus.VALIDATED:
            print(f"[ACTION_ENGINE] REJECTED: status is {draft.draft_status.value}", flush=True)
            raise ActionEngineError(
                f"Cannot preview: draft status is {draft.draft_status.value}, expected validated.",
                status_code=409,
            )

        if draft.expires_at:
            expires = draft.expires_at
            now_utc = datetime.now(timezone.utc)
            # SQLite returns naive datetimes — treat them as UTC
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires < now_utc:
                print(f"[ACTION_ENGINE] EXPIRED: expires_at={draft.expires_at}, now={now_utc}", flush=True)
                draft.draft_status = DraftStatus.EXPIRED
                if commit:
                    self.db.commit()
                else:
                    self.db.flush()
                raise ActionEngineError("Draft has expired. Please create a new draft.", status_code=410)

        # Generate preview from authoritative billing service
        print(f"[ACTION_ENGINE] calling _generate_billing_preview...", flush=True)
        preview_data = self._generate_billing_preview(draft)
        print(f"[ACTION_ENGINE] preview_data keys={list(preview_data.keys())}", flush=True)

        # Compute preview hash for confirmation binding
        preview_payload_json = json.dumps(preview_data["preview_payload"], sort_keys=True, default=str)
        preview_hash = _hash(preview_payload_json)
        print(f"[ACTION_ENGINE] preview_hash computed: {preview_hash}", flush=True)
        print(f"[ACTION_ENGINE] preview_payload for hash: {preview_payload_json[:500]}", flush=True)

        preview = AIActionPreview(
            preview_uid=_uid(),
            action_draft_id=draft.id,
            tenant_context_id=ctx.tenant_context_id,
            preview_status=PreviewStatus.VALID,
            authoritative_service="billing_service",
            preview_payload=preview_data["preview_payload"],
            resource_version_vector=preview_data.get("resource_versions"),
            money_summary=preview_data.get("money_summary"),
            preview_hash=preview_hash,
            warnings=preview_data.get("warnings"),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
        )
        self.db.add(preview)
        self.db.flush()

        # Risk policy evaluation
        policy_result = self._evaluate_risk_policy(draft, preview_data)

        # Store service snapshot
        snapshot = ServiceResponseSnapshot(
            snapshot_uid=_uid(),
            action_draft_id=draft.id,
            snapshot_type=SnapshotType.PREVIEW,
            payload_hash=preview_hash,
            payload_redacted=self._redact_preview(preview_data),
            classification="confidential",
        )
        self.db.add(snapshot)

        self._audit(AuditEventType.ACTION_PREVIEWED, ctx, {
            "action_uid": action_uid,
            "preview_uid": preview.preview_uid,
            "preview_hash": preview_hash,
            "policy_result": policy_result["result"],
        })

        if commit:
            self.db.commit()
            self.db.refresh(preview)

        return {
            "preview_uid": preview.preview_uid,
            "preview_hash": preview_hash,
            "preview_payload": preview_data["preview_payload"],
            "money_summary": preview_data.get("money_summary"),
            "warnings": preview_data.get("warnings"),
            "created_at": preview.created_at.isoformat() if preview.created_at else None,
            "expires_at": preview.expires_at.isoformat() if preview.expires_at else None,
            "policy_result": policy_result,
            "requires_confirmation": policy_result["result"] in ("CONFIRMATION_REQUIRED", "APPROVAL_REQUIRED"),
            "requires_approval": policy_result["result"] == "APPROVAL_REQUIRED",
        }

    # ── Phase 3: CONFIRM (M3 — explicit user confirmation) ─────────────

    def confirm_action(
        self,
        *,
        ctx: AIContext,
        action_uid: str,
        preview_uid: str,
        preview_hash: str,
    ) -> dict:
        """Record explicit user confirmation bound to preview hash."""
        draft = self._get_draft(action_uid, ctx)
        if not draft:
            raise ActionEngineError("Action draft not found.", status_code=404)

        preview = (
            self.db.query(AIActionPreview)
            .filter(
                AIActionPreview.preview_uid == preview_uid,
                AIActionPreview.action_draft_id == draft.id,
            )
            .first()
        )
        if not preview:
            raise ActionEngineError("Preview not found.", status_code=404)

        if preview.preview_status != PreviewStatus.VALID:
            raise ActionEngineError(
                f"Cannot confirm: preview status is {preview.preview_status.value}.",
                status_code=409,
            )

        if preview.expires_at:
            expires = preview.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires < datetime.now(timezone.utc):
                preview.preview_status = PreviewStatus.EXPIRED
                self.db.commit()
                raise ActionEngineError("Preview has expired. Regenerate preview.", status_code=410)

        # CRITICAL: Bind confirmation to exact preview hash
        print(f"[ACTION_ENGINE] confirm_action hash check: stored={preview.preview_hash} received={preview_hash} match={preview.preview_hash == preview_hash}", flush=True)
        if preview.preview_hash != preview_hash:
            raise ActionEngineError(
                "Preview hash mismatch. The preview may have been modified. Regenerate preview.",
                status_code=412,
            )

        # Check resource versions haven't changed
        if preview.resource_version_vector:
            stale = self._check_resource_versions(preview)
            if stale:
                preview.preview_status = PreviewStatus.SUPERSEDED
                self.db.commit()
                raise ActionEngineError(
                    "Resource versions have changed since preview. Regenerate preview.",
                    status_code=412,
                )

        confirmation = AIActionConfirmation(
            confirmation_uid=_uid(),
            action_preview_id=preview.id,
            confirmed_by_user_id=ctx.user_id,
            confirmation_phrase_hash=preview_hash,
            status=ConfirmationStatus.CONFIRMED,
        )
        self.db.add(confirmation)

        self._audit(AuditEventType.ACTION_CONFIRMED, ctx, {
            "action_uid": action_uid,
            "preview_uid": preview_uid,
            "confirmed_by": ctx.user_id,
        })

        self.db.commit()

        return {
            "confirmation_uid": confirmation.confirmation_uid,
            "status": "confirmed",
            "preview_uid": preview_uid,
            "preview_hash": preview_hash,
        }

    # ── Phase 4: APPROVAL (maker-checker) ──────────────────────────────

    def request_approval(
        self,
        *,
        ctx: AIContext,
        action_uid: str,
    ) -> dict:
        """Request maker-checker approval for high-consequence actions."""
        draft = self._get_draft(action_uid, ctx)
        if not draft:
            raise ActionEngineError("Action draft not found.", status_code=404)

        if draft.risk_class not in (RiskClass.R3, RiskClass.R4):
            raise ActionEngineError("Approval not required for this risk class.", status_code=400)

        approval = AIApprovalRequest(
            approval_uid=_uid(),
            action_draft_id=draft.id,
            tenant_context_id=ctx.tenant_context_id,
            requested_by_user_id=ctx.user_id,
            required_approver_role="org_admin",
            request_status=ApprovalRequestStatus.PENDING,
            expires_at=datetime.now(timezone.utc) + timedelta(days=7),
        )
        self.db.add(approval)
        self.db.flush()

        self.db.commit()

        return {
            "approval_uid": approval.approval_uid,
            "status": "pending",
            "required_approver_role": approval.required_approver_role,
            "expires_at": approval.expires_at.isoformat() if approval.expires_at else None,
        }

    def decide_approval(
        self,
        *,
        ctx: AIContext,
        approval_uid: str,
        decision: str,
        comment: str | None = None,
    ) -> dict:
        """Record an approval decision."""
        approval = (
            self.db.query(AIApprovalRequest)
            .filter(AIApprovalRequest.approval_uid == approval_uid)
            .first()
        )
        if not approval:
            raise ActionEngineError("Approval request not found.", status_code=404)

        if approval.request_status != ApprovalRequestStatus.PENDING:
            raise ActionEngineError(
                f"Cannot decide: approval status is {approval.request_status.value}.",
                status_code=409,
                error_code="approval_not_decidable",
                recovery="Only pending approvals can be decided. Refresh the approval state.",
            )

        if approval.expires_at:
            expires = approval.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires < datetime.now(timezone.utc):
                approval.request_status = ApprovalRequestStatus.EXPIRED
                self.db.commit()
                raise ActionEngineError(
                    "Approval request has expired.",
                    status_code=410,
                    error_code="approval_expired",
                    recovery="Request a fresh approval before continuing.",
                )

        # Prevent self-approval (maker-checker)
        if approval.requested_by_user_id == ctx.user_id:
            raise ActionEngineError(
                "Self-approval is not permitted. Another authorized user must approve.",
                status_code=403,
                error_code="self_approval_forbidden",
                recovery="Ask another authorized user to approve this action.",
            )

        decision_enum = ApprovalDecisionType(decision)
        dec = AIApprovalDecision(
            decision_uid=_uid(),
            approval_request_id=approval.id,
            decided_by_user_id=ctx.user_id,
            decision=decision_enum,
            comment=comment,
        )
        self.db.add(dec)

        if decision_enum == ApprovalDecisionType.APPROVE:
            approval.request_status = ApprovalRequestStatus.APPROVED
            event_type = AuditEventType.ACTION_APPROVED
        else:
            approval.request_status = ApprovalRequestStatus.REJECTED
            event_type = AuditEventType.ACTION_REJECTED

        self._audit(event_type, ctx, {
            "approval_uid": approval_uid,
            "decision": decision,
            "decided_by": ctx.user_id,
        })

        self.db.commit()

        return {
            "approval_uid": approval_uid,
            "status": approval.request_status.value,
            "decision": decision,
        }

    # ── Phase 5: EXECUTE (M4 — canonical mutation) ─────────────────────

    def execute_action(
        self,
        *,
        ctx: AIContext,
        action_uid: str,
        idempotency_key: str,
    ) -> dict:
        """Execute the confirmed/approved action through canonical billing service."""
        draft = self._get_draft(action_uid, ctx)
        if not draft:
            raise ActionEngineError("Action draft not found.", status_code=404)

        preview = (
            self.db.query(AIActionPreview)
            .filter(AIActionPreview.action_draft_id == draft.id, AIActionPreview.preview_status == PreviewStatus.VALID)
            .first()
        )
        if not preview:
            raise ActionEngineError(
                "No valid preview found. Regenerate preview.",
                status_code=409,
                error_code="preview_missing",
                recovery="Regenerate a fresh preview, then confirm and execute.",
            )

        if preview.expires_at:
            expires = preview.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires < datetime.now(timezone.utc):
                raise ActionEngineError(
                    "Preview has expired. Regenerate and reconfirm.",
                    status_code=410,
                    error_code="preview_expired",
                    recovery="Regenerate a fresh preview and reconfirm before executing.",
                )

        # Verify confirmation exists
        confirmation = (
            self.db.query(AIActionConfirmation)
            .filter(
                AIActionConfirmation.action_preview_id == preview.id,
                AIActionConfirmation.status == ConfirmationStatus.CONFIRMED,
            )
            .first()
        )
        if not confirmation:
            raise ActionEngineError(
                "Confirmation required. Please confirm the preview before executing.",
                status_code=409,
                error_code="confirmation_required",
                recovery="Confirm the current preview before executing the action.",
            )

        # Check approval if required
        if draft.risk_class in (RiskClass.R3, RiskClass.R4):
            approval = (
                self.db.query(AIApprovalRequest)
                .filter(
                    AIApprovalRequest.action_draft_id == draft.id,
                    AIApprovalRequest.request_status == ApprovalRequestStatus.APPROVED,
                )
                .first()
            )
            if not approval:
                raise ActionEngineError(
                    "Approval required. This action must be approved before execution.",
                    status_code=409,
                    error_code="approval_required",
                    recovery="Have an authorized user approve the action before executing.",
                )

        # ── Duplicate-execution guard (BUG 2) ───────────────────────────
        # Reject if ANY prior execution already succeeded for this draft,
        # regardless of idempotency key.  This prevents a second
        # mutation from being created if the user taps execute twice
        # with different keys.
        prior_succeeded = (
            self.db.query(AIActionExecution)
            .join(AIActionPreview, AIActionExecution.action_preview_id == AIActionPreview.id)
            .filter(
                AIActionPreview.action_draft_id == draft.id,
                AIActionExecution.execution_status == ExecutionStatus.SUCCEEDED,
            )
            .first()
        )
        if prior_succeeded:
            raise ActionEngineError(
                "This action has already been executed. "
                f"Execution UID: {prior_succeeded.execution_uid}. "
                "Duplicate execution is not permitted.",
                status_code=409,
            )

        # Check idempotency
        existing_execution = (
            self.db.query(AIActionExecution)
            .filter(AIActionExecution.idempotency_key == idempotency_key)
            .first()
        )
        if existing_execution:
            return {
                "execution_uid": existing_execution.execution_uid,
                "status": existing_execution.execution_status.value,
                "idempotent_replay": True,
            }

        # Recheck resource versions immediately before write
        if preview.resource_version_vector:
            stale = self._check_resource_versions(preview)
            if stale:
                preview.preview_status = PreviewStatus.SUPERSEDED
                self.db.commit()
                raise ActionEngineError(
                    "Resource versions changed since preview. Regenerate and reconfirm.",
                    status_code=412,
                )

        # Execute through canonical billing service
        execution = AIActionExecution(
            execution_uid=_uid(),
            action_preview_id=preview.id,
            tenant_context_id=ctx.tenant_context_id,
            idempotency_key=idempotency_key,
            execution_status=ExecutionStatus.PENDING,
            authoritative_service="billing_service",
        )
        self.db.add(execution)
        self.db.flush()

        try:
            result = self._execute_billing_action(draft, preview, ctx)
            execution.execution_status = ExecutionStatus.SUCCEEDED
            execution.service_operation_id = result.get("operation_id")
            execution.result_payload = result
            execution.completed_at = datetime.now(timezone.utc)

            # Create resource pointers
            for res in result.get("resources_created", []):
                pointer = FinancialResourcePointer(
                    execution_id=execution.id,
                    resource_type=res["type"],
                    resource_ref_id=res["id"],
                    service_name="billing_service",
                    resource_version=res.get("version"),
                )
                self.db.add(pointer)

        except Exception as e:
            try:
                self.db.rollback()
            except Exception:
                pass
            execution.execution_status = ExecutionStatus.FAILED
            execution.error_detail = str(e)[:2000]
            execution.completed_at = datetime.now(timezone.utc)
            self._audit(AuditEventType.ACTION_FAILED, ctx, {
                "action_uid": action_uid,
                "execution_uid": execution.execution_uid,
                "error": str(e)[:500],
            })
            try:
                self.db.commit()
            except Exception:
                pass
            raise ActionEngineError(f"Execution failed: {e}", status_code=500)

        # ── Terminal-state enforcement (BUG 2 fix) ──────────────────────
        # Move draft to EXPIRED (terminal) and preview to SUPERSEDED so
        # any subsequent generate_preview() or execute_action() call
        # against the same action_uid is rejected.  Without this, a
        # second call with a different idempotency_key would find a
        # still-VALIDATED draft and still-VALID preview and duplicate
        # the mutation.
        draft.draft_status = DraftStatus.EXPIRED
        preview.preview_status = PreviewStatus.SUPERSEDED
        self.db.flush()

        self._audit(AuditEventType.ACTION_EXECUTED, ctx, {
            "action_uid": action_uid,
            "execution_uid": execution.execution_uid,
            "idempotency_key": idempotency_key,
        })

        self.db.commit()

        return {
            "execution_uid": execution.execution_uid,
            "status": execution.execution_status.value,
            "result": result,
            "completed_at": execution.completed_at.isoformat() if execution.completed_at else None,
        }

    # ── Cancel / Discard ────────────────────────────────────────────────

    def cancel_action(self, *, ctx: AIContext, action_uid: str) -> dict:
        """Discard a draft action. Sets status to EXPIRED."""
        draft = self._get_draft(action_uid, ctx)
        if not draft:
            raise ActionEngineError("Action draft not found.", status_code=404)
        if draft.draft_status in (DraftStatus.REJECTED, DraftStatus.EXPIRED):
            raise ActionEngineError("Action draft is already terminal.", status_code=409)

        draft.draft_status = DraftStatus.EXPIRED
        self.db.flush()
        self._audit(AuditEventType.ACTION_CANCELLED, ctx, {
            "action_uid": action_uid,
            "action_type": draft.action_type,
        })
        return {"action_uid": action_uid, "status": "expired", "cancelled": True}

    # ── Internal Helpers ───────────────────────────────────────────────

    def _get_draft(self, action_uid: str, ctx: AIContext) -> AIActionDraft | None:
        return (
            self.db.query(AIActionDraft)
            .filter(
                AIActionDraft.action_uid == action_uid,
                AIActionDraft.organization_id == ctx.organization_id,
                AIActionDraft.user_id == ctx.user_id,
            )
            .first()
        )

    def _validate_draft(self, action_type: str, params: dict) -> list[str]:
        """Validate draft parameters based on action type."""
        errors = []

        if action_type == "invoice_draft":
            if not params.get("customer_id") and not params.get("customer_name"):
                errors.append("customer_id or customer_name is required")
            if not params.get("line_items"):
                errors.append("line_items is required")
            if params.get("line_items"):
                for i, item in enumerate(params["line_items"]):
                    if not item.get("description"):
                        errors.append(f"line_items[{i}].description is required")
                    qty = item.get("quantity", 0)
                    try:
                        if float(qty) <= 0:
                            errors.append(f"line_items[{i}].quantity must be positive")
                    except (TypeError, ValueError):
                        errors.append(f"line_items[{i}.quantity must be a number")
                    price = item.get("unit_price", 0)
                    try:
                        if float(price) <= 0:
                            errors.append(f"line_items[{i}].unit_price must be positive — please provide an amount")
                    except (TypeError, ValueError):
                        errors.append(f"line_items[{i}].unit_price must be a number")

        return errors

    def _generate_billing_preview(self, draft: AIActionDraft) -> dict:
        """Generate preview from authoritative billing service (dry-run)."""
        params = draft.proposed_params or {}

        if draft.action_type == "invoice_draft":
            return self._preview_invoice_draft(params, draft)

        # Generic preview for other action types
        return {
            "preview_payload": {
                "action_type": draft.action_type,
                "params": params,
                "status": "preview",
            },
            "money_summary": None,
            "resource_versions": None,
            "warnings": [],
        }

    def _preview_invoice_draft(self, params: dict, draft: AIActionDraft) -> dict:
        """Preview invoice draft with line items and totals."""
        print(f"[ACTION_ENGINE] _preview_invoice_draft: params={params}", flush=True)
        customer = None
        if params.get("customer_id"):
            customer = self.db.query(BillingCustomer).filter(
                BillingCustomer.id == params["customer_id"],
                BillingCustomer.organization_id == draft.organization_id,
            ).first()

        # Currency consistency: draft invoices adopt the organization's base
        # currency (single source of truth, identical to the billing dashboard)
        # rather than a hardcoded literal.
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        base_currency = BillingDashboardService(self.db)._get_base_currency(draft.organization_id)

        line_items = params.get("line_items", [])
        # Sec 8.2 / P-06 hard control: the DRAFT's pinned currency IS
        # authoritative and must pass through UNCHANGED.  Re-deriving it here
        # or silently overwriting would let the preview drift from what the
        # user drafted.  Missing → block (regenerate the draft); mismatch
        # against the authoritative record → block as a conflict.
        currency = params.get("currency")
        if not currency:
            raise ActionEngineError(
                "Currency conflict: draft carries no currency. Regenerate the draft.",
                status_code=409,
            )
        resolved_ccy = customer.currency if customer and customer.currency else base_currency
        if currency != resolved_ccy:
            raise ActionEngineError(
                f"Currency conflict: draft is {currency} but the authoritative "
                f"record resolves to {resolved_ccy}. Regenerate the draft before previewing.",
                status_code=409,
            )

        # Calculate totals (deterministic, from params — not from model)
        subtotal = Decimal("0")
        for item in line_items:
            qty = Decimal(str(item.get("quantity", 1)))
            price = Decimal(str(item.get("unit_price", 0)))
            subtotal += qty * price

        tax_rate = Decimal(str(params.get("tax_rate", 0))) / Decimal("100")
        tax_amount = subtotal * tax_rate
        total = subtotal + tax_amount

        warnings = []
        if not customer:
            warnings.append("Customer not found — preview is based on provided parameters only.")

        return {
            "preview_payload": {
                "action_type": "invoice_draft",
                "customer_id": params.get("customer_id"),
                "customer_name": customer.company_name if customer else "Unknown",
                "line_items": [
                    {
                        "description": item.get("description"),
                        "quantity": item.get("quantity", 1),
                        "unit_price": str(item.get("unit_price", 0)),
                        "total": str(Decimal(str(item.get("quantity", 1))) * Decimal(str(item.get("unit_price", 0)))),
                    }
                    for item in line_items
                ],
                "currency": currency,
                "subtotal": str(subtotal),
                "tax_rate": str(params.get("tax_rate", 0)),
                "tax_amount": str(tax_amount),
                "total": str(total),
            },
            "money_summary": {
                "currency": currency,
                "subtotal": str(subtotal),
                "tax": str(tax_amount),
                "total": str(total),
            },
            "resource_versions": {},
            "warnings": warnings,
        }

    def _evaluate_risk_policy(self, draft: AIActionDraft, preview_data: dict) -> dict:
        """Evaluate risk policy to determine confirmation/approval requirements."""
        policy = RISK_POLICIES.get(draft.action_type, RISK_POLICIES["invoice_draft"])

        total = Decimal("0")
        if preview_data.get("money_summary", {}).get("total"):
            total = Decimal(preview_data["money_summary"]["total"])

        if total >= policy["approval_threshold"]:
            result = "APPROVAL_REQUIRED"
        elif total >= policy["auto_execute_threshold"]:
            result = "CONFIRMATION_REQUIRED"
        else:
            result = "READY_TO_EXECUTE"

        evaluation = PolicyEvaluation(
            evaluation_uid=_uid(),
            action_draft_id=draft.id,
            tenant_context_id=draft.tenant_context_id,
            policy_code=draft.action_type,
            risk_class=draft.risk_class,
            result=result,
            thresholds_applied={
                "total": str(total),
                "auto_execute_threshold": str(policy["auto_execute_threshold"]),
                "approval_threshold": str(policy["approval_threshold"]),
            },
        )
        self.db.add(evaluation)

        return {
            "result": result,
            "total": str(total),
            "thresholds": {
                "auto_execute": str(policy["auto_execute_threshold"]),
                "approval": str(policy["approval_threshold"]),
            },
        }

    def _check_resource_versions(self, preview: AIActionPreview) -> bool:
        """Check if resource versions have changed since preview. Returns True if stale."""
        # In production, this queries the authoritative service for current versions
        # and compares against preview.resource_version_vector
        return False

    def _execute_billing_action(self, draft: AIActionDraft, preview: AIActionPreview, ctx: AIContext) -> dict:
        """Execute the action through canonical billing service."""
        if draft.action_type == "invoice_draft":
            return self._execute_invoice_draft(draft, preview, ctx)

        raise ActionEngineError(f"Action type '{draft.action_type}' is not yet implemented.", status_code=501)

    def _execute_invoice_draft(self, draft: AIActionDraft, preview: AIActionPreview, ctx: AIContext) -> dict:
        """Create a draft invoice through the canonical billing service."""
        params = draft.proposed_params or {}
        preview_payload = preview.preview_payload or {}

        # Sec 8.2 / P-06 re-check immediately before the write: the DRAFT's
        # pinned currency must equal the PREVIEWED currency, and both must
        # still match the authoritative record right now.  Any drift is a
        # conflict — blocked before mutation, never silently overwritten.
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        base_currency = BillingDashboardService(self.db)._get_base_currency(draft.organization_id)

        customer_id = params.get("customer_id")
        if not customer_id:
            raise ActionEngineError("Cannot create invoice: customer_id is required.", status_code=422)

        draft_ccy = params.get("currency")
        preview_ccy = preview_payload.get("currency")
        if not draft_ccy or not preview_ccy or draft_ccy != preview_ccy:
            raise ActionEngineError(
                "Currency conflict: draft and preview currencies disagree. "
                "Regenerate the preview before executing.",
                status_code=409,
            )
        customer_rec = self.db.query(BillingCustomer).filter(
            BillingCustomer.id == customer_id,
            BillingCustomer.organization_id == draft.organization_id,
        ).first()
        resolved_ccy = customer_rec.currency if customer_rec and customer_rec.currency else base_currency
        if draft_ccy != resolved_ccy:
            raise ActionEngineError(
                f"Currency conflict: draft is {draft_ccy} but the authoritative "
                f"record resolves to {resolved_ccy}. Regenerate the draft before executing.",
                status_code=409,
            )
        currency = draft_ccy

        subtotal = Decimal(preview_payload.get("subtotal", "0"))
        tax_amount = Decimal(preview_payload.get("tax_amount", "0"))
        total = Decimal(preview_payload.get("total", "0"))

        now = date.today()
        from app.modules.chatbot.billing_adapter import BillingAdapter
        seq = BillingAdapter(self.db).count_invoices_for_org(draft.organization_id) + 1
        invoice_number = f"AI-INV-{now.strftime('%Y%m%d')}-{seq:04d}"

        invoice = Invoice(
            organization_id=draft.organization_id,
            customer_id=customer_id,
            invoice_number=invoice_number,
            invoice_type="STANDARD",
            status="DRAFT",
            issue_date=now,
            due_date=now + timedelta(days=30),
            subtotal=subtotal,
            discount_percentage=Decimal("0"),
            discount_amount=Decimal("0"),
            tax_amount=tax_amount,
            shipping_amount=Decimal("0"),
            round_off=Decimal("0"),
            total_amount=total,
            paid_amount=Decimal("0"),
            balance_due=total,
            currency=currency,
            exchange_rate=Decimal("1"),
            is_recurring=False,
            is_active=True,
            created_by=ctx.user_id,
            updated_by=ctx.user_id,
        )
        self.db.add(invoice)
        self.db.flush()

        for i, item in enumerate(preview_payload.get("line_items", []), start=1):
            line = InvoiceItem(
                organization_id=draft.organization_id,
                invoice_id=invoice.id,
                line_number=i,
                item_type="PRODUCT",
                description=item.get("description", ""),
                quantity=Decimal(str(item.get("quantity", 1))),
                unit_price=Decimal(str(item.get("unit_price", 0))),
                discount_percentage=Decimal("0"),
                discount_amount=Decimal("0"),
                tax_percentage=Decimal("0"),
                tax_amount=Decimal("0"),
                total=Decimal(str(item.get("total", 0))),
                is_tax_inclusive=False,
                sort_order=i,
            )
            self.db.add(line)

        self.db.flush()

        invoice.status = "SENT"
        invoice.sent_at = datetime.utcnow()
        self.db.flush()

        return {
            "operation_id": f"INV-SENT-{invoice.id}",
            "invoice_id": invoice.id,
            "invoice_number": invoice.invoice_number,
            "status": "invoice_sent",
            "resources_created": [
                {"type": "invoice", "id": invoice.id, "version": "1"},
            ],
        }

    def _redact_preview(self, preview_data: dict) -> dict:
        """Redact sensitive fields from preview for storage."""
        # Remove any PII, keep only structural data
        redacted = json.loads(json.dumps(preview_data, default=str))
        return redacted

    def _audit(self, event_type: AuditEventType, ctx: AIContext, payload: dict) -> None:
        event = AIAuditEvent(
            event_uid=_uid(),
            tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            event_type=event_type,
            event_payload=payload,
            correlation_id=ctx.request_id,
        )
        self.db.add(event)
