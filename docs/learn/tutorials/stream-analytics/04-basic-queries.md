# 📊 Tutorial 4: Basic Query Development

![Tutorial](https://img.shields.io/badge/Tutorial-04_Basic_Queries-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Master fundamental Stream Analytics Query Language (SAQL) operations including SELECT projections, WHERE filtering, aggregations, and GROUP BY operations for real-time data transformation.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Write SELECT statements__ to project and transform streaming data
- ✅ __Apply WHERE clauses__ for conditional filtering
- ✅ __Perform aggregations__ (AVG, MIN, MAX, COUNT, SUM)
- ✅ __Use GROUP BY__ for data summarization
- ✅ __Handle data types__ and perform conversions
- ✅ __Test queries__ with sample data before deploying

## ⏱️ Time Estimate: 30 minutes

- __SELECT & WHERE Queries__: 10 minutes
- __Aggregation Queries__: 10 minutes
- __Advanced Filtering__: 10 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 03: Job Creation](03-job-creation.md)
- [x] Stream Analytics job running
- [x] Data flowing from Event Hub to outputs
- [x] Basic SQL knowledge

## 📊 Step 1: SELECT Statement Fundamentals

### __1.1 Simple Projection__

Select specific fields from incoming stream:

```sql
-- Select only essential fields
SELECT
    deviceId,
    timestamp,
    temperature,
    humidity
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __1.2 Column Aliasing__

Rename columns for clarity:

```sql
-- Rename columns with meaningful aliases
SELECT
    deviceId AS SensorID,
    location AS DeviceLocation,
    timestamp AS ReadingTime,
    temperature AS TempFahrenheit,
    humidity AS HumidityPercent,
    System.Timestamp() AS ProcessedAt
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __1.3 Calculated Fields__

Create derived columns with expressions:

```sql
-- Add calculated fields
SELECT
    deviceId,
    temperature,
    humidity,
    -- Convert Fahrenheit to Celsius
    ROUND((temperature - 32) * 5 / 9, 2) AS temperatureCelsius,
    -- Calculate heat index
    ROUND(temperature + (0.5 * humidity), 2) AS heatIndex,
    -- Categorize temperature
    CASE
        WHEN temperature < 60 THEN 'Cold'
        WHEN temperature BETWEEN 60 AND 75 THEN 'Comfortable'
        WHEN temperature > 75 THEN 'Hot'
        ELSE 'Unknown'
    END AS temperatureCategory
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

## 🔍 Step 2: WHERE Clause Filtering

### __2.1 Simple Filters__

Filter events based on conditions:

```sql
-- Only process events with temperature above 75°F
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    'High Temperature Alert' AS alertType
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    temperature > 75;
```

### __2.2 Multiple Conditions__

Combine multiple filter criteria:

```sql
-- Filter for critical conditions
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    vibration,
    status
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    (temperature > 80 OR humidity < 30)
    AND status != 'offline'
    AND vibration > 1.0;
```

### __2.3 String Filtering__

Filter based on text patterns:

```sql
-- Filter devices by location
SELECT
    deviceId,
    location,
    temperature,
    humidity
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    location LIKE 'Building-A%'
    OR deviceId IN ('sensor-001', 'sensor-002', 'sensor-003');
```

### __2.4 NULL Handling__

Manage missing or null values:

```sql
-- Handle NULL values appropriately
SELECT
    deviceId,
    COALESCE(location, 'Unknown Location') AS location,
    COALESCE(temperature, 0.0) AS temperature,
    COALESCE(humidity, 0.0) AS humidity,
    CASE
        WHEN temperature IS NULL THEN 'Missing Data'
        ELSE status
    END AS deviceStatus
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    temperature IS NOT NULL;  -- Exclude records with NULL temperature
```

## 📈 Step 3: Aggregation Functions

### __3.1 Basic Aggregations__

Calculate summary statistics:

```sql
-- Calculate basic statistics across all devices
SELECT
    COUNT(*) AS totalEvents,
    AVG(temperature) AS avgTemperature,
    MIN(temperature) AS minTemperature,
    MAX(temperature) AS maxTemperature,
    AVG(humidity) AS avgHumidity,
    AVG(vibration) AS avgVibration,
    System.Timestamp() AS windowEnd
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    TumblingWindow(minute, 1);
```

### __3.2 Grouped Aggregations__

Group data by dimensions:

```sql
-- Aggregations per device
SELECT
    deviceId,
    location,
    COUNT(*) AS eventCount,
    AVG(temperature) AS avgTemp,
    MIN(temperature) AS minTemp,
    MAX(temperature) AS maxTemp,
    STDEV(temperature) AS tempStdDev,
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

### __3.3 Advanced Aggregations with HAVING__

