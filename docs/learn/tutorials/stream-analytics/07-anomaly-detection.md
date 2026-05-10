---
title: "Tutorial 7: Anomaly Detection"
description: "__Implement machine learning-powered anomaly detection using Stream Analytics built-in functions. Detect spikes, dips, change points, and custom anomalies in real-time streaming data.__"
tags:
  - tutorials
  - stream-analytics
---
# 🚨 Tutorial 7: Anomaly Detection

![Tutorial](https://img.shields.io/badge/Tutorial-07_Anomaly_Detection-blue)
![Duration](https://img.shields.io/badge/Duration-35_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-orange)

__Implement machine learning-powered anomaly detection using Stream Analytics built-in functions. Detect spikes, dips, change points, and custom anomalies in real-time streaming data.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Use AnomalyDetection_SpikeAndDip__ for sudden value changes
- ✅ __Implement AnomalyDetection_ChangePoint__ for trend shifts
- ✅ __Configure confidence levels__ and sensitivity parameters
- ✅ __Build custom anomaly detection__ logic with statistical methods
- ✅ __Create multi-layered detection__ strategies
- ✅ __Generate actionable alerts__ from anomalies

## ⏱️ Time Estimate: 35 minutes

- __Spike and Dip Detection__: 12 minutes
- __Change Point Detection__: 12 minutes
- __Custom Anomaly Logic__: 11 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 06: Joins and Temporal Operations](06-joins-temporal.md)
- [x] Data generator producing varied patterns
- [x] Understanding of statistical concepts (mean, standard deviation)

## 📈 Step 1: Spike and Dip Detection

### __1.1 Basic Spike Detection__

Detect sudden increases in metric values:

```sql
-- Detect temperature spikes using built-in ML function
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikes') OVER(LIMIT DURATION(minute, 10)) AS RECORD) AS spikeScore
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

__Parameters Explained:__
- __95__: Confidence level (95% confidence)
- __120__: History window size (120 events)
- __'spikes'__: Detect only spikes (can be 'dips' or 'spikesanddips')

### __1.2 Extract Anomaly Details__

Parse the anomaly detection output:

```sql
-- Extract spike detection details
WITH SpikeDetection AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikes')
            OVER(LIMIT DURATION(minute, 10)) AS RECORD) AS spikeResult
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    spikeResult.IsAnomaly AS isSpike,
    spikeResult.Score AS anomalyScore,
    spikeResult.PValue AS pValue,
    CASE
        WHEN spikeResult.IsAnomaly = 1 AND spikeResult.Score > 0.8 THEN 'Critical Spike'
        WHEN spikeResult.IsAnomaly = 1 AND spikeResult.Score > 0.5 THEN 'Warning Spike'
        WHEN spikeResult.IsAnomaly = 1 THEN 'Minor Spike'
        ELSE 'Normal'
    END AS severityLevel
INTO
    SqlOutput
FROM
    SpikeDetection
WHERE
    spikeResult.IsAnomaly = 1;  -- Only output anomalies
