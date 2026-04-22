# -*- coding: utf-8 -*-
"""csa_platform.streaming.serving_layer — Serving layer for Lambda architecture.

This module implements the serving layer of the Lambda architecture,
providing unified queries across speed layer (real-time) and batch layer
(historical) data with configurable overlap windows and view merging.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Union

from azure.cosmos.aio import CosmosClient as AsyncCosmosClient
from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
from azure.kusto.data.exceptions import KustoServiceError
from azure.identity.aio import DefaultAzureCredential

logger = logging.getLogger(__name__)


@dataclass
class QueryConfig:
    """Configuration for serving layer queries."""
    start_time: datetime
    end_time: datetime
    event_types: Optional[List[str]] = None
    sources: Optional[List[str]] = None
    aggregation_level: str = "raw"  # "raw", "minute", "hour", "day"
    include_real_time: bool = True
    include_batch: bool = True
    overlap_window: timedelta = timedelta(minutes=15)  # Overlap between speed and batch


@dataclass
class QueryResult:
    """Result from serving layer query."""
    query_config: QueryConfig
    speed_layer_results: List[Dict[str, Any]]
    batch_layer_results: List[Dict[str, Any]]
    merged_results: List[Dict[str, Any]]
    metadata: Dict[str, Any]


@dataclass
class ServingLayerConfig:
    """Configuration for the ServingLayer."""
    # Azure Data Explorer settings (for analytical queries)
    adx_cluster_url: Optional[str] = None
    adx_database_name: str = "streaming"
    adx_realtime_table: str = "realtime_events"
    adx_batch_table: str = "batch_aggregated"

    # Cosmos DB settings (for operational queries)
    cosmos_endpoint: Optional[str] = None
    cosmos_database_name: str = "streaming"
    cosmos_container_name: str = "realtime"

    # Query optimization settings
    default_overlap_window: timedelta = timedelta(minutes=15)
    max_query_range: timedelta = timedelta(days=30)
    cache_ttl: timedelta = timedelta(minutes=5)


class ServingLayer:
    """Serving layer implementing unified queries for Lambda architecture.

    Features:
    - Queries Azure Data Explorer for real-time and historical views
    - Merges speed layer (recent) + batch layer (historical) results
    - Supports time-range queries with configurable overlap windows
    - Provides both analytical (ADX) and operational (Cosmos) query interfaces
    - Handles deduplication and consistency between layers
    """

    def __init__(self, config: ServingLayerConfig):
        """Initialize the serving layer.

        Args:
            config: Configuration for the serving layer
        """
        self.config = config
        self._adx_client: Optional[KustoClient] = None
        self._cosmos_client: Optional[AsyncCosmosClient] = None

    async def initialize(self) -> None:
        """Initialize connections to serving layer storage systems."""
        # Initialize Azure Data Explorer client
        if self.config.adx_cluster_url:
            kcsb = KustoConnectionStringBuilder.with_aad_managed_service_identity_authentication(
                self.config.adx_cluster_url
            )
            self._adx_client = KustoClient(kcsb)

        # Initialize Cosmos DB client
        if self.config.cosmos_endpoint:
            credential = DefaultAzureCredential()
            self._cosmos_client = AsyncCosmosClient(
                self.config.cosmos_endpoint,
                credential
            )

        logger.info("Serving layer initialized")

    async def query_recent(self, config: QueryConfig) -> List[Dict[str, Any]]:
        """Query recent data from the speed layer (real-time processing).

        Args:
            config: Query configuration

        Returns:
            List of recent events/aggregations
        """
        if not self._adx_client:
            logger.warning("ADX client not configured, returning empty results")
            return []

        try:
            # Build KQL query for recent data
            where_clauses = [
                f"timestamp >= datetime({config.start_time.isoformat()})",
                f"timestamp < datetime({config.end_time.isoformat()})"
            ]

            if config.event_types:
                event_types_str = "', '".join(config.event_types)
                where_clauses.append(f"event_type in ('{event_types_str}')")

            if config.sources:
                sources_str = "', '".join(config.sources)
                where_clauses.append(f"source in ('{sources_str}')")

            where_clause = " and ".join(where_clauses)

            if config.aggregation_level == "raw":
                query = f"""
                {self.config.adx_realtime_table}
                | where {where_clause}
                | order by timestamp asc
                """
            else:
                # Aggregated query
                bin_size = self._get_bin_size(config.aggregation_level)
                query = f"""
                {self.config.adx_realtime_table}
                | where {where_clause}
                | summarize
                    count=count(),
                    min_timestamp=min(timestamp),
                    max_timestamp=max(timestamp)
                    by event_type, source, bin(timestamp, {bin_size})
                | order by timestamp asc
                """

            result = self._adx_client.execute(self.config.adx_database_name, query)
            records = []

            for row in result.primary_results[0]:
                record = {}
                for i, col in enumerate(result.primary_results[0].columns):
                    record[col.column_name] = row[i]
                records.append(record)

            logger.debug(f"Retrieved {len(records)} recent records from speed layer")
            return records

        except Exception as e:
            logger.error(f"Failed to query recent data: {e}")
            return []

    async def query_historical(self, config: QueryConfig) -> List[Dict[str, Any]]:
        """Query historical data from the batch layer.

        Args:
            config: Query configuration

        Returns:
            List of historical events/aggregations
        """
        if not self._adx_client:
            logger.warning("ADX client not configured, returning empty results")
            return []

        try:
            # Build KQL query for historical data
            # Apply overlap window to avoid gaps
            overlap_start = config.start_time - config.overlap_window
            overlap_end = config.end_time

            where_clauses = [
                f"timestamp >= datetime({overlap_start.isoformat()})",
                f"timestamp < datetime({overlap_end.isoformat()})"
            ]

            if config.event_types:
                event_types_str = "', '".join(config.event_types)
                where_clauses.append(f"event_type in ('{event_types_str}')")

            if config.sources:
                sources_str = "', '".join(config.sources)
                where_clauses.append(f"source in ('{sources_str}')")

            where_clause = " and ".join(where_clauses)

            if config.aggregation_level == "raw":
                query = f"""
                {self.config.adx_batch_table}
                | where {where_clause}
                | order by timestamp asc
                """
            else:
                # Aggregated query
                bin_size = self._get_bin_size(config.aggregation_level)
                query = f"""
                {self.config.adx_batch_table}
                | where {where_clause}
                | summarize
                    count=count(),
                    min_timestamp=min(timestamp),
                    max_timestamp=max(timestamp)
                    by event_type, source, bin(timestamp, {bin_size})
                | order by timestamp asc
                """

            result = self._adx_client.execute(self.config.adx_database_name, query)
            records = []

            for row in result.primary_results[0]:
                record = {}
                for i, col in enumerate(result.primary_results[0].columns):
                    record[col.column_name] = row[i]
                records.append(record)

            logger.debug(f"Retrieved {len(records)} historical records from batch layer")
            return records

        except Exception as e:
            logger.error(f"Failed to query historical data: {e}")
            return []

    def _get_bin_size(self, aggregation_level: str) -> str:
        """Get KQL bin size for aggregation level."""
        sizes = {
            "minute": "1m",
            "hour": "1h",
            "day": "1d"
        }
        return sizes.get(aggregation_level, "1h")

    def _merge_results(
        self,
        speed_results: List[Dict[str, Any]],
        batch_results: List[Dict[str, Any]],
        overlap_window: timedelta
    ) -> List[Dict[str, Any]]:
        """Merge speed and batch layer results, handling overlap and deduplication.

        Args:
            speed_results: Results from speed layer
            batch_results: Results from batch layer
            overlap_window: Overlap period for merging

        Returns:
            Merged and deduplicated results
        """
        # Calculate cutoff time for preferring speed layer over batch layer
        cutoff_time = datetime.utcnow() - overlap_window

        # Separate results by layer preference
        batch_only = []
        speed_only = []

        # Process batch results (prefer for historical data)
        batch_timestamps = set()
        for record in batch_results:
            timestamp = record.get('timestamp')
            if timestamp and isinstance(timestamp, datetime):
                if timestamp < cutoff_time:
                    batch_only.append(record)
                    batch_timestamps.add(timestamp)

        # Process speed results (prefer for recent data)
        for record in speed_results:
            timestamp = record.get('timestamp')
            if timestamp and isinstance(timestamp, datetime):
                if timestamp >= cutoff_time or timestamp not in batch_timestamps:
                    speed_only.append(record)

        # Combine results
        merged = batch_only + speed_only

        # Sort by timestamp
        merged.sort(key=lambda x: x.get('timestamp', datetime.min))

        logger.debug(
            f"Merged {len(batch_only)} batch records and "
            f"{len(speed_only)} speed records into {len(merged)} total records"
        )

        return merged

    async def query_merged(self, config: QueryConfig) -> QueryResult:
        """Query and merge data from both speed and batch layers.

        Args:
            config: Query configuration

        Returns:
            QueryResult with merged data from both layers
        """
        # Query both layers concurrently
        speed_task = None
        batch_task = None

        if config.include_real_time:
            speed_task = asyncio.create_task(self.query_recent(config))

        if config.include_batch:
            batch_task = asyncio.create_task(self.query_historical(config))

        # Wait for results
        speed_results = []
        batch_results = []

        if speed_task:
            speed_results = await speed_task

        if batch_task:
            batch_results = await batch_task

        # Merge results
        merged_results = self._merge_results(
            speed_results,
            batch_results,
            config.overlap_window
        )

        # Create metadata
        metadata = {
            "query_start": config.start_time.isoformat(),
            "query_end": config.end_time.isoformat(),
            "speed_layer_count": len(speed_results),
            "batch_layer_count": len(batch_results),
            "merged_count": len(merged_results),
            "overlap_window_minutes": config.overlap_window.total_seconds() / 60,
            "query_time": datetime.utcnow().isoformat()
        }

        return QueryResult(
            query_config=config,
            speed_layer_results=speed_results,
            batch_layer_results=batch_results,
            merged_results=merged_results,
            metadata=metadata
        )

    async def query_operational(
        self,
        event_id: Optional[str] = None,
        event_type: Optional[str] = None,
        source: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Query operational data from Cosmos DB for low-latency lookups.

        Args:
            event_id: Specific event ID to find
            event_type: Filter by event type
            source: Filter by source
            limit: Maximum number of results

        Returns:
            List of operational records
        """
        if not self._cosmos_client:
            logger.warning("Cosmos client not configured, returning empty results")
            return []

        try:
            database = self._cosmos_client.get_database_client(self.config.cosmos_database_name)
            container = database.get_container_client(self.config.cosmos_container_name)

            # Build query
            query_parts = ["SELECT * FROM c"]
            parameters = []

            where_conditions = []
            if event_id:
                where_conditions.append("c.id = @event_id")
                parameters.append({"name": "@event_id", "value": event_id})

            if event_type:
                where_conditions.append("c.event_type = @event_type")
                parameters.append({"name": "@event_type", "value": event_type})

            if source:
                where_conditions.append("c.source = @source")
                parameters.append({"name": "@source", "value": source})

            if where_conditions:
                query_parts.append("WHERE " + " AND ".join(where_conditions))

            query_parts.append("ORDER BY c._ts DESC")

            query = " ".join(query_parts)

            # Execute query
            results = []
            async for item in container.query_items(
                query=query,
                parameters=parameters,
                max_item_count=limit
            ):
                results.append(item)

            logger.debug(f"Retrieved {len(results)} operational records")
            return results

        except Exception as e:
            logger.error(f"Failed to query operational data: {e}")
            return []

    async def get_aggregation_summary(
        self,
        start_time: datetime,
        end_time: datetime,
        granularity: str = "hour"
    ) -> Dict[str, Any]:
        """Get aggregation summary across time range.

        Args:
            start_time: Start time for summary
            end_time: End time for summary
            granularity: Time granularity ("minute", "hour", "day")

        Returns:
            Aggregation summary
        """
        config = QueryConfig(
            start_time=start_time,
            end_time=end_time,
            aggregation_level=granularity,
            include_real_time=True,
            include_batch=True
        )

        result = await self.query_merged(config)

        # Summarize merged results
        summary = {
            "time_range": {
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
                "granularity": granularity
            },
            "total_events": sum(r.get("count", 1) for r in result.merged_results),
            "event_types": {},
            "sources": {},
            "time_series": result.merged_results,
            "metadata": result.metadata
        }

        # Aggregate by event type and source
        for record in result.merged_results:
            event_type = record.get("event_type", "unknown")
            source = record.get("source", "unknown")
            count = record.get("count", 1)

            summary["event_types"][event_type] = summary["event_types"].get(event_type, 0) + count
            summary["sources"][source] = summary["sources"].get(source, 0) + count

        return summary

    async def close(self) -> None:
        """Close connections and cleanup resources."""
        if self._cosmos_client:
            await self._cosmos_client.close()

        # Note: Kusto client doesn't have async close
        self._adx_client = None

        logger.info("Serving layer closed")


