# Event Hubs Integration with Azure Functions

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __EventHub + Functions__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Beginner-green?style=flat-square)

Serverless event processing from Azure Event Hubs using Azure Functions.

---

## Overview

Azure Functions provides a serverless approach to processing Event Hub messages with automatic scaling and pay-per-execution pricing.

---

## Implementation

### Step 1: Function App Setup

```python
# requirements.txt
azure-functions
azure-eventhub
azure-storage-blob
azure-cosmos
```

### Step 2: Event Hub Trigger Function

```python
# function_app.py
import azure.functions as func
import json
import logging
from datetime import datetime

app = func.FunctionApp()

@app.event_hub_message_trigger(
    arg_name="events",
    event_hub_name="iot-events",
    connection="EventHubConnection",
    cardinality=func.Cardinality.MANY,
    consumer_group="functions-consumer"
)
@app.cosmos_db_output(
    arg_name="documents",
    database_name="analytics",
    container_name="processed_events",
    connection="CosmosDBConnection"
)
async def process_events(events: list[func.EventHubEvent], documents: func.Out[list[str]]):
    """Process batch of Event Hub messages."""

    processed = []

    for event in events:
        try:
            body = json.loads(event.get_body().decode('utf-8'))

            processed_event = {
                "id": f"{body['device_id']}_{event.sequence_number}",
                "device_id": body['device_id'],
                "temperature": body['temperature'],
                "humidity": body['humidity'],
                "processed_at": datetime.utcnow().isoformat(),
                "partition_key": body['device_id'],
                "enqueued_time": event.enqueued_time.isoformat(),
                "offset": event.offset,
                "sequence_number": event.sequence_number
            }

            # Add anomaly flag
            if body['temperature'] > 100 or body['temperature'] < -40:
                processed_event['is_anomaly'] = True
                processed_event['anomaly_type'] = 'temperature_out_of_range'

            processed.append(json.dumps(processed_event))

        except Exception as e:
            logging.error(f"Error processing event: {e}")

    documents.set(processed)
    logging.info(f"Processed {len(processed)} events")
```

### Step 3: Event Hub Output Binding

```python
@app.event_hub_message_trigger(
    arg_name="event",
    event_hub_name="raw-events",
    connection="SourceEventHubConnection"
)
@app.event_hub_output(
    arg_name="output",
    event_hub_name="enriched-events",
    connection="TargetEventHubConnection"
)
async def enrich_and_forward(event: func.EventHubEvent, output: func.Out[str]):
    """Enrich events and forward to another Event Hub."""

    body = json.loads(event.get_body().decode('utf-8'))

    # Enrich with metadata
    enriched = {
        **body,
        "enriched_at": datetime.utcnow().isoformat(),
        "source_partition": event.partition_key,
        "processing_function": "enrich_and_forward"
    }

    # Add geolocation if IP present
    if 'ip_address' in body:
        enriched['geo_location'] = await lookup_geo(body['ip_address'])

    output.set(json.dumps(enriched))
```

### Step 4: Batch Processing with Checkpointing

```python
@app.event_hub_message_trigger(
    arg_name="events",
    event_hub_name="large-events",
    connection="EventHubConnection",
    cardinality=func.Cardinality.MANY
)
@app.blob_output(
    arg_name="outputblob",
    path="processed/{datetime:yyyy}/{datetime:MM}/{datetime:dd}/{datetime:HH}/{rand-guid}.json",
    connection="StorageConnection"
)
async def batch_to_storage(events: list[func.EventHubEvent], outputblob: func.Out[str]):
    """Batch process events and write to blob storage."""

    batch = []

    for event in events:
        batch.append({
            "data": json.loads(event.get_body().decode('utf-8')),
            "metadata": {
                "enqueued_time": event.enqueued_time.isoformat(),
                "sequence_number": event.sequence_number,
                "partition_key": event.partition_key
            }
        })

    outputblob.set(json.dumps({"events": batch, "count": len(batch)}))
```

### Step 5: Dead Letter Queue Handling

```python
@app.event_hub_message_trigger(
    arg_name="event",
    event_hub_name="main-events",
    connection="EventHubConnection"
)
@app.queue_output(
    arg_name="dlq",
    queue_name="dead-letter-queue",
    connection="StorageConnection"
)
async def process_with_dlq(event: func.EventHubEvent, dlq: func.Out[str]):
    """Process events with dead letter queue for failures."""

    try:
        body = json.loads(event.get_body().decode('utf-8'))

        # Validate required fields
        required = ['device_id', 'timestamp', 'value']
        missing = [f for f in required if f not in body]
        if missing:
            raise ValueError(f"Missing required fields: {missing}")

        # Process event
        await process_event(body)

    except Exception as e:
        # Send to dead letter queue
        dlq_message = {
            "original_event": event.get_body().decode('utf-8'),
            "error": str(e),
            "error_time": datetime.utcnow().isoformat(),
            "event_metadata": {
                "enqueued_time": event.enqueued_time.isoformat(),
                "offset": event.offset,
                "sequence_number": event.sequence_number
            }
        }
        dlq.set(json.dumps(dlq_message))
        logging.error(f"Event sent to DLQ: {e}")
```

---

## Configuration

### host.json

```json
{
    "version": "2.0",
    "extensions": {
        "eventHubs": {
            "batchCheckpointFrequency": 5,
            "eventProcessorOptions": {
                "maxBatchSize": 256,
                "prefetchCount": 512
            },
            "initialOffsetOptions": {
                "type": "fromEnqueuedTime",
                "enqueuedTimeUtc": "2024-01-01T00:00:00Z"
            }
        }
    }
}
```

### local.settings.json

```json
{
    "IsEncrypted": false,
    "Values": {
        "AzureWebJobsStorage": "UseDevelopmentStorage=true",
        "FUNCTIONS_WORKER_RUNTIME": "python",
        "EventHubConnection": "Endpoint=sb://...",
        "CosmosDBConnection": "AccountEndpoint=..."
    }
}
```

---

## Scaling Considerations

| Metric | Recommendation |
|--------|----------------|
| Partitions | 1 function instance per partition max |
| Batch Size | 100-500 for low latency, 1000+ for throughput |
| Checkpoint Frequency | Every 5-10 batches for reliability |
| Premium Plan | Required for >10 partitions or VNet |

---

## Related Documentation

- [EventHub + Databricks](eventhub-databricks.md)
- [EventHub + Stream Analytics](eventhub-stream-analytics.md)
- [EventGrid + Functions](eventgrid-functions.md)

---

*Last Updated: January 2025*
