"""Rubric implementations for the eval harness.

Each rubric is a small class implementing the :class:`Rubric`
protocol.  The harness calls :meth:`Rubric.score` once per case and
appends the returned :class:`RubricScore` to the case's
:class:`EvalResult`.

Four rubrics are deterministic (pure Python, no LLM):

* :class:`GroundednessRubric`
* :class:`CitationAccuracyRubric`
* :class:`RefusalCorrectnessRubric`
* :class:`LatencyRubric`

One rubric — :class:`AnswerRelevanceRubric` — uses an injected
:class:`Scorer` so production deployments can plug an LLM-as-judge
and tests can inject a deterministic stub.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from apps.copilot.evals.models import (
    EvalCase,
    GoldenExample,
    RubricName,
    RubricScore,
)
from apps.copilot.evals.scorer import Scorer
from apps.copilot.models import AnswerResponse


@runtime_checkable
class Rubric(Protocol):
    """Protocol every rubric implements.

    ``score`` is async so LLM-backed rubrics can do I/O.  Purely
    deterministic rubrics implement the same signature and simply
    ``return`` immediately.
    """

    name: RubricName

    async def score(
        self,
        case: EvalCase,
        response: AnswerResponse,
        latency_ms: float,
    ) -> RubricScore: ...


# ---------------------------------------------------------------------------
# Deterministic rubrics
# ---------------------------------------------------------------------------


def _evaluate_threshold(value: float, threshold: float | None) -> bool:
    """Return True when ``value`` meets ``threshold`` (or no threshold)."""
    if threshold is None:
        return True
    return value >= threshold


class GroundednessRubric:
    """Score = :attr:`AnswerResponse.groundedness`.

    A refused answer retains its computed groundedness (``max_similarity``
    of the retrieved set), which lets the rubric distinguish a refusal
    caused by genuinely low coverage from a refusal caused by
    citation-verification failure despite strong coverage.
    """

    name: RubricName = "groundedness"

    async def score(
        self,
        case: EvalCase,
        response: AnswerResponse,
        latency_ms: float,  # noqa: ARG002
    ) -> RubricScore:
        value = float(response.groundedness)
        threshold = case.golden.thresholds.groundedness
        passed = _evaluate_threshold(value, threshold)
        reason = (
            f"groundedness={value:.3f}"
            + (f" >= threshold={threshold:.3f}" if threshold is not None else "")
        )
        return RubricScore(
            rubric=self.name,
            value=value,
            reason=reason,
            threshold=threshold,
            passed=passed,
        )


class CitationAccuracyRubric:
    """F1 of the set of source paths cited vs. golden ``expected_citations``.

    * precision = |cited ∩ expected| / |cited|
    * recall    = |cited ∩ expected| / |expected|
    * F1        = 2 * P * R / (P + R)

    When the golden has no expected citations, the rubric returns 1.0
    (nothing to compare against) unless the response itself cited
    nothing despite being non-refused — in that case the score is 0
    because a grounded answer must surface at least one citation.
    """

    name: RubricName = "citation_accuracy"

    async def score(
        self,
        case: EvalCase,
        response: AnswerResponse,
        latency_ms: float,  # noqa: ARG002
    ) -> RubricScore:
        expected = set(case.golden.expected_citations)
        cited = {c.source_path for c in response.citations}

        threshold = case.golden.thresholds.citation_accuracy

        # Special case: refusal-expected with no citations expected.
        if case.golden.must_refuse and not expected:
            value = 1.0 if not cited else 0.0
            passed = _evaluate_threshold(value, threshold)
            return RubricScore(
                rubric=self.name,
                value=value,
                reason=(
                    "refusal-expected: "
                    + ("no citations emitted (correct)" if not cited else "emitted citations on a refusal")
                ),
                threshold=threshold,
                passed=passed,
            )

        if not expected:
            value = 1.0 if (cited or response.refused) else 0.0
            passed = _evaluate_threshold(value, threshold)
            return RubricScore(
                rubric=self.name,
                value=value,
                reason=(
                    "no expected citations; "
                    + ("answer cited at least one chunk" if cited else
                       "refusal tolerated" if response.refused else
                       "no citations produced")
                ),
                threshold=threshold,
                passed=passed,
            )

        if not cited:
            value = 0.0
            passed = _evaluate_threshold(value, threshold)
            return RubricScore(
                rubric=self.name,
                value=value,
                reason=(
                    "no citations emitted while "
                    f"expected={sorted(expected)}"
                ),
                threshold=threshold,
                passed=passed,
            )

        tp = len(cited & expected)
        precision = tp / len(cited) if cited else 0.0
        recall = tp / len(expected) if expected else 0.0
        if precision + recall == 0:
            f1 = 0.0
        else:
            f1 = 2 * precision * recall / (precision + recall)

        passed = _evaluate_threshold(f1, threshold)
        return RubricScore(
            rubric=self.name,
            value=f1,
            reason=(
                f"tp={tp} precision={precision:.2f} recall={recall:.2f} "
                f"expected={sorted(expected)} cited={sorted(cited)}"
            ),
            threshold=threshold,
            passed=passed,
        )


class RefusalCorrectnessRubric:
    """1.0 when ``response.refused == golden.must_refuse``.

    For non-refusal goldens (``must_refuse=False``), a correct
    response has ``refused=False``.  For refusal goldens, a correct
    response has ``refused=True``.  Either way the score is binary
    because there is no middle ground — the agent either refused when
    it should have or it did not.
    """

    name: RubricName = "refusal_correctness"

    async def score(
        self,
        case: EvalCase,
        response: AnswerResponse,
        latency_ms: float,  # noqa: ARG002
    ) -> RubricScore:
        expected_refuse = case.golden.must_refuse
        actual_refuse = response.refused
        value = 1.0 if expected_refuse == actual_refuse else 0.0
        threshold = case.golden.thresholds.refusal_correctness
        passed = _evaluate_threshold(value, threshold)
        reason = (
            f"expected_refuse={expected_refuse} actual_refuse={actual_refuse}"
        )
        if expected_refuse != actual_refuse:
            reason += f" refusal_reason={response.refusal_reason!r}"
        return RubricScore(
            rubric=self.name,
            value=value,
            reason=reason,
            threshold=threshold,
            passed=passed,
        )


class LatencyRubric:
    """Records the per-case latency in milliseconds.

    This rubric's ``value`` is the raw latency (NOT a 0-1 score). The
    regression gate compares the aggregate P95/P99 across the run.
    The per-case threshold (if any) is ``max_latency_ms`` on the
    :class:`EvalCase` — the rubric fails the case when exceeded.
    """

    name: RubricName = "latency_p50"  # Used as per-case proxy; aggregates compute p50/p95/p99.

    async def score(
        self,
        case: EvalCase,
        response: AnswerResponse,  # noqa: ARG002
        latency_ms: float,
    ) -> RubricScore:
        threshold = float(case.max_latency_ms)
        passed = latency_ms <= threshold
        return RubricScore(
            rubric=self.name,
            value=float(latency_ms),
            reason=f"latency_ms={latency_ms:.1f} budget={threshold:.1f}",
            threshold=threshold,
            passed=passed,
        )


# ---------------------------------------------------------------------------
# LLM-as-judge rubric (injectable)
# ---------------------------------------------------------------------------


class AnswerRelevanceRubric:
    """LLM-as-judge rubric: "does the answer address the question?"

    Real production deployments inject an :class:`LLMJudgeScorer`.
    Tests (and the ``--dry-run`` CI path) inject a
    :class:`DeterministicScorer` which applies a trivial heuristic
    (phrase match) so the rubric remains deterministic without real
    LLM calls.
    """

    name: RubricName = "answer_relevance"

    def __init__(self, scorer: Scorer) -> None:
        self.scorer = scorer

    async def score(
        self,
        case: EvalCase,
        response: AnswerResponse,
        latency_ms: float,  # noqa: ARG002
    ) -> RubricScore:
        threshold = case.golden.thresholds.answer_relevance
        if response.refused and case.golden.must_refuse:
            # Correct refusal — relevance is vacuously 1.0.
            return RubricScore(
                rubric=self.name,
                value=1.0,
                reason="refusal-correct: relevance vacuously 1.0",
                threshold=threshold,
                passed=True,
            )
        if response.refused and not case.golden.must_refuse:
            return RubricScore(
                rubric=self.name,
                value=0.0,
                reason="unexpected refusal",
                threshold=threshold,
                passed=_evaluate_threshold(0.0, threshold),
            )

        value, reason = await self.scorer.score_relevance(
            question=case.golden.question,
            answer=response.answer,
            expected_phrases=list(case.golden.expected_phrases),
        )
        value = max(0.0, min(1.0, float(value)))
        passed = _evaluate_threshold(value, threshold)
        return RubricScore(
            rubric=self.name,
            value=value,
            reason=reason,
            threshold=threshold,
            passed=passed,
        )


# ---------------------------------------------------------------------------
# Registry helper
# ---------------------------------------------------------------------------


def default_rubrics(scorer: Scorer) -> list[Rubric]:
    """Return the canonical rubric set used by the harness.

    Callers may append custom rubrics but should treat this list as
    the stable production default.
    """
    return [
        GroundednessRubric(),
        CitationAccuracyRubric(),
        AnswerRelevanceRubric(scorer),
        RefusalCorrectnessRubric(),
        LatencyRubric(),
    ]


def evaluate_phrases(
    answer_text: str,
    expected_phrases: list[str],
) -> tuple[float, str]:
    """Deterministic phrase-match scoring helper.

    Returns ``(score, reason)`` where ``score`` is the fraction of
    expected phrases that appear (case-insensitively) in the answer.
    Used by the deterministic scorer as a stand-in for LLM-as-judge
    so CI runs are reproducible.
    """
    if not expected_phrases:
        return 1.0, "no expected phrases; vacuously 1.0"
    lowered = answer_text.lower()
    hits = sum(1 for p in expected_phrases if p.lower() in lowered)
    ratio = hits / len(expected_phrases)
    missing = [p for p in expected_phrases if p.lower() not in lowered]
    return ratio, f"hits={hits}/{len(expected_phrases)} missing={missing}"


def _noop_reference(_: GoldenExample) -> None:
    """Ensure ``GoldenExample`` import is retained for forward-ref docs."""


__all__ = [
    "AnswerRelevanceRubric",
    "CitationAccuracyRubric",
    "GroundednessRubric",
    "LatencyRubric",
    "RefusalCorrectnessRubric",
    "Rubric",
    "default_rubrics",
    "evaluate_phrases",
]
