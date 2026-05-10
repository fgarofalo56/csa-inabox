# Event Grid Reliability

> **[Home](../../../README.md)** | **[Best Practices](../README.md)** | **[Operational Excellence](README.md)** | **Event Grid Reliability**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Operations-orange?style=flat-square)

Best practices for ensuring reliable event delivery with Azure Event Grid.

---

## Overview

Azure Event Grid provides at-least-once delivery guarantees. This guide covers patterns for maximizing reliability and handling failures.

---

## Delivery Guarantees

### Event Grid SLAs

| Aspect | Guarantee | Notes |
|--------|-----------|-------|
| Delivery | At-least-once | Events may be delivered multiple times |
| Ordering | No guarantee | Within partition only (Event Hubs) |
| Latency | Sub-second | 99th percentile < 1 second |
| Durability | 24 hours | Default retry period |

### Retry Configuration

```json
{
    "properties": {
        "retryPolicy": {
            "maxDeliveryAttempts": 30,
            "eventTimeToLiveInMinutes": 1440
        },
        "deadLetterDestination": {
            "endpointType": "StorageBlob",
            "properties": {
                "resourceId": "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}",
                "blobContainerName": "deadletter"
            }
        }
    }
}
```

---

## Idempotent Event Handling

### Handler Pattern

```python
from functools import wraps
import hashlib
import redis

class EventGridHandler:
    """Idempotent Event Grid event handler."""

    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client
        self.processed_ttl = 86400  # 24 hours

    def idempotent(self, func):
        """Decorator for idempotent event processing."""
        @wraps(func)
        def wrapper(event: dict):
            event_id = event.get("id")

            # Check if already processed
            if self.redis.get(f"eventgrid:processed:{event_id}"):
                print(f"Event {event_id} already processed, skipping")
                return {"status": "duplicate"}

            # Process event
            result = func(event)

            # Mark as processed
            self.redis.setex(
                f"eventgrid:processed:{event_id}",
                self.processed_ttl,
                "1"
            )

            return result

        return wrapper

handler = EventGridHandler(redis.Redis())

@handler.idempotent
def process_blob_created(event: dict):
    """Process blob created event."""
    data = event.get("data", {})
    blob_url = data.get("url")

    # Process the blob
    process_data_file(blob_url)

    return {"status": "processed", "url": blob_url}
```

### Database-Based Deduplication

```sql
-- Processed events table
CREATE TABLE processed_events (
    event_id NVARCHAR(100) PRIMARY KEY,
    event_type NVARCHAR(100),
    processed_at DATETIME2 DEFAULT GETUTCDATE(),
    result NVARCHAR(MAX)
);

-- Idempotent upsert pattern
MERGE processed_events AS target
USING (SELECT @event_id AS event_id) AS source
ON target.event_id = source.event_id
WHEN NOT MATCHED THEN
    INSERT (event_id, event_type, result)
    VALUES (@event_id, @event_type, @result);

-- Cleanup old records
DELETE FROM processed_events
WHERE processed_at < DATEADD(day, -7, GETUTCDATE());
```

---

## Dead Letter Handling

### Dead Letter Queue Processing

```python
from azure.storage.blob import BlobServiceClient
import json

class DeadLetterProcessor:
    """Process dead-lettered Event Grid events."""

    def __init__(self, storage_connection: str, container: str = "deadletter"):
        self.blob_service = BlobServiceClient.from_connection_string(storage_connection)
        self.container = self.blob_service.get_container_client(container)

    def process_dead_letters(self, max_events: int = 100):
        """Process dead letter events."""
        processed = 0
        blobs = self.container.list_blobs()

        for blob in blobs:
            if processed >= max_events:
                break

            blob_client = self.container.get_blob_client(blob.name)
            content = blob_client.download_blob().readall()
            event = json.loads(content)

            try:
                # Analyze failure reason
                failure_info = self._analyze_failure(event)

                # Attempt reprocessing based on failure type
                if failure_info["retryable"]:
                    self._retry_event(event)
                else:
                    self._escalate_event(event, failure_info)

                # Archive processed dead letter
                self._archive_dead_letter(blob.name, event, failure_info)

            except Exception as e:
                print(f"Failed to process dead letter {blob.name}: {e}")

            processed += 1

    def _analyze_failure(self, event: dict) -> dict:
        """Analyze why event failed."""
        dead_letter_reason = event.get("deadLetterReason", "Unknown")
        delivery_attempts = event.get("deliveryAttempts", 0)

        retryable_reasons = [
            "MaxDeliveryAttemptsExceeded",
            "EndpointUnavailable"
        ]

        return {
            "reason": dead_letter_reason,
            "attempts": delivery_attempts,
            "retryable": dead_letter_reason in retryable_reasons
        }
```

