"""Eval harness orchestrator.

The harness:

1. Loads a set of goldens (YAML) into :class:`EvalCase` objects.
2. Runs each case through an agent (via :class:`AgentCallable`),
   enforcing a per-case concurrency limit.
3. Scores each response with the configured :class:`Rubric` list.
4. Aggregates the results into an :class:`EvalReport` (P50/P95/P99
   for latency, mean/pass-count for score rubrics).
5. Emits OTel spans so runs can be inspected in a tracing backend.

The agent is passed in as an ``AgentCallable`` — a simple protocol
taking ``question + conversation_id`` and returning an
:class:`AnswerResponse`.  This keeps the harness decoupled from the
concrete :class:`CopilotAgent` (which would require Azure
credentials) and lets tests inject a deterministic stub.

``COPILOT_EVALS_DETERMINISTIC=true`` force-selects the
:class:`DeterministicScorer` so CI runs never attempt real LLM calls
regardless of caller intent.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from collections.abc import Iterable
from pathlib import Path
from statistics import median
from typing import Any, Protocol

from apps.copilot.evals.goldens_schema import (
    validate_goldens_file,
)
from apps.copilot.evals.models import (
    EvalCase,
    EvalReport,
    EvalResult,
    GoldenExample,
    RubricAggregate,
    RubricName,
)
from apps.copilot.evals.rubrics import Rubric, default_rubrics
from apps.copilot.evals.scorer import DeterministicScorer, Scorer
from apps.copilot.models import AnswerResponse
from apps.copilot.prompts import PromptRegistry, default_registry
from apps.copilot.telemetry import SpanAttribute, copilot_span
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


class AgentCallable(Protocol):
    """Minimal interface the harness needs from an agent.

    Production deployments adapt :class:`CopilotAgent.ask` /
    :class:`CopilotAgent.ask_in_conversation` to match this signature.
    """

    async def __call__(
        self,
        question: str,
        conversation_id: str | None = None,
    ) -> AnswerResponse: ...


class DryRunAgent:
    """Deterministic stand-in used in CI ``--dry-run`` invocations.

    Produces an :class:`AnswerResponse` whose shape is consistent
    with the golden expectations:

    * ``must_refuse=True`` goldens get a refused response with
      ``refusal_reason="no_coverage"``.
    * All other goldens get a grounded answer that cites every
      ``expected_citations`` entry and includes every
      ``expected_phrases`` fragment — so the deterministic rubrics
      all pass.

    The agent itself resolves the golden from an internal lookup
    (populated by the harness before dispatch).
    """

    def __init__(self, goldens_by_question: dict[str, GoldenExample]) -> None:
        self._by_q = goldens_by_question

    async def __call__(
        self,
        question: str,
        conversation_id: str | None = None,  # noqa: ARG002
    ) -> AnswerResponse:
        golden = self._by_q.get(question)
        if golden is None:
            # Fallback: shallow response.
            return AnswerResponse(
                question=question,
                answer="No matching golden in dry-run agent.",
                citations=[],
                groundedness=0.0,
                refused=True,
                refusal_reason="unknown_question",
            )

        if golden.must_refuse:
            return AnswerResponse(
                question=question,
                answer="Refusal — question outside CSA corpus.",
                citations=[],
                groundedness=0.10,
                refused=True,
                refusal_reason="no_coverage",
            )

        # Build a deterministic answer that embeds every expected phrase
        # (so AnswerRelevanceRubric hits 1.0) and emits one citation per
        # expected source path (so CitationAccuracyRubric hits 1.0).
        from apps.copilot.models import Citation

        body_parts: list[str] = [
            f"Deterministic dry-run answer for {golden.id}.",
        ]
        for phrase in golden.expected_phrases:
            body_parts.append(phrase)
        for idx, _ in enumerate(golden.expected_citations, start=1):
            body_parts.append(f"[{idx}]")
        answer = " ".join(body_parts)

        citations: list[Citation] = []
        for idx, src in enumerate(golden.expected_citations, start=1):
            citations.append(
                Citation(
                    id=idx,
                    source_path=src,
                    excerpt=f"Deterministic excerpt for {src}",
                    similarity=0.95,
                    chunk_id=f"chunk-{idx}",
                    reranker_score=None,
                ),
            )

        # When the golden lists no expected citations, synthesise one
        # to preserve the "grounded answer cites something" contract.
        if not citations:
            citations.append(
                Citation(
                    id=1,
                    source_path="docs/dry-run.md",
                    excerpt="Deterministic placeholder",
                    similarity=0.90,
                    chunk_id="chunk-placeholder",
                    reranker_score=None,
                ),
            )
            answer = f"{answer} [1]"

        return AnswerResponse(
            question=question,
            answer=answer,
            citations=citations,
            groundedness=0.90,
            refused=False,
            refusal_reason=None,
        )


# ---------------------------------------------------------------------------
# Harness implementation
# ---------------------------------------------------------------------------


class EvalHarness:
    """Drives an eval run end-to-end."""

    def __init__(
        self,
        agent: AgentCallable,
        *,
        rubrics: list[Rubric] | None = None,
        scorer: Scorer | None = None,
        concurrency: int = 4,
        default_max_latency_ms: int = 30_000,
        prompt_registry: PromptRegistry | None = None,
        deterministic: bool | None = None,
    ) -> None:
        if concurrency < 1:
            raise ValueError(f"concurrency must be >= 1, got {concurrency}")
        self.agent = agent

        env_deterministic = os.environ.get("COPILOT_EVALS_DETERMINISTIC", "")
        env_forces_deterministic = env_deterministic.strip().lower() in {
            "1", "true", "yes", "on",
        }
        self.deterministic = deterministic if deterministic is not None else env_forces_deterministic

        if self.deterministic or scorer is None:
            scorer = DeterministicScorer()
        self.scorer = scorer

        self.rubrics = rubrics or default_rubrics(scorer)
        self.concurrency = concurrency
        self.default_max_latency_ms = default_max_latency_ms
        self.prompt_registry = prompt_registry or default_registry()

    # -- public API --------------------------------------------------------

    @classmethod
    def dry_run_from_goldens(
        cls,
        goldens: Iterable[GoldenExample],
        *,
        concurrency: int = 4,
    ) -> EvalHarness:
        """Build a harness wired to :class:`DryRunAgent` for CI."""
        goldens_list = list(goldens)
        lookup = {g.question: g for g in goldens_list}
        return cls(
            agent=DryRunAgent(lookup),
            scorer=DeterministicScorer(),
            concurrency=concurrency,
            deterministic=True,
        )

    @staticmethod
    def load_goldens(path: Path) -> list[GoldenExample]:
        """Load + validate a YAML golden set from *path*."""
        validated = validate_goldens_file(path)
        return [GoldenExample.model_validate(entry) for entry in validated]

    async def run(
        self,
        goldens: Iterable[GoldenExample],
        *,
        goldens_source: str = "<in-memory>",
        tag: str | None = None,
    ) -> EvalReport:
        """Run every golden in *goldens* and aggregate into a report."""
        cases = [
            EvalCase(golden=g, max_latency_ms=self.default_max_latency_ms)
            for g in goldens
        ]

        semaphore = asyncio.Semaphore(self.concurrency)
        run_id = uuid.uuid4().hex

        async def _bounded_run(case: EvalCase) -> EvalResult:
            async with semaphore:
                return await self._run_case(case)

        async with copilot_span(
            "copilot.evals.run",
            attributes={
                SpanAttribute.EVAL_CASE_ID: run_id,  # misnomer but useful correlation.
            },
        ):
            tasks = [asyncio.create_task(_bounded_run(c)) for c in cases]
            results = await asyncio.gather(*tasks)

        aggregates = self._aggregate(results)
        prompt_hashes = {
            spec.id: spec.content_hash
            for spec in self.prompt_registry.all()
        }

        passed = sum(1 for r in results if r.passed and r.error is None)
        errors = sum(1 for r in results if r.error is not None)
        failed = len(results) - passed - errors

        report = EvalReport(
            run_id=run_id,
            tag=tag,
            goldens_source=goldens_source,
            prompt_hashes=prompt_hashes,
            deterministic=self.deterministic,
            results=results,
            aggregates=aggregates,
            total_cases=len(results),
            passed_cases=passed,
            failed_cases=failed,
            error_cases=errors,
        )

        logger.info(
            "copilot.evals.run_complete",
            run_id=run_id,
            total=len(results),
            passed=passed,
            failed=failed,
            errors=errors,
            deterministic=self.deterministic,
        )
        return report

    # -- internals ---------------------------------------------------------

    async def _run_case(self, case: EvalCase) -> EvalResult:
        case_id = case.golden.id
        async with copilot_span(
            f"copilot.eval.{case_id}",
            attributes={
                SpanAttribute.EVAL_CASE_ID: case_id,
                SpanAttribute.SKILL_ID: case.golden.skill,
            },
        ) as span:
            start = time.perf_counter()
            try:
                response = await self.agent(
                    case.golden.question,
                    case.golden.conversation_id,
                )
            except Exception as exc:
                latency_ms = (time.perf_counter() - start) * 1000.0
                logger.warning(
                    "copilot.evals.case_error",
                    case_id=case_id,
                    error=str(exc),
                )
                return EvalResult(
                    case_id=case_id,
                    skill=case.golden.skill,
                    latency_ms=latency_ms,
                    groundedness=0.0,
                    answer_excerpt="",
                    citations=[],
                    scores=[],
                    passed=False,
                    error=f"{type(exc).__name__}: {exc}",
                )
            latency_ms = (time.perf_counter() - start) * 1000.0

            span.set_attribute(SpanAttribute.EVAL_LATENCY_MS, latency_ms)
            span.set_attribute(SpanAttribute.REFUSED, response.refused)
            span.set_attribute(SpanAttribute.GROUNDEDNESS, response.groundedness)

            scores = []
            all_passed = True
            for rubric in self.rubrics:
                score = await rubric.score(case, response, latency_ms)
                scores.append(score)
                span.set_attribute(
                    f"copilot.eval.score.{rubric.name}",
                    score.value,
                )
                if not score.passed:
                    all_passed = False

            excerpt = response.answer.strip()
            if len(excerpt) > 400:
                excerpt = excerpt[:397].rstrip() + "..."

            citations = [c.source_path for c in response.citations]

            return EvalResult(
                case_id=case_id,
                skill=case.golden.skill,
                latency_ms=latency_ms,
                refused=response.refused,
                refusal_reason=response.refusal_reason,
                groundedness=response.groundedness,
                answer_excerpt=excerpt,
                citations=citations,
                scores=scores,
                passed=all_passed,
                error=None,
            )

    def _aggregate(self, results: list[EvalResult]) -> list[RubricAggregate]:
        """Compute mean/p50/p95/p99 aggregates for each rubric + latency."""
        if not results:
            return []

        # Collect per-rubric values + pass counts.
        by_rubric: dict[RubricName, list[float]] = {}
        pass_counts: dict[RubricName, int] = {}
        fail_counts: dict[RubricName, int] = {}

        for res in results:
            if res.error is not None:
                continue
            for s in res.scores:
                by_rubric.setdefault(s.rubric, []).append(float(s.value))
                if s.passed:
                    pass_counts[s.rubric] = pass_counts.get(s.rubric, 0) + 1
                else:
                    fail_counts[s.rubric] = fail_counts.get(s.rubric, 0) + 1

        aggregates: list[RubricAggregate] = []
        for rubric_name, values in by_rubric.items():
            aggregates.append(
                RubricAggregate(
                    rubric=rubric_name,
                    mean=sum(values) / len(values),
                    p50=_percentile(values, 50),
                    p95=_percentile(values, 95),
                    p99=_percentile(values, 99),
                    count=len(values),
                    passed=pass_counts.get(rubric_name, 0),
                    failed=fail_counts.get(rubric_name, 0),
                ),
            )

        # Add aggregate latency rubrics (p50/p95/p99) from LatencyRubric.
        latency_values = by_rubric.get("latency_p50", [])
        if latency_values:
            for rn, pct in (("latency_p50", 50), ("latency_p95", 95), ("latency_p99", 99)):
                # Replace (or add) the named aggregate so consumers see all three.
                computed = _percentile(latency_values, pct)
                aggregates = [a for a in aggregates if a.rubric != rn]
                aggregates.append(
                    RubricAggregate(
                        rubric=rn,  # type: ignore[arg-type]
                        mean=sum(latency_values) / len(latency_values),
                        p50=_percentile(latency_values, 50),
                        p95=_percentile(latency_values, 95),
                        p99=_percentile(latency_values, 99),
                        count=len(latency_values),
                        passed=pass_counts.get("latency_p50", 0),
                        failed=fail_counts.get("latency_p50", 0),
                    ),
                )
                # Slightly fiddly: we write the same stats under all three
                # latency_pXX names so downstream consumers (gate + CLI)
                # can grab "latency_p95" directly. The mean is computed
                # once; the pXX fields are identical across all three
                # entries because they describe the same distribution.
                _ = computed
        return sorted(aggregates, key=lambda a: a.rubric)


def _percentile(values: list[float], pct: int) -> float:
    """Return the nearest-rank percentile of *values*.

    Simple deterministic implementation — no interpolation, no numpy
    dependency.
    """
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    sorted_vals = sorted(values)
    if pct <= 0:
        return float(sorted_vals[0])
    if pct >= 100:
        return float(sorted_vals[-1])
    if pct == 50:
        return float(median(sorted_vals))
    k = round((pct / 100.0) * (len(sorted_vals) - 1))
    return float(sorted_vals[k])


# Keep `Any` reference live so static analysis doesn't strip it.
_ANY_SENTINEL: Any = None


__all__ = [
    "AgentCallable",
    "DryRunAgent",
    "EvalHarness",
]
