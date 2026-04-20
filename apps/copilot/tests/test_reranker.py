"""Tests for the semantic-reranker path in :meth:`CopilotAgent._retrieve`
(post-Phase-1 Gap 3).

No Azure calls — the retriever stub introspects the
``use_semantic_reranker`` kwarg so we can assert exactly what the agent
requested of the underlying vector store.
"""

from __future__ import annotations

import asyncio

import pytest

from apps.copilot.agent import CopilotAgent, GenerationResult
from apps.copilot.config import CopilotSettings
from apps.copilot.models import AnswerResponse
from csa_platform.ai_integration.rag.pipeline import SearchResult

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class StubEmbedder:
    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        return [[0.1] * 4 for _ in texts]


class InstrumentedRetriever:
    """Retriever that records the reranker flag and raises on cue."""

    def __init__(
        self,
        *,
        results: list[SearchResult],
        raise_on_semantic: bool = False,
    ) -> None:
        self._results = results
        self._raise_on_semantic = raise_on_semantic
        self.calls: list[dict[str, object]] = []

    async def search_async(
        self,
        query_vector: list[float],
        query_text: str = "",
        top_k: int = 5,
        score_threshold: float = 0.0,
        filters: str | None = None,
        use_semantic_reranker: bool = False,
    ) -> list[SearchResult]:
        self.calls.append(
            {
                "vector_len": len(query_vector),
                "query_text": query_text,
                "top_k": top_k,
                "score_threshold": score_threshold,
                "filters": filters,
                "use_semantic_reranker": use_semantic_reranker,
            },
        )
        if use_semantic_reranker and self._raise_on_semantic:
            raise RuntimeError("semantic configuration not found")
        return list(self._results)


class StubLLM:
    def __init__(self, final: GenerationResult) -> None:
        self._final = final
        self.prompts: list[str] = []

    async def generate(self, prompt: str) -> GenerationResult:
        self.prompts.append(prompt)
        return self._final


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _result(cid: str, score: float, text: str = "Evidence.") -> SearchResult:
    return SearchResult(
        id=cid,
        text=text,
        score=score,
        source="docs/ARCHITECTURE.md",
        metadata={"source_path": "docs/ARCHITECTURE.md", "doc_type": "overview"},
    )


def _settings(*, reranker: bool) -> CopilotSettings:
    return CopilotSettings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="fake-key",
        azure_search_endpoint="https://fake.search.windows.net",
        azure_search_api_key="fake-key",
        min_grounding_similarity=0.45,
        min_grounded_chunks=1,
        top_k=3,
        max_citation_verification_retries=0,
        use_semantic_reranker=reranker,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSemanticRerankerEnabled:
    """Agent requests semantic ranking when the setting is True."""

    def test_retriever_called_with_reranker_flag(self) -> None:
        settings = _settings(reranker=True)
        retrieved = [_result("c1", 0.9, text="Backed evidence.")]
        llm = StubLLM(GenerationResult(answer="Answer [1].", citations=[1]))
        retriever = InstrumentedRetriever(results=retrieved)

        agent = CopilotAgent(
            settings=settings,
            retriever=retriever,
            embedder=StubEmbedder(),
            llm=llm,
        )

        response: AnswerResponse = asyncio.run(agent.ask("Q?"))

        assert not response.refused
        assert len(retriever.calls) == 1
        assert retriever.calls[0]["use_semantic_reranker"] is True

    def test_reranker_score_surfaces_on_citation(self) -> None:
        """When semantic_used, the Citation's reranker_score is populated."""
        settings = _settings(reranker=True)
        # Azure reranker scores live in [0, 4]. A score of 2.75 is
        # preserved verbatim on the citation.
        retrieved = [_result("c1", 2.75, text="Evidence.")]
        llm = StubLLM(GenerationResult(answer="Answer [1].", citations=[1]))
        agent = CopilotAgent(
            settings=settings,
            retriever=InstrumentedRetriever(results=retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )
        response = asyncio.run(agent.ask("Q?"))
        assert not response.refused
        assert response.citations[0].reranker_score == pytest.approx(2.75)

    def test_reranker_score_clamped_on_out_of_range(self) -> None:
        """Defensive: scores outside [0,4] are clamped."""
        settings = _settings(reranker=True)
        retrieved = [_result("c1", 10.0, text="Evidence.")]  # nonsense-high
        llm = StubLLM(GenerationResult(answer="Answer [1].", citations=[1]))
        agent = CopilotAgent(
            settings=settings,
            retriever=InstrumentedRetriever(results=retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )
        response = asyncio.run(agent.ask("Q?"))
        assert response.citations[0].reranker_score == 4.0


class TestSemanticRerankerDisabled:
    """When the flag is off, the retriever is called without reranking."""

    def test_no_reranker_flag_when_disabled(self) -> None:
        settings = _settings(reranker=False)
        retrieved = [_result("c1", 0.9, text="Evidence.")]
        llm = StubLLM(GenerationResult(answer="Answer [1].", citations=[1]))
        retriever = InstrumentedRetriever(results=retrieved)

        agent = CopilotAgent(
            settings=settings,
            retriever=retriever,
            embedder=StubEmbedder(),
            llm=llm,
        )
        asyncio.run(agent.ask("Q?"))
        assert retriever.calls[0]["use_semantic_reranker"] is False

    def test_reranker_score_is_none_when_disabled(self) -> None:
        settings = _settings(reranker=False)
        retrieved = [_result("c1", 0.9, text="Evidence.")]
        llm = StubLLM(GenerationResult(answer="Answer [1].", citations=[1]))
        agent = CopilotAgent(
            settings=settings,
            retriever=InstrumentedRetriever(results=retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )
        response = asyncio.run(agent.ask("Q?"))
        assert response.citations[0].reranker_score is None


class TestSemanticRerankerFallback:
    """When the index lacks semantic configuration, the agent retries without it."""

    def test_missing_semantic_config_falls_back_with_warning(self) -> None:
        settings = _settings(reranker=True)
        retrieved = [_result("c1", 0.9, text="Evidence.")]
        llm = StubLLM(GenerationResult(answer="Answer [1].", citations=[1]))
        retriever = InstrumentedRetriever(
            results=retrieved,
            raise_on_semantic=True,
        )
        agent = CopilotAgent(
            settings=settings,
            retriever=retriever,
            embedder=StubEmbedder(),
            llm=llm,
        )
        response = asyncio.run(agent.ask("Q?"))

        # The call was tried with the reranker, failed, and retried without.
        assert len(retriever.calls) == 2
        assert retriever.calls[0]["use_semantic_reranker"] is True
        assert retriever.calls[1]["use_semantic_reranker"] is False
        assert not response.refused
        # Citation has NO reranker score because the successful retrieval
        # did not use the reranker.
        assert response.citations[0].reranker_score is None
