---
title: "Data Explorer Pools - Azure Synapse Analytics"
description: "High-performance analytics engine optimized for time-series data, log analytics, and IoT telemetry using Kusto Query Language (KQL)."
tags:
  - services
  - synapse
  - data-explorer-pools
---
# 📊 Data Explorer Pools - Azure Synapse Analytics

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Specialty](https://img.shields.io/badge/Specialty-Time%20Series-orange?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

High-performance analytics engine optimized for time-series data, log analytics, and IoT telemetry using Kusto Query Language (KQL).

---

## 🌟 Overview

Azure Synapse Data Explorer Pools bring the power of Azure Data Explorer (Kusto) into the Synapse workspace, providing fast analytics on streaming and batch time-series data. Optimized for log analytics, IoT telemetry, and real-time monitoring scenarios.

### 🔥 Key Features

- __Sub-Second Queries__: Lightning-fast queries on billions of records
- __Time-Series Optimized__: Purpose-built for time-stamped data
- __KQL (Kusto Query Language)__: Powerful query language for log analytics
- __Streaming Ingestion__: Real-time data ingestion from Event Hubs, IoT Hub
- __Native Time Windows__: Built-in time bucketing and windowing functions
- __Columnar Storage__: Extreme compression for time-series data

---

## 🎯 Primary Use Cases

### 1. Log Analytics

```kql
// Analyze application logs for errors
ApplicationLogs
| where Timestamp > ago(1h)
| where Level == "Error"
| summarize ErrorCount = count() by bin(Timestamp, 5m), Component
| render timechart
```

### 2. IoT Telemetry Analysis

```kql
// Monitor IoT device metrics
IoTTelemetry
| where Timestamp between (datetime(2024-01-01) .. datetime(2024-01-31))
| where DeviceType == "TemperatureSensor"
| summarize
    AvgTemp = avg(Temperature),
    MaxTemp = max(Temperature),
    MinTemp = min(Temperature)
    by DeviceId, bin(Timestamp, 1h)
| render timechart with (title="Temperature Trends by Device")
```

### 3. Security Analytics

```kql
// Detect suspicious login patterns
SecurityEvents
| where EventType == "Login"
| where Timestamp > ago(24h)
| summarize
    LoginCount = count(),
    UniqueIPs = dcount(IPAddress)
    by UserAccount, bin(Timestamp, 1h)
| where LoginCount > 10 or UniqueIPs > 5
| project Timestamp, UserAccount, LoginCount, UniqueIPs, Severity = "High"
```

---

## 📊 KQL Query Patterns

### Time-Series Aggregations

```kql
// Hourly sales aggregation
SalesData
| where Timestamp > ago(30d)
| summarize
    TotalSales = sum(Amount),
    TransactionCount = count(),
    AvgTransactionValue = avg(Amount)
    by bin(Timestamp, 1h), Region
| render timechart
```

### Anomaly Detection

```kql
// Detect anomalies using built-in ML
PerformanceMetrics
| where Timestamp > ago(7d)
| make-series ActualValue = avg(ResponseTime)
    on Timestamp
    step 5m
    by ServiceName
| extend Anomalies = series_decompose_anomalies(ActualValue)
| mv-expand Timestamp, ActualValue, Anomalies
| where Anomalies != 0
| project Timestamp, ServiceName, ActualValue, AnomalyScore = Anomalies
```

### Joining Time-Series Data

```kql
// Correlate metrics from different sources
let CPUData = PerformanceMetrics
| where MetricName == "CPU"
| project Timestamp, CPU = MetricValue;

let MemoryData = PerformanceMetrics
| where MetricName == "Memory"
| project Timestamp, Memory = MetricValue;

CPUData
| join kind=inner (MemoryData) on Timestamp
| where CPU > 80 and Memory > 80
| project Timestamp, CPU, Memory
```

---

## 🔗 Integration with Synapse

### Query from Serverless SQL

```sql
-- Query Data Explorer from Serverless SQL Pool
SELECT *
FROM OPENROWSET(
    PROVIDER = 'KustoProvider',
    DATASOURCE = 'https://synapse-de-pool.region.kusto.windows.net',
    DATABASE = 'LogAnalytics',
    OBJECT = 'ApplicationLogs'
) AS Logs
WHERE EventTimestamp > DATEADD(hour, -1, GETDATE())
```

### Access from Spark

```python
# Read Data Explorer data in Spark
df = spark.read \
    .format("com.microsoft.kusto.spark.synapse.datasource") \
    .option("kustoCluster", "https://synapse-de-pool.region.kusto.windows.net") \
    .option("kustoDatabase", "LogAnalytics") \
    .option("kustoQuery", "ApplicationLogs | where Timestamp > ago(1h)") \
    .load()

df.show()
```

---

## 📚 Related Resources

### 🎓 __Learning Resources__

- [__KQL Quick Reference__](../../../../reference/kql-reference.md)
- [__Data Explorer Best Practices__](../../../../05-best-practices/service-specific/synapse/data-explorer-best-practices.md)
- [__Time-Series Analytics Patterns__](../../../../03-architecture-patterns/streaming-architectures/time-series-analytics.md)

---

*Last Updated: 2025-01-28*
*Engine: Azure Data Explorer (Kusto)*
*Documentation Status: Complete*
