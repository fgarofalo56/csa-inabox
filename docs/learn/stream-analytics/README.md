# Stream Analytics Documentation

> **[Home](../README.md)** | **Stream Analytics**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Azure%20Stream%20Analytics-blue?style=flat-square)

Azure Stream Analytics documentation for real-time analytics.

---

## Overview

Azure Stream Analytics is a fully managed, real-time analytics service for:

- Event stream processing
- Real-time dashboards
- Anomaly detection
- IoT analytics

---

## Quick Start

### Create Job

```sql
-- Simple pass-through query
SELECT *
INTO [output-eventhub]
FROM [input-eventhub]
WHERE temperature > 30

-- Tumbling window aggregation
SELECT
    System.Timestamp() AS WindowEnd,
    deviceId,
    AVG(temperature) AS avgTemp,
    MAX(temperature) AS maxTemp,
    COUNT(*) AS eventCount
INTO [output-blob]
FROM [input-eventhub]
GROUP BY deviceId, TumblingWindow(minute, 5)
```

---

## Key Concepts

### Window Functions

| Window Type | Description | Use Case |
|-------------|-------------|----------|
| Tumbling | Fixed, non-overlapping | Regular aggregations |
| Hopping | Fixed, overlapping | Smoothed aggregations |
| Sliding | Variable, triggered | Threshold monitoring |
| Session | Activity-based | User session analysis |

### Input Sources

- Azure Event Hubs
- Azure IoT Hub
- Azure Blob Storage
- Azure Data Lake Storage

### Output Sinks

- Event Hubs
- Blob Storage
- SQL Database
- Cosmos DB
- Power BI
- Azure Functions

---

## Advanced Patterns

### Anomaly Detection

```sql
-- Built-in anomaly detection
SELECT
    System.Timestamp() AS time,
    deviceId,
    temperature,
    AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikesanddips')
        OVER(PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS anomalyResult
INTO [output]
FROM [input]
```

### Reference Data Join

```sql
SELECT
    e.deviceId,
    e.temperature,
    d.location,
    d.deviceType
INTO [output]
FROM [events] e
JOIN [devices] d ON e.deviceId = d.deviceId
```

---

## Related Documentation

- [Streaming Architectures](../03-architecture-patterns/streaming-architectures/README.md)
- [Event Hubs Integration](../02-services/streaming-services/azure-event-hubs/README.md)
- [Stream Analytics Tutorials](../tutorials/stream-analytics/README.md)

---

*Last Updated: January 2025*