### Monitoring Dead Letters

```kql
// Monitor dead letter events
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.EVENTGRID"
| where OperationName == "Microsoft.EventGrid/eventSubscriptions/deadLetter"
| summarize
    DeadLetterCount = count(),
    UniqueSubscriptions = dcount(SubscriptionId)
    by bin(TimeGenerated, 1h), Topic = Resource, DeadLetterReason = resultDescription
| order by DeadLetterCount desc
```

---

## High Availability Patterns

### Multi-Region Subscription

```bicep
// Primary region topic
resource primaryTopic 'Microsoft.EventGrid/topics@2022-06-15' = {
  name: 'eg-events-eastus'
  location: 'eastus'
  properties: {
    inputSchema: 'CloudEventSchemaV1_0'
  }
}

// Secondary region topic
resource secondaryTopic 'Microsoft.EventGrid/topics@2022-06-15' = {
  name: 'eg-events-westus'
  location: 'westus'
  properties: {
    inputSchema: 'CloudEventSchemaV1_0'
  }
}

// Publisher sends to both regions
```

### Publisher Failover

```python
class ResilientEventPublisher:
    """Publish events with automatic failover."""

    def __init__(self, primary_endpoint: str, secondary_endpoint: str, credential):
        self.clients = [
            EventGridPublisherClient(primary_endpoint, credential),
            EventGridPublisherClient(secondary_endpoint, credential)
        ]
        self.primary_healthy = True

    async def publish(self, events: list):
        """Publish events with failover."""
        client_index = 0 if self.primary_healthy else 1

        try:
            await self.clients[client_index].send(events)
            self.primary_healthy = True  # Reset on success
        except Exception as e:
            print(f"Primary failed: {e}, trying secondary")
            self.primary_healthy = False
            try:
                await self.clients[1 - client_index].send(events)
            except Exception as e2:
                # Both failed - store locally
                await self._store_locally(events)
                raise Exception(f"Both endpoints failed: {e}, {e2}")
```

---

## Performance Optimization

### Batch Publishing

```python
from azure.eventgrid import EventGridEvent
import asyncio

class BatchEventPublisher:
    """Batch events for efficient publishing."""

    def __init__(self, client, batch_size: int = 100, flush_interval: float = 1.0):
        self.client = client
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self.buffer = []
        self._start_flush_timer()

    def add_event(self, event: EventGridEvent):
        """Add event to batch."""
        self.buffer.append(event)
        if len(self.buffer) >= self.batch_size:
            asyncio.create_task(self._flush())

    async def _flush(self):
        """Flush buffered events."""
        if not self.buffer:
            return

        events = self.buffer[:self.batch_size]
        self.buffer = self.buffer[self.batch_size:]

        try:
            await self.client.send(events)
        except Exception as e:
            # Re-add failed events to buffer
            self.buffer = events + self.buffer
            raise
```

---

## Monitoring & Alerting

### Key Metrics

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Dead letter count | > 0 | Investigate failures |
| Delivery latency | > 5 seconds | Check endpoint health |
| Failed deliveries | > 5% | Review error logs |
| Publish failures | > 0 | Check topic health |

### Alert Configuration

```json
{
    "type": "Microsoft.Insights/metricAlerts",
    "properties": {
        "severity": 2,
        "criteria": {
            "allOf": [
                {
                    "name": "DeadLetterAlert",
                    "metricName": "DeadLetteredCount",
                    "operator": "GreaterThan",
                    "threshold": 0,
                    "timeAggregation": "Total"
                }
            ]
        },
        "actions": [{"actionGroupId": "/subscriptions/{sub}/resourceGroups/{rg}/providers/microsoft.insights/actionGroups/ops"}]
    }
}
```

---

## Related Documentation

- [Event Grid Patterns](../cross-cutting-concerns/event-handling/event-grid-patterns.md)
- [Event Hubs DR](eventhub-dr.md)
- [Reliability Patterns](reliability.md)

---

*Last Updated: January 2025*
