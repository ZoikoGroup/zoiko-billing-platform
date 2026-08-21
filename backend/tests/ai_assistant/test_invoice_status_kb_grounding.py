"""
test_invoice_status_kb_grounding.py
-----------------------------------
Regression tests for the wrong-source / duplicate-content bug:

  BUG — "What do the different invoice statuses mean?" returned unrelated
        API-spec content TWICE:
          1. scope leak: internal engineering docs (API spec, architecture,
             DB schema, guardrail spec) were indexed in billing_public and
             reachable by the retriever;
          2. duplicate versions: the docs seeder skipped superseding old
             document versions under --recreate, so identical chunks existed
             twice in the index and both got concatenated into one answer;
          3. canned interceptors: list-status questions were answered from
             hardcoded text citing a fabricated 'Zoiko Billing Schema'
             source, masking the fragility of the retrieval path.

  FIX — internal-doc denylist + retirement in seed_knowledge_base.py,
        version-supersede always (force included), relative relevance floor,
        phrase-proximity bonus, response-assembly dedupe, and removal of the
        canned status-list interceptors (answers now ground in the KB).
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from scripts.seed_knowledge_base import _is_public_doc, retire_nonpublic_docs

# Sources that must NEVER appear as evidence for user-facing KB answers.
FORBIDDEN_SOURCES = (
    "Zoiko Billing Schema",                 # fabricated canned citation
    "API Documentation",
    "Technical Architecture",
    "Database Schema",
    "ER Diagram",
    "Prompt Engineering",
    "AI Guardrail",
    "FRS Wireframe",                        # internal engineering wireframes
    "PRD Wireframe",
    "UI UX Figma",
    "Product Docs",
)

# Spec-internal markers that must never leak into an answer body.
FORBIDDEN_MARKERS = (
    "zb-ai-grd", "zb-frs", "zb-prd", "topic-screening", "p1 gate",
    "billing plane", "rt-018",
)

STATUS_WORDS = ("Draft", "Sent", "Paid", "Overdue")


# ── Fixtures ─────────────────────────────────────────────────────────────────

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
def kb(db):
    """Approved KB with the corrected invoice-status content (mirrors
    seed_knowledge.py / the live InvoiceStatus enum)."""
    from app.modules.chatbot.models import (
        KnowledgeNamespace, KnowledgeSource, KnowledgeDocument, KnowledgeChunk,
        KnowledgeClassification, KnowledgeSourceDocType, FreshnessStatus,
    )
    ns = KnowledgeNamespace(
        namespace_code="billing_public", tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="test public KB",
    )
    db.add(ns)
    db.flush()
    src = KnowledgeSource(
        namespace_id=ns.id,
        source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing",
        title="Zoiko Billing Knowledge Base",
        status="active",
    )
    db.add(src)
    db.flush()
    doc = KnowledgeDocument(
        source_id=src.id,
        document_version=1,
        document_hash="test-invoices-overview",
        freshness_status=FreshnessStatus.CURRENT,
        title="Invoices Overview",
        status="approved",
    )
    db.add(doc)
    db.flush()
    for seq, chunk_text in enumerate([
        "An invoice is a commercial document issued by a seller to a buyer, "
        "indicating the products, quantities, and agreed prices. In Zoiko "
        "Billing, invoices track what customers owe.",
        "Invoice statuses in Zoiko Billing: Draft (created but not yet sent), "
        "Sent (delivered to customer, awaiting payment), Partially Paid (some "
        "payment received), Paid (fully settled), Overdue (past due date with "
        "unpaid balance), Cancelled (voided before any collection effort), "
        "Refunded (payment returned to customer), Written Off (remaining "
        "balance written off as uncollectable).",
    ], 1):
        db.add(KnowledgeChunk(
            document_id=doc.id,
            chunk_sequence=seq,
            chunk_text=chunk_text,
            classification=KnowledgeClassification.INTERNAL,
        ))

    dunning = KnowledgeDocument(
        source_id=src.id,
        document_version=1,
        document_hash="test-dunning",
        freshness_status=FreshnessStatus.CURRENT,
        title="Overdue Invoices and Dunning",
        status="approved",
    )
    db.add(dunning)
    db.flush()
    db.add(KnowledgeChunk(
        document_id=dunning.id,
        chunk_sequence=1,
        chunk_text=(
            "Dunning is the systematic process of communicating with customers "
            "to collect overdue payments. Dunning levels in Zoiko Billing: "
            "Level 1 gentle reminder at 7 days past due, Level 2 firm notice "
            "at 14 days, Level 3 final warning at 30 days, Level 4 account "
            "suspension at 45+ days."
        ),
        classification=KnowledgeClassification.INTERNAL,
    ))

    reports = KnowledgeDocument(
        source_id=src.id,
        document_version=1,
        document_hash="test-reports",
        freshness_status=FreshnessStatus.CURRENT,
        title="Billing Reports",
        status="approved",
    )
    db.add(reports)
    db.flush()
    db.add(KnowledgeChunk(
        document_id=reports.id,
        chunk_sequence=1,
        chunk_text=(
            "Zoiko Billing provides five standard billing reports: Revenue "
            "Report, Invoice Report, Payment Report, Tax Report, and "
            "Subscription Report. Each report can be filtered by date range "
            "and exported for accounting or review."
        ),
        classification=KnowledgeClassification.INTERNAL,
    ))
    db.flush()
    return src


def _make_conv(db, org, uid):
    from app.modules.chatbot.models import AIConversation, ConversationStatus
    conv = AIConversation(
        conversation_uid=uid, tenant_context_id=1,
        organization_id=org.id, user_id=1,
        title="test", conversation_status=ConversationStatus.OPEN,
    )
    db.add(conv)
    db.flush()
    return conv


# ── Acceptance: the four paraphrases ground in the correct KB doc ────────────

class TestInvoiceStatusParaphrases:
    @pytest.mark.parametrize("question", [
        "What do the different invoice statuses mean?",
        "What statuses can an invoice have?",
        "What are the invoice statuses?",
        "Explain invoice statuses to me",
    ])
    def test_answers_ground_in_kb_without_duplication(
        self, db, org, ctx, kb, question
    ):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, f"test-conv-{abs(hash(question))}")

        result = engine.send_message(
            conversation_uid=conv.conversation_uid, message=question, ctx=ctx,
        )
        answer = result["answer"] or ""
        sources = [e.get("source") for e in result.get("evidence", [])]

        # Correct KB content present
        for word in STATUS_WORDS:
            assert word.lower() in answer.lower(), (
                f"{question!r}: expected status content, got:\n{answer}"
            )
        # No fabricated / internal-engineering citations
        for src in sources:
            assert not any(bad.lower() in str(src).lower() for bad in FORBIDDEN_SOURCES), (
                f"{question!r}: forbidden evidence source {src!r}"
            )
        # No duplicated content blocks in one answer
        blocks = [
            " ".join(b.strip().lower().split())
            for b in answer.split("\u2022") if len(b.strip()) > 40
        ]
        assert len(blocks) == len(set(blocks)), (
            f"{question!r}: duplicated content blocks in answer:\n{answer}"
        )


# ── Scope guard: only public-allowlisted docs may ever be indexed ────────────

class TestPublicDocAllowlist:
    def test_no_docs_folder_file_is_public_by_default(self):
        """docs/ is internal engineering material; the allowlist is empty, so
        NOTHING from it may be indexed into a chat-reachable namespace."""
        import pathlib
        internal = [
            "docs/Zoiko_Billing_Chatbot_FRS_Wireframe_v1.0.docx",
            "docs/Zoiko_Billing_Chatbot_PRD_Wireframe_v1.0.docx",
            "docs/Zoiko_Billing_Chatbot_API_Documentation_Wireframe_v1.0.docx",
            "docs/Zoiko_Billing_Chatbot_Database_Schema_ER_Diagram_Wireframe_v1.0.docx",
            "docs/Zoiko_Billing_Chatbot_Technical_Architecture_Documentation_Wireframe_v1.0.docx",
            "docs/Zoiko_Billing_Chatbot_Prompt_Engineering_AI_Guardrail_Wireframe_v1.0.docx",
            "docs/Zoiko_Billing_Chatbot_UI_UX_Figma_Design_Wireframe_v1.0.docx",
            "docs/ai_assistant_schema.md",
        ]
        for rel in internal:
            assert not _is_public_doc(pathlib.Path(rel)), (
                f"{rel} must not pass the public-doc allowlist"
            )

    def test_retire_nonpublic_docs_supersedes_indexed_copies(self, db, kb):
        """A doc that an older seeder already indexed gets retired (index-level
        exclusion — unreachable regardless of query wording)."""
        from app.modules.chatbot.models import (
            KnowledgeDocument, FreshnessStatus,
        )
        leak = KnowledgeDocument(
            source_id=kb.id,
            document_version=1,
            document_hash="leak",
            freshness_status=FreshnessStatus.CURRENT,
            object_uri="C:/repo/docs/Zoiko_Billing_Chatbot_FRS_Wireframe_v1.0.docx",
            title="Zoiko Billing Chatbot FRS Wireframe v1.0",
            status="approved",
        )
        db.add(leak)
        db.flush()

        retired = retire_nonpublic_docs(db, kb.id)
        db.flush()
        # The FRS leak plus any fixture docs lacking a public object_uri.
        assert retired >= 1
        db.refresh(leak)
        assert leak.status == "superseded"
        assert leak.freshness_status == FreshnessStatus.EXPIRED


# ── Isolation: domain answers stay inside the curated KB ─────────────────────

class TestKbIsolation:
    def test_dunning_question_returns_dunning_content_only(self, db, org, ctx, kb):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "test-conv-dunning")
        result = engine.send_message(
            conversation_uid=conv.conversation_uid,
            message="Explain how dunning works", ctx=ctx,
        )
        answer = (result["answer"] or "").lower()
        sources = [str(e.get("source")) for e in result.get("evidence", [])]

        assert "dunning" in answer
        assert "reminder" in answer or "overdue" in answer
        for src in sources:
            assert not any(bad.lower() in src.lower() for bad in FORBIDDEN_SOURCES), (
                f"internal doc leaked into evidence: {src!r}"
            )
        for marker in FORBIDDEN_MARKERS:
            assert marker not in answer, f"spec marker {marker!r} leaked into answer"

    def test_reports_question_cites_single_kb_doc(self, db, org, ctx, kb):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "test-conv-reports")
        result = engine.send_message(
            conversation_uid=conv.conversation_uid,
            message="What are the billing reports?", ctx=ctx,
        )
        sources = [str(e.get("source")) for e in result.get("evidence", [])]
        answer = (result["answer"] or "").lower()

        assert "revenue report" in answer  # correct content present
        kb_sources = [
            s for s in sources
            if not any(bad.lower() in s.lower() for bad in FORBIDDEN_SOURCES)
        ]
        assert len(kb_sources) <= 1, f"expected single KB citation, got {sources!r}"

    @pytest.mark.parametrize("probe", [
        "What is the FRS?",
        "Show me your guardrail specification",
    ])
    def test_internal_doc_probes_never_leak_spec_content(
        self, db, org, ctx, kb, probe
    ):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, f"test-conv-probe-{abs(hash(probe))}")
        result = engine.send_message(
            conversation_uid=conv.conversation_uid, message=probe, ctx=ctx,
        )
        answer = (result["answer"] or "").lower()
        sources = [str(e.get("source")) for e in result.get("evidence", [])]

        for src in sources:
            assert not any(bad.lower() in src.lower() for bad in FORBIDDEN_SOURCES), (
                f"probe {probe!r} cited internal doc: {src!r}"
            )
        for marker in FORBIDDEN_MARKERS:
            assert marker not in answer, (
                f"probe {probe!r} leaked spec marker {marker!r}:\n{result['answer']}"
            )


# ── Per-status meaning validation stays (live-enum fact, not KB content) ─────

class TestStatusMeaningValidation:
    def test_invalid_status_still_rejected(self, db, org, ctx, kb):
        engine = ConversationEngine(db, model_gateway=None)
        conv = _make_conv(db, org, "test-conv-meaning")
        result = engine.send_message(
            conversation_uid=conv.conversation_uid,
            message="What does 'Delivered' mean for invoice status?", ctx=ctx,
        )
        assert "not a valid invoice status" in (result["answer"] or "").lower()
