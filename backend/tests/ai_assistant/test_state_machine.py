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
        confirmation.confirmation_phrase_hash = preview.preview_hash

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


class TestNoAutoExecuteForR2Plus:
    """P0 — no unconfirmed auto-execution.  Every governed action (risk class
    R2 and above) requires an explicit preview followed by an explicit
    confirmation bound to that preview's ID/hash.  A missing confirmation
    record, or a confirmation that is NOT bound to the current preview,
    must raise ActionEngineError('Confirmation required...')."""

    @staticmethod
    def _draft_preview(risk_class):
        draft = MagicMock()
        draft.action_uid = f"test-draft-{risk_class.value}"
        draft.draft_status = DraftStatus.VALIDATED
        draft.risk_class = getattr(RiskClass, risk_class.value)
        draft.organization_id = 1
        draft.user_id = 1
        draft.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        draft.proposed_params = {}

        preview = MagicMock()
        preview.preview_uid = f"test-preview-{risk_class.value}"
        preview.preview_status = PreviewStatus.VALID
        preview.preview_hash = "valid-hash"
        preview.expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
        preview.resource_version_vector = None
        preview.action_draft_id = 1
        return draft, preview

    @pytest.mark.parametrize("risk_class", [RiskClass.R2, RiskClass.R3, RiskClass.R4])
    def test_execute_without_confirmation_fails_for_r2_plus(self, risk_class):
        """For every risk class R2 and above, execute WITHOUT a confirmation
        record tied to the exact preview must raise 'Confirmation required'."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)
        draft, preview = self._draft_preview(risk_class)

        db.query.return_value.filter.return_value.first.side_effect = [
            draft, preview, None,  # no confirmation record
        ]

        with pytest.raises(ActionEngineError, match="Confirmation required"):
            engine.execute_action(
                ctx=MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test"),
                action_uid=draft.action_uid,
                idempotency_key=f"test-key-{risk_class.value}",
            )

    @pytest.mark.parametrize("risk_class", [RiskClass.R2, RiskClass.R3, RiskClass.R4])
    def test_execute_with_unbound_confirmation_fails(self, risk_class):
        """P0: a confirmation record that exists but is NOT bound to the current
        preview hash must not authorize execution — the confirmation binding is
        re-verified at execute time."""
        from app.modules.chatbot.actions.action_engine import ActionEngine, ActionEngineError

        db = MagicMock()
        engine = ActionEngine(db)
        draft, preview = self._draft_preview(risk_class)

        stale_confirmation = MagicMock()
        stale_confirmation.status = ConfirmationStatus.CONFIRMED
        stale_confirmation.confirmation_phrase_hash = "some-other-preview-hash"

        db.query.return_value.filter.return_value.first.side_effect = [
            draft, preview, stale_confirmation,
        ]

        with pytest.raises(ActionEngineError, match="Confirmation required"):
            engine.execute_action(
                ctx=MagicMock(organization_id=1, user_id=1, tenant_context_id=1, request_id="test"),
                action_uid=draft.action_uid,
                idempotency_key=f"unbound-key-{risk_class.value}",
            )

    @staticmethod
    def _make_conversation(db_session, org):
        from app.modules.chatbot.models import AIConversation, ConversationStatus
        conv = AIConversation(
            conversation_uid="pol-conv",
            tenant_context_id=1,
            organization_id=org.id,
            user_id=1,
            title="test",
            conversation_status=ConversationStatus.OPEN,
        )
        db_session.add(conv)
        db_session.flush()
        return conv

    @pytest.mark.parametrize("risk_class", [RiskClass.R2, RiskClass.R3, RiskClass.R4])
    def test_risk_policy_never_auto_executes_r2_plus(self, db_session, risk_class):
        """The risk policy must NEVER classify an R2+ draft as READY_TO_EXECUTE —
        even a tiny/below-threshold amount.  No code path may receive a signal
        that an R2+ mutation is pre-authorized without confirmation."""
        from app.modules.chatbot.actions.action_engine import ActionEngine
        from app.modules.chatbot.models import AIActionDraft
        from app.modules.organizations.models import Organization

        org = Organization(organization_name="State Org", organization_code="ST1")
        db_session.add(org)
        db_session.flush()
        conv = self._make_conversation(db_session, org)

        draft = AIActionDraft(
            action_uid=f"pol-{risk_class.value}",
            conversation_id=conv.id,
            tenant_context_id=1,
            organization_id=org.id,
            user_id=1,
            action_type="invoice_draft",
            risk_class=risk_class,
            proposed_params={"customer_name": "TOM"},
            draft_status=DraftStatus.VALIDATED,
        )
        db_session.add(draft)
        db_session.flush()

        engine = ActionEngine(db_session)
        result = engine._evaluate_risk_policy(
            draft, {"money_summary": {"total": "10"}}
        )
        assert result["result"] == "CONFIRMATION_REQUIRED", (
            f"R{risk_class.value} low-value draft classified as {result['result']}"
        )

    def test_high_value_r3_r4_still_escalates_to_approval(self, db_session):
        """APPROVAL_REQUIRED escalation for R3/R4 above the approval threshold
        must be preserved — removal of the auto-execute tier must not soften
        maker-checker on high-value actions."""
        from app.modules.chatbot.actions.action_engine import ActionEngine
        from app.modules.chatbot.models import AIActionDraft
        from app.modules.organizations.models import Organization

        org = Organization(organization_name="State Org 2", organization_code="ST2")
        db_session.add(org)
        db_session.flush()
        conv = self._make_conversation(db_session, org)

        draft = AIActionDraft(
            action_uid="pol-approval",
            conversation_id=conv.id,
            tenant_context_id=1,
            organization_id=org.id,
            user_id=1,
            action_type="invoice_draft",
            risk_class=RiskClass.R3,
            proposed_params={"customer_name": "TOM"},
            draft_status=DraftStatus.VALIDATED,
        )
        db_session.add(draft)
        db_session.flush()

        engine = ActionEngine(db_session)
        result = engine._evaluate_risk_policy(
            draft, {"money_summary": {"total": "5000"}}
        )
        assert result["result"] == "APPROVAL_REQUIRED", result
