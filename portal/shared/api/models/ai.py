# -*- coding: utf-8 -*-
"""AI service request/response models for the CSA-in-a-Box portal.

Defines the API contract for RAG-powered chat, text embeddings,
semantic search, and AI service health checks.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ── Sub-models ──────────────────────────────────────────────────────────────


class TokenUsage(BaseModel):
    """Token consumption for an AI request."""

    prompt_tokens: int = Field(ge=0, description="Tokens used in the prompt")
    completion_tokens: int = Field(ge=0, description="Tokens used in the completion")
    total_tokens: int = Field(ge=0, description="Total tokens consumed")


class SourceReference(BaseModel):
    """A source document referenced in a RAG answer."""

    title: str = Field(..., description="Source document title")
    url: str | None = Field(default=None, description="URL to the source document")
    chunk: str = Field(..., description="Relevant text chunk from the source")
    score: float = Field(..., ge=0.0, le=1.0, description="Relevance score (0-1)")


class SearchResult(BaseModel):
    """A single semantic search result."""

    id: str = Field(..., description="Document or chunk identifier")
    content: str = Field(..., description="Matched content text")
    metadata: dict = Field(default_factory=dict, description="Associated metadata")
    score: float = Field(..., ge=0.0, le=1.0, description="Similarity score (0-1)")


# ── Request Models ──────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    """Request body for RAG-powered chat."""

    query: str = Field(..., min_length=1, max_length=4000, description="User question")
    collection: str = Field(default="default", description="Vector store collection to search")
    max_results: int = Field(default=5, ge=1, le=20, description="Number of context chunks to retrieve")
    temperature: float = Field(default=0.1, ge=0.0, le=2.0, description="LLM sampling temperature")
    system_prompt: str | None = Field(default=None, max_length=2000, description="Optional system prompt override")


class EmbedRequest(BaseModel):
    """Request body for text embedding generation."""

    texts: list[str] = Field(..., min_length=1, max_length=100, description="Texts to embed")
    model: str = Field(default="text-embedding-3-small", description="Embedding model name")


class SearchRequest(BaseModel):
    """Semantic search request against indexed data products."""

    query: str = Field(..., min_length=1, max_length=2000, description="Search query text")
    collection: str = Field(default="default", description="Vector store collection to search")
    top_k: int = Field(default=10, ge=1, le=100, description="Maximum number of results")
    min_score: float = Field(default=0.0, ge=0.0, le=1.0, description="Minimum similarity score threshold")
    filters: dict[str, str] | None = Field(default=None, description="Metadata filters (key-value pairs)")


# ── Response Models ─────────────────────────────────────────────────────────


class ChatResponse(BaseModel):
    """Response from RAG-powered chat."""

    answer: str = Field(..., description="Generated answer grounded in retrieved context")
    sources: list[SourceReference] = Field(default_factory=list, description="Source documents used")
    model: str = Field(..., description="Model used for generation")
    usage: TokenUsage = Field(..., description="Token consumption breakdown")
    latency_ms: float = Field(..., ge=0.0, description="End-to-end latency in milliseconds")


class EmbedResponse(BaseModel):
    """Response containing generated embeddings."""

    embeddings: list[list[float]] = Field(..., description="Embedding vectors")
    model: str = Field(..., description="Model used for embedding")
    dimensions: int = Field(..., ge=1, description="Embedding vector dimensionality")
    usage: TokenUsage = Field(..., description="Token consumption breakdown")


class SearchResponse(BaseModel):
    """Semantic search results."""

    results: list[SearchResult] = Field(default_factory=list, description="Ranked search results")
    query: str = Field(..., description="Original search query")
    total: int = Field(..., ge=0, description="Total number of results returned")
    latency_ms: float = Field(..., ge=0.0, description="Search latency in milliseconds")


class AIServiceStatus(BaseModel):
    """Health status of AI services."""

    status: str = Field(..., description="Overall status: healthy | degraded | unavailable")
    embedding_model: str = Field(..., description="Configured embedding model")
    chat_model: str = Field(..., description="Configured chat/completion model")
    vector_store: str = Field(..., description="Vector store connection: connected | disconnected")
    last_check: str = Field(..., description="ISO-8601 timestamp of last health check")
