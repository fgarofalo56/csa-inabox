"""High-level RAG service facade (CSA-0133).

:class:`RAGService` is the entry point new routers should use.  It
wraps :mod:`.indexer`, :mod:`.retriever`, :mod:`.rerank`, and
:mod:`.generate` behind narrow async methods and owns the lifecycle
of the Azure clients.  Behaviour is equivalent to
:class:`~csa_platform.ai_integration.rag.pipeline.RAGPipeline`; see
ADR 0017 for the migration story.

CSA-0110 audit (2026-04-20): every method touching the network
(``ingest``, ``query``, ``close``) is ``async def``; the embedder and
retriever dependencies are structurally typed as ``SupportsAsync*``.
The only sync entry points remaining on the codebase are on
:class:`~csa_platform.ai_integration.rag.pipeline.RAGPipeline`
(legacy shim) and the CLI in :mod:`.pipeline` (argparse wrapper).
Explicit :meth:`ingest_async` / :meth:`query_async` aliases are
provided so thin sync wrappers (CLI, external orchestrators) can pick
the async surface unambiguously.
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Sequence
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any, Protocol, cast

from csa_platform.common.logging import get_logger

from .chunker import Chunk, DocumentChunker
from .generate import build_prompt, generate_answer_async
from .models import AnswerResponse, Citation, ContextChunk, IndexReport
from .rate_limit import AzureOpenAIRateLimiter, get_default_limiter
from .rerank import RerankPolicy, apply_policy
from .retriever import SearchResult
from .telemetry import observe_chunk_count, observe_request_latency

if TYPE_CHECKING:  # pragma: no cover
    from .config import RAGSettings

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Dependency protocols (structural typing for DI + tests)
# ---------------------------------------------------------------------------


class SupportsAsyncEmbed(Protocol):
    """Protocol implemented by the async embedder surface we rely on."""

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]: ...

    def embed_texts(self, texts: list[str]) -> list[list[float]]:  # sync fallback
        ...


class SupportsAsyncSearch(Protocol):
    """Protocol implemented by the async retriever surface we rely on."""

    async def search_async(
        self,
        query_vector: list[float],
        query_text: str = "",
        top_k: int = 5,
        score_threshold: float = 0.0,
        filters: str | None = None,
        use_semantic_reranker: bool = False,
    ) -> list[SearchResult]: ...

    def upsert_documents(self, chunks: list[Chunk], embeddings: list[list[float]]) -> int: ...


class SupportsAsyncGenerate(Protocol):
    """Protocol for the async chat client used at generation time."""

    chat: Any


# ---------------------------------------------------------------------------
# Service facade
# ---------------------------------------------------------------------------


class RAGService:
    """High-level RAG facade.

    Args:
        settings: Top-level :class:`RAGSettings` aggregate.
        embedder: Async-capable embedder.
        retriever: Vector store / retriever.
        chunker: Document chunker (built from ``settings`` when omitted).
        chat_client: Explicit async chat client; lazily built otherwise.
        rerank_policy: Override the semantic rerank policy.
    """

    def __init__(
        self,
        settings: RAGSettings,
        *,
        embedder: SupportsAsyncEmbed,
        retriever: SupportsAsyncSearch,
        chunker: DocumentChunker | None = None,
        chat_client: SupportsAsyncGenerate | None = None,
        rerank_policy: RerankPolicy | None = None,
        rate_limiter: AzureOpenAIRateLimiter | None = None,
    ) -> None:
        self.settings = settings
        self.embedder = embedder
        self.retriever = retriever
        self.chunker = chunker or DocumentChunker(
            chunk_size=settings.chunk.chunk_size,
            chunk_overlap=settings.chunk.chunk_overlap,
            min_chunk_length=settings.chunk.min_chunk_length,
            split_strategy=settings.chunk.split_strategy,
        )
        self._chat_client: SupportsAsyncGenerate | None = chat_client
        self._owns_chat_client = chat_client is None
        self.rerank_policy = rerank_policy or RerankPolicy(
            enabled=settings.search.use_semantic_reranker,
            configuration_name=settings.azure_search.semantic_config_name,
        )
        # CSA-0108: share a single limiter across generator + indexer so
        # RPM/TPM is enforced across both surfaces even when each builds
        # its own Azure OpenAI client.
        self._rate_limiter = rate_limiter or get_default_limiter()
        self._closed = False

    # -- factories ----------------------------------------------------------

    @classmethod
    def from_settings(cls, settings: RAGSettings | None = None) -> RAGService:
        """Build a service wired to real Azure clients."""
        from .config import get_settings
        from .indexer import EmbeddingGenerator
        from .retriever import VectorStore

        resolved = settings or get_settings()
        embedder = EmbeddingGenerator(
            endpoint=resolved.azure_openai.endpoint,
            api_key=resolved.azure_openai.api_key,
            deployment=resolved.azure_openai.embedding_deployment,
            api_version=resolved.azure_openai.api_version,
            dimensions=resolved.azure_openai.embedding_dimensions,
            batch_size=resolved.embedding_batch.batch_size,
            max_concurrent=resolved.embedding_batch.max_concurrent_requests,
        )
        retriever = VectorStore(
            endpoint=resolved.azure_search.endpoint,
            api_key=resolved.azure_search.api_key,
            index_name=resolved.azure_search.index_name,
            embedding_dimensions=resolved.azure_openai.embedding_dimensions,
        )
        return cls(resolved, embedder=embedder, retriever=retriever)

    # -- internal chat client plumbing --------------------------------------

    def _get_chat_client(self) -> SupportsAsyncGenerate:
        """Return the async chat client, constructing one on first use."""
        if self._chat_client is not None:
            return self._chat_client

        from openai import AsyncAzureOpenAI

        aoai = self.settings.azure_openai
        client: AsyncAzureOpenAI
        if aoai.api_key:
            client = AsyncAzureOpenAI(
                azure_endpoint=aoai.endpoint,
                api_key=aoai.api_key,
                api_version=aoai.api_version,
            )
        else:
            from azure.identity import get_bearer_token_provider
            from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

            credential = AsyncDefaultAzureCredential()
            token_provider = get_bearer_token_provider(
                credential,  # type: ignore[arg-type]  # async cred accepted at runtime
                "https://cognitiveservices.azure.com/.default",
            )
            client = AsyncAzureOpenAI(
                azure_endpoint=aoai.endpoint,
                azure_ad_token_provider=token_provider,
                api_version=aoai.api_version,
            )
        # AsyncAzureOpenAI satisfies SupportsAsyncGenerate structurally.
        self._chat_client = cast("SupportsAsyncGenerate", client)
        self._owns_chat_client = True
        return self._chat_client

    # -- public API ---------------------------------------------------------

    async def ingest(
        self,
        root: Path,
        *,
        dry_run: bool = False,
        extensions: Sequence[str] = (".txt", ".md", ".json", ".csv"),
        metadata: dict[str, Any] | None = None,
    ) -> IndexReport:
        """Ingest a file or directory tree into the vector store (async)."""
        self._ensure_open()
        ingest_start = time.perf_counter()

        files: list[Path]
        if root.is_file():
            files = [root]
        elif root.is_dir():
            files = sorted(
                p for ext in extensions for p in root.rglob(f"*{ext}") if p.is_file()
            )
        else:
            raise FileNotFoundError(f"Ingest root not found: {root}")

        total_chunks = 0
        scanned = 0
        for path in files:
            scanned += 1
            try:
                chunks = self.chunker.chunk_file(path, metadata=metadata)
            except Exception:
                logger.exception("rag_service.chunk_failed", path=str(path))
                continue
            if not chunks:
                continue
            texts = [c.text for c in chunks]
            # Async embed path picks up concurrency when many files are in play.
            embeddings = await self.embedder.embed_texts_async(texts)
            if dry_run:
                total_chunks += len(chunks)
                continue
            stored = self.retriever.upsert_documents(chunks, embeddings)
            total_chunks += stored
            logger.info(
                "rag_service.file_ingested",
                path=str(path),
                chunks=stored,
                dry_run=dry_run,
            )

        elapsed = time.perf_counter() - ingest_start
        observe_request_latency(
            operation="ingest",
            model=self.settings.azure_openai.embedding_deployment,
            seconds=elapsed,
        )
        observe_chunk_count("ingest", total_chunks)
        logger.info(
            "rag_service.ingest_complete",
            files=scanned,
            chunks=total_chunks,
            dry_run=dry_run,
            elapsed_ms=int(elapsed * 1000),
        )
        return IndexReport(files_scanned=scanned, chunks_stored=total_chunks, dry_run=dry_run)

    async def query(
        self,
        question: str,
        *,
        k: int = 6,
        with_rerank: bool = True,
        with_citations: bool = True,
        filters: str | None = None,
        score_threshold: float | None = None,
        system_prompt: str | None = None,
    ) -> AnswerResponse:
        """Embed -> search -> (rerank) -> generate.  Refuses on no context."""
        self._ensure_open()
        start = time.perf_counter()
        threshold = (
            score_threshold if score_threshold is not None else self.settings.search.score_threshold
        )
        use_reranker = with_rerank and self.rerank_policy.enabled

        embeddings = await self.embedder.embed_texts_async([question])
        raw_results = await self.retriever.search_async(
            query_vector=embeddings[0],
            query_text=question,
            top_k=k,
            score_threshold=threshold,
            filters=filters,
            use_semantic_reranker=use_reranker,
        )
        results = apply_policy(
            raw_results,
            self.rerank_policy if with_rerank else RerankPolicy.disabled(),
        )

        if not results:
            logger.info(
                "rag_service.query_no_results",
                question_len=len(question),
                elapsed_ms=int((time.perf_counter() - start) * 1000),
            )
            return AnswerResponse(
                answer="No relevant context found in the knowledge base for this question.",
                sources=[],
                context_chunks=[],
            )

        user_message, _ = build_prompt(question, results)
        client = self._get_chat_client()
        answer = await generate_answer_async(
            client=client,  # type: ignore[arg-type]  # protocol-typed duck
            deployment=self.settings.azure_openai.chat_deployment,
            user_message=user_message,
            system_prompt=system_prompt,
            max_tokens=self.settings.azure_openai.chat_max_tokens,
            temperature=self.settings.azure_openai.chat_temperature,
            rate_limiter=self._rate_limiter,
        )

        sources = (
            [
                Citation(
                    id=r.id,
                    source=r.source,
                    score=r.score,
                    metadata=dict(r.metadata),
                    # CSA-0099 — carry the chunk-time section anchor through
                    # to the citation when the retriever returned it in
                    # metadata (e.g. '#setup', 'Page 3', 'Heading: ...').
                    section_anchor=r.metadata.get("section_anchor"),
                )
                for r in results
            ]
            if with_citations
            else []
        )
        context_chunks = [
            ContextChunk(text=r.text, source=r.source, score=r.score) for r in results
        ]

        elapsed = time.perf_counter() - start
        observe_request_latency(
            operation="query",
            model=self.settings.azure_openai.chat_deployment,
            seconds=elapsed,
        )
        observe_chunk_count("query", len(results))
        logger.info(
            "rag_service.query_complete",
            question_len=len(question),
            chunks=len(results),
            elapsed_ms=int(elapsed * 1000),
        )
        return AnswerResponse(answer=answer, sources=sources, context_chunks=context_chunks)

    # -- explicit async aliases (CSA-0110) ----------------------------------
    #
    # ``ingest`` + ``query`` are already ``async def``; ``ingest_async`` /
    # ``query_async`` exist as named shims so callers (CLI wrappers,
    # external orchestrators) can pick the async surface unambiguously
    # without relying on reflection.  They take identical kwargs — any
    # future divergence should happen on the pair, not one side.

    async def ingest_async(
        self,
        root: Path,
        *,
        dry_run: bool = False,
        extensions: Sequence[str] = (".txt", ".md", ".json", ".csv"),
        metadata: dict[str, Any] | None = None,
    ) -> IndexReport:
        """Explicit async alias of :meth:`ingest` (CSA-0110)."""
        return await self.ingest(
            root,
            dry_run=dry_run,
            extensions=extensions,
            metadata=metadata,
        )

    async def query_async(
        self,
        question: str,
        *,
        k: int = 6,
        with_rerank: bool = True,
        with_citations: bool = True,
        filters: str | None = None,
        score_threshold: float | None = None,
        system_prompt: str | None = None,
    ) -> AnswerResponse:
        """Explicit async alias of :meth:`query` (CSA-0110)."""
        return await self.query(
            question,
            k=k,
            with_rerank=with_rerank,
            with_citations=with_citations,
            filters=filters,
            score_threshold=score_threshold,
            system_prompt=system_prompt,
        )

    # -- lifecycle ----------------------------------------------------------

    async def close(self) -> None:
        """Release async resources (idempotent)."""
        if self._closed:
            return
        self._closed = True

        if self._chat_client is not None and self._owns_chat_client:
            close = getattr(self._chat_client, "close", None)
            if close is not None:
                with contextlib.suppress(Exception):
                    result = close()
                    if hasattr(result, "__await__"):
                        await result
            self._chat_client = None

        aclose = getattr(self.retriever, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()

    async def __aenter__(self) -> RAGService:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.close()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("RAGService is closed; create a new instance to continue.")


__all__ = [
    "RAGService",
    "SupportsAsyncEmbed",
    "SupportsAsyncGenerate",
    "SupportsAsyncSearch",
]
