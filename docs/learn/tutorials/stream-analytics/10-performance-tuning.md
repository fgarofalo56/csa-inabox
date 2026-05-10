# ⚡ Tutorial 10: Performance Tuning and Optimization

![Tutorial](https://img.shields.io/badge/Tutorial-10_Performance_Tuning-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-red)

__Optimize Stream Analytics jobs for maximum throughput, minimal latency, and cost efficiency. Learn scaling strategies, query optimization, and monitoring best practices for production workloads.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Monitor job performance__ using metrics and diagnostics
- ✅ __Optimize query patterns__ for throughput and latency
- ✅ __Scale streaming units__ appropriately for workload demands
- ✅ __Implement partitioning strategies__ for parallel processing
- ✅ __Minimize resource costs__ while maintaining SLA requirements

## ⏱️ Time Estimate: 30 minutes

- __Performance Monitoring__: 8 minutes
- __Query Optimization__: 10 minutes
- __Scaling Strategies__: 7 minutes
- __Cost Optimization__: 5 minutes

## 📋 Prerequisites

- [ ] Completed all previous tutorials (01-09)
- [ ] Running Stream Analytics job with production-like workload
- [ ] Access to Azure Monitor and Log Analytics
- [ ] Understanding of query fundamentals

## 📊 Understanding Performance Metrics

### __10.1 Key Performance Indicators__

| Metric | Target | Warning Threshold | Critical Threshold |
|--------|--------|-------------------|-------------------|
| __SU% Utilization__ | 60-80% | >80% | >95% |
| __Watermark Delay__ | <30 seconds | >1 minute | >5 minutes |
| __Input Events__ | Stable | Sudden drops | Zero events |
| __Output Events__ | Proportional to input | Backlog growth | Output failure |
| __Data Conversion Errors__ | 0 | >0.1% | >1% |
| __Runtime Errors__ | 0 | Any | Continuous |

### __10.2 Enable Diagnostic Logging__

Configure comprehensive diagnostics:

```powershell
# Enable all diagnostic categories
$diagnosticSettings = @{
    name = "stream-analytics-diagnostics"
    resourceId = (az stream-analytics job show `
        --resource-group $env:STREAM_RG `
        --name $env:STREAM_JOB `
        --query id -o tsv)
    workspaceId = (az monitor log-analytics workspace show `
        --resource-group $env:STREAM_RG `
        --workspace-name "stream-analytics-logs" `
        --query id -o tsv)
}

# Create diagnostic setting
az monitor diagnostic-settings create `
    --name $diagnosticSettings.name `
    --resource $diagnosticSettings.resourceId `
    --workspace $diagnosticSettings.workspaceId `
    --logs '[
        {"category": "Execution", "enabled": true},
        {"category": "Authoring", "enabled": true}
    ]' `
    --metrics '[
        {"category": "AllMetrics", "enabled": true}
    ]'
```

### __10.3 Real-Time Metrics Dashboard__

Create Azure Monitor dashboard:

```powershell
# Query key metrics
$jobResourceId = az stream-analytics job show `
    --resource-group $env:STREAM_RG `
    --name $env:STREAM_JOB `
    --query id -o tsv

# SU% Utilization
az monitor metrics list `
    --resource $jobResourceId `
    --metric "ResourceUtilization" `
    --start-time (Get-Date).AddHours(-1).ToString("yyyy-MM-ddTHH:mm:ss") `
    --end-time (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss") `
    --interval PT1M `
    --aggregation Average `
    --output table

# Watermark Delay
az monitor metrics list `
    --resource $jobResourceId `
    --metric "WatermarkDelay" `
    --aggregation Maximum `
    --interval PT1M `
    --output table

# Input/Output Events
az monitor metrics list `
    --resource $jobResourceId `
    --metric "InputEvents" `
    --aggregation Total `
    --interval PT5M `
    --output table
```

## 🔍 Query Optimization

### __10.4 Identify Performance Bottlenecks__

Use query execution diagnostics:

```sql
-- Add diagnostic output to track query execution
SELECT
    System.Timestamp() AS ProcessingTime,
    COUNT(*) AS EventCount,
    AVG(DATEDIFF(millisecond, EventTime, System.Timestamp())) AS ProcessingLatencyMs
