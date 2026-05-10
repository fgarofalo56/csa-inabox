---
title: "Tutorial 5: Windowing Functions"
description: "__Master time-based windowing functions for temporal aggregations. Learn tumbling, hopping, sliding, and session windows to analyze streaming data over time intervals.__"
tags:
  - tutorials
  - stream-analytics
---
# ⏰ Tutorial 5: Windowing Functions

![Tutorial](https://img.shields.io/badge/Tutorial-05_Windowing_Functions-blue)
![Duration](https://img.shields.io/badge/Duration-40_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Master time-based windowing functions for temporal aggregations. Learn tumbling, hopping, sliding, and session windows to analyze streaming data over time intervals.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Use tumbling windows__ for non-overlapping fixed intervals
- ✅ __Implement hopping windows__ for overlapping time analysis
- ✅ __Create sliding windows__ for continuous event-driven aggregations
- ✅ __Apply session windows__ for activity-based grouping
- ✅ __Choose appropriate window types__ for different scenarios
- ✅ __Handle late-arriving events__ in windowed queries

## ⏱️ Time Estimate: 40 minutes

- __Tumbling Windows__: 10 minutes
- __Hopping Windows__: 10 minutes
- __Sliding & Session Windows__: 15 minutes
- __Advanced Patterns__: 5 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 04: Basic Queries](04-basic-queries.md)
- [x] Understanding of aggregation functions
- [x] Stream Analytics job running with data flow

## ⏰ Window Types Overview

### __Window Comparison__

| Window Type | Overlapping | Trigger | Use Case |
|-------------|-------------|---------|----------|
| __Tumbling__ | No | Fixed interval | Hourly reports, batch processing |
| __Hopping__ | Yes | Fixed interval | Moving averages, trend analysis |
| __Sliding__ | Yes | Event arrival | Real-time alerts, continuous metrics |
| __Session__ | No | Inactivity gap | User sessions, activity tracking |

## 📊 Step 1: Tumbling Windows

### __1.1 Basic Tumbling Window__

Non-overlapping, fixed-size time windows:

```sql
-- Calculate metrics every 5 minutes (no overlap)
SELECT
    deviceId,
    location,
    COUNT(*) AS eventCount,
    AVG(temperature) AS avgTemperature,
    MIN(temperature) AS minTemperature,
    MAX(temperature) AS maxTemperature,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    TumblingWindow(minute, 5);
```

__Window Behavior:__
- Events from 10:00:00 - 10:04:59 → Window 1
- Events from 10:05:00 - 10:09:59 → Window 2
- No events belong to multiple windows

### __1.2 Multiple Tumbling Windows__

Different intervals for different analyses:

```sql
-- 1-minute tumbling window for real-time monitoring
SELECT
    'RealTime' AS reportType,
    COUNT(DISTINCT deviceId) AS activeDevices,
    AVG(temperature) AS avgTemp,
    System.Timestamp() AS windowEnd
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    TumblingWindow(minute, 1);

-- 1-hour tumbling window for historical trends
SELECT
    'Hourly' AS reportType,
    DATEPART(hour, System.Timestamp()) AS hourOfDay,
    COUNT(*) AS totalEvents,
    AVG(temperature) AS avgTemp,
    STDEV(temperature) AS tempStdDev,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    TumblingWindow(hour, 1);
```

### __1.3 Tumbling Window with Complex Aggregations__

```sql
-- Comprehensive 10-minute device health summary
SELECT
    deviceId,
    location,
    System.Timestamp() AS windowEnd,
    -- Event metrics
    COUNT(*) AS totalEvents,
    COUNT(DISTINCT eventType) AS distinctEventTypes,
    -- Temperature statistics
    AVG(temperature) AS avgTemp,
    MIN(temperature) AS minTemp,
    MAX(temperature) AS maxTemp,
    STDEV(temperature) AS tempVariance,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY temperature) OVER() AS medianTemp,
    -- Status tracking
    SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END) AS normalEvents,
    SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) AS warningEvents,
    SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS criticalEvents,
    -- Health score
    CASE
        WHEN AVG(vibration) < 0.5 AND AVG(temperature) BETWEEN 68 AND 75 THEN 100
        WHEN AVG(vibration) < 1.0 THEN 75
        WHEN AVG(vibration) < 1.5 THEN 50
        ELSE 25
    END AS healthScore
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    TumblingWindow(minute, 10);
```

## 🔄 Step 2: Hopping Windows

### __2.1 Basic Hopping Window__

Overlapping windows for trend analysis:

```sql
-- 10-minute window, hopping every 5 minutes (50% overlap)
SELECT
    deviceId,
    COUNT(*) AS eventCount,
    AVG(temperature) AS avgTemperature,
    System.Timestamp() AS windowEnd
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    HoppingWindow(minute, 10, 5);  -- (window size, hop size)
```

__Window Behavior:__
- Window 1: 10:00:00 - 10:09:59
- Window 2: 10:05:00 - 10:14:59 (overlaps with Window 1)
- Events in overlap period belong to both windows

### __2.2 Moving Average with Hopping Window__

Calculate rolling averages:

```sql
-- 1-hour moving average, updated every 15 minutes
SELECT
    deviceId,
    location,
    AVG(temperature) AS movingAvgTemp,
    AVG(humidity) AS movingAvgHumidity,
    AVG(vibration) AS movingAvgVibration,
    MIN(temperature) AS minTemp,
    MAX(temperature) AS maxTemp,
    COUNT(*) AS sampleCount,
    System.Timestamp() AS windowEnd,
    DATEDIFF(minute, MIN(timestamp), System.Timestamp()) AS windowDurationMinutes
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    HoppingWindow(hour, 1, 15);  -- 1 hour window, hop every 15 min
```

### __2.3 Trend Detection with Hopping Windows__

Identify increasing/decreasing trends:

```sql
-- Detect temperature trends using overlapping windows
WITH WindowedData AS (
    SELECT
        deviceId,
        AVG(temperature) AS avgTemp,
        System.Timestamp() AS windowEnd
    FROM
        EventHubInput TIMESTAMP BY timestamp
    GROUP BY
        deviceId,
        HoppingWindow(minute, 10, 5)
)
SELECT
    deviceId,
    avgTemp AS currentAvgTemp,
    LAG(avgTemp, 1) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS previousAvgTemp,
    CASE
        WHEN avgTemp > LAG(avgTemp, 1) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) + 2 THEN 'Increasing'
        WHEN avgTemp < LAG(avgTemp, 1) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) - 2 THEN 'Decreasing'
        ELSE 'Stable'
    END AS tempTrend,
    windowEnd
INTO
    BlobOutput
FROM
    WindowedData;
```

## 📈 Step 3: Sliding Windows

### __3.1 Basic Sliding Window__

Event-driven windows (re-compute on every event):

```sql
-- Alert when average temperature exceeds threshold in last 5 minutes
SELECT
    deviceId,
    location,
    AVG(temperature) AS avgTempLast5Min,
    COUNT(*) AS eventCount,
    System.Timestamp() AS alertTime
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    SlidingWindow(minute, 5)
HAVING
    AVG(temperature) > 80;
```

__Window Behavior:__
- Recomputed on EVERY event arrival
- Looks back 5 minutes from each event
- Useful for immediate alerting

### __3.2 Continuous Anomaly Detection__

Detect anomalies using sliding window statistics:

```sql
-- Detect temperature spikes using sliding window
SELECT
    deviceId,
    location,
    temperature AS currentTemp,
    AVG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS avgTempLast10Min,
    STDEV(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS stdDevLast10Min,
    CASE
        WHEN temperature > AVG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) +
                           (2 * STDEV(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)))
        THEN 'Spike Detected'
        WHEN temperature < AVG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) -
                           (2 * STDEV(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)))
        THEN 'Drop Detected'
        ELSE 'Normal'
    END AS anomalyStatus,
    System.Timestamp() AS detectionTime
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    temperature IS NOT NULL;
```

### __3.3 Real-Time Threshold Alerting__

Continuous monitoring with sliding windows:

```sql
-- Alert when conditions persist over sliding window
SELECT
    deviceId,
    location,
    AVG(vibration) AS avgVibration,
    MAX(vibration) AS maxVibration,
    COUNT(*) AS highVibrationCount,
    'High Vibration Alert' AS alertType,
    System.Timestamp() AS alertTime
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    SlidingWindow(minute, 3)
HAVING
    AVG(vibration) > 1.0
    AND COUNT(*) >= 5;  -- At least 5 high readings
```

## 🎯 Step 4: Session Windows

### __4.1 Basic Session Window__

Group events separated by inactivity timeout:

```sql
-- Identify device activity sessions (10-second inactivity timeout)
SELECT
    deviceId,
    location,
    COUNT(*) AS eventsInSession,
    AVG(temperature) AS avgTemp,
    MIN(timestamp) AS sessionStart,
    MAX(timestamp) AS sessionEnd,
    DATEDIFF(second, MIN(timestamp), MAX(timestamp)) AS sessionDurationSeconds,
    System.Timestamp() AS sessionWindowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    SessionWindow(second, 10);  -- 10-second timeout
```

__Window Behavior:__
- Window closes after 10 seconds of no events from device
- Session duration varies based on event frequency
- Ideal for user activity or device usage patterns

### __4.2 User Activity Sessions__

Track device usage patterns:

```sql
-- Analyze device operational sessions
SELECT
    deviceId,
    location,
    COUNT(*) AS operationCount,
    MIN(timestamp) AS sessionStart,
    MAX(timestamp) AS sessionEnd,
    DATEDIFF(minute, MIN(timestamp), MAX(timestamp)) AS sessionDurationMinutes,
    AVG(temperature) AS avgSessionTemp,
    MAX(temperature) AS peakSessionTemp,
    -- Categorize session length
    CASE
        WHEN DATEDIFF(minute, MIN(timestamp), MAX(timestamp)) < 5 THEN 'Short'
        WHEN DATEDIFF(minute, MIN(timestamp), MAX(timestamp)) < 30 THEN 'Medium'
        ELSE 'Long'
    END AS sessionLength,
    System.Timestamp() AS sessionEnd
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    status != 'offline'
GROUP BY
    deviceId,
    location,
    SessionWindow(minute, 5, 60);  -- 5-min timeout, 60-min max duration
```

### __4.3 Equipment Usage Analysis__

Understand operational patterns:

```sql
-- Equipment usage patterns with session windows
SELECT
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1) AS building,
    COUNT(DISTINCT deviceId) AS activeDevicesInSession,
    AVG(DATEDIFF(minute, MIN(timestamp), MAX(timestamp))) AS avgSessionDuration,
    COUNT(*) AS totalOperations,
    MIN(timestamp) AS periodStart,
    MAX(timestamp) AS periodEnd,
    System.Timestamp() AS analysisTime
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    eventType = 'telemetry'
    AND status = 'normal'
GROUP BY
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1),
    SessionWindow(minute, 10, 120);  -- 10-min timeout, 2-hour max
```

## 🔍 Step 5: Advanced Windowing Patterns

### __5.1 Combining Multiple Window Types__

Use different windows for different analyses:

```sql
-- Real-time alerts (Sliding) + Trend analysis (Hopping)
-- Alert output
SELECT
    'RealTimeAlert' AS outputType,
    deviceId,
    AVG(temperature) AS avgTemp,
    System.Timestamp() AS alertTime
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    SlidingWindow(minute, 5)
HAVING
    AVG(temperature) > 85;

-- Trend output
SELECT
    'TrendAnalysis' AS outputType,
    deviceId,
    AVG(temperature) AS movingAvgTemp,
    STDEV(temperature) AS tempVariability,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    HoppingWindow(minute, 30, 10);
```

### __5.2 Nested Windowing__

Windows within windows for complex analysis:

```sql
-- Calculate hourly max of 5-minute averages
WITH FiveMinuteAverages AS (
    SELECT
        deviceId,
        AVG(temperature) AS avgTemp,
        System.Timestamp() AS windowEnd
    FROM
        EventHubInput TIMESTAMP BY timestamp
    GROUP BY
        deviceId,
        TumblingWindow(minute, 5)
)
SELECT
    deviceId,
    MAX(avgTemp) AS maxOf5MinAverages,
    AVG(avgTemp) AS avgOf5MinAverages,
    COUNT(*) AS numberOfFiveMinWindows,
    System.Timestamp() AS hourlyWindowEnd
INTO
    SqlOutput
FROM
    FiveMinuteAverages TIMESTAMP BY windowEnd
GROUP BY
    deviceId,
    TumblingWindow(hour, 1);
```

### __5.3 Window Size Optimization__

Choose optimal window sizes based on data characteristics:

```sql
-- Multi-resolution analysis
-- High frequency (1-minute windows)
SELECT
    '1min' AS resolution,
    deviceId,
    AVG(temperature) AS avgTemp,
    System.Timestamp() AS windowEnd
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    TumblingWindow(minute, 1);

-- Medium frequency (15-minute windows)
SELECT
    '15min' AS resolution,
    deviceId,
    AVG(temperature) AS avgTemp,
    STDEV(temperature) AS tempStdDev,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    TumblingWindow(minute, 15);

-- Low frequency (1-hour windows)
SELECT
    '1hour' AS resolution,
    deviceId,
    location,
    AVG(temperature) AS avgTemp,
    MIN(temperature) AS minTemp,
    MAX(temperature) AS maxTemp,
    COUNT(*) AS eventCount,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    TumblingWindow(hour, 1);
```

## 🧪 Step 6: Testing and Deployment

### __6.1 Deploy Windowing Query__

```powershell
# Example: Deploy hopping window moving average query
$query = @"
-- Moving average temperature monitoring
SELECT
    deviceId,
    location,
    AVG(temperature) AS movingAvgTemp,
    MIN(temperature) AS minTemp,
    MAX(temperature) AS maxTemp,
    COUNT(*) AS sampleCount,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    HoppingWindow(minute, 15, 5);
"@

$query | Out-File -FilePath "windowing-query.sql" -Encoding UTF8

# Stop job
az stream-analytics job stop --name $env:STREAM_JOB --resource-group $env:STREAM_RG

# Update transformation
az stream-analytics transformation update `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "Transformation" `
    --saql @windowing-query.sql

# Start job
az stream-analytics job start `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --output-start-mode JobStartTime
```

### __6.2 Validate Window Output__

```powershell
# Query to check windowed results
$validationQuery = @"
SELECT TOP 20
    deviceId,
    location,
    windowEnd,
    movingAvgTemp,
    sampleCount,
    DATEDIFF(minute, LAG(windowEnd) OVER (PARTITION BY deviceId ORDER BY windowEnd), windowEnd) AS minutesBetweenWindows
FROM SensorReadings
ORDER BY deviceId, windowEnd DESC;
"@

Invoke-Sqlcmd -ConnectionString $connectionString -Query $validationQuery | Format-Table
```

## 🎓 Key Concepts Learned

### __Window Selection Guide__

| Requirement | Recommended Window |
|-------------|-------------------|
| Fixed-interval reports | Tumbling |
| Moving averages | Hopping |
| Real-time alerts | Sliding |
| User/device sessions | Session |
| Trend detection | Hopping |
| Anomaly detection | Sliding |

### __Best Practices__

- __Tumbling__: Use for non-overlapping batch processing
- __Hopping__: Choose hop size < window size for overlap
- __Sliding__: Use sparingly (compute-intensive)
- __Session__: Set timeout based on expected inactivity
- __Performance__: Larger windows = fewer computations = better performance

### __Common Patterns__

- __Dashboard Metrics__: Tumbling windows (1, 5, 15 min)
- __Trend Analysis__: Hopping windows (15-60 min window, 5-15 min hop)
- __Alerting__: Sliding windows (1-5 min)
- __Usage Analytics__: Session windows (5-30 min timeout)

## 🚀 Next Steps

You've mastered temporal windowing! Continue to:

__[Tutorial 06: Joins and Temporal Operations →](06-joins-temporal.md)__

In the next tutorial, you'll learn:

- Stream-to-stream joins
- Stream-to-reference data joins
- Temporal joins with time constraints
- Self-joins for pattern detection

## 📚 Additional Resources

- [Window Functions Overview](https://docs.microsoft.com/stream-analytics-query/windowing-azure-stream-analytics)
- [Tumbling Window](https://docs.microsoft.com/stream-analytics-query/tumbling-window-azure-stream-analytics)
- [Hopping Window](https://docs.microsoft.com/stream-analytics-query/hopping-window-azure-stream-analytics)
- [Sliding Window](https://docs.microsoft.com/stream-analytics-query/sliding-window-azure-stream-analytics)
- [Session Window](https://docs.microsoft.com/stream-analytics-query/session-window-azure-stream-analytics)

---

__Tutorial Progress:__ 5 of 11 complete | __Next:__ [Joins and Temporal Operations](06-joins-temporal.md)

*Last Updated: January 2025*
