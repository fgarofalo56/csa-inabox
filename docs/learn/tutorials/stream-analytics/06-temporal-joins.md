---
title: "Tutorial 6: Joins and Temporal Operations"
description: "__Master stream joins and temporal operations for correlating events across time. Learn stream-to-stream joins, reference data enrichment, and temporal pattern detection.__"
tags:
  - tutorials
  - stream-analytics
---
# 🔗 Tutorial 6: Joins and Temporal Operations

![Tutorial](https://img.shields.io/badge/Tutorial-06_Joins_Temporal-blue)
![Duration](https://img.shields.io/badge/Duration-35_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-orange)

__Master stream joins and temporal operations for correlating events across time. Learn stream-to-stream joins, reference data enrichment, and temporal pattern detection.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Perform stream-to-stream joins__ with temporal constraints
- ✅ __Enrich streams with reference data__ from static sources
- ✅ __Implement self-joins__ for pattern detection
- ✅ __Use temporal functions__ (LAG, ISFIRST, LAST)
- ✅ __Detect event sequences__ and correlations
- ✅ __Handle time-based joins__ efficiently

## ⏱️ Time Estimate: 35 minutes

- __Reference Data Joins__: 10 minutes
- __Stream-to-Stream Joins__: 15 minutes
- __Temporal Operations__: 10 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 05: Windowing Functions](05-windowing-functions.md)
- [x] Understanding of SQL JOIN operations
- [x] Multiple event streams or reference data available

## 📊 Step 1: Reference Data Joins

### __1.1 Create Reference Data__

Upload device metadata to Blob Storage:

```powershell
# Create device reference data CSV
$deviceMetadata = @"
deviceId,deviceType,manufacturer,installDate,location,maintenanceSchedule
sensor-001,Temperature,Honeywell,2024-01-15,Building-A/Floor-1,Quarterly
sensor-002,Humidity,Siemens,2024-01-20,Building-A/Floor-1,Monthly
sensor-003,Pressure,Bosch,2024-02-01,Building-A/Floor-2,Quarterly
sensor-004,Temperature,Honeywell,2024-02-10,Building-B/Floor-1,Quarterly
sensor-005,Vibration,SKF,2024-03-01,Building-B/Floor-2,Weekly
sensor-006,Temperature,Honeywell,2024-03-15,Building-C/Floor-1,Monthly
sensor-007,Humidity,Siemens,2024-03-20,Building-C/Floor-1,Quarterly
sensor-008,Temperature,Honeywell,2024-04-01,Building-C/Floor-2,Monthly
sensor-009,Vibration,SKF,2024-04-10,Building-A/Floor-2,Weekly
"@

# Upload to Blob Storage
$deviceMetadata | Out-File -FilePath "device-metadata.csv" -Encoding UTF8

az storage blob upload `
    --account-name $env:STREAM_SA `
    --account-key $env:STREAM_SA_KEY `
    --container-name "reference-data" `
    --name "devices/device-metadata.csv" `
    --file "device-metadata.csv" `
    --overwrite
```

### __1.2 Configure Reference Data Input__

```powershell
# Create reference data input configuration
$refDataConfig = @{
    properties = @{
        type = "Reference"
        datasource = @{
            type = "Microsoft.Storage/Blob"
            properties = @{
                storageAccounts = @(
                    @{
                        accountName = $env:STREAM_SA
                        accountKey = $env:STREAM_SA_KEY
                    }
                )
                container = "reference-data"
                pathPattern = "devices/device-metadata.csv"
                dateFormat = "yyyy-MM-dd"
                timeFormat = "HH"
            }
        }
        serialization = @{
            type = "Csv"
            properties = @{
                fieldDelimiter = ","
                encoding = "UTF8"
            }
        }
    }
} | ConvertTo-Json -Depth 10 | Out-File -FilePath "refdata-input.json" -Encoding UTF8

# Create reference data input
az stream-analytics input create `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "DeviceMetadata" `
    --properties @refdata-input.json
```

### __1.3 Join Stream with Reference Data__

Enrich telemetry with device metadata:

```sql
-- Enrich sensor data with device metadata
SELECT
    e.deviceId,
    e.timestamp,
    e.temperature,
    e.humidity,
    e.vibration,
    e.status,
    -- Reference data fields
    r.deviceType,
    r.manufacturer,
    r.installDate,
    r.maintenanceSchedule,
    -- Calculated fields
    DATEDIFF(day, CAST(r.installDate AS datetime), CAST(e.timestamp AS datetime)) AS daysInOperation,
    CASE
        WHEN r.maintenanceSchedule = 'Weekly' AND DATEDIFF(day, CAST(r.installDate AS datetime), CAST(e.timestamp AS datetime)) % 7 = 0 THEN 'Due'
        WHEN r.maintenanceSchedule = 'Monthly' AND DATEPART(day, e.timestamp) = 1 THEN 'Due'
        WHEN r.maintenanceSchedule = 'Quarterly' AND DATEPART(day, e.timestamp) = 1 AND DATEPART(month, e.timestamp) IN (1,4,7,10) THEN 'Due'
        ELSE 'Not Due'
    END AS maintenanceStatus
INTO
    SqlOutput
FROM
    EventHubInput e TIMESTAMP BY timestamp
LEFT OUTER JOIN
    DeviceMetadata r
ON
    e.deviceId = r.deviceId;
```

## 🔄 Step 2: Stream-to-Stream Joins

### __2.1 Self-Join for Pattern Detection__

Detect consecutive anomalies from same device:

```sql
-- Detect consecutive temperature spikes (within 5 minutes)
SELECT
    t1.deviceId,
    t1.location,
    t1.timestamp AS firstSpikeTime,
    t1.temperature AS firstSpikeTemp,
    t2.timestamp AS secondSpikeTime,
    t2.temperature AS secondSpikeTemp,
    DATEDIFF(second, t1.timestamp, t2.timestamp) AS secondsBetweenSpikes,
    'Consecutive Spikes Detected' AS alertType
INTO
    BlobOutput
FROM
    EventHubInput t1 TIMESTAMP BY timestamp
JOIN
    EventHubInput t2 TIMESTAMP BY timestamp
ON
    t1.deviceId = t2.deviceId
    AND DATEDIFF(second, t1, t2) BETWEEN 1 AND 300  -- 1 second to 5 minutes
WHERE
    t1.temperature > 85
    AND t2.temperature > 85
    AND t1.timestamp != t2.timestamp;
```

### __2.2 Cross-Device Correlation__

Find devices in same location with correlated issues:

```sql
-- Detect multiple devices in same building with high temperature
SELECT
    d1.deviceId AS device1,
    d2.deviceId AS device2,
    d1.location,
    d1.temperature AS temp1,
    d2.temperature AS temp2,
    AVG(d1.temperature + d2.temperature) / 2 AS avgTemperature,
    'Multiple Devices High Temp' AS alertType,
    System.Timestamp() AS detectionTime
INTO
    BlobOutput
FROM
    EventHubInput d1 TIMESTAMP BY timestamp
JOIN
    EventHubInput d2 TIMESTAMP BY timestamp
ON
    SUBSTRING(d1.location, 1, CHARINDEX('/', d1.location)) = SUBSTRING(d2.location, 1, CHARINDEX('/', d2.location))
    AND d1.deviceId < d2.deviceId  -- Avoid duplicate pairs
    AND DATEDIFF(second, d1, d2) BETWEEN -30 AND 30  -- Within 30 seconds
WHERE
    d1.temperature > 80
    AND d2.temperature > 80;
```

### __2.3 Event Sequence Detection__

Identify specific event sequences:

```sql
-- Detect: Normal → Warning → Critical sequence within 10 minutes
WITH StatusEvents AS (
    SELECT
        deviceId,
        timestamp,
        status,
        LAG(status) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS previousStatus,
        LAG(status, 2) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS twoPreviousStatus
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    timestamp AS criticalTime,
    'Escalating Failure Pattern' AS alertType,
    'Normal → Warning → Critical' AS sequence
INTO
    BlobOutput
FROM
    StatusEvents
WHERE
    twoPreviousStatus = 'normal'
    AND previousStatus = 'warning'
    AND status = 'critical';
```

## ⏰ Step 3: Temporal Functions

### __3.1 LAG Function for Comparison__

Compare current event with previous events:

```sql
-- Calculate temperature change rate
SELECT
    deviceId,
    location,
    timestamp,
    temperature AS currentTemp,
    LAG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)) AS previousTemp,
    temperature - LAG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)) AS tempChange,
    DATEDIFF(second, LAG(timestamp) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)), timestamp) AS secondsSincePrevious,
    -- Calculate rate of change (degrees per minute)
    CASE
        WHEN LAG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)) IS NOT NULL
        THEN (temperature - LAG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5))) /
             (DATEDIFF(second, LAG(timestamp) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)), timestamp) / 60.0)
        ELSE NULL
    END AS tempChangeRatePerMinute,
    -- Alert on rapid changes
    CASE
        WHEN ABS((temperature - LAG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5))) /
                 (DATEDIFF(second, LAG(timestamp) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)), timestamp) / 60.0)) > 5
        THEN 'Rapid Temperature Change'
        ELSE 'Normal'
    END AS changeAlert
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __3.2 ISFIRST for Initialization__

Identify first event in a window:

```sql
-- Track session start and metrics
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    ISFIRST(minute, 10) OVER (PARTITION BY deviceId) AS isSessionStart,
    CASE
        WHEN ISFIRST(minute, 10) OVER (PARTITION BY deviceId) = 1
        THEN temperature
        ELSE NULL
    END AS initialTemperature,
    COUNT(*) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 10)) AS eventsInWindow
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __3.3 LAST for Final Values__

