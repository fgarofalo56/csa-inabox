"""End-to-end CLI tests for ``python -m apps.copilot.evals``."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from apps.copilot.evals import cli as cli_module
from apps.copilot.evals.cli import main
from apps.copilot.models import AnswerResponse, Citation

FIXTURE_DIR = Path(__file__).parent / "fixtures"
GOLDENS_DIR = Path(__file__).parent.parent / "goldens"


class TestCliRun:
    def test_help_exits_zero(self, capsys: pytest.CaptureFixture[str]) -> None:
        with pytest.raises(SystemExit) as exc:
            main(["--help"])
        assert exc.value.code == 0
        out = capsys.readouterr().out
        assert "run" in out
        assert "baseline" in out
        assert "gate" in out
        assert "diff" in out

    def test_dry_run_produces_report(
        self, tmp_path: Path,
    ) -> None:
        output = tmp_path / "report.json"
        rc = main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(output),
                "--dry-run",
                "--tag",
                "test",
                "--concurrency",
                "2",
            ],
        )
        assert rc == 0
        assert output.exists()
        data = json.loads(output.read_text(encoding="utf-8"))
        assert data["schema_version"] == "eval-report-v1"
        assert data["deterministic"] is True
        assert data["total_cases"] == 2
        assert data["tag"] == "test"

    def test_non_dry_run_requires_programmatic(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str],
    ) -> None:
        rc = main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(tmp_path / "report.json"),
            ],
        )
        assert rc == 2
        err = capsys.readouterr().err
        assert "programmatic" in err

    def test_bad_goldens_returns_2(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.yaml"
        bad.write_text("goldens: []\n", encoding="utf-8")
        rc = main(
            [
                "run",
                "--goldens",
                str(bad),
                "--output",
                str(tmp_path / "r.json"),
                "--dry-run",
            ],
        )
        assert rc == 2


class TestCliGate:
    @pytest.fixture
    def dry_run_report(self, tmp_path: Path) -> Path:
        output = tmp_path / "report.json"
        rc = main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(output),
                "--dry-run",
            ],
        )
        assert rc == 0
        return output

    def test_gate_passes_on_self(self, dry_run_report: Path) -> None:
        # Baseline == current => PASS.
        rc = main(
            [
                "gate",
                "--current",
                str(dry_run_report),
                "--baseline",
                str(dry_run_report),
            ],
        )
        assert rc == 0

    def test_gate_fails_on_regression(
        self, dry_run_report: Path, tmp_path: Path,
    ) -> None:
        # Build a perturbed current report (drop citation_accuracy 0.1).
        data = json.loads(dry_run_report.read_text(encoding="utf-8"))
        for agg in data["aggregates"]:
            if agg["rubric"] == "citation_accuracy":
                agg["mean"] -= 0.1
        perturbed = tmp_path / "perturbed.json"
        perturbed.write_text(json.dumps(data), encoding="utf-8")

        rc = main(
            [
                "gate",
                "--current",
                str(perturbed),
                "--baseline",
                str(dry_run_report),
            ],
        )
        assert rc == 1


class TestCliBaseline:
    def test_baseline_written(self, tmp_path: Path) -> None:
        # Produce a report.
        src = tmp_path / "src.json"
        main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(src),
                "--dry-run",
            ],
        )
        out = tmp_path / "baseline.json"
        rc = main(
            [
                "baseline",
                "--from",
                str(src),
                "--tag",
                "v0.fixture",
                "--output",
                str(out),
            ],
        )
        assert rc == 0
        assert out.exists()
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data["tag"] == "v0.fixture"


class TestCliDiff:
    def test_diff_prints_per_case(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str],
    ) -> None:
        a = tmp_path / "a.json"
        b = tmp_path / "b.json"
        main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(a),
                "--dry-run",
            ],
        )
        main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(b),
                "--dry-run",
            ],
        )
        rc = main(["diff", "--a", str(a), "--b", str(b)])
        assert rc == 0
        out = capsys.readouterr().out
        assert "Report A" in out
        assert "Report B" in out
        assert "DIFF" in out


class _FakeLiveScorer:
    """Deterministic stand-in for :class:`LLMJudgeScorer` used by tests.

    Always scores 1.0 so every rubric passes.  Records invocations so
    tests can assert the judge was actually consulted.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, list[str]]] = []

    async def score_relevance(
        self,
        question: str,
        answer: str,
        expected_phrases: list[str],
    ) -> tuple[float, str]:
        self.calls.append((question, answer, list(expected_phrases)))
        return 1.0, "fake live scorer: always 1.0"


