# Stream Analytics Integration with Event Grid

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __ASA + Event Grid__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Route Stream Analytics alerts and events to Event Grid for downstream processing.

---

## Overview

Stream Analytics can publish to Event Grid to enable:

- Alert distribution to multiple subscribers
- Event-driven automation based on streaming insights
- Decoupled architecture for stream processing results

---

## Implementation

### Step 1: Create Custom Event Grid Topic

```bash
# Create Event Grid topic for alerts
az eventgrid topic create \
    --resource-group rg-analytics \
    --name asa-alerts-topic \
    --location eastus
```

### Step 2: Configure Azure Function Output

```sql
-- Stream Analytics query that triggers alerts
SELECT
    device_id,
    temperature,
    System.Timestamp() AS alert_time,
    'HIGH_TEMPERATURE' AS alert_type
INTO [function-output]
FROM [iot-input]
WHERE temperature > 100

-- Aggregate anomalies for batch alerts
SELECT
    COUNT(*) AS anomaly_count,
    AVG(temperature) AS avg_temp,
    System.Timestamp() AS window_end
INTO [batch-alert-output]
FROM [iot-input]
WHERE temperature > 80
GROUP BY TumblingWindow(minute, 5)
HAVING COUNT(*) > 10
```

### Step 3: Azure Function to Publish to Event Grid

```python
import azure.functions as func
from azure.eventgrid import EventGridPublisherClient, EventGridEvent
from azure.core.credentials import AzureKeyCredential
import json
import os
from datetime import datetime

app = func.FunctionApp()

@app.function_name("PublishASAAlerts")
@app.route(route="asa-alerts", methods=["POST"])
async def publish_asa_alerts(req: func.HttpRequest) -> func.HttpResponse:
    """Receive ASA output and publish to Event Grid."""

    try:
        # Parse ASA output (array of records)
        records = req.get_json()

        # Event Grid client
        endpoint = os.environ["EVENTGRID_TOPIC_ENDPOINT"]
        key = os.environ["EVENTGRID_TOPIC_KEY"]
        client = EventGridPublisherClient(endpoint, AzureKeyCredential(key))

        # Convert each record to Event Grid event
        events = []
        for record in records:
            event = EventGridEvent(
                subject=f"alerts/{record['alert_type']}/{record['device_id']}",
                event_type="Analytics.Alert.Triggered",
                data={
                    "device_id": record["device_id"],
                    "temperature": record["temperature"],
                    "alert_type": record["alert_type"],
                    "alert_time": record["alert_time"],
                    "source": "StreamAnalytics"
                },
                data_version="1.0"
            )
            events.append(event)

        # Publish batch
        if events:
            await client.send(events)

        return func.HttpResponse(f"Published {len(events)} events", status_code=200)

    except Exception as e:
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
```

### Step 4: Event Grid Subscriptions for Alerts

```json
{
    "name": "alert-to-teams",
    "properties": {
        "destination": {
            "endpointType": "WebHook",
            "properties": {
                "endpointUrl": "https://outlook.office.com/webhook/..."
            }
        },
        "filter": {
            "includedEventTypes": ["Analytics.Alert.Triggered"],
            "advancedFilters": [
                {
                    "operatorType": "StringContains",
                    "key": "data.alert_type",
                    "values": ["HIGH_TEMPERATURE", "CRITICAL"]
                }
            ]
        }
    }
}
```

### Step 5: Complete Pipeline Architecture

```python
# Databricks notebook to consume alerts
from pyspark.sql.functions import *

# Read from Event Hub (subscribed to Event Grid)
alerts_stream = spark.readStream.format("eventhubs") \
    .options(**eventhub_config) \
    .load() \
    .withColumn("event", from_json(col("body").cast("string"), alert_schema)) \
    .select("event.*")

# Enrich alerts with device metadata
enriched_alerts = alerts_stream.join(
    spark.table("reference.devices"),
    "device_id"
).select(
    "device_id",
    "device_name",
    "location",
    "temperature",
    "alert_type",
    "alert_time"
)

# Write to alert history
enriched_alerts.writeStream \
    .format("delta") \
    .option("checkpointLocation", "/checkpoints/alerts") \
    .toTable("analytics.alert_history")
```

---

## Alert Routing Patterns

### Severity-Based Routing

```sql
-- Critical alerts (immediate)
SELECT * INTO [critical-alerts-output]
FROM [iot-input]
WHERE temperature > 120

-- Warning alerts (5-minute aggregation)
SELECT
    device_id,
    COUNT(*) as warning_count,
    System.Timestamp() as window_end
INTO [warning-alerts-output]
FROM [iot-input]
WHERE temperature BETWEEN 100 AND 120
GROUP BY device_id, TumblingWindow(minute, 5)
HAVING COUNT(*) > 3
```

### Multi-Destination Fan-Out

```json
{
    "subscriptions": [
        {
            "name": "alerts-to-pagerduty",
            "filter": { "advancedFilters": [{ "key": "data.severity", "values": ["critical"] }] },
            "destination": { "endpointType": "WebHook", "properties": { "endpointUrl": "https://events.pagerduty.com/..." } }
        },
        {
            "name": "alerts-to-slack",
            "filter": { "advancedFilters": [{ "key": "data.severity", "values": ["warning", "critical"] }] },
            "destination": { "endpointType": "WebHook", "properties": { "endpointUrl": "https://hooks.slack.com/..." } }
        },
        {
            "name": "alerts-to-storage",
            "filter": {},
            "destination": { "endpointType": "StorageQueue" }
        }
    ]
}
```

---

## Related Documentation

- [ASA + Functions](stream-analytics-functions.md)
- [EventHub + Stream Analytics](eventhub-stream-analytics.md)
- [EventGrid + Functions](eventgrid-functions.md)

---

*Last Updated: January 2025*
