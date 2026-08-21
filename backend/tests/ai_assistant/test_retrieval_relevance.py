"""
test_retrieval_relevance.py
---------------------------
Regression tests for systemic retrieval bias (off-topic RAG answers):

  - "What are the billing reports?" must cite the Billing Reports article,
    not invoice/credit-note definitions.
  - IDF dampening: words appearing in most chunks ("billing") carry almost
    no weight, so generic-word-only matches cannot reach the confidence bar.
  - Stem-aware TF ranking: documents ABOUT a topic outrank documents that
    merely mention it in passing.
  - Page-context boost re-ranks relevant chunks toward the current page but
    never rescues weak matches.
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
)
from app.modules.chatbot.knowledge.retrieval import KnowledgeRetriever
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext

# Deliberately invoice-heavy KB plus one reports doc — mirrors the live KB
# shape that caused invoice content to dominate unrelated queries.
KB_DOCS = {
    "Billing Reports": [
        "Zoiko Billing provides five standard billing reports, available on the Reports page: Revenue Report, Invoice Report, Payment Report, Tax Report, and Subscription Report. Each report can be filtered by date range and exported.",
        "Revenue Report: shows total billed revenue, collected payments, refunds, and net revenue over a chosen period.",
        "Tax Report: shows tax amounts charged and collected, grouped by tax rate. Use it to prepare tax filings.",
        "Subscription Report: shows active, cancelled, and expiring subscriptions, plan distribution, and recurring revenue trends.",
    ],
    "Invoices Overview": [
        "An invoice is a commercial document issued by a seller to a buyer, indicating the products, quantities, and agreed prices for services or products provided. In Zoiko Billing, invoices track what customers owe.",
        "Invoice statuses in Zoiko Billing: Draft, Sent, Partially Paid, Paid, Overdue, Cancelled, Refunded, Written Off.",
        "Invoice line items detail each product or service billed, with description, quantity, unit price, and total.",
    ],
    "Credit Notes vs Refunds": [
        "A credit note is a document issued to a customer that reduces the amount they owe without money movement.",
        "A refund is the actual return of money to a customer through a real financial transaction to their original payment method.",
        "Refunds in Zoiko Billing are tracked with a refund number, linked to the original payment, and show the refunded amount.",
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


class TestReportsQuestion:
    def test_reports_question_cites_reports_doc(self, db, ctx, engine):
        class _Conv:
            id = None

        conv = _Conv()
        q = "What are the billing reports?"
        intent = engine._classify_intent(conv, q, ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, q, intent, ctx)

        sources = [e.get("source") for e in result.get("evidence", [])]
        assert sources == ["Billing Reports"], f"Wrong citations: {sources}"
        for report in ("Revenue Report", "Tax Report", "Subscription Report"):
            assert report in result["answer"], f"Missing {report} in answer"

    def test_no_invoice_definition_leakage(self, db, ctx, engine):
        """The reported failure mode: invoice/credit-note definitions served
        for an unrelated question."""
        class _Conv:
            id = None

        conv = _Conv()
        q = "What are the billing reports?"
        intent = engine._classify_intent(conv, q, ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, q, intent, ctx)
        assert "commercial document issued by a seller" not in result["answer"].lower()
        assert "credit note" not in result["answer"].lower()


class TestDampeningAndStems:
    def test_word_naming_no_document_stays_dampened(self, db, ctx):
        """A query whose only content word matches NO document title and no
        content must not produce confident results — generic noise abstains."""
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="what are the zorb options?", ctx=ctx, top_k=3, min_score=0.2)
        assert results == [] or not r.is_confident(results, threshold=0.3)

    def test_title_topical_word_is_not_dampened(self, db, ctx):
        """'billing' is corpus-frequent BUT names a document (Billing Reports)
        — topic-title exemption keeps it at full weight so its dedicated doc
        wins instead of the query being dampened into weakness."""
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="what are the billing options?", ctx=ctx, top_k=3, min_score=0.2)
        assert results
        assert results[0].source_title == "Billing Reports"

    def test_corpus_frequent_topic_survives_admission(self, db, ctx):
        """Regression (refund/payment routing): 'refunds' appears in most
        docs as passing mention, which dampened it to 0.25 and pushed its
        OWN document's chunks below the admission gate while any chunk
        containing 'explain' scored 0.8. Title-topical words must keep full
        weight so the dedicated document is retrieved and wins."""
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="explain how refunds work", ctx=ctx, top_k=3, min_score=0.2)
        assert results
        assert results[0].source_title == "Credit Notes vs Refunds"

    def test_stem_matching_unifies_plural_and_singular(self, db, ctx):
        """'refunds' must retrieve chunks discussing 'refund'."""
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="How do refunds work?", ctx=ctx, top_k=3, min_score=0.2)
        assert results
        assert all(r_.source_title == "Credit Notes vs Refunds" for r_ in results), (
            [r_.source_title for r_ in results]
        )

    def test_topic_doc_outranks_passing_mentions(self, db, ctx):
        """Documents ABOUT the topic rank above documents that mention it."""
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="How do refunds work?", ctx=ctx, top_k=3, min_score=0.2)
        assert results[0].source_title == "Credit Notes vs Refunds"

    def test_punctuation_stripped_from_query_terms(self, db, ctx):
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="What are the billing reports?", ctx=ctx, top_k=3, min_score=0.2)
        assert results and results[0].score >= 0.85


class TestPageContextBoost:
    def _seed_second_kb(self, db):
        """Add another doc mentioning 'reports' in passing so two docs tie."""
        doc = KnowledgeDocument(
            source_id=db.query(KnowledgeSource).first().id,
            document_version="1.0", freshness_status=FreshnessStatus.CURRENT,
            title="Billing Workflows", status="approved",
        )
        db.add(doc)
        db.flush()
        db.add(KnowledgeChunk(
            document_id=doc.id, chunk_sequence=1,
            chunk_text="The billing summary workflow includes generating periodic reports for finance review and approval.",
            classification=KnowledgeClassification.INTERNAL,
        ))
        db.flush()

    def test_boost_reranks_toward_current_page(self, db, ctx):
        self._seed_second_kb(db)
        r = KnowledgeRetriever(db)
        base, _ = r.retrieve(query="billing reports", ctx=ctx, top_k=2, min_score=0.2)
        boosted, _ = r.retrieve(
            query="billing reports", ctx=ctx, top_k=2, min_score=0.2,
            boost_terms=["report", "reports"],
        )
        assert boosted[0].source_title == "Billing Reports"
        assert boosted[0].score >= base[0].score

    def test_boost_never_rescues_weak_matches(self, db, ctx):
        r = KnowledgeRetriever(db)
        results, _ = r.retrieve(
            query="quarterly unicorn forecasts", ctx=ctx, top_k=3, min_score=0.2,
            boost_terms=["report", "reports"],
        )
        assert results == []