INTO
    [PerformanceDiagnostics]
FROM
    [SensorInput] TIMESTAMP BY EventTime
GROUP BY
    TumblingWindow(second, 30)
```

### __10.5 Optimize JOIN Operations__

Inefficient JOIN patterns and optimizations:

```sql
-- ❌ INEFFICIENT: Cartesian product without proper constraints
SELECT
    s1.DeviceId,
    s1.Temperature,
    s2.Humidity
FROM
    [SensorStream1] s1 TIMESTAMP BY EventTime
JOIN
    [SensorStream2] s2 TIMESTAMP BY EventTime
ON
    s1.DeviceId = s2.DeviceId
    AND DATEDIFF(minute, s1, s2) BETWEEN -60 AND 60  -- Too wide!

-- ✅ OPTIMIZED: Narrow temporal window
SELECT
    s1.DeviceId,
    s1.Temperature,
    s2.Humidity
FROM
    [SensorStream1] s1 TIMESTAMP BY EventTime
JOIN
    [SensorStream2] s2 TIMESTAMP BY EventTime
ON
    s1.DeviceId = s2.DeviceId
    AND DATEDIFF(second, s1, s2) BETWEEN -5 AND 5  -- Narrow window
```

__Optimization Benefits:__
- Reduced memory footprint (smaller join window)
- Lower CPU utilization
- Faster event processing

### __10.6 Efficient Windowing Patterns__

```sql
-- ❌ INEFFICIENT: Multiple aggregations with redundant windows
SELECT DeviceId, AVG(Temperature) AS AvgTemp
INTO [Output1]
FROM [Input] TIMESTAMP BY EventTime
GROUP BY DeviceId, TumblingWindow(minute, 5);

SELECT DeviceId, MAX(Temperature) AS MaxTemp
INTO [Output2]
FROM [Input] TIMESTAMP BY EventTime
GROUP BY DeviceId, TumblingWindow(minute, 5);

-- ✅ OPTIMIZED: Single window with multiple aggregations
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp,
    MAX(Temperature) AS MaxTemp,
    MIN(Temperature) AS MinTemp,
    STDEV(Temperature) AS StdDevTemp,
    System.Timestamp() AS WindowEnd
INTO
    [CombinedOutput]
FROM
    [Input] TIMESTAMP BY EventTime
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)
```

### __10.7 Subquery Optimization__

```sql
-- ❌ INEFFICIENT: Nested subqueries
SELECT DeviceId, AvgTemp
FROM (
    SELECT DeviceId, AVG(Temperature) AS AvgTemp
    FROM [Input] TIMESTAMP BY EventTime
    GROUP BY DeviceId, TumblingWindow(minute, 5)
)
WHERE AvgTemp > 75;

-- ✅ OPTIMIZED: Use HAVING clause instead
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp,
    System.Timestamp() AS WindowEnd
INTO
    [OptimizedOutput]
FROM
    [Input] TIMESTAMP BY EventTime
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)
HAVING
    AVG(Temperature) > 75
```

### __10.8 Reduce Data Conversion Errors__

Handle data type mismatches efficiently:

```sql
-- ❌ INEFFICIENT: Causes data conversion errors
SELECT
    DeviceId,
    Temperature  -- Assumes always numeric
INTO [Output]
FROM [Input] TIMESTAMP BY EventTime;

-- ✅ OPTIMIZED: Defensive type casting with error handling
SELECT
    DeviceId,
    TRY_CAST(Temperature AS FLOAT) AS Temperature,
    CASE
        WHEN TRY_CAST(Temperature AS FLOAT) IS NULL THEN 1
        ELSE 0
    END AS ConversionError
INTO [SafeOutput]
FROM [Input] TIMESTAMP BY EventTime
WHERE TRY_CAST(Temperature AS FLOAT) IS NOT NULL  -- Filter bad data early
```

## 📈 Scaling Strategies

### __10.9 Understanding Streaming Units (SUs)__

Streaming Units represent compute capacity:

```text
1 SU = 1 MB/s throughput capacity

