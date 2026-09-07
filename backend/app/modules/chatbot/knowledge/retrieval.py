"""
knowledge/retrieval.py
---------------------
RAG retrieval pipeline with hybrid search (lexical + vector),
hard tenant/namespace filters, citation tracking, and confidence gating.

Key rules per ZB-AI-KB-001:
  - Retrieval must exclude anything not 'approved'
  - Hard tenant/namespace filters BEFORE ranking, not after
  - Every answer from retrieval includes citation rows
  - Low/conflicting confidence -> bounded "I don't have a confirmed answer"
  - Retrieved text is data, never treated as instruction
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
from typing import Any

from sqlalchemy import func, or_, and_
from sqlalchemy.orm import Session

from ..context.ai_context import AIContext
from ..models import (
    KnowledgeNamespace,
    KnowledgeSource,
    KnowledgeDocument,
    KnowledgeChunk,
    RetrievalRun,
    RetrievalCitation,
    FreshnessStatus,
    KnowledgeClassification,
)

logger = logging.getLogger("zoiko_billing.ai.knowledge")

# Defense-in-depth (ZB-AI-KB-001): the ONLY knowledge sources whose chunks
# may appear in a live chat response. Internal engineering documentation
# (FRS / PRD / API / architecture / guardrail wireframes) must never be
# indexed for retrieval at all — the index-level gate is the ingester
# allowlist in scripts/seed_knowledge_base.py; THIS allowlist is the runtime
# backstop that drops foreign sources before ranking if that ever regresses.
PUBLIC_KB_SOURCE_TITLES = frozenset({"Zoiko Billing Knowledge Base"})

# Generic phrasing words ("how do ... work?") carry no topical signal. Counting
# them as matches is what let invoice chunks score highly for a permissions
# question — relevance must be computed over CONTENT words only.
QUERY_STOPWORDS = frozenset((
    "a", "an", "the", "and", "or", "but", "if", "then", "else",
    "what", "which", "who", "whom", "whose", "why", "how",
    "do", "does", "did", "done", "is", "are", "was", "were", "be", "been",
    "being", "am", "can", "could", "should", "would", "will", "shall",
    "may", "might", "must",
    "to", "of", "in", "on", "for", "with", "at", "by", "from", "as", "into",
    "about", "over", "after", "before", "between", "out", "against",
    "during", "without", "under", "up", "down", "off", "than", "there", "here",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its",
    "they", "them", "their", "this", "that", "these", "those",
    "have", "has", "had", "having", "not", "no", "yes",
    "please", "tell", "show", "get", "give", "need", "want", "know",
    "work", "works", "working", "use", "using", "used", "explain", "like", "also",
    "just", "some", "any", "each", "every", "all", "more", "most", "other",
    "only", "own", "same", "so", "too", "very", "again", "once", "when",
))


# Enumeration/count-signal constants: used to boost chunks containing
# structural list markers when the query asks about types, levels, etc.
_ENUM_SIGNALS = frozenset({
    "how", "many", "types", "levels", "stages",
    "list", "kinds", "what", "are", "different",
})
_STRUCT_MARKERS = re.compile(
    r"(?:level\s+\d|step\s+\d|(?:type|kind|stage|tier)\s+\d"
    r"|\b\d+\.\s|option\s+[a-d])",
)


def _uid() -> str:
    return str(uuid.uuid4())


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class RetrievalResult:
    """A single retrieval result with citation metadata."""

    def __init__(
        self,
        chunk_text: str,
        score: float,
        rank: int,
        source_title: str,
        source_type: str,
        document_id: int,
        chunk_id: int,
        namespace_code: str,
    ):
        self.chunk_text = chunk_text
        self.score = score
        self.rank = rank
        self.source_title = source_title
        self.source_type = source_type
        self.document_id = document_id
        self.chunk_id = chunk_id
        self.namespace_code = namespace_code

    def to_dict(self) -> dict:
        return {
            "text": self.chunk_text[:500],
            "score": self.score,
            "rank": self.rank,
            "source_title": self.source_title,
            "source_type": self.source_type,
            "namespace": self.namespace_code,
        }


class KnowledgeRetriever:
    """Hybrid retrieval with tenant-scoped namespace filtering."""

    def __init__(self, db: Session):
        self.db = db
        # Cache for approved document IDs per namespace (invalidate on KB changes)
        self._doc_cache: dict[tuple, tuple[list[int], float]] = {}
        self._doc_obj_cache: dict[tuple, tuple[list, float]] = {}  # cache document objects
        self._cache_ttl = 300  # 5 minutes

    def _get_cached_doc_ids(self, namespace_ids: tuple[int, ...], freshness_policy: str) -> list[int] | None:
        """Get cached document IDs if valid."""
        import time
        cache_key = (namespace_ids, freshness_policy)
        if cache_key in self._doc_cache:
            doc_ids, cached_time = self._doc_cache[cache_key]
            if time.time() - cached_time < self._cache_ttl:
                return doc_ids
        return None

    def _set_cached_doc_ids(self, namespace_ids: tuple[int, ...], freshness_policy: str, doc_ids: list[int]) -> None:
        """Cache document IDs."""
        import time
        cache_key = (namespace_ids, freshness_policy)
        self._doc_cache[cache_key] = (doc_ids, time.time())

    def _get_cached_docs(self, namespace_ids: tuple[int, ...], freshness_policy: str) -> list | None:
        """Get cached document objects if valid."""
        import time
        cache_key = (namespace_ids, freshness_policy)
        if cache_key in self._doc_obj_cache:
            docs, cached_time = self._doc_obj_cache[cache_key]
            if time.time() - cached_time < self._cache_ttl:
                return docs
        return None

    def _set_cached_docs(self, namespace_ids: tuple[int, ...], freshness_policy: str, docs: list) -> None:
        """Cache document objects."""
        import time
        cache_key = (namespace_ids, freshness_policy)
        self._doc_obj_cache[cache_key] = (docs, time.time())

    def _validate_cached_docs(
        self,
        namespace_ids: tuple[int, ...],
        freshness_policy: str,
        cached_docs: list,
    ) -> list | None:
        """RT-022: a document can be revoked/expired while it still sits in the
        retriever's document cache (TTL 300s). On a cache hit we re-verify the
        cached set against the DB so a revoked chunk is never served from the
        cache. Returns the original list if still valid, ``[]`` for an empty
        (valid) hit, or ``None`` when a stored document is stale — in which case
        the caller evicts the cache and rebuilds from the DB.
        """
        if not cached_docs:
            return cached_docs
        ids = [d.id for d in cached_docs]
        invalid = (
            self.db.query(KnowledgeDocument.id)
            .filter(
                KnowledgeDocument.id.in_(ids),
                KnowledgeDocument.status != "approved",
            )
        )
        if freshness_policy == "current_only":
            invalid = invalid.union(
                self.db.query(KnowledgeDocument.id).filter(
                    KnowledgeDocument.id.in_(ids),
                    KnowledgeDocument.freshness_status == FreshnessStatus.EXPIRED,
                )
            )
        if invalid.count():
            cache_key = (namespace_ids, freshness_policy)
            self._doc_obj_cache.pop(cache_key, None)
            self._doc_cache.pop(cache_key, None)
            return None
        return cached_docs

    def invalidate(self) -> None:
        """Drop all cached documents/IDs so the next retrieve rebuilds from the
        DB. Called when knowledge-base documents are revoked, expired, or
        otherwise changed out-of-band (ingestion/admin pipeline)."""
        self._doc_cache.clear()
        self._doc_obj_cache.clear()

    def retrieve(
        self,
        *,
        query: str,
        ctx: AIContext,
        namespace_codes: list[str] | None = None,
        top_k: int = 5,
        min_score: float = 0.3,
        freshness_policy: str = "current_only",
        message_id: int | None = None,
        boost_terms: list[str] | None = None,
        domains: list[str] | None = None,
    ) -> tuple[list[RetrievalResult], list[dict]]:
        """Retrieve knowledge chunks relevant to a query.

        Args:
            domains: Current app-page domain segments (e.g. ['invoices'] for
                '/billing/invoices'). When non-empty, namespaces that declare
                allowed_domains/blocked_domains are restricted to the current
                surface. When empty or None, no domain restriction is applied
                (matches pre-restriction behavior).

        Returns:
            (results, citations_dict) — results for grounding, citations for DB storage
        """
        start_time = time.monotonic()
        
        # Resolve allowed namespaces
        namespaces = self._resolve_namespaces(ctx, namespace_codes, domains=domains)
        if not namespaces:
            return [], []

        # Build namespace-scoped query
        namespace_ids = tuple(ns.id for ns in namespaces)
        
        # Try cache first for document objects
        approved_docs = self._get_cached_docs(namespace_ids, freshness_policy)
        if approved_docs is not None:
            # RT-022: a document can be revoked/expired while it sits in the
            # cache. On a cache hit we re-verify the cached set is still
            # approved/current; if not, the cache is evicted and we rebuild
            # from the DB so a revoked chunk is never served from the cache.
            approved_docs = self._validate_cached_docs(namespace_ids, freshness_policy, approved_docs)
            if approved_docs is not None:
                doc_ids = [d.id for d in approved_docs]
                cache_hit = True
        if approved_docs is None:
            # Get approved, current documents with sources in one query.
            # KnowledgeDocument has no 'source' relationship (only source_id FK),
            # so we filter source titles directly in SQL via the join.
            doc_query = (
                self.db.query(KnowledgeDocument)
                .join(KnowledgeSource, KnowledgeSource.id == KnowledgeDocument.source_id)
                .filter(
                    KnowledgeSource.namespace_id.in_(namespace_ids),
                    KnowledgeSource.title.in_(PUBLIC_KB_SOURCE_TITLES),
                    KnowledgeSource.status == "active",
                    KnowledgeDocument.status == "approved",
                    KnowledgeDocument.freshness_status != FreshnessStatus.EXPIRED,
                )
            )

            if freshness_policy == "current_only":
                doc_query = doc_query.filter(KnowledgeDocument.freshness_status == FreshnessStatus.CURRENT)

            approved_docs = doc_query.all()
            
            if not approved_docs:
                return [], []
            
            doc_ids = [d.id for d in approved_docs]
            # Cache the document objects
            self._set_cached_docs(namespace_ids, freshness_policy, approved_docs)
            cache_hit = False
        
        logger.debug("KB retrieve: namespace_ids=%s doc_ids=%d cache_hit=%s time=%dms",
                     namespace_ids, len(doc_ids), cache_hit, 
                     int((time.monotonic() - start_time) * 1000))

        # Load all knowledge chunks for the approved documents
        if not doc_ids:
            return [], []
        chunks = (
            self.db.query(KnowledgeChunk)
            .filter(
                KnowledgeChunk.document_id.in_(doc_ids),
                KnowledgeChunk.classification != KnowledgeClassification.RESTRICTED,
            )
            .order_by(KnowledgeChunk.document_id, KnowledgeChunk.chunk_sequence)
            .all()
        )
        if not chunks:
            return [], []

        # Lexical search (simple keyword matching — vector search via pgvector in production)
        query_lower = query.lower()
        scored_chunks = []
        # Score over content words only; a query made purely of stopwords has
        # no topical signal and must not match anything. Tokenize on
        # alphanumeric runs so punctuation never rides along ("reports?"
        # must match chunks containing "reports").
        query_words = [
            w for w in re.findall(r"[a-z0-9]+", query_lower)
            if len(w) > 1 and w not in QUERY_STOPWORDS
        ]
        if not query_words:
            return [], []

        unique_words = set(query_words)

        # Stem-aware variants: match plural/singular forms ("refunds" must
        # match chunks discussing "refund"/"refunded"). The short stem is
        # used for occurrence counting so plurals never double-count.
        variants: dict[str, tuple[str, ...]] = {}
        for w in unique_words:
            stem = w[:-1] if w.endswith("s") and len(w) > 3 else w
            variants[w] = (w, stem) if stem != w else (w,)

        def _chunk_matches(chunk_lower: str, word: str) -> bool:
            return any(v in chunk_lower for v in variants[word])

        # IDF-style dampening, SCALE-INVARIANT: measure how many distinct
        # source DOCUMENTS contain the word (as a fraction of all documents),
        # not raw chunk counts. A term present in most documents ("billing"
        # in a billing KB) carries almost no topical signal whether the KB
        # has 10 chunks or 10,000 — a chunk-count threshold tuned on a large
        # KB silently stops dampening on small KBs (e.g. 4/10 chunks misses
        # a "> 40% of chunks" cutoff by rounding, while the same word sits
        # in 100% of documents). Without dampening, dense chunks matching
        # only such generic terms win citations for unrelated queries.
        #
        # TOPIC-TITLE EXEMPTION: corpus frequency alone cannot distinguish a
        # generic filler word from a DOMAIN TOPIC that every document merely
        # references in passing. "refunds"/"payments" appear in most billing
        # docs (status lists, workflow steps) yet each names a dedicated
        # document — dampening them to 0.25 made chunks in their OWN topic
        # documents score below the admission gate (0.2 < min_score) while
        # any chunk containing the query's only full-weight word ("explain")
        # sailed through at 0.8. A word that stem-matches ANY approved
        # document title is topical vocabulary by definition and is never
        # dampened. This is a property of the matching logic, not a per-topic
        # exception list.
        n_docs = len({d.id for d in approved_docs})
        title_by_doc = {d.id: (d.title or "").lower() for d in approved_docs}
        titled_stems: set[str] = set()
        for _t in title_by_doc.values():
            for tok in re.findall(r"[a-z0-9]+", _t):
                titled_stems.add(tok[:-1] if tok.endswith("s") and len(tok) > 3 else tok)
        doc_ids_by_word = {
            w: {c.document_id for c in chunks if _chunk_matches(c.chunk_text.lower(), w)}
            for w in unique_words
        }
        word_weight = {
            w: (
                0.25
                if len(doc_ids_by_word[w]) > 0.5 * n_docs
                and not {w, variants[w][-1]} & titled_stems
                else 1.0
            )
            for w in unique_words
        }
        total_weight = sum(word_weight[w] for w in query_words)

        if os.environ.get("KB_RETRIEVAL_TRACE"):
            logger.info(
                "kb-trace q=%r words=%s weights=%s",
                query,
                sorted(unique_words),
                {w: word_weight[w] for w in sorted(unique_words)},
            )

        boost_terms = [t for t in (boost_terms or []) if t]
        candidates = []  # (chunk, score, term_occurrences)
        for chunk in chunks:
            chunk_lower = chunk.chunk_text.lower()
            matched_weight = sum(
                word_weight[w] for w in query_words if _chunk_matches(chunk_lower, w)
            )
            score = matched_weight / total_weight

            # Boost for exact phrase match
            if query_lower in chunk_lower:
                score = min(score + 0.3, 1.0)

            if score >= min_score:
                occurrences = sum(
                    chunk_lower.count(variants[w][-1]) for w in unique_words
                )
                candidates.append((chunk, score, occurrences))

        # Term-frequency factor: among chunks matching the same words, prefer
        # those where the terms are CENTRAL (discussed repeatedly) over ones
        # that merely mention them in passing. Without this, a query like
        # "how do refunds work?" co-cites every document that name-drops
        # refunds alongside the document actually about refunds.
        if candidates:
            max_occ = max(o for _, _, o in candidates) or 1
            candidates = [
                (c, s * (0.75 + 0.25 * (o / max_occ)), o)
                for c, s, o in candidates
            ]

        # Phrase-proximity bonus: a chunk containing a CONTIGUOUS query
        # bigram ("invoice statuses") is about that concept, while a chunk
        # that merely scatters the same words through a vocabulary table is
        # peripheral. Applied after the TF factor so it can reorder, but
        # never manufacture, candidates.
        phrases = [
            (a, b) for a, b in zip(query_words, query_words[1:]) if a != b
        ]
        phrase_patterns = [
            re.compile(rf"\b(?:{re.escape(a)}\s+{re.escape(b)}|{re.escape(b)}\s+{re.escape(a)})\b")
            for a, b in phrases
        ]
        if phrase_patterns:
            candidates = [
                (c, s, o)
                for c, s, o in (
                    (
                        c,
                        min(
                            s + (0.15 if any(
                                pat.search(c.chunk_text.lower())
                                for pat in phrase_patterns
                            ) else 0.0),
                            1.0,
                        ),
                        o,
                    )
                    for c, s, o in candidates
                )
            ]

        # Stage-by-stage scoring trace (KB_RETRIEVAL_TRACE=1): records how
        # each bonus/penalty contributed to the top candidates, for tuning.
        trace_enabled = bool(os.environ.get("KB_RETRIEVAL_TRACE"))
        stage_trace: dict[int, dict] = {}

        for chunk, score, _occ in candidates:
            chunk_lower = chunk.chunk_text.lower()
            if trace_enabled:
                stage_trace[id(chunk)] = {"base": round(score, 3)}
            # Document-title relevance: a chunk whose DOCUMENT TITLE contains
            # a query term belongs to a document ABOUT that topic, while a
            # chunk that merely name-drops the term inside an unrelated
            # document is peripheral. Decisive when every candidate mentions
            # the term exactly once and the TF factor cannot separate them.
            if any(
                _chunk_matches(title_by_doc.get(chunk.document_id, ""), w)
                for w in unique_words
            ):
                score = min(score + 0.1, 1.0)
                if trace_enabled:
                    stage_trace[id(chunk)]["title"] = 0.1
            # Page-context boost re-ranks already-relevant chunks toward
            # the surface the user is currently on. Applied only AFTER the
            # relevance bar is met, so it can never rescue weak matches.
            if boost_terms and any(t in chunk.chunk_text.lower() for t in boost_terms):
                score = min(score + 0.1, 1.0)
                if trace_enabled:
                    stage_trace[id(chunk)]["page"] = 0.1
            # Heading-zone boost: a chunk whose OPENING region (the section
            # heading its ingester prefixed) contains the topic is ABOUT that
            # topic. Require TWO distinct query terms so a chunk that merely
            # name-drops one term early ("...refunds, and net revenue...")
            # keeps its peripheral status; definitional openings like
            # "Invoice statuses in Zoiko Billing:" clear the bar.
            if (
                len({w for w in unique_words if w in chunk.chunk_text[:120].lower()}) >= 2
            ):
                score = min(score + 0.05, 1.0)
                if trace_enabled:
                    stage_trace[id(chunk)]["heading"] = 0.05
            # Enumeration/count-signal boost: when the query asks "how many
            # types", "what are the levels", "list the stages", etc., chunks
            # containing structural list markers (Level 1, Step 2, numbered
            # patterns) are direct answers. Without this, the setup how-to
            # chunk matches the same words and scores equally or higher
            # because it contains the term more times, even though it doesn't
            # enumerate the types the user is asking about.
            if unique_words & _ENUM_SIGNALS and _STRUCT_MARKERS.search(chunk_lower):
                score = min(score + 0.20, 1.0)
                if trace_enabled:
                    stage_trace[id(chunk)]["enum"] = 0.20
            # Table-fragment demotion: chunks dominated by pipe-delimited
            # table rows (wireframe specs) extract as unreadable fragments;
            # definitional prose should win close contests against them.
            if chunk.chunk_text.count("|") >= 6:
                score = max(score - 0.08, 0.0)
                if trace_enabled:
                    stage_trace[id(chunk)]["table"] = -0.08
            scored_chunks.append((chunk, score))

        # Sort by score descending
        scored_chunks.sort(key=lambda x: x[1], reverse=True)
        if trace_enabled:
            for chunk, score in scored_chunks[:8]:
                logger.info(
                    "kb-trace q=%r doc=%r stages=%s final=%.3f",
                    query,
                    title_by_doc.get(chunk.document_id),
                    stage_trace.get(id(chunk), {}),
                    score,
                )
        top_chunks = scored_chunks[:top_k]

        # Relevance floor: drop chunks scoring far below the best match so
        # citations always reflect what the answer actually relies on (a 0.67
        # chunk must not ride along with a 1.0 match from another document).
        # RELATIVE only — scores are query-normalized (matched/total), so an
        # absolute floor here silently discarded every result for queries
        # carrying extra noise words ("...different invoice statuses mean?"),
        # which is what pushed users to whatever weak chunk cleared the bar.
        # Weak-top queries are handled downstream by confidence gating, not
        # by pretending nothing was found.
        if top_chunks:
            floor = top_chunks[0][1] * 0.85
            top_chunks = [(c, s) for c, s in top_chunks if s >= floor]
            # Guarantee at least 2 chunks from the TOP document for LLM
            # synthesis — the strict 85% floor can drop a genuinely relevant
            # second chunk on "explain" queries where the definition and
            # how-to sit just above/below the threshold.  Scoped to same
            # document, relaxed to 80% of top score for the extra chunk.
            if len(top_chunks) < 2:
                top_doc_id = scored_chunks[0][0].document_id if scored_chunks else None
                if top_doc_id:
                    relaxed_floor = top_chunks[0][1] * 0.80
                    same_doc_relaxed = [
                        (c, s) for c, s in scored_chunks
                        if c.document_id == top_doc_id and s >= relaxed_floor
                    ]
                    if len(same_doc_relaxed) >= 2:
                        top_chunks = same_doc_relaxed[:2]

        # Build results
        results = []
        citations_data = []

        # Build doc lookup for source info
        doc_map = {d.id: d for d in approved_docs}
        unique_source_ids = list({d.source_id for d in approved_docs})
        sources = self.db.query(KnowledgeSource).filter(KnowledgeSource.id.in_(unique_source_ids)).all()
        source_map = {s.id: s for s in sources}

        for rank, (chunk, score) in enumerate(top_chunks, 1):
            doc = doc_map.get(chunk.document_id)
            source = source_map.get(doc.source_id) if doc else None

            result = RetrievalResult(
                chunk_text=chunk.chunk_text,
                score=score,
                rank=rank,
                source_title=doc.title if doc else "Unknown",
                source_type=source.source_type.value if source else "unknown",
                document_id=chunk.document_id,
                chunk_id=chunk.id,
                namespace_code=namespaces[0].namespace_code if namespaces else "unknown",
            )
            results.append(result)

            citations_data.append({
                "chunk_id": chunk.id,
                "rank": rank,
                "score": score,
                "source_title": doc.title if doc else "Unknown",
            })

        return results, citations_data

    def store_retrieval(
        self,
        *,
        ctx: AIContext,
        query: str,
        results: list[RetrievalResult],
        citations_data: list[dict],
        namespace_code: str,
        message_id: int | None = None,
    ) -> int | None:
        """Store a retrieval run and its citations. Returns retrieval_run_id."""
        namespace = (
            self.db.query(KnowledgeNamespace)
            .filter(KnowledgeNamespace.namespace_code == namespace_code)
            .first()
        )
        if not namespace:
            return None

        run = RetrievalRun(
            retrieval_run_uid=_uid(),
            knowledge_namespace_id=namespace.id,
            message_id=message_id,
            query_hash=_hash(query),
            top_k=len(results),
            result_count=len(results),
        )
        self.db.add(run)
        self.db.flush()

        for cite in citations_data:
            citation = RetrievalCitation(
                retrieval_run_id=run.id,
                knowledge_chunk_id=cite["chunk_id"],
                rank=cite["rank"],
                score=cite["score"],
                used_in_message_id=message_id,
            )
            self.db.add(citation)

        return run.id

    @staticmethod
    def _parse_domain_restrictions(raw: Any) -> set[str]:
        """Normalize an allowed_domains/blocked_domains cell into a set of
        lowercase domain tokens. Accepts a proper JSON array or a
        JSON-encoded string (legacy seeds); anything else is ignored."""
        if raw is None:
            return set()
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return set()
            items = parsed if isinstance(parsed, list) else [parsed]
        elif isinstance(raw, (list, tuple, set)):
            items = raw
        else:
            return set()
        return {
            str(item).strip().lower()
            for item in items
            if item is not None and str(item).strip()
        }

    def _resolve_namespaces(
        self,
        ctx: AIContext,
        namespace_codes: list[str] | None,
        domains: list[str] | None = None,
    ) -> list[KnowledgeNamespace]:
        """Resolve allowed namespaces for the current tenant context.

        Namespaces that declare access restrictions (allowed_domains /
        blocked_domains) are limited to those app surfaces. Restrictions are
        only enforced when a current page domain is known: without one, every
        namespace resolves as before (retrieval was never domain-scoped), so
        existing installs keep working until a restriction is declared."""
        query = self.db.query(KnowledgeNamespace)

        if namespace_codes:
            query = query.filter(KnowledgeNamespace.namespace_code.in_(namespace_codes))
        else:
            # Default: public + tenant-specific namespaces
            query = query.filter(
                or_(
                    KnowledgeNamespace.namespace_code == "billing_public",
                    KnowledgeNamespace.tenant_id == ctx.organization_id,
                )
            )

        namespaces = query.all()

        current_domains = {
            d.strip().lower()
            for d in (domains or [])
            if d and str(d).strip()
        }
        if not current_domains:
            return namespaces

        def _restricted(ns: KnowledgeNamespace) -> bool:
            allowed = self._parse_domain_restrictions(ns.allowed_domains)
            blocked = self._parse_domain_restrictions(ns.blocked_domains)
            if allowed and not (allowed & current_domains):
                return True
            if blocked and (blocked & current_domains):
                return True
            return False

        return [ns for ns in namespaces if not _restricted(ns)]

    def is_confident(self, results: list[RetrievalResult], threshold: float = 0.5) -> bool:
        """Check if retrieval results are confident enough to answer."""
        if not results:
            return False
        return any(r.score >= threshold for r in results)

    def has_conflicting_evidence(self, results: list[RetrievalResult]) -> bool:
        """Detect if retrieved sources conflict with each other."""
        if len(results) < 2:
            return False
        # Simple heuristic: if top results have very different scores, potential conflict
        scores = [r.score for r in results[:3]]
        return max(scores) - min(scores) > 0.4 and min(scores) < 0.3
