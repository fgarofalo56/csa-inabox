# Event Hubs Integration with Stream Analytics

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __EventHub + Stream Analytics__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Real-time analytics on Event Hub streams using Azure Stream Analytics.

---

## Overview

Azure Stream Analytics provides SQL-based stream processing with built-in windowing, joins, and machine learning capabilities.

---

## Implementation

### Step 1: Create Stream Analytics Job

```bash
# Azure CLI
az stream-analytics job create \
    --resource-group rg-analytics \
    --name asa-iot-processing \
    --location eastus \
    --sku Standard \
    --output-error-policy Drop
```

### Step 2: Configure Input

```json
{
    "name": "iot-events-input",
    "properties": {
        "type": "Stream",
        "datasource": {
            "type": "Microsoft.EventHub/EventHub",
            "properties": {
                "serviceBusNamespace": "myhub",
                "eventHubName": "iot-events",
                "consumerGroupName": "asa-consumer",
                "sharedAccessPolicyName": "listen",
                "sharedAccessPolicyKey": "xxx"
            }
        },
        "serialization": {
            "type": "Json",
            "properties": {
                "encoding": "UTF8"
            }
        }
    }
}
```

### Step 3: Stream Analytics Queries

```sql
-- Basic aggregation with tumbling window
SELECT
    device_id,
    System.Timestamp() AS window_end,
    AVG(temperature) AS avg_temp,
    MAX(temperature) AS max_temp,
    MIN(temperature) AS min_temp,
    COUNT(*) AS reading_count
INTO [output-aggregates]
FROM [iot-events-input]
GROUP BY device_id, TumblingWindow(minute, 5)

-- Sliding window for continuous monitoring
SELECT
    device_id,
    System.Timestamp() AS event_time,
    AVG(temperature) OVER (PARTITION BY device_id LIMIT DURATION(minute, 10)) AS rolling_avg
INTO [output-rolling]
FROM [iot-events-input]

-- Anomaly detection
SELECT
    device_id,
    temperature,
    humidity,
    System.Timestamp() AS detected_at,
    'TEMPERATURE_SPIKE' AS anomaly_type
INTO [output-anomalies]
FROM [iot-events-input]
WHERE temperature > 100 OR temperature < -40

-- Session windows for activity tracking
SELECT
    user_id,
    MIN(event_time) AS session_start,
    MAX(event_time) AS session_end,
    COUNT(*) AS event_count,
    DATEDIFF(second, MIN(event_time), MAX(event_time)) AS session_duration_sec
INTO [output-sessions]
FROM [clickstream-input]
GROUP BY user_id, SessionWindow(event_time, INTERVAL 30 MINUTE, INTERVAL 2 HOUR)
```

### Step 4: Reference Data Join

```sql
-- Join stream with reference data
SELECT
    e.device_id,
    e.temperature,
    d.device_name,
    d.location,
    d.threshold_high,
    d.threshold_low,
    System.Timestamp() AS event_time,
    CASE
        WHEN e.temperature > d.threshold_high THEN 'HIGH'
        WHEN e.temperature < d.threshold_low THEN 'LOW'
        ELSE 'NORMAL'
    END AS status
INTO [output-enriched]
FROM [iot-events-input] e
JOIN [device-reference] d ON e.device_id = d.device_id
```

### Step 5: Temporal Joins

```sql
-- Join two streams within time window
SELECT
    o.order_id,
    o.customer_id,
    o.order_time,
    p.payment_id,
    p.payment_time,
    DATEDIFF(second, o.order_time, p.payment_time) AS time_to_payment
INTO [output-orders-payments]
FROM [orders-input] o
JOIN [payments-input] p
    ON o.order_id = p.order_id
    AND DATEDIFF(minute, o, p) BETWEEN 0 AND 30
```

### Step 6: Output to Multiple Destinations

```sql
-- Output to Power BI for real-time dashboard
SELECT
    device_id,
    AVG(temperature) AS avg_temp,
    COUNT(*) AS count,
    System.Timestamp() AS time
INTO [powerbi-output]
FROM [iot-events-input]
GROUP BY device_id, TumblingWindow(second, 10)

-- Output aggregates to Synapse
SELECT
    device_id,
    DATEPART(year, System.Timestamp()) AS year,
    DATEPART(month, System.Timestamp()) AS month,
    DATEPART(day, System.Timestamp()) AS day,
    DATEPART(hour, System.Timestamp()) AS hour,
    AVG(temperature) AS avg_temp,
    MAX(temperature) AS max_temp,
    COUNT(*) AS reading_count
INTO [synapse-output]
FROM [iot-events-input]
GROUP BY device_id, TumblingWindow(hour, 1)

-- Output anomalies to Event Hub for downstream processing
SELECT
    device_id,
    temperature,
    'ANOMALY' AS event_type,
    System.Timestamp() AS detected_at
INTO [eventhub-alerts-output]
FROM [iot-events-input]
WHERE temperature > 100
```

---

## Built-in ML Functions

```sql
-- Anomaly detection with built-in ML
WITH AnomalyDetection AS (
    SELECT
        device_id,
        temperature,
        AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikesanddips') OVER (
            PARTITION BY device_id
            LIMIT DURATION(minute, 10)
        ) AS anomaly_result
    FROM [iot-events-input]
)
SELECT
    device_id,
    temperature,
    anomaly_result.IsAnomaly AS is_anomaly,
    anomaly_result.Score AS anomaly_score
INTO [output-ml-anomalies]
FROM AnomalyDetection
WHERE anomaly_result.IsAnomaly = 1
```

---

## Monitoring Query

```sql
-- Create diagnostic metrics
SELECT
    'StreamAnalyticsMetrics' AS metric_type,
    COUNT(*) AS events_processed,
    System.Timestamp() AS window_time
INTO [metrics-output]
FROM [iot-events-input]
GROUP BY TumblingWindow(minute, 1)
```

---

## Configuration

### Scaling

| Streaming Units | Throughput | Use Case |
|-----------------|------------|----------|
| 1-3 | Up to 1 MB/s | Development/Test |
| 6-12 | Up to 6 MB/s | Production workloads |
| 24+ | 12+ MB/s | High-volume production |

---

## Related Documentation

- [EventHub + Databricks](eventhub-databricks.md)
- [EventHub + Functions](eventhub-functions.md)
- [ASA + Functions](stream-analytics-functions.md)

---

*Last Updated: January 2025*
