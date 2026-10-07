"""
tests/ai_assistant/test_public_knowledge_question_coverage.py
---------------------------------------------------------------
Public assistant (marketing widget) KNOWLEDGE-question coverage.

POST /api/assistant/public/sessions/{session_uid}/messages delegates straight to
``PublicAssistantService.send_message`` (see
``public_router.send_public_message``), and that is a pipeline entirely separate
from ``ConversationEngine``:

    retrieve_public() -> is_confident(results, threshold=0.5) -> _synthesize()

The public path performs no intent classification and has no live-data handlers,
so the authenticated engine's routing can neither mask nor create a public-path
bug. These tests therefore drive that exact method against the REAL
``seed_knowledge`` corpus (24 documents / 22 public / 2 internal, the same rows
production seeds) so they reproduce the production failure instead of a
fixture-shaped approximation of it.

Per this repo's established convention there is no FastAPI TestClient anywhere in
tests/ -- services and routers are invoked directly.

The defect guarded here: question-form scaffolding ("how many", "types") was
scored as topical content. Because the score is query-normalized
(matched_weight / total_weight), each scaffolding word deflated the denominator,
pushing an on-topic chunk below the 0.5 confidence gate, so the assistant
abstained on a question its own approved evidence could answer. Normalization now
excludes scaffolding while enumeration intent is still read from the raw query,
so the "+0.20 enumeration boost" for "how many types of ..." queries is intact.
"""

import pytest

from app.database import Base
from app.modules.chatbot.models import (
    FreshnessStatus,
    KnowledgeChunk,
    KnowledgeClassification,
    KnowledgeDocument,
    KnowledgeNamespace,
    KnowledgeSource,
    KnowledgeSourceDocType,
)
from app.modules.chatbot.public_assistant import _ABSTAIN_ANSWER, PublicAssistantService
from seed_knowledge import KB_ENTRIES

# Seeded with is_public=False; the public path must never surface them.
PRIVATE_TITLES = {e["title"] for e in KB_ENTRIES if not e.get("is_public")}
PUBLIC_TITLES = {e["title"] for e in KB_ENTRIES if e.get("is_public")}

ABSTAIN_MARKER = "don't have a confirmed answer"

# The phrasings the task requires to retrieve grounded knowledge.
REQUIRED_KNOWLEDGE = [
    "Explain about the payments",
    "what is the payment",
    "what are payments",
    "explain payment",
    "how does payment work",
    "how many types of payment are there",
    "what payment methods are supported",
    "how do I record a payment",
    "what is the tax",
    "what is the invoice",
    "what is billing",
    "what is payment reconciliation",
]

# Further natural variations that must not be treated as a different question.
EXTRA_KNOWLEDGE = [
    "what is a payment",
    "how do payments work",
    "explain invoices",
    "what is an overdue invoice",
    "how does payment allocation work",
    "how does payment recording work",
    "what is a credit note",
    "what is the tax report",
    "what does the billing report show",
    "how can I create an invoice",
    "how does billing work",
    "what is the dashboard",
    "how do I add a customer",
    "what reports are available",
    "how many types of invoice status are there",
]


@pytest.fixture()
def db_session():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

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
def public_kb(db_session):
    """Seed the real public KB exactly as ``seed_knowledge.seed()`` does."""
    ns = KnowledgeNamespace(
        namespace_code="billing_public",
        tenant_id=0,
        allowed_domains='["billing","help","dashboard"]',
        description="Zoiko Billing public knowledge base - product documentation and policies",
    )
    db_session.add(ns)
    db_session.flush()
    src = KnowledgeSource(
        namespace_id=ns.id,
        source_type=KnowledgeSourceDocType.DOC,
        classification=KnowledgeClassification.INTERNAL,
        owner_team="billing",
        title="Zoiko Billing Knowledge Base",
        status="active",
    )
    db_session.add(src)
    db_session.flush()
    for entry in KB_ENTRIES:
        doc = KnowledgeDocument(
            source_id=src.id,
            document_version=1,
            document_hash=f"test-{entry['title']}",
            freshness_status=FreshnessStatus.CURRENT,
            title=entry["title"],
            status="approved",
            is_public=entry.get("is_public", False),
        )
        db_session.add(doc)
        db_session.flush()
        for seq, text in enumerate(entry["chunks"], 1):
            db_session.add(
                KnowledgeChunk(
                    document_id=doc.id,
                    chunk_sequence=seq,
                    chunk_text=text,
                    classification=KnowledgeClassification.INTERNAL,
                )
            )
    db_session.commit()
    assert len(PUBLIC_TITLES) == 22 and len(PRIVATE_TITLES) == 2


@pytest.fixture()
def service(db_session, public_kb):
    # gateway=None -> deterministic rules-only synthesis, so assertions test
    # retrieval/grounding rather than model phrasing.
    return PublicAssistantService(db_session, gateway=None)


