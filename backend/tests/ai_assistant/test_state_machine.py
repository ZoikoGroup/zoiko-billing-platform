"""
tests/test_ai_assistant_state_machine.py
----------------------------------------
State machine tests: every illegal transition must fail.

Covers:
  - Execute without confirm -> must fail
  - Confirm with expired/mismatched preview hash -> must fail
  - Execute without approval when required -> must fail
  - Preview on expired draft -> must fail
  - Skip states (e.g., execute without preview) -> must fail
"""

import json
import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from app.modules.chatbot.models import (
    AIActionDraft,
    AIActionPreview,
    AIActionConfirmation,
    AIApprovalRequest,
    AIApprovalDecision,
    AIActionExecution,
    RiskClass,
    DraftStatus,
    PreviewStatus,
    ConfirmationStatus,
    ApprovalRequestStatus,
    ExecutionStatus,
)


class TestStateMachineTransitions:
    """Every illegal state transition must be rejected."""

    def test_execute_without_confirmation_fails(self):
        """Cannot execute without a valid confirmation."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-draft-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.risk_class = RiskClass.R2
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        draft.proposed_params = {}

        preview = MagicMock()
        preview.preview_uid = "test-preview-1"
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "valid-hash"
        preview.expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
        preview.resource_version_vector = None
        preview.action_draft_id = draft.id

        db.query.return_value.filter.return_value.first.side_effect = [draft, preview, None]  # No confirmation

        with pytest.raises(ActionEngineError, match="Confirmation required"):
            engine.execute_action(
                ctx=MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test"),
                action_uid="test-draft-1",
                idempotency_key="test-key-1",
            )

    def test_confirm_with_wrong_preview_hash_fails(self):
        """Cannot confirm with mismatched preview hash."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-draft-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

        preview = MagicMock()
        preview.preview_uid = "test-preview-1"
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "correct-hash"
        preview.expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
        preview.resource_version_vector = None
        preview.action_draft_id = draft.id

        db.query.return_value.filter.return_value.first.side_effect = [draft, preview]

        ctx = MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test")

        with pytest.raises(ActionEngineError, match="hash mismatch"):
            engine.confirm_action(
                ctx=ctx,
                action_uid="test-draft-1",
                preview_uid="test-preview-1",
                preview_hash="wrong-hash",
            )

    def test_confirm_with_expired_preview_fails(self):
        """Cannot confirm with expired preview."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-draft-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

        preview = MagicMock()
        preview.preview_uid = "test-preview-1"
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "valid-hash"
        preview.expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)  # Expired
        preview.resource_version_vector = None
        preview.action_draft_id = draft.id

        db.query.return_value.filter.return_value.first.side_effect = [draft, preview]

        ctx = MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test")

        with pytest.raises(ActionEngineError, match="expired"):
            engine.confirm_action(
                ctx=ctx,
                action_uid="test-draft-1",
                preview_uid="test-preview-1",
                preview_hash="valid-hash",
            )

    def test_preview_on_expired_draft_fails(self):
        """Cannot preview an expired draft."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-draft-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) - timedelta(hours=2)  # Expired

        db.query.return_value.filter.return_value.first.return_value = draft

        ctx = MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test")

        with pytest.raises(ActionEngineError, match="expired"):
            engine.generate_preview(ctx=ctx, action_uid="test-draft-1")

    def test_preview_on_rejected_draft_fails(self):
        """Cannot preview a rejected draft."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-draft-1"
        draft.draft_status = DraftStatus.REJECTED
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

        db.query.return_value.filter.return_value.first.return_value = draft

        ctx = MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test")

        with pytest.raises(ActionEngineError, match="rejected"):
            engine.generate_preview(ctx=ctx, action_uid="test-draft-1")

    def test_self_approval_fails(self):
        """Maker-checker: self-approval is not permitted."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        approval = MagicMock()
        approval.approval_uid = "test-approval-1"
        approval.request_status = ApprovalRequestStatus.PENDING
        approval.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
        approval.requested_by_user_id = 1  # Same user trying to approve

        db.query.return_value.filter.return_value.first.return_value = approval

        ctx = MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test")

        with pytest.raises(ActionEngineError, match="Self-approval"):
            engine.decide_approval(
                ctx=ctx,
                approval_uid="test-approval-1",
                decision="approve",
            )

    def test_idempotent_replay_prevents_double_execute(self):
        """BUG 2: After a SUCCEEDED execution, a second call — even with
        the same idempotency key — must be rejected with 409, not
        silently return an idempotent replay."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)

        draft = MagicMock()
        draft.action_uid = "test-draft-1"
        draft.draft_status = DraftStatus.VALIDATED
        draft.risk_class = RiskClass.R2
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        draft.proposed_params = {}

        preview = MagicMock()
        preview.preview_uid = "test-preview-1"
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "valid-hash"
        preview.expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
        preview.resource_version_vector = None
        preview.action_draft_id = draft.id

        existing_execution = MagicMock()
        existing_execution.execution_uid = "existing-exec-1"
        existing_execution.execution_status = ExecutionStatus.SUCCEEDED
        existing_execution.idempotency_key = "test-key-1"

        confirmation = MagicMock()
        confirmation.status = ConfirmationStatus.CONFIRMED
        confirmation.preview_hash = preview.preview_hash

        db.query.return_value.filter.return_value.first.side_effect = [
            draft, preview,  # draft lookup + preview lookup
            confirmation,  # confirmation check
            # idempotency check is NOT reached — the prior-succeeded
            # guard fires first via the .join() chain.
        ]

        # The prior-succeeded guard uses .join().filter().first() and
        # finds the existing SUCCEEDED execution → triggers 409.
        db.query.return_value.join.return_value.filter.return_value.first.return_value = existing_execution

        ctx = MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test")

        with pytest.raises(ActionEngineError, match="already been executed"):
            engine.execute_action(
                ctx=ctx,
                action_uid="test-draft-1",
                idempotency_key="test-key-1",
            )
