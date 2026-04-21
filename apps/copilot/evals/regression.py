"""Regression gate — compares a current :class:`EvalReport` against a baseline.

The gate raises a single :class:`RegressionDecision` that:

* ``passed`` — False when any watched rubric dropped by more than the
  configured threshold.
* ``regressions`` — list of :class:`Regression` entries (per-rubric,
  optionally per-case for answer-relevance drops).
* ``improvements`` — informational list of :class:`Improvement`
  entries.
* ``message`` — human-readable summary printed by the CLI.

Thresholds:

* ``max_score_regression`` — absolute drop in mean for each score
  rubric (default 0.02 = 2 percentage points).
* ``max_latency_p95_regression_pct`` — relative increase in P95
  latency (default 10.0 = 10%).

Only rubrics present in BOTH reports are compared.  New rubrics in
the current report produce an informational note, removed rubrics
likewise.
"""

from __future__ import annotations

from apps.copilot.evals.models import (
    EvalReport,
    Improvement,
    Regression,
    RegressionDecision,
    RubricName,
)

# Score rubrics whose mean is watched by the gate.
_SCORE_RUBRICS: tuple[RubricName, ...] = (
    "groundedness",
    "citation_accuracy",
    "answer_relevance",
    "refusal_correctness",
)


class RegressionGate:
    """Compares :class:`EvalReport` instances for regressions."""

    def __init__(
        self,
        *,
        max_score_regression: float = 0.02,
        max_latency_p95_regression_pct: float = 10.0,
    ) -> None:
        if max_score_regression < 0:
            raise ValueError("max_score_regression must be non-negative")
        if max_latency_p95_regression_pct < 0:
            raise ValueError("max_latency_p95_regression_pct must be non-negative")
        self.max_score_regression = max_score_regression
        self.max_latency_p95_regression_pct = max_latency_p95_regression_pct

    def compare(
        self,
        baseline: EvalReport,
        current: EvalReport,
    ) -> RegressionDecision:
        """Return the :class:`RegressionDecision` for this comparison."""
        regressions: list[Regression] = []
        improvements: list[Improvement] = []

        # -- score rubrics (mean delta) ----------------------------------
        for rubric in _SCORE_RUBRICS:
            base_agg = baseline.aggregate_for(rubric)
            curr_agg = current.aggregate_for(rubric)
            if base_agg is None or curr_agg is None:
                continue
            delta = curr_agg.mean - base_agg.mean
            if delta < -self.max_score_regression:
                regressions.append(
                    Regression(
                        rubric=rubric,
                        baseline_value=base_agg.mean,
                        current_value=curr_agg.mean,
                        delta=delta,
                        threshold=-self.max_score_regression,
                        kind="score",
                    ),
                )
            elif delta > self.max_score_regression:
                improvements.append(
                    Improvement(
                        rubric=rubric,
                        baseline_value=base_agg.mean,
                        current_value=curr_agg.mean,
                        delta=delta,
                        kind="score",
                    ),
                )

        # -- latency (P95 pct change) ------------------------------------
        base_latency = baseline.aggregate_for("latency_p95")
        curr_latency = current.aggregate_for("latency_p95")
        if base_latency is not None and curr_latency is not None:
            base_p95 = base_latency.p95
            curr_p95 = curr_latency.p95
            if base_p95 <= 0:
                # Guard against degenerate baselines — skip.
                pct_change = 0.0
            else:
                pct_change = (curr_p95 - base_p95) / base_p95 * 100.0
            if pct_change > self.max_latency_p95_regression_pct:
                regressions.append(
                    Regression(
                        rubric="latency_p95",
                        baseline_value=base_p95,
                        current_value=curr_p95,
                        delta=pct_change,
                        threshold=self.max_latency_p95_regression_pct,
                        kind="latency",
                    ),
                )
            elif pct_change < -self.max_latency_p95_regression_pct:
                improvements.append(
                    Improvement(
                        rubric="latency_p95",
                        baseline_value=base_p95,
                        current_value=curr_p95,
                        delta=pct_change,
                        kind="latency",
                    ),
                )

        passed = not regressions
        message = self._build_message(
            passed=passed,
            regressions=regressions,
            improvements=improvements,
        )
        return RegressionDecision(
            passed=passed,
            regressions=regressions,
            improvements=improvements,
            message=message,
            max_score_regression=self.max_score_regression,
            max_latency_p95_regression_pct=self.max_latency_p95_regression_pct,
            baseline_run_id=baseline.run_id,
            current_run_id=current.run_id,
        )

    @staticmethod
    def _build_message(
        *,
        passed: bool,
        regressions: list[Regression],
        improvements: list[Improvement],
    ) -> str:
        lines: list[str] = []
        verdict = "PASS" if passed else "FAIL"
        lines.append(f"[{verdict}] Regression gate")
        if regressions:
            lines.append(f"  Regressions ({len(regressions)}):")
            for r in regressions:
                if r.kind == "latency":
                    lines.append(
                        f"    - {r.rubric}: {r.baseline_value:.1f} -> "
                        f"{r.current_value:.1f} (+{r.delta:.1f}% vs threshold "
                        f"{r.threshold:.1f}%)",
                    )
                else:
                    lines.append(
                        f"    - {r.rubric}: {r.baseline_value:.3f} -> "
                        f"{r.current_value:.3f} (delta {r.delta:+.3f})",
                    )
        if improvements:
            lines.append(f"  Improvements ({len(improvements)}):")
            for imp in improvements:
                if imp.kind == "latency":
                    lines.append(
                        f"    + {imp.rubric}: {imp.baseline_value:.1f} -> "
                        f"{imp.current_value:.1f} ({imp.delta:+.1f}%)",
                    )
                else:
                    lines.append(
                        f"    + {imp.rubric}: {imp.baseline_value:.3f} -> "
                        f"{imp.current_value:.3f} (delta {imp.delta:+.3f})",
                    )
        if not regressions and not improvements:
            lines.append("  No meaningful deltas vs. baseline.")
        return "\n".join(lines)


__all__ = ["RegressionGate"]
