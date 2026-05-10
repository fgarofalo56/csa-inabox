# Performance Benchmarks for Azure Synapse Analytics

[Home](../../README.md) > Performance > Performance Benchmarks

This guide provides comprehensive performance benchmarking methodologies, reference metrics, and optimization recommendations for Azure Synapse Analytics components including Dedicated SQL Pools, Serverless SQL Pools, Spark Pools, and Pipelines.

## Introduction to Performance Benchmarking

Performance benchmarking allows you to establish baselines, identify bottlenecks, validate optimizations, and ensure your Synapse Analytics environment meets your business requirements. Key benefits include:

- Establishing performance expectations and SLAs
- Identifying optimization opportunities
- Making data-driven scaling decisions
- Validating architectural choices
- Measuring the impact of configuration changes

## General Benchmarking Methodology

Follow these steps for effective benchmarking:

1. __Define clear objectives__
   - Specific metrics to measure (throughput, latency, resource utilization)
   - Workload characteristics to test
   - Success criteria for each component

2. __Create a controlled environment__
   - Isolate resources to avoid interference
   - Document all configuration settings
   - Ensure consistent data volumes and patterns

3. __Prepare representative test data__
   - Scale to match production data volumes
   - Reflect production data distributions
   - Include realistic data skew and variety

4. __Execute standardized test runs__
   - Run tests multiple times to account for variance
   - Test at different times of day when relevant
   - Record detailed metrics and execution logs

5. __Analyze and document results__
   - Calculate statistical measures (mean, median, percentiles)
   - Compare against baselines and objectives
   - Document configuration details with results

## SQL Pool Performance Benchmarking

### Dedicated SQL Pool Benchmark Framework

For comprehensive benchmarking of Dedicated SQL Pools:

1. __Data Loading Performance__
   - PolyBase load rates from different sources
   - COPY command performance
   - Partition switching efficiency
   - Comparison of various file formats (Parquet, CSV)

2. __Query Performance__
   - Scan operations on large tables
   - Aggregation performance
   - Join performance across distribution strategies
   - Complex analytical query execution times

3. __Concurrency Testing__
   - Workload management efficiency
   - Performance under multiple concurrent users
   - Resource class impact on concurrency

4. __Resource Utilization__
   - DWU/cDWU utilization patterns
   - Memory pressure metrics
   - Tempdb usage

### Sample Benchmark Queries

Use these queries as starting points for your benchmarks:

```sql
-- Table scan benchmark
DECLARE @StartTime datetime = GETDATE();
SELECT COUNT(*) FROM [dbo].[FactSales_Benchmark];
SELECT DATEDIFF(ms, @StartTime, GETDATE()) AS Duration_ms;

-- Aggregation benchmark
DECLARE @StartTime datetime = GETDATE();
SELECT 
    ProductKey, 
    SUM(SalesAmount) AS TotalSales, 
    AVG(SalesAmount) AS AvgSale,
    COUNT(*) AS SalesCount
FROM [dbo].[FactSales_Benchmark]
GROUP BY ProductKey;
SELECT DATEDIFF(ms, @StartTime, GETDATE()) AS Duration_ms;

-- Join benchmark
DECLARE @StartTime datetime = GETDATE();
SELECT 
    c.CustomerName, 
    p.ProductName, 
    SUM(f.SalesAmount) AS TotalSales
FROM 
    [dbo].[FactSales_Benchmark] f
    JOIN [dbo].[DimCustomer] c ON f.CustomerKey = c.CustomerKey
    JOIN [dbo].[DimProduct] p ON f.ProductKey = p.ProductKey
GROUP BY 
    c.CustomerName, 
    p.ProductName;
SELECT DATEDIFF(ms, @StartTime, GETDATE()) AS Duration_ms;
```

### Key Metrics to Measure

Track these metrics for Dedicated SQL Pool performance:

| Metric | Description | Target Range | Measurement Method |
|--------|-------------|--------------|-------------------|
| Data Load Speed | GB per hour | >1 TB/hr (DW1000c) | COPY/PolyBase operations with timing |
| Query Response Time | Time for query completion | Varies by complexity | DMVs, query timing, client metrics |
| Scan Rate | GB scanned per second | >2 GB/s per DWU100 | Query with timing on known data sizes |
| DWU Utilization | % of available resources used | 60-80% | Azure Portal metrics, DMVs |
| Concurrency | # of concurrent queries | Based on resource class | Load testing with multiple connections |