Scaling Tiers:
- 1-6 SUs: Small workloads (<6 MB/s)
- 6-12 SUs: Medium workloads (6-12 MB/s)
- 12-24 SUs: Large workloads (12-24 MB/s)
- 24+ SUs: Enterprise workloads (requires partitioning)
```

### __10.10 Calculate Required SUs__

Formula for SU estimation:

```powershell
# Calculate required SUs based on workload
$eventsPerSecond = 10000
$avgEventSizeKB = 2
$throughputMBps = ($eventsPerSecond * $avgEventSizeKB) / 1024

$requiredSUs = [Math]::Ceiling($throughputMBps)

Write-Host "Estimated throughput: $throughputMBps MB/s"
Write-Host "Recommended SUs: $requiredSUs"
Write-Host "Buffer for peaks (20%): $([Math]::Ceiling($requiredSUs * 1.2))"
```

### __10.11 Scale Streaming Units__

Adjust SUs based on metrics:

```powershell
# Check current SU allocation
$currentSUs = az stream-analytics job show `
    --resource-group $env:STREAM_RG `
    --name $env:STREAM_JOB `
    --query "transformation.streamingUnits" -o tsv

Write-Host "Current Streaming Units: $currentSUs"

# Scale up to handle increased load
$newSUs = 12

az stream-analytics transformation update `
    --resource-group $env:STREAM_RG `
    --job-name $env:STREAM_JOB `
    --name "Transformation" `
    --streaming-units $newSUs

Write-Host "Scaled to $newSUs SUs"
```

### __10.12 Implement Partitioning for Scalability__

Enable parallel processing with partitions:

```sql
-- Partition input by DeviceId for parallel processing
SELECT
    DeviceId,
    BuildingId,
    AVG(Temperature) AS AvgTemp,
    COUNT(*) AS EventCount,
    System.Timestamp() AS WindowEnd
INTO
    [PartitionedOutput]
FROM
    [SensorInput] TIMESTAMP BY EventTime
    PARTITION BY PartitionId  -- Enable partition-level parallelism
GROUP BY
    DeviceId,
    BuildingId,
    TumblingWindow(minute, 5)
```

__Partitioning Benefits:__
- Linear scalability across SUs
- Reduced memory per partition
- Improved throughput (can exceed 6 SUs limit with partitions)

### __10.13 Configure Compatibility Level for Performance__

```powershell
# Use latest compatibility level for performance improvements
az stream-analytics job update `
    --resource-group $env:STREAM_RG `
    --name $env:STREAM_JOB `
    --compatibility-level "1.2"  # Latest version with optimizations

# Verify compatibility level
az stream-analytics job show `
    --resource-group $env:STREAM_RG `
    --name $env:STREAM_JOB `
    --query "compatibilityLevel" -o tsv
```

## 🎯 Input/Output Optimization

### __10.14 Optimize Event Hub Configuration__

```powershell
# Ensure partition count matches parallelization needs
$targetPartitions = 16  # Match with SU count

az eventhubs eventhub update `
    --resource-group $env:STREAM_RG `
    --namespace-name $env:STREAM_EH_NAMESPACE `
    --name $env:STREAM_EH_NAME `
    --partition-count $targetPartitions

# Verify partition count
az eventhubs eventhub show `
    --resource-group $env:STREAM_RG `
    --namespace-name $env:STREAM_EH_NAMESPACE `
    --name $env:STREAM_EH_NAME `
    --query "partitionCount"
```

### __10.15 Optimize Output Batching__

Configure output batching for efficiency:

```json
// Output configuration for Azure SQL Database
{
  "type": "Microsoft.Sql/Server/Database",
  "properties": {
    "server": "your-sql-server.database.windows.net",
    "database": "streamdb",
    "user": "streamuser",
    "password": "{password}",
    "table": "SensorData",
    "batchSize": 10000,  // Optimize batch size
    "maxWriterCount": 8  // Parallel writers
  }
}
```

### __10.16 Blob Storage Partitioning__

Optimize blob output with proper partitioning:

```json
// Path pattern for efficient blob partitioning
{
  "pathPattern": "rawdata/{date}/{time}/output_{deviceId}.json",
  "dateFormat": "yyyy/MM/dd",
  "timeFormat": "HH"
}
```

