"""Semantic reranking helpers for the RAG pipeline (CSA-0133).

Azure AI Search's semantic reranker runs server-side; all we manage
client-side is whether to enable it and which configuration to use.
Extracting this out keeps the retriever oblivious to rerank policy
and leaves a clean seam for a future client-side cross-encoder.
"""

from __future__ import annotations

from dataclasses import dataclass

from .retriever import SearchResult


@dataclass(frozen=True)
class RerankPolicy:
    """Configuration for the semantic reranker.

    Attributes:
        enabled: Whether to apply semantic reranking on the next query.
        configuration_name: Name of the semantic configuration registered
            on the Azure AI Search index (must match the one created by
            :meth:`VectorStore.create_index`).
    """

    enabled: bool = True
    configuration_name: str = "csa-semantic-config"

    @classmethod
    def disabled(cls) -> RerankPolicy:
        """Convenience constructor for the no-op rerank policy."""
        return cls(enabled=False)


def apply_policy(results: list[SearchResult], policy: RerankPolicy) -> list[SearchResult]:
    """Post-process search results under *policy*.

    Server-side rerank already adjusted ``SearchResult.score`` when
    present, so this helper is a seam for future client-side rerankers.
    Today it's a pass-through (disabled) or a defensive score sort
    (enabled).  Always returns a fresh list.
    """
    if not policy.enabled:
        return list(results)
    return sorted(results, key=lambda r: r.score, reverse=True)


__all__ = ["RerankPolicy", "apply_policy"]
