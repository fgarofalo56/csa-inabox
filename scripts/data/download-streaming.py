#!/usr/bin/env python3
"""
Download real-time streaming data feeds.

Connects to real-time data feeds for streaming tutorials and demonstrations.
Supports USGS earthquakes, NOAA weather alerts, and Wikimedia recent changes.

Data sources:
- USGS Earthquakes: https://earthquake.usgs.gov/earthquakes/feed/
- NOAA Weather Alerts: https://api.weather.gov/alerts
- Wikimedia Recent Changes: https://stream.wikimedia.org/
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import requests
from tqdm import tqdm

# Optional import for Azure Event Hubs
try:
    from azure.eventhub import EventHubProducerClient, EventData
    HAS_AZURE_EVENTHUB = True
except ImportError:
    HAS_AZURE_EVENTHUB = False
    logging.warning("azure-eventhub not available - Event Hub output disabled")

# Optional import for Server-Sent Events
try:
    import sseclient
    HAS_SSECLIENT = True
except ImportError:
    HAS_SSECLIENT = False
    logging.warning("sseclient-py not available - Wikimedia stream disabled")


def setup_logging(verbose: bool = False) -> None:
    """Set up logging configuration."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )


class StreamingDataCollector:
    """Collect real-time streaming data from various sources."""

    USGS_EARTHQUAKE_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
    NOAA_ALERTS_URL = "https://api.weather.gov/alerts/active"
    WIKIMEDIA_STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

    def __init__(self, output_type: str = "file", eventhub_connection_string: Optional[str] = None):
        """Initialize collector."""
        self.output_type = output_type
        self.eventhub_connection_string = eventhub_connection_string
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'CSA-in-a-Box Data Collector (research/educational use)'
        })

        # Initialize Event Hub client if needed
        self.eventhub_client = None
        if output_type == "eventhub" and HAS_AZURE_EVENTHUB and eventhub_connection_string:
            try:
                self.eventhub_client = EventHubProducerClient.from_connection_string(
                    eventhub_connection_string
                )
                logging.info("Connected to Event Hub")
            except Exception as e:
                logging.error(f"Failed to connect to Event Hub: {e}")

    def collect_earthquake_data(self, duration_seconds: int, output_file: Optional[str] = None) -> List[Dict]:
        """Collect USGS earthquake data by polling."""
        data_points = []
        start_time = time.time()
        last_earthquake_count = 0

        with tqdm(desc="Collecting earthquake data", unit="polls") as pbar:
            while time.time() - start_time < duration_seconds:
                try:
                    response = self.session.get(self.USGS_EARTHQUAKE_URL, timeout=10)
                    response.raise_for_status()
                    earthquake_data = response.json()

                    timestamp = datetime.utcnow().isoformat() + 'Z'
                    earthquakes = earthquake_data.get('features', [])

                    # Only process if we have new earthquakes
                    if len(earthquakes) != last_earthquake_count:
                        data_point = {
                            'timestamp': timestamp,
                            'source': 'usgs_earthquake',
                            'earthquake_count': len(earthquakes),
                            'earthquakes': earthquakes
                        }

                        data_points.append(data_point)
                        last_earthquake_count = len(earthquakes)

                        self._output_data(data_point, output_file)

                    pbar.update(1)

                except requests.RequestException as e:
                    logging.warning(f"Failed to get earthquake data: {e}")

                time.sleep(60)  # Poll every minute

        return data_points

    def collect_weather_alerts(self, duration_seconds: int, output_file: Optional[str] = None) -> List[Dict]:
        """Collect NOAA weather alerts by polling."""
        data_points = []
        start_time = time.time()
        last_alert_count = 0

        with tqdm(desc="Collecting weather alerts", unit="polls") as pbar:
            while time.time() - start_time < duration_seconds:
                try:
                    response = self.session.get(self.NOAA_ALERTS_URL, timeout=10)
                    response.raise_for_status()
                    alerts_data = response.json()

                    timestamp = datetime.utcnow().isoformat() + 'Z'
                    alerts = alerts_data.get('features', [])

                    # Only process if we have new alerts
                    if len(alerts) != last_alert_count:
                        data_point = {
                            'timestamp': timestamp,
                            'source': 'noaa_weather_alerts',
                            'alert_count': len(alerts),
                            'alerts': alerts
                        }

                        data_points.append(data_point)
                        last_alert_count = len(alerts)

                        self._output_data(data_point, output_file)

                    pbar.update(1)

                except requests.RequestException as e:
                    logging.warning(f"Failed to get weather alerts: {e}")

                time.sleep(30)  # Poll every 30 seconds

        return data_points

    def collect_wikimedia_stream(self, duration_seconds: int, output_file: Optional[str] = None) -> List[Dict]:
        """Collect Wikimedia recent changes via Server-Sent Events."""
        if not HAS_SSECLIENT:
            logging.error("sseclient-py required for Wikimedia stream")
            return []

        data_points = []
        start_time = time.time()

        try:
            response = self.session.get(self.WIKIMEDIA_STREAM_URL, stream=True, timeout=30)
            client = sseclient.SSEClient(response)

            with tqdm(desc="Collecting Wikimedia changes", unit="events") as pbar:
                for event in client.events():
                    if time.time() - start_time >= duration_seconds:
                        break

                    if event.data:
                        try:
                            change_data = json.loads(event.data)
                            timestamp = datetime.utcnow().isoformat() + 'Z'

                            data_point = {
                                'timestamp': timestamp,
                                'source': 'wikimedia_recentchange',
                                'event_type': event.event,
                                'data': change_data
                            }

                            data_points.append(data_point)
                            self._output_data(data_point, output_file)

                            pbar.update(1)

                        except json.JSONDecodeError:
                            continue

        except Exception as e:
            logging.error(f"Failed to collect Wikimedia stream: {e}")

        return data_points

    def _output_data(self, data_point: Dict, output_file: Optional[str] = None) -> None:
        """Output data to file or Event Hub."""
        if self.output_type == "file" and output_file:
            # Append to JSONL file
            with open(output_file, 'a') as f:
                f.write(json.dumps(data_point) + '\n')

        elif self.output_type == "eventhub" and self.eventhub_client:
            try:
                event_data = EventData(json.dumps(data_point))
                with self.eventhub_client:
                    self.eventhub_client.send_batch([event_data])
                logging.debug("Sent data to Event Hub")
            except Exception as e:
                logging.error(f"Failed to send to Event Hub: {e}")

    def collect_all_feeds(self, duration_seconds: int, output_dir: Path) -> Dict[str, List[Dict]]:
        """Collect from all available feeds simultaneously (simplified)."""
        all_data = {}

        # For simplicity, collect sequentially with shorter durations
        feed_duration = duration_seconds // 3

        feeds = [
            ('earthquake', self.collect_earthquake_data),
            ('weather', self.collect_weather_alerts),
        ]

        # Add Wikimedia if available
        if HAS_SSECLIENT:
            feeds.append(('wikimedia', self.collect_wikimedia_stream))

        for feed_name, collect_func in feeds:
            logging.info(f"Starting {feed_name} collection for {feed_duration} seconds")
            output_file = output_dir / f"streaming_{feed_name}.jsonl" if self.output_type == "file" else None
            data = collect_func(feed_duration, output_file)
            all_data[feed_name] = data

        return all_data


