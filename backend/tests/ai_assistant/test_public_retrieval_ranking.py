"""
test_public_retrieval_ranking.py
--------------------------------
Regression tests for the live public-assistant ranking failures reported on
zoikobilling.com: the widget showed a CORRECT-looking answer from the WRONG
knowledge chunk.

  - "How much does Zoiko Billing cost?" answered with the dunning LEVELS
    (brand words matched on "Zoiko Billing" + the "how" frame earned the
    +0.20 structural boost), while the chunk quoting "$29/month" shares no
    word with "cost" and was discarded.
  - "Is there a free trial?" answered with the subscription STATUS list
    because every candidate saturated at 1.0 and the tie fell to document
    insertion order.
  - "What is my account balance?" answered with a credit-note definition for
    the same saturation reason.

The tests run against the REAL seeded knowledge base (seed_knowledge.KB_ENTRIES)
through retrieve_public(), i.e. exactly the path the marketing-site widget uses.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
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
from seed_knowledge import KB_ENTRIES

PRICING_DOC = "Pricing and Plans (Marketing)"
DUNNING_DOC = "Overdue Invoices and Dunning"


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
def public_kb(db):
    """The marketing-site knowledge base, seeded exactly as in production."""
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
    for entry in KB_ENTRIES:
        if not entry.get("is_public"):
            continue
        doc = KnowledgeDocument(
            source_id=src.id, document_version="1.0",
            freshness_status=FreshnessStatus.CURRENT,
            title=entry["title"], status="approved", is_public=True,
        )
        db.add(doc)
        db.flush()
        for seq, text in enumerate(entry["chunks"], 1):
            db.add(KnowledgeChunk(
                document_id=doc.id, chunk_sequence=seq, chunk_text=text,
                classification=KnowledgeClassification.INTERNAL,
            ))
    db.flush()
    return ns


@pytest.fixture()
def retriever(db, public_kb):
    return KnowledgeRetriever(db)


def top_titles(results, n=3):
    return [r.source_title for r in results[:n]]


class TestPriceQuestion:
    """The pricing question must be answered from the pricing document."""

    def test_cost_question_cites_pricing_document(self, retriever):
        results, _ = retriever.retrieve_public(
            query="How much does Zoiko Billing cost?", top_k=5)
        assert results, "price question produced no results"
        assert results[0].source_title == PRICING_DOC, (
            f"Expected {PRICING_DOC!r}, got {top_titles(results)}"
        )
        assert results[0].score >= 0.5, (
            f"price answer below the public confidence bar: {results[0].score}"
        )

    def test_cost_question_answer_quotes_prices(self, retriever):
        results, _ = retriever.retrieve_public(
            query="How much does Zoiko Billing cost?", top_k=5)
        combined = " ".join(r.chunk_text for r in results[:3])
        assert "$" in combined, f"no quoted prices in the retrieved chunks: {combined[:300]}"

    def test_brand_words_alone_never_carry_dunning(self, retriever):
        """'Zoiko Billing' appears in the dunning chunk; brand recognition is
        not topical relevance and must not outrank the pricing document."""
        results, _ = retriever.retrieve_public(
            query="How much does Zoiko Billing cost?", top_k=5)
        assert DUNNING_DOC not in top_titles(results), (
            f"dunning ranked for a pricing question: {top_titles(results)}"
        )

    def test_price_question_not_answered_by_structural_boost(self, retriever):
        """'how' used to trigger the +0.20 enumeration boost, which is what
        handed the win to a chunk containing 'Level 1'."""
        results, _ = retriever.retrieve_public(
            query="How much does Zoiko Billing cost?", top_k=5)
        assert results
        assert "Level 1" not in results[0].chunk_text, (
            f"enumeration boost still firing: {results[0].chunk_text[:200]}"
        )


class TestFreeTrialQuestion:
    """A 3-way tie at 1.0 used to fall to document insertion order, so the
    subscription STATUS list beat the answer."""

    def test_free_trial_answer_is_not_a_status_list(self, retriever):
        results, _ = retriever.retrieve_public(
            query="Is there a free trial?", top_k=5)
        assert results
        assert results[0].source_title == PRICING_DOC, (
            f"Expected {PRICING_DOC!r}, got {top_titles(results)}"
        )
        assert "Subscription statuses" not in results[0].chunk_text, (
            "answered with the subscription status list"
        )

    def test_free_trial_answer_mentions_trial(self, retriever):
        results, _ = retriever.retrieve_public(
            query="Is there a free trial?", top_k=5)
        assert "trial" in results[0].chunk_text.lower(), (
            results[0].chunk_text[:200]
        )


class TestAccountBalanceQuestion:
    """The credit-note definition tied with the account field at 1.0."""

    def test_account_balance_cites_accounts_document(self, retriever):
        results, _ = retriever.retrieve_public(
            query="What is my account balance?", top_k=5)
        assert results
        assert results[0].source_title == "Customers and Accounts", (
            f"Expected 'Customers and Accounts', got {top_titles(results)}"
        )


class TestMarketingIntroQuestions:
    """Second batch of live failures: the brand words "Zoiko Billing" matched
    every marketing document, so which document answered was a coin toss —
    dunning levels for "how do I get started", the report list for "what is
    Zoiko Billing", and the report list again for "how do I set up recurring
    billing" (visitors say "recurring billing", the KB says "subscription")."""

    @pytest.mark.parametrize("query", [
        "How do I get started with Zoiko Billing?",
        "What is Zoiko Billing?",
    ])
    def test_intro_question_answers_from_an_intro_document(self, retriever, query):
        results, _ = retriever.retrieve_public(query=query, top_k=5)
        assert results, f"{query!r} produced no results"
        intro_docs = {
            "Zoiko Billing Platform Overview (Marketing)",
            "Getting Started and Requesting a Demo (Marketing)",
            "Who Zoiko Billing Is For (Marketing)",
        }
        assert results[0].source_title in intro_docs, (
            f"{query!r} -> {top_titles(results)}"
        )

    def test_recurring_billing_question_answers_the_how_to(self, retriever):
        results, _ = retriever.retrieve_public(
            query="How do I set up recurring billing?", top_k=5)
        assert results, "recurring billing question produced no results"
        assert results[0].source_title == "Subscriptions and Plans", (
            f"Expected 'Subscriptions and Plans', got {top_titles(results)}"
        )
        assert "subscription" in results[0].chunk_text.lower(), (
            results[0].chunk_text[:200]
        )


