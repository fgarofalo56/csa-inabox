"""Cosmos DB Gremlin graph store for GraphRAG knowledge graphs.

Persists GraphRAG entities and relationships in Azure Cosmos DB Gremlin API
for interactive graph queries and traversals.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from azure.identity import DefaultAzureCredential

logger = logging.getLogger(__name__)


@dataclass
class GraphEntity:
    """An entity (vertex) in the knowledge graph."""

    id: str
    name: str
    type: str
    description: str
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphRelationship:
    """A relationship (edge) in the knowledge graph."""

    source_id: str
    target_id: str
    type: str
    description: str
    weight: float = 1.0
    properties: dict[str, Any] = field(default_factory=dict)


class CosmosGremlinStore:
    """Persist and query knowledge graphs in Azure Cosmos DB Gremlin API.

    Provides methods to load GraphRAG output (Parquet files) into Cosmos DB
    and query the graph using Gremlin traversals.

    Example:
        store = CosmosGremlinStore(
            endpoint="wss://my-cosmos.gremlin.cosmos.azure.com:443/",
            database="graphrag",
            graph="knowledge",
        )
        store.load_from_graphrag_output("./graphrag-output/")
        results = store.query("g.V().has('type', 'Organization').limit(10)")
    """

    def __init__(
        self,
        endpoint: str | None = None,
        database: str = "graphrag",
        graph: str = "knowledge",
        key: str | None = None,
        credential: Any | None = None,
    ) -> None:
        self._endpoint = endpoint or os.getenv("COSMOS_GREMLIN_ENDPOINT", "")
        self._database = database
        self._graph = graph
        self._key = key or os.getenv("COSMOS_GREMLIN_KEY", "")
        self._credential = credential or DefaultAzureCredential()
        self._client = None

    def _get_client(self) -> Any:
        """Get or create Gremlin client."""
        if self._client is None:
            try:
                from gremlin_python.driver import client as gremlin_client
                from gremlin_python.driver import serializer
            except ImportError:
                raise ImportError(
                    "gremlinpython required. Install: pip install gremlinpython"
                )

            self._client = gremlin_client.Client(
                url=self._endpoint,
                traversal_source="g",
                username=f"/dbs/{self._database}/colls/{self._graph}",
                password=self._key,
                message_serializer=serializer.GraphSONSerializersV2d0(),
            )
        return self._client

    def load_from_graphrag_output(
        self,
        output_dir: str,
        batch_size: int = 50,
    ) -> dict[str, int]:
        """Load GraphRAG Parquet output into Cosmos DB Gremlin.

        Reads entities.parquet and relationships.parquet from GraphRAG
        output and creates vertices and edges in Cosmos DB.

        Args:
            output_dir: Path to GraphRAG output directory.
            batch_size: Number of operations per batch.

        Returns:
            Dict with counts of loaded vertices and edges.
        """
        import pandas as pd
        from pathlib import Path

        output_path = Path(output_dir)
        stats = {"vertices": 0, "edges": 0}

        # Load entities
        entity_files = list(output_path.rglob("entities.parquet"))
        if entity_files:
            df = pd.read_parquet(entity_files[0])
            entities = []
            for _, row in df.iterrows():
                entity = GraphEntity(
                    id=str(row.get("id", row.get("title", ""))),
                    name=str(row.get("title", row.get("name", ""))),
                    type=str(row.get("type", "Entity")),
                    description=str(row.get("description", "")),
                )
                entities.append(entity)

            self.add_entities(entities, batch_size=batch_size)
            stats["vertices"] = len(entities)
            logger.info("Loaded %d entities", len(entities))

        # Load relationships
        rel_files = list(output_path.rglob("relationships.parquet"))
        if rel_files:
            df = pd.read_parquet(rel_files[0])
            relationships = []
            for _, row in df.iterrows():
                rel = GraphRelationship(
                    source_id=str(row.get("source", "")),
                    target_id=str(row.get("target", "")),
                    type=str(row.get("type", row.get("description", "RELATED_TO"))),
                    description=str(row.get("description", "")),
                    weight=float(row.get("weight", 1.0)),
                )
                relationships.append(rel)

            self.add_relationships(relationships, batch_size=batch_size)
            stats["edges"] = len(relationships)
            logger.info("Loaded %d relationships", len(relationships))

        return stats

    def add_entities(
        self, entities: list[GraphEntity], batch_size: int = 50
    ) -> None:
        """Add entities as vertices in the graph."""
        client = self._get_client()

        for i in range(0, len(entities), batch_size):
            batch = entities[i : i + batch_size]
            for entity in batch:
                # Escape single quotes in strings
                name = entity.name.replace("'", "\\'")
                desc = entity.description[:500].replace("'", "\\'")
                etype = entity.type.replace("'", "\\'")

                query = (
                    f"g.addV('{etype}')"
                    f".property('id', '{entity.id}')"
                    f".property('name', '{name}')"
                    f".property('description', '{desc}')"
                    f".property('pk', '{entity.id}')"
                )
                try:
                    client.submitAsync(query).result()
                except Exception:
                    logger.warning("Failed to add entity: %s", entity.id)

    def add_relationships(
        self, relationships: list[GraphRelationship], batch_size: int = 50
    ) -> None:
        """Add relationships as edges in the graph."""
        client = self._get_client()

        for i in range(0, len(relationships), batch_size):
            batch = relationships[i : i + batch_size]
            for rel in batch:
                rel_type = rel.type.replace(" ", "_").replace("'", "")
                desc = rel.description[:200].replace("'", "\\'")

                query = (
                    f"g.V('{rel.source_id}')"
                    f".addE('{rel_type}')"
                    f".to(g.V('{rel.target_id}'))"
                    f".property('description', '{desc}')"
                    f".property('weight', {rel.weight})"
                )
                try:
                    client.submitAsync(query).result()
                except Exception:
                    logger.warning(
                        "Failed to add edge: %s -> %s",
                        rel.source_id,
                        rel.target_id,
                    )

    def query(self, gremlin_query: str) -> list[dict[str, Any]]:
        """Execute a Gremlin query and return results.

        Args:
            gremlin_query: Gremlin traversal query string.

        Returns:
            List of result dictionaries.
        """
        client = self._get_client()
        callback = client.submitAsync(gremlin_query)
        results = callback.result()
        return [dict(r) if hasattr(r, "__iter__") else {"value": r} for r in results]

    def find_related_entities(
        self,
        entity_name: str,
        max_depth: int = 2,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Find entities related to a given entity.

        Args:
            entity_name: Name of the starting entity.
            max_depth: Maximum traversal depth.
            limit: Maximum results.

        Returns:
            List of related entities with relationship info.
        """
        name = entity_name.replace("'", "\\'")
        query = (
            f"g.V().has('name', '{name}')"
            f".repeat(both().simplePath()).times({max_depth})"
            f".dedup()"
            f".limit({limit})"
            f".project('name', 'type', 'description')"
            f".by('name').by(label).by('description')"
        )
        return self.query(query)

    def get_entity_context(
        self,
        entity_name: str,
        include_community: bool = True,
    ) -> dict[str, Any]:
        """Get full context for an entity (for RAG retrieval).

        Returns the entity, its direct relationships, and optionally
        its community summary.

        Args:
            entity_name: Entity name to look up.
            include_community: Whether to include community info.

        Returns:
            Dict with entity details, relationships, and community.
        """
        name = entity_name.replace("'", "\\'")

        # Get entity
        entity_results = self.query(
            f"g.V().has('name', '{name}')"
            f".project('id', 'name', 'type', 'description')"
            f".by('id').by('name').by(label).by('description')"
        )

        # Get relationships
        rel_results = self.query(
            f"g.V().has('name', '{name}')"
            f".bothE()"
            f".project('type', 'direction', 'other')"
            f".by(label)"
            f".by(constant('out'))"
            f".by(inV().values('name'))"
        )

        return {
            "entity": entity_results[0] if entity_results else None,
            "relationships": rel_results,
            "relationship_count": len(rel_results),
        }

    def impact_analysis(
        self,
        asset_name: str,
        direction: str = "downstream",
        max_depth: int = 5,
    ) -> list[dict[str, Any]]:
        """Trace impact of a data asset through the graph.

        Useful for governance: "If I change this table, what's affected?"

        Args:
            asset_name: Name of the data asset.
            direction: "downstream" (what depends on this) or
                "upstream" (what this depends on).
            max_depth: Maximum traversal depth.

        Returns:
            List of impacted assets with path information.
        """
        name = asset_name.replace("'", "\\'")
        traverse = "out" if direction == "downstream" else "in"

        query = (
            f"g.V().has('name', '{name}')"
            f".repeat({traverse}().simplePath()).times({max_depth}).emit()"
            f".dedup()"
            f".project('name', 'type', 'depth')"
            f".by('name').by(label).by(loops())"
        )
        return self.query(query)

    def close(self) -> None:
        """Close the Gremlin client connection."""
        if self._client:
            self._client.close()
            self._client = None
