"""GraphRAG module for CSA-in-a-Box.

Provides knowledge graph construction, document loading, and graph-enhanced
retrieval using Microsoft GraphRAG + Azure Cosmos DB Gremlin API.
"""

from csa_platform.ai_integration.graphrag.document_loader import DocumentLoader
from csa_platform.ai_integration.graphrag.index_builder import GraphRAGIndexBuilder
from csa_platform.ai_integration.graphrag.graph_store import CosmosGremlinStore
from csa_platform.ai_integration.graphrag.search import GraphRAGSearch

__all__ = [
    "DocumentLoader",
    "GraphRAGIndexBuilder",
    "CosmosGremlinStore",
    "GraphRAGSearch",
]
