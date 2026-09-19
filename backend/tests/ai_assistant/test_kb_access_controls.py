"""
test_kb_access_controls.py

Architecture-alignment tests for the knowledge layer's access controls
(ZB-AI-KB-001 / Section 11):

  - Sources that are not 'active' must never leak approved chunks into
    retrieval (inactive/deprecated content is excluded).
  - Namespaces that declare allowed_domains / blocked_domains are restricted
    to the current app surface; a namespace whose restriction does not match
    the current page domain is excluded from retrieval.
  - Restrictions stay dormant until a page domain is actually known, so
    previously un-scoped installs keep their exact behavior.
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


def _add_kb(db, *, source_status="active", source_title="Zoiko Billing Knowledge Base",
            text, allowed_domains=None, blocked_domains=None, namespace_code="billing_public"):
    ns = KnowledgeNamespace(
        namespace_code=namespace_code, tenant_id=0,
        allowed_domains=allowed_domains, blocked_domains=blocked_domains,
        description="kb",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id, source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing", title=source_title, status=source_status,
    )
    db.add(src)
    db.flush()
    doc = KnowledgeDocument(
        source_id=src.id, document_version=1,
        freshness_status=FreshnessStatus.CURRENT, title=source_title,
        status="approved",
    )
    db.add(doc)
    db.flush()
    db.add(KnowledgeChunk(
        document_id=doc.id, chunk_sequence=1, chunk_text=text,
        classification=KnowledgeClassification.INTERNAL,
    ))
    db.flush()
    return ns


@pytest.fixture()
def ctx(db):
    return AIContext(
        organization_id=0, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="test", tenant_name="Zoiko Test",
    )


@pytest.fixture()
def retriever(db):
    return KnowledgeRetriever(db)


class TestInactiveSourceExcluded:
    def test_inactive_source_chunks_never_returned(self, db, ctx, retriever):
        _add_kb(db, text="Dunning starts after the due date passes.", source_status="active")
        _add_kb(
            db, text="DOODAD every month for nothing", source_status="inactive",
            namespace_code="tenant_scope_2",
        )
        results, _ = retriever.retrieve(query="dunning overdue", ctx=ctx, top_k=5, min_score=0.0)
        assert any("dunning" in r.chunk_text.lower() for r in results)
        assert all("doodad" not in r.chunk_text.lower() for r in results)

    def test_active_source_returns_content(self, db, ctx, retriever):
        _add_kb(db, text="Refunds are processed within five business days.")
        results, _ = retriever.retrieve(query="refund processing", ctx=ctx, top_k=5, min_score=0.0)
        assert any("refund" in r.chunk_text.lower() for r in results)


class TestDomainRestrictions:
    def test_no_page_domain_applies_no_restriction(self, db, ctx, retriever):
        _add_kb(db, allowed_domains=["invoices"], text="Invoice numbering resets yearly.")
        _add_kb(db, namespace_code="tenant_b", text="Dashboard widget costs update nightly.")
        results, _ = retriever.retrieve(query="invoice dashboard", ctx=ctx, top_k=5, min_score=0.0)
        assert len(results) >= 1

    def test_allowed_domains_keep_in_scope_namespace(self, db, ctx, retriever):
        _add_kb(db, allowed_domains=["invoices"], text="Invoice numbering resets yearly.")
        _add_kb(db, namespace_code="tenant_b", text="Dashboard widget costs update nightly.")
        results, _ = retriever.retrieve(
            query="invoice numbering", ctx=ctx, top_k=5, min_score=0.0,
            domains=["invoices"],
        )
        assert any("resets yearly" in r.chunk_text for r in results)

    def test_allowed_domains_exclude_out_of_scope_namespace(self, db, ctx, retriever):
        _add_kb(db, allowed_domains=["invoices"], text="Invoice numbering resets yearly.")
        results, _ = retriever.retrieve(
            query="invoice numbering", ctx=ctx, top_k=5, min_score=0.0,
            domains=["payments"],
        )
        assert results == []

    def test_blocked_domains_exclude_current_surface(self, db, ctx, retriever):
        _add_kb(db, blocked_domains=["invoices"], text="Invoice numbering resets yearly.")
        results, _ = retriever.retrieve(
            query="invoice numbering", ctx=ctx, top_k=5, min_score=0.0,
            domains=["invoices"],
        )
        assert results == []

    def test_blocked_domains_does_not_filter_other_surfaces(self, db, ctx, retriever):
        _add_kb(db, blocked_domains=["invoices"], text="Invoice numbering resets yearly.")
        results, _ = retriever.retrieve(
            query="invoice numbering", ctx=ctx, top_k=5, min_score=0.0,
            domains=["payments"],
        )
        assert any("resets yearly" in r.chunk_text for r in results)

    def test_json_string_legacy_seed_is_enforced(self, db, ctx, retriever):
        ns = KnowledgeNamespace(
            namespace_code="legacy", tenant_id=0,
            allowed_domains='["invoices"]', description="legacy seed",
        )
        db.add(ns)
        db.flush()
        results, _ = retriever.retrieve(
            query="invoice", ctx=ctx, top_k=5, min_score=0.0,
            domains=["payments"], namespace_codes=["legacy"],
        )
        assert results == []


class TestEngineWiring:
    def test_page_domains_derived_from_page_path(self, db):
        engine = ConversationEngine(db, model_gateway=None)
        engine._current_page_path = "/billing/invoices"
        assert set(engine._page_domains()) == {"invoices", "invoice"}

    def test_without_page_path_domains_empty(self, db):
        engine = ConversationEngine(db, model_gateway=None)
        assert engine._page_domains() == []

    def test_page_domains_scope_engine_retrieval(self, db, ctx):
        from app.modules.chatbot.conversation.engine import ConversationEngine as CE
        engine = CE(db, model_gateway=None)
        _add_kb(db, allowed_domains=["invoices"], text="Invoice numbering resets yearly.")
        engine._retriever = KnowledgeRetriever(db)
        engine._current_page_path = "/billing/payments"
        out = engine._retrieve("invoice numbering", ctx, top_k=5)
        assert out["answer"] is None, (
            "restricted namespace must not surface outside its allowed surface"
        )
        engine._current_page_path = "/billing/invoices"
        out = engine._retrieve("invoice numbering", ctx, top_k=5)
        assert out["answer"] is not None and "resets yearly" in out["answer"]