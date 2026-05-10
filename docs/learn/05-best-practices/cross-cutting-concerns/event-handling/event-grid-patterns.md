# Event Grid Patterns

> **[Home](../../../../README.md)** | **[Best Practices](../../README.md)** | **[Cross-Cutting](../README.md)** | **Event Grid Patterns**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Event%20Handling-orange?style=flat-square)

Event-driven architecture patterns with Azure Event Grid.

---

## Overview

Azure Event Grid enables reactive, event-driven architectures with reliable event delivery and filtering.

---

## Core Patterns

### Fan-Out Pattern

```python
# Multiple subscribers receive the same event
# Event Grid handles delivery to all subscribers

# Publisher
from azure.eventgrid import EventGridPublisherClient
from azure.core.credentials import AzureKeyCredential

client = EventGridPublisherClient(
    endpoint="https://<topic>.eastus-1.eventgrid.azure.net/api/events",
    credential=AzureKeyCredential("<key>")
)

# Single event, multiple subscribers
event = {
    "id": str(uuid.uuid4()),
    "eventType": "Data.FileUploaded",
    "subject": "/bronze/sales/2024/01/15/data.parquet",
    "data": {
        "container": "datalake",
        "path": "/bronze/sales/2024/01/15/data.parquet",
        "size": 1048576
    },
    "dataVersion": "1.0"
}

client.send([event])
```

### Event Filtering

```json
{
    "filter": {
        "subjectBeginsWith": "/bronze/sales",
        "subjectEndsWith": ".parquet",
        "includedEventTypes": ["Data.FileUploaded"],
        "advancedFilters": [
            {
                "operatorType": "NumberGreaterThan",
                "key": "data.size",
                "value": 1000000
            }
        ]
    }
}
```

---

## Data Pipeline Triggers

### Storage Event Trigger

```python
# Azure Function triggered by blob events
import azure.functions as func
from azure.storage.blob import BlobServiceClient

def main(event: func.EventGridEvent):
    """Process new data files."""
    data = event.get_json()

    # Extract file info
    blob_url = data['url']
    container = data['container']
    blob_name = data['blobName']

    # Trigger processing pipeline
    if blob_name.startswith('bronze/') and blob_name.endswith('.parquet'):
        trigger_databricks_job(
            job_id="bronze-to-silver",
            parameters={"input_path": blob_url}
        )
```

### Synapse Pipeline Trigger

```json
{
    "name": "EventGridTrigger",
    "type": "BlobEventsTrigger",
    "typeProperties": {
        "blobPathBeginsWith": "/bronze/",
        "blobPathEndsWith": ".parquet",
        "ignoreEmptyBlobs": true,
        "scope": "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}",
        "events": ["Microsoft.Storage.BlobCreated"]
    }
}
```

---

## Error Handling

### Dead Letter Configuration

```json
{
    "deadLetterDestination": {
        "endpointType": "StorageBlob",
        "properties": {
            "resourceId": "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}",
            "blobContainerName": "deadletter"
        }
    },
    "retryPolicy": {
        "maxDeliveryAttempts": 30,
        "eventTimeToLiveInMinutes": 1440
    }
}
```

### Retry Strategy

```python
class EventGridRetryHandler:
    """Handle Event Grid delivery failures."""

    MAX_RETRIES = 3
    BACKOFF_MULTIPLIER = 2

    async def process_with_retry(self, event: dict):
        """Process event with exponential backoff."""
        for attempt in range(self.MAX_RETRIES):
            try:
                await self.process_event(event)
                return
            except TransientError as e:
                wait_time = (self.BACKOFF_MULTIPLIER ** attempt)
                logger.warning(f"Retry {attempt + 1}, waiting {wait_time}s")
                await asyncio.sleep(wait_time)
            except PermanentError as e:
                await self.send_to_dead_letter(event, str(e))
                raise

        # Max retries exceeded
        await self.send_to_dead_letter(event, "Max retries exceeded")
```

---

## Monitoring

### Event Metrics

```kql
// Monitor Event Grid delivery metrics
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.EVENTGRID"
| where OperationName == "Microsoft.EventGrid/events/delivery"
| summarize
    TotalEvents = count(),
    SuccessCount = countif(ResultType == "Success"),
    FailureCount = countif(ResultType == "Failure")
    by bin(TimeGenerated, 5m), Topic = Resource
| extend SuccessRate = round(100.0 * SuccessCount / TotalEvents, 2)
| order by TimeGenerated desc
```

### Alerting

```json
{
    "type": "Microsoft.Insights/metricAlerts",
    "properties": {
        "severity": 2,
        "criteria": {
            "odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
            "allOf": [
                {
                    "name": "DeadLetterEvents",
                    "metricName": "DeadLetteredCount",
                    "operator": "GreaterThan",
                    "threshold": 0,
                    "timeAggregation": "Total"
                }
            ]
        },
        "actions": [{"actionGroupId": "/subscriptions/{sub}/resourceGroups/{rg}/providers/microsoft.insights/actionGroups/ops-team"}]
    }
}
```

---

## Security

### Webhook Validation

```python
from azure.functions import HttpRequest, HttpResponse

def validate_subscription(req: HttpRequest) -> HttpResponse:
    """Handle Event Grid subscription validation."""
    body = req.get_json()

    # Validation request
    if body[0].get('eventType') == 'Microsoft.EventGrid.SubscriptionValidationEvent':
        validation_code = body[0]['data']['validationCode']
        return HttpResponse(
            json.dumps({"validationResponse": validation_code}),
            mimetype="application/json"
        )

    # Process actual events
    for event in body:
        process_event(event)

    return HttpResponse(status_code=200)
```

### Access Control

```bicep
resource eventGridTopic 'Microsoft.EventGrid/topics@2022-06-15' = {
  name: 'eg-data-events'
  location: location
  properties: {
    publicNetworkAccess: 'Disabled'
    inboundIpRules: []
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2022-01-01' = {
  name: 'pe-eventgrid'
  location: location
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'eventgrid-connection'
        properties: {
          privateLinkServiceId: eventGridTopic.id
          groupIds: ['topic']
        }
      }
    ]
  }
}
```

---

## Related Documentation

- [Event Grid Overview](../../../../02-services/streaming-services/azure-event-grid/README.md)
- [Event Grid Reliability](../../operational-excellence/eventgrid-reliability.md)
- [Streaming Architectures](../../../../03-architecture-patterns/streaming-architectures/README.md)

---

*Last Updated: January 2025*
