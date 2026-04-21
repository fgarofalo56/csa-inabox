"""Scorers for the :class:`AnswerRelevanceRubric`.

The eval harness decouples the "judge" from the rubric so we can:

1. Run CI without any Azure / LLM dependency (deterministic stub).
2. Swap in an LLM-as-judge in production deployments.
3. Inject test fakes for unit tests.

The contract is the :class:`Scorer` protocol — a single async method
returning ``(score, reason)``.  Implementations should clamp scores
to ``[0.0, 1.0]`` themselves; the rubric re-clamps defensively.
"""

from __future__ import annotations

import os
from typing import Protocol

# ---------------------------------------------------------------------------
# Typed errors
# ---------------------------------------------------------------------------


class LiveEvalConfigurationError(RuntimeError):
    """Raised when a live eval run is requested without the required env.

    Live evals require *both*:

    * ``COPILOT_EVALS_LIVE=true`` (explicit opt-in per run), and
    * ``AZURE_OPENAI_ENDPOINT`` set to a reachable endpoint.

    The CLI uses this error to produce a single, actionable message
    instead of a deep stack trace.
    """


class LiveScorerError(RuntimeError):
    """Raised when the live :class:`LLMJudgeScorer` cannot produce a score.

    The deterministic path never raises this; the live path does so
    the harness can surface it as an explicit per-case error rather
    than masking it as ``score=0.5``.
    """


class Scorer(Protocol):
    """Minimal interface for an answer-relevance judge."""

    async def score_relevance(
        self,
        question: str,
        answer: str,
        expected_phrases: list[str],
    ) -> tuple[float, str]: ...


class DeterministicScorer:
    """Phrase-match scorer used in CI and tests.

    The implementation is a pure Python heuristic (case-insensitive
    substring match against ``expected_phrases``). It makes NO
    network calls, returns the same output for the same input, and is
    therefore trivially reproducible.

    When ``COPILOT_EVALS_DETERMINISTIC`` is truthy (the default in the
    CI dry-run path), the harness forces this scorer regardless of
    what the caller passed.
    """

    async def score_relevance(
        self,
        question: str,
        answer: str,
        expected_phrases: list[str],
    ) -> tuple[float, str]:
        # Local import avoids a circular dep at module load time:
        # ``rubrics`` already imports this module.
        from apps.copilot.evals.rubrics import evaluate_phrases

        if not answer:
            return 0.0, "empty answer"
        # The ``question`` arg is unused in the deterministic path but
        # kept in the signature so the LLM scorer can use it.
        _ = question
        value, reason = evaluate_phrases(answer, expected_phrases)
        return value, reason


