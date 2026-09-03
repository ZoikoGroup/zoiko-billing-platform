"""Regression: a chatbot handler database failure must never leave the
SQLAlchemy Session in an aborted transaction that is re-used for the audit
event / tool-invocation / final-commit flushes — which on PostgreSQL silently
replaces the ORIGINAL error with a spurious

    This Session's transaction has been rolled back due to a previous
    exception during flush.  ... (psycopg.errors.InFailedSqlTransaction)
    current transaction is aborted, commands ignored until end of transaction

Root cause of the "Show overdue invoices" failure: the live `invoices` table
was missing two ORM columns (idempotency_key / idempotency_request_hash), so
the handler's entity-SELECT failed with UndefinedColumn.  That aborted the
PostgreSQL transaction.  _invoke_handler then re-used the SAME session to
flush the ai_audit_event (MESSAGE_SENT) and run the final commit, producing
the misleading "current transaction is aborted" error that obscured the real
cause and could poison a shared session.

These tests pin the transaction-recovery CONTRACT (dialect-independent):
after a handler raises a database error, the engine must roll the Session back
so that
  1. the Session's transaction is recovered (rollback() is invoked),
  2. the original exception is not masked by InFailedSqlTransaction,
  3. the failed tool-invocation evidence is still written on a clean session,
  4. a subsequent DB operation / chatbot request succeeds on the same session.

SQLite (used by the in-memory test DB) does not abort its transaction the way
PostgreSQL does, so we simulate the abort by having the handler raise a real
SQLAlchemyError and assert the engine recovers the session with rollback().
"""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def org(db):
    o = Organization(organization_name="Zoiko Recovery", organization_code="ZR")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1,
        tenant_context_id=1,
        role="admin", permissions=[], request_id="recovery-test",
        tenant_name="Zoiko Recovery",
    )


def make_db_fail_handler(db):
    """A handler that performs a SQL statement referencing a nonexistent
    column — the pre-fix "Show overdue invoices" symptom — forcing the
    underlying transaction into a failed/aborted state."""
    def handler(conv, text_, intent, ctx):
        db.execute(
            text("SELECT definitely_missing_column FROM invoices")
        )
        raise AssertionError("query should have raised")
    return handler


