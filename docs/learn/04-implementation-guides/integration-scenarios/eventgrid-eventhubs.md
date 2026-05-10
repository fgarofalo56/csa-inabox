# Event Grid Integration with Event Hubs

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __EventGrid + EventHubs__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Route Azure events to Event Hubs for stream processing and analytics.

---

## Overview

Event Grid to Event Hubs integration enables:

- Centralized event collection from multiple Azure services
- Durable event storage for replay and audit
- Stream processing of cloud events

---

## Implementation

### Step 1: Create Event Hub Destination

```bash
# Create Event Hub namespace
az eventhubs namespace create \
    --resource-group rg-analytics \
    --name eh-events-ns \
    --sku Standard \
    --enable-auto-inflate \
    --maximum-throughput-units 10

# Create Event Hub
az eventhubs eventhub create \
    --resource-group rg-analytics \
    --namespace-name eh-events-ns \
    --name cloud-events \
    --partition-count 4 \
    --message-retention 7
```

### Step 2: Create Event Grid Subscription

```bash
# Subscribe to storage events
az eventgrid event-subscription create \
    --name storage-to-eventhub \
    --source-resource-id "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.Storage/storageAccounts/datalake" \
    --endpoint-type eventhub \
    --endpoint "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.EventHub/namespaces/eh-events-ns/eventhubs/cloud-events" \
    --included-event-types Microsoft.Storage.BlobCreated Microsoft.Storage.BlobDeleted
```

### Step 3: ARM Template for Multiple Subscriptions

```json
{
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    "contentVersion": "1.0.0.0",
    "resources": [
        {
            "type": "Microsoft.EventGrid/systemTopics",
            "apiVersion": "2022-06-15",
            "name": "storage-topic",
            "location": "[resourceGroup().location]",
            "properties": {
                "source": "[resourceId('Microsoft.Storage/storageAccounts', 'datalake')]",
                "topicType": "Microsoft.Storage.StorageAccounts"
            }
        },
        {
            "type": "Microsoft.EventGrid/systemTopics/eventSubscriptions",
            "apiVersion": "2022-06-15",
            "name": "storage-topic/blob-events-to-eh",
            "dependsOn": ["[resourceId('Microsoft.EventGrid/systemTopics', 'storage-topic')]"],
            "properties": {
                "destination": {
                    "endpointType": "EventHub",
                    "properties": {
                        "resourceId": "[resourceId('Microsoft.EventHub/namespaces/eventhubs', 'eh-events-ns', 'cloud-events')]"
                    }
                },
                "filter": {
                    "includedEventTypes": [
                        "Microsoft.Storage.BlobCreated",
                        "Microsoft.Storage.BlobDeleted"
                    ],
                    "subjectBeginsWith": "/blobServices/default/containers/bronze/",
                    "isSubjectCaseSensitive": false
                },
                "eventDeliverySchema": "CloudEventSchemaV1_0"
            }
        }
    ]
}
```

### Step 4: Process Events in Databricks

```python
from pyspark.sql.functions import *
from pyspark.sql.types import *

# Schema for CloudEvents
cloud_event_schema = StructType([
    StructField("specversion", StringType(), True),
    StructField("type", StringType(), True),
    StructField("source", StringType(), True),
    StructField("id", StringType(), True),
    StructField("time", TimestampType(), True),
    StructField("subject", StringType(), True),
    StructField("data", StringType(), True)
])

# Read from Event Hub
events_df = spark.readStream.format("eventhubs") \
    .options(**eventhub_config) \
    .load() \
    .withColumn("event", from_json(col("body").cast("string"), cloud_event_schema)) \
    .select("event.*")

# Filter by event type
blob_created = events_df.filter(col("type") == "Microsoft.Storage.BlobCreated")
blob_deleted = events_df.filter(col("type") == "Microsoft.Storage.BlobDeleted")

# Extract blob details
blob_details = blob_created.withColumn(
    "data_parsed",
    from_json(col("data"), StructType([
        StructField("api", StringType()),
        StructField("contentType", StringType()),
        StructField("contentLength", LongType()),
        StructField("url", StringType())
    ]))
).select(
    col("id").alias("event_id"),
    col("time").alias("event_time"),
    col("subject"),
    col("data_parsed.url").alias("blob_url"),
    col("data_parsed.contentLength").alias("size_bytes"),
    col("data_parsed.contentType").alias("content_type")
)
```

### Step 5: Multi-Source Event Aggregation

```python
# Create subscriptions for multiple sources
sources = [
    {"name": "storage", "topic_type": "Microsoft.Storage.StorageAccounts"},
    {"name": "keyvault", "topic_type": "Microsoft.KeyVault.vaults"},
    {"name": "containerregistry", "topic_type": "Microsoft.ContainerRegistry.registries"}
]

# Process unified event stream
unified_events = events_df.select(
    col("id").alias("event_id"),
    col("type").alias("event_type"),
    col("source").alias("event_source"),
    col("time").alias("event_time"),
    col("subject"),
    col("data")
)

# Write to Delta Lake for audit
unified_events.writeStream \
    .format("delta") \
    .partitionBy("event_type") \
    .option("checkpointLocation", "/checkpoints/cloud_events") \
    .toTable("audit.cloud_events")
```

---

## Event Filtering

```json
{
    "filter": {
        "includedEventTypes": ["Microsoft.Storage.BlobCreated"],
        "subjectBeginsWith": "/blobServices/default/containers/bronze/",
        "subjectEndsWith": ".parquet",
        "advancedFilters": [
            {
                "operatorType": "NumberGreaterThan",
                "key": "data.contentLength",
                "value": 1048576
            }
        ]
    }
}
```

---

## Related Documentation

- [EventGrid + Functions](eventgrid-functions.md)
- [EventGrid + Logic Apps](eventgrid-logicapps.md)
- [EventHub + Databricks](eventhub-databricks.md)

---

*Last Updated: January 2025*
