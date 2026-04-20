"""Grounding policy, coverage evaluation, and citation verification.

This module implements the **Phase 1 refusal + citation contract**:

1. :func:`evaluate_coverage` — pure function.  Given a list of
   retriever results and a :class:`GroundingPolicy`, returns a
   :class:`Coverage` object with summary statistics and an
   ``is_grounded`` flag.  If ``is_grounded`` is ``False`` the agent
   MUST refuse rather than generate.

2. :func:`verify_citations` — post-generation check.  Every ``[n]``
   marker present in the answer text must resolve to a real chunk that
   appeared in the retrieved set, and every citation claimed in the
   structured ``citations`` list must have a corresponding marker in the
   answer.  Violations are collected into a
   :class:`apps.copilot.models.CitationVerificationResult`.

No network or LLM calls happen here — all logic is deterministic and
trivially unit-testable.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.models import CitationVerificationResult, RetrievedChunk

_CITATION_MARKER_RE = re.compile(r"\[(\d+)\]")
"""Matches ``[1]``, ``[12]``, etc.  Markers are 1-based positive integers."""


# ---------------------------------------------------------------------------
# Policy + coverage
# ---------------------------------------------------------------------------


class GroundingPolicy(BaseModel):
    """Rules the agent applies before agreeing to generate an answer.

    ``off_scope_classifier`` is currently always ``"similarity"`` —
    Phase 1 ships only the similarity-based classifier.  The ``"llm"``
    option is reserved for a future phase where we use a secondary
    cheap-model call to classify "is this even a CSA question?".
    """

    min_similarity: float = Field(ge=0.0, le=1.0, description="Minimum per-chunk similarity.")
    min_chunks: int = Field(ge=1, description="Minimum chunks meeting min_similarity.")
    refusal_message: str = Field(description="User-visible refusal text.")
    off_scope_classifier: Literal["similarity", "llm"] = Field(
        default="similarity",
        description="Coverage classifier mode. Only 'similarity' is implemented in Phase 1.",
    )

    model_config = ConfigDict(frozen=True)


class Coverage(BaseModel):
    """Result of :func:`evaluate_coverage`.

    ``is_grounded`` is the single flag the agent reads — all other
    fields exist for observability and test assertions.
    """

    max_similarity: float = Field(ge=0.0, le=1.0, description="Highest similarity across all results.")
    mean_similarity: float = Field(ge=0.0, le=1.0, description="Mean similarity across all results.")
    chunks_above_threshold: int = Field(ge=0, description="Count of chunks meeting min_similarity.")
    is_grounded: bool = Field(description="True when policy.min_chunks is satisfied.")
    total_chunks: int = Field(ge=0, description="Total chunks considered.")

    model_config = ConfigDict(frozen=True)


def evaluate_coverage(results: list[RetrievedChunk], policy: GroundingPolicy) -> Coverage:
    """Summarise retrieval coverage against a :class:`GroundingPolicy`.

    Pure function — given the same inputs, always returns the same
    :class:`Coverage`.  Safe to call from async code without ``await``.

    Args:
        results: Chunks returned by the retriever (already sorted by
            similarity desc, but this function does not require that).
        policy: The grounding policy in force for this agent.

    Returns:
        A :class:`Coverage` snapshot.  The caller interprets
        ``is_grounded`` to decide between generate and refuse.
    """
    if policy.off_scope_classifier != "similarity":
        # Defensive: the type system already constrains values, but raise
        # a clear error if a future policy mode is selected without a
        # matching implementation.
        raise NotImplementedError(
            f"Coverage classifier '{policy.off_scope_classifier}' is not implemented in Phase 1.",
        )

    total = len(results)
    if total == 0:
        return Coverage(
            max_similarity=0.0,
            mean_similarity=0.0,
            chunks_above_threshold=0,
            is_grounded=False,
            total_chunks=0,
        )

    similarities = [r.similarity for r in results]
    max_sim = max(similarities)
    mean_sim = sum(similarities) / total
    above = sum(1 for s in similarities if s >= policy.min_similarity)
    grounded = above >= policy.min_chunks

    return Coverage(
        max_similarity=max_sim,
        mean_similarity=mean_sim,
        chunks_above_threshold=above,
        is_grounded=grounded,
        total_chunks=total,
    )


# ---------------------------------------------------------------------------
# Citation verification
# ---------------------------------------------------------------------------


def extract_citation_markers(answer_text: str) -> list[int]:
    """Return the numeric ids referenced by ``[n]`` markers, in order.

    Duplicates are preserved (so callers can detect repeated citations
    and, if they like, dedupe themselves).  Non-matching markers are
    ignored.
    """
    return [int(m) for m in _CITATION_MARKER_RE.findall(answer_text)]


def verify_citations(
    answer_text: str,
    retrieved_chunks: list[RetrievedChunk],
    cited_ids: list[int],
    chunk_id_by_citation: dict[int, str] | None = None,
) -> CitationVerificationResult:
    """Verify that every citation is both marked and grounded.

    A citation is *valid* when:

    * Its 1-based id appears as ``[n]`` at least once in the answer text.
    * The underlying chunk id (provided via ``chunk_id_by_citation``)
      matches a chunk returned by the retriever.  If no mapping is
      provided, the id is treated as positional and must satisfy
      ``1 <= id <= len(retrieved_chunks)``.

    Args:
        answer_text: The generated answer text.
        retrieved_chunks: The chunks returned by the retriever for
            this query (the ground-truth set).
        cited_ids: Citation ids claimed by the generator via the
            structured output.
        chunk_id_by_citation: Optional map from citation id → chunk id.
            Required when citation ids don't correspond to the
            positional order of ``retrieved_chunks``.

    Returns:
        A :class:`CitationVerificationResult`.  ``valid`` is ``True``
        only when no markers are missing AND no ids are fabricated AND
        the answer contains at least one ``[n]`` marker overall.
    """
    marker_ids = extract_citation_markers(answer_text)
    marker_id_set = set(marker_ids)
    cited_id_set = set(cited_ids)

    # Detect missing markers: every id claimed in the citations list
    # must appear at least once as a [n] marker in the answer text.
    missing = sorted(cited_id_set - marker_id_set)

    # Detect fabricated ids: every id referenced by either a marker
    # OR the citations list must resolve to a retrieved chunk.
    retrieved_ids = {c.id for c in retrieved_chunks}
    all_ids = marker_id_set | cited_id_set
    fabricated: list[int] = []

    if chunk_id_by_citation is not None:
        # Explicit mapping: every id must have an entry AND the mapped
        # chunk id must be present in the retrieved set.
        for cid in sorted(all_ids):
            mapped = chunk_id_by_citation.get(cid)
            if mapped is None or mapped not in retrieved_ids:
                fabricated.append(cid)
    else:
        # Positional fallback: ids are 1-based indices into retrieved_chunks.
        upper = len(retrieved_chunks)
        for cid in sorted(all_ids):
            if cid < 1 or cid > upper:
                fabricated.append(cid)

    # The contract requires *at least one* citation marker overall — an
    # answer with no markers cannot be verifiable even if the
    # citations list is empty.
    has_any_marker = bool(marker_ids)
    valid = has_any_marker and not missing and not fabricated

    return CitationVerificationResult(
        valid=valid,
        missing_markers=missing,
        fabricated_ids=fabricated,
        marker_ids_found=sorted(marker_id_set),
    )
