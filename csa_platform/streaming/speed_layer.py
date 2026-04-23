# -*- coding: utf-8 -*-
"""csa_platform.streaming.speed_layer — Real-time processing layer for Lambda architecture.

This module implements the speed layer (hot path) of the Lambda architecture,
providing real-time transformations, windowed aggregations, and writing to
hot storage systems like Cosmos DB and Azure Data Explorer.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Union

from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.aio import CosmosClient as AsyncCosmosClient
from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
from azure.kusto.data.exceptions import KustoServiceError
from azure.identity.aio import DefaultAzureCredential

from csa_platform.streaming.event_processor import EventCallback, EventSchema

logger = logging.getLogger(__name__)


@dataclass
class WindowConfig:
    """Configuration for windowing operations."""
    window_type: str  # "sliding" or "tumbling"
    window_size: timedelta
    slide_interval: Optional[timedelta] = None  # For sliding windows
    grace_period: timedelta = timedelta(minutes=1)
    max_out_of_order: timedelta = timedelta(minutes=5)


@dataclass
class SpeedLayerConfig:
    """Configuration for the SpeedLayer."""
    # Cosmos DB settings
    cosmos_endpoint: Optional[str] = None
    cosmos_database_name: str = "streaming"
    cosmos_container_name: str = "realtime"
    cosmos_partition_key: str = "/event_type"

    # Azure Data Explorer settings
    adx_cluster_url: Optional[str] = None
    adx_database_name: str = "streaming"
    adx_table_name: str = "realtime_events"

    # Window configurations
    sliding_window: WindowConfig = field(
        default_factory=lambda: WindowConfig(
            window_type="sliding",
            window_size=timedelta(minutes=5),
            slide_interval=timedelta(seconds=30)
        )
    )
    tumbling_window: WindowConfig = field(
        default_factory=lambda: WindowConfig(
            window_type="tumbling",
            window_size=timedelta(minutes=1)
        )
    )

    # Performance settings
    batch_size: int = 100
    flush_interval: timedelta = timedelta(seconds=10)
    max_memory_events: int = 10000


@dataclass
class WindowedEvent:
    """Represents an event in a time window."""
    event: EventSchema
    window_start: datetime
    window_end: datetime
    window_type: str


@dataclass
class AggregationResult:
    """Results of windowed aggregation."""
    window_start: datetime
    window_end: datetime
    window_type: str
    event_count: int
    event_types: Dict[str, int]
    sources: Dict[str, int]
    min_timestamp: datetime
    max_timestamp: datetime
    aggregations: Dict[str, Any]


class TimeWindow:
    """Manages events within a time window."""

    def __init__(self, start: datetime, end: datetime, window_type: str):
        self.start = start
        self.end = end
        self.window_type = window_type
        self.events: List[EventSchema] = []
        self.last_update = datetime.utcnow()

    def add_event(self, event: EventSchema) -> bool:
        """Add event to window if it falls within the time range.

        Returns:
            True if event was added, False if outside window
        """
        if self.start <= event.timestamp < self.end:
            self.events.append(event)
            self.last_update = datetime.utcnow()
            return True
        return False

    def aggregate(self) -> AggregationResult:
        """Compute aggregations for events in this window."""
        if not self.events:
            return AggregationResult(
                window_start=self.start,
                window_end=self.end,
                window_type=self.window_type,
                event_count=0,
                event_types={},
                sources={},
                min_timestamp=self.start,
                max_timestamp=self.start,
                aggregations={}
            )

        event_types: Dict[str, int] = defaultdict(int)
        sources: Dict[str, int] = defaultdict(int)
        numeric_values: Dict[str, List[float]] = defaultdict(list)

        for event in self.events:
            event_types[event.event_type] += 1
            sources[event.source] += 1

            # Extract numeric values for aggregation
            for key, value in event.payload.items():
                if isinstance(value, (int, float)):
                    numeric_values[key].append(float(value))

        # Compute numeric aggregations
        aggregations = {}
        for key, values in numeric_values.items():
            if values:
                aggregations[f"{key}_sum"] = sum(values)
                aggregations[f"{key}_avg"] = sum(values) / len(values)
                aggregations[f"{key}_min"] = min(values)
                aggregations[f"{key}_max"] = max(values)
                aggregations[f"{key}_count"] = len(values)

        return AggregationResult(
            window_start=self.start,
            window_end=self.end,
            window_type=self.window_type,
            event_count=len(self.events),
            event_types=dict(event_types),
            sources=dict(sources),
            min_timestamp=min(e.timestamp for e in self.events),
            max_timestamp=max(e.timestamp for e in self.events),
            aggregations=aggregations
        )


class SpeedLayer:
    """Real-time processing layer implementing the speed layer of Lambda architecture.

    Features:
    - Real-time event transformation and enrichment
    - Sliding and tumbling window aggregations
    - Writes to Cosmos DB for operational queries
    - Writes to Azure Data Explorer for analytical queries
    - In-memory event buffering with configurable limits
    """

    def __init__(self, config: SpeedLayerConfig):
        """Initialize the speed layer.

        Args:
            config: Configuration for the speed layer
        """
        self.config = config
        self._cosmos_client: Optional[AsyncCosmosClient] = None
        self._kusto_client: Optional[KustoClient] = None
        self._sliding_windows: Dict[str, TimeWindow] = {}
        self._tumbling_windows: Dict[str, TimeWindow] = {}
        self._event_buffer: deque = deque(maxlen=config.max_memory_events)
        self._last_flush = datetime.utcnow()
        self._running = False

    async def initialize(self) -> None:
        """Initialize connections to hot storage systems."""
        # Initialize Cosmos DB client
        if self.config.cosmos_endpoint:
            credential = DefaultAzureCredential()
            self._cosmos_client = AsyncCosmosClient(
                self.config.cosmos_endpoint,
                credential
            )
            await self._setup_cosmos_container()

        # Initialize Azure Data Explorer client
        if self.config.adx_cluster_url:
            kcsb = KustoConnectionStringBuilder.with_aad_managed_service_identity_authentication(
                self.config.adx_cluster_url
            )
            self._kusto_client = KustoClient(kcsb)
            await self._setup_adx_table()

        logger.info("Speed layer initialized")

    async def _setup_cosmos_container(self) -> None:
        """Setup Cosmos DB database and container."""
        if not self._cosmos_client:
            return

        try:
            # Create database if it doesn't exist
            database = self._cosmos_client.get_database_client(self.config.cosmos_database_name)
            await database.read()
        except Exception:
            await self._cosmos_client.create_database(self.config.cosmos_database_name)
            logger.info(f"Created Cosmos database: {self.config.cosmos_database_name}")

        try:
            # Create container if it doesn't exist
            database = self._cosmos_client.get_database_client(self.config.cosmos_database_name)
            container = database.get_container_client(self.config.cosmos_container_name)
            await container.read()
        except Exception:
            await database.create_container(
                id=self.config.cosmos_container_name,
                partition_key=PartitionKey(path=self.config.cosmos_partition_key)
            )
            logger.info(f"Created Cosmos container: {self.config.cosmos_container_name}")

    async def _setup_adx_table(self) -> None:
        """Setup Azure Data Explorer table."""
        if not self._kusto_client:
            return

        # Define table schema
        create_table_command = f"""
        .create table ['iot_events'] (
            id: string,
            timestamp: datetime,
            event_type: string,
            source: string,
            payload: dynamic,
            window_start: datetime,
            window_end: datetime,
            window_type: string,
            processed_at: datetime
        )
        """

        try:
            self._kusto_client.execute(self.config.adx_database_name, create_table_command)
            logger.info(f"Created ADX table: {self.config.adx_table_name}")
        except KustoServiceError as e:
            if "already exists" not in str(e):
                logger.error(f"Failed to create ADX table: {e}")

    def _get_window_key(self, event: EventSchema, window_start: datetime, window_type: str) -> str:
        """Generate a unique key for a time window."""
        return f"{window_type}_{event.event_type}_{window_start.isoformat()}"

    def _create_sliding_windows(self, event: EventSchema) -> List[TimeWindow]:
        """Create sliding windows for an event."""
        windows = []
        current_time = datetime.utcnow()
        window_config = self.config.sliding_window

        # Calculate how many windows this event should be in
        slide_interval = window_config.slide_interval or window_config.window_size
        window_start = event.timestamp - (event.timestamp - datetime.min) % slide_interval

        # Create overlapping windows
        for i in range(int(window_config.window_size / slide_interval)):
            start = window_start - (slide_interval * i)
            end = start + window_config.window_size

            # Only create windows that might still receive events
            if end > current_time - window_config.max_out_of_order:
                window_key = self._get_window_key(event, start, "sliding")

                if window_key not in self._sliding_windows:
                    self._sliding_windows[window_key] = TimeWindow(start, end, "sliding")

                windows.append(self._sliding_windows[window_key])

        return windows

    def _create_tumbling_window(self, event: EventSchema) -> TimeWindow:
        """Create tumbling window for an event."""
        window_config = self.config.tumbling_window

        # Calculate tumbling window boundaries
        window_start = event.timestamp - (event.timestamp - datetime.min) % window_config.window_size
        window_end = window_start + window_config.window_size

        window_key = self._get_window_key(event, window_start, "tumbling")

        if window_key not in self._tumbling_windows:
            self._tumbling_windows[window_key] = TimeWindow(window_start, window_end, "tumbling")

        return self._tumbling_windows[window_key]

    def _cleanup_old_windows(self) -> None:
        """Remove windows that are beyond the grace period."""
        current_time = datetime.utcnow()

        # Cleanup sliding windows
        expired_sliding = [
            key for key, window in self._sliding_windows.items()
            if window.end < current_time - self.config.sliding_window.grace_period
        ]
        for key in expired_sliding:
            del self._sliding_windows[key]

        # Cleanup tumbling windows
        expired_tumbling = [
            key for key, window in self._tumbling_windows.items()
            if window.end < current_time - self.config.tumbling_window.grace_period
        ]
        for key in expired_tumbling:
            del self._tumbling_windows[key]

        if expired_sliding or expired_tumbling:
            logger.debug(f"Cleaned up {len(expired_sliding)} sliding and {len(expired_tumbling)} tumbling windows")

    async def process_realtime(self, events: List[EventSchema]) -> None:
        """Process events in real-time through the speed layer.

        Args:
            events: List of events to process
        """
        processed_events = []

        for event in events:
            # Add to sliding windows
            sliding_windows = self._create_sliding_windows(event)
            for window in sliding_windows:
                window.add_event(event)

            # Add to tumbling window
            tumbling_window = self._create_tumbling_window(event)
            tumbling_window.add_event(event)

            # Store event for hot storage
            processed_events.append(event)
            self._event_buffer.append(event)

        # Cleanup old windows
        self._cleanup_old_windows()

        # Write to hot storage if buffer is full or time elapsed
        should_flush = (
            len(self._event_buffer) >= self.config.batch_size or
            datetime.utcnow() - self._last_flush >= self.config.flush_interval
        )

        if should_flush:
            await self.write_hot_store(list(self._event_buffer))
            self._event_buffer.clear()
            self._last_flush = datetime.utcnow()

        logger.debug(f"Processed {len(events)} events through speed layer")

    async def aggregate_window(self, window_type: str = "both") -> List[AggregationResult]:
        """Compute aggregations for current windows.

        Args:
            window_type: Type of windows to aggregate ("sliding", "tumbling", or "both")

        Returns:
            List of aggregation results
        """
        results = []

        if window_type in ("sliding", "both"):
            for window in self._sliding_windows.values():
                if window.events:
                    results.append(window.aggregate())

        if window_type in ("tumbling", "both"):
            for window in self._tumbling_windows.values():
                if window.events:
                    results.append(window.aggregate())

        return results

    async def write_hot_store(self, events: List[EventSchema]) -> None:
        """Write events to hot storage systems (Cosmos DB and Azure Data Explorer).

        Args:
            events: Events to write to hot storage
        """
        if not events:
            return

        # Write to Cosmos DB for operational queries
        if self._cosmos_client:
            await self._write_to_cosmos(events)

        # Write to Azure Data Explorer for analytical queries
        if self._kusto_client:
            await self._write_to_adx(events)

    async def _write_to_cosmos(self, events: List[EventSchema]) -> None:
        """Write events to Cosmos DB."""
        try:
            database = self._cosmos_client.get_database_client(self.config.cosmos_database_name)
            container = database.get_container_client(self.config.cosmos_container_name)

            # Convert events to Cosmos DB documents
            documents = []
            for event in events:
                doc = {
                    "id": event.id,
                    "timestamp": event.timestamp.isoformat(),
                    "event_type": event.event_type,
                    "source": event.source,
                    "payload": event.payload,
                    "processed_at": datetime.utcnow().isoformat(),
                    "_ts": int(event.timestamp.timestamp())
                }
                documents.append(doc)

            # Batch upsert documents
            for doc in documents:
                await container.upsert_item(doc)

            logger.debug(f"Wrote {len(documents)} events to Cosmos DB")

        except Exception as e:
            logger.error(f"Failed to write to Cosmos DB: {e}", exc_info=True)

    async def _write_to_adx(self, events: List[EventSchema]) -> None:
        """Write events to Azure Data Explorer."""
        try:
            # Convert events to ADX ingest format
            data_rows = []
            for event in events:
                row = [
                    event.id,
                    event.timestamp,
                    event.event_type,
                    event.source,
                    json.dumps(event.payload),
                    None,  # window_start (null for raw events)
                    None,  # window_end (null for raw events)
                    "raw",  # window_type
                    datetime.utcnow()
                ]
                data_rows.append(row)

            # Ingest data
            ingest_command = f"""
            .ingest inline into table {self.config.adx_table_name} <|
            {chr(10).join([','.join([str(cell) if cell is not None else '' for cell in row]) for row in data_rows])}
            """

            self._kusto_client.execute(self.config.adx_database_name, ingest_command)
            logger.debug(f"Wrote {len(events)} events to ADX")

        except Exception as e:
            logger.error(f"Failed to write to ADX: {e}", exc_info=True)

    async def close(self) -> None:
        """Close connections and cleanup resources."""
        if self._cosmos_client:
            await self._cosmos_client.close()

        # Note: Kusto client doesn't have async close
        self._kusto_client = None

        logger.info("Speed layer closed")


# EventCallback implementation for integration with EventProcessor
class SpeedLayerCallback:
    """Callback adapter for integrating SpeedLayer with EventProcessor."""

    def __init__(self, speed_layer: SpeedLayer):
        self.speed_layer = speed_layer

    async def __call__(self, events: List[EventSchema]) -> None:
        """Process events through the speed layer."""
        await self.speed_layer.process_realtime(events)


if __name__ == "__main__":
    import os

    async def main():
        """Example usage of SpeedLayer."""
        config = SpeedLayerConfig(
            cosmos_endpoint=os.environ.get("COSMOS_ENDPOINT"),
            adx_cluster_url=os.environ.get("ADX_CLUSTER_URL"),
            batch_size=10,
            flush_interval=timedelta(seconds=5)
        )

        speed_layer = SpeedLayer(config)
        await speed_layer.initialize()

        # Example events
        sample_events = [
            EventSchema(
                id="test-1",
                timestamp=datetime.utcnow(),
                event_type="temperature",
                source="sensor-01",
                payload={"value": 23.5, "unit": "C", "location": "office"}
            ),
            EventSchema(
                id="test-2",
                timestamp=datetime.utcnow(),
                event_type="temperature",
                source="sensor-02",
                payload={"value": 25.1, "unit": "C", "location": "warehouse"}
            )
        ]

        # Process events
        await speed_layer.process_realtime(sample_events)

        # Get aggregations
        aggregations = await speed_layer.aggregate_window()
        for agg in aggregations:
            print(f"Window {agg.window_start} - {agg.window_end}: {agg.event_count} events")

        await speed_layer.close()

    if os.environ.get("COSMOS_ENDPOINT") or os.environ.get("ADX_CLUSTER_URL"):
        asyncio.run(main())
    else:
        print("Set COSMOS_ENDPOINT or ADX_CLUSTER_URL environment variables to test")
