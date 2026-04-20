"""Tests for :mod:`apps.copilot.agent` (Phase 1 grounded Q&A).

All tests use in-memory stubs for the retriever, embedder, and LLM.
No Azure credentials are required and no real PydanticAI Agent is
constructed — we inject a :class:`StubLLM` implementing the
``LLMGenerator`` protocol.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from apps.copilot.agent import CopilotAgent, GenerationResult
from apps.copilot.config import CopilotSettings
from apps.copilot.models import AnswerResponse
from csa_platform.ai_integration.rag.pipeline import SearchResult

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class StubEmbedder:
    """Async embedder stub.  Returns a single fixed-length vector."""

    def __init__(self, dim: int = 4) -> None:
        self.dim = dim
        self.calls: list[list[str]] = []

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [[0.1] * self.dim for _ in texts]


class StubRetriever:
    """Async retriever stub.  Returns pre-baked SearchResults."""

    def __init__(self, results: list[SearchResult]) -> None:
        self._results = results
        self.calls = 0

    async def search_async(
        self,
        query_vector: list[float],  # noqa: ARG002
        query_text: str = "",  # noqa: ARG002
        top_k: int = 5,  # noqa: ARG002
        score_threshold: float = 0.0,  # noqa: ARG002
        filters: str | None = None,  # noqa: ARG002
        use_semantic_reranker: bool = False,  # noqa: ARG002
    ) -> list[SearchResult]:
        self.calls += 1
        return list(self._results)


class StubLLM:
    """LLMGenerator stub.

    Returns a queue of pre-baked :class:`GenerationResult` items so a
    test can verify retry behaviour.  If the queue is exhausted it
    raises :class:`RuntimeError` (which would surface as a test
    failure rather than silent reuse).
    """

    def __init__(self, outputs: list[GenerationResult]) -> None:
        self._outputs = list(outputs)
        self.prompts: list[str] = []

    async def generate(self, prompt: str) -> GenerationResult:
        self.prompts.append(prompt)
        if not self._outputs:
            raise RuntimeError("StubLLM exhausted: no more pre-baked outputs.")
        return self._outputs.pop(0)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _search_result(
    cid: str,
    score: float,
    source: str = "docs/ARCHITECTURE.md",
    text: str = "Private endpoints are required for prod.",
) -> SearchResult:
    return SearchResult(
        id=cid,
        text=text,
        score=score,
        source=source,
        metadata={"source_path": source, "doc_type": "overview"},
    )


@pytest.fixture
def settings() -> CopilotSettings:
    return CopilotSettings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="fake-key",
        azure_search_endpoint="https://fake.search.windows.net",
        azure_search_api_key="fake-key",
        min_grounding_similarity=0.45,
        min_grounded_chunks=1,
        top_k=3,
        max_citation_verification_retries=1,
    )


def _make_agent(
    settings: CopilotSettings,
    retriever_results: list[SearchResult],
    llm_outputs: list[GenerationResult],
) -> tuple[CopilotAgent, StubRetriever, StubLLM, StubEmbedder]:
    retriever = StubRetriever(retriever_results)
    llm = StubLLM(llm_outputs)
    embedder = StubEmbedder()
    agent = CopilotAgent(
        settings=settings,
        retriever=retriever,
        embedder=embedder,
        llm=llm,
    )
    return agent, retriever, llm, embedder


# ---------------------------------------------------------------------------
# Refusal paths
# ---------------------------------------------------------------------------


class TestRefusalPaths:
    """The agent must refuse rather than fabricate."""

    def test_empty_question_refuses_without_retrieval(
        self,
        settings: CopilotSettings,
    ) -> None:
        agent, retriever, llm, _embedder = _make_agent(settings, [], [])
        response = asyncio.run(agent.ask("  "))
        assert response.refused is True
        assert response.refusal_reason == "empty_question"
        assert retriever.calls == 0
        assert llm.prompts == []

    def test_no_coverage_refuses(self, settings: CopilotSettings) -> None:
        # All retrieved scores are below the 0.45 threshold.
        weak_results = [_search_result("a", 0.10), _search_result("b", 0.20)]
        agent, _retriever, llm, _embedder = _make_agent(
            settings,
            weak_results,
            [],  # LLM must not be invoked
        )
        response = asyncio.run(agent.ask("Anything?"))
        assert response.refused is True
        assert response.refusal_reason == "no_coverage"
        assert response.answer == settings.refusal_message
        assert response.groundedness == pytest.approx(0.20)
        # The LLM was never called.
        assert llm.prompts == []

    def test_no_retrieval_results_refuses(self, settings: CopilotSettings) -> None:
        agent, _retriever, llm, _embedder = _make_agent(settings, [], [])
        response = asyncio.run(agent.ask("Anything?"))
        assert response.refused is True
        assert response.refusal_reason == "no_coverage"
        assert llm.prompts == []


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestHappyPath:
    """Grounded question with a compliant LLM response."""

    def test_returns_answer_with_citations(self, settings: CopilotSettings) -> None:
        retrieved = [
            _search_result("c1", 0.90, source="docs/ARCHITECTURE.md"),
            _search_result("c2", 0.80, source="docs/adr/0001.md"),
        ]
        llm_outputs = [
            GenerationResult(
                answer=(
                    "Private endpoints are required for production environments "
                    "[1]. The Bicep templates enable them automatically [2]."
                ),
                citations=[1, 2],
            ),
        ]
        agent, _retriever, llm, embedder = _make_agent(settings, retrieved, llm_outputs)

        response: AnswerResponse = asyncio.run(agent.ask("Do I need private endpoints?"))

        assert response.refused is False
        assert response.refusal_reason is None
        assert len(response.citations) == 2
        assert {c.id for c in response.citations} == {1, 2}
        assert response.citations[0].source_path.startswith("docs/")
        assert response.groundedness == pytest.approx(0.90)
        # Embedder + LLM both called exactly once.
        assert len(embedder.calls) == 1
        assert len(llm.prompts) == 1

    def test_prompt_contains_numbered_context(self, settings: CopilotSettings) -> None:
        retrieved = [
            _search_result("c1", 0.9, text="Alpha chunk."),
            _search_result("c2", 0.8, text="Beta chunk."),
        ]
        outputs = [
            GenerationResult(answer="Alpha [1] and beta [2].", citations=[1, 2]),
        ]
        agent, _retriever, llm, _embedder = _make_agent(settings, retrieved, outputs)
        asyncio.run(agent.ask("What are alpha and beta?"))

        assert len(llm.prompts) == 1
        prompt = llm.prompts[0]
        assert "[1]" in prompt
        assert "[2]" in prompt
        assert "Alpha chunk." in prompt
        assert "Beta chunk." in prompt


# ---------------------------------------------------------------------------
# Citation verification + retry
# ---------------------------------------------------------------------------


class TestCitationVerification:
    """Verification errors trigger a single retry then refuse."""

    def test_retry_succeeds_after_fix(self, settings: CopilotSettings) -> None:
        retrieved = [_search_result("c1", 0.9), _search_result("c2", 0.8)]
        # First attempt fabricates id 5; second attempt is compliant.
        outputs = [
            GenerationResult(
                answer="First answer [1] and [5].",
                citations=[1, 5],
            ),
            GenerationResult(
                answer="Second answer [1] and [2].",
                citations=[1, 2],
            ),
        ]
        agent, _retriever, llm, _embedder = _make_agent(settings, retrieved, outputs)
        response = asyncio.run(agent.ask("Question?"))

        assert response.refused is False
        assert response.answer.startswith("Second answer")
        assert {c.id for c in response.citations} == {1, 2}
        assert len(llm.prompts) == 2
        # The second prompt should mention the previous failure.
        assert "citation verification" in llm.prompts[1].lower()
        assert "5" in llm.prompts[1]  # fabricated id mentioned in repair prompt

    def test_retry_exhausted_returns_refusal(self, settings: CopilotSettings) -> None:
        # Both attempts fabricate an id — agent must give up and refuse.
        retrieved = [_search_result("c1", 0.9)]
        outputs = [
            GenerationResult(answer="Bad [1] and [7].", citations=[1, 7]),
            GenerationResult(answer="Still bad [9].", citations=[9]),
        ]
        agent, _retriever, llm, _embedder = _make_agent(settings, retrieved, outputs)
        response = asyncio.run(agent.ask("Question?"))

        assert response.refused is True
        assert response.refusal_reason == "citation_verification_failed"
        assert response.answer == settings.refusal_message
        # retries=1 means max_attempts=2, both prompts consumed.
        assert len(llm.prompts) == 2

    def test_missing_marker_triggers_retry(self, settings: CopilotSettings) -> None:
        retrieved = [_search_result("c1", 0.9), _search_result("c2", 0.8)]
        outputs = [
            # Cited [2] but didn't mark it in the text.
            GenerationResult(answer="Only marked [1].", citations=[1, 2]),
            GenerationResult(answer="Now [1] and [2] both.", citations=[1, 2]),
        ]
        agent, _retriever, llm, _embedder = _make_agent(settings, retrieved, outputs)
        response = asyncio.run(agent.ask("Question?"))
        assert response.refused is False
        assert len(llm.prompts) == 2
        assert "without a matching" in llm.prompts[1]

    def test_no_markers_at_all_triggers_retry(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_search_result("c1", 0.9)]
        outputs = [
            GenerationResult(answer="I have no citations.", citations=[]),
            GenerationResult(answer="Now [1] is cited.", citations=[1]),
        ]
        agent, _retriever, llm, _embedder = _make_agent(settings, retrieved, outputs)
        response = asyncio.run(agent.ask("Question?"))
        assert response.refused is False
        assert "[1]" in response.answer
        assert len(llm.prompts) == 2


# ---------------------------------------------------------------------------
# Citation construction details
# ---------------------------------------------------------------------------


class TestCitationBuilding:
    """Structural details of the Citation objects in the response."""

    def test_long_excerpts_are_truncated(self, settings: CopilotSettings) -> None:
        long_text = "x " * 600  # 1200 chars
        retrieved = [_search_result("c1", 0.9, text=long_text)]
        outputs = [GenerationResult(answer="Cite [1].", citations=[1])]
        agent, _retriever, _llm, _embedder = _make_agent(settings, retrieved, outputs)
        response = asyncio.run(agent.ask("q?"))
        assert len(response.citations) == 1
        assert len(response.citations[0].excerpt) <= 500
        assert response.citations[0].excerpt.endswith("...")

    def test_citation_similarity_is_clamped(self, settings: CopilotSettings) -> None:
        # Azure Search can return scores > 1 for hybrid queries.
        retrieved = [_search_result("c1", 1.5)]
        outputs = [GenerationResult(answer="Cite [1].", citations=[1])]
        agent, _retriever, _llm, _embedder = _make_agent(settings, retrieved, outputs)
        response = asyncio.run(agent.ask("q?"))
        assert response.citations[0].similarity == 1.0
        assert response.groundedness == 1.0


# ---------------------------------------------------------------------------
# Sanity: imports of optional LLM backend are lazy
# ---------------------------------------------------------------------------


def test_module_import_does_not_require_azure() -> None:
    """Importing the agent module must not create any Azure clients.

    This is a regression guard: if someone ever moves a heavy import
    out of :meth:`PydanticAIGenerator._build_agent`, offline tests and
    ``--help`` invocations will start failing with credential errors.
    """
    # Simply re-import and check the module is present; the import
    # itself must not raise.
    import importlib

    import apps.copilot.agent as agent_mod

    reloaded: Any = importlib.reload(agent_mod)
    assert hasattr(reloaded, "CopilotAgent")
