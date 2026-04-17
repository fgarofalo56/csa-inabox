"""Azure Functions for Event Processing Service.

Processes events from Event Hub in real-time. Writes enriched events
to Cosmos DB for low-latency queries and ADLS for batch analytics.
Part of the CSA-in-a-Box shared services streaming layer.

Async / concurrency model
-------------------------
All triggers are ``async def`` so the Azure Functions host does not
block the event loop while processing a batch.  Outbound writes still
flow through the host-managed ``cosmos_db_output`` and
``event_hub_message_trigger`` bindings (which give us automatic
retries, dead-letter routing, and throughput control) rather than a
raw ``azure.cosmos.aio`` client — but the ``async def`` signatures
leave the door open for direct ``.aio`` SDK calls when a scenario
needs more control.

Logging
-------
All log lines are emitted as JSON via :mod:`governance.common.logging`
(structlog) so Log Analytics can parse them with a single KQL expression
(see ``docs/LOG_SCHEMA.md``).  Each invocation binds trace_id and
correlation_id through :func:`bind_trace_context` so cross-service
correlation works out of the box.
"""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import azure.functions as func

from domains.sharedServices.common.function_helpers import (
    build_error_response,
    build_health_response,
)
from governance.common.logging import (
    bind_trace_context,
    configure_structlog,
    extract_trace_id_from_headers,
    get_logger,
)

configure_structlog(service="csa-event-processing")
logger = get_logger(__name__)

app = func.FunctionApp()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
COSMOS_CONNECTION = os.environ.get("COSMOS_CONNECTION", "")
COSMOS_DATABASE = os.environ.get("COSMOS_DATABASE", "events")
COSMOS_CONTAINER = os.environ.get("COSMOS_CONTAINER", "processed_events")
OUTPUT_CONTAINER = os.environ.get("OUTPUT_CONTAINER", "events-archive")


def _validate_event_data(event_data: dict[str, Any]) -> tuple[bool, str]:
    """Validate incoming event data against basic schema.

    Args:
        event_data: Raw event payload to validate.

    Returns:
        Tuple of (is_valid, error_message).
    """
    if not isinstance(event_data, dict):
        return False, "Event data must be a JSON object"

    # Check for required fields
    if "data" not in event_data and "payload" not in event_data:
        return False, "Event must contain 'data' or 'payload' field"

    # Validate event type if present
    event_type = event_data.get("type") or event_data.get("event_type")
    if event_type and not isinstance(event_type, str):
        return False, "Event type must be a string"

    # Validate source if present
    source = event_data.get("source")
    if source and not isinstance(source, str):
        return False, "Event source must be a string"

    # Check for oversized payloads (1 MB limit)
    if len(json.dumps(event_data)) > 1024 * 1024:
        return False, "Event payload exceeds 1 MB size limit"

    return True, ""