## 💰 Cost Optimization

### __10.17 Calculate Job Costs__

Understand cost components:

```powershell
# Calculate monthly Stream Analytics cost
$streamingUnits = 6
$hoursPerDay = 24
$daysPerMonth = 30
$suHourlyCost = 0.111  # USD per SU-hour

$monthlyCost = $streamingUnits * $hoursPerDay * $daysPerMonth * $suHourlyCost

Write-Host "Monthly Stream Analytics Cost: `$$([Math]::Round($monthlyCost, 2))"
Write-Host "Breakdown:"
Write-Host "  - Streaming Units: $streamingUnits"
Write-Host "  - Hours per month: $($hoursPerDay * $daysPerMonth)"
Write-Host "  - SU-hours: $($streamingUnits * $hoursPerDay * $daysPerMonth)"
```

### __10.18 Cost Optimization Strategies__

```sql
-- Strategy 1: Filter data early to reduce processing
SELECT
    DeviceId,
    Temperature,
    Humidity,
    EventTime
INTO [FilteredOutput]
FROM [Input] TIMESTAMP BY EventTime
WHERE
    Temperature IS NOT NULL
    AND Temperature BETWEEN -50 AND 150  -- Filter invalid ranges early
    AND DeviceId LIKE 'PROD-%'  -- Only process production devices

-- Strategy 2: Reduce output frequency with windowing
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp,
    System.Timestamp() AS WindowEnd
INTO [SummarizedOutput]
FROM [Input] TIMESTAMP BY EventTime
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)  -- Output every 5 minutes vs. every event
```

### __10.19 Implement Smart Start/Stop__

Automate job scheduling for non-24/7 workloads:

```powershell
# Create Azure Function to stop job during off-hours
$stopJobScript = @'
param($Timer)

$resourceGroup = $env:STREAM_RG
$jobName = $env:STREAM_JOB

# Stop job at 6 PM weekdays
$currentHour = (Get-Date).Hour
$dayOfWeek = (Get-Date).DayOfWeek

if ($dayOfWeek -ne "Saturday" -and $dayOfWeek -ne "Sunday" -and $currentHour -ge 18) {
    az stream-analytics job stop --resource-group $resourceGroup --name $jobName --no-wait
    Write-Host "Job stopped for cost savings"
}
'@

# Save as Azure Function for scheduling
```

## 📉 Monitoring and Alerting

### __10.20 Configure Performance Alerts__

Create alerts for performance degradation:

```powershell
# Alert when SU utilization exceeds 80%
az monitor metrics alert create `
    --name "HighSUUtilization" `
    --resource-group $env:STREAM_RG `
    --scopes (az stream-analytics job show --resource-group $env:STREAM_RG --name $env:STREAM_JOB --query id -o tsv) `
    --condition "avg ResourceUtilization > 80" `
    --window-size 5m `
    --evaluation-frequency 1m `
    --action "email-admin@company.com" `
    --description "Stream Analytics SU utilization above 80%"

# Alert when watermark delay exceeds 60 seconds
az monitor metrics alert create `
    --name "HighWatermarkDelay" `
    --resource-group $env:STREAM_RG `
    --scopes (az stream-analytics job show --resource-group $env:STREAM_RG --name $env:STREAM_JOB --query id -o tsv) `
    --condition "max WatermarkDelay > 60000" `
    --window-size 5m `
    --evaluation-frequency 1m `
    --action "email-admin@company.com" `
    --description "Watermark delay exceeds 60 seconds"
```

### __10.21 Log Analytics Queries__

Create performance monitoring queries:

```kusto
// Query 1: Track SU utilization trends
AzureMetrics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where MetricName == "ResourceUtilization"
| summarize AvgUtilization = avg(Average), MaxUtilization = max(Maximum)
    by bin(TimeGenerated, 5m)
| render timechart

// Query 2: Identify input bottlenecks
AzureMetrics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where MetricName in ("InputEvents", "OutputEvents")
| summarize
    InputRate = sumif(Total, MetricName == "InputEvents"),
    OutputRate = sumif(Total, MetricName == "OutputEvents")
    by bin(TimeGenerated, 1m)
