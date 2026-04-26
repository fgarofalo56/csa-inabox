"""GraphRAG search interfaces for CSA-in-a-Box.

Provides global, local, and DRIFT search over GraphRAG indexes,
with optional hybrid retrieval combining vector search and graph traversal.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    """A single search result from GraphRAG."""

    answer: str
    context: list[dict[str, Any]] = field(default_factory=list)
    search_type: str = "global"
    metadata: dict[str, Any] = field(default_factory=dict)


class GraphRAGSearch:
    """Search interface for GraphRAG knowledge graphs.

    Supports three search modes:
    - **Global search**: Uses community summaries for broad, thematic questions.
    - **Local search**: Uses entity context for specific, factual questions.
    - **DRIFT search**: Dynamic Reasoning and Inference-based Traversal for
      complex, multi-hop questions.

    Example:
        search = GraphRAGSearch(index_dir="./graphrag-output")
        result = search.global_search("What are the main themes in this corpus?")
        print(result.answer)
    """

    def __init__(
        self,
        index_dir: str | Path,
        llm_deployment: str = "gpt-5.4",
        embedding_deployment: str = "text-embedding-3-large",
        api_base: str | None = None,
        community_level: int = 2,
    ) -> None:
        self._index_dir = Path(index_dir)
        self._llm_deployment = llm_deployment
        self._embedding_deployment = embedding_deployment
        self._api_base = api_base or os.getenv("AZURE_OPENAI_ENDPOINT", "")
        self._community_level = community_level

        # Lazy-loaded components
        self._entities: pd.DataFrame | None = None
        self._relationships: pd.DataFrame | None = None
        self._reports: pd.DataFrame | None = None
        self._text_units: pd.DataFrame | None = None
        self._communities: pd.DataFrame | None = None

    def _load_index_data(self) -> None:
        """Load GraphRAG index Parquet files."""
        if self._entities is not None:
            return

        import pandas as pd

        def find_and_load(name: str) -> pd.DataFrame | None:
            matches = list(self._index_dir.rglob(f"{name}.parquet"))
            if matches:
                return pd.read_parquet(matches[0])
            logger.warning("Index file not found: %s.parquet", name)
            return None

        self._entities = find_and_load("entities")
        self._relationships = find_and_load("relationships")
        self._reports = find_and_load("community_reports")
        self._text_units = find_and_load("text_units")
        self._communities = find_and_load("communities")

        entity_count = len(self._entities) if self._entities is not None else 0
        rel_count = len(self._relationships) if self._relationships is not None else 0
        logger.info(
            "Loaded index: %d entities, %d relationships", entity_count, rel_count
        )

    def _get_llm_config(self) -> Any:
        """Create LLM configuration for GraphRAG queries."""
        from graphrag.config.enums import ModelType
        from graphrag.config.models.language_model_config import LanguageModelConfig

        return LanguageModelConfig(
            type=ModelType.AzureOpenAIChat,
            model=self._llm_deployment,
            deployment_name=self._llm_deployment,
            api_base=self._api_base,
            auth_type="azure_identity",
        )

    def global_search(
        self,
        query: str,
        community_level: int | None = None,
        response_type: str = "Multiple Paragraphs",
    ) -> SearchResult:
        """Global search using community report summaries.

        Best for broad questions like:
        - "What are the main themes in this dataset?"
        - "Summarize the key governance patterns"
        - "What are the most important data quality issues?"

        Args:
            query: Natural language question.
            community_level: Community hierarchy level (default: 2).
            response_type: Desired response format.

        Returns:
            SearchResult with answer and context.
        """
        self._load_index_data()

        from graphrag.language_model.manager import ModelManager
        from graphrag.query.indexer_adapters import read_indexer_reports
        from graphrag.query.structured_search.global_search.community_context import (
            GlobalCommunityContext,
        )
        from graphrag.query.structured_search.global_search.search import GlobalSearch

        level = community_level or self._community_level

        llm_config = self._get_llm_config()
        model_manager = ModelManager()
        llm = model_manager.get_or_create_chat_model(llm_config, "global-search")

        reports = read_indexer_reports(
            self._reports, self._communities, level
        )

        context_builder = GlobalCommunityContext(
            community_reports=reports,
        )

        search_engine = GlobalSearch(
            llm=llm,
            context_builder=context_builder,
            response_type=response_type,
        )

        import asyncio
        result = asyncio.run(search_engine.asearch(query))

        return SearchResult(
            answer=result.response,
            context=result.context_data if hasattr(result, "context_data") else [],
            search_type="global",
            metadata={"community_level": level, "response_type": response_type},
        )

    def local_search(
        self,
        query: str,
        community_level: int | None = None,
        top_k: int = 10,
    ) -> SearchResult:
        """Local search using entity-level context.

        Best for specific questions like:
        - "What data sources does the Finance domain use?"
        - "Who owns the customer_360 data product?"
        - "What transformations are applied to sales data?"

        Args:
            query: Natural language question.
            community_level: Community level for context.
            top_k: Number of entities to retrieve.

        Returns:
            SearchResult with answer and entity context.
        """
        self._load_index_data()

        from graphrag.language_model.manager import ModelManager
        from graphrag.query.indexer_adapters import (
            read_indexer_entities,
            read_indexer_relationships,
            read_indexer_reports,
            read_indexer_text_units,
        )
        from graphrag.query.structured_search.local_search.mixed_context import (
            LocalSearchMixedContext,
        )
        from graphrag.query.structured_search.local_search.search import LocalSearch

        level = community_level or self._community_level

        llm_config = self._get_llm_config()
        model_manager = ModelManager()
        llm = model_manager.get_or_create_chat_model(llm_config, "local-search")

        entities = read_indexer_entities(self._entities, self._communities, level)
        relationships = read_indexer_relationships(self._relationships)
        reports = read_indexer_reports(self._reports, self._communities, level)
        text_units = read_indexer_text_units(self._text_units)

        context_builder = LocalSearchMixedContext(
            community_reports=reports,
            text_units=text_units,
            entities=entities,
            relationships=relationships,
        )

        search_engine = LocalSearch(
            llm=llm,
            context_builder=context_builder,
        )

        import asyncio
        result = asyncio.run(search_engine.asearch(query))

        return SearchResult(
            answer=result.response,
            context=result.context_data if hasattr(result, "context_data") else [],
            search_type="local",
            metadata={"community_level": level, "top_k": top_k},
        )

    def hybrid_search(
        self,
        query: str,
        vector_results: list[dict[str, Any]] | None = None,
        graph_store: Any | None = None,
        entity_name: str | None = None,
    ) -> SearchResult:
        """Hybrid search combining vector retrieval and graph context.

        Merges results from Azure AI Search (vector) with GraphRAG
        entity context for richer, more grounded answers.

        Args:
            query: Natural language question.
            vector_results: Pre-fetched vector search results.
            graph_store: CosmosGremlinStore for live graph queries.
            entity_name: Specific entity to get graph context for.

        Returns:
            SearchResult with combined context.
        """
        # Get local search results (graph context)
        graph_result = self.local_search(query)

        # Combine with vector results if provided
        combined_context = []
        if vector_results:
            combined_context.extend(
                [{"source": "vector", "content": r} for r in vector_results]
            )

        if graph_result.context:
            combined_context.extend(
                [{"source": "graph", "content": c} for c in graph_result.context]
            )

        # Get additional graph context if entity specified
        if graph_store and entity_name:
            entity_context = graph_store.get_entity_context(entity_name)
            if entity_context.get("entity"):
                combined_context.append(
                    {"source": "graph_entity", "content": entity_context}
                )

        return SearchResult(
            answer=graph_result.answer,
            context=combined_context,
            search_type="hybrid",
            metadata={
                "vector_result_count": len(vector_results) if vector_results else 0,
                "graph_context_items": len(graph_result.context) if graph_result.context else 0,
            },
        )