### Benchmark Results Interpretation

| Metric | Poor | Average | Good | Excellent |
|--------|------|---------|------|-----------|
| Data Load (1TB, DW1000c) | >2 hours | 1-2 hours | 30-60 minutes | <30 minutes |
| Large Table Scan (1TB) | >60 seconds | 30-60 seconds | 10-30 seconds | <10 seconds |
| Complex Join Query | >30 seconds | 15-30 seconds | 5-15 seconds | <5 seconds |
| Concurrent Queries (DW1000c) | <8 queries | 8-12 queries | 12-16 queries | >16 queries |

## Serverless SQL Pool Benchmarking

### Benchmarking Methodology for Serverless SQL

1. __File Format Performance__
   - Query performance across formats (Parquet, CSV, JSON)
   - Compression impact on performance
   - Partitioning strategies effectiveness

2. __Data Virtualization Efficiency__
   - External table query performance
   - View performance over external data
   - OPENROWSET vs. external tables comparison

3. __Resource Utilization__
   - Data processed per query
   - CPU request units
   - Memory allocation efficiency

### Sample Serverless SQL Benchmark Queries

```sql
-- Benchmark querying different file formats
DECLARE @StartTime datetime = GETDATE();
SELECT TOP 1000000 * 
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/benchmark/parquet_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [result];
SELECT DATEDIFF(ms, @StartTime, GETDATE()) AS Parquet_Duration_ms;

DECLARE @StartTime datetime = GETDATE();
SELECT TOP 1000000 * 
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/benchmark/csv_data/*.csv',
    FORMAT = 'CSV', 
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE
) AS [result];
SELECT DATEDIFF(ms, @StartTime, GETDATE()) AS CSV_Duration_ms;

-- Benchmark aggregation over external data
DECLARE @StartTime datetime = GETDATE();
SELECT 
    product_category, 
    COUNT(*) as product_count,
    AVG(price) as avg_price,
    SUM(quantity_sold) as total_sold
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/benchmark/parquet_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [result]
GROUP BY product_category;
SELECT DATEDIFF(ms, @StartTime, GETDATE()) AS Duration_ms;
```

### Key Metrics for Serverless SQL

| Metric | Description | Target Range | Measurement Method |
|--------|-------------|--------------|-------------------|
| Query Duration | Time for query completion | Varies by query | Query timing functions |
| Data Processed | Amount of data scanned | Minimize unnecessary scanning | Query execution statistics |
| Memory Utilization | Memory used during query | Within allocated limits | DMVs, execution statistics |
| Execution Plan Cost | Relative cost of query plans | Lower is better | EXPLAIN plans, Query Store |
| Cost (Data Processed) | Amount billed based on data processed | Budget dependent | Azure Cost Analysis |

## Spark Pool Performance Benchmarking

### Benchmarking Framework for Spark

1. __Job Execution Performance__
   - End-to-end job completion time
   - Task and stage execution metrics
   - Shuffle performance analysis
   - Executor utilization patterns

2. __Data Processing Performance__
   - Batch processing throughput
   - Stream processing latency
   - Delta Lake operation performance
   - Machine learning training speed

3. __Resource Allocation Efficiency__
   - Driver and executor memory utilization
   - Core utilization across nodes
   - Scaling efficiency with added resources
   - Resource allocation optimization

### Sample PySpark Benchmark Code