Capture last value in a sequence:

```sql
-- Get final status before state change
WITH StatusChanges AS (
    SELECT
        deviceId,
        timestamp,
        status,
        LAG(status) OVER (PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS previousStatus
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    timestamp AS changeTime,
    previousStatus AS oldStatus,
    status AS newStatus,
    DATEDIFF(second,
        LAG(timestamp) OVER (PARTITION BY deviceId LIMIT DURATION(hour, 1)),
        timestamp
    ) AS secondsInPreviousState
INTO
    SqlOutput
FROM
    StatusChanges
WHERE
    status != previousStatus
    AND previousStatus IS NOT NULL;
```

## 🎯 Step 4: Advanced Join Patterns

### __4.1 Multiple Stream Join__

Correlate data from multiple input streams:

```sql
-- Assuming second input stream for environmental data
SELECT
    s.deviceId,
    s.timestamp,
    s.temperature AS deviceTemp,
    e.roomTemperature,
    e.outsideTemperature,
    s.temperature - e.roomTemperature AS tempDifferential,
    CASE
        WHEN s.temperature > e.roomTemperature + 10 THEN 'Device Overheating'
        WHEN s.temperature < e.roomTemperature - 5 THEN 'Device Too Cold'
        ELSE 'Normal'
    END AS thermalStatus
INTO
    SqlOutput
FROM
    EventHubInput s TIMESTAMP BY timestamp
JOIN
    EnvironmentalInput e TIMESTAMP BY timestamp
ON
    s.location = e.location
    AND DATEDIFF(second, s, e) BETWEEN -10 AND 10;
```

