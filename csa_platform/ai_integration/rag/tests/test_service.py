"""End-to-end tests for :class:`RAGService` with all internals mocked."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from csa_platform.ai_integration.rag.chunker import Chunk, DocumentChunker
from csa_platform.ai_integration.rag.config import RAGSettings
from csa_platform.ai_integration.rag.models import AnswerResponse, IndexReport
from csa_platform.ai_integration.rag.retriever import SearchResult
from csa_platform.ai_integration.rag.service import RAGService


@pytest.fixture
def settings() -> RAGSettings:
    return RAGSettings()


def _make_service(
    settings: RAGSettings,
    *,
    retriever_results: list[SearchResult] | None = None,
    chunks_per_file: int = 2,
    chat_answer: str = "ANSWER",
) -> tuple[RAGService, MagicMock, MagicMock, MagicMock]:
    embedder = MagicMock()
    embedder.embed_texts_async = AsyncMock(return_value=[[0.1, 0.2, 0.3]])
    embedder.embed_texts = MagicMock(return_value=[[0.1, 0.2, 0.3]] * chunks_per_file)

    retriever = MagicMock()
    retriever.search_async = AsyncMock(return_value=retriever_results or [])
    retriever.upsert_documents = MagicMock(return_value=chunks_per_file)
    retriever.aclose = AsyncMock()

    chat_client = MagicMock()
    choice = MagicMock()
    choice.message.content = chat_answer
    response = MagicMock()
    response.choices = [choice]
    chat_client.chat.completions.create = AsyncMock(return_value=response)
    chat_client.close = AsyncMock()

    svc = RAGService(
        settings,
        embedder=embedder,
        retriever=retriever,
        chat_client=chat_client,
    )
    return svc, embedder, retriever, chat_client


class TestQuery:
    def test_query_returns_structured_answer(self, settings: RAGSettings) -> None:
        results = [
            SearchResult(id="r1", text="ctx-1", score=0.9, source="docs/a.md", metadata={"k": "v"}),
            SearchResult(id="r2", text="ctx-2", score=0.8, source="docs/b.md"),
        ]
        svc, _embedder, retriever, chat = _make_service(
            settings, retriever_results=results, chat_answer="Hello world"
        )

        resp = asyncio.run(svc.query("What?", k=2))
        assert isinstance(resp, AnswerResponse)
        assert resp.answer == "Hello world"
        assert len(resp.sources) == 2
        assert resp.sources[0].id == "r1"
        assert len(resp.context_chunks) == 2
        retriever.search_async.assert_awaited_once()
        chat.chat.completions.create.assert_awaited_once()

    def test_query_no_results_short_circuits(self, settings: RAGSettings) -> None:
        svc, _embedder, _retriever, chat = _make_service(settings, retriever_results=[])
        resp = asyncio.run(svc.query("x"))
        assert "No relevant context" in resp.answer
        assert resp.sources == []
        assert resp.context_chunks == []
        chat.chat.completions.create.assert_not_awaited()

    def test_query_without_citations(self, settings: RAGSettings) -> None:
        results = [SearchResult(id="r1", text="t", score=0.9, source="s")]
        svc, *_ = _make_service(settings, retriever_results=results)
        resp = asyncio.run(svc.query("?", with_citations=False))
        assert resp.sources == []
        assert len(resp.context_chunks) == 1

    def test_query_respects_rerank_toggle(self, settings: RAGSettings) -> None:
        results = [SearchResult(id="r1", text="t", score=0.9, source="s")]
        svc, _embedder, retriever, _chat = _make_service(settings, retriever_results=results)

        asyncio.run(svc.query("q", with_rerank=False))
        _, kwargs = retriever.search_async.await_args
        assert kwargs["use_semantic_reranker"] is False

    def test_answer_response_to_dict_legacy_shape(self, settings: RAGSettings) -> None:
        results = [SearchResult(id="r1", text="t", score=0.9, source="s", metadata={"a": 1})]
        svc, *_ = _make_service(settings, retriever_results=results, chat_answer="ok")
        resp = asyncio.run(svc.query("?"))
        d = resp.to_dict()
        assert set(d.keys()) == {"answer", "sources", "context_chunks"}
        assert d["sources"][0]["id"] == "r1"
        assert d["context_chunks"][0]["text"] == "t"


class TestIngest:
    def test_ingest_single_file(self, settings: RAGSettings, tmp_path: Path) -> None:
        path = tmp_path / "doc.txt"
        path.write_text("A reasonably long piece of text for ingest testing.", encoding="utf-8")

        svc, embedder, retriever, _chat = _make_service(settings)
        # Stub the chunker with a deterministic two-chunk result.
        svc.chunker = MagicMock(spec=DocumentChunker)
        svc.chunker.chunk_file.return_value = [
            Chunk(id="c1", text="a", source=str(path)),
            Chunk(id="c2", text="b", source=str(path)),
        ]
        embedder.embed_texts_async = AsyncMock(return_value=[[0.1], [0.2]])
        retriever.upsert_documents.return_value = 2

        report = asyncio.run(svc.ingest(path))
        assert isinstance(report, IndexReport)
        assert report.files_scanned == 1
        assert report.chunks_stored == 2
        assert report.dry_run is False
        retriever.upsert_documents.assert_called_once()

    def test_ingest_directory(self, settings: RAGSettings, tmp_path: Path) -> None:
        (tmp_path / "a.md").write_text("one", encoding="utf-8")
        (tmp_path / "b.md").write_text("two", encoding="utf-8")

        svc, embedder, retriever, _chat = _make_service(settings)
        svc.chunker = MagicMock(spec=DocumentChunker)
        svc.chunker.chunk_file.side_effect = [
            [Chunk(id="c1", text="one", source=str(tmp_path / "a.md"))],
            [Chunk(id="c2", text="two", source=str(tmp_path / "b.md"))],
        ]
        embedder.embed_texts_async = AsyncMock(side_effect=[[[0.1]], [[0.2]]])
        retriever.upsert_documents.side_effect = [1, 1]

        report = asyncio.run(svc.ingest(tmp_path, extensions=[".md"]))
        assert report.files_scanned == 2
        assert report.chunks_stored == 2

    def test_ingest_missing_root(self, settings: RAGSettings, tmp_path: Path) -> None:
        svc, *_ = _make_service(settings)
        with pytest.raises(FileNotFoundError):
            asyncio.run(svc.ingest(tmp_path / "nope"))

    def test_ingest_dry_run_skips_upsert(self, settings: RAGSettings, tmp_path: Path) -> None:
        path = tmp_path / "d.txt"
        path.write_text("x", encoding="utf-8")

        svc, embedder, retriever, _chat = _make_service(settings)
        svc.chunker = MagicMock(spec=DocumentChunker)
        svc.chunker.chunk_file.return_value = [Chunk(id="c1", text="x", source=str(path))]
        embedder.embed_texts_async = AsyncMock(return_value=[[0.1]])

        report = asyncio.run(svc.ingest(path, dry_run=True))
        assert report.dry_run is True
        assert report.chunks_stored == 1
        retriever.upsert_documents.assert_not_called()


class TestLifecycle:
    def test_close_is_idempotent(self, settings: RAGSettings) -> None:
        svc, _embedder, retriever, chat = _make_service(settings)
        # Flag service as owning the chat client so close() targets it.
        svc._owns_chat_client = True
        asyncio.run(svc.close())
        asyncio.run(svc.close())
        retriever.aclose.assert_awaited()
        chat.close.assert_awaited()

    def test_async_context_manager(self, settings: RAGSettings) -> None:
        svc, _embedder, retriever, _chat = _make_service(settings)

        async def _run() -> Any:
            async with svc as s:
                return s
            # on exit close() runs

        out = asyncio.run(_run())
        assert out is svc
        retriever.aclose.assert_awaited()

    def test_query_after_close_raises(self, settings: RAGSettings) -> None:
        svc, *_ = _make_service(settings)
        asyncio.run(svc.close())
        with pytest.raises(RuntimeError, match="closed"):
            asyncio.run(svc.query("?"))


class TestFactory:
    def test_from_settings_wires_real_components(self, settings: RAGSettings) -> None:
        svc = RAGService.from_settings(settings)
        # The factory wires an EmbeddingGenerator and VectorStore but
        # does not actually open any Azure connections until a method is
        # called, so this should be cheap and offline-safe.
        from csa_platform.ai_integration.rag.indexer import EmbeddingGenerator
        from csa_platform.ai_integration.rag.retriever import VectorStore

        assert isinstance(svc.embedder, EmbeddingGenerator)
        assert isinstance(svc.retriever, VectorStore)
        assert isinstance(svc.chunker, DocumentChunker)
