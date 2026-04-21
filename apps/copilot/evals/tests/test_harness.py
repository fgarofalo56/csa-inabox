"""Tests for the :class:`EvalHarness`."""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.copilot.evals import EvalHarness
from apps.copilot.evals.harness import DryRunAgent
from apps.copilot.evals.models import GoldenExample, ScoreThreshold
from apps.copilot.models import AnswerResponse

FIXTURE_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def sample_goldens() -> list[GoldenExample]:
    return EvalHarness.load_goldens(FIXTURE_DIR / "sample_goldens.yaml")


class TestLoadGoldens:
    def test_loads_fixture_file(self, sample_goldens: list[GoldenExample]) -> None:
        assert len(sample_goldens) == 2
        ids = {g.id for g in sample_goldens}
        assert ids == {"smoke-grounded", "smoke-refusal"}

    def test_missing_file_raises(self) -> None:
        from apps.copilot.evals.goldens_schema import GoldenSchemaError

        with pytest.raises(GoldenSchemaError, match="does not exist"):
            EvalHarness.load_goldens(FIXTURE_DIR / "nope.yaml")


class TestDryRunAgent:
    @pytest.mark.asyncio
    async def test_dry_run_grounded_response(self) -> None:
        golden = GoldenExample(
            id="x",
            question="Q?",
            expected_citations=["docs/x.md"],
            expected_phrases=["foo"],
            must_refuse=False,
        )
        agent = DryRunAgent({"Q?": golden})
        resp = await agent("Q?")
        assert isinstance(resp, AnswerResponse)
        assert resp.refused is False
        assert len(resp.citations) == 1
        assert resp.citations[0].source_path == "docs/x.md"
        assert "foo" in resp.answer

    @pytest.mark.asyncio
    async def test_dry_run_refusal_response(self) -> None:
        golden = GoldenExample(
            id="r",
            question="off-topic",
            must_refuse=True,
        )
        agent = DryRunAgent({"off-topic": golden})
        resp = await agent("off-topic")
        assert resp.refused is True
        assert resp.refusal_reason == "no_coverage"
        assert resp.citations == []

    @pytest.mark.asyncio
    async def test_dry_run_unknown_question(self) -> None:
        agent = DryRunAgent({})
        resp = await agent("unknown")
        assert resp.refused is True
        assert resp.refusal_reason == "unknown_question"


class TestEvalHarnessRun:
    @pytest.mark.asyncio
    async def test_run_on_sample_goldens(
        self, sample_goldens: list[GoldenExample],
    ) -> None:
        harness = EvalHarness.dry_run_from_goldens(
            sample_goldens, concurrency=2,
        )
        report = await harness.run(
            sample_goldens, goldens_source="fixtures/sample_goldens.yaml",
        )
        assert report.total_cases == 2
        assert report.passed_cases == 2
        assert report.error_cases == 0
        # Aggregates should cover all rubrics.
        rubrics = {a.rubric for a in report.aggregates}
        assert "groundedness" in rubrics
        assert "citation_accuracy" in rubrics
        assert "refusal_correctness" in rubrics
        assert "answer_relevance" in rubrics
        assert "latency_p95" in rubrics

    @pytest.mark.asyncio
    async def test_prompt_hashes_captured(
        self, sample_goldens: list[GoldenExample],
    ) -> None:
        harness = EvalHarness.dry_run_from_goldens(sample_goldens)
        report = await harness.run(sample_goldens)
        assert "ground_and_cite" in report.prompt_hashes
        assert "refusal_off_scope" in report.prompt_hashes
        # Hashes should be full-length sha256 hex.
        for h in report.prompt_hashes.values():
            assert len(h) == 64

    @pytest.mark.asyncio
    async def test_run_emits_result_per_case(
        self, sample_goldens: list[GoldenExample],
    ) -> None:
        harness = EvalHarness.dry_run_from_goldens(sample_goldens)
        report = await harness.run(sample_goldens)
        result_ids = {r.case_id for r in report.results}
        assert result_ids == {g.id for g in sample_goldens}
        for r in report.results:
            assert r.error is None
            # Each result has a score per rubric.
            rubrics = {s.rubric for s in r.scores}
            assert len(rubrics) >= 5

    @pytest.mark.asyncio
    async def test_deterministic_mode_forces_deterministic_scorer(
        self, sample_goldens: list[GoldenExample], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("COPILOT_EVALS_DETERMINISTIC", "true")
        harness = EvalHarness.dry_run_from_goldens(sample_goldens)
        report = await harness.run(sample_goldens)
        assert report.deterministic is True

    @pytest.mark.asyncio
    async def test_concurrency_must_be_positive(self) -> None:
        with pytest.raises(ValueError, match="concurrency must be"):
            EvalHarness(
                agent=DryRunAgent({}),
                concurrency=0,
            )

    @pytest.mark.asyncio
    async def test_agent_exception_captured_in_result(self) -> None:
        class ExplodingAgent:
            async def __call__(
                self,
                question: str,  # noqa: ARG002
                conversation_id: str | None = None,  # noqa: ARG002
            ) -> AnswerResponse:
                raise RuntimeError("boom")

        golden = GoldenExample(id="boom", question="Q?")
        harness = EvalHarness(agent=ExplodingAgent(), deterministic=True)
        report = await harness.run([golden])
        assert report.error_cases == 1
        assert report.results[0].error is not None
        assert "boom" in report.results[0].error


class TestThresholdFailure:
    @pytest.mark.asyncio
    async def test_case_fails_when_threshold_not_met(self) -> None:
        # Build a golden with impossibly high groundedness threshold —
        # DryRunAgent emits 0.9 so 0.95 threshold fails.
        golden = GoldenExample(
            id="too-strict",
            question="Q?",
            expected_citations=["docs/x.md"],
            expected_phrases=["X"],
            thresholds=ScoreThreshold(groundedness=0.95),
        )
        harness = EvalHarness.dry_run_from_goldens([golden])
        report = await harness.run([golden])
        assert report.failed_cases == 1
        assert report.results[0].passed is False
