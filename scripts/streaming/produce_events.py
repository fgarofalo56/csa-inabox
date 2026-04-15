#!/usr/bin/env python3
"""Produce sample streaming events to Event Hub.

Generates realistic clickstream/IoT events and publishes them to Azure
Event Hub for the CSA-in-a-Box streaming pipeline.

Usage:
    # Produce 100 events/sec for 60 seconds:
    python produce_events.py --event-hub-namespace csaevents --event-hub-name events --rate 100 --duration 60

    # Produce with connection string:
    python produce_events.py --connection-string "Endpoint=sb://..." --event-hub-name events --rate 50

    # Dry run (print events to stdout):
    python produce_events.py --dry-run --rate 5 --duration 5

Prerequisites:
    pip install azure-eventhub azure-identity
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

# --- Event generation ---

EVENT_TYPES = [
    "page_view",
    "button_click",
    "form_submit",
    "search_query",
    "add_to_cart",
    "checkout_start",
    "purchase_complete",
    "error",
    "sensor_reading",
    "heartbeat",
]

PAGES = [
    "/",
    "/products",
    "/products/detail",
    "/cart",
    "/checkout",
    "/search",
    "/account",
    "/orders",
    "/help",
    "/about",
]

DEVICES = ["desktop", "mobile", "tablet", "iot_sensor", "api_client"]
REGIONS = ["eastus", "westus", "northeurope", "southeastasia", "brazilsouth"]
BROWSERS = ["Chrome", "Firefox", "Safari", "Edge", "Mobile App"]


def generate_event(event_num: int) -> dict[str, Any]:
    """Generate a single realistic event."""
    event_type = random.choices(
        EVENT_TYPES,
        weights=[30, 20, 5, 10, 8, 3, 2, 2, 15, 5],
        k=1,
    )[0]

    now = datetime.now(timezone.utc)
    customer_id = random.randint(1, 200) if random.random() > 0.3 else None

    base_event: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "source": "csa-inabox-producer",
        "type": event_type,
        "timestamp": now.isoformat(),
        "data": {
            "event_number": event_num,
            "session_id": f"sess-{random.randint(1, 1000):04d}",
            "customer_id": customer_id,
            "device": random.choice(DEVICES),
            "region": random.choice(REGIONS),
        },
    }

    # Type-specific enrichment
    if event_type in ("page_view", "button_click"):
        base_event["data"]["page"] = random.choice(PAGES)
        base_event["data"]["browser"] = random.choice(BROWSERS)
        base_event["data"]["load_time_ms"] = random.randint(50, 3000)

    elif event_type == "search_query":
        base_event["data"]["query"] = random.choice(
            [
                "laptop",
                "headphones",
                "running shoes",
                "data book",
                "yoga mat",
                "water bottle",
                "keyboard",
                "monitor",
            ]
        )
        base_event["data"]["results_count"] = random.randint(0, 500)

    elif event_type in ("add_to_cart", "purchase_complete"):
        base_event["data"]["product_id"] = random.randint(1, 50)
        base_event["data"]["amount"] = round(random.uniform(5, 500), 2)

    elif event_type == "sensor_reading":
        base_event["data"]["sensor_id"] = f"sensor-{random.randint(1, 50):03d}"
        base_event["data"]["temperature"] = round(random.gauss(22, 5), 1)
        base_event["data"]["humidity"] = round(random.uniform(30, 80), 1)

    elif event_type == "error":
        base_event["data"]["error_code"] = random.choice([400, 401, 403, 404, 500, 502, 503])
        base_event["data"]["error_message"] = random.choice(
            [
                "Resource not found",
                "Unauthorized",
                "Internal server error",
                "Gateway timeout",
                "Rate limit exceeded",
            ]
        )

    return base_event


async def produce_to_eventhub(
    namespace: str | None,
    connection_string: str | None,
    event_hub_name: str,
    rate: int,
    duration: int,
) -> None:
    """Publish events to Azure Event Hub."""
    from azure.eventhub import EventData
    from azure.eventhub.aio import EventHubProducerClient
    from azure.eventhub.exceptions import EventHubError

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=30),
        retry=retry_if_exception_type((EventHubError, OSError)),
    )
    async def _send_batch_with_retry(producer_client, batch):
        """Send an event batch with retry on transient Event Hub errors."""
        await producer_client.send_batch(batch)

    if connection_string:
        producer = EventHubProducerClient.from_connection_string(
            conn_str=connection_string,
            eventhub_name=event_hub_name,
        )
    else:
        from azure.identity.aio import DefaultAzureCredential

        credential = DefaultAzureCredential()
        fqns = f"{namespace}.servicebus.windows.net"
        producer = EventHubProducerClient(
            fully_qualified_namespace=fqns,
            eventhub_name=event_hub_name,
            credential=credential,
        )

    total_sent = 0
    start_time = time.monotonic()
    interval = 1.0 / rate

    print(f"Publishing {rate} events/sec to {event_hub_name} for {duration}s...")

    async with producer:
        while time.monotonic() - start_time < duration:
            batch = await producer.create_batch()
            batch_count = 0

            # Fill batch with events for this second
            for _ in range(min(rate, 500)):
                event = generate_event(total_sent + batch_count)
                try:
                    batch.add(EventData(json.dumps(event)))
                    batch_count += 1
                except ValueError:
                    break

            await _send_batch_with_retry(producer, batch)
            total_sent += batch_count

            elapsed = time.monotonic() - start_time
            if int(elapsed) % 10 == 0 and elapsed > 0:
                print(f"  {int(elapsed)}s: {total_sent} events sent ({total_sent / elapsed:.0f}/s)")

            # Ensure sleep time is always >= 0 to avoid negative sleep durations
            sleep_time = max(0, interval * rate - (time.monotonic() - start_time) % 1)
            await asyncio.sleep(sleep_time)

    print(f"\nDone! Sent {total_sent} events in {duration}s")


def produce_dry_run(rate: int, duration: int) -> None:
    """Print events to stdout for testing."""
    total = 0
    start = time.monotonic()

    while time.monotonic() - start < duration:
        for _ in range(rate):
            event = generate_event(total)
            print(json.dumps(event, indent=2))
            total += 1
        time.sleep(1)

    print(f"\n[DRY RUN] Generated {total} events in {duration}s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Produce sample events to Event Hub")
    parser.add_argument("--event-hub-namespace", help="Event Hub namespace name")
    parser.add_argument("--connection-string", help="Event Hub connection string (alternative to namespace)")
    parser.add_argument("--event-hub-name", default="events", help="Event Hub name (default: events)")
    parser.add_argument("--rate", type=int, default=10, help="Events per second (default: 10)")
    parser.add_argument("--duration", type=int, default=60, help="Duration in seconds (default: 60)")
    parser.add_argument("--dry-run", action="store_true", help="Print events to stdout")

    args = parser.parse_args()

    if args.dry_run:
        produce_dry_run(args.rate, args.duration)
    else:
        if not args.event_hub_namespace and not args.connection_string:
            parser.error("Either --event-hub-namespace or --connection-string is required")
        asyncio.run(
            produce_to_eventhub(
                namespace=args.event_hub_namespace,
                connection_string=args.connection_string,
                event_hub_name=args.event_hub_name,
                rate=args.rate,
                duration=args.duration,
            )
        )


if __name__ == "__main__":
    main()
