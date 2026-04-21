"""Vector store and retrieval for the RAG pipeline (CSA-0133).

:class:`VectorStore` wraps Azure AI Search's sync and async clients.
Semantic reranking is a toggle; see :mod:`.rerank` for policy helpers.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from csa_platform.common.logging import get_logger

from .chunker import Chunk

if TYPE_CHECKING:  # pragma: no cover
    from azure.search.documents import SearchClient
    from azure.search.documents.aio import SearchClient as AsyncSearchClient
    from azure.search.documents.indexes import SearchIndexClient

logger = get_logger(__name__)


@dataclass
class SearchResult:
    """A single vector-search result."""

    id: str
    text: str
    score: float
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)


class VectorStore:
    """Azure AI Search integration for vector storage and retrieval.

    Args:
        endpoint: Azure AI Search service endpoint.
        api_key: Admin API key (empty -> managed identity).
        index_name: Name of the search index.
        embedding_dimensions: Vector dimensionality.
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        index_name: str = "csa-rag-index",
        embedding_dimensions: int = 1536,
    ) -> None:
        self.endpoint = endpoint
        self.api_key = api_key
        self.index_name = index_name
        self.embedding_dimensions = embedding_dimensions
        self._search_client: SearchClient | None = None
        self._index_client: SearchIndexClient | None = None
        self._async_search_client: AsyncSearchClient | None = None
        self._async_credential: Any = None

    # -- client plumbing ----------------------------------------------------

    def _make_credential(self) -> Any:
        if self.api_key:
            from azure.core.credentials import AzureKeyCredential

            return AzureKeyCredential(self.api_key)
        from azure.identity import DefaultAzureCredential

        return DefaultAzureCredential()

    def _make_async_credential(self) -> Any:
        """Create an async credential; ``AzureKeyCredential`` is fine as-is."""
        if self.api_key:
            from azure.core.credentials import AzureKeyCredential

            return AzureKeyCredential(self.api_key)
        from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

        return AsyncDefaultAzureCredential()

    def _get_index_client(self) -> SearchIndexClient:
        if self._index_client is None:
            from azure.search.documents.indexes import SearchIndexClient

            self._index_client = SearchIndexClient(
                endpoint=self.endpoint, credential=self._make_credential()
            )
        return self._index_client

    def _get_search_client(self) -> SearchClient:
        if self._search_client is None:
            from azure.search.documents import SearchClient

            self._search_client = SearchClient(
                endpoint=self.endpoint,
                index_name=self.index_name,
                credential=self._make_credential(),
            )
        return self._search_client

    def _get_async_search_client(self) -> AsyncSearchClient:
        """Lazily build and cache the async search client for connection pooling."""
        if self._async_search_client is None:
            from azure.search.documents.aio import SearchClient as AsyncSearchClient

            self._async_credential = self._make_async_credential()
            self._async_search_client = AsyncSearchClient(
                endpoint=self.endpoint,
                index_name=self.index_name,
                credential=self._async_credential,
            )
        return self._async_search_client

    # -- index management ---------------------------------------------------

    def create_index(self) -> None:
        """Create or update the RAG search index (vector + semantic config)."""
        from azure.search.documents.indexes.models import (
            HnswAlgorithmConfiguration,
            SearchableField,
            SearchField,
            SearchFieldDataType,
            SearchIndex,
            SemanticConfiguration,
            SemanticField,
            SemanticPrioritizedFields,
            SemanticSearch,
            SimpleField,
            VectorSearch,
            VectorSearchProfile,
        )

        fields = [
            SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
            SearchableField(name="content", type=SearchFieldDataType.String),
            SimpleField(name="source", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="metadata", type=SearchFieldDataType.String),
            SearchField(
                name="content_vector",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=self.embedding_dimensions,
                vector_search_profile_name="csa-vector-profile",
            ),
        ]
        vector_search = VectorSearch(
            algorithms=[HnswAlgorithmConfiguration(name="csa-hnsw")],
            profiles=[
                VectorSearchProfile(
                    name="csa-vector-profile",
                    algorithm_configuration_name="csa-hnsw",
                )
            ],
        )
        semantic_search = SemanticSearch(
            configurations=[
                SemanticConfiguration(
                    name="csa-semantic-config",
                    prioritized_fields=SemanticPrioritizedFields(
                        content_fields=[SemanticField(field_name="content")],
                    ),
                )
            ]
        )
        index = SearchIndex(
            name=self.index_name,
            fields=fields,
            vector_search=vector_search,
            semantic_search=semantic_search,
        )
        self._get_index_client().create_or_update_index(index)
        logger.info("search_index.created_or_updated", index_name=self.index_name)

    # -- CRUD ---------------------------------------------------------------

    def upsert_documents(self, chunks: list[Chunk], embeddings: list[list[float]]) -> int:
        """Upsert chunks + embeddings, returning the uploaded count."""
        if len(chunks) != len(embeddings):
            raise ValueError(f"Chunk count ({len(chunks)}) must match embedding count ({len(embeddings)})")

        documents = [
            {
                "id": chunk.id,
                "content": chunk.text,
                "source": chunk.source,
                "metadata": json.dumps(chunk.metadata),
                "content_vector": embedding,
            }
            for chunk, embedding in zip(chunks, embeddings, strict=True)
        ]

        client = self._get_search_client()
        uploaded = 0
        batch_size = 1000  # Azure AI Search upload batch limit
        for i in range(0, len(documents), batch_size):
            batch = documents[i : i + batch_size]
            result = client.upload_documents(documents=batch)
            uploaded += sum(1 for r in result if r.succeeded)
            logger.info("upsert_batch", batch_start=i, batch_end=i + len(batch), succeeded=uploaded)
        return uploaded

    def delete_documents(self, document_ids: list[str]) -> int:
        """Delete documents by ID, returning the deleted count."""
        result = self._get_search_client().delete_documents(
            documents=[{"id": d} for d in document_ids]
        )
        deleted = sum(1 for r in result if r.succeeded)
        logger.info("documents.deleted", count=deleted, index_name=self.index_name)
        return deleted

    # -- query --------------------------------------------------------------

    @staticmethod
    def _build_search_kwargs(
        query_vector: list[float],
        query_text: str,
        top_k: int,
        filters: str | None,
        use_semantic_reranker: bool,
    ) -> dict[str, Any]:
        from azure.search.documents.models import VectorizedQuery

        kwargs: dict[str, Any] = {
            "vector_queries": [
                VectorizedQuery(
                    vector=query_vector,
                    k_nearest_neighbors=top_k,
                    fields="content_vector",
                )
            ],
            "top": top_k,
        }
        if query_text:
            kwargs["search_text"] = query_text
        if filters:
            kwargs["filter"] = filters
        if use_semantic_reranker:
            kwargs["query_type"] = "semantic"
            kwargs["semantic_configuration_name"] = "csa-semantic-config"
        return kwargs

    @staticmethod
    def _doc_to_result(doc: dict[str, Any], score_threshold: float) -> SearchResult | None:
        score = doc.get("@search.score", 0.0)
        reranker_score = doc.get("@search.reranker_score")
        effective_score = reranker_score if reranker_score is not None else score
        if effective_score < score_threshold:
            return None
        metadata: dict[str, Any] = {}
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            metadata = json.loads(doc.get("metadata", "{}"))
        return SearchResult(
            id=doc["id"],
            text=doc.get("content", ""),
            score=effective_score,
            source=doc.get("source", ""),
            metadata=metadata,
        )

    def search(
        self,
        query_vector: list[float],
        query_text: str = "",
        top_k: int = 5,
        score_threshold: float = 0.0,
        filters: str | None = None,
        use_semantic_reranker: bool = False,
    ) -> list[SearchResult]:
        """Sync vector search with optional hybrid text + semantic rerank."""
        kwargs = self._build_search_kwargs(
            query_vector, query_text, top_k, filters, use_semantic_reranker
        )
        response = self._get_search_client().search(**kwargs)
        results: list[SearchResult] = []
        for doc in response:
            r = self._doc_to_result(doc, score_threshold)
            if r is not None:
                results.append(r)
        return results

    async def search_async(
        self,
        query_vector: list[float],
        query_text: str = "",
        top_k: int = 5,
        score_threshold: float = 0.0,
        filters: str | None = None,
        use_semantic_reranker: bool = False,
    ) -> list[SearchResult]:
        """Async variant of :meth:`search` using the async Azure AI Search SDK."""
        kwargs = self._build_search_kwargs(
            query_vector, query_text, top_k, filters, use_semantic_reranker
        )
        response = await self._get_async_search_client().search(**kwargs)
        results: list[SearchResult] = []
        async for doc in response:
            r = self._doc_to_result(doc, score_threshold)
            if r is not None:
                results.append(r)
        return results

    async def aclose(self) -> None:
        """Close the cached async client + release HTTP connections (idempotent)."""
        if self._async_search_client is not None:
            with contextlib.suppress(Exception):
                await self._async_search_client.close()
            self._async_search_client = None
        if self._async_credential is not None:
            close = getattr(self._async_credential, "close", None)
            if close is not None:
                with contextlib.suppress(Exception):
                    result = close()
                    if asyncio.iscoroutine(result):
                        await result
            self._async_credential = None


__all__ = ["SearchResult", "VectorStore"]
