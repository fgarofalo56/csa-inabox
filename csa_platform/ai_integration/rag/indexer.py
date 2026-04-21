"""Embedding generation for the RAG pipeline (CSA-0133).

:class:`EmbeddingGenerator` owns the Azure OpenAI embedding deployment,
batch sizing, and concurrency semaphore.  Both sync and async paths
are preserved; the async client is cached across calls so connection
pools survive between ``embed_texts_async`` invocations.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from csa_platform.common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from openai import AzureOpenAI

logger = get_logger(__name__)


class EmbeddingGenerator:
    """Generate text embeddings via Azure OpenAI.

    Args:
        endpoint: Azure OpenAI endpoint URL.
        api_key: API key (empty -> ``DefaultAzureCredential``).
        deployment: Embedding model deployment name.
        api_version: Azure OpenAI API version.
        dimensions: Embedding vector dimensionality.
        batch_size: Number of texts per API call.
        max_concurrent: Maximum parallel API requests.
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        deployment: str = "text-embedding-3-small",
        api_version: str = "2024-06-01",
        dimensions: int = 1536,
        batch_size: int = 100,
        max_concurrent: int = 5,
    ) -> None:
        self.endpoint = endpoint
        self.api_key = api_key
        self.deployment = deployment
        self.api_version = api_version
        self.dimensions = dimensions
        self.batch_size = batch_size
        self.max_concurrent = max_concurrent
        self._client: AzureOpenAI | None = None
        self._cached_async_client: Any = None
        # CSA-0106: track the async credential separately so aclose()
        # can dispose it on shutdown — AsyncAzureOpenAI.close() does not
        # reach into the bearer-token provider's underlying credential.
        self._cached_async_credential: Any = None

    def _get_client(self) -> AzureOpenAI:
        """Lazily initialise the sync Azure OpenAI client."""
        if self._client is None:
            from openai import AzureOpenAI

            if self.api_key:
                self._client = AzureOpenAI(
                    azure_endpoint=self.endpoint,
                    api_key=self.api_key,
                    api_version=self.api_version,
                )
            else:
                from azure.identity import DefaultAzureCredential, get_bearer_token_provider

                token_provider = get_bearer_token_provider(
                    DefaultAzureCredential(),
                    "https://cognitiveservices.azure.com/.default",
                )
                self._client = AzureOpenAI(
                    azure_endpoint=self.endpoint,
                    azure_ad_token_provider=token_provider,
                    api_version=self.api_version,
                )
        return self._client

    @property
    def _async_openai_client(self) -> Any:
        """Lazily build and cache the async Azure OpenAI client."""
        if not hasattr(self, "_cached_async_client") or self._cached_async_client is None:
            from openai import AsyncAzureOpenAI

            if self.api_key:
                self._cached_async_client = AsyncAzureOpenAI(
                    azure_endpoint=self.endpoint,
                    api_key=self.api_key,
                    api_version=self.api_version,
                )
            else:
                from azure.identity import get_bearer_token_provider
                from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

                credential = AsyncDefaultAzureCredential()
                # Retain a reference so aclose() can dispose it later.
                self._cached_async_credential = credential
                token_provider = get_bearer_token_provider(
                    credential,  # type: ignore[arg-type]  # async cred accepted at runtime
                    "https://cognitiveservices.azure.com/.default",
                )
                self._cached_async_client = AsyncAzureOpenAI(
                    azure_endpoint=self.endpoint,
                    azure_ad_token_provider=token_provider,
                    api_version=self.api_version,
                )
        return self._cached_async_client

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Sync batched embedding generation."""
        client = self._get_client()
        all_embeddings: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            logger.info("Embedding batch", batch_start=i, batch_end=i + len(batch), total=len(texts))
            response = client.embeddings.create(
                input=batch,
                model=self.deployment,
                dimensions=self.dimensions,
            )
            all_embeddings.extend(item.embedding for item in response.data)
        return all_embeddings

    def embed_single(self, text: str) -> list[float]:
        """Single-text convenience wrapper around :meth:`embed_texts`."""
        return self.embed_texts([text])[0]

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        """Async batched embedding generation.

        Uses a semaphore to bound concurrency at :attr:`max_concurrent`.
        The underlying ``AsyncAzureOpenAI`` client is cached across calls.
        """
        async_client = self._async_openai_client
        semaphore = asyncio.Semaphore(self.max_concurrent)
        all_embeddings: list[list[float]] = [[] for _ in texts]

        async def _embed_batch(start: int, batch: list[str]) -> None:
            async with semaphore:
                logger.info("async_embedding_batch", batch_start=start, batch_end=start + len(batch))
                response = await async_client.embeddings.create(
                    input=batch,
                    model=self.deployment,
                    dimensions=self.dimensions,
                )
                for j, item in enumerate(response.data):
                    all_embeddings[start + j] = item.embedding

        tasks = [
            asyncio.create_task(_embed_batch(i, texts[i : i + self.batch_size]))
            for i in range(0, len(texts), self.batch_size)
        ]
        await asyncio.gather(*tasks)
        # Cached client persists across calls; do not close it here.
        return all_embeddings

    async def aclose(self) -> None:
        """Release the async Azure OpenAI client + credential (CSA-0106).

        Call this from your FastAPI shutdown / lifespan exit. Silently
        tolerates a generator that has never emitted an async client —
        closing is idempotent. Safe to call multiple times.
        """
        client = self._cached_async_client
        self._cached_async_client = None
        if client is not None:
            close = getattr(client, "close", None)
            if close is not None:
                try:
                    result = close()
                    if hasattr(result, "__await__"):
                        await result
                except Exception as exc:  # pragma: no cover — defensive
                    logger.warning("async_openai_client_close_failed", error=str(exc))

        credential = self._cached_async_credential
        self._cached_async_credential = None
        if credential is not None:
            close = getattr(credential, "close", None)
            if close is not None:
                try:
                    result = close()
                    if hasattr(result, "__await__"):
                        await result
                except Exception as exc:  # pragma: no cover — defensive
                    logger.warning("async_credential_close_failed", error=str(exc))


__all__ = ["EmbeddingGenerator"]
