"""RAG pipeline compatibility shim (CSA-0133).

Re-export layer preserving the pre-split ``pipeline`` import surface
so ``from ...rag.pipeline import RAGPipeline, DocumentChunker, ...``
keeps working.  New code should prefer :class:`RAGService` (see
:mod:`.service` and ADR 0017).  Moved-out components:
``DocumentChunker``/``Chunk`` -> :mod:`.chunker`; ``EmbeddingGenerator``
-> :mod:`.indexer`; ``VectorStore``/``SearchResult`` -> :mod:`.retriever`;
prompt + async chat -> :mod:`.generate`; rerank -> :mod:`.rerank`;
high-level facade -> :mod:`.service`.
"""

from __future__ import annotations

import argparse
import contextlib
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from csa_platform.common.logging import configure_structlog, get_logger

from .chunker import Chunk, DocumentChunker
from .generate import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE
from .indexer import EmbeddingGenerator
from .retriever import SearchResult, VectorStore

if TYPE_CHECKING:  # pragma: no cover - import-time only
    from openai import AsyncAzureOpenAI, AzureOpenAI

configure_structlog(service="rag-pipeline")
logger = get_logger(__name__)


class RAGPipeline:
    """Legacy RAG orchestrator — kept for backwards compatibility.

    New code should use
    :class:`csa_platform.ai_integration.rag.service.RAGService`.  This
    class retains its pre-split behaviour and async paths so existing
    routers and tests continue to pass.
    """

    _SYSTEM_PROMPT = SYSTEM_PROMPT
    _USER_PROMPT_TEMPLATE = USER_PROMPT_TEMPLATE

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
        async_chat_client: AsyncAzureOpenAI | None = None,
    ) -> None:
        self.chunker = chunker
        self.embedder = embedder
        self.vector_store = vector_store
        self.chat_client = chat_client
        self.async_chat_client = async_chat_client
        self._cached_async_chat_client: AsyncAzureOpenAI | None = None
        self.chat_deployment = chat_deployment
        self.chat_max_tokens = chat_max_tokens
        self.chat_temperature = chat_temperature
        self.top_k = top_k
        self.score_threshold = score_threshold
        self.use_semantic_reranker = use_semantic_reranker

    # -- chat client plumbing -----------------------------------------------

    def _get_chat_client(self) -> AzureOpenAI:
        """Return an injected chat client or lazily build one from embedder config."""
        if self.chat_client is not None:
            return self.chat_client
        from openai import AzureOpenAI

        if hasattr(self.embedder, "api_key") and self.embedder.api_key:
            return AzureOpenAI(
                azure_endpoint=self.embedder.endpoint,
                api_key=self.embedder.api_key,
                api_version=self.embedder.api_version,
            )
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider

        token_provider = get_bearer_token_provider(
            DefaultAzureCredential(),
            "https://cognitiveservices.azure.com/.default",
        )
        return AzureOpenAI(
            azure_endpoint=self.embedder.endpoint,
            azure_ad_token_provider=token_provider,
            api_version=self.embedder.api_version,
        )

    def _get_async_chat_client(self) -> AsyncAzureOpenAI:
        """Return an injected async chat client or lazily build one."""
        if self.async_chat_client is not None:
            return self.async_chat_client
        if self._cached_async_chat_client is not None:
            return self._cached_async_chat_client

        from openai import AsyncAzureOpenAI

        if hasattr(self.embedder, "api_key") and self.embedder.api_key:
            self._cached_async_chat_client = AsyncAzureOpenAI(
                azure_endpoint=self.embedder.endpoint,
                api_key=self.embedder.api_key,
                api_version=self.embedder.api_version,
            )
        else:
            from azure.identity import get_bearer_token_provider
            from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

            credential = AsyncDefaultAzureCredential()
            token_provider = get_bearer_token_provider(
                credential,  # type: ignore[arg-type]  # async cred accepted at runtime
                "https://cognitiveservices.azure.com/.default",
            )
            self._cached_async_chat_client = AsyncAzureOpenAI(
                azure_endpoint=self.embedder.endpoint,
                azure_ad_token_provider=token_provider,
                api_version=self.embedder.api_version,
            )
        return self._cached_async_chat_client

    # -- Ingestion ----------------------------------------------------------

    def ingest_file(self, path: Path, metadata: dict[str, Any] | None = None) -> int:
        """Chunk, embed, and store a single file. Returns the chunk count."""
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
        """Walk *directory* and ingest every matching file."""
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
        """Chunk, embed, and store raw *text*."""
        chunks = self.chunker.chunk_text(text, source=source, metadata=metadata)
        if not chunks:
            return 0
        texts = [c.text for c in chunks]
        embeddings = self.embedder.embed_texts(texts)
        return self.vector_store.upsert_documents(chunks, embeddings)

    # -- Querying -----------------------------------------------------------

    def _build_augmented_prompt(
        self, question: str, results: list[SearchResult]
    ) -> tuple[str, list[dict[str, Any]]]:
        """Produce the user-side prompt and the sources payload."""
        context_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        for r in results:
            context_parts.append(f"[Source: {r.source}]\n{r.text}")
            sources.append(
                {"id": r.id, "source": r.source, "score": r.score, "metadata": r.metadata}
            )
        user_message = self._USER_PROMPT_TEMPLATE.format(
            context="\n\n".join(context_parts),
            question=question,
        )
        return user_message, sources

    @staticmethod
    def _context_chunks(results: list[SearchResult]) -> list[dict[str, Any]]:
        """Legacy ``context_chunks`` shape used in the response dict."""
        return [{"text": r.text, "source": r.source, "score": r.score} for r in results]

    def query(
        self,
        question: str,
        filters: str | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Sync RAG query: embed -> search -> augment -> generate."""
        query_vector = self.embedder.embed_single(question)
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

        user_message, sources = self._build_augmented_prompt(question, results)
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
            "context_chunks": self._context_chunks(results),
        }

    async def query_async(
        self,
        question: str,
        filters: str | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Async RAG query using native async SDKs end-to-end."""
        embeddings = await self.embedder.embed_texts_async([question])
        query_vector = embeddings[0]
        results = await self.vector_store.search_async(
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

        user_message, sources = self._build_augmented_prompt(question, results)
        client = self._get_async_chat_client()
        response = await client.chat.completions.create(
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
            "context_chunks": self._context_chunks(results),
        }

    async def aclose(self) -> None:
        """Close the cached async chat client and delegate to the vector store."""
        if self._cached_async_chat_client is not None:
            with contextlib.suppress(Exception):
                await self._cached_async_chat_client.close()
            self._cached_async_chat_client = None
        aclose = getattr(self.vector_store, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()


# ---------------------------------------------------------------------------
# Factory + CLI (preserved for the legacy `python -m ...pipeline` entry point)
# ---------------------------------------------------------------------------


def create_pipeline_from_config() -> RAGPipeline:
    """Build a :class:`RAGPipeline` from environment-driven settings."""
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


def _cli_ingest(args: argparse.Namespace) -> None:
    pipeline = create_pipeline_from_config()
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
        description="CSA-in-a-Box RAG Pipeline - ingest documents and query the knowledge base.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_parser = subparsers.add_parser("ingest", help="Ingest documents into the vector store.")
    ingest_parser.add_argument("--source", required=True, help="Path to file or directory to ingest.")
    ingest_parser.add_argument(
        "--extensions",
        default=None,
        help="Comma-separated file extensions to include (e.g. '.txt,.md,.json').",
    )
    ingest_parser.set_defaults(func=_cli_ingest)

    query_parser = subparsers.add_parser("query", help="Query the knowledge base.")
    query_parser.add_argument("--question", required=True, help="Natural-language question to ask.")
    query_parser.add_argument("--filter", default=None, help="OData filter expression.")
    query_parser.set_defaults(func=_cli_query)

    args = parser.parse_args()
    args.func(args)


__all__ = [
    "Chunk",
    "DocumentChunker",
    "EmbeddingGenerator",
    "RAGPipeline",
    "SearchResult",
    "VectorStore",
    "create_pipeline_from_config",
    "main",
]


if __name__ == "__main__":
    main()
