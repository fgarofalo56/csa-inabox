"""Tests for the scorer implementations."""

from __future__ import annotations

import pytest

from apps.copilot.evals.scorer import DeterministicScorer, LLMJudgeScorer


class TestDeterministicScorer:
    @pytest.mark.asyncio
    async def test_hit_ratio_is_deterministic(self) -> None:
        scorer = DeterministicScorer()
        v1, _r1 = await scorer.score_relevance(
            "q", "Unity Catalog and Purview",
            ["Unity Catalog", "Purview"],
        )
        v2, _r2 = await scorer.score_relevance(
            "q", "Unity Catalog and Purview",
            ["Unity Catalog", "Purview"],
        )
        assert v1 == v2 == 1.0

    @pytest.mark.asyncio
    async def test_empty_answer_scores_zero(self) -> None:
        scorer = DeterministicScorer()
        value, reason = await scorer.score_relevance("q", "", ["foo"])
        assert value == 0.0
        assert "empty" in reason

    @pytest.mark.asyncio
    async def test_no_expected_phrases_is_1_0(self) -> None:
        scorer = DeterministicScorer()
        value, _reason = await scorer.score_relevance("q", "anything", [])
        assert value == 1.0

    @pytest.mark.asyncio
    async def test_partial_match(self) -> None:
        scorer = DeterministicScorer()
        value, reason = await scorer.score_relevance(
            "q", "mentions alpha not gamma",
            ["alpha", "beta", "gamma"],
        )
        assert value == pytest.approx(2 / 3)
        assert "beta" in reason


class TestLLMJudgeScorer:
    @pytest.mark.asyncio
    async def test_returns_fallback_without_endpoint(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("COPILOT_AZURE_OPENAI_ENDPOINT", raising=False)
        scorer = LLMJudgeScorer(endpoint="")
        value, reason = await scorer.score_relevance("q", "a", [])
        assert value == 0.5
        assert "not configured" in reason

    @pytest.mark.asyncio
    async def test_returns_fallback_without_credentials(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv(
            "COPILOT_AZURE_OPENAI_ENDPOINT",
            "https://example.invalid",
        )
        monkeypatch.delenv("COPILOT_AZURE_OPENAI_API_KEY", raising=False)
        scorer = LLMJudgeScorer(endpoint="https://example.invalid")
        value, reason = await scorer.score_relevance("q", "a", [])
        assert value == 0.5
        assert "credentials" in reason.lower() or "configured" in reason.lower()
