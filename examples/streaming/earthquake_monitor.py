"""Real-time earthquake monitoring using CSA Lambda architecture.

This example demonstrates the complete Lambda architecture pipeline:
1. Producer: Fetches earthquake data from USGS GeoJSON feed
2. Event Hub: Publishes events to Azure Event Hubs
3. Speed Layer: Real-time processing and aggregation
4. Batch Layer: Periodic reprocessing for accuracy
5. Serving Layer: Unified queries across hot and cold paths
6. Dashboard: Real-time terminal display

Usage:
    python earthquake_monitor.py --mode produce    # Producer only
    python earthquake_monitor.py --mode consume    # Consumer only
    python earthquake_monitor.py --mode both       # Both producer and consumer
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import aiohttp
from azure.eventhub.aio import EventHubProducerClient
from azure.identity.aio import DefaultAzureCredential

# Import CSA streaming components
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from csa_platform.streaming import (
    EventProcessor,
    EventProcessorConfig,
    EventSchema,
    SpeedLayer,
    SpeedLayerConfig,
    BatchLayer,
    BatchLayerConfig,
    ServingLayer,
    ServingLayerConfig,
    QueryConfig
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class EarthquakeProducer:
    """Fetches earthquake data from USGS and publishes to Event Hub."""

    def __init__(self, eventhub_connection_string: str, eventhub_name: str):
        """Initialize the earthquake producer.

        Args:
            eventhub_connection_string: Azure Event Hub connection string
            eventhub_name: Name of the Event Hub
        """
        self.connection_string = eventhub_connection_string
        self.eventhub_name = eventhub_name
        self._client: Optional[EventHubProducerClient] = None
        self._running = False

    async def initialize(self) -> None:
        """Initialize the Event Hub producer client."""
        self._client = EventHubProducerClient.from_connection_string(
            conn_str=self.connection_string,
            eventhub_name=self.eventhub_name
        )
        logger.info("Earthquake producer initialized")

    async def fetch_earthquakes(self, min_magnitude: float = 2.5) -> List[Dict[str, Any]]:
        """Fetch recent earthquake data from USGS GeoJSON feed.

        Args:
            min_magnitude: Minimum earthquake magnitude to fetch

        Returns:
            List of earthquake events
        """
        # USGS earthquake feed URLs
        feeds = {
            1.0: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
            2.5: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
            4.5: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson",
        }

        # Select appropriate feed
        feed_url = feeds.get(min_magnitude, feeds[2.5])

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(feed_url) as response:
                    if response.status == 200:
                        data = await response.json()
                        earthquakes = data.get("features", [])
                        logger.info(f"Fetched {len(earthquakes)} earthquakes from USGS")
                        return earthquakes
                    else:
                        logger.error(f"Failed to fetch earthquakes: HTTP {response.status}")
                        return []

        except Exception as e:
            logger.error(f"Error fetching earthquakes: {e}")
            return []

    def _convert_to_event_schema(self, earthquake: Dict[str, Any]) -> EventSchema:
        """Convert USGS earthquake data to EventSchema.

        Args:
            earthquake: USGS GeoJSON earthquake feature

        Returns:
            EventSchema with earthquake data
        """
        properties = earthquake.get("properties", {})
        geometry = earthquake.get("geometry", {})
        coordinates = geometry.get("coordinates", [0, 0, 0])

        # Extract key earthquake properties
        magnitude = properties.get("mag", 0.0)
        place = properties.get("place", "Unknown")
        timestamp_ms = properties.get("time", 0)
        earthquake_time = datetime.fromtimestamp(timestamp_ms / 1000) if timestamp_ms else datetime.utcnow()

        # Create event payload
        payload = {
            "magnitude": magnitude,
            "place": place,
            "longitude": coordinates[0] if len(coordinates) > 0 else 0,
            "latitude": coordinates[1] if len(coordinates) > 1 else 0,
            "depth_km": coordinates[2] if len(coordinates) > 2 else 0,
            "url": properties.get("url", ""),
            "detail": properties.get("detail", ""),
            "felt": properties.get("felt"),
            "cdi": properties.get("cdi"),  # Community Decimal Intensity
            "mmi": properties.get("mmi"),  # Modified Mercalli Intensity
            "alert": properties.get("alert"),  # Alert level
            "tsunami": properties.get("tsunami", 0),
            "sig": properties.get("sig", 0),  # Significance
            "net": properties.get("net", ""),  # Network
            "code": properties.get("code", ""),
            "ids": properties.get("ids", ""),
            "sources": properties.get("sources", ""),
            "types": properties.get("types", ""),
            "nst": properties.get("nst"),  # Number of seismic stations
            "dmin": properties.get("dmin"),  # Minimum distance
            "rms": properties.get("rms"),  # Root mean square
            "gap": properties.get("gap"),  # Azimuthal gap
            "magnitude_type": properties.get("magType", ""),
            "title": properties.get("title", "")
        }

        return EventSchema(
            id=earthquake.get("id", f"eq_{timestamp_ms}"),
            timestamp=earthquake_time,
            event_type="earthquake",
            source="usgs",
            payload=payload,
            raw_data=json.dumps(earthquake).encode('utf-8')
        )

    async def publish_earthquakes(self, earthquakes: List[Dict[str, Any]]) -> None:
        """Publish earthquake events to Event Hub.

        Args:
            earthquakes: List of earthquake data from USGS
        """
        if not earthquakes or not self._client:
            return

        try:
            # Convert to EventSchema and then to Event Hub events
            events = []
            for eq in earthquakes:
                event_schema = self._convert_to_event_schema(eq)

                # Create Event Hub event
                event_data = {
                    "id": event_schema.id,
                    "timestamp": event_schema.timestamp.isoformat(),
                    "event_type": event_schema.event_type,
                    "source": event_schema.source,
                    "payload": event_schema.payload
                }

                events.append(json.dumps(event_data))

            # Send batch to Event Hub
            async with self._client:
                event_data_batch = await self._client.create_batch()

                for event_json in events:
                    try:
                        event_data_batch.add(event_json)
                    except ValueError:
                        # Batch is full, send it and create a new one
                        await self._client.send_batch(event_data_batch)
                        event_data_batch = await self._client.create_batch()
                        event_data_batch.add(event_json)

                # Send the last batch
                if len(event_data_batch) > 0:
                    await self._client.send_batch(event_data_batch)

            logger.info(f"Published {len(events)} earthquake events to Event Hub")

        except Exception as e:
            logger.error(f"Failed to publish earthquakes: {e}")

    async def run_producer(self, interval_seconds: int = 300) -> None:
        """Run the earthquake producer continuously.

        Args:
            interval_seconds: Interval between fetches (default: 5 minutes)
        """
        self._running = True
        logger.info(f"Starting earthquake producer (fetching every {interval_seconds} seconds)")

        while self._running:
            try:
                # Fetch and publish earthquakes
                earthquakes = await self.fetch_earthquakes()
                if earthquakes:
                    await self.publish_earthquakes(earthquakes)

                # Wait for next interval
                await asyncio.sleep(interval_seconds)

            except Exception as e:
                logger.error(f"Producer error: {e}")
                await asyncio.sleep(30)  # Wait 30 seconds on error

    def stop(self) -> None:
        """Stop the producer."""
        self._running = False
        logger.info("Earthquake producer stopping...")

    async def close(self) -> None:
        """Close producer connections."""
        if self._client:
            await self._client.close()
        logger.info("Earthquake producer closed")


class EarthquakeMonitor:
    """Real-time earthquake monitoring using Lambda architecture."""

    def __init__(self, config: Dict[str, Any]):
        """Initialize the earthquake monitor.

        Args:
            config: Configuration dictionary with connection strings
        """
        self.config = config
        self.event_processor: Optional[EventProcessor] = None
        self.speed_layer: Optional[SpeedLayer] = None
        self.batch_layer: Optional[BatchLayer] = None
        self.serving_layer: Optional[ServingLayer] = None
        self._running = False

        # Statistics
        self.stats = {
            "events_processed": 0,
            "total_earthquakes": 0,
            "max_magnitude": 0.0,
            "magnitude_ranges": {"1.0-2.9": 0, "3.0-3.9": 0, "4.0-4.9": 0, "5.0+": 0},
            "locations": {},
            "last_update": None
        }

    async def initialize(self) -> None:
        """Initialize all Lambda architecture components."""
        # Initialize Event Processor
        event_config = EventProcessorConfig(
            connection_string=self.config["eventhub_connection_string"],
            eventhub_name=self.config["eventhub_name"],
            consumer_group="$Default",
            batch_size=10,
            max_wait_time=30
        )
        self.event_processor = EventProcessor(event_config)

        # Initialize Speed Layer
        speed_config = SpeedLayerConfig(
            cosmos_endpoint=self.config.get("cosmos_endpoint"),
            adx_cluster_url=self.config.get("adx_cluster_url"),
            batch_size=50,
            flush_interval=timedelta(seconds=30)
        )
        self.speed_layer = SpeedLayer(speed_config)
        await self.speed_layer.initialize()

        # Initialize Batch Layer
        batch_config = BatchLayerConfig(
            adls_account_url=self.config.get("adls_account_url", ""),
            reprocess_window=timedelta(hours=6)
        )
        self.batch_layer = BatchLayer(batch_config)
        await self.batch_layer.initialize()

        # Initialize Serving Layer
        serving_config = ServingLayerConfig(
            adx_cluster_url=self.config.get("adx_cluster_url"),
            cosmos_endpoint=self.config.get("cosmos_endpoint")
        )
        self.serving_layer = ServingLayer(serving_config)
        await self.serving_layer.initialize()

        # Connect Event Processor to Speed Layer
        from csa_platform.streaming.speed_layer import SpeedLayerCallback
        speed_callback = SpeedLayerCallback(self.speed_layer)
        self.event_processor.add_callback(speed_callback)
        self.event_processor.add_callback(self._update_statistics)

        logger.info("Earthquake monitor initialized")

    async def _update_statistics(self, events: List[EventSchema]) -> None:
        """Update monitoring statistics.

        Args:
            events: List of processed events
        """
        for event in events:
            if event.event_type == "earthquake":
                self.stats["events_processed"] += 1
                self.stats["total_earthquakes"] += 1

                magnitude = event.payload.get("magnitude", 0.0)
                place = event.payload.get("place", "Unknown")

                # Update max magnitude
                if magnitude > self.stats["max_magnitude"]:
                    self.stats["max_magnitude"] = magnitude

                # Update magnitude ranges
                if 1.0 <= magnitude < 3.0:
                    self.stats["magnitude_ranges"]["1.0-2.9"] += 1
                elif 3.0 <= magnitude < 4.0:
                    self.stats["magnitude_ranges"]["3.0-3.9"] += 1
                elif 4.0 <= magnitude < 5.0:
                    self.stats["magnitude_ranges"]["4.0-4.9"] += 1
                elif magnitude >= 5.0:
                    self.stats["magnitude_ranges"]["5.0+"] += 1

                # Update locations (simplified)
                location_key = place.split(',')[-1].strip() if ',' in place else place
                self.stats["locations"][location_key] = self.stats["locations"].get(location_key, 0) + 1

                self.stats["last_update"] = datetime.utcnow()

    def display_dashboard(self) -> None:
        """Display real-time dashboard in terminal."""
        # Clear screen (works on most terminals)
        print("\033[2J\033[H", end="")

        print("=" * 80)
        print("🌍 REAL-TIME EARTHQUAKE MONITORING DASHBOARD")
        print("=" * 80)
        print()

        # Current statistics
        print(f"📊 STATISTICS:")
        print(f"   Events Processed: {self.stats['events_processed']}")
        print(f"   Total Earthquakes: {self.stats['total_earthquakes']}")
        print(f"   Max Magnitude: {self.stats['max_magnitude']:.1f}")
        print(f"   Last Update: {self.stats['last_update'].strftime('%Y-%m-%d %H:%M:%S') if self.stats['last_update'] else 'None'}")
        print()

        # Magnitude distribution
        print(f"📈 MAGNITUDE DISTRIBUTION:")
        for range_name, count in self.stats["magnitude_ranges"].items():
            bar = "█" * min(count, 50)  # Simple bar chart
            print(f"   {range_name}: {count:4d} {bar}")
        print()

        # Top locations
        print(f"🌎 TOP LOCATIONS:")
        sorted_locations = sorted(
            self.stats["locations"].items(),
            key=lambda x: x[1],
            reverse=True
        )
        for location, count in sorted_locations[:10]:
            print(f"   {location[:30]:30s}: {count:3d}")
        print()

        # Recent earthquakes (if speed layer is available)
        if self.speed_layer:
            print(f"⚡ SPEED LAYER WINDOWS:")
            print(f"   Active sliding windows: {len(getattr(self.speed_layer, '_sliding_windows', {}))}")
            print(f"   Active tumbling windows: {len(getattr(self.speed_layer, '_tumbling_windows', {}))}")
        print()

        print("=" * 80)
        print("Press Ctrl+C to stop monitoring")
        print("=" * 80)

    async def run_consumer(self) -> None:
        """Run the earthquake consumer (Lambda architecture processing)."""
        self._running = True
        logger.info("Starting earthquake monitor consumer")

        # Start event processing
        processing_task = asyncio.create_task(self.event_processor.process_events())

        # Start dashboard updates
        async def dashboard_loop():
            while self._running:
                self.display_dashboard()
                await asyncio.sleep(5)  # Update every 5 seconds

        dashboard_task = asyncio.create_task(dashboard_loop())

        try:
            await asyncio.gather(processing_task, dashboard_task)
        except asyncio.CancelledError:
            logger.info("Consumer tasks cancelled")

    def stop(self) -> None:
        """Stop the monitor."""
        self._running = False
        logger.info("Earthquake monitor stopping...")

    async def close(self) -> None:
        """Close all connections."""
        if self.event_processor:
            await self.event_processor.shutdown()

        if self.speed_layer:
            await self.speed_layer.close()

        if self.batch_layer:
            await self.batch_layer.close()

        if self.serving_layer:
            await self.serving_layer.close()

        logger.info("Earthquake monitor closed")


async def main():
    """Main function for earthquake monitoring."""
    parser = argparse.ArgumentParser(description="Real-time earthquake monitoring")
    parser.add_argument(
        "--mode",
        choices=["produce", "consume", "both"],
        default="both",
        help="Operation mode"
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=300,
        help="Producer fetch interval in seconds (default: 300)"
    )

    args = parser.parse_args()

    # Configuration from environment variables
    config = {
        "eventhub_connection_string": os.environ.get("EVENTHUB_CONNECTION_STRING"),
        "eventhub_name": os.environ.get("EVENTHUB_NAME", "earthquakes"),
        "cosmos_endpoint": os.environ.get("COSMOS_ENDPOINT"),
        "adx_cluster_url": os.environ.get("ADX_CLUSTER_URL"),
        "adls_account_url": os.environ.get("ADLS_ACCOUNT_URL")
    }

    # Validate required configuration
    if not config["eventhub_connection_string"]:
        print("Error: EVENTHUB_CONNECTION_STRING environment variable is required")
        sys.exit(1)

    # Initialize components
    producer = None
    monitor = None

    async def shutdown_handler():
        """Handle graceful shutdown."""
        logger.info("Received shutdown signal")
        if producer:
            producer.stop()
        if monitor:
            monitor.stop()

    # Set up signal handlers
    loop = asyncio.get_running_loop()
    for sig in [signal.SIGTERM, signal.SIGINT]:
        loop.add_signal_handler(sig, lambda: asyncio.create_task(shutdown_handler()))

    try:
        tasks = []

        # Start producer if requested
        if args.mode in ["produce", "both"]:
            producer = EarthquakeProducer(
                config["eventhub_connection_string"],
                config["eventhub_name"]
            )
            await producer.initialize()
            tasks.append(producer.run_producer(args.interval))

        # Start consumer if requested
        if args.mode in ["consume", "both"]:
            monitor = EarthquakeMonitor(config)
            await monitor.initialize()
            tasks.append(monitor.run_consumer())

        # Run selected components
        if tasks:
            await asyncio.gather(*tasks)
        else:
            print("No mode selected")

    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
    except Exception as e:
        logger.error(f"Application error: {e}", exc_info=True)
    finally:
        # Cleanup
        if producer:
            await producer.close()
        if monitor:
            await monitor.close()

        logger.info("Earthquake monitoring stopped")


if __name__ == "__main__":
    asyncio.run(main())