def ask(service, question: str) -> dict:
    """Send one visitor message through the public pipeline."""
    session = service.create_session()
    return service.send_message(
        session_uid=session["session_uid"], message=question, ip_hash=None, page="/"
    )


def assert_grounded_knowledge(result: dict, question: str) -> None:
    """A knowledge answer must be evidenced, non-abstaining and traceable to a
    cited PUBLIC document."""
    assert result["mode"] == "M0_EXPLAIN", f"{question!r} -> {result['mode']}"
    assert result["evidence"], f"{question!r} retrieved no evidence"
    assert result["answer"] != _ABSTAIN_ANSWER, f"{question!r} fell back to the canned abstention"
    assert ABSTAIN_MARKER not in result["answer"].lower(), f"{question!r} returned the abstention"

    sources = {e["source"] for e in result["evidence"]}
    assert sources <= PUBLIC_TITLES, f"{question!r} cited non-public/unknown docs: {sources - PUBLIC_TITLES}"
    assert not (sources & PRIVATE_TITLES), f"{question!r} leaked a private doc: {sources & PRIVATE_TITLES}"

    # Grounded: the rules-only answer is drawn from the top cited chunk, so the
    # opening of the answer must appear in that citation's summary. Whitespace
    # is collapsed on both sides because _synthesize() normalizes it.
    import re as _re

    summary = _re.sub(r"\s+", " ", result["evidence"][0]["summary"]).strip()
    assert result["answer"][:60] in summary, (
        f"{question!r} answer is not traceable to its own citation\n"
        f"  answer : {result['answer'][:120]!r}\n  summary: {summary[:120]!r}"
    )


class TestRequiredKnowledgePhrasings:
    @pytest.mark.parametrize("question", REQUIRED_KNOWLEDGE)
    def test_answers_from_public_kb(self, service, question):
        assert_grounded_knowledge(ask(service, question), question)

    @pytest.mark.parametrize("question", EXTRA_KNOWLEDGE)
    def test_natural_variations_also_answered(self, service, question):
        assert_grounded_knowledge(ask(service, question), question)


class TestQuestionFormDoesNotControlRetrieval:
    """The same topic must retrieve the same knowledge regardless of phrasing."""

    @pytest.mark.parametrize(
        "question",
        [
            "what is a payment",
            "what is the payment",
            "what are payments",
            "explain payment",
            "explain about payments",
            "tell me about payments",
            "how does payment work",
            "how many types of payment are there",
        ],
    )
    def test_all_forms_retrieve_payments_document(self, service, question):
        result = ask(service, question)
        assert_grounded_knowledge(result, question)
        assert any(
            e["source"] == "Payments and Allocations" for e in result["evidence"]
        ), f"{question!r} did not cite the Payments document: {[e['source'] for e in result['evidence']]}"


class TestCountPhrasingRegression:
    """The specific production failure.

    Before normalization, "how many types of payment are there" scored its
    best on-topic chunk 1/3 + title bonus = 0.433, below the 0.5 gate, so the
    public assistant returned the generic abstention even though it had
    retrieved the Payments document (which is why the widget could still show
    "Source: Payments and Allocations" alongside the fallback text).
    """

    def test_count_question_is_grounded_not_abstained(self, service):
        result = ask(service, "how many types of payment are there")
        assert_grounded_knowledge(result, "how many types of payment are there")
        assert any(
            e["source"] == "Payments and Allocations" for e in result["evidence"]
        ), result["evidence"]

    def test_scaffolding_is_not_scored_as_topics(self, service):
        """Normalization must drop the scaffolding, not invent topical weight."""
        from app.modules.chatbot.knowledge.retrieval import (
            QUERY_STOPWORDS,
            _QUESTION_SCAFFOLD_WORDS,
        )
        import re

        words = [
            w
            for w in re.findall(r"[a-z0-9]+", "how many types of payment are there")
            if len(w) > 1
            and w not in QUERY_STOPWORDS
            and w not in _QUESTION_SCAFFOLD_WORDS
        ]
        assert words == ["payment"], words

    def test_enumeration_boost_signal_survives_normalization(self):
        """The +0.20 enum boost reads the RAW query, so it is not switched off
        for exactly the 'how many types of ...' questions it was built for."""
        import inspect
        import re

        from app.modules.chatbot.knowledge import retrieval as R

        src = inspect.getsource(R.KnowledgeRetriever.retrieve)
        assert "enum_words = set(raw_query_words) & _ENUM_SIGNALS" in src
        assert "if enum_words and _STRUCT_MARKERS.search(chunk_lower):" in src

        query = "how many types of payment are there"
        raw = [w for w in re.findall(r"[a-z0-9]+", query) if len(w) > 1]
        scored = [
            w
            for w in raw
            if w not in R.QUERY_STOPWORDS and w not in R._QUESTION_SCAFFOLD_WORDS
        ]
        # The topical score sees only the topic...
        assert scored == ["payment"], scored
        # ...while the enumeration intent is still detectable from the raw query.
        assert set(raw) & R._ENUM_SIGNALS == {"how", "many", "types", "are"}
        # The two vocabularies genuinely overlap, which is why the enum signal
        # must not be derived from the scaffolding-filtered words.
        assert set(R._ENUM_SIGNALS) & R._QUESTION_SCAFFOLD_WORDS == {
            "many", "types", "levels", "stages", "list", "kinds", "different",
        }


