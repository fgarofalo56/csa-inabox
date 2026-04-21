"""Tests for :mod:`csa_platform.ai_integration.rag.retriever` (async path)."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from csa_platform.ai_integration.rag.retriever import SearchResult, VectorStore


class _AsyncIter:
    """Minimal async-iterator used to fake AzureSearchClient responses."""

    def __init__(self, items: list[dict[str, Any]]) -> None:
        self._items = list(items)

    def __aiter__(self) -> _AsyncIter:
        return self

    async def __anext__(self) -> dict[str, Any]:
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)


class TestVectorStoreAsync:
    def _make(self) -> VectorStore:
        return VectorStore(endpoint="https://test.search.windows.net", api_key="k", index_name="idx")

    def test_search_async_parses_docs(self) -> None:
        store = self._make()
        doc = {
            "id": "d1",
            "content": "txt",
            "source": "s.md",
            "metadata": '{"k": 1}',
            "@search.score": 0.8,
        }
        mock_client = MagicMock()
        mock_client.search = AsyncMock(return_value=_AsyncIter([doc]))
        store._async_search_client = mock_client

        with patch.dict("sys.modules", {"azure.search.documents.models": MagicMock()}):
            results = asyncio.run(store.search_async(query_vector=[0.1], top_k=3))

        assert len(results) == 1
        assert results[0].id == "d1"
        assert results[0].score == 0.8
        assert results[0].metadata == {"k": 1}

    def test_search_async_prefers_reranker_score(self) -> None:
        store = self._make()
        doc = {
            "id": "d1",
            "content": "txt",
            "source": "",
            "metadata": "{}",
            "@search.score": 0.3,
            "@search.reranker_score": 0.95,
        }
        mock_client = MagicMock()
        mock_client.search = AsyncMock(return_value=_AsyncIter([doc]))
        store._async_search_client = mock_client

        with patch.dict("sys.modules", {"azure.search.documents.models": MagicMock()}):
            results = asyncio.run(store.search_async(query_vector=[0.1]))

        assert results[0].score == 0.95

    def test_search_async_filters_by_threshold(self) -> None:
        store = self._make()
        low = {"id": "a", "content": "", "source": "", "metadata": "{}", "@search.score": 0.1}
        high = {"id": "b", "content": "", "source": "", "metadata": "{}", "@search.score": 0.9}
        mock_client = MagicMock()
        mock_client.search = AsyncMock(return_value=_AsyncIter([low, high]))
        store._async_search_client = mock_client

        with patch.dict("sys.modules", {"azure.search.documents.models": MagicMock()}):
            results = asyncio.run(store.search_async(query_vector=[0.1], score_threshold=0.5))

        assert [r.id for r in results] == ["b"]

    def test_aclose_closes_async_client(self) -> None:
        store = self._make()
        mock_client = MagicMock()
        mock_client.close = AsyncMock()
        store._async_search_client = mock_client
        asyncio.run(store.aclose())
        mock_client.close.assert_awaited_once()
        assert store._async_search_client is None

    def test_aclose_idempotent(self) -> None:
        store = self._make()
        asyncio.run(store.aclose())
        asyncio.run(store.aclose())

    def test_search_result_dataclass(self) -> None:
        r = SearchResult(id="x", text="y", score=0.5, source="s")
        assert r.metadata == {}
