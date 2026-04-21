"""Tests for :mod:`apps.copilot.grounding`.

These are all pure-function tests — no Azure, no LLM, no async.
"""

from __future__ import annotations

import pytest

from apps.copilot.grounding import (
    GroundingPolicy,
    evaluate_coverage,
    extract_citation_markers,
    verify_citations,
)
from apps.copilot.models import RetrievedChunk


def _chunk(cid: str, similarity: float, source: str = "docs/sample.md") -> RetrievedChunk:
    """Test helper: build a RetrievedChunk with minimal fields."""
    return RetrievedChunk(
        id=cid,
        source_path=source,
        text=f"Text for {cid}",
        similarity=similarity,
        doc_type="overview",
    )


def _policy(min_sim: float = 0.5, min_chunks: int = 2) -> GroundingPolicy:
    return GroundingPolicy(
        min_similarity=min_sim,
        min_chunks=min_chunks,
        refusal_message="No grounded context.",
        off_scope_classifier="similarity",
    )


# ---------------------------------------------------------------------------
# evaluate_coverage
# ---------------------------------------------------------------------------


class TestEvaluateCoverage:
    """evaluate_coverage should summarise retrieval quality deterministically."""

    def test_empty_results_are_not_grounded(self) -> None:
        coverage = evaluate_coverage([], _policy())
        assert coverage.is_grounded is False
        assert coverage.total_chunks == 0
        assert coverage.max_similarity == 0.0
        assert coverage.mean_similarity == 0.0
        assert coverage.chunks_above_threshold == 0

    def test_all_below_threshold_refuses(self) -> None:
        results = [_chunk("a", 0.10), _chunk("b", 0.20), _chunk("c", 0.30)]
        coverage = evaluate_coverage(results, _policy(min_sim=0.5, min_chunks=1))
        assert coverage.is_grounded is False
        assert coverage.chunks_above_threshold == 0
        assert coverage.max_similarity == pytest.approx(0.30)

    def test_enough_above_threshold_is_grounded(self) -> None:
        results = [_chunk("a", 0.90), _chunk("b", 0.80), _chunk("c", 0.10)]
        coverage = evaluate_coverage(results, _policy(min_sim=0.5, min_chunks=2))
        assert coverage.is_grounded is True
        assert coverage.chunks_above_threshold == 2
        assert coverage.max_similarity == pytest.approx(0.90)
        assert coverage.mean_similarity == pytest.approx((0.9 + 0.8 + 0.1) / 3)

    def test_boundary_similarity_is_inclusive(self) -> None:
        # A chunk exactly at the threshold should count.
        results = [_chunk("a", 0.50), _chunk("b", 0.50)]
        coverage = evaluate_coverage(results, _policy(min_sim=0.5, min_chunks=2))
        assert coverage.is_grounded is True
        assert coverage.chunks_above_threshold == 2

    def test_min_chunks_gate_is_strict(self) -> None:
        # Only one chunk meets the threshold; min_chunks=2 → refusal.
        results = [_chunk("a", 0.99), _chunk("b", 0.10)]
        coverage = evaluate_coverage(results, _policy(min_sim=0.5, min_chunks=2))
        assert coverage.is_grounded is False
        assert coverage.chunks_above_threshold == 1

    def test_unsupported_classifier_raises(self) -> None:
        policy = _policy()
        # Bypass Pydantic validation to simulate a future classifier.
        bad_policy = policy.model_copy(update={"off_scope_classifier": "llm"})
        with pytest.raises(NotImplementedError):
            evaluate_coverage([_chunk("a", 0.9)], bad_policy)


# ---------------------------------------------------------------------------
# extract_citation_markers
# ---------------------------------------------------------------------------


class TestExtractCitationMarkers:
    """The marker extractor underpins citation verification."""

    def test_extracts_multiple_markers_in_order(self) -> None:
        text = "Foo [1] and bar [3] and [2]."
        assert extract_citation_markers(text) == [1, 3, 2]

    def test_preserves_duplicates(self) -> None:
        text = "Claim [1]. Another claim [1]. Third [2]."
        assert extract_citation_markers(text) == [1, 1, 2]

    def test_ignores_non_numeric_brackets(self) -> None:
        text = "See [ref] and [A] and [1]."
        assert extract_citation_markers(text) == [1]

    def test_no_markers_returns_empty(self) -> None:
        assert extract_citation_markers("No citations here.") == []


# ---------------------------------------------------------------------------
# verify_citations
# ---------------------------------------------------------------------------


class TestVerifyCitations:
    """verify_citations enforces the Phase 1 citation contract."""

    def test_valid_positional_case(self) -> None:
        retrieved = [_chunk("c1", 0.9), _chunk("c2", 0.8)]
        result = verify_citations(
            answer_text="The answer is grounded [1]. Also relevant [2].",
            retrieved_chunks=retrieved,
            cited_ids=[1, 2],
        )
        assert result.valid is True
        assert result.missing_markers == []
        assert result.fabricated_ids == []
        assert result.marker_ids_found == [1, 2]

    def test_detects_missing_marker_for_claimed_citation(self) -> None:
        retrieved = [_chunk("c1", 0.9), _chunk("c2", 0.8)]
        result = verify_citations(
            answer_text="Only [1] is marked.",
            retrieved_chunks=retrieved,
            cited_ids=[1, 2],  # 2 is claimed but not marked
        )
        assert result.valid is False
        assert result.missing_markers == [2]

    def test_detects_fabricated_id_by_position(self) -> None:
        retrieved = [_chunk("c1", 0.9)]
        result = verify_citations(
            answer_text="Fake cite [1] and [99].",
            retrieved_chunks=retrieved,
            cited_ids=[1, 99],  # 99 has no matching chunk
        )
        assert result.valid is False
        assert 99 in result.fabricated_ids
        assert 1 not in result.fabricated_ids

    def test_rejects_answer_with_no_markers(self) -> None:
        # Even if the citations list is empty, a factual-style answer
        # with zero markers fails the contract.
        retrieved = [_chunk("c1", 0.9)]
        result = verify_citations(
            answer_text="This answer has no citations at all.",
            retrieved_chunks=retrieved,
            cited_ids=[],
        )
        assert result.valid is False
        assert result.marker_ids_found == []

    def test_explicit_chunk_mapping_catches_fabrication(self) -> None:
        retrieved = [_chunk("c1", 0.9), _chunk("c2", 0.8)]
        mapping = {1: "c1", 2: "c-not-retrieved"}
        result = verify_citations(
            answer_text="Claim one [1]. Claim two [2].",
            retrieved_chunks=retrieved,
            cited_ids=[1, 2],
            chunk_id_by_citation=mapping,
        )
        assert result.valid is False
        assert 2 in result.fabricated_ids
        assert 1 not in result.fabricated_ids

    def test_explicit_chunk_mapping_allows_all_valid(self) -> None:
        retrieved = [_chunk("c1", 0.9), _chunk("c2", 0.8)]
        mapping = {1: "c1", 2: "c2"}
        result = verify_citations(
            answer_text="Claim [1] and [2].",
            retrieved_chunks=retrieved,
            cited_ids=[1, 2],
            chunk_id_by_citation=mapping,
        )
        assert result.valid is True

    def test_markers_without_citations_field_are_still_checked(self) -> None:
        # The generator forgot to populate citations[] but used markers.
        # These markers must still be grounded.
        retrieved = [_chunk("c1", 0.9)]
        result = verify_citations(
            answer_text="Grounded [1]. Fabricated [5].",
            retrieved_chunks=retrieved,
            cited_ids=[],
        )
        assert result.valid is False
        assert 5 in result.fabricated_ids
