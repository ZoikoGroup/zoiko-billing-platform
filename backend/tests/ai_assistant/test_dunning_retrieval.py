"""
test_dunning_retrieval.py
-------------------------
Tests that dunning-related questions are correctly answered from the
knowledge base, verifying the retrieval pipeline loads chunks properly
and returns grounded answers.

Covers:
  - ISSUE 1: retrieval pipeline loads chunks (no silent exception swallowing)
  - ISSUE 2: _sort_chunks_by_type orders definition before procedural content
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.models import (
    KnowledgeNamespace,
    KnowledgeSource,
    KnowledgeDocument,
    KnowledgeChunk,
    KnowledgeClassification,
    KnowledgeSourceDocType,
    FreshnessStatus,
    AIConversation,
    ConversationStatus,
)
from app.modules.chatbot.knowledge.retrieval import KnowledgeRetriever
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext

_sort_chunks_by_type = ConversationEngine._sort_chunks_by_type


KB_DOCS = {
    "Overdue Invoices and Dunning": [
        "An overdue invoice is one where the due date has passed and the balance remains unpaid. Overdue invoices may trigger dunning processes.",
        "Dunning is the systematic process of communicating with customers to collect overdue payments. It typically involves escalating reminders: friendly reminder, firm notice, final warning, account suspension.",
        "Dunning levels in Zoiko Billing: Level 1 (gentle reminder at 7 days past due), Level 2 (firm notice at 14 days), Level 3 (final warning at 30 days), Level 4 (account suspension at 45+ days).",
        "How to set up dunning: Go to Billing Settings, open the Dunning tab, configure reminder intervals, email templates, and escalation rules for each dunning level. Dunning runs automatically on overdue invoices.",
        "How to view overdue invoices: Go to the Dashboard, check the Overdue Invoices widget, or go to Invoices and filter by Overdue status. The aging report shows how long each invoice has been overdue.",
    ],
    "Invoices Overview": [
        "An invoice is a commercial document issued by a seller to a buyer, indicating the products, quantities, and agreed prices for services or products provided. In Zoiko Billing, invoices track what customers owe.",
        "Invoice statuses in Zoiko Billing: Draft, Sent, Partially Paid, Paid, Overdue, Cancelled, Refunded, Written Off.",
    ],
    "Payments and Allocations": [
        "A payment records money received from a customer. Each payment is linked to a customer and may be allocated across one or more invoices.",
        "Payment statuses: Pending, Processing, Cleared, Failed, Cancelled, Refunded.",
    ],
}


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
def kb(db):
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]', description="public KB",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id, source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing", title="Zoiko Billing Knowledge Base", status="active",
    )
    db.add(src)
    db.flush()
    for title, chunks in KB_DOCS.items():
        doc = KnowledgeDocument(
            source_id=src.id, document_version="1.0",
            freshness_status=FreshnessStatus.CURRENT, title=title, status="approved",
        )
        db.add(doc)
        db.flush()
        for seq, text in enumerate(chunks, 1):
            db.add(KnowledgeChunk(
                document_id=doc.id, chunk_sequence=seq, chunk_text=text,
                classification=KnowledgeClassification.INTERNAL,
            ))
    db.flush()
    return ns


@pytest.fixture()
def ctx(db, kb):
    o = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db.add(o)
    db.flush()
    return AIContext(
        organization_id=o.id, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="test", tenant_name="Zoiko Test",
    )


@pytest.fixture()
def engine(db):
    return ConversationEngine(db, model_gateway=None)


@pytest.fixture()
def conv(db, kb, ctx):
    c = AIConversation(
        conversation_uid="test-dunning-conv",
        tenant_context_id=ctx.tenant_context_id,
        organization_id=ctx.organization_id,
        user_id=ctx.user_id,
        title="Dunning Test",
        conversation_status=ConversationStatus.OPEN,
    )
    db.add(c)
    db.flush()
    return c


class TestDunningRetrieval:
    def test_chunks_are_loaded_from_database(self, db, kb, ctx):
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="explain about dunning", ctx=ctx, top_k=5, min_score=0.2)
        assert len(results) > 0, "No chunks retrieved — chunk loading is broken"
        assert any("dunning" in c.chunk_text.lower() for c in results), (
            f"Dunning chunks not found: {[c.source_title for c in results]}"
        )

    def test_dunning_cites_correct_document(self, db, kb, ctx):
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="explain about dunning", ctx=ctx, top_k=5, min_score=0.2)
        assert results
        titles = [c.source_title for c in results]
        assert "Overdue Invoices and Dunning" in titles, (
            f"Expected 'Overdue Invoices and Dunning' in citations, got: {titles}"
        )

    def test_dunning_chunks_contain_level_info(self, db, kb, ctx):
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="dunning levels", ctx=ctx, top_k=5, min_score=0.2)
        assert results
        combined = " ".join(r.chunk_text for r in results)
        assert "Level 1" in combined or "level 1" in combined, "Missing dunning level info"

    def test_dunning_intent_classifies_as_help(self, db, kb, ctx, engine, conv):
        intent = engine._classify_intent(conv, "explain about dunning", ctx)
        assert intent["domain"] == "help", (
            f"Expected domain='help', got '{intent['domain']}'"
        )

    def test_dunning_handler_returns_grounded_answer(self, db, kb, ctx, engine, conv):
        intent = engine._classify_intent(conv, "explain about dunning", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "explain about dunning", intent, ctx)
        answer = result.get("answer", "")
        assert len(answer) > 50, f"Answer too short: {answer}"
        assert "I don't have specific information" not in answer, (
            f"Got abstention instead of answer: {answer}"
        )
        assert "dunning" in answer.lower(), (
            f"Answer doesn't mention dunning: {answer[:200]}"
        )

    def test_dunning_answer_includes_escalation_info(self, db, kb, ctx, engine, conv):
        intent = engine._classify_intent(conv, "what is dunning", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "what is dunning", intent, ctx)
        answer = result.get("answer", "").lower()
        has_escalation = any(kw in answer for kw in (
            "reminder", "escalat", "overdue", "level", "collect",
            "communicate", "payment",
        ))
        assert has_escalation, f"Answer missing dunning details: {result.get('answer', '')[:300]}"

    def test_dunning_evidence_has_source(self, db, kb, ctx, engine, conv):
        intent = engine._classify_intent(conv, "explain dunning process", ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, "explain dunning process", intent, ctx)
        evidence = result.get("evidence", [])
        assert len(evidence) > 0, "No evidence returned"
        sources = [e.get("source") for e in evidence]
        assert any("dunning" in s.lower() for s in sources), (
            f"Expected dunning source in evidence, got: {sources}"
        )


class TestChunkSorting:
    """ISSUE 2: _sort_chunks_by_type must place definition chunks before
    procedural/how-to chunks so the LLM receives consistently ordered input."""

    def test_definition_before_howto(self):
        chunks = (
            "• How to set up dunning: Go to Billing Settings, open the Dunning tab.\n"
            "• Dunning is the systematic process of communicating with customers to collect overdue payments.\n"
            "• Dunning levels in Zoiko Billing: Level 1 (gentle reminder at 7 days past due)."
        )
        result = _sort_chunks_by_type(chunks)
        lines = [l.strip() for l in result.strip().split("\n") if l.strip()]
        # Definition chunks must come before procedural
        def_idx = next(i for i, l in enumerate(lines) if "systematic process" in l.lower())
        howto_idx = next(i for i, l in enumerate(lines) if "how to set up" in l.lower())
        assert def_idx < howto_idx, (
            f"Definition at index {def_idx}, how-to at {howto_idx} — wrong order"
        )

    def test_all_definition_chunks_grouped_first(self):
        chunks = (
            "• How to set up dunning: Go to Billing Settings.\n"
            "• How to view overdue invoices: Go to the Dashboard.\n"
            "• Dunning is the systematic process of communicating with customers.\n"
            "• Dunning levels in Zoiko Billing: Level 1, Level 2, Level 3, Level 4."
        )
        result = _sort_chunks_by_type(chunks)
        lines = [l.strip() for l in result.strip().split("\n") if l.strip()]
        # Both definitions should be before both how-tos
        def_lines = [l for l in lines if "systematic process" in l.lower() or "levels" in l.lower()]
        howto_lines = [l for l in lines if "how to" in l.lower()]
        last_def = max(lines.index(d) for d in def_lines)
        first_howto = min(lines.index(h) for h in howto_lines)
        assert last_def < first_howto, (
            f"Last definition at {last_def}, first how-to at {first_howto}"
        )

    def test_refund_chunks_sorted(self):
        chunks = (
            "• How to process a refund: Go to Payments, select the payment, click Refund.\n"
            "• A refund is the actual return of money to a customer through a real financial transaction.\n"
            "• A credit note is a document issued to a customer that reduces the amount they owe."
        )
        result = _sort_chunks_by_type(chunks)
        lines = [l.strip() for l in result.strip().split("\n") if l.strip()]
        def_idx = next(i for i, l in enumerate(lines) if "actual return of money" in l.lower())
        howto_idx = next(i for i, l in enumerate(lines) if "how to process" in l.lower())
        assert def_idx < howto_idx, (
            f"Definition at {def_idx}, how-to at {howto_idx} — wrong order"
        )

    def test_empty_input_returns_empty(self):
        assert _sort_chunks_by_type("") == ""

    def test_single_chunk_unchanged(self):
        chunk = "• Dunning is the systematic process of communicating with customers."
        assert _sort_chunks_by_type(chunk) == chunk

    def test_preserves_bullet_prefix(self):
        chunks = (
            "• How to set up dunning: Go to Billing Settings.\n"
            "• Dunning is the systematic process of communicating with customers."
        )
        result = _sort_chunks_by_type(chunks)
        for line in result.strip().split("\n"):
            if line.strip():
                assert line.strip().startswith("•"), f"Missing bullet prefix: {line}"
