"""Frozen DTOs for the Copilot eval harness.

Every type in this module is a frozen Pydantic :class:`BaseModel` so
reports are safe to serialise, hash, pass across async boundaries,
and use as dict keys.

The canonical report shape is :class:`EvalReport` — it is the wire
format written to ``evals_out/*.json`` and read by the regression
gate.  Additive schema evolution is allowed; breaking changes bump
the ``schema_version`` field so baselines refuse to compare against
incompatible reports.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SCHEMA_VERSION: Literal["eval-report-v1"] = "eval-report-v1"
"""Wire-format identifier for :class:`EvalReport`.

Bumped whenever a breaking schema change lands (e.g. required new
fields). Callers compare before deserialising to detect incompatible
baselines.
"""


# Canonical rubric names.  Adding a new rubric requires registering it
# in :mod:`apps.copilot.evals.rubrics` and updating the harness.
RubricName = Literal[
    "groundedness",
    "citation_accuracy",
    "answer_relevance",
    "refusal_correctness",
    "latency_p95",
    "latency_p50",
    "latency_p99",
]


# ---------------------------------------------------------------------------
# Goldens (author-facing YAML shape)
# ---------------------------------------------------------------------------


class ScoreThreshold(BaseModel):
    """Per-rubric threshold declared in a golden example.

    A value of ``None`` means "not applicable to this case" (e.g.
    refusal_correctness on a refusal-expected case IS applicable; on
    a grounded case it is not).
    """

    groundedness: float | None = Field(default=None, ge=0.0, le=1.0)
    citation_accuracy: float | None = Field(default=None, ge=0.0, le=1.0)
    answer_relevance: float | None = Field(default=None, ge=0.0, le=1.0)
    refusal_correctness: float | None = Field(default=None, ge=0.0, le=1.0)

    model_config = ConfigDict(frozen=True, extra="forbid")


class GoldenExample(BaseModel):
    """A single golden Q&A authored in YAML.

    The harness materialises each golden into an :class:`EvalCase`
    (passing through the skill id and runtime config).
    """

    id: str = Field(min_length=1)
    question: str = Field(min_length=1)
    skill: str = Field(default="grounded-corpus-qa", min_length=1)
    conversation_id: str | None = Field(default=None)
    expected_citations: list[str] = Field(default_factory=list)
    expected_phrases: list[str] = Field(default_factory=list)
    must_refuse: bool = Field(default=False)
    thresholds: ScoreThreshold = Field(default_factory=ScoreThreshold)
    tags: list[str] = Field(default_factory=list)

    model_config = ConfigDict(frozen=True, extra="forbid")

    @field_validator("expected_citations", mode="after")
    @classmethod
    def _no_empty_citations(cls, v: list[str]) -> list[str]:
        if any(not c.strip() for c in v):
            raise ValueError("expected_citations must not contain empty strings")
        return v


class EvalCase(BaseModel):
    """A :class:`GoldenExample` bound to the harness runtime config.

    Created internally by the harness.  Tests may construct these
    directly to bypass YAML loading.
    """

    golden: GoldenExample
    max_latency_ms: int = Field(default=30_000, ge=1)

    model_config = ConfigDict(frozen=True)


# ---------------------------------------------------------------------------
# Scores + results
# ---------------------------------------------------------------------------


class RubricScore(BaseModel):
    """Outcome of scoring one rubric against one response.

    ``value`` is in ``[0.0, 1.0]`` inclusive for score rubrics; for
    latency rubrics the value is the raw milliseconds (unbounded)
    and the threshold comparison is handled by the regression gate.
    """

    rubric: RubricName = Field(description="Canonical rubric name.")
    value: float = Field(description="Score value. See rubric docs for semantics.")
    reason: str = Field(
        default="",
        description="Short human-readable explanation for triage.",
    )
    threshold: float | None = Field(
        default=None,
        description="Per-case threshold, if the golden specified one.",
    )
    passed: bool = Field(
        default=True,
        description="True when value met the threshold (or no threshold given).",
    )

    model_config = ConfigDict(frozen=True, extra="forbid")


class EvalResult(BaseModel):
    """Outcome of running one :class:`EvalCase`.

    Contains the measured latency, the per-rubric scores, the
    refusal state, and a short excerpt of the produced answer for
    triage.  The full answer is not included to keep report size
    bounded for CI artifacts.
    """

    case_id: str = Field(min_length=1)
    skill: str = Field(min_length=1)
    latency_ms: float = Field(ge=0.0)
    refused: bool = Field(default=False)
    refusal_reason: str | None = Field(default=None)
    groundedness: float = Field(ge=0.0, le=1.0)
    answer_excerpt: str = Field(default="")
    citations: list[str] = Field(
        default_factory=list,
        description="Source paths surfaced in the response's citations.",
    )
    scores: list[RubricScore] = Field(default_factory=list)
    passed: bool = Field(
        default=True,
        description="True when every rubric passed its per-case threshold.",
    )
    error: str | None = Field(
        default=None,
        description="Short error summary when the case failed to execute.",
    )

    model_config = ConfigDict(frozen=True)

    def score_for(self, rubric: RubricName) -> RubricScore | None:
        """Return the :class:`RubricScore` for *rubric*, or ``None``."""
        for s in self.scores:
            if s.rubric == rubric:
                return s
        return None


# ---------------------------------------------------------------------------
# Report aggregate
# ---------------------------------------------------------------------------


class RubricAggregate(BaseModel):
    """Aggregate stats for one rubric across all cases in a report."""

    rubric: RubricName
    mean: float = Field(ge=0.0)
    p50: float = Field(ge=0.0)
    p95: float = Field(ge=0.0)
    p99: float = Field(ge=0.0)
    count: int = Field(ge=0)
    passed: int = Field(ge=0)
    failed: int = Field(ge=0)

    model_config = ConfigDict(frozen=True)


class EvalReport(BaseModel):
    """Top-level container written to ``evals_out/*.json``.

    Compatible with :func:`json.dumps(report.model_dump())` — the
    frozen config is consistent with Pydantic v2 serialisation.
    """

    schema_version: Literal["eval-report-v1"] = Field(default=SCHEMA_VERSION)
    run_id: str = Field(min_length=1, description="UUID-like id for this run.")
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    tag: str | None = Field(default=None, description="Optional label (e.g. 'v0.1.0').")
    goldens_source: str = Field(description="Path / label describing the golden set.")
    prompt_hashes: dict[str, str] = Field(
        default_factory=dict,
        description="Snapshot of prompt id -> content_hash in effect for this run.",
    )
    deterministic: bool = Field(
        default=True,
        description="True when the run used the deterministic scorer stub.",
    )
    results: list[EvalResult] = Field(default_factory=list)
    aggregates: list[RubricAggregate] = Field(default_factory=list)
    total_cases: int = Field(ge=0)
    passed_cases: int = Field(ge=0)
    failed_cases: int = Field(ge=0)
    error_cases: int = Field(ge=0)

    model_config = ConfigDict(frozen=True)

    def aggregate_for(self, rubric: RubricName) -> RubricAggregate | None:
        for agg in self.aggregates:
            if agg.rubric == rubric:
                return agg
        return None

    @classmethod
    def from_json_dict(cls, data: dict[str, Any]) -> EvalReport:
        """Construct from a decoded JSON dict, with schema-version check."""
        schema = data.get("schema_version")
        if schema != SCHEMA_VERSION:
            raise ValueError(
                f"Incompatible report schema: got {schema!r}, expected {SCHEMA_VERSION!r}. "
                "Regenerate the baseline with the current harness.",
            )
        return cls.model_validate(data)


# ---------------------------------------------------------------------------
# Regression gate
# ---------------------------------------------------------------------------


class Regression(BaseModel):
    """One regression detected by the gate."""

    rubric: RubricName
    baseline_value: float
    current_value: float
    delta: float
    threshold: float = Field(description="Max tolerated delta (negative number).")
    case_id: str | None = Field(default=None, description="Per-case regressions carry an id.")
    kind: Literal["score", "latency"] = Field(default="score")

    model_config = ConfigDict(frozen=True)


class Improvement(BaseModel):
    """One improvement detected by the gate (informational)."""

    rubric: RubricName
    baseline_value: float
    current_value: float
    delta: float
    case_id: str | None = Field(default=None)
    kind: Literal["score", "latency"] = Field(default="score")

    model_config = ConfigDict(frozen=True)


class RegressionDecision(BaseModel):
    """Final verdict from :class:`RegressionGate`.

    Consumed by the CLI gate sub-command and by CI integration tests.
    ``passed`` False yields a non-zero exit code.
    """

    passed: bool
    regressions: list[Regression] = Field(default_factory=list)
    improvements: list[Improvement] = Field(default_factory=list)
    message: str = Field(default="")
    max_score_regression: float = Field(default=0.02)
    max_latency_p95_regression_pct: float = Field(default=10.0)
    baseline_run_id: str | None = Field(default=None)
    current_run_id: str | None = Field(default=None)

    model_config = ConfigDict(frozen=True)


__all__ = [
    "SCHEMA_VERSION",
    "EvalCase",
    "EvalReport",
    "EvalResult",
    "GoldenExample",
    "Improvement",
    "Regression",
    "RegressionDecision",
    "RubricAggregate",
    "RubricName",
    "RubricScore",
    "ScoreThreshold",
]
