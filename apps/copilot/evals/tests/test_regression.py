"""Tests for :class:`RegressionGate`."""

from __future__ import annotations

import pytest

from apps.copilot.evals.models import (
    EvalReport,
    RubricAggregate,
)
from apps.copilot.evals.regression import RegressionGate


def _report(
    *,
    run_id: str = "r1",
    groundedness_mean: float = 0.8,
    citation_accuracy_mean: float = 0.85,
    answer_relevance_mean: float = 0.8,
    refusal_correctness_mean: float = 1.0,
    latency_p95: float = 1000.0,
) -> EvalReport:
    aggregates = [
        RubricAggregate(
            rubric="groundedness",
            mean=groundedness_mean,
            p50=groundedness_mean,
            p95=groundedness_mean,
            p99=groundedness_mean,
            count=10,
            passed=10,
            failed=0,
        ),
        RubricAggregate(
            rubric="citation_accuracy",
            mean=citation_accuracy_mean,
            p50=citation_accuracy_mean,
            p95=citation_accuracy_mean,
            p99=citation_accuracy_mean,
            count=10,
            passed=10,
            failed=0,
        ),
        RubricAggregate(
            rubric="answer_relevance",
            mean=answer_relevance_mean,
            p50=answer_relevance_mean,
            p95=answer_relevance_mean,
            p99=answer_relevance_mean,
            count=10,
            passed=10,
            failed=0,
        ),
        RubricAggregate(
            rubric="refusal_correctness",
            mean=refusal_correctness_mean,
            p50=refusal_correctness_mean,
            p95=refusal_correctness_mean,
            p99=refusal_correctness_mean,
            count=10,
            passed=10,
            failed=0,
        ),
        RubricAggregate(
            rubric="latency_p95",
            mean=latency_p95,
            p50=latency_p95 * 0.5,
            p95=latency_p95,
            p99=latency_p95 * 1.5,
            count=10,
            passed=10,
            failed=0,
        ),
    ]
    return EvalReport(
        run_id=run_id,
        goldens_source="fixtures",
        results=[],
        aggregates=aggregates,
        total_cases=10,
        passed_cases=10,
        failed_cases=0,
        error_cases=0,
    )


class TestRegressionGate:
    def test_no_delta_passes(self) -> None:
        gate = RegressionGate()
        base = _report(run_id="base")
        curr = _report(run_id="curr")
        dec = gate.compare(base, curr)
        assert dec.passed is True
        assert dec.regressions == []
        assert "PASS" in dec.message

    def test_score_regression_fails(self) -> None:
        gate = RegressionGate(max_score_regression=0.02)
        base = _report(run_id="b", groundedness_mean=0.9)
        curr = _report(run_id="c", groundedness_mean=0.8)
        dec = gate.compare(base, curr)
        assert dec.passed is False
        rubrics = {r.rubric for r in dec.regressions}
        assert "groundedness" in rubrics

    def test_small_regression_within_threshold_passes(self) -> None:
        gate = RegressionGate(max_score_regression=0.05)
        base = _report(run_id="b", groundedness_mean=0.85)
        curr = _report(run_id="c", groundedness_mean=0.82)
        dec = gate.compare(base, curr)
        assert dec.passed is True

    def test_improvement_is_informational(self) -> None:
        gate = RegressionGate(max_score_regression=0.02)
        base = _report(run_id="b", groundedness_mean=0.8)
        curr = _report(run_id="c", groundedness_mean=0.9)
        dec = gate.compare(base, curr)
        assert dec.passed is True
        assert len(dec.improvements) == 1
        assert dec.improvements[0].rubric == "groundedness"

    def test_latency_regression_detected(self) -> None:
        gate = RegressionGate(max_latency_p95_regression_pct=10.0)
        base = _report(run_id="b", latency_p95=1000.0)
        curr = _report(run_id="c", latency_p95=1200.0)  # 20% slower
        dec = gate.compare(base, curr)
        assert dec.passed is False
        kinds = {r.kind for r in dec.regressions}
        assert "latency" in kinds

    def test_latency_improvement_detected(self) -> None:
        gate = RegressionGate(max_latency_p95_regression_pct=10.0)
        base = _report(run_id="b", latency_p95=1000.0)
        curr = _report(run_id="c", latency_p95=800.0)
        dec = gate.compare(base, curr)
        assert dec.passed is True
        improvements = [i for i in dec.improvements if i.kind == "latency"]
        assert len(improvements) == 1

    def test_multiple_regressions(self) -> None:
        gate = RegressionGate()
        base = _report(
            run_id="b",
            groundedness_mean=0.9,
            citation_accuracy_mean=0.9,
        )
        curr = _report(
            run_id="c",
            groundedness_mean=0.8,
            citation_accuracy_mean=0.7,
        )
        dec = gate.compare(base, curr)
        assert dec.passed is False
        rubrics = {r.rubric for r in dec.regressions}
        assert {"groundedness", "citation_accuracy"} <= rubrics

    def test_decision_captures_run_ids(self) -> None:
        gate = RegressionGate()
        base = _report(run_id="baseline-id")
        curr = _report(run_id="current-id")
        dec = gate.compare(base, curr)
        assert dec.baseline_run_id == "baseline-id"
        assert dec.current_run_id == "current-id"

    def test_negative_threshold_rejected(self) -> None:
        with pytest.raises(ValueError, match="max_score_regression"):
            RegressionGate(max_score_regression=-0.1)
        with pytest.raises(ValueError, match="max_latency_p95_regression_pct"):
            RegressionGate(max_latency_p95_regression_pct=-1.0)

    def test_message_format_contains_values(self) -> None:
        gate = RegressionGate()
        base = _report(run_id="b", groundedness_mean=0.9)
        curr = _report(run_id="c", groundedness_mean=0.7)
        dec = gate.compare(base, curr)
        assert "FAIL" in dec.message
        assert "groundedness" in dec.message
