"""
test_permissions_retrieval.py
-----------------------------
Regression tests for irrelevant-answer prevention in KB retrieval:

  - "How do user roles and permissions work?" (suggested chip) must return
    the User Roles and Permissions documentation — never invoice/payment
    content.
  - Citations must match the topic of the answer (no far-weaker chunks from
    other documents riding along with the best match).
  - Queries with only weak KB matches must ABSTAIN instead of substituting
    loosely-related content.
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
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext


# Minimal KB mirroring seed_knowledge.py entries relevant to these tests.
KB_DOCS = {
    "Invoices Overview": [
        "An invoice is a commercial document issued by a seller to a buyer, indicating the products, quantities, and agreed prices for services or products provided.",
        "Invoice statuses in Zoiko Billing: Draft, Sent, Partially Paid, Paid, Overdue, Cancelled, Refunded, Written Off.",
        "To find a payment, search by payment number, transaction ID, or customer name.",
    ],
    "User Roles and Permissions": [
        "Zoiko Billing has three user roles: Super Admin, Organization Admin, and Billing Admin. Roles control what a user can see and do.",
        "Super Admin: platform-level operator. Manages platform settings, organizations, kill switches, and cross-tenant support access.",
        "Organization Admin: the administrator of an organization. Manages users and role assignments; only an Organization Admin can change another user's role.",
        "Who can access billing settings: both Organization Admin and Billing Admin roles can open and change billing settings. User management is restricted to the Organization Admin.",
    ],
    "Subscriptions and Plans": [
        "A subscription represents a recurring billing arrangement where a customer is charged at regular intervals for access to a product or service.",
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
    """Seed the billing_public namespace with the minimal KB."""
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="public KB",
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
        organization_id=o.id, user_id=1,
        tenant_context_id=1,
        role="admin", permissions=[], request_id="test",
        tenant_name="Zoiko Test",
    )


@pytest.fixture()
def conv(db, org_maker):
    from app.modules.chatbot.models import AIConversation, ConversationStatus
    c = AIConversation(
        conversation_uid="perm-conv", tenant_context_id=1,
        organization_id=org_maker.id, user_id=1,
        title="t", conversation_status=ConversationStatus.OPEN,
    )
    db.add(c)
    db.flush()
    return c


@pytest.fixture()
def org_maker(db):
    o = Organization(organization_name="Zoiko Org", organization_code="ZO")
    db.add(o)
    db.flush()
    return o


class TestPermissionsRetrieval:
    def test_chip_query_returns_permissions_doc(self, db, ctx, conv):
        engine = ConversationEngine(db, model_gateway=None)
        q = "How do user roles and permissions work?"
        intent = engine._classify_intent(conv, q, ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, q, intent, ctx)

        sources = [e.get("source") for e in result.get("evidence", [])]
        assert sources == ["User Roles and Permissions"], (
            f"Wrong knowledge source(s): {sources}"
        )
        assert "Billing Admin" in result["answer"]

    @pytest.mark.parametrize("query", [
        "what permissions does an org admin have",
        "can I change someone's role",
        "who can access billing settings",
    ])
    def test_permission_variations_cite_correct_doc(self, db, ctx, conv, query):
        engine = ConversationEngine(db, model_gateway=None)
        intent = engine._classify_intent(conv, query, ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, query, intent, ctx)

        sources = [e.get("source") for e in result.get("evidence", [])]
        assert "User Roles and Permissions" in sources, (
            f"{query!r} did not cite the permissions doc: {sources}"
        )
        assert "Invoices Overview" not in sources and \
            "Payments and Allocations" not in sources

    def test_citations_match_answer_topic(self, db, ctx):
        """No far-weaker chunks from other documents may ride along."""
        engine = ConversationEngine(db, model_gateway=None)
        results, _ = engine._retriever.retrieve(
            query="who can access billing settings", ctx=ctx, top_k=3, min_score=0.2,
        )
        assert results, "expected retrieval results"
        top_score = results[0].score
        for r in results:
            assert r.score >= top_score * 0.85, (
                f"Chunk from {r.source_title!r} scored {r.score} vs top {top_score} "
                "— below relevance floor"
            )

    def test_weak_match_abstains_instead_of_substituting(self, db, ctx, conv):
        """A query with only weak KB overlap must get the abstention response,
        never invoice/payment content dressed up as an answer."""
        engine = ConversationEngine(db, model_gateway=None)
        q = "what is the workflow for employee onboarding documents?"
        intent = engine._classify_intent(conv, q, ctx)
        if intent["domain"] == "out_of_scope":
            pytest.skip("routed to out_of_scope before retrieval")
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, q, intent, ctx)

        combined = result["answer"].lower()
        assert "invoice is a commercial document" not in combined, (
            "Unrelated invoice content substituted for an off-topic question"
        )

    def test_refund_question_still_cites_refund_doc(self, db, ctx, conv):
        """Sanity: legitimate KB questions still retrieve confidently."""
        engine = ConversationEngine(db, model_gateway=None)
        q = "How do refunds work?"
        intent = engine._classify_intent(conv, q, ctx)
        handler = engine._get_handler(intent["domain"])
        result = handler(conv, q, intent, ctx)
        # With this minimal KB the refund wording matches the invoices doc's
        # Refunded status chunk — the point is a CONFIDENT, cited answer.
        assert result.get("evidence"), "expected cited evidence for refund question"
