---
title: "System Topics"
description: "React to Azure service events using Event Grid system topics for seamless cloud automation."
tags:
  - services
  - azure-event-grid
---
# 🌐 System Topics

![Feature](https://img.shields.io/badge/Feature-System%20Events-brightgreen?style=flat-square)
![Integration](https://img.shields.io/badge/Integration-100%2B%20Services-blue?style=flat-square)

React to Azure service events using Event Grid system topics for seamless cloud automation.

---

## 🎯 Overview

System topics are built-in Event Grid topics that publish events from Azure services without requiring custom code. They enable automation and integration across your Azure environment by subscribing to native Azure service events.

### Key Benefits

- **No Configuration Required**: Azure services automatically publish to system topics
- **100+ Azure Services**: Broad coverage across the Azure ecosystem
- **Consistent Schema**: Standardized event formats across services
- **Automatic Updates**: New event types added as services evolve
- **Zero Maintenance**: No infrastructure to manage

---

## 📋 Supported Services

### Storage Services

- **Azure Storage**: Blob created, deleted, renamed
- **Azure Data Lake Storage Gen2**: File operations
- **Azure File Sync**: Sync events

### Messaging & Integration

- **Azure Service Bus**: Message processing events
- **Azure Event Hubs**: Capture file created
- **Azure Relay**: Hybrid connection events

### Container Services

- **Azure Container Registry**: Image push, delete, quarantine
- **Azure Kubernetes Service**: Cluster events
- **Azure Container Instances**: Container group events

### Security & Identity

- **Azure Key Vault**: Secret expiration, certificate renewal
- **Azure Active Directory**: User provisioning events
- **Azure Policy**: Compliance state changes

### IoT Services

- **Azure IoT Hub**: Device lifecycle events
- **Azure Digital Twins**: Twin updates
- **Azure Maps**: Geofence events

### Media & Communication

- **Azure Media Services**: Job state changes
- **Azure Communication Services**: Call events
- **Azure SignalR**: Connection events

---

## 🔧 Common Use Cases

### Use Case 1: Blob Storage Event Processing

Automatically process files when uploaded to Azure Storage.

```bash
# Create Event Grid subscription for blob events
az eventgrid event-subscription create \
  --name blob-processor \
  --source-resource-id /subscriptions/{sub-id}/resourceGroups/rg-storage/providers/Microsoft.Storage/storageAccounts/mystorageaccount \
  --endpoint https://myfunction.azurewebsites.net/api/processor \
  --endpoint-type webhook \
  --included-event-types Microsoft.Storage.BlobCreated \
  --subject-begins-with /blobServices/default/containers/uploads/ \
  --subject-ends-with .csv
```

```python
# Python Azure Function to process blob events
import logging
import json
import azure.functions as func
from azure.storage.blob import BlobServiceClient

def main(event: func.EventGridEvent):
    """Process blob creation events."""
    result = json.dumps({
        'id': event.id,
        'data': event.get_json(),
        'topic': event.topic,
        'subject': event.subject,
        'event_type': event.event_type,
    })

    logging.info(f'Python EventGrid trigger processed an event: {result}')

    # Extract blob details
    data = event.get_json()
    blob_url = data['url']
    blob_size = data['contentLength']

    logging.info(f'New blob created: {blob_url} ({blob_size} bytes)')

    # Process the blob
    if blob_url.endswith('.csv'):
        process_csv_file(blob_url)
    elif blob_url.endswith('.json'):
        process_json_file(blob_url)

def process_csv_file(blob_url):
    """Process CSV file from blob storage."""
    blob_service = BlobServiceClient.from_connection_string(
        os.environ["STORAGE_CONNECTION_STRING"]
    )

    # Download and process blob
    blob_client = blob_service.get_blob_client_from_url(blob_url)
    blob_data = blob_client.download_blob()
    content = blob_data.readall()

    # Process CSV content
    logging.info(f"Processing CSV: {len(content)} bytes")
```

```csharp
// C# Azure Function for blob events
using System;
using System.IO;
using Microsoft.Azure.WebJobs;
using Microsoft.Azure.EventGrid.Models;
using Microsoft.Azure.WebJobs.Extensions.EventGrid;
using Microsoft.Extensions.Logging;
using Azure.Storage.Blobs;

public static class BlobEventProcessor
{
    [FunctionName("ProcessBlobEvent")]
    public static void Run(
        [EventGridTrigger] EventGridEvent eventGridEvent,
        ILogger log)
    {
        log.LogInformation($"Event type: {eventGridEvent.EventType}");
        log.LogInformation($"Event subject: {eventGridEvent.Subject}");

        // Parse blob URL from event data
        dynamic data = eventGridEvent.Data;
        string blobUrl = data.url;

        log.LogInformation($"Blob URL: {blobUrl}");

        // Process based on event type
        switch (eventGridEvent.EventType)
        {
            case "Microsoft.Storage.BlobCreated":
                ProcessNewBlob(blobUrl, log);
                break;

            case "Microsoft.Storage.BlobDeleted":
                HandleBlobDeletion(blobUrl, log);
                break;

            default:
                log.LogInformation($"Unhandled event type: {eventGridEvent.EventType}");
                break;
        }
    }

    private static void ProcessNewBlob(string blobUrl, ILogger log)
    {
        log.LogInformation($"Processing new blob: {blobUrl}");

        var blobClient = new BlobClient(new Uri(blobUrl));

        // Download and process blob
        using (var stream = new MemoryStream())
        {
            blobClient.DownloadTo(stream);
            stream.Position = 0;

            // Process the stream
            log.LogInformation($"Downloaded {stream.Length} bytes");
        }
    }
}
```

### Use Case 2: IoT Device Lifecycle Management

Respond to IoT device connection and disconnection events.

```python
# Azure Function to handle IoT device events
import azure.functions as func
import logging
from azure.cosmos import CosmosClient

def main(event: func.EventGridEvent):
    """Handle IoT Hub device events."""
    event_type = event.event_type
    device_data = event.get_json()

    device_id = device_data.get('deviceId')
    logging.info(f"Device event: {event_type} for device {device_id}")

    if event_type == 'Microsoft.Devices.DeviceConnected':
        handle_device_connected(device_id, device_data)

    elif event_type == 'Microsoft.Devices.DeviceDisconnected':
        handle_device_disconnected(device_id, device_data)

    elif event_type == 'Microsoft.Devices.DeviceCreated':
        handle_device_created(device_id, device_data)

    elif event_type == 'Microsoft.Devices.DeviceDeleted':
        handle_device_deleted(device_id, device_data)

def handle_device_connected(device_id, data):
    """Update device status when connected."""
    logging.info(f"Device {device_id} connected")

    # Update device registry in Cosmos DB
    cosmos_client = CosmosClient.from_connection_string(
        os.environ["COSMOS_CONNECTION_STRING"]
    )
    database = cosmos_client.get_database_client("iot")
    container = database.get_container_client("devices")

    device_record = {
        "id": device_id,
        "status": "online",
        "lastConnected": data.get('eventTime'),
        "hubName": data.get('hubName')
    }

    container.upsert_item(device_record)
    logging.info(f"Updated device {device_id} status to online")

def handle_device_disconnected(device_id, data):
    """Update device status when disconnected."""
    logging.info(f"Device {device_id} disconnected")

    # Update device registry
    cosmos_client = CosmosClient.from_connection_string(
        os.environ["COSMOS_CONNECTION_STRING"]
    )
    database = cosmos_client.get_database_client("iot")
    container = database.get_container_client("devices")

    device_record = {
        "id": device_id,
        "status": "offline",
        "lastDisconnected": data.get('eventTime')
    }

    container.upsert_item(device_record)
```

### Use Case 3: Key Vault Secret Rotation

Automate secret rotation when secrets near expiration.

```python
# Azure Function for Key Vault secret expiry
import azure.functions as func
import logging
from azure.keyvault.secrets import SecretClient
from azure.identity import DefaultAzureCredential

def main(event: func.EventGridEvent):
    """Handle Key Vault secret events."""
    event_type = event.event_type
    data = event.get_json()

    secret_name = data.get('ObjectName')
    vault_name = data.get('VaultName')

    logging.info(f"Key Vault event: {event_type} for secret {secret_name}")

    if event_type == 'Microsoft.KeyVault.SecretNearExpiry':
        rotate_secret(vault_name, secret_name)

    elif event_type == 'Microsoft.KeyVault.SecretExpired':
        handle_expired_secret(vault_name, secret_name)

def rotate_secret(vault_name, secret_name):
    """Rotate secret before expiration."""
    logging.warning(f"Secret {secret_name} expiring soon, rotating...")

    vault_url = f"https://{vault_name}.vault.azure.net"
    credential = DefaultAzureCredential()
    client = SecretClient(vault_url=vault_url, credential=credential)

    # Generate new secret value (example: API key rotation)
    new_secret_value = generate_new_api_key()

    # Update the secret
    client.set_secret(secret_name, new_secret_value)

    logging.info(f"Rotated secret {secret_name}")

    # Notify administrators
    send_notification(f"Secret {secret_name} has been rotated")

def handle_expired_secret(vault_name, secret_name):
    """Handle expired secret alert."""
    logging.error(f"Secret {secret_name} has EXPIRED!")

    # Send critical alert
    send_critical_alert(f"CRITICAL: Secret {secret_name} in vault {vault_name} has expired")
```

### Use Case 4: Container Registry Automation

Trigger CI/CD pipelines when container images are pushed.

```bash
# Create Event Grid subscription for ACR events
az eventgrid event-subscription create \
  --name acr-image-push \
  --source-resource-id /subscriptions/{sub-id}/resourceGroups/rg-containers/providers/Microsoft.ContainerRegistry/registries/myregistry \
  --endpoint https://mydevops.com/api/trigger-pipeline \
  --endpoint-type webhook \
  --included-event-types Microsoft.ContainerRegistry.ImagePushed \
  --subject-begins-with myapp/
```

```python
# Python webhook handler for ACR events
from fastapi import FastAPI, Request
import logging

app = FastAPI()

@app.post("/api/trigger-pipeline")
async def handle_acr_event(request: Request):
    """Handle ACR image push events."""
    event_data = await request.json()

    for event in event_data:
        event_type = event.get('eventType')

        if event_type == 'Microsoft.ContainerRegistry.ImagePushed':
            data = event.get('data')
            image = f"{data['repository']}:{data['tag']}"

            logging.info(f"New image pushed: {image}")

            # Trigger deployment pipeline
            await trigger_deployment_pipeline(
                image=image,
                registry=data['registry'],
                repository=data['repository'],
                tag=data['tag']
            )

    return {"status": "processed"}

async def trigger_deployment_pipeline(image, registry, repository, tag):
    """Trigger Azure DevOps pipeline."""
    # Call Azure DevOps API to trigger pipeline
    logging.info(f"Triggering deployment for {image}")
```

---

## 🔍 Event Schema Examples

### Blob Storage Event

```json
{
  "topic": "/subscriptions/{sub-id}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/mystorageaccount",
  "subject": "/blobServices/default/containers/uploads/blobs/data.csv",
  "eventType": "Microsoft.Storage.BlobCreated",
  "eventTime": "2025-01-28T10:30:00.0000000Z",
  "id": "831e1650-001e-001b-66ab-eeb76e000000",
  "data": {
    "api": "PutBlob",
    "clientRequestId": "6d79dbfb-0e37-4fc4-981f-442c9ca65760",
    "requestId": "831e1650-001e-001b-66ab-eeb76e000000",
    "eTag": "0x8D4BCC2E4835CD0",
    "contentType": "text/csv",
    "contentLength": 524288,
    "blobType": "BlockBlob",
    "url": "https://mystorageaccount.blob.core.windows.net/uploads/data.csv",
    "sequencer": "00000000000004420000000000028963",
    "storageDiagnostics": {
      "batchId": "b68529f3-68cd-4744-baa4-3c0498ec19f0"
    }
  },
  "dataVersion": "2.0",
  "metadataVersion": "1"
}
```

### IoT Hub Event

```json
{
  "topic": "/subscriptions/{sub-id}/resourceGroups/rg/providers/Microsoft.Devices/IotHubs/myiothub",
  "subject": "devices/sensor-01",
  "eventType": "Microsoft.Devices.DeviceConnected",
  "eventTime": "2025-01-28T10:30:00.0000000Z",
  "id": "f6bbf8f4-d365-520d-a878-17bf7238abd8",
  "data": {
    "deviceId": "sensor-01",
    "moduleId": "",
    "hubName": "myiothub",
    "deviceConnectionStateEventInfo": {
      "sequenceNumber": "000000000000000001D4132452F67CE200000002000000000000000000000001"
    }
  },
  "dataVersion": "1.0",
  "metadataVersion": "1"
}
```

### Key Vault Event

```json
{
  "topic": "/subscriptions/{sub-id}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/myvault",
  "subject": "secrets/api-key",
  "eventType": "Microsoft.KeyVault.SecretNearExpiry",
  "eventTime": "2025-01-28T10:30:00.0000000Z",
  "id": "f6bbf8f4-d365-520d-a878-17bf7238abd8",
  "data": {
    "Id": "https://myvault.vault.azure.net/secrets/api-key/f6bbf8f4d365520da87817bf7238abd8",
    "VaultName": "myvault",
    "ObjectType": "Secret",
    "ObjectName": "api-key",
    "Version": "f6bbf8f4d365520da87817bf7238abd8",
    "NBF": 1548114759,
    "EXP": 1548115059
  },
  "dataVersion": "1.0",
  "metadataVersion": "1"
}
```

---

## 🔗 Advanced Filtering

### Subject Filtering

```bash
# Filter by subject prefix and suffix
az eventgrid event-subscription create \
  --name filtered-subscription \
  --source-resource-id /subscriptions/{sub}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/myaccount \
  --endpoint https://myfunction.com/api/handler \
  --subject-begins-with /blobServices/default/containers/production/ \
  --subject-ends-with .json
```

### Advanced Filtering

```bash
# Create subscription with advanced filters
az eventgrid event-subscription create \
  --name advanced-filter \
  --source-resource-id /subscriptions/{sub}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/myaccount \
  --endpoint https://myfunction.com/api/handler \
  --advanced-filter data.contentLength NumberGreaterThan 1048576 \
  --advanced-filter data.blobType StringEquals BlockBlob
```

```json
// Advanced filter JSON example
{
  "filter": {
    "advancedFilters": [
      {
        "operatorType": "NumberGreaterThan",
        "key": "data.contentLength",
        "value": 1048576
      },
      {
        "operatorType": "StringIn",
        "key": "data.contentType",
        "values": ["application/json", "text/csv"]
      },
      {
        "operatorType": "StringContains",
        "key": "subject",
        "values": ["production", "staging"]
      }
    ]
  }
}
```

---

## 🔗 Related Resources

### Core Topics

- [__Event Grid Overview__](README.md) - Service fundamentals
- [__Event-Driven Architecture__](event-driven-architecture.md) - Design patterns

### Integration Guides

- [__Azure Functions Integration__](../../../04-implementation-guides/integration-scenarios/eventgrid-functions.md)
- [__Logic Apps Integration__](../../../04-implementation-guides/integration-scenarios/eventgrid-logicapps.md)

### Best Practices

- [__Event Handling__](../../../05-best-practices/cross-cutting-concerns/event-handling/event-grid-patterns.md)
- [__Error Handling__](../../../05-best-practices/operational-excellence/eventgrid-reliability.md)

---

*Last Updated: 2025-01-28*
*Event Types: 100+ Azure Services*
*Coverage: Complete*