### __4.2 Temporal Join with Aggregation__

Join windowed aggregations:

```sql
-- Join 5-minute device averages with hourly building averages
WITH DeviceAverages AS (
    SELECT
        deviceId,
        location,
        AVG(temperature) AS avgDeviceTemp,
        System.Timestamp() AS windowEnd
    FROM
        EventHubInput TIMESTAMP BY timestamp
    GROUP BY
        deviceId,
        location,
        TumblingWindow(minute, 5)
),
BuildingAverages AS (
    SELECT
        SUBSTRING(location, 1, CHARINDEX('/', location) - 1) AS building,
        AVG(temperature) AS avgBuildingTemp,
        System.Timestamp() AS windowEnd
    FROM
        EventHubInput TIMESTAMP BY timestamp
    GROUP BY
        SUBSTRING(location, 1, CHARINDEX('/', location) - 1),
        TumblingWindow(hour, 1)
)
SELECT
    d.deviceId,
    d.location,
    d.avgDeviceTemp,
    b.avgBuildingTemp,
    d.avgDeviceTemp - b.avgBuildingTemp AS tempDifferenceFromBuilding,
    CASE
        WHEN d.avgDeviceTemp > b.avgBuildingTemp + 15 THEN 'Outlier High'
        WHEN d.avgDeviceTemp < b.avgBuildingTemp - 15 THEN 'Outlier Low'
        ELSE 'Normal Range'
    END AS outlierStatus
INTO
    SqlOutput
FROM
    DeviceAverages d TIMESTAMP BY windowEnd
LEFT OUTER JOIN
    BuildingAverages b TIMESTAMP BY windowEnd
ON
    SUBSTRING(d.location, 1, CHARINDEX('/', d.location) - 1) = b.building
    AND DATEDIFF(hour, b, d) BETWEEN 0 AND 1;
```