```

### __1.3 Detect Both Spikes and Dips__

Monitor for bidirectional anomalies:

```sql
-- Detect temperature spikes AND dips
WITH BidirectionalDetection AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        humidity,
        vibration,
        CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS tempAnomaly,
        CAST(AnomalyDetection_SpikeAndDip(humidity, 90, 100, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS humidityAnomaly,
        CAST(AnomalyDetection_SpikeAndDip(vibration, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS vibrationAnomaly
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    vibration,
    -- Temperature anomaly
    tempAnomaly.IsAnomaly AS isTempAnomaly,
    tempAnomaly.Score AS tempAnomalyScore,
    -- Humidity anomaly
    humidityAnomaly.IsAnomaly AS isHumidityAnomaly,
    humidityAnomaly.Score AS humidityAnomalyScore,
    -- Vibration anomaly
    vibrationAnomaly.IsAnomaly AS isVibrationAnomaly,
    vibrationAnomaly.Score AS vibrationAnomalyScore,
    -- Composite severity
    CASE
        WHEN (tempAnomaly.IsAnomaly + humidityAnomaly.IsAnomaly + vibrationAnomaly.IsAnomaly) >= 2 THEN 'Critical - Multiple Metrics'
        WHEN tempAnomaly.IsAnomaly = 1 OR vibrationAnomaly.IsAnomaly = 1 THEN 'High - Safety Concern'
        WHEN humidityAnomaly.IsAnomaly = 1 THEN 'Medium - Environmental'
        ELSE 'Normal'
    END AS overallSeverity,
    -- Alert message
    CONCAT(
        CASE WHEN tempAnomaly.IsAnomaly = 1 THEN 'Temperature ' ELSE '' END,
        CASE WHEN humidityAnomaly.IsAnomaly = 1 THEN 'Humidity ' ELSE '' END,
        CASE WHEN vibrationAnomaly.IsAnomaly = 1 THEN 'Vibration ' ELSE '' END,
        'Anomaly Detected'
    ) AS alertMessage
INTO
    BlobOutput
FROM
    BidirectionalDetection
WHERE
    tempAnomaly.IsAnomaly = 1
    OR humidityAnomaly.IsAnomaly = 1
    OR vibrationAnomaly.IsAnomaly = 1;
```

## 📉 Step 2: Change Point Detection

### __2.1 Basic Change Point Detection__

Identify when data patterns fundamentally shift:

```sql
-- Detect change points in temperature trends
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    CAST(AnomalyDetection_ChangePoint(temperature, 80, 120)
        OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS RECORD) AS changePoint
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

__Parameters:__
- __80__: Confidence level (80%)
- __120__: History window size

### __2.2 Extract Change Point Details__

Get detailed change point information:

```sql
-- Detailed change point analysis
WITH ChangePointAnalysis AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        CAST(AnomalyDetection_ChangePoint(temperature, 80, 120)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 2)) AS RECORD) AS changePointResult
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    changePointResult.IsAnomaly AS isChangePoint,
    changePointResult.Score AS confidenceScore,
    changePointResult.PValue AS statisticalSignificance,
    CASE
        WHEN changePointResult.IsAnomaly = 1 AND changePointResult.Score > 0.9 THEN 'Strong Trend Change'
        WHEN changePointResult.IsAnomaly = 1 AND changePointResult.Score > 0.7 THEN 'Moderate Trend Change'
        WHEN changePointResult.IsAnomaly = 1 THEN 'Weak Trend Change'
        ELSE 'Stable Trend'
    END AS trendStatus,
    -- Calculate temperature trend
    temperature - LAG(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(minute, 30)) AS recentTempChange,
    -- Alert type
    CASE
        WHEN changePointResult.IsAnomaly = 1 THEN 'Trend Change Alert'
        ELSE NULL
    END AS alertType
INTO
    SqlOutput
FROM
    ChangePointAnalysis
WHERE
    changePointResult.IsAnomaly = 1;
```

### __2.3 Multi-Metric Change Point Detection__

Monitor trend changes across multiple metrics:

```sql
-- Monitor change points in temperature, humidity, and vibration
WITH MultiMetricChangePoints AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        humidity,
        vibration,
        CAST(AnomalyDetection_ChangePoint(temperature, 80, 120)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS RECORD) AS tempCP,
        CAST(AnomalyDetection_ChangePoint(humidity, 75, 120)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS RECORD) AS humidityCP,
        CAST(AnomalyDetection_ChangePoint(vibration, 85, 120)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS RECORD) AS vibrationCP
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    -- Change point indicators
    tempCP.IsAnomaly AS tempTrendChange,
    humidityCP.IsAnomaly AS humidityTrendChange,
    vibrationCP.IsAnomaly AS vibrationTrendChange,
    -- Confidence scores
    tempCP.Score AS tempConfidence,
    humidityCP.Score AS humidityConfidence,
    vibrationCP.Score AS vibrationConfidence,
    -- Combined analysis
    CASE
        WHEN tempCP.IsAnomaly = 1 AND vibrationCP.IsAnomaly = 1 THEN 'Equipment State Change'
        WHEN tempCP.IsAnomaly = 1 AND humidityCP.IsAnomaly = 1 THEN 'Environmental Shift'
        WHEN vibrationCP.IsAnomaly = 1 THEN 'Mechanical Change'
        WHEN tempCP.IsAnomaly = 1 THEN 'Thermal Trend Shift'
        WHEN humidityCP.IsAnomaly = 1 THEN 'Humidity Pattern Change'
        ELSE 'Unknown Change'
    END AS changeCategory,
    System.Timestamp() AS detectionTime
INTO
    BlobOutput
FROM
    MultiMetricChangePoints
WHERE
    tempCP.IsAnomaly = 1
    OR humidityCP.IsAnomaly = 1
    OR vibrationCP.IsAnomaly = 1;
```

## 🔍 Step 3: Custom Anomaly Detection

### __3.1 Statistical Threshold Detection__

Implement Z-score based anomaly detection:

```sql
-- Custom Z-score anomaly detection
WITH StatisticalBaseline AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        AVG(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS avgTemp,
        STDEV(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS stdDevTemp
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    avgTemp AS baselineAverage,
    stdDevTemp AS baselineStdDev,
    -- Calculate Z-score
    CASE
        WHEN stdDevTemp > 0 THEN (temperature - avgTemp) / stdDevTemp
        ELSE 0
    END AS zScore,
    -- Classify anomaly
    CASE
        WHEN stdDevTemp > 0 AND ABS((temperature - avgTemp) / stdDevTemp) > 3 THEN 'Extreme Anomaly'
        WHEN stdDevTemp > 0 AND ABS((temperature - avgTemp) / stdDevTemp) > 2 THEN 'Moderate Anomaly'
        WHEN stdDevTemp > 0 AND ABS((temperature - avgTemp) / stdDevTemp) > 1.5 THEN 'Minor Deviation'
        ELSE 'Normal'
    END AS anomalyClassification,
    -- Anomaly flag
    CASE
        WHEN stdDevTemp > 0 AND ABS((temperature - avgTemp) / stdDevTemp) > 2 THEN 1
        ELSE 0
    END AS isAnomaly
INTO
    SqlOutput
FROM
    StatisticalBaseline
WHERE
    stdDevTemp > 0
    AND ABS((temperature - avgTemp) / stdDevTemp) > 2;
```

### __3.2 Percentile-Based Detection__

Use percentiles to identify outliers:

```sql
-- Percentile-based anomaly detection
WITH PercentileAnalysis AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY temperature)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS p05,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY temperature)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS p95,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY temperature)
            OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS median
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    median AS medianTemperature,
    p05 AS lowerBound,
    p95 AS upperBound,
    CASE
        WHEN temperature > p95 THEN 'High Outlier'
        WHEN temperature < p05 THEN 'Low Outlier'
        ELSE 'Within Range'
    END AS outlierStatus,
    CASE
        WHEN temperature > p95 THEN temperature - p95
        WHEN temperature < p05 THEN p05 - temperature
        ELSE 0
    END AS deviationFromRange
INTO
    BlobOutput
FROM
    PercentileAnalysis
WHERE
    temperature > p95 OR temperature < p05;
```

### __3.3 Rate of Change Detection__

Detect rapid changes regardless of absolute values:

```sql
-- Detect rapid rate of change
WITH RateOfChange AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        LAG(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(minute, 5)) AS prevTemp,
        LAG(timestamp) OVER(PARTITION BY deviceId LIMIT DURATION(minute, 5)) AS prevTimestamp
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    prevTemp,
    temperature - prevTemp AS absoluteChange,
    DATEDIFF(second, prevTimestamp, timestamp) AS timeDiffSeconds,
    -- Calculate rate (degrees per minute)
    CASE
        WHEN prevTemp IS NOT NULL AND DATEDIFF(second, prevTimestamp, timestamp) > 0
        THEN ((temperature - prevTemp) / (DATEDIFF(second, prevTimestamp, timestamp) / 60.0))
        ELSE 0
    END AS changeRatePerMinute,
    -- Classify change rate
    CASE
        WHEN prevTemp IS NOT NULL AND DATEDIFF(second, prevTimestamp, timestamp) > 0
             AND ABS((temperature - prevTemp) / (DATEDIFF(second, prevTimestamp, timestamp) / 60.0)) > 10
        THEN 'Extreme Rate Change'
        WHEN prevTemp IS NOT NULL AND DATEDIFF(second, prevTimestamp, timestamp) > 0
             AND ABS((temperature - prevTemp) / (DATEDIFF(second, prevTimestamp, timestamp) / 60.0)) > 5
        THEN 'High Rate Change'
        WHEN prevTemp IS NOT NULL AND DATEDIFF(second, prevTimestamp, timestamp) > 0
             AND ABS((temperature - prevTemp) / (DATEDIFF(second, prevTimestamp, timestamp) / 60.0)) > 2
        THEN 'Moderate Rate Change'
        ELSE 'Normal Rate'
    END AS rateCategory
INTO
    SqlOutput
FROM
    RateOfChange
WHERE
    prevTemp IS NOT NULL
    AND DATEDIFF(second, prevTimestamp, timestamp) > 0
    AND ABS((temperature - prevTemp) / (DATEDIFF(second, prevTimestamp, timestamp) / 60.0)) > 5;
```

## 🎯 Step 4: Multi-Layer Anomaly Detection

### __4.1 Composite Anomaly Detection__

Combine multiple detection methods:

```sql
-- Multi-layer anomaly detection combining ML and custom logic
WITH MLDetection AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        vibration,
        CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS mlTempAnomaly,
        CAST(AnomalyDetection_SpikeAndDip(vibration, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS mlVibAnomaly
    FROM
        EventHubInput TIMESTAMP BY timestamp
),
CustomDetection AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        vibration,
        AVG(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS avgTemp,
        STDEV(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) AS stdDevTemp,
        CASE
            WHEN STDEV(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1)) > 0
                 AND ABS((temperature - AVG(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1))) /
                         STDEV(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(hour, 1))) > 2
            THEN 1 ELSE 0
        END AS customTempAnomaly,
        CASE
            WHEN vibration > 1.5 THEN 1 ELSE 0
        END AS customVibAnomaly
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    m.deviceId,
    m.location,
    m.timestamp,
    m.temperature,
    m.vibration,
    -- ML detection results
    m.mlTempAnomaly.IsAnomaly AS mlTempDetection,
    m.mlTempAnomaly.Score AS mlTempScore,
    m.mlVibAnomaly.IsAnomaly AS mlVibDetection,
    m.mlVibAnomaly.Score AS mlVibScore,
    -- Custom detection results
    c.customTempAnomaly,
    c.customVibAnomaly,
    -- Composite anomaly score (0-4 scale)
    (m.mlTempAnomaly.IsAnomaly + m.mlVibAnomaly.IsAnomaly + c.customTempAnomaly + c.customVibAnomaly) AS compositeScore,
    -- Final classification
    CASE
        WHEN (m.mlTempAnomaly.IsAnomaly + m.mlVibAnomaly.IsAnomaly + c.customTempAnomaly + c.customVibAnomaly) >= 3
            THEN 'Critical - Multiple Detection Methods'
        WHEN (m.mlTempAnomaly.IsAnomaly + c.customTempAnomaly) >= 2
            THEN 'High - Temperature Anomaly Confirmed'
        WHEN (m.mlVibAnomaly.IsAnomaly + c.customVibAnomaly) >= 2
            THEN 'High - Vibration Anomaly Confirmed'
        WHEN (m.mlTempAnomaly.IsAnomaly + m.mlVibAnomaly.IsAnomaly + c.customTempAnomaly + c.customVibAnomaly) >= 2
            THEN 'Medium - Multiple Indicators'
        WHEN (m.mlTempAnomaly.IsAnomaly + m.mlVibAnomaly.IsAnomaly + c.customTempAnomaly + c.customVibAnomaly) = 1
            THEN 'Low - Single Detection Method'
        ELSE 'Normal'
    END AS severityLevel,
    System.Timestamp() AS detectionTime
INTO
    SqlOutput
FROM
    MLDetection m
JOIN
    CustomDetection c
ON
    m.deviceId = c.deviceId
    AND m.timestamp = c.timestamp
WHERE
    (m.mlTempAnomaly.IsAnomaly = 1 OR m.mlVibAnomaly.IsAnomaly = 1 OR c.customTempAnomaly = 1 OR c.customVibAnomaly = 1);
```

### __4.2 Context-Aware Anomaly Detection__

Adjust thresholds based on context:

```sql
-- Context-aware anomaly detection (time of day, location, device type)
WITH ContextualBaseline AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        DATEPART(hour, timestamp) AS hourOfDay,
        DATEPART(weekday, timestamp) AS dayOfWeek,
        -- Different baselines for different times
        CASE
            WHEN DATEPART(hour, timestamp) BETWEEN 8 AND 17 THEN AVG(temperature)
                OVER(PARTITION BY deviceId, DATEPART(hour, timestamp) LIMIT DURATION(day, 7))
            ELSE AVG(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(day, 7))
        END AS contextualAvg,
        CASE
            WHEN DATEPART(hour, timestamp) BETWEEN 8 AND 17 THEN STDEV(temperature)
                OVER(PARTITION BY deviceId, DATEPART(hour, timestamp) LIMIT DURATION(day, 7))
            ELSE STDEV(temperature) OVER(PARTITION BY deviceId LIMIT DURATION(day, 7))
        END AS contextualStdDev
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    hourOfDay,
    contextualAvg AS expectedTemperature,
    contextualStdDev AS normalVariance,
    ABS(temperature - contextualAvg) AS deviation,
    CASE
        WHEN contextualStdDev > 0 AND ABS(temperature - contextualAvg) / contextualStdDev > 3
            THEN 'Critical Anomaly'
        WHEN contextualStdDev > 0 AND ABS(temperature - contextualAvg) / contextualStdDev > 2
            THEN 'Moderate Anomaly'
        ELSE 'Normal for Time Period'
    END AS contextualStatus
INTO
    BlobOutput
FROM
    ContextualBaseline
WHERE
    contextualStdDev > 0
    AND ABS(temperature - contextualAvg) / contextualStdDev > 2;
```

## ✅ Testing and Validation

### __Deploy Anomaly Detection Query__

```powershell
$anomalyQuery = @"
-- Comprehensive anomaly detection
WITH AnomalyDetection AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        vibration,
        CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS tempAnomaly,
        CAST(AnomalyDetection_SpikeAndDip(vibration, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS vibAnomaly
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    vibration,
    tempAnomaly.IsAnomaly AS isTempAnomaly,
    tempAnomaly.Score AS tempAnomalyScore,
    vibAnomaly.IsAnomaly AS isVibAnomaly,
    vibAnomaly.Score AS vibAnomalyScore,
    CASE
        WHEN tempAnomaly.IsAnomaly = 1 AND vibAnomaly.IsAnomaly = 1 THEN 'Critical'
        WHEN tempAnomaly.IsAnomaly = 1 OR vibAnomaly.IsAnomaly = 1 THEN 'Warning'
        ELSE 'Normal'
    END AS alertLevel
INTO
    SqlOutput
FROM
    AnomalyDetection
WHERE
    tempAnomaly.IsAnomaly = 1 OR vibAnomaly.IsAnomaly = 1;
"@

$anomalyQuery | Out-File -FilePath "anomaly-detection-query.sql" -Encoding UTF8

# Update job
az stream-analytics job stop --name $env:STREAM_JOB --resource-group $env:STREAM_RG
az stream-analytics transformation update --job-name $env:STREAM_JOB --resource-group $env:STREAM_RG --name "Transformation" --saql @anomaly-detection-query.sql
az stream-analytics job start --job-name $env:STREAM_JOB --resource-group $env:STREAM_RG --output-start-mode JobStartTime
```

## 🎓 Key Concepts Learned

### __Anomaly Detection Methods__

| Method | Best For | Sensitivity |
|--------|----------|-------------|
| __SpikeAndDip__ | Sudden value changes | High |
| __ChangePoint__ | Trend shifts | Medium |
| __Z-Score__ | Statistical outliers | Configurable |
| __Percentile__ | Distribution-based detection | Medium |
| __Rate of Change__ | Rapid transitions | High |

### __Best Practices__

- Combine multiple detection methods for accuracy
- Tune confidence levels based on false positive tolerance
- Use appropriate history window sizes (100-200 events)
- Partition by deviceId for device-specific baselines
- Filter output to anomalies only to reduce noise

## 🚀 Next Steps

You've mastered anomaly detection! Continue to:

__[Tutorial 08: Power BI Integration →](08-powerbi-integration.md)__

## 📚 Additional Resources

- [Anomaly Detection in Stream Analytics](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-machine-learning-anomaly-detection)
- [AnomalyDetection_SpikeAndDip](https://docs.microsoft.com/stream-analytics-query/anomalydetection-spikeanddip-azure-stream-analytics)
- [AnomalyDetection_ChangePoint](https://docs.microsoft.com/stream-analytics-query/anomalydetection-changepoint-azure-stream-analytics)

---

__Tutorial Progress:__ 7 of 11 complete | __Next:__ [Power BI Integration](08-powerbi-integration.md)

*Last Updated: January 2025*