Filter aggregated results:

```sql
-- Find devices with high average temperature
SELECT
    deviceId,
    location,
    AVG(temperature) AS avgTemperature,
    COUNT(*) AS readingCount,
    System.Timestamp() AS windowEnd
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    TumblingWindow(minute, 5)
HAVING
    AVG(temperature) > 75
    AND COUNT(*) > 10;  -- Minimum 10 readings for statistical significance
```

## 🔢 Step 4: Data Type Operations

### __4.1 Type Conversions__

Convert between data types:

```sql
-- Demonstrate type conversions
SELECT
    deviceId,
    CAST(timestamp AS datetime) AS eventDateTime,
    CAST(temperature AS bigint) AS tempInteger,
    CAST(ROUND(humidity, 0) AS int) AS humidityInt,
    TRY_CAST(deviceId AS int) AS deviceIdNum,  -- Returns NULL if conversion fails
    CONCAT(deviceId, '-', location) AS fullIdentifier,
    SUBSTRING(location, 1, 10) AS buildingCode
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __4.2 String Operations__

Manipulate text data:

```sql
-- String manipulation examples
SELECT
    deviceId,
    location,
    -- Extract building name
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1) AS building,
    -- Convert to uppercase
    UPPER(status) AS statusUpper,
    -- String length
    LEN(location) AS locationLength,
    -- Replace text
    REPLACE(location, 'Building-', 'Bldg-') AS shortLocation,
    -- Concatenation
    CONCAT(deviceId, ' @ ', location) AS deviceInfo
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __4.3 Date/Time Operations__

Work with timestamps:

```sql
-- Date and time operations
SELECT
    deviceId,
    timestamp,
    DATEPART(hour, timestamp) AS hourOfDay,
    DATEPART(day, timestamp) AS dayOfMonth,
    DATEPART(weekday, timestamp) AS dayOfWeek,
    DATEADD(hour, -5, timestamp) AS timestampEST,  -- Convert to EST
    DATEDIFF(second, timestamp, System.Timestamp()) AS processingDelaySeconds
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

## 🎯 Step 5: Complete Query Examples

### __5.1 Temperature Monitoring Dashboard__

Create aggregated metrics for monitoring:

```sql
-- Real-time temperature monitoring dashboard
SELECT
    deviceId,
    location,
    -- Time window identifier
    System.Timestamp() AS windowEnd,
    -- Count metrics
    COUNT(*) AS totalReadings,
    -- Temperature metrics
    AVG(temperature) AS avgTemperature,
    MIN(temperature) AS minTemperature,
    MAX(temperature) AS maxTemperature,
    STDEV(temperature) AS tempStdDev,
    -- Humidity metrics
    AVG(humidity) AS avgHumidity,
    -- Status summary
    SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END) AS normalCount,
    SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) AS warningCount,
    SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS criticalCount,
    -- Alert flag
    CASE
        WHEN AVG(temperature) > 80 THEN 1
        WHEN MIN(temperature) < 55 THEN 1
        ELSE 0
    END AS alertFlag
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    TumblingWindow(minute, 5);
```

### __5.2 Anomaly Pre-Filter__

Identify potential anomalies for deeper analysis:

```sql
-- Pre-filter potential anomalies
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    vibration,
    status,
    -- Calculate deviation from baseline
    ABS(temperature - 72.0) AS tempDeviation,
    -- Categorize severity
    CASE
        WHEN vibration > 2.0 THEN 'Critical'
        WHEN vibration > 1.0 THEN 'Warning'
        WHEN temperature > 85 OR temperature < 60 THEN 'Warning'
        ELSE 'Normal'
    END AS severityLevel,
    -- Add processing metadata
    System.Timestamp() AS detectedAt
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    -- Filter for anomalous conditions
    (temperature > 85 OR temperature < 60)
    OR (humidity > 80 OR humidity < 20)
    OR vibration > 1.0
    OR status IN ('warning', 'critical');
```

### __5.3 Device Health Summary__

Track overall device health:

```sql
-- Device health summary per location
SELECT
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1) AS building,
    COUNT(DISTINCT deviceId) AS deviceCount,
    AVG(temperature) AS avgTemperature,
    AVG(humidity) AS avgHumidity,
    AVG(vibration) AS avgVibration,
    -- Calculate health score (0-100)
    CASE
        WHEN AVG(vibration) < 0.5 AND AVG(temperature) BETWEEN 68 AND 75 THEN 100
        WHEN AVG(vibration) < 1.0 AND AVG(temperature) BETWEEN 65 AND 80 THEN 75
        WHEN AVG(vibration) < 1.5 THEN 50
        ELSE 25
    END AS healthScore,
    -- Status distribution
    SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END) AS normalDevices,
    SUM(CASE WHEN status != 'normal' THEN 1 ELSE 0 END) AS issueDevices,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1),
    TumblingWindow(minute, 10);
