# Azure OpenAI Capability Matrix

> **Last Updated:** 2026-04-22 | **API Version:** 2024-06-01 | **Status:** Active

## Overview

This matrix documents which Azure OpenAI features are implemented, available but not yet implemented, and explicitly out of scope for CSA-in-a-Box.

## Status Legend

- **Implemented** -- Feature is coded, tested, and production-ready
- **Available** -- Azure OpenAI supports this; implementation planned or deferred
- **Out of Scope** -- Intentionally excluded from this reference architecture

---

## Embeddings

| Feature | Status | Model | Module | Notes |
|---------|--------|-------|--------|-------|
| Sync embedding | Implemented | text-embedding-3-small | rag/indexer.py | Single + batch |
| Async embedding | Implemented | text-embedding-3-small | rag/indexer.py | CSA-0106 |
| Batch processing | Implemented | text-embedding-3-small | rag/indexer.py | batch_size=100, max_concurrent=5 |
| Retry + backoff | Implemented | * | rag/indexer.py | 3 retries, exponential |
| Rate limiting | Implemented | * | rag/rate_limit.py | Shared RPM/TPM (CSA-0108) |
| text-embedding-3-large | Available | text-embedding-3-large | - | Higher quality, 3072 dims |
| Custom dimensions | Available | text-embedding-3-* | - | Matryoshka embedding support |

## Chat Completions

| Feature | Status | Model | Module | Notes |
|---------|--------|-------|--------|-------|
| Sync chat | Implemented | gpt-4o | rag/generate.py | Temperature, max_tokens |
| Async chat | Implemented | gpt-4o | rag/generate.py | AsyncAzureOpenAI |
| System prompts | Implemented | gpt-4o | rag/generate.py | Fixed system role |
| Streaming | Available | gpt-4o | - | stream=True not implemented |
| Tool/Function calling | Available | gpt-4o | - | Planned for agent orchestration |
| Vision (image input) | Available | gpt-4o | - | Not implemented |
| JSON mode | Available | gpt-4o | - | response_format=json_object |
| Structured outputs | Available | gpt-4o | - | response_format with schema |
| Seed (reproducibility) | Available | gpt-4o | - | Deterministic outputs |

## Assistants API

| Feature | Status | Notes |
|---------|--------|-------|
| Assistants | Out of Scope | Using Semantic Kernel for agent orchestration instead |
| Threads | Out of Scope | Conversation state managed in application layer |
| Code Interpreter | Out of Scope | Databricks notebooks used for code execution |
| File Search | Out of Scope | Custom RAG pipeline with Azure AI Search preferred |

## Batch API

| Feature | Status | Notes |
|---------|--------|-------|
| Batch completions | Out of Scope | Real-time processing via streaming pipeline |
| Batch embeddings | Available | Could optimize bulk indexing |

## Fine-Tuning

| Feature | Status | Notes |
|---------|--------|-------|
| Fine-tuning | Out of Scope | Using RAG for domain knowledge instead |
| Distillation | Out of Scope | Cost optimization via prompt engineering |

## On Your Data

| Feature | Status | Notes |
|---------|--------|-------|
| Azure AI Search integration | Implemented | Via rag/retriever.py + Azure AI Search |
| Cosmos DB integration | Available | Planned for marketplace data |
| Blob Storage | Available | Could index ADLS documents |

## Content Safety

| Feature | Status | Notes |
|---------|--------|-------|
| Content filtering | Available | CSA-0112 tracked, not yet implemented |
| Custom blocklists | Out of Scope | Platform-level content safety planned |

---

## Authentication

| Method | Status | Use Case | Module |
|--------|--------|----------|--------|
| API Key | Implemented | Dev/local | rag/pipeline.py |
| Azure AD (sync) | Implemented | Production | rag/pipeline.py |
| Azure AD (async) | Implemented | Async apps | rag/service.py |
| Managed Identity | Implemented | Azure-hosted | DefaultAzureCredential |

## Model Deployments

| Deployment Name | Model | Purpose | API Version |
|----------------|-------|---------|-------------|
| text-embedding-3-small | text-embedding-3-small | Document + query embeddings | 2024-06-01 |
| gpt-4o | gpt-4o | RAG chat, summarization | 2024-06-01 |

---

## Configuration Reference

| Setting | Default | Source |
|---------|---------|--------|
| AZURE_OPENAI_ENDPOINT | - | Environment variable |
| AZURE_OPENAI_API_KEY | (empty = use DefaultAzureCredential) | Environment variable |
| AZURE_OPENAI_API_VERSION | 2024-06-01 | rag/config.py |
| EMBEDDING_DEPLOYMENT | text-embedding-3-small | rag/config.py |
| EMBEDDING_DIMENSIONS | 1536 | rag/config.py |
| CHAT_DEPLOYMENT | gpt-4o | rag/config.py |
| CHAT_MAX_TOKENS | 2048 | rag/config.py |
| CHAT_TEMPERATURE | 0.1 | rag/config.py |

---

## Roadmap

| Feature | Priority | Tracking |
|---------|----------|----------|
| Content Safety integration | High | CSA-0112 |
| Streaming chat responses | Medium | - |
| Tool/Function calling | Medium | For agent orchestration |
| Batch embedding optimization | Low | For bulk reindexing |

---

## Related Documentation

- [AI Integration README](./README.md)
- [RAG Pipeline Guide](../../docs/tutorials/08-rag-vector-search/README.md)
- [Semantic Kernel Agents](../../docs/tutorials/07-semantic-kernel-agents/README.md)