def save_streaming_manifest(feeds_data: Dict[str, List[Dict]], output_dir: Path,
                          duration_seconds: int) -> None:
    """Save manifest for streaming data collection."""
    manifest_path = output_dir / "streaming_manifest.json"

    manifest = {
        'collection_info': {
            'duration_seconds': duration_seconds,
            'collection_timestamp': datetime.utcnow().isoformat() + 'Z',
            'feeds_collected': list(feeds_data.keys())
        },
        'feeds': {}
    }

    for feed_name, data in feeds_data.items():
        manifest['feeds'][feed_name] = {
            'event_count': len(data),
            'first_event': data[0]['timestamp'] if data else None,
            'last_event': data[-1]['timestamp'] if data else None,
            'output_file': f"streaming_{feed_name}.jsonl"
        }

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    logging.info(f"Saved streaming manifest: {len(feeds_data)} feeds")


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Collect real-time streaming data feeds",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--feed',
        choices=['earthquake', 'weather', 'wikimedia', 'all'],
        default='all',
        help='Data feed to collect from'
    )
    parser.add_argument(
        '--duration-seconds',
        type=int,
        default=60,
        help='Duration to collect data (seconds)'
    )
    parser.add_argument(
        '--output',
        choices=['file', 'eventhub'],
        default='file',
        help='Output destination'
    )
    parser.add_argument(
        '--eventhub-connection-string',
        help='Azure Event Hub connection string (required for eventhub output)'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/streaming/data/raw/',
        help='Output directory for files'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    setup_logging(args.verbose)

    # Validate Event Hub configuration
    if args.output == "eventhub":
        if not HAS_AZURE_EVENTHUB:
            print("Error: azure-eventhub package required for Event Hub output")
            sys.exit(1)

        if not args.eventhub_connection_string:
            eventhub_conn = os.getenv('EVENTHUB_CONNECTION_STRING')
            if not eventhub_conn:
                print("Error: Event Hub connection string required (use --eventhub-connection-string or EVENTHUB_CONNECTION_STRING env var)")
                sys.exit(1)
            args.eventhub_connection_string = eventhub_conn

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Initialize collector
    collector = StreamingDataCollector(
        output_type=args.output,
        eventhub_connection_string=args.eventhub_connection_string
    )

    try:
        logging.info(f"Starting {args.feed} data collection for {args.duration_seconds} seconds")

        if args.feed == 'all':
            # Collect from all feeds
            feeds_data = collector.collect_all_feeds(args.duration_seconds, output_dir)

            if args.output == "file":
                save_streaming_manifest(feeds_data, output_dir, args.duration_seconds)

        else:
            # Collect from specific feed
            output_file = None
            if args.output == "file":
                output_file = output_dir / f"streaming_{args.feed}.jsonl"

            if args.feed == 'earthquake':
                data = collector.collect_earthquake_data(args.duration_seconds, output_file)
            elif args.feed == 'weather':
                data = collector.collect_weather_alerts(args.duration_seconds, output_file)
            elif args.feed == 'wikimedia':
                data = collector.collect_wikimedia_stream(args.duration_seconds, output_file)

            if args.output == "file":
                feeds_data = {args.feed: data}
                save_streaming_manifest(feeds_data, output_dir, args.duration_seconds)

        logging.info("Data collection completed successfully")

    except KeyboardInterrupt:
        logging.info("Collection interrupted by user")
    except Exception as e:
        logging.error(f"Collection failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()