```

## 🧪 Step 6: Testing Queries

### __6.1 Update Job with New Query__

Apply one of the advanced queries:

```powershell
# Save the temperature monitoring query
$query = @"
-- Temperature Monitoring Dashboard Query
SELECT
    deviceId,
    location,
    System.Timestamp() AS windowEnd,
    COUNT(*) AS totalReadings,
    AVG(temperature) AS avgTemperature,
    MIN(temperature) AS minTemperature,
    MAX(temperature) AS maxTemperature,
    AVG(humidity) AS avgHumidity,
    SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END) AS normalCount,
    SUM(CASE WHEN status != 'normal' THEN 1 ELSE 0 END) AS alertCount
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    TumblingWindow(minute, 5);
"@

$query | Out-File -FilePath "monitoring-query.sql" -Encoding UTF8

# Stop job
az stream-analytics job stop --name $env:STREAM_JOB --resource-group $env:STREAM_RG

# Update query
az stream-analytics transformation update `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "Transformation" `
    --saql @monitoring-query.sql

# Restart job
az stream-analytics job start `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --output-start-mode JobStartTime
```

### __6.2 Validate Query Results__

Query SQL Database to verify aggregations:

```powershell
$connectionString = "Server=tcp:$($env:STREAM_SQL_SERVER).database.windows.net,1433;Initial Catalog=$($env:STREAM_SQL_DB);User ID=$($env:STREAM_SQL_USER);Password=$($env:STREAM_SQL_PASSWORD);Encrypt=True;"

$validationQuery = @"
SELECT TOP 10
    deviceId,
    location,
    windowEnd,
    totalReadings,
    ROUND(avgTemperature, 2) AS avgTemp,
    normalCount,
    alertCount
FROM SensorReadings
ORDER BY windowEnd DESC;
"@

Invoke-Sqlcmd -ConnectionString $connectionString -Query $validationQuery | Format-Table
```

## ✅ Validation Exercises

### __Exercise 1: Filter High-Temperature Events__

Write a query to select only events where temperature exceeds 80°F:

<details>
<summary>💡 Solution</summary>

```sql
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    'High Temp Alert' AS alertType
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    temperature > 80;
```

</details>

### __Exercise 2: Calculate Moving Average__

Compute 5-minute moving average temperature per device:

<details>
<summary>💡 Solution</summary>

```sql
SELECT
    deviceId,
    AVG(temperature) AS avgTemperature,
    COUNT(*) AS sampleCount,
    System.Timestamp() AS windowEnd
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    TumblingWindow(minute, 5);
```

</details>

### __Exercise 3: Multi-Condition Filter__

Select events from Building-A with temperature > 75 OR humidity < 30:

<details>
<summary>💡 Solution</summary>

```sql
SELECT
    deviceId,
    location,
    temperature,
    humidity
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    location LIKE 'Building-A%'
    AND (temperature > 75 OR humidity < 30);
```

</details>

## 🎓 Key Concepts Learned

### __SAQL Fundamentals__

- __SELECT__: Project and transform columns
- __WHERE__: Filter events before processing
- __GROUP BY__: Aggregate data by dimensions
- __HAVING__: Filter aggregated results

### __Functions Mastered__

- __Aggregates__: AVG, MIN, MAX, COUNT, SUM, STDEV
- __String__: SUBSTRING, CONCAT, UPPER, REPLACE, LEN
- __Date/Time__: DATEPART, DATEADD, DATEDIFF
- __Conversion__: CAST, TRY_CAST, COALESCE

### __Best Practices__

- Use TIMESTAMP BY to define event time
- Filter early with WHERE to reduce processing
- Use HAVING for post-aggregation filters
- Handle NULL values explicitly
- Add meaningful column aliases

## 🚀 Next Steps

You've mastered basic SAQL queries! Continue to:

__[Tutorial 05: Windowing Functions →](05-windowing-functions.md)__

In the next tutorial, you'll learn:

- Tumbling windows for fixed-interval aggregations
- Hopping windows for overlapping analysis
- Sliding windows for continuous metrics
- Session windows for activity-based grouping

## 📚 Additional Resources

- [Stream Analytics Query Language Reference](https://docs.microsoft.com/stream-analytics-query/stream-analytics-query-language-reference)
- [Built-in Functions](https://docs.microsoft.com/stream-analytics-query/built-in-functions-azure-stream-analytics)
- [Query Patterns](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-stream-analytics-query-patterns)

---

__Tutorial Progress:__ 4 of 11 complete | __Next:__ [Windowing Functions](05-windowing-functions.md)

*Last Updated: January 2025*