```python
# Benchmark DataFrame operations
from pyspark.sql import SparkSession
import time

# Initialize Spark session
spark = SparkSession.builder.appName("Benchmark").getOrCreate()

# Benchmark data reading
start_time = time.time()
df = spark.read.format("parquet").load("abfss://benchmark@yourstorageaccount.dfs.core.windows.net/data/large_dataset.parquet")
df.cache()  # Cache for subsequent operations
count = df.count()  # Force execution
read_time = time.time() - start_time
print(f"Reading {count} records took {read_time:.2f} seconds")

# Benchmark transformation operations
start_time = time.time()
result = df.groupBy("category").agg({"amount": "sum", "quantity": "avg"})
result.cache()
result.count()  # Force execution
transform_time = time.time() - start_time
print(f"Transformation took {transform_time:.2f} seconds")

# Benchmark write operations
start_time = time.time()
result.write.mode("overwrite").format("parquet").save("abfss://benchmark@yourstorageaccount.dfs.core.windows.net/output/benchmark_result")
write_time = time.time() - start_time
print(f"Writing results took {write_time:.2f} seconds")

# Log metrics to a tracking table
metrics_df = spark.createDataFrame([
    ("read", read_time, count, spark.conf.get("spark.executor.instances"), spark.conf.get("spark.executor.memory")),
    ("transform", transform_time, result.count(), spark.conf.get("spark.executor.instances"), spark.conf.get("spark.executor.memory")),
    ("write", write_time, result.count(), spark.conf.get("spark.executor.instances"), spark.conf.get("spark.executor.memory"))
], ["operation", "duration_seconds", "record_count", "executor_count", "executor_memory"])

metrics_df.write.mode("append").format("delta").save("abfss://benchmark@yourstorageaccount.dfs.core.windows.net/benchmark_metrics")
```

### Key Metrics for Spark Pools

| Metric | Description | Target Range | Measurement Method |
|--------|-------------|--------------|-------------------|
| Job Duration | End-to-end execution time | Workload dependent | Spark UI, job logs |
| Data Processing Rate | Records processed per second | >100K records/sec | Custom timing, Spark metrics |
| Executor CPU Utilization | % CPU used by executors | 60-80% | Spark metrics, Yarn metrics |
| Executor Memory Usage | Memory consumption patterns | 60-80% of allocated | Spark UI, GC logs |
| Shuffle Data | Amount of data shuffled between executors | Minimize unnecessary shuffling | Spark UI stage details |

### Spark Configuration Testing

Create a configuration matrix for testing:

| Configuration Parameter | Small | Medium | Large | XLarge |
|------------------------|-------|--------|-------|--------|
| Executor Count | 2-4 | 8-16 | 32-64 | 128+ |
| Executor Memory | 4-8 GB | 16 GB | 32 GB | 64 GB |
| Executor Cores | 2-4 | 4-8 | 8-16 | 16+ |
| Dynamic Allocation | Enabled | Enabled | Enabled | Enabled/Disabled |

Run identical workloads across these configurations to determine optimal settings for your specific use cases.

## Pipeline Performance Benchmarking

### Pipeline Benchmarking Framework

1. __Activity Performance__
   - Copy activity throughput
   - Data Flow transformation speed
   - Lookup and validation activity latency
   - External activity integration performance

2. __End-to-End Pipeline Execution__
   - Overall pipeline duration
   - Activity parallelism efficiency
   - Integration runtime utilization
   - Pipeline run reliability

3. __Scalability Testing__
   - Performance under increased data volumes
   - Concurrent pipeline execution
   - Integration runtime scaling effectiveness

### Key Metrics for Pipelines

| Metric | Description | Target Range | Measurement Method |
|--------|-------------|--------------|-------------------|
| Copy Throughput | MB/s or rows/s copied | >100 MB/s | Activity monitoring, duration logs |
| Data Flow Throughput | Records processed per second | >50K records/sec | Data Flow monitoring metrics |
| Pipeline Duration | End-to-end execution time | Workload dependent | Pipeline run history |
| Activity Success Rate | % of activities completing successfully | >99% | Pipeline monitoring metrics |
| Integration Runtime Utilization | CPU, memory usage of IR | 60-80% | Integration runtime metrics |

### Pipeline Performance Testing Tool

Create a PowerShell script to automate pipeline benchmarking:

