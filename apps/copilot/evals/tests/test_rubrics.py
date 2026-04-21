"""Tests for the rubric implementations."""

from __future__ import annotations

import pytest

from apps.copilot.evals.models import EvalCase, GoldenExample, ScoreThreshold
from apps.copilot.evals.rubrics import (
    AnswerRelevanceRubric,
    CitationAccuracyRubric,
    GroundednessRubric,
    LatencyRubric,
    RefusalCorrectnessRubric,
    evaluate_phrases,
)
from apps.copilot.evals.scorer import DeterministicScorer
from apps.copilot.models import AnswerResponse, Citation


def _golden(
    *,
    id_: str = "case",
    question: str = "Q?",
    expected_citations: list[str] | None = None,
    expected_phrases: list[str] | None = None,
    must_refuse: bool = False,
    thresholds: ScoreThreshold | None = None,
) -> GoldenExample:
    return GoldenExample(
        id=id_,
        question=question,
        expected_citations=expected_citations or [],
        expected_phrases=expected_phrases or [],
        must_refuse=must_refuse,
        thresholds=thresholds or ScoreThreshold(),
    )


def _case(
    golden: GoldenExample,
    max_latency_ms: int = 30_000,
) -> EvalCase:
    return EvalCase(golden=golden, max_latency_ms=max_latency_ms)


def _response(
    *,
    answer: str = "answer text [1]",
    citations: list[str] | None = None,
    groundedness: float = 0.9,
    refused: bool = False,
    refusal_reason: str | None = None,
) -> AnswerResponse:
    cites = []
    for i, src in enumerate(citations or [], start=1):
        cites.append(
            Citation(
                id=i,
                source_path=src,
                excerpt="excerpt",
                similarity=0.8,
                chunk_id=f"chunk-{i}",
            ),
        )
    return AnswerResponse(
        question="Q?",
        answer=answer,
        citations=cites,
        groundedness=groundedness,
        refused=refused,
        refusal_reason=refusal_reason,
    )


class TestGroundednessRubric:
    @pytest.mark.asyncio
    async def test_reflects_response_groundedness(self) -> None:
        rubric = GroundednessRubric()
        case = _case(
            _golden(thresholds=ScoreThreshold(groundedness=0.5)),
        )
        resp = _response(groundedness=0.82)
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == pytest.approx(0.82)
        assert score.passed is True

    @pytest.mark.asyncio
    async def test_fails_below_threshold(self) -> None:
        rubric = GroundednessRubric()
        case = _case(_golden(thresholds=ScoreThreshold(groundedness=0.9)))
        resp = _response(groundedness=0.5)
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.passed is False


class TestCitationAccuracyRubric:
    @pytest.mark.asyncio
    async def test_perfect_f1(self) -> None:
        rubric = CitationAccuracyRubric()
        case = _case(_golden(expected_citations=["docs/a.md", "docs/b.md"]))
        resp = _response(citations=["docs/a.md", "docs/b.md"])
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_partial_f1(self) -> None:
        rubric = CitationAccuracyRubric()
        case = _case(_golden(expected_citations=["docs/a.md", "docs/b.md"]))
        resp = _response(citations=["docs/a.md"])
        score = await rubric.score(case, resp, latency_ms=10.0)
        # Precision 1.0, recall 0.5 -> F1 = 2/3
        assert 0.65 < score.value < 0.68

    @pytest.mark.asyncio
    async def test_zero_when_missing_all_expected(self) -> None:
        rubric = CitationAccuracyRubric()
        case = _case(_golden(expected_citations=["docs/a.md"]))
        resp = _response(citations=["docs/other.md"])
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 0.0

    @pytest.mark.asyncio
    async def test_refusal_expected_no_citations(self) -> None:
        rubric = CitationAccuracyRubric()
        case = _case(_golden(must_refuse=True))
        resp = _response(
            answer="refused",
            citations=[],
            refused=True,
            refusal_reason="no_coverage",
        )
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 1.0

    @pytest.mark.asyncio
    async def test_refusal_expected_but_cited(self) -> None:
        rubric = CitationAccuracyRubric()
        case = _case(_golden(must_refuse=True))
        resp = _response(
            answer="I cited [1]",
            citations=["docs/a.md"],
            refused=False,
        )
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 0.0

    @pytest.mark.asyncio
    async def test_no_expected_no_citations_non_refused_fails(self) -> None:
        rubric = CitationAccuracyRubric()
        case = _case(_golden())
        resp = _response(citations=[], refused=False)
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 0.0