### __4.3 Geospatial-Temporal Join__

Join based on location proximity and time:

```sql
-- Find devices in same area experiencing issues simultaneously
SELECT
    d1.deviceId AS device1,
    d2.deviceId AS device2,
    d1.location AS location1,
    d2.location AS location2,
    d1.status AS status1,
    d2.status AS status2,
    'Localized Issue' AS alertType,
    System.Timestamp() AS detectionTime
INTO
    BlobOutput
FROM
    EventHubInput d1 TIMESTAMP BY timestamp
JOIN
    EventHubInput d2 TIMESTAMP BY timestamp
ON
    d1.deviceId != d2.deviceId
    AND SUBSTRING(d1.location, 1, CHARINDEX('/Floor', d1.location)) =
        SUBSTRING(d2.location, 1, CHARINDEX('/Floor', d2.location))
    AND DATEDIFF(second, d1, d2) BETWEEN -60 AND 60
WHERE
    d1.status IN ('warning', 'critical')
    AND d2.status IN ('warning', 'critical');
```

## 🧪 Step 5: Testing Join Queries

### __5.1 Deploy Join Query__

```powershell
$joinQuery = @"
-- Stream enrichment with reference data and anomaly correlation
SELECT
    e.deviceId,
    e.timestamp,
    e.temperature,
    e.humidity,
    e.status,
    r.deviceType,
    r.manufacturer,
    r.maintenanceSchedule,
    DATEDIFF(day, CAST(r.installDate AS datetime), CAST(e.timestamp AS datetime)) AS daysInOperation
INTO
    SqlOutput
FROM
    EventHubInput e TIMESTAMP BY timestamp
LEFT OUTER JOIN
    DeviceMetadata r
ON
    e.deviceId = r.deviceId;
"@

$joinQuery | Out-File -FilePath "join-query.sql" -Encoding UTF8

# Update job
az stream-analytics job stop --name $env:STREAM_JOB --resource-group $env:STREAM_RG
az stream-analytics transformation update --job-name $env:STREAM_JOB --resource-group $env:STREAM_RG --name "Transformation" --saql @join-query.sql
az stream-analytics job start --job-name $env:STREAM_JOB --resource-group $env:STREAM_RG --output-start-mode JobStartTime
```

### __5.2 Validate Joined Data__

```powershell
$validationQuery = @"
SELECT TOP 20
    deviceId,
    timestamp,
    temperature,
    deviceType,
    manufacturer,
    daysInOperation
FROM SensorReadings
WHERE deviceType IS NOT NULL
ORDER BY timestamp DESC;
"@

Invoke-Sqlcmd -ConnectionString $connectionString -Query $validationQuery | Format-Table
```

## 🎓 Key Concepts Learned

### __Join Types__

- __INNER JOIN__: Only matching records from both streams
- __LEFT OUTER JOIN__: All records from left stream, matched from right
- __Temporal Constraints__: DATEDIFF limits for time-bounded joins
- __Self-Join__: Join stream with itself for pattern detection

### __Temporal Functions__

- __LAG__: Access previous event values
- __ISFIRST__: Detect first event in window
- __LAST__: Get final value in sequence
- __DATEDIFF__: Calculate time differences

### __Best Practices__

- Always use TIMESTAMP BY for both join inputs
- Add DATEDIFF constraints to limit join window
- Use appropriate join types (INNER vs OUTER)
- Partition by deviceId for device-specific patterns
- Test joins with sample data before production

## 🚀 Next Steps

You've mastered joins and temporal operations! Continue to:

__[Tutorial 07: Anomaly Detection →](07-anomaly-detection.md)__

In the next tutorial, you'll learn:

- Built-in ML anomaly detection functions
- AnomalyDetection_SpikeAndDip
- AnomalyDetection_ChangePoint
- Custom anomaly detection logic

## 📚 Additional Resources

- [JOIN in Stream Analytics](https://docs.microsoft.com/stream-analytics-query/join-azure-stream-analytics)
- [Reference Data Joins](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-use-reference-data)
- [Temporal Functions](https://docs.microsoft.com/stream-analytics-query/time-management-azure-stream-analytics)
- [LAG Function](https://docs.microsoft.com/stream-analytics-query/lag-azure-stream-analytics)

---

__Tutorial Progress:__ 6 of 11 complete | __Next:__ [Anomaly Detection](07-anomaly-detection.md)

*Last Updated: January 2025*
