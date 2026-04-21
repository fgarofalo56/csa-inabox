"""End-to-end CLI tests for ``python -m apps.copilot.evals``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.copilot.evals.cli import main

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
