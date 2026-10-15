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
from seed_knowledge import KB_ENTRIES, PUBLIC_SOURCE_URLS

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
            object_uri=PUBLIC_SOURCE_URLS.get(entry["title"]) if entry.get("is_public", False) else None,
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


class TestInvoiceTileQuestionTopicalRanking:
    """The approved "Invoices" topic tile — "How do I create and send an
    invoice?" — must be answered from the invoices documentation, not from the
    marketing "Pricing and Plans" blurb, which happens to list the verbs
    "create, send, collect and reconcile core invoices" and so out-scored the
    real topic document on raw word overlap (production regression: the answer
    degraded to the canned abstention while citing the pricing blurb).

    The peripheral-document demotion that fixes this is PUBLIC-path only, so
    the authenticated engine's ranking is untouched (asserted in source).
    """

    INVOICE_DOC = "Invoices Overview"
    MARKETING_BLURB = "Pricing and Plans (Marketing)"

    @pytest.mark.parametrize(
        "question",
        [
            "How do I create and send an invoice?",
            "How do I create an invoice?",
            "How do I send an invoice?",
            "how can I create an invoice",
        ],
    )
    def test_invoice_question_cites_the_invoice_document(self, service, question):
        result = ask(service, question)
        assert_grounded_knowledge(result, question)
        assert any(
            e["source"] == self.INVOICE_DOC for e in result["evidence"]
        ), f"{question!r} did not cite {self.INVOICE_DOC}: {[e['source'] for e in result['evidence']]}"
        assert result["evidence"][0]["source"] != self.MARKETING_BLURB, (
            f"{question!r} top evidence is the marketing blurb: "
            f"{[e['source'] for e in result['evidence']]}"
        )

    def test_peripheral_demotion_is_public_only(self):
        """A regression guard: the demotion must never apply on the
        authenticated path (is_public_only), nor to price questions whose
        answer document is named with different vocabulary than the query."""
        import inspect

        from app.modules.chatbot.knowledge import retrieval as R

        src = inspect.getsource(R.KnowledgeRetriever.retrieve)
        assert (
            "is_public_only and not price_words and topical_titles_present and not title_hit"
            in src
        )


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


class TestPublicSourceUrlMapping:
    """The marketing corpus may only cite approved zoikobilling.com pages.

    Every citation URL reaches the widget via KnowledgeDocument.object_uri
    (retrieval.py falls back to it when the source has no source_url). This
    contract locks the mapping so a future public document cannot silently
    ship with an invented, external or non-existent destination.
    """

    # Real, existing top-level marketing routes in zoiko-billing-nextjs/app/.
    # A mapping target must be one of these (or the site root).
    KNOWN_MARKETING_PATHS = {
        "/",
        "/automation",
        "/customer-records",
        "/global-billing",
        "/integrations",
        "/invoices",
        "/multi-currency",
        "/payments-and-reconcilliation",
        "/platform-overview",
        "/pricing",
        "/reporting-and-analytics",
        "/security-overview",
        "/why-zoiko-billing",
    }

    # Public documents intentionally left without a page (no existing page
    # covers the whole topic). Kept explicit so adding a public doc forces a
    # deliberate mapping decision rather than defaulting to "unmapped".
    INTENTIONALLY_UNMAPPED = {
        "Subscriptions and Plans",
        "Proration and Multi-Currency Billing",
        "Overdue Invoices and Dunning",
        "Contracts and Quotations",
        "Billing Workflows and Policies",
        "What This Assistant Can Answer (Marketing)",
    }

    def test_only_public_documents_are_mapped(self):
        for title in PUBLIC_SOURCE_URLS:
            entry = next((e for e in KB_ENTRIES if e["title"] == title), None)
            assert entry is not None, f"mapped title {title!r} is not in KB_ENTRIES"
            assert entry.get("is_public"), f"{title!r} is mapped but not public"

    def test_every_public_document_has_an_explicit_mapping_decision(self):
        for entry in KB_ENTRIES:
            if not entry.get("is_public"):
                continue
            title = entry["title"]
            mapped = title in PUBLIC_SOURCE_URLS
            intentionally = title in self.INTENTIONALLY_UNMAPPED
            assert mapped or intentionally, (
                f"public doc {title!r} has no citation URL and is not listed as "
                f"intentionally unmapped — decide and record its destination"
            )
            assert not (mapped and intentionally), f"{title!r} is both mapped and unmapped"

    def test_mapped_urls_are_approved_same_site_pages(self):
        from app.modules.chatbot.public_config import is_public_url_allowed

        for title, url in PUBLIC_SOURCE_URLS.items():
            assert is_public_url_allowed(url), (
                f"{title!r} maps to a URL the widget would refuse: {url!r}"
            )
            assert url.startswith("https://www.zoikobilling.com/"), (
                f"{title!r} must cite the canonical https host, got {url!r}"
            )
            path = "/" + url.split("zoikobilling.com/", 1)[1]
            assert path in self.KNOWN_MARKETING_PATHS, (
                f"{title!r} maps to a route that does not exist: {path!r}"
            )

    def test_retrieval_surfaces_the_document_citation_url(self, service):
        """End-to-end: a mapped document's citation must expose its URL."""
        result = ask(service, "what are the billing reports?")
        assert_grounded_knowledge(result, "what are the billing reports?")
        urls = {e["source"]: e.get("url") for e in result["evidence"]}
        assert urls.get("Billing Reports") == (
            "https://www.zoikobilling.com/reporting-and-analytics"
        ), urls

    def test_unmapped_public_document_has_no_url(self, service):
        """A topic with no page must cite a plain (URL-less) source."""
        result = ask(service, "how does dunning work")
        assert result["evidence"], "dunning should be answerable from the corpus"
        for e in result["evidence"]:
            if e["source"] in self.INTENTIONALLY_UNMAPPED:
                assert e.get("url") is None, f"{e['source']!r} unexpectedly has a URL"

