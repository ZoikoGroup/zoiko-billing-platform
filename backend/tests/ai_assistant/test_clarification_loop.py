"""
test_clarification_loop.py
--------------------------
Regression tests for the disambiguation clarification loop:

  - A reply to a clarify question (even loosely phrased) must be matched
    against the options just offered — never re-ask the same question.
  - Page context (/billing/customers/dashboard) biases "X dashboard" toward
    the X view instead of asking.
  - Max ONE clarification round-trip: a second consecutive ambiguous reply
    commits to the most likely option with an explicit assumption note.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.conversation.engine import ConversationEngine
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


@pytest.fixture()
def engine(db):
    return ConversationEngine(db, model_gateway=None)


def _send(engine, ctx, message, page_path=None):
    conv = engine.create_conversation(ctx=ctx)
    return engine.send_message(
        conversation_uid=conv["conversation_uid"],
        message=message,
        ctx=ctx,
        page_path=page_path,
    )


def _two_turn(engine, ctx, first, second, page_path=None):
    conv = engine.create_conversation(ctx=ctx)
    uid = conv["conversation_uid"]
    r1 = engine.send_message(conversation_uid=uid, message=first, ctx=ctx, page_path=page_path)
    r2 = engine.send_message(conversation_uid=uid, message=second, ctx=ctx, page_path=page_path)
    return r1, r2


class TestClarificationLoop:
    def test_rephrased_answer_resolves_not_repeats(self, engine, ctx):
        """The exact reported repro: bot asks billing-vs-customer dashboard;
        user replies 'I need the customer Dashboard summary' → must resolve
        to the customer view, not re-ask word-for-word."""
        r1, r2 = _two_turn(
            engine, ctx,
            "customer dashboard",
            "I need the customer Dashboard summary",
        )
        assert "did you mean" in r1["answer"].lower()
        assert "did you mean" not in r2["answer"].lower(), (
            f"Clarification repeated verbatim: {r2['answer'][:200]!r}"
        )
        assert "taking your reply as" in r2["answer"].lower()
        assert "customer" in r2["answer"].lower()

    def test_keyword_reply_resolves_to_billing_dashboard(self, engine, ctx):
        """A bare keyword that matches one option moves forward."""
        r1, r2 = _two_turn(engine, ctx, "team dashboard", "billing")
        assert "did you mean" in r1["answer"].lower()
        assert "did you mean" not in r2["answer"].lower()
        # Routed to the financial dashboard summary
        assert "revenue" in r2["answer"].lower()

    def test_ordinal_reply_resolves(self, engine, ctx):
        """Ordinal pick of a REAL option resolves to it."""
        r1, r2 = _two_turn(engine, ctx, "customer dashboard", "the second one")
        assert "did you mean" not in r2["answer"].lower()
        assert "customer" in r2["answer"].lower()

    def test_ordinal_pick_of_placeholder_surface_commits_safely(self, engine, ctx):
        """'team' has no records surface — picking it still moves forward
        with an explicit assumption (billing dashboard), never a loop and
        never an unrelated capabilities dump."""
        r1, r2 = _two_turn(engine, ctx, "team dashboard", "the second one")
        assert "did you mean" not in r2["answer"].lower()
        assert "i'll assume" in r2["answer"].lower()
        assert "revenue" in r2["answer"].lower()

    def test_page_context_skips_clarification_entirely(self, engine, ctx):
        """User on /billing/customers/dashboard asking about 'customer
        dashboard' → resolve directly, no disambiguation question."""
        r = _send(
            engine, ctx,
            "customer dashboard summary",
            page_path="/billing/customers/dashboard",
        )
        assert "did you mean" not in r["answer"].lower()
        assert "customer" in r["answer"].lower()

    def test_page_context_does_not_hijack_other_pages(self, engine, ctx):
        """On the reports page there is no customer bias — but a reply can
        still resolve via keywords; and off-page first ask still clarifies."""
        r = _send(
            engine, ctx,
            "customer dashboard",
            page_path="/billing/reports",
        )
        assert "did you mean" in r["answer"].lower()

    def test_second_consecutive_clarify_commits_with_assumption(self, engine, ctx):
        """Max one round-trip: if the reply would trigger the SAME clarify
        again, commit to the default with an explicit assumption note."""
        r1, r2 = _two_turn(engine, ctx, "team dashboard", "I said the team dashboard")
        assert "did you mean" in r1["answer"].lower()
        assert "did you mean" not in r2["answer"].lower()
        assert "i'll assume" in r2["answer"].lower()
        # Default commitment is the billing dashboard summary
        assert "revenue" in r2["answer"].lower()

    def test_topic_change_after_clarification_works_normally(self, engine, ctx):
        """After a clarify, an unrelated new question is classified fresh —
        neither re-clarified nor force-routed through the stale options."""
        r1, r2 = _two_turn(engine, ctx, "team dashboard", "how many invoices are there?")
        assert "did you mean" not in r2["answer"].lower()
        assert "taking your reply as" not in r2["answer"].lower()
        assert "invoice" in r2["answer"].lower()

    def test_pending_state_cleared_after_resolution(self, engine, ctx):
        """Once resolved, the NEXT message classifies fresh (no lingering
        pending state)."""
        conv = engine.create_conversation(ctx=ctx)
        uid = conv["conversation_uid"]
        engine.send_message(conversation_uid=uid, message="customer dashboard", ctx=ctx)
        engine.send_message(conversation_uid=uid, message="the customer view", ctx=ctx)
        pending = engine._get_pending_clarification(
            engine._get_conversation(uid, ctx)
        )
        assert pending is None


class TestMatchClarifyOption:
    """Unit tests for the reply→option matcher."""

    OPTIONS = [
        {
            "label": "Your billing dashboard (financial summary)",
            "primary": ["billing", "financial", "finance"],
            "keywords": ["billing", "financial", "finance", "summary", "revenue"],
            "route": {"intent": "dashboard_summary", "domain": "dashboard"},
        },
        {
            "label": "The customer view (I can show customer records)",
            "primary": ["customer"],
            "keywords": ["customer", "customers", "client", "clients"],
            "route": {"intent": "customer_list", "domain": "billing"},
        },
    ]

    def _match(self, engine, text):
        return engine._match_clarify_option(text, {"options": self.OPTIONS})

    def test_full_rephrase_prefers_entity_over_generic_word(self, engine):
        """'summary' appears in option 1's keywords, but 'customer' is the
        decisive primary keyword → option 2."""
        assert self._match(engine, "I need the customer Dashboard summary") is self.OPTIONS[1]

    def test_bare_keyword(self, engine):
        assert self._match(engine, "customer") is self.OPTIONS[1]
        assert self._match(engine, "billing please") is self.OPTIONS[0]

    def test_ordinals(self, engine):
        assert self._match(engine, "the second one") is self.OPTIONS[1]
        assert self._match(engine, "first") is self.OPTIONS[0]

    def test_no_match_returns_none(self, engine):
        assert self._match(engine, "what is the weather today") is None