| extend BacklogGrowth = InputRate - OutputRate
| where BacklogGrowth > 1000  // Alert when backlog grows
| render timechart

// Query 3: Data conversion error trends
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where Category == "Execution"
| where properties_s contains "conversion error"
| summarize ErrorCount = count() by bin(TimeGenerated, 5m)
| render timechart
```

## 🧪 Performance Testing

### __10.22 Load Testing Script__

Generate high-volume test data:

```python
# performance_load_test.py
from azure.eventhub import EventHubProducerClient, EventData
import asyncio
import json
import time
from datetime import datetime
import random
import os

connection_string = os.environ.get("STREAM_EH_SEND_CONN")
eventhub_name = os.environ.get("STREAM_EH_NAME")

async def send_batch(producer, batch_size, device_count):
    """Send a batch of events"""
    event_data_batch = await producer.create_batch()

    for i in range(batch_size):
        device_id = f"device-{random.randint(1, device_count):04d}"
        event = {
            "deviceId": device_id,
            "temperature": round(random.uniform(60, 85), 2),
            "humidity": round(random.uniform(30, 70), 2),
            "pressure": round(random.uniform(980, 1020), 2),
            "timestamp": datetime.utcnow().isoformat()
        }

        try:
            event_data_batch.add(EventData(json.dumps(event)))
        except ValueError:
            # Batch is full, send it and create new batch
            await producer.send_batch(event_data_batch)
            event_data_batch = await producer.create_batch()
            event_data_batch.add(EventData(json.dumps(event)))

    # Send remaining events
    if len(event_data_batch) > 0:
        await producer.send_batch(event_data_batch)

async def load_test(events_per_second, duration_seconds, device_count):
    """Run load test with specified parameters"""
    producer = EventHubProducerClient.from_connection_string(
        conn_str=connection_string,
        eventhub_name=eventhub_name
    )

    batch_size = events_per_second
    batches = duration_seconds

    print(f"Starting load test:")
    print(f"  - Target: {events_per_second} events/second")
    print(f"  - Duration: {duration_seconds} seconds")
    print(f"  - Devices: {device_count}")
    print(f"  - Total events: {events_per_second * duration_seconds}")

    start_time = time.time()

    async with producer:
        for batch_num in range(batches):
            batch_start = time.time()

            await send_batch(producer, batch_size, device_count)

            # Calculate sleep time to maintain rate
            elapsed = time.time() - batch_start
            sleep_time = max(0, 1.0 - elapsed)

            if sleep_time > 0:
                await asyncio.sleep(sleep_time)

            if (batch_num + 1) % 10 == 0:
                print(f"Sent {(batch_num + 1) * batch_size} events...")

    total_time = time.time() - start_time
    total_events = batches * batch_size
    actual_rate = total_events / total_time

    print(f"\nLoad test complete:")
    print(f"  - Total time: {total_time:.2f} seconds")
    print(f"  - Total events: {total_events}")
    print(f"  - Actual rate: {actual_rate:.2f} events/second")

# Run load test
if __name__ == "__main__":
    asyncio.run(load_test(
        events_per_second=1000,  # Target throughput
        duration_seconds=300,     # 5 minutes
        device_count=100          # Number of unique devices
    ))
```

### __10.23 Monitor During Load Test__

```powershell
# Monitor metrics during load test
$startTime = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")

# Run load test (in separate terminal)
python performance_load_test.py

