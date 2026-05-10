---
title: "Azure Stream Analytics - Code Examples"
description: "Complete Stream Analytics query examples for real-time data processing and analytics."
tags:
  - code-examples
  - by-service
  - stream-analytics
---
# Azure Stream Analytics - Code Examples

![Service](https://img.shields.io/badge/Service-Azure_Stream_Analytics-blue)
![Language](https://img.shields.io/badge/Language-Stream_Analytics_SQL-orange)
![Complexity](https://img.shields.io/badge/Complexity-Beginner_to_Advanced-red)

Complete Stream Analytics query examples for real-time data processing and analytics.

---

## Overview

This section provides production-ready Stream Analytics query patterns for:

- **Real-Time Analytics** - Live data aggregation and transformation
- **Window Functions** - Temporal analytics with tumbling, hopping, and sliding windows
- **Pattern Detection** - Complex event processing and anomaly detection
- **Data Enrichment** - Joining streaming data with reference data

### What You'll Learn

- Stream Analytics SQL syntax and patterns
- Windowing strategies for temporal analytics
- Join operations with reference data
- Output routing and partitioning
- Performance optimization techniques

---

## Table of Contents

- [Basic Queries](#basic-queries)
- [Window Functions](#window-functions)
- [Advanced Analytics](#advanced-analytics)
- [Reference Data Joins](#reference-data-joins)
- [Setup Instructions](#setup-instructions)
- [Common Patterns](#common-patterns)

---

## Basic Queries

### Example 1: Simple Filtering and Projection

![Complexity](https://img.shields.io/badge/Complexity-Beginner-green)

#### Overview

Basic query to filter and transform streaming data from Event Hubs to Azure Synapse Analytics.

#### Prerequisites

- Stream Analytics job created
- Event Hubs input configured
- Synapse Analytics output configured

#### Query

```sql
-- =====================================================
-- Simple Filter and Projection
-- Filter high-temperature events and transform structure
-- =====================================================

WITH FilteredEvents AS (
    SELECT
        EventId,
        SensorId,
        Temperature,
        Humidity,
        Location,
        System.Timestamp() AS EventTimestamp
    FROM
        EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
    WHERE
        Temperature > 30.0  -- Filter high temperature readings
        AND Humidity > 40.0
)

SELECT
    EventId,
    SensorId,
    Temperature,
    Humidity,
    Location,
    EventTimestamp,
    'HighTemperature' AS AlertType,
    CASE
        WHEN Temperature > 40.0 THEN 'Critical'
        WHEN Temperature > 35.0 THEN 'Warning'
        ELSE 'Normal'
    END AS SeverityLevel
INTO
    SynapseOutput
FROM
    FilteredEvents;
```

#### Expected Output

Stream Analytics will write records to Synapse in this format:

```json
{
  "EventId": "evt-12345",
  "SensorId": "sensor-A01",
  "Temperature": 35.2,
  "Humidity": 65.8,
  "Location": "Building-A",
  "EventTimestamp": "2024-12-09T10:30:00.000Z",
  "AlertType": "HighTemperature",
  "SeverityLevel": "Warning"
}
```

#### Common Variations

**Variation 1: Multiple Conditions**

```sql
-- Filter with multiple conditions
SELECT
    *
FROM
    EventHubInput
WHERE
    (Temperature > 30.0 OR Humidity > 80.0)
    AND Location IN ('Building-A', 'Building-B')
    AND SensorId LIKE 'sensor-A%';
```

**Variation 2: Data Type Conversions**

```sql
-- Convert and format data
SELECT
    EventId,
    CAST(Temperature AS DECIMAL(5,2)) AS Temperature,
    CAST(Humidity AS INT) AS Humidity,
    DATEADD(hour, 5, System.Timestamp()) AS LocalTimestamp
FROM
    EventHubInput;
```

---

### Example 2: Data Aggregation

![Complexity](https://img.shields.io/badge/Complexity-Beginner-green)

#### Overview

Aggregate streaming data to calculate statistics per sensor.

#### Query

```sql
-- =====================================================
-- Real-Time Aggregation
-- Calculate statistics per sensor every 1 minute
-- =====================================================

SELECT
    SensorId,
    Location,
    COUNT(*) AS EventCount,
    AVG(Temperature) AS AvgTemperature,
    MIN(Temperature) AS MinTemperature,
    MAX(Temperature) AS MaxTemperature,
    STDEV(Temperature) AS TempStdDev,
    AVG(Humidity) AS AvgHumidity,
    System.Timestamp() AS WindowEndTime
INTO
    SynapseOutput
FROM
    EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
GROUP BY
    SensorId,
    Location,
    TumblingWindow(minute, 1);
```

#### Expected Output

```json
{
  "SensorId": "sensor-A01",
  "Location": "Building-A",
  "EventCount": 120,
  "AvgTemperature": 28.5,
  "MinTemperature": 25.2,
  "MaxTemperature": 32.1,
  "TempStdDev": 1.8,
  "AvgHumidity": 62.3,
  "WindowEndTime": "2024-12-09T10:31:00.000Z"
}
```

---

## Window Functions

### Example 3: Tumbling Window Analytics

![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)

#### Overview

Use tumbling windows for non-overlapping time-based aggregations.

#### Query

```sql
-- =====================================================
-- Tumbling Window Aggregation
-- 5-minute non-overlapping windows
-- =====================================================

-- Calculate sensor statistics every 5 minutes
SELECT
    SensorId,
    Location,
    COUNT(*) AS EventCount,
    AVG(Temperature) AS AvgTemperature,
    MAX(Temperature) AS MaxTemperature,
    System.Timestamp() AS WindowEnd,
    DATEADD(minute, -5, System.Timestamp()) AS WindowStart
INTO
    PowerBIOutput
FROM
    EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
GROUP BY
    SensorId,
    Location,
    TumblingWindow(minute, 5);

-- Detect sensors with abnormal readings
WITH AbnormalReadings AS (
    SELECT
        SensorId,
        Location,
        COUNT(*) AS ErrorCount,
        System.Timestamp() AS WindowEnd
    FROM
        EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
    WHERE
        Temperature > 100 OR Temperature < -50  -- Out of normal range
        OR Humidity > 100 OR Humidity < 0
    GROUP BY
        SensorId,
        Location,
        TumblingWindow(minute, 5)
    HAVING
        COUNT(*) > 3  -- More than 3 errors in window
)

SELECT
    SensorId,
    Location,
    ErrorCount,
    WindowEnd,
    'SensorMalfunction' AS AlertType
INTO
    AlertOutput
FROM
    AbnormalReadings;
```

---

### Example 4: Hopping Window Analytics

![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)

#### Overview

Use hopping windows for overlapping time windows to detect trends.

#### Query

```sql
-- =====================================================
-- Hopping Window for Trend Detection
-- 10-minute windows, advancing every 2 minutes
-- =====================================================

-- Calculate moving average temperature
WITH MovingAverages AS (
    SELECT
        SensorId,
        Location,
        AVG(Temperature) AS AvgTemp,
        COUNT(*) AS SampleCount,
        System.Timestamp() AS WindowEnd
    FROM
        EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
    GROUP BY
        SensorId,
        Location,
        HoppingWindow(minute, 10, 2)  -- 10-min window, 2-min hop
)

SELECT
    SensorId,
    Location,
    AvgTemp,
    SampleCount,
    WindowEnd,
    -- Calculate trend compared to previous window
    LAG(AvgTemp, 1) OVER (PARTITION BY SensorId LIMIT DURATION(minute, 20)) AS PreviousAvgTemp,
    -- Temperature change rate
    (AvgTemp - LAG(AvgTemp, 1) OVER (PARTITION BY SensorId LIMIT DURATION(minute, 20))) AS TempChange
INTO
    TrendAnalysisOutput
FROM
    MovingAverages;
```

---

### Example 5: Sliding Window Analytics

![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

#### Overview

Use sliding windows for continuous monitoring and anomaly detection.

#### Query

```sql
-- =====================================================
-- Sliding Window for Anomaly Detection
-- Detect sudden temperature spikes
-- =====================================================

-- Detect rapid temperature changes
WITH TemperatureChanges AS (
    SELECT
        SensorId,
        Location,
        Temperature,
        System.Timestamp() AS EventTime,
        LAG(Temperature, 1) OVER (PARTITION BY SensorId LIMIT DURATION(minute, 5)) AS PrevTemperature,
        LAG(System.Timestamp(), 1) OVER (PARTITION BY SensorId LIMIT DURATION(minute, 5)) AS PrevEventTime
    FROM
        EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
),
Anomalies AS (
    SELECT
        SensorId,
        Location,
        Temperature,
        PrevTemperature,
        (Temperature - PrevTemperature) AS TempDelta,
        DATEDIFF(second, PrevEventTime, EventTime) AS TimeDeltaSeconds,
        EventTime
    FROM
        TemperatureChanges
    WHERE
        ABS(Temperature - PrevTemperature) > 10.0  -- > 10 degree change
        AND DATEDIFF(second, PrevEventTime, EventTime) < 60  -- within 1 minute
)

SELECT
    SensorId,
    Location,
    Temperature,
    PrevTemperature,
    TempDelta,
    EventTime,
    'TemperatureAnomaly' AS AlertType,
    CASE
        WHEN TempDelta > 0 THEN 'Spike'
        ELSE 'Drop'
    END AS AnomalyDirection
INTO
    AnomalyOutput
FROM
    Anomalies;
```

---

## Advanced Analytics

### Example 6: Complex Event Processing

![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

#### Overview

Detect complex patterns across multiple event streams.

#### Query

```sql
-- =====================================================
-- Complex Event Processing
-- Detect equipment failure patterns
-- =====================================================

-- Join sensor data with equipment status
WITH EquipmentEvents AS (
    SELECT
        e.EquipmentId,
        e.Location,
        s.SensorId,
        s.Temperature,
        s.Vibration,
        s.Pressure,
        e.OperatingStatus,
        e.LastMaintenanceDate,
        System.Timestamp() AS EventTime
    FROM
        SensorInputStream s TIMESTAMP BY EventEnqueuedUtcTime
        INNER JOIN EquipmentInputStream e TIMESTAMP BY EventEnqueuedUtcTime
        ON s.EquipmentId = e.EquipmentId
        AND DATEDIFF(second, s, e) BETWEEN 0 AND 5
),

-- Detect failure indicators
FailureIndicators AS (
    SELECT
        EquipmentId,
        Location,
        Temperature,
        Vibration,
        Pressure,
        OperatingStatus,
        EventTime,
        CASE
            WHEN Temperature > 80 THEN 1 ELSE 0
        END AS HighTempFlag,
        CASE
            WHEN Vibration > 50 THEN 1 ELSE 0
        END AS HighVibrationFlag,
        CASE
            WHEN Pressure < 20 THEN 1 ELSE 0
        END AS LowPressureFlag
    FROM
        EquipmentEvents
),

-- Aggregate failure indicators over time
FailureScore AS (
    SELECT
        EquipmentId,
        Location,
        SUM(HighTempFlag) AS TempViolations,
        SUM(HighVibrationFlag) AS VibrationViolations,
        SUM(LowPressureFlag) AS PressureViolations,
        COUNT(*) AS TotalReadings,
        System.Timestamp() AS WindowEnd
    FROM
        FailureIndicators
    GROUP BY
        EquipmentId,
        Location,
        TumblingWindow(minute, 10)
),

-- Calculate failure probability
FailurePrediction AS (
    SELECT
        EquipmentId,
        Location,
        TempViolations,
        VibrationViolations,
        PressureViolations,
        TotalReadings,
        WindowEnd,
        -- Simple failure score (0-100)
        ((CAST(TempViolations AS FLOAT) / TotalReadings) * 40 +
         (CAST(VibrationViolations AS FLOAT) / TotalReadings) * 35 +
         (CAST(PressureViolations AS FLOAT) / TotalReadings) * 25) AS FailureScore
    FROM
        FailureScore
)

SELECT
    EquipmentId,
    Location,
    TempViolations,
    VibrationViolations,
    PressureViolations,
    FailureScore,
    WindowEnd,
    CASE
        WHEN FailureScore >= 75 THEN 'Critical'
        WHEN FailureScore >= 50 THEN 'Warning'
        WHEN FailureScore >= 25 THEN 'Monitor'
        ELSE 'Normal'
    END AS RiskLevel
INTO
    PredictiveMaintenanceOutput
FROM
    FailurePrediction;
```

#### Expected Output

```json
{
  "EquipmentId": "EQ-1001",
  "Location": "Factory-Floor-A",
  "TempViolations": 45,
  "VibrationViolations": 32,
  "PressureViolations": 18,
  "FailureScore": 68.5,
  "WindowEnd": "2024-12-09T10:40:00.000Z",
  "RiskLevel": "Warning"
}
```

---

## Reference Data Joins

### Example 7: Enriching with Reference Data

![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)

#### Overview

Join streaming data with reference data for enrichment.

#### Query

```sql
-- =====================================================
-- Reference Data Join
-- Enrich sensor data with device metadata
-- =====================================================

-- Join with device reference data
SELECT
    s.SensorId,
    s.Temperature,
    s.Humidity,
    s.Location,
    r.DeviceType,
    r.Manufacturer,
    r.InstallationDate,
    r.MaintenanceSchedule,
    r.AlertThreshold,
    System.Timestamp() AS EventTime,
    -- Apply device-specific thresholds
    CASE
        WHEN s.Temperature > r.AlertThreshold THEN 'ALERT'
        WHEN s.Temperature > (r.AlertThreshold * 0.9) THEN 'WARNING'
        ELSE 'NORMAL'
    END AS Status
INTO
    EnrichedOutput
FROM
    SensorInputStream s TIMESTAMP BY EventEnqueuedUtcTime
    LEFT OUTER JOIN DeviceReferenceData r
    ON s.SensorId = r.SensorId;

-- Join with multiple reference datasets
WITH EnrichedSensorData AS (
    SELECT
        s.*,
        d.DeviceType,
        d.AlertThreshold,
        l.Building,
        l.Floor,
        l.Zone,
        l.ResponsibleTeam
    FROM
        SensorInputStream s TIMESTAMP BY EventEnqueuedUtcTime
        LEFT OUTER JOIN DeviceReferenceData d
        ON s.SensorId = d.SensorId
        LEFT OUTER JOIN LocationReferenceData l
        ON s.Location = l.LocationId
)

SELECT
    SensorId,
    DeviceType,
    Temperature,
    Building,
    Floor,
    Zone,
    ResponsibleTeam,
    System.Timestamp() AS EventTime,
    -- Use reference data for smart routing
    CASE
        WHEN Temperature > AlertThreshold THEN ResponsibleTeam
        ELSE 'NoAction'
    END AS RouteToTeam
INTO
    AlertRoutingOutput
FROM
    EnrichedSensorData
WHERE
    Temperature > AlertThreshold;
```

---

### Example 8: Time-Series Analysis

![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

#### Overview

Perform advanced time-series analytics with lag functions and pattern matching.

#### Query

```sql
-- =====================================================
-- Time Series Pattern Detection
-- Detect sustained high-temperature periods
-- =====================================================

-- Calculate rolling statistics
WITH RollingStats AS (
    SELECT
        SensorId,
        Location,
        Temperature,
        AVG(Temperature) OVER (
            PARTITION BY SensorId
            LIMIT DURATION(minute, 30)
        ) AS AvgTemp30Min,
        STDEV(Temperature) OVER (
            PARTITION BY SensorId
            LIMIT DURATION(minute, 30)
        ) AS StdDev30Min,
        System.Timestamp() AS EventTime
    FROM
        EventHubInput TIMESTAMP BY EventEnqueuedUtcTime
),

-- Detect anomalies using standard deviation
AnomalyDetection AS (
    SELECT
        SensorId,
        Location,
        Temperature,
        AvgTemp30Min,
        StdDev30Min,
        EventTime,
        -- Z-score calculation
        (Temperature - AvgTemp30Min) / NULLIF(StdDev30Min, 0) AS ZScore
    FROM
        RollingStats
    WHERE
        StdDev30Min IS NOT NULL
        AND StdDev30Min > 0
),

-- Count consecutive anomalies
ConsecutiveAnomalies AS (
    SELECT
        SensorId,
        Location,
        COUNT(*) AS AnomalyCount,
        AVG(Temperature) AS AvgAnomalyTemp,
        MAX(ABS(ZScore)) AS MaxZScore,
        System.Timestamp() AS WindowEnd
    FROM
        AnomalyDetection
    WHERE
        ABS(ZScore) > 2.0  -- 2 standard deviations
    GROUP BY
        SensorId,
        Location,
        SlidingWindow(minute, 15)
    HAVING
        COUNT(*) >= 5  -- At least 5 anomalies in window
)

SELECT
    SensorId,
    Location,
    AnomalyCount,
    AvgAnomalyTemp,
    MaxZScore,
    WindowEnd,
    'SustainedAnomaly' AS AlertType,
    CASE
        WHEN MaxZScore > 3.0 THEN 'Critical'
        WHEN MaxZScore > 2.5 THEN 'High'
        ELSE 'Medium'
    END AS Severity
INTO
    SustainedAnomalyOutput
FROM
    ConsecutiveAnomalies;
```

---

## Setup Instructions

### Prerequisites

1. **Azure Resources**
   - Stream Analytics job
   - Event Hubs (input)
   - Azure Synapse Analytics (output)
   - Azure Storage (for reference data)

### Create Stream Analytics Job

```bash
# Create Resource Group
az group create --name rg-stream-analytics --location eastus

# Create Stream Analytics Job
az stream-analytics job create \
  --resource-group rg-stream-analytics \
  --name sa-job-telemetry \
  --location eastus \
  --output-error-policy Drop \
  --events-outoforder-policy Adjust \
  --events-outoforder-max-delay 5 \
  --events-late-arrival-max-delay 10

# Configure Event Hubs Input
az stream-analytics input create \
  --resource-group rg-stream-analytics \
  --job-name sa-job-telemetry \
  --name EventHubInput \
  --type Stream \
  --datasource @eventhub-input.json \
  --serialization @json-serialization.json

# Configure Synapse Output
az stream-analytics output create \
  --resource-group rg-stream-analytics \
  --job-name sa-job-telemetry \
  --name SynapseOutput \
  --datasource @synapse-output.json \
  --serialization @json-serialization.json
```

### Input Configuration (eventhub-input.json)

```json
{
  "type": "Microsoft.EventHub/EventHub",
  "properties": {
    "serviceBusNamespace": "eh-namespace",
    "eventHubName": "telemetry-events",
    "consumerGroupName": "$Default",
    "authenticationMode": "ConnectionString"
  }
}
```

### Output Configuration (synapse-output.json)

```json
{
  "type": "Microsoft.Sql/Server/Database",
  "properties": {
    "server": "synapse-workspace.sql.azuresynapse.net",
    "database": "analytics_db",
    "table": "dbo.TelemetryEvents",
    "authenticationMode": "Msi"
  }
}
```

### Serialization Configuration (json-serialization.json)

```json
{
  "type": "Json",
  "properties": {
    "encoding": "UTF8"
  }
}
```

---

## Common Patterns

### Windowing Strategies

| Window Type | Use Case | Example |
|-------------|----------|---------|
| **Tumbling** | Non-overlapping aggregations | Hourly sales totals |
| **Hopping** | Overlapping windows for trends | Moving averages |
| **Sliding** | Event-triggered windows | Pattern detection |
| **Session** | User session analytics | Web clickstream analysis |

### Performance Optimization

1. **Partition Input** - Use partition key for parallel processing
2. **Minimize Joins** - Reduce reference data joins when possible
3. **Filter Early** - Apply WHERE clauses before aggregations
4. **Use CTEs** - Common Table Expressions for complex queries

### Output Partitioning

```sql
-- Partition output by location
SELECT
    *,
    Location AS PartitionId
INTO
    PartitionedOutput PARTITION BY PartitionId
FROM
    EventHubInput;
```

---

## Next Steps

- [Synapse Examples](../synapse/README.md) - Data warehouse queries
- [Event Hubs Examples](../event-hubs/README.md) - Event streaming
- [Streaming Pipeline](../../integration-examples/streaming-pipeline/README.md) - End-to-end solution

---

## Additional Resources

- [Stream Analytics Documentation](../../../02-services/streaming-services/azure-stream-analytics/README.md)
- [Best Practices](../../../best-practices/README.md)
- [Query Language Reference](https://docs.microsoft.com/stream-analytics-query/stream-analytics-query-language-reference)

---

**Last Updated:** 2025-12-09
**Version:** 1.0.0
**Maintainer:** CSA-in-a-Box Documentation Team
