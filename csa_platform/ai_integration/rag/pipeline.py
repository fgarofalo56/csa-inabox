"""RAG (Retrieval-Augmented Generation) pipeline for CSA-in-a-Box.

Provides end-to-end document ingestion (chunk -> embed -> store) and
query (embed query -> search -> augment prompt -> generate) capabilities
using Azure OpenAI and Azure AI Search.

Usage::

    # Ingest documents
    python pipeline.py ingest --source path/to/docs

    # Query the knowledge base
    python pipeline.py query --question "What are the USDA crop yield trends?"

Architecture::

    Documents (ADLS)  ->  DocumentChunker  ->  EmbeddingGenerator
                                                      |
                                                VectorStore (AI Search)
                                                      |
                                          RAGPipeline.query()  ->  GPT-4o
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from governance.common.logging import configure_structlog, get_logger

if TYPE_CHECKING:
    from azure.search.documents import SearchClient
    from azure.search.documents.indexes import SearchIndexClient
    from openai import AzureOpenAI

configure_structlog(service="rag-pipeline")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Document Chunker
# ---------------------------------------------------------------------------


@dataclass
class Chunk:
    """A single chunk of text extracted from a document."""

    id: str
    text: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)
    chunk_index: int = 0


class DocumentChunker:
    """Split documents into overlapping chunks for embedding.

    Supports sentence-based, paragraph-based, and fixed-token splitting
    strategies with configurable chunk size and overlap.

    Args:
        chunk_size: Target number of *characters* per chunk.
        chunk_overlap: Number of overlapping characters between consecutive
            chunks to preserve context across boundaries.
        min_chunk_length: Minimum character length for a chunk to be retained.
        split_strategy: One of ``"sentence"``, ``"paragraph"``, or ``"token"``.
    """

    _SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
    _PARAGRAPH_RE = re.compile(r"\n\s*\n")

    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        min_chunk_length: int = 50,
        split_strategy: str = "sentence",
    ) -> None:
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_length = min_chunk_length
        self.split_strategy = split_strategy

    # -- public API ---------------------------------------------------------

    def chunk_text(self, text: str, source: str = "", metadata: dict[str, Any] | None = None) -> list[Chunk]:
        """Split *text* into a list of :class:`Chunk` objects.

        Args:
            text: The full document text to split.
            source: Source identifier (file path, URL, etc.).
            metadata: Additional metadata to attach to every chunk.

        Returns:
            Ordered list of chunks with unique IDs.
        """
        metadata = metadata or {}
        segments = self._split(text)
        chunks = self._merge_segments(segments)
        result: list[Chunk] = []
        for idx, chunk_text in enumerate(chunks):
            if len(chunk_text.strip()) < self.min_chunk_length:
                continue
            chunk_id = self._make_id(source, idx)
            result.append(
                Chunk(
                    id=chunk_id,
                    text=chunk_text.strip(),
                    source=source,
                    metadata={**metadata, "chunk_index": idx},
                    chunk_index=idx,
                )
            )
        return result

    def chunk_file(self, path: Path, metadata: dict[str, Any] | None = None) -> list[Chunk]:
        """Read a file and return chunks.

        Args:
            path: Path to the text file.
            metadata: Additional metadata.

        Returns:
            List of chunks from the file content.
        """
        text = path.read_text(encoding="utf-8")
        file_meta = {
            "filename": path.name,
            "file_extension": path.suffix,
            **(metadata or {}),
        }
        return self.chunk_text(text, source=str(path), metadata=file_meta)

    # -- internals ----------------------------------------------------------

    def _split(self, text: str) -> list[str]:
        """Split text into atomic segments based on the configured strategy."""
        if self.split_strategy == "paragraph":
            return [p.strip() for p in self._PARAGRAPH_RE.split(text) if p.strip()]
        if self.split_strategy == "sentence":
            return [s.strip() for s in self._SENTENCE_RE.split(text) if s.strip()]
        # token-level: split on whitespace, rejoin in fixed windows
        return text.split()

    def _merge_segments(self, segments: list[str]) -> list[str]:
        """Merge atomic segments into chunks respecting size and overlap."""
        if self.split_strategy == "token":
            return self._merge_tokens(segments)
        return self._merge_text_segments(segments)

    def _merge_text_segments(self, segments: list[str]) -> list[str]:
        """Merge sentence/paragraph segments into chunks."""
        chunks: list[str] = []
        current: list[str] = []
        current_len = 0

        for segment in segments:
            seg_len = len(segment)
            if current_len + seg_len > self.chunk_size and current:
                chunks.append(" ".join(current))
                # Keep overlap: walk backwards to find overlap segments
                overlap_parts: list[str] = []
                overlap_len = 0
                for prev_seg in reversed(current):
                    if overlap_len + len(prev_seg) > self.chunk_overlap:
                        break
                    overlap_parts.insert(0, prev_seg)
                    overlap_len += len(prev_seg)
                current = overlap_parts
                current_len = overlap_len
            current.append(segment)
            current_len += seg_len

        if current:
            chunks.append(" ".join(current))
        return chunks

    def _merge_tokens(self, words: list[str]) -> list[str]:
        """Merge word-level tokens into fixed-size chunks with overlap."""
        chunks: list[str] = []
        step = max(1, self.chunk_size - self.chunk_overlap)
        for i in range(0, len(words), step):
            chunk_words = words[i : i + self.chunk_size]
            chunks.append(" ".join(chunk_words))
        return chunks

    @staticmethod
    def _make_id(source: str, index: int) -> str:
        """Generate a deterministic chunk ID from source and index."""
        raw = f"{source}:{index}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Embedding Generator
# ---------------------------------------------------------------------------


class EmbeddingGenerator:
    """Generate text embeddings using Azure OpenAI.

    Supports batch processing with configurable concurrency and automatic
    retry for transient failures.

    Args:
        endpoint: Azure OpenAI endpoint URL.
        api_key: API key (leave empty to use ``DefaultAzureCredential``).
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

    def _get_client(self) -> AzureOpenAI:
        """Lazily initialise the Azure OpenAI client."""
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

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for a list of texts synchronously.

        Automatically splits into batches of :attr:`batch_size`.

        Args:
            texts: List of text strings to embed.

        Returns:
            List of embedding vectors (one per input text).
        """
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
            batch_embeddings = [item.embedding for item in response.data]
            all_embeddings.extend(batch_embeddings)

        return all_embeddings

    def embed_single(self, text: str) -> list[float]:
        """Generate an embedding for a single text string.

        Args:
            text: The text to embed.

        Returns:
            The embedding vector.
        """
        results = self.embed_texts([text])
        return results[0]

    @property
    def _async_openai_client(self) -> Any:
        """Lazily initialise and cache the async Azure OpenAI client.

        Avoids creating a new ``AsyncAzureOpenAI`` instance on every
        call to :meth:`embed_texts_async`, which is expensive due to
        connection pool setup.
        """
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
                token_provider = get_bearer_token_provider(
                    credential,  # type: ignore[arg-type]  # Azure SDK async credential; type stubs expect sync
                    "https://cognitiveservices.azure.com/.default",
                )
                self._cached_async_client = AsyncAzureOpenAI(
                    azure_endpoint=self.endpoint,
                    azure_ad_token_provider=token_provider,
                    api_version=self.api_version,
                )
        return self._cached_async_client

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for a list of texts asynchronously.

        Uses a semaphore to limit concurrency to :attr:`max_concurrent`
        parallel API requests.  The underlying ``AsyncAzureOpenAI`` client
        is cached across calls to avoid expensive per-call instantiation.

        Args:
            texts: List of text strings to embed.

        Returns:
            List of embedding vectors.
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

        tasks: list[asyncio.Task[None]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            tasks.append(asyncio.create_task(_embed_batch(i, batch)))

        await asyncio.gather(*tasks)
        # Client is cached via _async_openai_client property — do not close it
        # here as it will be reused across calls.
        return all_embeddings


# ---------------------------------------------------------------------------
# Vector Store (Azure AI Search)
# ---------------------------------------------------------------------------


@dataclass
class SearchResult:
    """A single result from a vector search query."""

    id: str
    text: str
    score: float
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)


class VectorStore:
    """Azure AI Search integration for vector storage and retrieval.

    Manages index creation, document upsert, and hybrid/vector search
    with optional semantic reranking.

    Args:
        endpoint: Azure AI Search service endpoint.
        api_key: Admin API key (leave empty for managed identity).
        index_name: Name of the search index.
        embedding_dimensions: Dimensionality of stored vectors.
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

    def _get_index_client(self) -> SearchIndexClient:
        """Lazily initialise the search index client."""
        if self._index_client is None:
            from azure.search.documents.indexes import SearchIndexClient

            credential = self._make_credential()
            self._index_client = SearchIndexClient(
                endpoint=self.endpoint,
                credential=credential,
            )
        return self._index_client

    def _get_search_client(self) -> SearchClient:
        """Lazily initialise the search client."""
        if self._search_client is None:
            from azure.search.documents import SearchClient

            credential = self._make_credential()
            self._search_client = SearchClient(
                endpoint=self.endpoint,
                index_name=self.index_name,
                credential=credential,
            )
        return self._search_client

    def _make_credential(self) -> Any:
        """Create the appropriate credential for Azure AI Search."""
        if self.api_key:
            from azure.core.credentials import AzureKeyCredential

            return AzureKeyCredential(self.api_key)
        from azure.identity import DefaultAzureCredential

        return DefaultAzureCredential()

    def create_index(self) -> None:
        """Create or update the search index with vector and semantic configurations.

        The index schema includes:
        - ``id``: Unique document key.
        - ``content``: Full text of the chunk.
        - ``source``: Source file or URL.
        - ``metadata``: JSON metadata string.
        - ``content_vector``: Dense embedding vector.
        """
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

        semantic_config = SemanticConfiguration(
            name="csa-semantic-config",
            prioritized_fields=SemanticPrioritizedFields(
                content_fields=[SemanticField(field_name="content")],
            ),
        )
        semantic_search = SemanticSearch(configurations=[semantic_config])

        index = SearchIndex(
            name=self.index_name,
            fields=fields,
            vector_search=vector_search,
            semantic_search=semantic_search,
        )

        client = self._get_index_client()
        client.create_or_update_index(index)
        logger.info("search_index.created_or_updated", index_name=self.index_name)

    def upsert_documents(self, chunks: list[Chunk], embeddings: list[list[float]]) -> int:
        """Upsert chunks with their embeddings into the search index.

        Args:
            chunks: List of document chunks.
            embeddings: Corresponding embedding vectors.

        Returns:
            Number of successfully uploaded documents.

        Raises:
            ValueError: If the number of chunks and embeddings do not match.
        """
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
        # Upload in batches of 1000 (AI Search limit)
        uploaded = 0
        batch_size = 1000
        for i in range(0, len(documents), batch_size):
            batch = documents[i : i + batch_size]
            result = client.upload_documents(documents=batch)
            uploaded += sum(1 for r in result if r.succeeded)
            logger.info("upsert_batch", batch_start=i, batch_end=i + len(batch), succeeded=uploaded)

        return uploaded

    def search(
        self,
        query_vector: list[float],
        query_text: str = "",
        top_k: int = 5,
        score_threshold: float = 0.0,
        filters: str | None = None,
        use_semantic_reranker: bool = False,
    ) -> list[SearchResult]:
        """Execute a vector search (optionally hybrid + semantic reranking).

        Args:
            query_vector: The query embedding vector.
            query_text: Optional text query for hybrid search.
            top_k: Maximum number of results to return.
            score_threshold: Minimum similarity score to include.
            filters: OData filter expression.
            use_semantic_reranker: Whether to apply semantic reranking.

        Returns:
            List of :class:`SearchResult` ordered by relevance.
        """
        from azure.search.documents.models import VectorizedQuery

        vector_query = VectorizedQuery(
            vector=query_vector,
            k_nearest_neighbors=top_k,
            fields="content_vector",
        )

        search_kwargs: dict[str, Any] = {
            "vector_queries": [vector_query],
            "top": top_k,
        }

        if query_text:
            search_kwargs["search_text"] = query_text

        if filters:
            search_kwargs["filter"] = filters

        if use_semantic_reranker:
            search_kwargs["query_type"] = "semantic"
            search_kwargs["semantic_configuration_name"] = "csa-semantic-config"

        client = self._get_search_client()
        response = client.search(**search_kwargs)

        results: list[SearchResult] = []
        for doc in response:
            score = doc.get("@search.score", 0.0)
            reranker_score = doc.get("@search.reranker_score")
            effective_score = reranker_score if reranker_score is not None else score

            if effective_score < score_threshold:
                continue

            metadata = {}
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                metadata = json.loads(doc.get("metadata", "{}"))

            results.append(
                SearchResult(
                    id=doc["id"],
                    text=doc.get("content", ""),
                    score=effective_score,
                    source=doc.get("source", ""),
                    metadata=metadata,
                )
            )

        return results

    def delete_documents(self, document_ids: list[str]) -> int:
        """Delete documents from the search index by ID.

        Args:
            document_ids: List of document IDs to delete.

        Returns:
            Number of successfully deleted documents.
        """
        client = self._get_search_client()
        docs_to_delete = [{"id": doc_id} for doc_id in document_ids]
        result = client.delete_documents(documents=docs_to_delete)
        deleted = sum(1 for r in result if r.succeeded)
        logger.info("documents.deleted", count=deleted, index_name=self.index_name)
        return deleted


