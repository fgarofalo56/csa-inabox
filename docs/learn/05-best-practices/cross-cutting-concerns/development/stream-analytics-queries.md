# Stream Analytics Query Development

> **[Home](../../../../README.md)** | **[Best Practices](../../README.md)** | **[Cross-Cutting](../README.md)** | **Stream Analytics Queries**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Development-blue?style=flat-square)

Best practices for developing Azure Stream Analytics queries.

---

## Query Fundamentals

### Basic Structure

```sql
-- Standard query pattern
SELECT
    System.Timestamp() AS EventTime,
    DeviceId,
    AVG(Temperature) AS AvgTemperature,
    COUNT(*) AS EventCount
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)
```

### Window Types

| Window Type | Use Case | Syntax |
|-------------|----------|--------|
| Tumbling | Fixed, non-overlapping | `TumblingWindow(minute, 5)` |
| Hopping | Fixed, overlapping | `HoppingWindow(minute, 10, 5)` |
| Sliding | Event-driven | `SlidingWindow(minute, 5)` |
| Session | Activity-based gaps | `SessionWindow(minute, 5, 30)` |

---

## Performance Optimization

### Partition Optimization

```sql
-- Use PARTITION BY for parallelism
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
    PARTITION BY DeviceId
GROUP BY
    DeviceId,
    TumblingWindow(minute, 1)
```

### Efficient Joins

```sql
-- Reference data join (small, static data)
SELECT
    i.DeviceId,
    i.Temperature,
    r.DeviceLocation,
    r.Threshold
FROM
    IoTHubInput i TIMESTAMP BY EventEnqueuedUtcTime
JOIN
    ReferenceData r ON i.DeviceId = r.DeviceId

-- Stream-to-stream join
SELECT
    a.DeviceId,
    a.Temperature,
    b.Humidity
FROM
    TempStream a TIMESTAMP BY a.EventTime
JOIN
    HumidityStream b TIMESTAMP BY b.EventTime
ON
    a.DeviceId = b.DeviceId
    AND DATEDIFF(second, a, b) BETWEEN -5 AND 5
```

---

## Pattern Detection

### Anomaly Detection

```sql
-- Built-in anomaly detection
SELECT
    DeviceId,
    EventTime,
    Temperature,
    AnomalyDetection_SpikeAndDip(Temperature, 95, 120, 'spikesanddips')
        OVER(PARTITION BY DeviceId LIMIT DURATION(minute, 10)) AS AnomalyResult
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
```

### Trend Analysis

```sql
-- Detect increasing trends
SELECT
    DeviceId,
    System.Timestamp() AS WindowEnd,
    AVG(Temperature) AS AvgTemp,
    LAG(AVG(Temperature), 1) OVER (
        PARTITION BY DeviceId
        LIMIT DURATION(minute, 10)
    ) AS PrevAvgTemp
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)
HAVING
    AVG(Temperature) > LAG(AVG(Temperature), 1) OVER (
        PARTITION BY DeviceId
        LIMIT DURATION(minute, 10)
    ) * 1.1  -- 10% increase
```

---

## Error Handling

### Late Arrival Policy

```sql
-- Configure late arrival tolerance
-- Set in job configuration, not query
-- Late arrival: up to 5 minutes
-- Out of order: up to 10 seconds

-- Handle late events in query
SELECT
    DeviceId,
    System.Timestamp() AS ProcessedTime,
    EventEnqueuedUtcTime AS OriginalTime,
    DATEDIFF(second, EventEnqueuedUtcTime, System.Timestamp()) AS LatencySeconds
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
```

### Null Handling

```sql
-- Safe null handling
SELECT
    DeviceId,
    COALESCE(Temperature, 0) AS Temperature,
    CASE
        WHEN Temperature IS NULL THEN 'MISSING'
        WHEN Temperature > 100 THEN 'HIGH'
        WHEN Temperature < 0 THEN 'LOW'
        ELSE 'NORMAL'
    END AS Status
FROM
    IoTHubInput
WHERE
    DeviceId IS NOT NULL
```

---

## Output Patterns

### Multiple Outputs

```sql
-- Hot path: Real-time alerts
SELECT
    DeviceId,
    Temperature,
    'ALERT' AS Type
INTO
    AlertOutput
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
WHERE
    Temperature > 100

-- Warm path: Aggregated metrics
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp,
    MAX(Temperature) AS MaxTemp,
    MIN(Temperature) AS MinTemp
INTO
    MetricsOutput
FROM
    IoTHubInput TIMESTAMP BY EventEnqueuedUtcTime
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)

-- Cold path: All events for archive
SELECT *
INTO
    ArchiveOutput
FROM
    IoTHubInput
```

---

## Testing

### Local Testing

```powershell
# Test with sample data
az stream-analytics job start \
    --resource-group rg-streaming \
    --name asa-iot-processing \
    --output-start-mode CustomTime \
    --output-start-time "2024-01-15T00:00:00Z"
```

### Query Validation

```sql
-- Validate query logic with sample data
WITH TestData AS (
    SELECT * FROM (
        VALUES
            ('device1', 75.5, '2024-01-15T10:00:00Z'),
            ('device1', 85.0, '2024-01-15T10:01:00Z'),
            ('device1', 105.0, '2024-01-15T10:02:00Z')
    ) AS t(DeviceId, Temperature, EventTime)
)
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp
FROM TestData
GROUP BY DeviceId
```

---

## Related Documentation

- [Stream Analytics Overview](../../../../02-services/streaming-services/azure-stream-analytics/README.md)
- [Event Hubs Integration](../event-handling/event-grid-patterns.md)
- [Real-time Architecture](../../../../03-architecture-patterns/streaming-architectures/README.md)

---

*Last Updated: January 2025*