class _FakeLiveAgent:
    """Stand-in for a live :class:`CopilotAgent`.

    Returns a grounded answer that embeds every expected phrase / cites
    every expected source path so the rubrics produced by the harness
    pass without calling Azure.
    """

    def __init__(self, goldens: Sequence[object]) -> None:
        self._by_q: dict[str, object] = {
            getattr(g, "question"): g for g in goldens  # noqa: B009
        }

    async def __call__(
        self,
        question: str,
        conversation_id: str | None = None,  # noqa: ARG002
    ) -> AnswerResponse:
        golden = self._by_q.get(question)
        if golden is None or getattr(golden, "must_refuse", False):
            return AnswerResponse(
                question=question,
                answer="Refusal — no golden.",
                citations=[],
                groundedness=0.1,
                refused=True,
                refusal_reason="no_coverage",
            )
        phrases: list[str] = list(getattr(golden, "expected_phrases", []))
        sources: list[str] = list(getattr(golden, "expected_citations", []))
        parts: list[str] = ["Live-mocked answer."]
        parts.extend(phrases)
        for idx, _ in enumerate(sources, start=1):
            parts.append(f"[{idx}]")
        answer = " ".join(parts)
        citations: list[Citation] = []
        for idx, src in enumerate(sources, start=1):
            citations.append(
                Citation(
                    id=idx,
                    source_path=src,
                    excerpt=f"Live excerpt for {src}",
                    similarity=0.95,
                    chunk_id=f"live-chunk-{idx}",
                    reranker_score=None,
                ),
            )
        if not citations:
            citations.append(
                Citation(
                    id=1,
                    source_path="docs/live.md",
                    excerpt="Placeholder",
                    similarity=0.9,
                    chunk_id="live-placeholder",
                    reranker_score=None,
                ),
            )
            answer = f"{answer} [1]"
        return AnswerResponse(
            question=question,
            answer=answer,
            citations=citations,
            groundedness=0.92,
            refused=False,
            refusal_reason=None,
        )


class TestCliLiveMode:
    def test_live_without_env_exits_with_clear_error(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Without COPILOT_EVALS_LIVE=true the CLI refuses to run --live."""
        monkeypatch.delenv("COPILOT_EVALS_LIVE", raising=False)
        monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
        rc = main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(tmp_path / "r.json"),
                "--live",
            ],
        )
        assert rc == 2
        err = capsys.readouterr().err
        assert "Live eval misconfigured" in err
        assert "COPILOT_EVALS_LIVE" in err

    def test_live_with_env_but_no_endpoint_exits_clearly(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Missing AZURE_OPENAI_ENDPOINT is reported distinctly."""
        monkeypatch.setenv("COPILOT_EVALS_LIVE", "true")
        monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
        monkeypatch.delenv("COPILOT_AZURE_OPENAI_ENDPOINT", raising=False)
        rc = main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(tmp_path / "r.json"),
                "--live",
            ],
        )
        assert rc == 2
        err = capsys.readouterr().err
        assert "AZURE_OPENAI_ENDPOINT" in err

    def test_live_mode_with_mocked_scorer_and_agent_completes(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Live mode runs end-to-end when fakes are injected.

        We set the env gates, inject a fake scorer + fake agent (so no
        Azure call is made), and assert the CLI produces a report.
        """
        monkeypatch.setenv("COPILOT_EVALS_LIVE", "true")
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.invalid")

        from apps.copilot.evals.harness import EvalHarness

        goldens = EvalHarness.load_goldens(FIXTURE_DIR / "sample_goldens.yaml")

        fake_scorer = _FakeLiveScorer()
        fake_agent = _FakeLiveAgent(goldens)
        cli_module._set_live_scorer_override(fake_scorer)
        cli_module._set_live_agent_override(fake_agent)
        try:
            output = tmp_path / "live.json"
            rc = main(
                [
                    "run",
                    "--goldens",
                    str(FIXTURE_DIR / "sample_goldens.yaml"),
                    "--output",
                    str(output),
                    "--live",
                    "--tag",
                    "live-mock",
                ],
            )
        finally:
            cli_module._set_live_scorer_override(None)
            cli_module._set_live_agent_override(None)

        assert rc == 0, capsys.readouterr().err
        assert output.exists()
        data = json.loads(output.read_text(encoding="utf-8"))
        assert data["deterministic"] is False
        assert data["tag"] == "live-mock"
        assert data["total_cases"] == 2
        err = capsys.readouterr().err
        # The warning line must be emitted in live mode.
        assert "--live mode calls Azure" in err

    def test_live_and_dry_run_are_mutually_exclusive(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Supplying both flags is a configuration error."""
        monkeypatch.setenv("COPILOT_EVALS_LIVE", "true")
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.invalid")
        rc = main(
            [
                "run",
                "--goldens",
                str(FIXTURE_DIR / "sample_goldens.yaml"),
                "--output",
                str(tmp_path / "r.json"),
                "--dry-run",
                "--live",
            ],
        )
        assert rc == 2
        err = capsys.readouterr().err
        assert "mutually exclusive" in err


class TestCliWithShippedBaseline:
    def test_shipped_baseline_exists(self) -> None:
        baseline = (
            Path(__file__).parent.parent / "baselines" / "baseline_v0.1.0.json"
        )
        assert baseline.exists(), "shipped baseline missing; run baseline subcommand"

    def test_gate_against_shipped_baseline(
        self, tmp_path: Path,
    ) -> None:
        """Dry-run vs. the shipped baseline should pass.

        The baseline was captured from the DryRunAgent itself, so a
        current dry-run against the same goldens should be regression-
        free.
        """
        output = tmp_path / "current.json"
        rc = main(
            [
                "run",
                "--goldens",
                str(GOLDENS_DIR / "corpus_qa.yaml"),
                "--output",
                str(output),
                "--dry-run",
            ],
        )
        assert rc == 0
        baseline = (
            Path(__file__).parent.parent / "baselines" / "baseline_v0.1.0.json"
        )
        rc = main(
            [
                "gate",
                "--current",
                str(output),
                "--baseline",
                str(baseline),
            ],
        )
        assert rc == 0
