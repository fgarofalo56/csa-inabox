"""Configuration for the RAG (Retrieval-Augmented Generation) pipeline.

Centralises all configuration for Azure OpenAI, Azure AI Search, and
chunking/search behaviour.  Values are loaded from environment variables
with sensible defaults so that development, staging, and production
environments can be driven purely by environment configuration.

Usage::

    from .config import get_settings

    settings = get_settings()
    print(settings.azure_openai_endpoint)
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings


class AzureOpenAISettings(BaseSettings):
    """Azure OpenAI service configuration."""

    endpoint: str = Field(
        default="",
        description="Azure OpenAI resource endpoint URL.",
    )
    api_key: str = Field(
        default="",
        description="Azure OpenAI API key. Leave empty to use DefaultAzureCredential.",
    )
    api_version: str = Field(
        default="2024-06-01",
        description="Azure OpenAI API version.",
    )
    embedding_deployment: str = Field(
        default="text-embedding-3-small",
        description="Deployment name for the embedding model.",
    )
    embedding_dimensions: int = Field(
        default=1536,
        description="Dimensionality of the embedding vectors.",
    )
    chat_deployment: str = Field(
        default="gpt-4o",
        description="Deployment name for the chat/completion model.",
    )
    chat_max_tokens: int = Field(
        default=2048,
        description="Maximum tokens for chat completion responses.",
    )
    chat_temperature: float = Field(
        default=0.1,
        description="Temperature for chat completions (lower = more deterministic).",
    )

    model_config = {"env_prefix": "AZURE_OPENAI_"}


class AzureSearchSettings(BaseSettings):
    """Azure AI Search service configuration."""

    endpoint: str = Field(
        default="",
        description="Azure AI Search service endpoint URL.",
    )
    api_key: str = Field(
        default="",
        description="Azure AI Search admin API key. Leave empty to use DefaultAzureCredential.",
    )
    index_name: str = Field(
        default="csa-rag-index",
        description="Name of the search index for RAG vectors.",
    )
    semantic_config_name: str = Field(
        default="csa-semantic-config",
        description="Name of the semantic ranking configuration.",
    )
    api_version: str = Field(
        default="2024-07-01",
        description="Azure AI Search REST API version.",
    )

    model_config = {"env_prefix": "AZURE_SEARCH_"}


class ChunkSettings(BaseSettings):
    """Document chunking configuration."""

    chunk_size: int = Field(
        default=512,
        description="Target number of tokens per chunk.",
    )
    chunk_overlap: int = Field(
        default=64,
        description="Number of overlapping tokens between consecutive chunks.",
    )
    min_chunk_length: int = Field(
        default=50,
        description="Minimum character length for a chunk to be kept.",
    )
    split_strategy: Literal["sentence", "paragraph", "token"] = Field(
        default="sentence",
        description="Strategy for splitting documents into chunks.",
    )

    model_config = {"env_prefix": "RAG_CHUNK_"}


class SearchSettings(BaseSettings):
    """RAG query-time search configuration."""

    top_k: int = Field(
        default=5,
        description="Number of top results to retrieve from vector search.",
    )
    score_threshold: float = Field(
        default=0.70,
        description="Minimum similarity score to include a result.",
    )
    use_semantic_reranker: bool = Field(
        default=True,
        description="Whether to apply Azure AI Search semantic reranking.",
    )

    model_config = {"env_prefix": "RAG_SEARCH_"}


class EmbeddingBatchSettings(BaseSettings):
    """Batch processing configuration for embedding generation."""

    batch_size: int = Field(
        default=100,
        description="Number of texts to embed in a single API call.",
    )
    max_concurrent_requests: int = Field(
        default=5,
        description="Maximum number of concurrent embedding API calls.",
    )
    retry_attempts: int = Field(
        default=3,
        description="Number of retries for transient API failures.",
    )
    retry_delay_seconds: float = Field(
        default=1.0,
        description="Base delay between retries (with exponential back-off).",
    )

    model_config = {"env_prefix": "RAG_EMBED_"}


class RAGSettings(BaseSettings):
    """Top-level RAG pipeline settings aggregating all sub-configurations."""

    azure_openai: AzureOpenAISettings = Field(default_factory=AzureOpenAISettings)
    azure_search: AzureSearchSettings = Field(default_factory=AzureSearchSettings)
    chunk: ChunkSettings = Field(default_factory=ChunkSettings)
    search: SearchSettings = Field(default_factory=SearchSettings)
    embedding_batch: EmbeddingBatchSettings = Field(default_factory=EmbeddingBatchSettings)

    # General pipeline settings
    log_level: str = Field(
        default="INFO",
        description="Logging level for the RAG pipeline.",
    )

    model_config = {"env_prefix": "RAG_"}


@lru_cache(maxsize=1)
def get_settings() -> RAGSettings:
    """Return a cached singleton of :class:`RAGSettings`.

    Settings are populated from environment variables.  Call this function
    from any module that needs pipeline configuration.

    Returns:
        The global RAG pipeline settings instance.
    """
    return RAGSettings()
