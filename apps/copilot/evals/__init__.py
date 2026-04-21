"""Copilot eval harness — goldens, rubrics, regression gates, CLI.

The eval package provides a CI-runnable, reproducible quality gate
for the CSA Copilot.  It runs the agent against a fixed set of
*goldens* (YAML-authored Q&A fixtures), scores each response on
multiple rubrics (groundedness, citation accuracy, answer relevance,
refusal correctness, latency), compares the resulting report against
a committed baseline, and exits non-zero on regression.

Key entry points:

* :class:`EvalHarness` — orchestrates the run.
* :class:`RegressionGate` — compares current vs. baseline.
* :mod:`apps.copilot.evals.cli` — ``python -m apps.copilot.evals``.
* :mod:`apps.copilot.evals.rubrics` — rubric implementations.

See :doc:`README` for authoring goldens and wiring the CI gate.
"""

from __future__ import annotations

from apps.copilot.evals.harness import EvalHarness
from apps.copilot.evals.models import (
    EvalCase,
    EvalReport,
    EvalResult,
    GoldenExample,
    RegressionDecision,
    RubricScore,
    ScoreThreshold,
)
from apps.copilot.evals.regression import RegressionGate
from apps.copilot.evals.rubrics import (
    CitationAccuracyRubric,
    GroundednessRubric,
    LatencyRubric,
    RefusalCorrectnessRubric,
)
from apps.copilot.evals.scorer import DeterministicScorer, LLMJudgeScorer, Scorer

__all__ = [
    "CitationAccuracyRubric",
    "DeterministicScorer",
    "EvalCase",
    "EvalHarness",
    "EvalReport",
    "EvalResult",
    "GoldenExample",
    "GroundednessRubric",
    "LLMJudgeScorer",
    "LatencyRubric",
    "RefusalCorrectnessRubric",
    "RegressionDecision",
    "RegressionGate",
    "RubricScore",
    "ScoreThreshold",
    "Scorer",
]
