"""Azure Functions for Event Processing Service.

Processes events from Event Hub in real-time. Writes enriched events
to Cosmos DB for low-latency queries and ADLS for batch analytics.
Part of the CSA-in-a-Box shared services streaming layer.
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import List

import azure.functions as func

app = func.FunctionApp()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
COSMOS_CONNECTION = os.environ.get("COSMOS_CONNECTION", "")
COSMOS_DATABASE = os.environ.get("COSMOS_DATABASE", "events")
COSMOS_CONTAINER = os.environ.get("COSMOS_CONTAINER", "processed_events")
OUTPUT_CONTAINER = os.environ.get("OUTPUT_CONTAINER", "events-archive")


def _process_event(event_data: dict) -> dict:
    """Process a single event: validate, enrich, and transform.

    Args:
        event_data: Raw event payload from Event Hub.

    Returns:
        Enriched event with processing metadata.
    """
    processed = {
        "id": event_data.get("id", f"evt-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"),
        "source": event_data.get("source", "unknown"),
        "event_type": event_data.get("type", event_data.get("event_type", "unknown")),
        "timestamp": event_data.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "data": event_data.get("data", event_data),
        "processing": {
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "processor": "csa-event-processing",
            "version": "1.0.0",
        },
    }

    # Derive partition key for Cosmos DB
    processed["partition_key"] = f"{processed['source']}_{processed['event_type']}"

    # Basic validation
    if not processed.get("data"):
        processed["processing"]["warnings"] = ["Empty event data"]

    return processed


# ---------------------------------------------------------------------------
# Event Hub Trigger: Process streaming events
# ---------------------------------------------------------------------------
@app.event_hub_message_trigger(
    arg_name="events",
    event_hub_name="%EVENT_HUB_NAME%",
    connection="EVENT_HUB_CONNECTION",
    cardinality="many",
    consumer_group="$Default",
)
@app.cosmos_db_output(
    arg_name="cosmosOutput",
    database_name="%COSMOS_DATABASE%",
    container_name="%COSMOS_CONTAINER%",
    connection="COSMOS_CONNECTION",
    create_if_not_exists=True,
    partition_key="/partition_key",
)
def process_events(events: List[func.EventHubEvent], cosmosOutput: func.Out[str]):
    """Process batch of events from Event Hub.

    Enriches events and writes to:
    1. Cosmos DB for low-latency queries
    2. Logs for ADLS archival via diagnostic settings
    """
    batch_size = len(events)
    logging.info(f"Processing batch of {batch_size} events")

    processed_events = []
    errors = 0

    for event in events:
        try:
            # Parse event body
            body = event.get_body().decode("utf-8")
            event_data = json.loads(body)

            # Add Event Hub metadata
            event_data["_eventhub"] = {
                "enqueued_time": event.enqueued_time.isoformat() if event.enqueued_time else None,
                "sequence_number": event.sequence_number,
                "offset": event.offset,
                "partition_key": event.partition_key,
            }

            # Process the event
            processed = _process_event(event_data)
            processed_events.append(processed)

        except json.JSONDecodeError as e:
            logging.error(f"Invalid JSON in event: {e}")
            errors += 1
        except Exception as e:
            logging.exception(f"Error processing event: {e}")
            errors += 1

    # Write batch to Cosmos DB
    if processed_events:
        cosmosOutput.set(json.dumps(processed_events, default=str))

    logging.info(
        f"Batch complete: {len(processed_events)} processed, {errors} errors"
    )


# ---------------------------------------------------------------------------
# Timer Trigger: Periodic stats aggregation
# ---------------------------------------------------------------------------
@app.timer_trigger(
    schedule="0 */5 * * * *",  # Every 5 minutes
    arg_name="timer",
    run_on_startup=False,
)
def aggregate_event_stats(timer: func.TimerRequest):
    """Periodically aggregate event processing statistics.

    Runs every 5 minutes. Logs metrics for Azure Monitor / Log Analytics.
    """
    if timer.past_due:
        logging.warning("Timer trigger is past due")

    logging.info(
        json.dumps({
            "metric_type": "event_processing_heartbeat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "healthy",
        })
    )


# ---------------------------------------------------------------------------
# HTTP Trigger: Dead letter replay
# ---------------------------------------------------------------------------
@app.route(route="replay", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
@app.cosmos_db_output(
    arg_name="cosmosOutput",
    database_name="%COSMOS_DATABASE%",
    container_name="%COSMOS_CONTAINER%",
    connection="COSMOS_CONNECTION",
    partition_key="/partition_key",
)
def replay_events(req: func.HttpRequest, cosmosOutput: func.Out[str]) -> func.HttpResponse:
    """Replay dead-letter events for reprocessing.

    POST /api/replay
    Body: { "events": [ {...}, {...} ] }
    """
    logging.info("Event replay request received")

    try:
        body = req.get_json()
        events = body.get("events", [])
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON"}),
            status_code=400,
            mimetype="application/json",
        )

    if not events:
        return func.HttpResponse(
            json.dumps({"error": "No events to replay"}),
            status_code=400,
            mimetype="application/json",
        )

    processed = []
    for event_data in events:
        event_data["_replay"] = {
            "replayed_at": datetime.now(timezone.utc).isoformat(),
            "original_id": event_data.get("id"),
        }
        processed.append(_process_event(event_data))

    cosmosOutput.set(json.dumps(processed, default=str))

    return func.HttpResponse(
        json.dumps({
            "replayed": len(processed),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }),
        status_code=200,
        mimetype="application/json",
    )


# ---------------------------------------------------------------------------
# HTTP Trigger: Health check
# ---------------------------------------------------------------------------
@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Health check for event processing service."""
    return func.HttpResponse(
        json.dumps({
            "status": "healthy",
            "service": "event-processing",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }),
        status_code=200,
        mimetype="application/json",
    )
