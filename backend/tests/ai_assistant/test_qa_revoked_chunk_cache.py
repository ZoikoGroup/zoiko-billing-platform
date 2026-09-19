"""RT-022 / Q46 / Q77 — revoked/retired KB chunk excluded even if still in
the retriever's document cache.

The existing RT-022 regression only revokes a BRAND-NEW document that was
never cached. This test covers the harder case: a document is retrieved
(which populates KnowledgeRetriever's in-process _doc_obj_cache), then the
document is REVOKED, and a subsequent query on the same retriever instance
must NOT surface the now-revoked chunks — even on a cache hit.
"""
import pytest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.knowledge.retrieval import KnowledgeRetriever
from app.modules.chatbot.models import (
    KnowledgeNamespace, KnowledgeSource, KnowledgeDocument,
    KnowledgeChunk, KnowledgeSourceDocType, KnowledgeClassification,
    FreshnessStatus,
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


def _add_kb(db, *, source_title="Zoiko Billing Knowledge Base", text, revoked=False):
    ns = (
        db.query(KnowledgeNamespace)
        .filter_by(namespace_code="billing_public", tenant_id=0)
        .first()
    )
    if ns is None:
        ns = KnowledgeNamespace(
            namespace_code="billing_public", tenant_id=0,
            allowed_domains='["billing"]', description="kb",
        )
        db.add(ns)
        db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id, source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing", title=source_title, status="active",
    )
    db.add(src)
    db.flush()
    doc = KnowledgeDocument(
        source_id=src.id, document_version=1,
        freshness_status=FreshnessStatus.EXPIRED if revoked else FreshnessStatus.CURRENT,
        title=source_title,
        status="revoked" if revoked else "approved",
    )
    db.add(doc)
    db.flush()
    db.add(KnowledgeChunk(
        document_id=doc.id, chunk_sequence=1, chunk_text=text,
        classification=KnowledgeClassification.INTERNAL,
    ))
    db.flush()
    return ns, src, doc


@pytest.fixture()
def ctx(db):
    return AIContext(
        organization_id=0, user_id=1, tenant_context_id=1,
        role="admin", permissions=[], request_id="test", tenant_name="Zoiko Test",
    )


class TestRevokedChunkNotServedFromCache:
    def test_revoked_doc_after_cache_population_is_excluded(self, db, ctx):
        _add_kb(db, text="Refund eligibility requires a cleared payment rounded up to the nearest dollar")

        retriever = KnowledgeRetriever(db)
        # 1. First retrieval populates the retriever's document cache.
        r1, _ = retriever.retrieve(query="refund eligibility cleared", ctx=ctx, top_k=5)
        assert r1, "approved doc must be retrievable initially"

        # 2. The document is now REVOKED (status + freshness flipped in DB).
        doc = db.query(KnowledgeDocument).first()
        doc.status = "revoked"
        doc.freshness_status = FreshnessStatus.EXPIRED
        db.flush()

        # 3. Same retriever instance, same namespace+policy -> potential cache hit.
        r2, _ = retriever.retrieve(query="refund eligibility cleared", ctx=ctx, top_k=5)
        for res in r2:
            assert "REVOKED" not in res.chunk_text
        # The revoked doc's content must NOT be returned.
        assert not any("rounded up" in res.chunk_text for res in r2), \
            "revoked document was still served from the cache"

    def test_brand_new_revoked_doc_never_served(self, db, ctx):
        """Control: the existing RT-022 scenario (brand-new revoked doc)."""
        _add_kb(db, text="Refund eligibility requires a cleared payment")
        _add_kb(db, text="REVOKED refund secret: do not cite", revoked=True)
        retriever = KnowledgeRetriever(db)
        r, _ = retriever.retrieve(query="REVOKED refund secret", ctx=ctx, top_k=5)
        assert all("REVOKED" not in x.chunk_text for x in r)
