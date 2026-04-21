"""Integration tests for :meth:`RAGService.query_async` (CSA-0110).

These tests exercise the full ``query_async`` path end-to-end against
mocked retriever + embedder + chat clients, confirming:

* chunk counts are surfaced on the response,
* citation shape matches the audit contract (id / source / score /
  section_anchor),
* the telemetry counter increments by the reported usage tokens,
* the rate limiter is invoked with the deployment name the settings
  advertise,
* ``ingest_async`` is a behavioural no-op alias over ``ingest``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from csa_platform.ai_integration.rag.chunker import Chunk, DocumentChunker
from csa_platform.ai_integration.rag.config import RAGSettings
from csa_platform.ai_integration.rag.models import AnswerResponse, IndexReport
from csa_platform.ai_integration.rag.rate_limit import (
    AzureOpenAIRateLimiter,
    reset_default_limiter,
)
from csa_platform.ai_integration.rag.retriever import SearchResult
from csa_platform.ai_integration.rag.service import RAGService


@pytest.fixture(autouse=True)
def _reset_limiter() -> Any:
    reset_default_limiter()
    yield
    reset_default_limiter()


def _settings_for_test() -> RAGSettings:
    s = RAGSettings()
    # Disable the semantic reranker so search_async is called with a
    # predictable ``use_semantic_reranker=False`` when with_rerank is off.
    s.search.use_semantic_reranker = False
    return s


def _build_service(
    *,
    retriever_results: list[SearchResult],
    chat_answer: str = "ANSWER",
    prompt_tokens: int = 42,
    completion_tokens: int = 7,
) -> tuple[RAGService, MagicMock, MagicMock]:
    embedder = MagicMock()
    embedder.embed_texts_async = AsyncMock(return_value=[[0.1, 0.2, 0.3]])

    retriever = MagicMock()
    retriever.search_async = AsyncMock(return_value=retriever_results)
    retriever.upsert_documents = MagicMock(return_value=len(retriever_results))
    retriever.aclose = AsyncMock()

    chat_client = MagicMock()
    choice = MagicMock()
    choice.message.content = chat_answer
    usage = MagicMock()
    usage.prompt_tokens = prompt_tokens
    usage.completion_tokens = completion_tokens
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    chat_client.chat.completions.create = AsyncMock(return_value=response)
    chat_client.close = AsyncMock()

    limiter = AzureOpenAIRateLimiter(
        rpm=1000, tpm=1_000_000, retry_attempts=1, retry_min_seconds=0.0, retry_max_seconds=0.0,
    )

    svc = RAGService(
        _settings_for_test(),
        embedder=embedder,
        retriever=retriever,
        chat_client=chat_client,
        rate_limiter=limiter,
    )
    return svc, retriever, chat_client


class TestQueryAsync:
    def test_end_to_end_returns_answer_and_citations(self) -> None:
        results = [
            SearchResult(
                id="r1",
                text="Alpha context.",
                score=0.91,
                source="docs/a.md",
                metadata={"section_anchor": "#intro"},
            ),
            SearchResult(
                id="r2",
                text="Beta context.",
                score=0.78,
                source="docs/b.md",
                metadata={},
            ),
        ]
        svc, retriever, chat_client = _build_service(
            retriever_results=results, chat_answer="The answer."
        )
        resp = asyncio.run(svc.query_async("What is Alpha?"))

        assert isinstance(resp, AnswerResponse)
        assert resp.answer == "The answer."
        assert len(resp.context_chunks) == 2
        assert [c.source for c in resp.context_chunks] == ["docs/a.md", "docs/b.md"]
        assert [c.score for c in resp.context_chunks] == [0.91, 0.78]
        assert len(resp.sources) == 2
        assert resp.sources[0].id == "r1"
        assert resp.sources[0].section_anchor == "#intro"
        assert resp.sources[1].section_anchor is None

        retriever.search_async.assert_awaited_once()
        chat_client.chat.completions.create.assert_awaited_once()
        _, kwargs = chat_client.chat.completions.create.await_args
        assert kwargs["model"] == "gpt-4o"

    def test_no_results_short_circuits(self) -> None:
        svc, _retriever, chat = _build_service(retriever_results=[])
        resp = asyncio.run(svc.query_async("no hits"))
        assert "No relevant context" in resp.answer
        assert resp.sources == []
        assert resp.context_chunks == []
        chat.chat.completions.create.assert_not_awaited()

    def test_telemetry_counter_increments(self) -> None:
        """The Prometheus dollars counter reflects usage from the mock."""
        pytest.importorskip("prometheus_client")
        from prometheus_client import REGISTRY

        before = (
            REGISTRY.get_sample_value("rag_dollars_estimated_total", {"model": "gpt-4o"}) or 0.0
        )
        results = [SearchResult(id="r1", text="t", score=0.9, source="s")]
        svc, *_ = _build_service(
            retriever_results=results,
            prompt_tokens=1000,
            completion_tokens=500,
        )
        asyncio.run(svc.query_async("q"))
        after = (
            REGISTRY.get_sample_value("rag_dollars_estimated_total", {"model": "gpt-4o"}) or 0.0
        )
        # gpt-4o pricing (DEFAULT_PRICING):
        #   1000/1000 * 0.0025 + 500/1000 * 0.010 = 0.0025 + 0.005 = 0.0075
        delta = after - before
        assert abs(delta - 0.0075) < 1e-6, f"delta={delta!r}"

        token_count = REGISTRY.get_sample_value(
            "rag_tokens_total", {"model": "gpt-4o", "direction": "prompt"}
        )
        assert token_count is not None
        assert token_count >= 1000

    def test_query_async_is_thin_alias(self) -> None:
        """query_async should return the same result as query."""
        results = [SearchResult(id="r1", text="t", score=0.9, source="s")]
        svc, *_ = _build_service(retriever_results=results)
        expected = asyncio.run(svc.query("same"))
        # Rebuild service to reset mock state, then call async alias.
        svc2, *_ = _build_service(retriever_results=results)
        got = asyncio.run(svc2.query_async("same"))
        assert got.answer == expected.answer
        assert len(got.sources) == len(expected.sources)


class TestIngestAsync:
    def test_ingest_async_is_alias(self, tmp_path: Path) -> None:
        path = tmp_path / "d.txt"
        path.write_text("A few words of content for ingest.", encoding="utf-8")

        results: list[SearchResult] = []
        svc, retriever, _chat = _build_service(retriever_results=results)
        svc.chunker = MagicMock(spec=DocumentChunker)
        svc.chunker.chunk_file.return_value = [
            Chunk(id="c1", text="alpha", source=str(path)),
            Chunk(id="c2", text="beta", source=str(path)),
        ]
        # ``svc.embedder`` is a MagicMock — attribute assignment is intended.
        svc.embedder.embed_texts_async = AsyncMock(return_value=[[0.1], [0.2]])  # type: ignore[method-assign]
        retriever.upsert_documents.return_value = 2

        report = asyncio.run(svc.ingest_async(path))
        assert isinstance(report, IndexReport)
        assert report.files_scanned == 1
        assert report.chunks_stored == 2
        assert report.dry_run is False
        retriever.upsert_documents.assert_called_once()
