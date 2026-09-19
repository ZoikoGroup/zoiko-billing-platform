"""Regression: conversation message order is stable regardless of identical
created_at timestamps (BUG 1 — "answer appears above its question").

A user question and its assistant reply are persisted in the same commit, and
`created_at` is CURRENT_TIMESTAMP (transaction start), so BOTH rows commonly get
the IDENTICAL timestamp.  Ordering the session serializer by `created_at` alone
is then undefined — the DB may hand the answer back BEFORE the question.  The
serializer now tie-breaks equal timestamps by the monotonically-increasing
primary key (insertion order), guaranteeing user -> assistant every time.

This test pins that guarantee by constructing a pair with byte-identical
created_at values and asserting the restored conversation keeps insertion order.
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import (
    AIConversation,
    AIConversationMessage,
    ConversationStatus,
    RiskClass,
    SenderType,
)


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
    o = Organization(organization_name="Zoiko Ordering", organization_code="ZO")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1,
        tenant_context_id=1,
        role="admin", permissions=[], request_id="order-test",
        tenant_name="Zoiko Ordering",
    )


def _make_conversation(db, org, ctx, *, uid="order-conv"):
    conv = AIConversation(
        conversation_uid=uid,
        tenant_context_id=ctx.tenant_context_id,
        organization_id=org.id,
        user_id=ctx.user_id,
        title="Ordering Test",
        conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv


def _add_with_identical_timestamp(db, conv_id, *, uid, sender, text, ts):
    db.add(
        AIConversationMessage(
            conversation_id=conv_id,
            message_uid=uid,
            sender_type=sender,
            message_text=text,
            mode="M1_INSPECT" if sender is SenderType.ASSISTANT else None,
            risk_class=RiskClass.R1,
            structured_payload={},
            # Identical timestamp on BOTH sides of the turn — the exact
            # condition that previously yielded undefined order.
            created_at=ts,
        )
    )


class TestMessageOrderReconciliation:
    def test_identical_created_at_preserves_user_before_answer(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conversation(db, org, ctx, uid="order-conv-same-ts")
        ts = datetime(2026, 9, 2, 17, 48, 0, tzinfo=timezone.utc)

        _add_with_identical_timestamp(
            db, conv.id, uid="m-user-1", sender=SenderType.USER,
            text="How to add the customer?", ts=ts,
        )
        _add_with_identical_timestamp(
            db, conv.id, uid="m-answer-1", sender=SenderType.ASSISTANT,
            text="Here is how to add a customer.", ts=ts,
        )
        # A second turn sharing ANOTHER identical timestamp, to prove the
        # tie-break holds across multiple turns.
        _add_with_identical_timestamp(
            db, conv.id, uid="m-user-2", sender=SenderType.USER,
            text="Now show overdue invoices", ts=ts,
        )
        _add_with_identical_timestamp(
            db, conv.id, uid="m-answer-2", sender=SenderType.ASSISTANT,
            text="Here are your overdue invoices.", ts=ts,
        )
        db.commit()

        detail = engine.get_conversation(conversation_uid="order-conv-same-ts", ctx=ctx)

        kinds = [m["sender_type"] for m in detail["messages"]]
        texts = [m["message_text"] for m in detail["messages"]]
        # User must always precede its answer, in exact insertion order.
        assert kinds == ["user", "assistant", "user", "assistant"], kinds
        assert texts == [
            "How to add the customer?",
            "Here is how to add a customer.",
            "Now show overdue invoices",
            "Here are your overdue invoices.",
        ], texts

    def test_interleaved_insertion_stays_in_id_order(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conversation(db, org, ctx, uid="order-conv-interleaved")
        ts = datetime(2026, 9, 2, 18, 5, 0, tzinfo=timezone.utc)

        _add_with_identical_timestamp(db, conv.id, uid="i-u1", sender=SenderType.USER,
                                      text="q1", ts=ts)
        _add_with_identical_timestamp(db, conv.id, uid="i-a1", sender=SenderType.ASSISTANT,
                                      text="a1", ts=ts)
        _add_with_identical_timestamp(db, conv.id, uid="i-u2", sender=SenderType.USER,
                                      text="q2", ts=ts)
        _add_with_identical_timestamp(db, conv.id, uid="i-a2", sender=SenderType.ASSISTANT,
                                      text="a2", ts=ts)
        db.commit()

        detail = engine.get_conversation(conversation_uid="order-conv-interleaved", ctx=ctx)
        texts = [m["message_text"] for m in detail["messages"]]
        assert texts == ["q1", "a1", "q2", "a2"], texts
