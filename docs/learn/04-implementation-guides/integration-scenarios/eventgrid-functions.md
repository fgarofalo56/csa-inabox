# Event Grid Integration with Azure Functions

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __EventGrid + Functions__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Beginner-green?style=flat-square)

Serverless reactive processing of Azure events using Event Grid triggers.

---

## Overview

Event Grid + Functions provides:

- Push-based event delivery with millisecond latency
- Automatic retry and dead-lettering
- Built-in integration with Azure services
- Pay-per-execution pricing

---

## Implementation

### Step 1: Event Grid Trigger Function

```python
# function_app.py
import azure.functions as func
import json
import logging
from datetime import datetime

app = func.FunctionApp()

@app.event_grid_trigger(arg_name="event")
@app.cosmos_db_output(
    arg_name="document",
    database_name="events",
    container_name="processed",
    connection="CosmosDBConnection"
)
async def process_blob_event(event: func.EventGridEvent, document: func.Out[str]):
    """Process blob storage events."""

    logging.info(f"Event type: {event.event_type}")
    logging.info(f"Subject: {event.subject}")

    data = event.get_json()

    processed = {
        "id": event.id,
        "event_type": event.event_type,
        "subject": event.subject,
        "event_time": event.event_time.isoformat(),
        "blob_url": data.get("url"),
        "content_type": data.get("contentType"),
        "content_length": data.get("contentLength"),
        "processed_at": datetime.utcnow().isoformat()
    }

    document.set(json.dumps(processed))
```

### Step 2: Handle Multiple Event Types

```python
@app.event_grid_trigger(arg_name="event")
async def handle_storage_events(event: func.EventGridEvent):
    """Route storage events by type."""

    handlers = {
        "Microsoft.Storage.BlobCreated": handle_blob_created,
        "Microsoft.Storage.BlobDeleted": handle_blob_deleted,
        "Microsoft.Storage.DirectoryCreated": handle_directory_created
    }

    handler = handlers.get(event.event_type)
    if handler:
        await handler(event)
    else:
        logging.warning(f"Unhandled event type: {event.event_type}")

async def handle_blob_created(event: func.EventGridEvent):
    """Process new blob creation."""
    data = event.get_json()

    # Trigger data pipeline for new files
    if data.get("url", "").endswith(".parquet"):
        await trigger_data_pipeline(data["url"])

    # Index file for search
    await index_blob_metadata(event.subject, data)

async def handle_blob_deleted(event: func.EventGridEvent):
    """Handle blob deletion."""
    # Remove from search index
    await remove_from_index(event.subject)
```

### Step 3: CloudEvents Schema

```python
@app.event_grid_trigger(arg_name="event")
async def process_cloud_event(event: func.EventGridEvent):
    """Process CloudEvents format."""

    # CloudEvents properties
    ce_type = event.event_type
    ce_source = event.topic
    ce_id = event.id
    ce_time = event.event_time

    data = event.get_json()

    logging.info(f"""
        CloudEvent received:
        - Type: {ce_type}
        - Source: {ce_source}
        - ID: {ce_id}
        - Time: {ce_time}
        - Data: {json.dumps(data)[:200]}...
    """)
```

### Step 4: Custom Topic Publisher

```python
from azure.eventgrid import EventGridPublisherClient
from azure.core.credentials import AzureKeyCredential
from azure.eventgrid import EventGridEvent
import os

async def publish_custom_event(event_type: str, subject: str, data: dict):
    """Publish event to custom Event Grid topic."""

    endpoint = os.environ["EVENTGRID_TOPIC_ENDPOINT"]
    key = os.environ["EVENTGRID_TOPIC_KEY"]

    client = EventGridPublisherClient(endpoint, AzureKeyCredential(key))

    event = EventGridEvent(
        event_type=event_type,
        subject=subject,
        data=data,
        data_version="1.0"
    )

    await client.send([event])

# Usage in function
@app.event_grid_trigger(arg_name="event")
@app.event_grid_output(
    arg_name="output_event",
    topic_endpoint_uri="EVENTGRID_CUSTOM_TOPIC_ENDPOINT",
    topic_key_setting="EVENTGRID_CUSTOM_TOPIC_KEY"
)
async def transform_and_publish(event: func.EventGridEvent, output_event: func.Out[func.EventGridOutputEvent]):
    """Transform event and publish to custom topic."""

    data = event.get_json()

    # Transform
    transformed = {
        "original_id": event.id,
        "transformed_at": datetime.utcnow().isoformat(),
        "enriched_data": await enrich_data(data)
    }

    output_event.set(
        func.EventGridOutputEvent(
            id=str(uuid.uuid4()),
            data=transformed,
            subject=f"transformed/{event.subject}",
            event_type="Custom.Data.Transformed",
            event_time=datetime.utcnow(),
            data_version="1.0"
        )
    )
```

### Step 5: Dead Letter Handling

```python
@app.blob_trigger(
    arg_name="deadletter",
    path="eventgrid-deadletter/{name}",
    connection="StorageConnection"
)
async def process_dead_letters(deadletter: func.InputStream):
    """Process dead-lettered events."""

    content = json.loads(deadletter.read().decode('utf-8'))

    logging.error(f"""
        Dead letter received:
        - Event ID: {content.get('id')}
        - Error: {content.get('deadLetterReason')}
        - Delivery attempts: {content.get('deliveryAttempts')}
    """)

    # Alert on repeated failures
    if content.get('deliveryAttempts', 0) >= 3:
        await send_alert("Event Grid delivery failure", content)

    # Store for manual investigation
    await store_for_investigation(content)
```

---

## Subscription Configuration

```json
{
    "properties": {
        "destination": {
            "endpointType": "AzureFunction",
            "properties": {
                "resourceId": "/subscriptions/.../functions/process_blob_event"
            }
        },
        "filter": {
            "includedEventTypes": ["Microsoft.Storage.BlobCreated"],
            "subjectBeginsWith": "/blobServices/default/containers/data/"
        },
        "retryPolicy": {
            "maxDeliveryAttempts": 30,
            "eventTimeToLiveInMinutes": 1440
        },
        "deadLetterDestination": {
            "endpointType": "StorageBlob",
            "properties": {
                "resourceId": "/subscriptions/.../storageAccounts/dlqstorage",
                "blobContainerName": "eventgrid-deadletter"
            }
        }
    }
}
```

---

## Related Documentation

- [EventGrid + EventHubs](eventgrid-eventhubs.md)
- [EventGrid + Logic Apps](eventgrid-logicapps.md)
- [EventHub + Functions](eventhub-functions.md)

---

*Last Updated: January 2025*