# Monitor in real-time
while ($true) {
    Clear-Host
    Write-Host "=== Stream Analytics Performance Metrics ===" -ForegroundColor Cyan
    Write-Host "Time: $(Get-Date)" -ForegroundColor Green

    $jobResourceId = az stream-analytics job show `
        --resource-group $env:STREAM_RG `
        --name $env:STREAM_JOB `
        --query id -o tsv

    # Get latest metrics
    $suUtil = az monitor metrics list `
        --resource $jobResourceId `
        --metric "ResourceUtilization" `
        --start-time $startTime `
        --aggregation Average `
        --query "value[0].timeseries[0].data[-1].average" -o tsv

    $watermark = az monitor metrics list `
        --resource $jobResourceId `
        --metric "WatermarkDelay" `
        --start-time $startTime `
        --aggregation Maximum `
        --query "value[0].timeseries[0].data[-1].maximum" -o tsv

    $inputEvents = az monitor metrics list `
        --resource $jobResourceId `
        --metric "InputEvents" `
        --start-time $startTime `
        --aggregation Total `
        --interval PT1M `
        --query "value[0].timeseries[0].data[-1].total" -o tsv

    Write-Host "SU Utilization: $([Math]::Round($suUtil, 2))%" -ForegroundColor $(if($suUtil -gt 80){'Red'}else{'Green'})
    Write-Host "Watermark Delay: $([Math]::Round($watermark / 1000, 2)) seconds" -ForegroundColor $(if($watermark -gt 60000){'Red'}else{'Green'})
    Write-Host "Input Events (last minute): $inputEvents" -ForegroundColor Cyan

    Start-Sleep -Seconds 10
}
```

## 🎓 Key Concepts Learned

### __Performance Fundamentals__

- __SU% Utilization__: Primary metric for capacity planning
- __Watermark Delay__: Indicates processing lag
- __Partitioning__: Enables linear scalability

### __Optimization Techniques__

- __Query patterns__: Minimize subqueries, optimize JOINs
- __Windowing__: Choose appropriate window size
- __Early filtering__: Reduce data volume as early as possible

### __Cost Management__

- __Right-sizing SUs__: Balance performance and cost
- __Scheduled operations__: Stop jobs during off-peak hours
- __Output optimization__: Batch writes, reduce frequency

## 🚀 Next Steps

You've mastered performance optimization! Continue to the final tutorial:

__[Tutorial 11: Error Handling and Resilience →](11-error-handling.md)__

In the next tutorial, you'll:

- Implement comprehensive error handling
- Configure dead letter queues
- Build fault-tolerant streaming pipelines
- Handle data quality issues

## 📚 Additional Resources

- [Stream Analytics Query Optimization](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-streaming-unit-consumption)
- [Scaling Stream Analytics Jobs](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-scale-jobs)
- [Performance Best Practices](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-parallelization)
- [Cost Optimization Guide](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-add-inputs)

## 🔧 Troubleshooting

### __Issue: High SU% Despite Low Input Rate__

__Symptoms:__ SU utilization >90% with low event throughput

__Solution:__

```sql
-- Check for inefficient query patterns
-- Look for:
-- 1. Overly complex JOINs
-- 2. Large temporal windows
-- 3. Unnecessary subqueries

-- Simplify query example:
SELECT
    DeviceId,
    AVG(Temperature) AS AvgTemp
INTO [Output]
FROM [Input] TIMESTAMP BY EventTime
GROUP BY DeviceId, TumblingWindow(minute, 5)
-- Remove any unnecessary transformations
```

### __Issue: Increasing Watermark Delay__

__Symptoms:__ Watermark delay continuously grows

__Solution:__

```powershell
# Scale up SUs
az stream-analytics transformation update `
    --resource-group $env:STREAM_RG `
    --job-name $env:STREAM_JOB `
    --name "Transformation" `
    --streaming-units 12  # Increase from current value

# Or enable partitioning in query
# Add PARTITION BY PartitionId to query
```

### __Issue: Output Throttling__

__Symptoms:__ Output events lower than expected

__Solution:__

```powershell
# Increase output batch size and parallel writers
# For SQL Database output:
# Update output configuration to increase:
# - batchSize: 10000
# - maxWriterCount: 8

# For Blob Storage:
# Implement proper partitioning pattern
# pathPattern: "data/{date}/{time}/output.json"
```

## 💬 Feedback

Was this tutorial helpful?

- ✅ __Completed successfully__ - [Continue to Tutorial 11](11-error-handling.md)
- ⚠️ __Had issues__ - [Report a problem](https://github.com/fgarofalo56/csa-inabox-docs/issues)
- 💡 __Have suggestions__ - [Share feedback](https://github.com/fgarofalo56/csa-inabox-docs/discussions)

---

__Tutorial Progress:__ 10 of 11 complete | __Next:__ [Error Handling](11-error-handling.md)

*Last Updated: January 2025*