def _process_event(event_data: dict[str, Any]) -> dict[str, Any]:
    """Process a single event: validate, enrich, and transform.

    Args:
        event_data: Raw event payload from Event Hub.

    Returns:
        Enriched event with processing metadata.
    """
    # Validate input data
    is_valid, error_msg = _validate_event_data(event_data)
    if not is_valid:
        raise ValueError(f"Invalid event data: {error_msg}")

    # Generate UUID instead of datetime-based ID to prevent collisions
    event_id = event_data.get("id") or str(uuid.uuid4())

    processed: dict[str, Any] = {
        "id": event_id,
        "source": event_data.get("source", "unknown"),
        "event_type": event_data.get("type", event_data.get("event_type", "unknown")),
        "timestamp": event_data.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "data": event_data.get("data", event_data.get("payload", event_data)),
        "processing": {
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "processor": "csa-event-processing",
            "version": "1.0.0",
        },
    }

    # Derive partition key for Cosmos DB
    processed["partition_key"] = f"{processed['source']}_{processed['event_type']}"

    # Additional validation warnings
    warnings = []
    if not processed.get("data"):
        warnings.append("Empty event data")
    if processed["source"] == "unknown":
        warnings.append("Missing event source")
    if processed["event_type"] == "unknown":
        warnings.append("Missing event type")

    if warnings:
        processed["processing"]["warnings"] = warnings

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
async def process_events(
    events: list[func.EventHubEvent],
    cosmosOutput: func.Out[str],
) -> None:
    """Process batch of events from Event Hub.

    Enriches events and writes to:
    1. Cosmos DB for low-latency queries
    2. Logs for ADLS archival via diagnostic settings
    """
    if not events:
        return

    batch_size = len(events)
    # Use the first event's sequence number as the trace anchor — it gives
    # us a deterministic ID per batch that maps back to Event Hub partitions.
    first_seq = events[0].sequence_number
    with bind_trace_context(
        trigger="eventhub",
        batch_size=batch_size,
        first_sequence_number=first_seq,
    ):
        logger.info("batch.received")

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
                logger.error("event.invalid_json", error=str(e), sequence_number=event.sequence_number)
                errors += 1
            except ValueError as e:
                logger.error("event.validation_failed", error=str(e), sequence_number=event.sequence_number)
                errors += 1
            except UnicodeDecodeError as e:
                logger.error("event.encoding_failed", error=str(e), sequence_number=event.sequence_number)
                errors += 1
            except Exception as e:
                logger.exception(
                    "event.processing_failed", sequence_number=event.sequence_number, error_type=type(e).__name__
                )
                errors += 1

        # Write batch to Cosmos DB
        if processed_events:
            cosmosOutput.set(json.dumps(processed_events, default=str))

        logger.info(
            "batch.completed",
            processed=len(processed_events),
            errors=errors,
        )


# ---------------------------------------------------------------------------
# Timer Trigger: Periodic stats aggregation
# ---------------------------------------------------------------------------
@app.timer_trigger(
    schedule="0 */5 * * * *",  # Every 5 minutes
    arg_name="timer",
    run_on_startup=False,
)
async def aggregate_event_stats(timer: func.TimerRequest) -> None:
    """Periodically aggregate event processing statistics.

    Runs every 5 minutes. Logs metrics for Azure Monitor / Log Analytics.
    """
    with bind_trace_context(trigger="timer", schedule="0 */5 * * * *"):
        if timer.past_due:
            logger.warning("timer.past_due")

        logger.info(
            "heartbeat",
            metric_type="event_processing_heartbeat",
            status="healthy",
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
async def replay_events(
    req: func.HttpRequest,
    cosmosOutput: func.Out[str],
) -> func.HttpResponse:
    """Replay dead-letter events for reprocessing.

    POST /api/replay
    Body: { "events": [ {...}, {...} ] }
    """
    trace_id = extract_trace_id_from_headers(dict(req.headers))
    with bind_trace_context(
        trace_id=trace_id,
        request_method="POST",
        request_route="/api/replay",
    ):
        logger.info("replay.request_received")

        try:
            body = req.get_json()
            events = body.get("events", [])
        except ValueError:
            logger.warning("replay.invalid_json")
            return build_error_response(400, "Invalid JSON")

        if not events:
            logger.warning("replay.empty_payload")
            return build_error_response(400, "No events to replay")

        processed = []
        validation_errors = 0

        for event_data in events:
            try:
                event_data["_replay"] = {
                    "replayed_at": datetime.now(timezone.utc).isoformat(),
                    "original_id": event_data.get("id"),
                }
                processed.append(_process_event(event_data))
            except ValueError as e:
                logger.error("replay.validation_failed", error=str(e), event_id=event_data.get("id"))
                validation_errors += 1
            except Exception as e:
                logger.exception("replay.processing_failed", error_type=type(e).__name__, event_id=event_data.get("id"))
                validation_errors += 1

        if processed:
            cosmosOutput.set(json.dumps(processed, default=str))

        logger.info("replay.completed", replayed=len(processed), errors=validation_errors)
        return func.HttpResponse(
            json.dumps(
                {
                    "replayed": len(processed),
                    "errors": validation_errors,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            ),
            status_code=200,
            mimetype="application/json",
        )


# ---------------------------------------------------------------------------
# HTTP Trigger: Health check
# ---------------------------------------------------------------------------
@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
async def health(req: func.HttpRequest) -> func.HttpResponse:
    """Health check for event processing service."""
    return func.HttpResponse(
        json.dumps(build_health_response("event-processing")),
        status_code=200,
        mimetype="application/json",
    )
