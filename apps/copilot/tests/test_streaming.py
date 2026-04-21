"""Tests for :meth:`CopilotAgent.ask_stream` (post-Phase-1 Gap 2).

The streaming surface is a pure asyncio protocol: no Azure SDK
interaction.  A :class:`StreamingStubLLM` yields pre-baked deltas and
a final :class:`GenerationResult`.  A :class:`BlockingStubLLM` omits
``stream`` so we can exercise the feature-detection fallback path.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from apps.copilot.agent import (
    CopilotAgent,
    GenerationResult,
    LLMStreamChunk,
)
from apps.copilot.config import CopilotSettings
from apps.copilot.models import AnswerChunk, AnswerResponse, Citation
from csa_platform.ai_integration.rag.pipeline import SearchResult

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class StubEmbedder:
    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        return [[0.1] * 4 for _ in texts]


class StubRetriever:
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


class StreamingStubLLM:
    """LLM stub that implements :meth:`stream`."""

    def __init__(
        self,
        *,
        deltas: list[str],
        final: GenerationResult,
    ) -> None:
        self._deltas = list(deltas)
        self._final = final
        self.prompts: list[str] = []

    async def generate(self, prompt: str) -> GenerationResult:
        self.prompts.append(prompt)
        return self._final

    async def stream(self, prompt: str) -> AsyncIterator[LLMStreamChunk]:
        self.prompts.append(prompt)
        for d in self._deltas:
            yield LLMStreamChunk(delta=d)
        yield LLMStreamChunk(final=self._final)


class BlockingStubLLM:
    """LLM stub with only :meth:`generate` — no :meth:`stream`."""

    def __init__(self, final: GenerationResult) -> None:
        self._final = final
        self.prompts: list[str] = []

    async def generate(self, prompt: str) -> GenerationResult:
        self.prompts.append(prompt)
        return self._final


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _result(cid: str, score: float, text: str = "Grounded evidence.") -> SearchResult:
    return SearchResult(
        id=cid,
        text=text,
        score=score,
        source="docs/ARCHITECTURE.md",
        metadata={"source_path": "docs/ARCHITECTURE.md", "doc_type": "overview"},
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
        max_citation_verification_retries=0,
    )


async def _collect(
    agent: CopilotAgent,
    question: str,
    **kwargs: object,
) -> list[AnswerChunk]:
    """Drain ``ask_stream`` into a list for assertion."""
    out: list[AnswerChunk] = []
    async for event in agent.ask_stream(question, **kwargs):  # type: ignore[arg-type]
        out.append(event)
    return out


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestStreamingHappyPath:
    """Tokens flow before ``done``; refusals are never triggered."""

    @pytest.mark.asyncio
    async def test_emits_expected_event_sequence(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9, text="Evidence one."), _result("c2", 0.8, text="Evidence two.")]
        final = GenerationResult(
            answer="Conclusion [1] and support [2].",
            citations=[1, 2],
        )
        llm = StreamingStubLLM(
            deltas=["Conclusion ", "[1] and ", "support [2]."],
            final=final,
        )
        agent = CopilotAgent(
            settings=settings,
            retriever=StubRetriever(retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )

        events = await _collect(agent, "Why?")
        kinds = [e.kind for e in events]

        assert kinds.count("status") >= 3  # retrieve-start, retrieve-complete, coverage-gate-pass, generate-start
        assert "retrieve-start" in [e.payload for e in events if e.kind == "status"]
        assert "retrieve-complete" in [e.payload for e in events if e.kind == "status"]
        assert "coverage-gate-pass" in [e.payload for e in events if e.kind == "status"]
        assert "generate-start" in [e.payload for e in events if e.kind == "status"]
        # Tokens must fire in order.
        token_deltas = [e.payload for e in events if e.kind == "token"]
        assert token_deltas == ["Conclusion ", "[1] and ", "support [2]."]
        # One citation per verified id.
        citations = [e.payload for e in events if e.kind == "citation"]
        assert len(citations) == 2
        assert {c.id for c in citations if isinstance(c, Citation)} == {1, 2}
        # Terminal done with the full AnswerResponse.
        assert events[-1].kind == "done"
        final_payload = events[-1].payload
        assert isinstance(final_payload, AnswerResponse)
        assert not final_payload.refused
        assert final_payload.answer == "Conclusion [1] and support [2]."

    @pytest.mark.asyncio
    async def test_citations_carry_through_to_done(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9, text="Grounded.")]
        final = GenerationResult(answer="Claim [1].", citations=[1])
        llm = StreamingStubLLM(deltas=["Claim ", "[1]."], final=final)
        agent = CopilotAgent(
            settings=settings,
            retriever=StubRetriever(retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )

        events = await _collect(agent, "Question?")
        done = events[-1]
        assert done.kind == "done"
        assert isinstance(done.payload, AnswerResponse)
        assert len(done.payload.citations) == 1
        assert done.payload.citations[0].id == 1


# ---------------------------------------------------------------------------
# Refusal paths
# ---------------------------------------------------------------------------


class TestStreamingRefusal:
    """Refusals must still emit exactly one terminal ``done`` event."""

    @pytest.mark.asyncio
    async def test_empty_question_emits_refusal_and_done(
        self,
        settings: CopilotSettings,
    ) -> None:
        llm = StreamingStubLLM(deltas=[], final=GenerationResult(answer="", citations=[]))
        agent = CopilotAgent(
            settings=settings,
            retriever=StubRetriever([]),
            embedder=StubEmbedder(),
            llm=llm,
        )
        events = await _collect(agent, "")
        kinds = [e.kind for e in events]
        assert kinds == ["status", "done"]
        assert events[0].payload == "refused:empty_question"
        assert isinstance(events[1].payload, AnswerResponse)
        assert events[1].payload.refused is True
        assert events[1].payload.refusal_reason == "empty_question"
        # LLM must NOT have been invoked.
        assert llm.prompts == []

    @pytest.mark.asyncio
    async def test_no_coverage_short_circuits_before_llm(
        self,
        settings: CopilotSettings,
    ) -> None:
        weak = [_result("a", 0.10), _result("b", 0.20)]
        llm = StreamingStubLLM(deltas=[], final=GenerationResult(answer="x", citations=[]))
        agent = CopilotAgent(
            settings=settings,
            retriever=StubRetriever(weak),
            embedder=StubEmbedder(),
            llm=llm,
        )
        events = await _collect(agent, "Anything?")
        statuses = [e.payload for e in events if e.kind == "status"]
        # Coverage-gate-pass must NOT appear.
        assert "coverage-gate-pass" not in statuses
        assert "refused:no_coverage" in statuses
        assert events[-1].kind == "done"
        assert isinstance(events[-1].payload, AnswerResponse)
        assert events[-1].payload.refused is True
        assert events[-1].payload.refusal_reason == "no_coverage"
        # LLM not invoked.
        assert llm.prompts == []

    @pytest.mark.asyncio
    async def test_citation_verification_failure_refuses_in_stream(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9)]
        bad_final = GenerationResult(
            answer="Fabricated [9].",
            citations=[9],
        )
        llm = StreamingStubLLM(deltas=["Fabricated ", "[9]."], final=bad_final)
        agent = CopilotAgent(
            settings=settings,
            retriever=StubRetriever(retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )
        events = await _collect(agent, "Q?")
        # Deltas ARE emitted during generation (streaming happens before verification).
        assert any(e.kind == "token" for e in events)
        # But the final done is a refusal.
        assert events[-1].kind == "done"
        assert isinstance(events[-1].payload, AnswerResponse)
        assert events[-1].payload.refused is True
        assert events[-1].payload.refusal_reason == "citation_verification_failed"


# ---------------------------------------------------------------------------
# Fallback for non-streaming LLMs
# ---------------------------------------------------------------------------


class TestStreamingFallback:
    """When the LLM has only ``generate``, we synthesise a single delta."""

    @pytest.mark.asyncio
    async def test_blocking_llm_produces_one_token_event(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9)]
        final = GenerationResult(answer="Answer [1].", citations=[1])
        llm = BlockingStubLLM(final=final)
        agent = CopilotAgent(
            settings=settings,
            retriever=StubRetriever(retrieved),
            embedder=StubEmbedder(),
            llm=llm,
        )
        events = await _collect(agent, "Q?")
        token_events = [e for e in events if e.kind == "token"]
        assert len(token_events) == 1
        assert token_events[0].payload == "Answer [1]."
        assert events[-1].kind == "done"
        assert isinstance(events[-1].payload, AnswerResponse)
        assert not events[-1].payload.refused