class TestExistingRankingPreserved:
    """The fix must not disturb questions that already answered correctly."""

    @pytest.mark.parametrize("query,expected", [
        ("How do I record a payment?", "Payments and Allocations"),
        ("How do I check an invoice's status?", "Invoices Overview"),
        ("What are the dunning levels?", DUNNING_DOC),
        ("How do I reconcile payments?", "Payments and Reconciliation (How It Works)"),
        ("What's the difference between a credit and a refund?", "Credit Notes vs Refunds"),
    ])
    def test_known_good_queries_keep_their_documents(self, retriever, query, expected):
        results, _ = retriever.retrieve_public(query=query, top_k=5)
        assert results, f"{query!r} produced no results"
        assert results[0].source_title == expected, (
            f"{query!r} -> {top_titles(results)}, expected {expected!r}"
        )

    def test_out_of_scope_query_still_abstains(self, retriever):
        results, _ = retriever.retrieve_public(
            query="what are the zorb options?", top_k=3, min_score=0.2)
        assert results == [] or not retriever.is_confident(results, threshold=0.3)


class TestBoostsStillSeparateCandidates:
    """Boosts used to saturate at 1.0, which turned ranking into a coin toss
    decided by document insertion order."""

    def test_reported_scores_stay_on_the_zero_to_one_scale(self, retriever):
        for query in (
            "How much does Zoiko Billing cost?",
            "Is there a free trial?",
            "What is my account balance?",
            "How do I record a payment?",
        ):
            results, citations = retriever.retrieve_public(query=query, top_k=5)
            for r in results:
                assert 0.0 <= r.score <= 1.0, f"{query!r} -> {r.score}"
            for c in citations:
                assert 0.0 <= c["score"] <= 1.0, f"{query!r} -> {c['score']}"