class TestTopicQuestionNeverUsesTheCapabilityIntro:
    """The capability/intro document enumerates every topic, so a topic
    question like "how does payment reconciliation work?" used to be answered
    with the intro text ("This assistant can help you with Zoiko Billing's
    public product documentation: ... payment reconciliation ...") instead of
    the document that actually explains the topic. Directory content must be
    demoted once the query names concrete topics; only capabilities questions
    ("what can you help me with?") should target it."""

    RECONCILIATION_DOC = "Payments and Reconciliation (How It Works)"
    INTRO_DOC = "What This Assistant Can Answer (Marketing)"

    @pytest.mark.parametrize("question", [
        "how does payment reconciliation work",
        "what is payment reconciliation",
        "explain payment reconciliation",
    ])
    def test_reconciliation_question_cites_the_reconciliation_document(self, service, question):
        result = ask(service, question)
        assert_grounded_knowledge(result, question)
        assert any(
            e["source"] == self.RECONCILIATION_DOC for e in result["evidence"]
        ), f"{question!r} did not cite {self.RECONCILIATION_DOC}: {[e['source'] for e in result['evidence']]}"
        assert all(
            e["source"] != self.INTRO_DOC for e in result["evidence"]
        ), f"{question!r} was answered by the capability intro: {[e['source'] for e in result['evidence']]}"

    def test_capabilities_question_still_targets_the_intro(self, service):
        result = ask(service, "what can you help me with?")
        assert_grounded_knowledge(result, "what can you help me with?")
        assert any(
            e["source"] == self.INTRO_DOC for e in result["evidence"]
        ), f"capabilities question lost the intro doc: {[e['source'] for e in result['evidence']]}"


class TestAbstentionStillWorks:
    """The fix must not turn the assistant into an always-answering machine."""

    @pytest.mark.parametrize(
        "question",
        [
            "how do I bake sourdough bread",
            "what is the weather in Paris tomorrow",
            "explain quantum chromodynamics to me",
        ],
    )
    def test_unrelated_question_abstains_with_no_evidence(self, service, question):
        result = ask(service, question)
        assert result["answer"] == _ABSTAIN_ANSWER, f"{question!r} was answered"
        assert result["evidence"] == [], f"{question!r} cited unrelated Zoiko content"

    def test_scaffolding_only_question_has_no_topical_signal(self, service):
        """After stripping scaffolding there is nothing topical left, so this
        must abstain rather than match the whole KB."""
        result = ask(service, "how many types are there")
        assert result["answer"] == _ABSTAIN_ANSWER
        assert result["evidence"] == []

    def test_unsupported_detail_is_not_invented(self, service):
        """Grounding in the Payments doc must not extend to facts it lacks."""
        result = ask(service, "what payment methods are supported")
        assert_grounded_knowledge(result, "what payment methods are supported")
        answer = result["answer"].lower()
        for invented in ("bitcoin", "crypto", "paypal", "wire transfer"):
            assert invented not in answer, f"invented payment method {invented!r}"


class TestPublicVisibilityUnchanged:
    def test_private_documents_never_cited(self, service):
        for question in (
            "what are the user roles and permissions",
            "how do I configure billing settings",
            "what permissions does an admin role have",
        ):
            result = ask(service, question)
            sources = {e["source"] for e in result["evidence"]}
            assert not (sources & PRIVATE_TITLES), f"{question!r} leaked {sources & PRIVATE_TITLES}"
            for title in PRIVATE_TITLES:
                assert title not in result["answer"], f"{question!r} quoted private doc {title!r}"

    def test_risk_class_retained_for_auditing(self, service):
        """R0 stays in the API payload for internal auditing; only the widget
        must stop rendering it (components/assistant/PublicAssistantWidget.tsx,
        commit c511f08). No backend change is involved."""
        result = ask(service, "what is the payment")
        assert result["risk_class"] == "R0"


class TestEndpointWiring:
    def test_message_route_exists_and_targets_the_service(self):
        from app.modules.chatbot import public_router

        target = "/assistant/public/sessions/{session_uid}/messages"
        assert target in {r.path for r in public_router.router.routes}
        assert any(
            getattr(r, "methods", None) and "POST" in r.methods and r.path == target
            for r in public_router.router.routes
        )