if __name__ == "__main__":
    import os

    async def main():
        """Example usage of ServingLayer."""
        config = ServingLayerConfig(
            adx_cluster_url=os.environ.get("ADX_CLUSTER_URL"),
            cosmos_endpoint=os.environ.get("COSMOS_ENDPOINT"),
            default_overlap_window=timedelta(minutes=10)
        )

        serving_layer = ServingLayer(config)
        await serving_layer.initialize()

        # Example query
        query_config = QueryConfig(
            start_time=datetime.utcnow() - timedelta(hours=1),
            end_time=datetime.utcnow(),
            event_types=["temperature", "humidity"],
            aggregation_level="minute"
        )

        # Query merged data
        result = await serving_layer.query_merged(query_config)

        print(f"Query returned {len(result.merged_results)} merged records")
        print(f"Speed layer: {result.metadata['speed_layer_count']} records")
        print(f"Batch layer: {result.metadata['batch_layer_count']} records")

        # Get aggregation summary
        summary = await serving_layer.get_aggregation_summary(
            start_time=datetime.utcnow() - timedelta(hours=2),
            end_time=datetime.utcnow(),
            granularity="hour"
        )

        print(f"Total events in summary: {summary['total_events']}")
        print(f"Event types: {summary['event_types']}")

        await serving_layer.close()

    if os.environ.get("ADX_CLUSTER_URL") or os.environ.get("COSMOS_ENDPOINT"):
        asyncio.run(main())
    else:
        print("Set ADX_CLUSTER_URL or COSMOS_ENDPOINT environment variables to test")