```powershell
# Pipeline Benchmarking Tool
param(
    [string] $WorkspaceName,
    [string] $PipelineName,
    [int] $RunCount = 5,
    [hashtable] $Parameters = @{}
)

$totalDuration = 0
$successCount = 0
$runIds = @()

Write-Host "Starting benchmark for pipeline: $PipelineName"
Write-Host "Running $RunCount iterations..."

for ($i = 1; $i -le $RunCount; $i++) {
    Write-Host "Run $i of $RunCount..."
    
    # Run the pipeline
    $startTime = Get-Date
    $run = Invoke-AzSynapsePipeline -WorkspaceName $WorkspaceName -PipelineName $PipelineName -Parameter $Parameters
    $runId = $run.RunId
    $runIds += $runId
    
    # Wait for completion
    $status = "InProgress"
    while ($status -eq "InProgress") {
        Start-Sleep -Seconds 10
        $runStatus = Get-AzSynapsePipelineRun -WorkspaceName $WorkspaceName -RunId $runId
        $status = $runStatus.Status
    }
    
    $endTime = Get-Date
    $duration = ($endTime - $startTime).TotalSeconds
    
    # Record results
    if ($status -eq "Succeeded") {
        $successCount++
        $totalDuration += $duration
        Write-Host "Run $i completed successfully in $duration seconds"
    }
    else {
        Write-Host "Run $i failed with status: $status"
    }
}

# Calculate statistics
$successRate = ($successCount / $RunCount) * 100
$avgDuration = if ($successCount -gt 0) { $totalDuration / $successCount } else { 0 }

# Output results
Write-Host "===== Benchmark Results ====="
Write-Host "Pipeline: $PipelineName"
Write-Host "Success Rate: $successRate%"
Write-Host "Average Duration: $avgDuration seconds"
Write-Host "Run IDs: $runIds"
```

## Delta Lake Performance Benchmarking

### Delta Lake Operation Benchmarks

1. __Read Performance__
   - Full table scans
   - Predicate pushdown efficiency
   - Partition pruning effectiveness
   - Time travel query performance

2. __Write Performance__
   - Append operations
   - Merge operations
   - Delete performance
   - Update performance
   - Optimize (compaction) efficiency

3. __Concurrent Operations__
   - Read consistency during writes
   - Concurrent write handling
   - Transaction conflict resolution

### Sample Delta Lake Benchmark Code

```python
# Delta Lake Performance Benchmark
from delta.tables import DeltaTable
from pyspark.sql.functions import *
import time

# Initialize Spark session
spark = SparkSession.builder.appName("DeltaBenchmark").getOrCreate()

# Benchmark parameters
table_path = "abfss://benchmark@yourstorageaccount.dfs.core.windows.net/delta/benchmark_table"
num_records = 10000000
batch_size = 1000000
num_batches = 10

# Create initial dataset
def create_test_data(records):
    return (spark.range(0, records)
            .withColumn("value", rand() * 100)
            .withColumn("category", (rand() * 5).cast("int"))
            .withColumn("date", current_date())
    )

# Benchmark writes
print("===== Write Benchmark =====")
df = create_test_data(num_records)

start_time = time.time()
df.write.format("delta").mode("overwrite").save(table_path)
write_time = time.time() - start_time
print(f"Initial write of {num_records} records: {write_time:.2f} seconds")

# Benchmark appends
print("\n===== Append Benchmark =====")
append_times = []
for i in range(num_batches):
    batch_df = create_test_data(batch_size).withColumn("batch_id", lit(i))
    start_time = time.time()
    batch_df.write.format("delta").mode("append").save(table_path)
    batch_time = time.time() - start_time
    append_times.append(batch_time)
    print(f"Batch {i} append time: {batch_time:.2f} seconds")

print(f"Average append time: {sum(append_times)/len(append_times):.2f} seconds")

# Benchmark reads
print("\n===== Read Benchmark =====")
# Full scan
start_time = time.time()
count = spark.read.format("delta").load(table_path).count()
full_scan_time = time.time() - start_time
print(f"Full scan of {count} records: {full_scan_time:.2f} seconds")

# Filtered read
start_time = time.time()
filtered_count = spark.read.format("delta").load(table_path).filter("category = 2").count()
filter_time = time.time() - start_time
print(f"Filtered scan returning {filtered_count} records: {filter_time:.2f} seconds")

# Time travel
start_time = time.time()
version_1_count = spark.read.format("delta").option("versionAsOf", 1).load(table_path).count()
time_travel_time = time.time() - start_time
print(f"Time travel query to version 1 ({version_1_count} records): {time_travel_time:.2f} seconds")

# Benchmark updates
print("\n===== Update Benchmark =====")
delta_table = DeltaTable.forPath(spark, table_path)
start_time = time.time()
delta_table.update(
    condition = "category = 2",
    set = { "value": lit(999.99) }
)
update_time = time.time() - start_time
print(f"Update operation: {update_time:.2f} seconds")

# Benchmark optimize
print("\n===== Optimize Benchmark =====")
start_time = time.time()
delta_table.optimize().executeCompaction()
optimize_time = time.time() - start_time
print(f"Optimize operation: {optimize_time:.2f} seconds")

# Log benchmark results
metrics = [
    ("initial_write", write_time, num_records),
    ("average_append", sum(append_times)/len(append_times), batch_size),
    ("full_scan", full_scan_time, count),
    ("filtered_scan", filter_time, filtered_count),
    ("time_travel", time_travel_time, version_1_count),
    ("update", update_time, -1),
    ("optimize", optimize_time, -1)
]

metrics_df = spark.createDataFrame(metrics, ["operation", "duration_seconds", "record_count"])
metrics_df.write.format("delta").mode("append").save(table_path + "_metrics")
```