# ---------------------------------------------------------------------------
# RAG Pipeline
# ---------------------------------------------------------------------------


class RAGPipeline:
    """Orchestrates RAG ingestion and querying.

    Wires together :class:`DocumentChunker`, :class:`EmbeddingGenerator`,
    and :class:`VectorStore` into cohesive ingest and query workflows.

    Args:
        chunker: Document chunker instance.
        embedder: Embedding generator instance.
        vector_store: Vector store instance.
        chat_deployment: Azure OpenAI chat model deployment name.
        chat_max_tokens: Maximum tokens for the generated answer.
        chat_temperature: Temperature for chat completions.
        top_k: Number of context chunks to retrieve.
        score_threshold: Minimum similarity score for retrieved chunks.
        use_semantic_reranker: Whether to apply semantic reranking.
    """

    _SYSTEM_PROMPT = (
        "You are a helpful assistant for the CSA-in-a-Box data platform. "
        "Answer questions based on the provided context from the knowledge base. "
        "If the context does not contain enough information to answer the question, "
        "say so clearly. Always cite the source document when possible."
    )

    _USER_PROMPT_TEMPLATE = (
        "Context from the knowledge base:\n\n"
        "{context}\n\n"
        "---\n\n"
        "Question: {question}\n\n"
        "Answer the question based on the context above. "
        "If the context is insufficient, state what additional information would be needed."
    )

    def __init__(
        self,
        chunker: DocumentChunker,
        embedder: EmbeddingGenerator,
        vector_store: VectorStore,
        chat_deployment: str = "gpt-4o",
        chat_max_tokens: int = 2048,
        chat_temperature: float = 0.1,
        top_k: int = 5,
        score_threshold: float = 0.70,
        use_semantic_reranker: bool = True,
        chat_client: AzureOpenAI | None = None,
    ) -> None:
        self.chunker = chunker
        self.embedder = embedder
        self.vector_store = vector_store
        self.chat_client = chat_client
        self.chat_deployment = chat_deployment
        self.chat_max_tokens = chat_max_tokens
        self.chat_temperature = chat_temperature
        self.top_k = top_k
        self.score_threshold = score_threshold
        self.use_semantic_reranker = use_semantic_reranker

    def _get_chat_client(self) -> AzureOpenAI:
        """Get the chat client. Uses injected client or creates one from config."""
        if self.chat_client is not None:
            return self.chat_client
        # Fallback: create client from same config as embedder
        from openai import AzureOpenAI

        if hasattr(self.embedder, "api_key") and self.embedder.api_key:
            return AzureOpenAI(
                azure_endpoint=self.embedder.endpoint,
                api_key=self.embedder.api_key,
                api_version=self.embedder.api_version,
            )
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider

        credential = DefaultAzureCredential()
        token_provider = get_bearer_token_provider(credential, "https://cognitiveservices.azure.com/.default")
        return AzureOpenAI(
            azure_endpoint=self.embedder.endpoint,
            azure_ad_token_provider=token_provider,
            api_version=self.embedder.api_version,
        )

    # -- Ingestion ----------------------------------------------------------

    def ingest_file(self, path: Path, metadata: dict[str, Any] | None = None) -> int:
        """Ingest a single file: chunk -> embed -> store.

        Args:
            path: Path to the document file.
            metadata: Additional metadata to attach.

        Returns:
            Number of chunks stored.
        """
        logger.info("file.ingesting", path=str(path))
        chunks = self.chunker.chunk_file(path, metadata=metadata)
        if not chunks:
            logger.warning("file.no_chunks", path=str(path))
            return 0

        texts = [c.text for c in chunks]
        embeddings = self.embedder.embed_texts(texts)
        stored = self.vector_store.upsert_documents(chunks, embeddings)
        logger.info("file.stored", chunks=stored, path=str(path))
        return stored

    def ingest_directory(
        self,
        directory: Path,
        extensions: Sequence[str] = (".txt", ".md", ".json", ".csv"),
        metadata: dict[str, Any] | None = None,
    ) -> int:
        """Ingest all matching files from a directory.

        Args:
            directory: Directory to scan for documents.
            extensions: File extensions to include.
            metadata: Additional metadata to attach.

        Returns:
            Total number of chunks stored.
        """
        if not directory.is_dir():
            raise FileNotFoundError(f"Directory not found: {directory}")

        total = 0
        for ext in extensions:
            for file_path in sorted(directory.rglob(f"*{ext}")):
                try:
                    total += self.ingest_file(file_path, metadata=metadata)
                except Exception:
                    logger.exception("file.ingest_failed", path=str(file_path))
        logger.info("directory.ingested", total_chunks=total, directory=str(directory))
        return total

    def ingest_text(
        self,
        text: str,
        source: str = "inline",
        metadata: dict[str, Any] | None = None,
    ) -> int:
        """Ingest raw text: chunk -> embed -> store.

        Args:
            text: The text content to ingest.
            source: Source identifier.
            metadata: Additional metadata.

        Returns:
            Number of chunks stored.
        """
        chunks = self.chunker.chunk_text(text, source=source, metadata=metadata)
        if not chunks:
            return 0
        texts = [c.text for c in chunks]
        embeddings = self.embedder.embed_texts(texts)
        return self.vector_store.upsert_documents(chunks, embeddings)

    # -- Querying -----------------------------------------------------------

    def query(
        self,
        question: str,
        filters: str | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Execute a RAG query: embed question -> search -> augment -> generate.

        Args:
            question: The user's natural-language question.
            filters: Optional OData filter expression for scoping results.
            system_prompt: Optional override for the system prompt.

        Returns:
            Dictionary with keys:
            - ``answer``: The generated answer text.
            - ``sources``: List of source documents used.
            - ``context_chunks``: The retrieved context chunks.
        """
        # 1. Embed the question
        query_vector = self.embedder.embed_single(question)

        # 2. Search for relevant chunks
        results = self.vector_store.search(
            query_vector=query_vector,
            query_text=question,
            top_k=self.top_k,
            score_threshold=self.score_threshold,
            filters=filters,
            use_semantic_reranker=self.use_semantic_reranker,
        )

        if not results:
            return {
                "answer": "No relevant context found in the knowledge base for this question.",
                "sources": [],
                "context_chunks": [],
            }

        # 3. Build augmented prompt
        context_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        for r in results:
            context_parts.append(f"[Source: {r.source}]\n{r.text}")
            sources.append(
                {
                    "id": r.id,
                    "source": r.source,
                    "score": r.score,
                    "metadata": r.metadata,
                }
            )

        context = "\n\n".join(context_parts)
        user_message = self._USER_PROMPT_TEMPLATE.format(
            context=context,
            question=question,
        )

        # 4. Generate answer via Azure OpenAI
        client = self._get_chat_client()
        response = client.chat.completions.create(
            model=self.chat_deployment,
            messages=[
                {"role": "system", "content": system_prompt or self._SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            max_tokens=self.chat_max_tokens,
            temperature=self.chat_temperature,
        )

        answer = response.choices[0].message.content or ""

        return {
            "answer": answer,
            "sources": sources,
            "context_chunks": [{"text": r.text, "source": r.source, "score": r.score} for r in results],
        }

    async def query_async(
        self,
        question: str,
        filters: str | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Async version of :meth:`query`.

        Useful in web frameworks or event-driven architectures.

        Args:
            question: The user's natural-language question.
            filters: Optional OData filter expression.
            system_prompt: Optional system prompt override.

        Returns:
            Same structure as :meth:`query`.
        """
        # For the async path, we run the synchronous pipeline in a thread pool
        # because the underlying Azure SDK clients may not be fully async.
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, lambda: self.query(question, filters=filters, system_prompt=system_prompt)
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_pipeline_from_config() -> RAGPipeline:
    """Create a :class:`RAGPipeline` from environment-driven configuration.

    Reads settings from :func:`config.get_settings` and wires up all
    components.

    Returns:
        A fully configured RAG pipeline instance.
    """
    from .config import get_settings

    settings = get_settings()

    chunker = DocumentChunker(
        chunk_size=settings.chunk.chunk_size,
        chunk_overlap=settings.chunk.chunk_overlap,
        min_chunk_length=settings.chunk.min_chunk_length,
        split_strategy=settings.chunk.split_strategy,
    )

    embedder = EmbeddingGenerator(
        endpoint=settings.azure_openai.endpoint,
        api_key=settings.azure_openai.api_key,
        deployment=settings.azure_openai.embedding_deployment,
        api_version=settings.azure_openai.api_version,
        dimensions=settings.azure_openai.embedding_dimensions,
        batch_size=settings.embedding_batch.batch_size,
        max_concurrent=settings.embedding_batch.max_concurrent_requests,
    )

    vector_store = VectorStore(
        endpoint=settings.azure_search.endpoint,
        api_key=settings.azure_search.api_key,
        index_name=settings.azure_search.index_name,
        embedding_dimensions=settings.azure_openai.embedding_dimensions,
    )

    return RAGPipeline(
        chunker=chunker,
        embedder=embedder,
        vector_store=vector_store,
        chat_deployment=settings.azure_openai.chat_deployment,
        chat_max_tokens=settings.azure_openai.chat_max_tokens,
        chat_temperature=settings.azure_openai.chat_temperature,
        top_k=settings.search.top_k,
        score_threshold=settings.search.score_threshold,
        use_semantic_reranker=settings.search.use_semantic_reranker,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_ingest(args: argparse.Namespace) -> None:
    """Handle the ``ingest`` CLI sub-command."""
    pipeline = create_pipeline_from_config()

    # Ensure index exists
    pipeline.vector_store.create_index()

    source = Path(args.source)
    if source.is_file():
        count = pipeline.ingest_file(source)
    elif source.is_dir():
        exts = tuple(args.extensions.split(",")) if args.extensions else (".txt", ".md", ".json", ".csv")
        count = pipeline.ingest_directory(source, extensions=exts)
    else:
        print(f"Error: {source} is neither a file nor a directory.", file=sys.stderr)
        sys.exit(1)

    print(f"Ingested {count} chunks from {source}")


def _cli_query(args: argparse.Namespace) -> None:
    """Handle the ``query`` CLI sub-command."""
    pipeline = create_pipeline_from_config()
    result = pipeline.query(args.question, filters=args.filter)

    print(f"\nAnswer:\n{result['answer']}\n")
    if result["sources"]:
        print("Sources:")
        for src in result["sources"]:
            print(f"  - {src['source']} (score: {src['score']:.3f})")


def main() -> None:
    """CLI entry point for the RAG pipeline."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box RAG Pipeline — ingest documents and query the knowledge base.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # -- ingest sub-command --
    ingest_parser = subparsers.add_parser("ingest", help="Ingest documents into the vector store.")
    ingest_parser.add_argument("--source", required=True, help="Path to file or directory to ingest.")
    ingest_parser.add_argument(
        "--extensions",
        default=None,
        help="Comma-separated file extensions to include (e.g. '.txt,.md,.json').",
    )
    ingest_parser.set_defaults(func=_cli_ingest)

    # -- query sub-command --
    query_parser = subparsers.add_parser("query", help="Query the knowledge base.")
    query_parser.add_argument("--question", required=True, help="Natural-language question to ask.")
    query_parser.add_argument("--filter", default=None, help="OData filter expression.")
    query_parser.set_defaults(func=_cli_query)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
