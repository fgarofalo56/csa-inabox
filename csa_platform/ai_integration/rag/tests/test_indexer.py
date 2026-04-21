"""Tests for :mod:`csa_platform.ai_integration.rag.indexer` (async path)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from csa_platform.ai_integration.rag.indexer import EmbeddingGenerator


class TestEmbeddingGeneratorAsync:
    def _make(self, **kwargs: object) -> EmbeddingGenerator:
        defaults = {
            "endpoint": "https://test.openai.azure.com",
            "api_key": "test-key",
            "batch_size": 2,
            "max_concurrent": 3,
        }
        defaults.update(kwargs)
        return EmbeddingGenerator(**defaults)  # type: ignore[arg-type]

    def test_embed_texts_async_single_batch(self) -> None:
        gen = self._make(batch_size=10)

        item_a = MagicMock()
        item_a.embedding = [0.1, 0.2]
        item_b = MagicMock()
        item_b.embedding = [0.3, 0.4]
        response = MagicMock()
        response.data = [item_a, item_b]

        mock_client = MagicMock()
        mock_client.embeddings.create = AsyncMock(return_value=response)
        gen._cached_async_client = mock_client

        out = asyncio.run(gen.embed_texts_async(["one", "two"]))
        assert out == [[0.1, 0.2], [0.3, 0.4]]
        mock_client.embeddings.create.assert_awaited_once()

    def test_embed_texts_async_multiple_batches(self) -> None:
        gen = self._make(batch_size=2)

        def _item(vec: list[float]) -> MagicMock:
            m = MagicMock()
            m.embedding = vec
            return m

        r1 = MagicMock()
        r1.data = [_item([1.0]), _item([2.0])]
        r2 = MagicMock()
        r2.data = [_item([3.0])]

        mock_client = MagicMock()
        mock_client.embeddings.create = AsyncMock(side_effect=[r1, r2])
        gen._cached_async_client = mock_client

        out = asyncio.run(gen.embed_texts_async(["a", "b", "c"]))
        assert out == [[1.0], [2.0], [3.0]]
        assert mock_client.embeddings.create.await_count == 2

    def test_embed_texts_async_respects_concurrency_cap(self) -> None:
        """Concurrency is bounded by max_concurrent through the semaphore."""
        gen = self._make(batch_size=1, max_concurrent=2)

        in_flight = 0
        max_in_flight = 0

        async def _create(**_kwargs: object) -> MagicMock:
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.02)
            in_flight -= 1
            item = MagicMock()
            item.embedding = [0.0]
            resp = MagicMock()
            resp.data = [item]
            return resp

        mock_client = MagicMock()
        mock_client.embeddings.create = _create
        gen._cached_async_client = mock_client

        texts = [f"t{i}" for i in range(6)]
        asyncio.run(gen.embed_texts_async(texts))
        assert max_in_flight <= 2

    def test_sync_embed_single_delegates_to_batch(self) -> None:
        gen = self._make()
        mock_client = MagicMock()
        item = MagicMock()
        item.embedding = [0.9]
        resp = MagicMock()
        resp.data = [item]
        mock_client.embeddings.create.return_value = resp
        gen._client = mock_client

        assert gen.embed_single("hello") == [0.9]

    def test_aclose_disposes_async_client_and_credential(self) -> None:
        """CSA-0106: aclose() releases the cached async client + credential."""
        gen = self._make()

        async_client = MagicMock()
        async_client.close = AsyncMock(return_value=None)
        credential = MagicMock()
        credential.close = AsyncMock(return_value=None)

        gen._cached_async_client = async_client
        gen._cached_async_credential = credential

        asyncio.run(gen.aclose())

        async_client.close.assert_awaited_once()
        credential.close.assert_awaited_once()
        assert gen._cached_async_client is None
        assert gen._cached_async_credential is None

    def test_aclose_is_idempotent(self) -> None:
        """Calling aclose() on a fresh generator or twice must not raise."""
        gen = self._make()
        asyncio.run(gen.aclose())
        asyncio.run(gen.aclose())

    def test_aclose_swallows_close_failures(self) -> None:
        """aclose() never lets a flaky close() propagate (defensive shutdown)."""
        gen = self._make()
        async_client = MagicMock()
        async_client.close = AsyncMock(side_effect=RuntimeError("boom"))
        gen._cached_async_client = async_client

        asyncio.run(gen.aclose())
        assert gen._cached_async_client is None

    def test_aclose_accepts_sync_close_callables(self) -> None:
        """Some client/credential wrappers expose a sync close()."""
        gen = self._make()
        async_client = MagicMock()
        async_client.close = MagicMock(return_value=None)
        gen._cached_async_client = async_client

        asyncio.run(gen.aclose())
        async_client.close.assert_called_once()