### Key Metrics for Delta Lake

| Metric | Description | Target Range | Measurement Method |
|--------|-------------|--------------|-------------------|
| Write Throughput | Records written per second | >100K records/sec | Timed writes with record counts |
| Read Throughput | Records read per second | >1M records/sec | Timed reads with record counts |
| Compaction Efficiency | Size reduction from compaction | >30% reduction | Size before/after optimize |
| Merge Performance | Time to perform merge operations | Workload dependent | Timed merge operations |
| Time Travel Overhead | Additional time for historical queries | <20% vs. current version | Comparison of current vs. historical reads |

## Performance Comparison Benchmarks

### Component Comparison Methodologies

Create standardized comparison tests:

1. __SQL Options Comparison__
   - Dedicated SQL Pool vs. Serverless SQL
   - Synapse SQL vs. Spark SQL
   - Performance vs. cost efficiency analysis

2. __Storage Format Comparison__
   - Parquet vs. Delta Lake
   - CSV vs. Parquet performance delta
   - Compression option impact

3. __Pipeline Processing Options__
   - Copy Activity vs. Data Flows vs. Spark
   - Mapping Data Flow vs. Wrangling Data Flow
   - Self-hosted IR vs. Azure-hosted IR

### Sample Comparative Benchmark Results

| Scenario | Option A | Option B | Option C | Winner |
|----------|----------|----------|----------|--------|
| 1TB Aggregation | SQL Pool (DW1000c): 45s | Serverless SQL: 180s | Spark (Medium): 120s | SQL Pool |
| 100GB Join Operation | SQL Pool (DW1000c): 30s | Serverless SQL: 75s | Spark (Medium): 50s | SQL Pool |
| Incremental Load (10GB) | Copy Activity: 60s | Data Flow: 90s | Spark Delta: 45s | Spark Delta |
| Small File Processing | Copy Activity: 120s | Data Flow: 80s | Spark Coalesce: 40s | Spark Coalesce |

## Cost-Performance Optimization

### Cost Analysis Framework

1. __Component Cost Efficiency__
   - Performance per dollar metrics
   - Cost comparison of equivalent workloads
   - Idle time minimization strategies

2. __Scaling Economics__
   - Performance gain vs. cost increase analysis
   - Auto-scaling effectiveness
   - Right-sizing recommendations

3. __Storage Cost Optimization__
   - Storage format efficiency
   - Compression effectiveness
   - Data lifecycle management

### Performance-Cost Ratio Metrics

| Component | Performance Metric | Cost Metric | Optimization Target |
|-----------|-------------------|-------------|---------------------|
| Dedicated SQL Pool | Query throughput (queries/hour) | DWU hours consumed | Maximize queries/DWU-hour |
| Serverless SQL | Data processed per query (GB) | Data processed cost ($) | Minimize $/query |
| Spark Pools | Data processing rate (GB/min) | vCore hours consumed | Maximize GB/vCore-hour |
| Pipelines | Activity executions | Activity execution cost | Maximize activities/$ |

### Sample Cost-Performance Analysis

