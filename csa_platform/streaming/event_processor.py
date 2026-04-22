# -*- coding: utf-8 -*-
"""csa_platform.streaming.event_processor — Generic Event Hubs processor with checkpointing.

This module provides a generic event processor that reads from Azure Event Hubs,
supports multiple event types, handles checkpointing via Azure Blob Storage,
and provides a callback pattern for processing events through the Lambda architecture.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Protocol, Union

from azure.eventhub import EventData
from azure.eventhub.aio import EventHubConsumerClient
from azure.eventhub.extensions.checkpointstoreblobaio import BlobCheckpointStore
from azure.identity.aio import DefaultAzureCredential

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EventSchema:
    """Common event schema for all event types processed by the Lambda architecture.

    This provides a unified interface for events from different sources
    (earthquake data, weather, IoT, clickstream, etc.)
    """
    id: str
    timestamp: datetime
    event_type: str
    source: str
    payload: Dict[str, Any]
    raw_data: Optional[bytes] = None
    partition_key: Optional[str] = None
    sequence_number: Optional[int] = None
    offset: Optional[str] = None


class EventCallback(Protocol):
    """Protocol for event processing callbacks."""

    async def __call__(self, events: List[EventSchema]) -> None:
        """Process a batch of events.

        Args:
            events: List of EventSchema objects to process
        """
        ...


@dataclass
class EventProcessorConfig:
    """Configuration for the EventProcessor."""
    connection_string: str
    eventhub_name: str
    consumer_group: str = "$Default"
    checkpoint_store_connection_string: Optional[str] = None
    checkpoint_container_name: str = "checkpoints"
    batch_size: int = 10
    max_wait_time: int = 30
    prefetch_count: int = 300
    track_last_enqueued_event_properties: bool = True
    starting_position: str = "-1"  # Latest events

    # Event parsing settings
    event_type_field: str = "event_type"
    timestamp_field: str = "timestamp"
    id_field: str = "id"
    source_field: str = "source"

    # Graceful shutdown settings
    shutdown_timeout: int = 30


class EventProcessor:
    """Generic Azure Event Hubs event processor with Lambda architecture support.

    Features:
    - Reads from Azure Event Hubs using async client
    - Supports multiple event types (earthquake, weather, IoT, etc.)
    - Checkpointing via Azure Blob Storage
    - Callback pattern for processing events
    - Graceful shutdown handling
    - Error handling and retry logic
    """

    def __init__(self, config: EventProcessorConfig):
        """Initialize the event processor.

        Args:
            config: Configuration for the event processor
        """
        self.config = config
        self._running = False
        self._shutdown_event = asyncio.Event()
        self._consumer_client: Optional[EventHubConsumerClient] = None
        self._checkpoint_store: Optional[BlobCheckpointStore] = None
        self._callbacks: List[EventCallback] = []

    def add_callback(self, callback: EventCallback) -> None:
        """Add an event processing callback.

        Args:
            callback: Callback function to process events
        """
        self._callbacks.append(callback)

    def remove_callback(self, callback: EventCallback) -> None:
        """Remove an event processing callback.

        Args:
            callback: Callback function to remove
        """
        if callback in self._callbacks:
            self._callbacks.remove(callback)

    async def _initialize_client(self) -> None:
        """Initialize the Event Hubs consumer client."""
        # Initialize checkpoint store if configured
        if self.config.checkpoint_store_connection_string:
            credential = DefaultAzureCredential()
            self._checkpoint_store = BlobCheckpointStore(
                blob_account_url=self.config.checkpoint_store_connection_string,
                container_name=self.config.checkpoint_container_name,
                credential=credential
            )

        # Initialize consumer client
        self._consumer_client = EventHubConsumerClient.from_connection_string(
            conn_str=self.config.connection_string,
            consumer_group=self.config.consumer_group,
            eventhub_name=self.config.eventhub_name,
            checkpoint_store=self._checkpoint_store
        )

    def _parse_event(self, event_data: EventData) -> EventSchema:
        """Parse an EventData object into an EventSchema.

        Args:
            event_data: Azure Event Hubs EventData object

        Returns:
            EventSchema object with parsed data
        """
        try:
            # Parse JSON payload
            if hasattr(event_data, 'body') and event_data.body:
                body_str = event_data.body.decode('utf-8')
                payload = json.loads(body_str)
            else:
                payload = {}

            # Extract common fields with fallbacks
            event_id = payload.get(self.config.id_field, f"event_{event_data.sequence_number}")

            # Parse timestamp
            timestamp_raw = payload.get(self.config.timestamp_field)
            if timestamp_raw:
                if isinstance(timestamp_raw, str):
                    try:
                        timestamp = datetime.fromisoformat(timestamp_raw.replace('Z', '+00:00'))
                    except ValueError:
                        timestamp = datetime.utcnow()
                else:
                    timestamp = datetime.utcnow()
            else:
                timestamp = datetime.utcnow()

            event_type = payload.get(self.config.event_type_field, "unknown")
            source = payload.get(self.config.source_field, "unknown")

            return EventSchema(
                id=event_id,
                timestamp=timestamp,
                event_type=event_type,
                source=source,
                payload=payload,
                raw_data=event_data.body,
                partition_key=event_data.partition_key,
                sequence_number=event_data.sequence_number,
                offset=event_data.offset
            )

        except Exception as e:
            logger.warning(f"Failed to parse event {event_data.sequence_number}: {e}")
            # Return a minimal event schema for unparseable events
            return EventSchema(
                id=f"event_{event_data.sequence_number}",
                timestamp=datetime.utcnow(),
                event_type="parse_error",
                source="unknown",
                payload={"error": str(e)},
                raw_data=event_data.body,
                partition_key=event_data.partition_key,
                sequence_number=event_data.sequence_number,
                offset=event_data.offset
            )

    async def _process_events_batch(self, partition_context, events: List[EventData]) -> None:
        """Process a batch of events through registered callbacks.

        Args:
            partition_context: Event Hubs partition context for checkpointing
            events: List of EventData objects to process
        """
        if not events or not self._callbacks:
            return

        try:
            # Parse events into EventSchema objects
            parsed_events = [self._parse_event(event) for event in events]

            # Process through all callbacks
            for callback in self._callbacks:
                try:
                    await callback(parsed_events)
                except Exception as e:
                    logger.error(f"Callback failed: {e}", exc_info=True)

            # Update checkpoint after successful processing
            if self._checkpoint_store and events:
                await partition_context.update_checkpoint(events[-1])
                logger.debug(f"Updated checkpoint for partition {partition_context.partition_id}")

        except Exception as e:
            logger.error(f"Failed to process events batch: {e}", exc_info=True)

    async def _on_partition_initialize(self, partition_context) -> None:
        """Handle partition initialization."""
        logger.info(f"Initializing partition {partition_context.partition_id}")

    async def _on_partition_close(self, partition_context, reason) -> None:
        """Handle partition close."""
        logger.info(f"Closing partition {partition_context.partition_id}, reason: {reason}")

    async def _on_error(self, partition_context, error) -> None:
        """Handle errors during processing."""
        logger.error(f"Error in partition {partition_context.partition_id}: {error}")

    async def process_events(self) -> None:
        """Start processing events from Event Hubs.

        This method runs until shutdown is requested.
        """
        if not self._consumer_client:
            await self._initialize_client()

        if not self._consumer_client:
            raise RuntimeError("Failed to initialize Event Hubs consumer client")

        self._running = True
        logger.info(f"Starting event processor for {self.config.eventhub_name}")

        try:
            async with self._consumer_client:
                await self._consumer_client.receive_batch(
                    on_event_batch=self._process_events_batch,
                    on_partition_initialize=self._on_partition_initialize,
                    on_partition_close=self._on_partition_close,
                    on_error=self._on_error,
                    max_batch_size=self.config.batch_size,
                    max_wait_time=self.config.max_wait_time,
                    prefetch=self.config.prefetch_count,
                    track_last_enqueued_event_properties=self.config.track_last_enqueued_event_properties,
                    starting_position=self.config.starting_position
                )
        except Exception as e:
            logger.error(f"Event processing failed: {e}", exc_info=True)
            raise
        finally:
            self._running = False
            logger.info("Event processor stopped")

    async def shutdown(self) -> None:
        """Gracefully shutdown the event processor."""
        logger.info("Shutting down event processor...")
        self._shutdown_event.set()

        # Wait for processing to stop
        timeout = self.config.shutdown_timeout
        start_time = asyncio.get_event_loop().time()

        while self._running and (asyncio.get_event_loop().time() - start_time) < timeout:
            await asyncio.sleep(0.1)

        if self._running:
            logger.warning(f"Event processor did not shutdown within {timeout} seconds")

        # Close resources
        if self._consumer_client:
            await self._consumer_client.close()
            self._consumer_client = None

        if self._checkpoint_store:
            await self._checkpoint_store.close()
            self._checkpoint_store = None

        logger.info("Event processor shutdown complete")

    @property
    def is_running(self) -> bool:
        """Check if the event processor is currently running."""
        return self._running


if __name__ == "__main__":
    import os
    from typing import List

    # Example callback for testing
    async def example_callback(events: List[EventSchema]) -> None:
        """Example callback that logs events."""
        for event in events:
            print(f"Processed event: {event.event_type} from {event.source} at {event.timestamp}")

    async def main():
        # Example configuration - replace with actual values
        config = EventProcessorConfig(
            connection_string=os.environ.get("EVENTHUB_CONNECTION_STRING", ""),
            eventhub_name=os.environ.get("EVENTHUB_NAME", "test-hub"),
            consumer_group="$Default",
            checkpoint_store_connection_string=os.environ.get("STORAGE_CONNECTION_STRING"),
            checkpoint_container_name="checkpoints",
            batch_size=5,
            max_wait_time=10
        )

        processor = EventProcessor(config)
        processor.add_callback(example_callback)

        try:
            await processor.process_events()
        except KeyboardInterrupt:
            logger.info("Received interrupt signal")
        finally:
            await processor.shutdown()

    if os.environ.get("EVENTHUB_CONNECTION_STRING"):
        asyncio.run(main())
    else:
        print("Set EVENTHUB_CONNECTION_STRING environment variable to test")