def _setup_engine(db, org, ctx):
    engine = ConversationEngine(db, model_gateway=None)
    conv = AIConversation(
        conversation_uid="recovery-conv",
        tenant_context_id=ctx.tenant_context_id,
        organization_id=org.id,
        user_id=ctx.user_id,
        title="Recovery Test",
        conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    intent = {"domain": "billing", "intent": "list_overdue", "risk_class": "R1"}
    return engine, conv, intent


class TestHandlerTransactionRecovery:
    def test_session_is_rolled_back_after_handler_db_failure(self, db, org, ctx, monkeypatch):
        """The engine must roll the Session back when a handler fails, so the
        aborted transaction is never re-used.  Without the fix _invoke_handler
        never calls rollback() and this test fails."""
        registered = {"rollback": 0}
        real_rollback = db.rollback

        def spy_rollback():
            registered["rollback"] += 1
            return real_rollback()

        monkeypatch.setattr(db, "rollback", spy_rollback)

        engine, conv, intent = _setup_engine(db, org, ctx)
        handler = make_db_fail_handler(db)

        response = engine._invoke_handler(handler, conv, "Show overdue invoices", intent, ctx)

        # Fail-closed (P-06) response — never a raw SQLAlchemy error.
        assert response["mode"] == "M5_ESCALATE"
        assert response["risk_class"] == "R0"
        # The session MUST have been recovered.
        assert registered["rollback"] >= 1, (
            "handler failed with a DB error but the Session was never rolled back"
        )

    def test_handler_db_failure_does_not_mask_original_exception(
        self, db, org, ctx, monkeypatch, capsys, caplog
    ):
        """The original UndefinedColumn error (not a spurious InFailedSqlTransaction)
        must be the one the engine logs/raises at the handler boundary, and a
        subsequent valid write must succeed on the recovered session."""
        import logging

        engine, conv, intent = _setup_engine(db, org, ctx)
        handler = make_db_fail_handler(db)

        with caplog.at_level(logging.ERROR, logger="zoiko_billing"):
            response = engine._invoke_handler(handler, conv, "Show overdue invoices", intent, ctx)

        assert response["mode"] == "M5_ESCALATE"

        # The logged traceback must mention the ORIGINAL column error, and must
        # NOT be the misleading 'current transaction is aborted' replacement.
        recorded = "\n".join(rec.message for rec in caplog.records)
        assert "definitely_missing_column" in recorded or "no such column" in recorded.lower()
        assert "current transaction is aborted" not in recorded.lower()

        # Recovery proof: the same session accepts a new write + commit.
        db.add(AIConversation(
            conversation_uid="post-recovery-conv",
            tenant_context_id=ctx.tenant_context_id,
            organization_id=org.id,
            user_id=ctx.user_id,
            title="Post",
            conversation_status=ConversationStatus.OPEN,
        ))
        db.commit()
        count = db.query(AIConversation).filter(
            AIConversation.conversation_uid == "post-recovery-conv"
        ).count()
        assert count == 1

    def test_failed_tool_invocation_recorded_on_clean_session(self, db, org, ctx, monkeypatch):
        """The FAILED tool-invocation evidence row must still be written, on the
        recovered session, without a 'current transaction is aborted' error."""
        from app.modules.chatbot.models import ToolInvocation, ToolInvocationStatus

        engine, conv, intent = _setup_engine(db, org, ctx)
        handler = make_db_fail_handler(db)

        engine._invoke_handler(handler, conv, "Show overdue invoices", intent, ctx)
        db.commit()

        rows = db.query(ToolInvocation).filter(
            ToolInvocation.conversation_id == conv.id
        ).all()
        assert len(rows) == 1
        assert rows[0].status == ToolInvocationStatus.FAILED

    def test_consecutive_request_uses_clean_session(self, db, org, ctx, monkeypatch):
        """A failed request must not poison the session for the NEXT request."""
        engine, conv, intent = _setup_engine(db, org, ctx)
        engine._invoke_handler(make_db_fail_handler(db), conv, "Show overdue invoices", intent, ctx)

        # A second, normal operation on the SAME session must succeed.
        db.add(AIConversation(
            conversation_uid="second-request-conv",
            tenant_context_id=ctx.tenant_context_id,
            organization_id=org.id,
            user_id=ctx.user_id,
            title="Second Request",
            conversation_status=ConversationStatus.OPEN,
        ))
        db.commit()
        assert db.query(AIConversation).filter(
            AIConversation.conversation_uid == "second-request-conv"
        ).count() == 1


class TestSendMessageScenario:
    """End-to-end 'Show overdue invoices' through ConversationEngine.send_message:
    the request must not leave the Session in a failed transaction, and a
    subsequent request on the same session must still work."""

    def _conv(self, db, ctx, uid="scenario-conv"):
        conv = AIConversation(
            conversation_uid=uid,
            tenant_context_id=ctx.tenant_context_id,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            title="Placeholder title only",
            conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        # Commit, matching production (create_conversation persists the row).
        # A rollback of a just-flushed row would delete it from the session,
        # which would only mask the recovery behaviour under test.
        db.commit()
        return conv

    def test_overdue_request_then_second_request(self, db, org, ctx, monkeypatch, caplog):
        import logging

        engine = ConversationEngine(db, model_gateway=None)
        self._conv(db, ctx)

        # Force the billing-domain handler (the actual dispatch target that
        # `_get_handler("billing")` returns for "Show overdue invoices", whose
        # resolved intent routes to `_handle_billing`) to fail with a database
        # error — the exact class of failure that aborts the transaction on
        # PostgreSQL.
        def boom(conv, text_, intent, ctx):
            db.execute(text("SELECT definitely_missing_column FROM invoices"))
            raise AssertionError("should have raised")
        monkeypatch.setattr(engine, "_handle_billing", boom)

        registered = {"rollback": 0}
        real_rollback = db.rollback

        def spy_rollback():
            registered["rollback"] += 1
            return real_rollback()
        monkeypatch.setattr(db, "rollback", spy_rollback)

        with caplog.at_level(logging.ERROR, logger="zoiko_billing"):
            resp = engine.send_message(
                conversation_uid="scenario-conv", message="Show overdue invoices", ctx=ctx,
            )

        # Controlled failure (fail-closed), not an InFailedSqlTransaction leak.
        assert resp["mode"] == "M5_ESCALATE"
        assert resp["risk_class"] == "R0"

        recorded = "\n".join(r.message for r in caplog.records)
        assert "definitely_missing_column" in recorded or "no such column" in recorded.lower()
        assert "current transaction is aborted" not in recorded.lower()

        # Session recovered — a second request on the SAME session must work.
        engine2 = ConversationEngine(db, model_gateway=None)
        resp2 = engine2.send_message(
            conversation_uid="scenario-conv", message="Revenue this month", ctx=ctx,
        )
        assert resp2 is not None