class LLMJudgeScorer:
    """LLM-as-judge scorer.

    Constructed lazily — the underlying PydanticAI agent + OpenAI
    client are only imported when :meth:`score_relevance` is called
    so tests never pull in Azure credentials transitively.

    Callers should NOT pass this in CI — use the deterministic
    scorer there. It is provided for on-demand local runs where a
    human wants the judge to grade a golden set against a live
    model.
    """

    JUDGE_PROMPT = (
        "You are an evaluator rating whether a Copilot answer is "
        "relevant to the question.\n"
        "Output a single float between 0.0 and 1.0 on the first line "
        "(no other text), then a short reason on the second line.\n"
        "1.0 = answer directly addresses the question with relevant "
        "facts.\n"
        "0.5 = partial coverage, some relevant facts missing.\n"
        "0.0 = answer is irrelevant, refusal, or off-topic.\n"
    )

    def __init__(
        self,
        *,
        chat_deployment: str | None = None,
        endpoint: str | None = None,
        api_version: str = "2024-06-01",
    ) -> None:
        self.chat_deployment = chat_deployment or os.environ.get(
            "COPILOT_AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4o",
        )
        self.endpoint = endpoint or os.environ.get(
            "COPILOT_AZURE_OPENAI_ENDPOINT", "",
        )
        self.api_version = api_version

    async def score_relevance(
        self,
        question: str,
        answer: str,
        expected_phrases: list[str],
    ) -> tuple[float, str]:
        if not self.endpoint:
            # Degrade gracefully: no endpoint configured.
            return 0.5, "LLM judge endpoint not configured"

        try:
            from openai import AsyncAzureOpenAI
        except ImportError:
            return 0.5, "openai package unavailable"

        # API key vs AAD: for a judge, we accept either; users who want
        # AAD must pre-export OPENAI_API_KEY='' and rely on env.
        api_key = os.environ.get("COPILOT_AZURE_OPENAI_API_KEY", "")
        if not api_key:
            return 0.5, "no Azure OpenAI credentials for judge"

        client = AsyncAzureOpenAI(
            azure_endpoint=self.endpoint,
            api_key=api_key,
            api_version=self.api_version,
        )
        phrases_hint = (
            "\nExpected phrases (presence is a positive signal): "
            f"{expected_phrases}"
            if expected_phrases
            else ""
        )
        user = (
            f"Question: {question}\n\n"
            f"Answer: {answer}\n"
            f"{phrases_hint}"
        )
        try:
            resp = await client.chat.completions.create(
                model=self.chat_deployment,
                messages=[
                    {"role": "system", "content": self.JUDGE_PROMPT},
                    {"role": "user", "content": user},
                ],
                max_tokens=128,
                temperature=0.0,
            )
            content = (resp.choices[0].message.content or "").strip()
        except Exception as exc:  # pragma: no cover - live-LLM path
            return 0.5, f"LLM judge error: {exc}"

        lines = [ln.strip() for ln in content.splitlines() if ln.strip()]
        score = 0.5
        reason = content[:200]
        if lines:
            try:
                score = float(lines[0])
            except ValueError:
                score = 0.5
            if len(lines) > 1:
                reason = lines[1]
        score = max(0.0, min(1.0, score))
        return score, reason


def live_eval_enabled() -> bool:
    """Return True when ``COPILOT_EVALS_LIVE`` is truthy.

    Centralising the env check keeps the CLI and scorer in lock-step —
    every ``live_eval_enabled()``-gated code path uses the same
    truthiness rules as :mod:`apps.copilot.telemetry.tracer`.
    """
    raw = os.environ.get("COPILOT_EVALS_LIVE", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def build_live_scorer(
    *,
    endpoint: str | None = None,
    chat_deployment: str | None = None,
    api_version: str = "2024-06-01",
) -> LLMJudgeScorer:
    """Construct a :class:`LLMJudgeScorer` for live LLM-as-judge runs.

    Validates the required env surface and raises
    :class:`LiveEvalConfigurationError` otherwise so callers never
    ship a partially-configured live run.  The Azure OpenAI endpoint
    is read from ``AZURE_OPENAI_ENDPOINT`` (the RAG-service standard)
    when not provided explicitly.
    """
    if not live_eval_enabled():
        raise LiveEvalConfigurationError(
            "Live eval is not enabled.  Set COPILOT_EVALS_LIVE=true to "
            "opt in to non-deterministic LLM-as-judge scoring.",
        )
    resolved_endpoint = (
        endpoint
        or os.environ.get("AZURE_OPENAI_ENDPOINT", "")
        or os.environ.get("COPILOT_AZURE_OPENAI_ENDPOINT", "")
    ).strip()
    if not resolved_endpoint:
        raise LiveEvalConfigurationError(
            "Live eval requires AZURE_OPENAI_ENDPOINT (or "
            "COPILOT_AZURE_OPENAI_ENDPOINT) to be set.",
        )
    return LLMJudgeScorer(
        endpoint=resolved_endpoint,
        chat_deployment=chat_deployment,
        api_version=api_version,
    )


__all__ = [
    "DeterministicScorer",
    "LLMJudgeScorer",
    "LiveEvalConfigurationError",
    "LiveScorerError",
    "Scorer",
    "build_live_scorer",
    "live_eval_enabled",
]