```powershell
# Cost-performance analysis script
param(
    [string] $WorkspaceName,
    [string] $ResourceGroup,
    [int] $DaysToAnalyze = 30
)

# Get SQL Pool costs
$sqlPoolUsage = Get-AzConsumptionUsageDetail -ResourceGroup $ResourceGroup | 
                Where-Object { 
                    $_.InstanceName -like "*sqlpool*" -and 
                    $_.UsageStart -ge (Get-Date).AddDays(-$DaysToAnalyze) 
                }

$sqlPoolCost = ($sqlPoolUsage | Measure-Object -Property PretaxCost -Sum).Sum

# Get SQL Pool performance metrics
$sqlPoolMetrics = Get-AzMetric -ResourceId "/subscriptions/{subscription-id}/resourceGroups/$ResourceGroup/providers/Microsoft.Synapse/workspaces/$WorkspaceName/sqlPools/sqlpool01" `
                  -MetricName "DWUUsagePercent" `
                  -AggregationType Average `
                  -StartTime (Get-Date).AddDays(-$DaysToAnalyze) `
                  -EndTime (Get-Date)

$avgDWUUsage = ($sqlPoolMetrics.Data | Measure-Object -Property Average -Average).Average

# Get query execution count
$queryCount = (Get-AzSynapseSqlPoolRequestEnd -WorkspaceName $WorkspaceName -SqlPoolName "sqlpool01" -TimeRangeStart (Get-Date).AddDays(-$DaysToAnalyze)).Count

# Calculate performance-cost metrics
$queriesPerDollar = $queryCount / $sqlPoolCost
$costPerQuery = $sqlPoolCost / $queryCount

# Output analysis
Write-Host "===== SQL Pool Cost-Performance Analysis ====="
Write-Host "Time Period: Last $DaysToAnalyze days"
Write-Host "Total Cost: $sqlPoolCost"
Write-Host "Query Count: $queryCount"
Write-Host "Average DWU Usage: $avgDWUUsage%"
Write-Host "Queries per Dollar: $queriesPerDollar"
Write-Host "Cost per Query: $costPerQuery"

if ($avgDWUUsage -lt 40) {
    Write-Host "RECOMMENDATION: Consider downsizing DWU as utilization is below 40%"
}
elseif ($avgDWUUsage -gt 80) {
    Write-Host "RECOMMENDATION: Consider upsizing DWU as utilization is above 80%"
}
```

## Benchmark Tools and Utilities

### Built-in Synapse Tools

1. __SQL Pool DMVs__
   - sys.dm_pdw_exec_requests
   - sys.dm_pdw_request_steps
   - sys.dm_pdw_sql_requests
   - sys.dm_pdw_resource_waits

2. __Spark UI and Logs__
   - Job and stage details
   - Event timeline
   - Executor statistics
   - SQL metrics

3. __Pipeline Monitoring__
   - Run history
   - Activity details
   - Integration runtime monitoring

### External Benchmarking Tools

1. __JMeter for Load Testing__
   - SQL endpoint stress testing
   - Concurrent query loads
   - User simulation scenarios

2. __TPC-H/TPC-DS Benchmarks__
   - Industry-standard query patterns
   - Scalable data generation
   - Standardized metrics

3. __Custom Benchmarking Framework__
   - Automated test execution
   - Result collection and analysis
   - Visualization and reporting

## Continuous Performance Monitoring

### Setting Up Performance Baselines

1. __Establish baseline metrics__
   - Document normal performance ranges
   - Set thresholds for alerts
   - Create baseline dashboards

2. __Regular benchmark execution__
   - Schedule automated benchmark runs
   - Compare against baselines
   - Track performance trends over time

3. __Performance regression testing__
   - Run benchmarks after major changes
   - Compare to previous baselines
   - Alert on significant degradations

### Integration with Monitoring Systems

1. __Azure Monitor integration__
   - Custom metrics for benchmark results
   - Performance metric dashboards
   - Alerts for performance degradation

2. __Log Analytics queries__
   - Performance trend analysis
   - Correlation with system events
   - Custom reporting dashboards

3. __Automated remediation__
   - Auto-scaling based on benchmark results
   - Self-healing for common performance issues
   - Scheduled optimization jobs

## Related Topics

- [Performance Optimization Best Practices](../best-practices/performance.md)
- [Monitoring and Logging Guide](../monitoring/logging-monitoring-guide.md)
- [Troubleshooting Guide](../troubleshooting/README.md)
- [Cost Optimization Strategies](../best-practices/cost-optimization.md)

## External Resources

- [Azure Synapse Analytics Documentation](https://docs.microsoft.com/en-us/azure/synapse-analytics/)
- [Azure Architecture Center: Performance Benchmarking](https://docs.microsoft.com/en-us/azure/architecture/framework/scalability/performance-efficiency)
- [TPC Benchmarks](http://www.tpc.org/)