class TestRefusalCorrectness:
    @pytest.mark.asyncio
    async def test_correct_refusal(self) -> None:
        rubric = RefusalCorrectnessRubric()
        case = _case(_golden(must_refuse=True))
        resp = _response(refused=True, refusal_reason="no_coverage")
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 1.0
        assert score.passed is True

    @pytest.mark.asyncio
    async def test_incorrect_refusal(self) -> None:
        rubric = RefusalCorrectnessRubric()
        case = _case(_golden(must_refuse=False))
        resp = _response(refused=True, refusal_reason="no_coverage")
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 0.0

    @pytest.mark.asyncio
    async def test_correct_non_refusal(self) -> None:
        rubric = RefusalCorrectnessRubric()
        case = _case(_golden(must_refuse=False))
        resp = _response(refused=False)
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 1.0


class TestLatencyRubric:
    @pytest.mark.asyncio
    async def test_within_budget(self) -> None:
        rubric = LatencyRubric()
        case = _case(_golden(), max_latency_ms=1000)
        resp = _response()
        score = await rubric.score(case, resp, latency_ms=500)
        assert score.passed is True
        assert score.value == 500.0

    @pytest.mark.asyncio
    async def test_exceeds_budget(self) -> None:
        rubric = LatencyRubric()
        case = _case(_golden(), max_latency_ms=1000)
        resp = _response()
        score = await rubric.score(case, resp, latency_ms=5000)
        assert score.passed is False


class TestAnswerRelevance:
    @pytest.mark.asyncio
    async def test_refusal_correct_vacuously_1_0(self) -> None:
        rubric = AnswerRelevanceRubric(DeterministicScorer())
        case = _case(_golden(must_refuse=True))
        resp = _response(refused=True, refusal_reason="no_coverage")
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 1.0

    @pytest.mark.asyncio
    async def test_unexpected_refusal(self) -> None:
        rubric = AnswerRelevanceRubric(DeterministicScorer())
        case = _case(_golden(must_refuse=False))
        resp = _response(refused=True, refusal_reason="no_coverage")
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == 0.0

    @pytest.mark.asyncio
    async def test_deterministic_phrase_match(self) -> None:
        rubric = AnswerRelevanceRubric(DeterministicScorer())
        case = _case(
            _golden(expected_phrases=["Unity Catalog", "Purview"]),
        )
        resp = _response(
            answer="Use Unity Catalog and Purview together [1]",
        )
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_deterministic_phrase_miss(self) -> None:
        rubric = AnswerRelevanceRubric(DeterministicScorer())
        case = _case(
            _golden(expected_phrases=["Unity Catalog", "Purview"]),
        )
        resp = _response(answer="Use Unity Catalog only [1]")
        score = await rubric.score(case, resp, latency_ms=10.0)
        assert score.value == pytest.approx(0.5)


class TestEvaluatePhrases:
    def test_empty_phrases_is_1_0(self) -> None:
        value, reason = evaluate_phrases("hello", [])
        assert value == 1.0
        assert "vacuously" in reason

    def test_partial_hits(self) -> None:
        value, _reason = evaluate_phrases(
            "Hello Unity Catalog world", ["Unity Catalog", "Purview"],
        )
        assert value == pytest.approx(0.5)

    def test_case_insensitive(self) -> None:
        value, _reason = evaluate_phrases(
            "FULL of UNITY catalog", ["Unity Catalog"],
        )
        assert value == 1.0
