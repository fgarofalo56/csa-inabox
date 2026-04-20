"""RAG (Retrieval-Augmented Generation) pipeline package.

Legacy imports from :mod:`.pipeline` continue to work.  New code
should import from this package root to get the preferred
:class:`RAGService` facade.  See ADR 0017 for the CSA-0133 split.
"""

from __future__ import annotations

from .chunker import Chunk, DocumentChunker
from .config import RAGSettings, get_settings
from .generate import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE, build_prompt, generate_answer_async
from .indexer import EmbeddingGenerator
from .models import AnswerResponse, Citation, ContextChunk, IndexReport
from .pipeline import RAGPipeline, create_pipeline_from_config
from .rerank import RerankPolicy, apply_policy
from .retriever import SearchResult, VectorStore
from .service import (
    RAGService,
    SupportsAsyncEmbed,
    SupportsAsyncGenerate,
    SupportsAsyncSearch,
)

__all__ = [
    "SYSTEM_PROMPT",
    "USER_PROMPT_TEMPLATE",
    "AnswerResponse",
    "Chunk",
    "Citation",
    "ContextChunk",
    "DocumentChunker",
    "EmbeddingGenerator",
    "IndexReport",
    "RAGPipeline",
    "RAGService",
    "RAGSettings",
    "RerankPolicy",
    "SearchResult",
    "SupportsAsyncEmbed",
    "SupportsAsyncGenerate",
    "SupportsAsyncSearch",
    "VectorStore",
    "apply_policy",
    "build_prompt",
    "create_pipeline_from_config",
    "generate_answer_async",
    "get_settings",
]
