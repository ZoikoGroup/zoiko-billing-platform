"""
test_conversation_titles.py
---------------------------
Regression tests for conversation history titling:

  - Conversations are titled from their FIRST USER MESSAGE (not the generic
    "New Conversation" placeholder).
  - Placeholder-titled conversations with 0 messages keep the placeholder.
  - Explicitly titled conversations are never overwritten.
  - Legacy conversations persisted with the placeholder get backfilled from
    their first stored user message when the history list is served.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.conversation.engine import (
    ConversationEngine,
    derive_conversation_title,
)
from app.modules.chatbot.context.ai_context import AIContext


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
    o = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db.add(o)
    db.flush()
    return o


@pytest.fixture()
def ctx(org):
    return AIContext(
        organization_id=org.id, user_id=1,
        tenant_context_id=1,
        role="admin", permissions=[], request_id="test",
        tenant_name="Zoiko Test",
    )


class TestDeriveTitle:
    def test_short_message_kept_verbatim(self):
        assert derive_conversation_title("Show overdue invoices") == "Show overdue invoices"

    def test_whitespace_collapsed(self):
        assert derive_conversation_title("  show   overdue \n invoices  ") == "Show overdue invoices"

    def test_long_message_truncated_at_word_boundary(self):
        title = derive_conversation_title("can you show me overdue invoices for this month please")
        assert title.endswith("…")
        assert len(title) <= 49  # 48 chars + ellipsis
        assert not title[:-1].endswith(" ")  # no dangling space before ellipsis

    def test_empty_message_falls_back_to_placeholder(self):
        assert derive_conversation_title("") == "New Conversation"
        assert derive_conversation_title(None) == "New Conversation"


class TestFirstMessageTitling:
    def test_new_conversation_without_messages_keeps_placeholder(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        result = engine.create_conversation(ctx=ctx)
        assert result["title"] == "New Conversation"

    def test_first_message_sets_title(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = engine.create_conversation(ctx=ctx)
        engine.send_message(conversation_uid=conv["conversation_uid"], message="Show overdue invoices", ctx=ctx)
        updated = engine.get_conversation(conversation_uid=conv["conversation_uid"], ctx=ctx)
        assert updated["title"] == "Show overdue invoices", (
            f"Expected first-message title, got {updated['title']!r}"
        )

    def test_initial_message_sets_title_at_creation(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = engine.create_conversation(ctx=ctx, initial_message="How many customers do we have?")
        assert conv["title"] == "How many customers do we have?"

    def test_second_message_does_not_overwrite_title(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = engine.create_conversation(ctx=ctx)
        engine.send_message(conversation_uid=conv["conversation_uid"], message="Dashboard summary please", ctx=ctx)
        engine.send_message(conversation_uid=conv["conversation_uid"], message="now show payments", ctx=ctx)
        updated = engine.get_conversation(conversation_uid=conv["conversation_uid"], ctx=ctx)
        assert updated["title"] == "Dashboard summary please"

    def test_explicit_title_is_preserved(self, db, org, ctx):
        engine = ConversationEngine(db, model_gateway=None)
        conv = engine.create_conversation(ctx=ctx, title="Q3 collections review")
        engine.send_message(conversation_uid=conv["conversation_uid"], message="Show overdue invoices", ctx=ctx)
        updated = engine.get_conversation(conversation_uid=conv["conversation_uid"], ctx=ctx)
        assert updated["title"] == "Q3 collections review"


class TestLegacyBackfill:
    def _make_legacy_conv(self, db, org, ctx, uid, with_message=True):
        """Simulate an old conversation persisted with the generic title."""
        from app.modules.chatbot.models import AIConversation, AIConversationMessage, ConversationStatus, SenderType

        conv = AIConversation(
            conversation_uid=uid,
            tenant_context_id=1,
            organization_id=org.id, user_id=ctx.user_id,
            title="New Conversation",
            conversation_status=ConversationStatus.OPEN,
        )
        db.add(conv)
        db.flush()
        if with_message:
            db.add(AIConversationMessage(
                conversation_id=conv.id,
                message_uid=f"msg-{uid}",
                sender_type=SenderType.USER,
                message_text="What is my outstanding balance?",
            ))
            db.flush()
        return conv

    def test_list_backfills_placeholder_titles_from_first_user_message(self, db, org, ctx):
        self._make_legacy_conv(db, org, ctx, "legacy-1")
        engine = ConversationEngine(db, model_gateway=None)

        listed = engine.list_conversations(ctx=ctx)
        match = [c for c in listed if c["conversation_uid"] == "legacy-1"]
        assert match, "legacy conversation missing from list"
        assert match[0]["title"] == "What is my outstanding balance?", (
            f"Expected backfilled title, got {match[0]['title']!r}"
        )

    def test_empty_legacy_conversation_keeps_placeholder(self, db, org, ctx):
        self._make_legacy_conv(db, org, ctx, "legacy-empty", with_message=False)
        engine = ConversationEngine(db, model_gateway=None)

        listed = engine.list_conversations(ctx=ctx)
        match = [c for c in listed if c["conversation_uid"] == "legacy-empty"]
        assert match[0]["title"] == "New Conversation"
