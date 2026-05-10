---
title: "Synapse-Specific Performance Optimization"
description: "Detailed performance tuning for Azure Synapse Analytics SQL and Spark pools"
author: "CSA Documentation Team"
last_updated: "2025-12-09"
version: "1.0.0"
category: "Best Practices - Performance"
---

# Synapse-Specific Performance Optimization

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)
![Impact](https://img.shields.io/badge/Impact-Critical-darkred)

> **🔷 Synapse Performance Excellence**
> Optimize Azure Synapse Analytics for maximum performance across dedicated SQL pools, serverless SQL pools, and Apache Spark pools.

## 📋 Table of Contents

- [Dedicated SQL Pool Optimization](#dedicated-sql-pool-optimization)
- [Serverless SQL Pool Optimization](#serverless-sql-pool-optimization)
- [Spark Pool Optimization](#spark-pool-optimization)
- [Integration Pipeline Optimization](#integration-pipeline-optimization)
- [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)

## Dedicated SQL Pool Optimization

### Table Design

#### Distribution Strategies

```sql
-- Choose distribution based on table size and join patterns

-- HASH distribution for large fact tables (> 2 GB)
CREATE TABLE FactSales (
    SaleID BIGINT,
    ProductID INT,
    CustomerID INT,
    SaleAmount DECIMAL(18,2),
    SaleDate DATE
)
WITH (
    DISTRIBUTION = HASH(CustomerID),  -- Distribute on JOIN column
    CLUSTERED COLUMNSTORE INDEX
);

-- REPLICATE for small dimension tables (< 2 GB)
CREATE TABLE DimProduct (
    ProductID INT,
    ProductName NVARCHAR(100),
    Category NVARCHAR(50),
    Price DECIMAL(10,2)
)
WITH (
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);

-- ROUND_ROBIN for staging tables
CREATE TABLE StagingSales (
    SaleID BIGINT,
    ProductID INT,
    SaleAmount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = ROUND_ROBIN,
    HEAP  -- No indexes for fast loading
);
```

#### Indexing Strategy

```sql
-- Clustered Columnstore Index (default, best for analytics)
CREATE TABLE Sales (
    SaleID BIGINT,
    CustomerID INT,
    SaleDate DATE,
    Amount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = HASH(CustomerID),
    CLUSTERED COLUMNSTORE INDEX
);

-- Ordered Clustered Columnstore Index (better segment elimination)
CREATE TABLE SalesOrdered (
    SaleID BIGINT,
    CustomerID INT,
    SaleDate DATE,
    Amount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = HASH(CustomerID),
    CLUSTERED COLUMNSTORE INDEX ORDER (SaleDate)
);

-- Heap with non-clustered index for point lookups
CREATE TABLE CustomerLookup (
    CustomerID INT,
    CustomerName NVARCHAR(100),
    Email NVARCHAR(255)
)
WITH (
    DISTRIBUTION = REPLICATE,
    HEAP
);

CREATE NONCLUSTERED INDEX IX_CustomerEmail
ON CustomerLookup(Email);
```

### Query Optimization

#### Table Statistics

```sql
-- Create statistics on join/filter columns
CREATE STATISTICS stats_customer_id ON FactSales(CustomerID) WITH FULLSCAN;
CREATE STATISTICS stats_product_id ON FactSales(ProductID) WITH FULLSCAN;
CREATE STATISTICS stats_sale_date ON FactSales(SaleDate) WITH FULLSCAN;

-- Update statistics after data loads
UPDATE STATISTICS FactSales;

-- Auto-create statistics (recommended)
ALTER DATABASE SalesDB SET AUTO_CREATE_STATISTICS ON;
ALTER DATABASE SalesDB SET AUTO_UPDATE_STATISTICS ON;

-- View statistics health
SELECT
    sm.name + '.' + tb.name AS table_name,
    st.name AS stats_name,
    sp.last_updated,
    sp.rows,
    sp.modification_counter
FROM sys.stats st
INNER JOIN sys.stats_columns sc ON st.object_id = sc.object_id AND st.stats_id = sc.stats_id
INNER JOIN sys.tables tb ON st.object_id = tb.object_id
INNER JOIN sys.schemas sm ON tb.schema_id = sm.schema_id
CROSS APPLY sys.dm_db_stats_properties(st.object_id, st.stats_id) sp
WHERE sp.modification_counter > 0
ORDER BY sp.modification_counter DESC;
```

#### Result Set Caching

```sql
-- Enable result set caching
ALTER DATABASE SalesDB SET RESULT_SET_CACHING ON;

-- Check cache usage
SELECT
    request_id,
    command,
    result_cache_hit,
    total_elapsed_time,
    submit_time
FROM sys.dm_pdw_exec_requests
WHERE command LIKE 'SELECT%'
ORDER BY submit_time DESC;

-- Monitor cache hit ratio
SELECT
    SUM(CASE WHEN result_cache_hit = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS cache_hit_ratio
FROM sys.dm_pdw_exec_requests
WHERE command LIKE 'SELECT%'
AND submit_time > DATEADD(hour, -1, GETDATE());
```

### Workload Management

#### Resource Classes and Workload Groups

```sql
-- Create workload group for ETL
CREATE WORKLOAD GROUP ETLWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 25,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 10,
    CAP_PERCENTAGE_RESOURCE = 50
);

-- Create workload group for reporting
CREATE WORKLOAD GROUP ReportingWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 10,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 3,
    CAP_PERCENTAGE_RESOURCE = 30
);

-- Create classifier to route queries
CREATE WORKLOAD CLASSIFIER ETLClassifier
WITH (
    WORKLOAD_GROUP = 'ETLWorkload',
    MEMBERNAME = 'etl_user',
    IMPORTANCE = HIGH
);

CREATE WORKLOAD CLASSIFIER ReportingClassifier
WITH (
    WORKLOAD_GROUP = 'ReportingWorkload',
    MEMBERNAME = 'report_user',
    IMPORTANCE = NORMAL
);

-- Monitor workload groups
SELECT
    r.request_id,
    r.status,
    r.submit_time,
    r.start_time,
    r.total_elapsed_time,
    r.command,
    w.name AS workload_group,
    c.name AS classifier
FROM sys.dm_pdw_exec_requests r
LEFT JOIN sys.dm_pdw_resource_waits rw ON r.request_id = rw.request_id
LEFT JOIN sys.workload_management_workload_groups w ON rw.group_id = w.group_id
LEFT JOIN sys.workload_management_workload_classifiers c ON rw.classifier_id = c.classifier_id
WHERE r.status = 'Running'
ORDER BY r.submit_time DESC;
```

## Serverless SQL Pool Optimization

### Query Optimization

#### Partition Elimination

```sql
-- ✅ GOOD: Partition pruning in path
SELECT customer_id, order_total
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/sales/year=2024/month=12/**',
    FORMAT = 'PARQUET'
) AS sales;

-- ❌ BAD: Filtering after reading all data
SELECT customer_id, order_total
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/sales/**',
    FORMAT = 'PARQUET'
) AS sales
WHERE year_partition = 2024 AND month_partition = 12;
```

#### Column Pruning

```sql
-- ✅ GOOD: Select only needed columns
SELECT product_id, quantity, price
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/sales/year=2024/**',
    FORMAT = 'PARQUET'
) AS sales;

-- ❌ BAD: Reading all columns
SELECT *
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/sales/year=2024/**',
    FORMAT = 'PARQUET'
) AS sales;
```

### External Tables

```sql
-- Create external data source
CREATE EXTERNAL DATA SOURCE SalesDataLake
WITH (
    LOCATION = 'https://storage.dfs.core.windows.net/sales'
);

-- Create external file format
CREATE EXTERNAL FILE FORMAT ParquetFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);

-- Create external table with partition columns
CREATE EXTERNAL TABLE SalesExternal (
    sale_id BIGINT,
    product_id INT,
    customer_id INT,
    amount DECIMAL(18,2),
    year INT,
    month INT
)
WITH (
    LOCATION = 'sales/',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
);

-- Query with partition pruning
SELECT customer_id, SUM(amount) as total_sales
FROM SalesExternal
WHERE year = 2024 AND month = 12
GROUP BY customer_id;
```

## Spark Pool Optimization

### Cluster Configuration

```python
# Spark configuration for performance
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("OptimizedSparkApp") \
    .config("spark.sql.adaptive.enabled", "true") \
    .config("spark.sql.adaptive.coalescePartitions.enabled", "true") \
    .config("spark.sql.adaptive.skewJoin.enabled", "true") \
    .config("spark.sql.autoBroadcastJoinThreshold", "10485760")  # 10 MB \
    .config("spark.sql.shuffle.partitions", "200") \
    .config("spark.sql.files.maxPartitionBytes", "134217728")  # 128 MB \
    .getOrCreate()

# Executor configuration
spark.conf.set("spark.executor.memory", "8g")
spark.conf.set("spark.executor.cores", "4")
spark.conf.set("spark.executor.instances", "10")

# Dynamic allocation
spark.conf.set("spark.dynamicAllocation.enabled", "true")
spark.conf.set("spark.dynamicAllocation.minExecutors", "2")
spark.conf.set("spark.dynamicAllocation.maxExecutors", "20")
```

### DataFrame Optimization

#### Broadcast Joins

```python
from pyspark.sql.functions import broadcast

# Large fact table
sales_df = spark.read.format("delta").load("/delta/sales")

# Small dimension table (< 10 MB)
products_df = spark.read.format("delta").load("/delta/products")

# ✅ GOOD: Broadcast small table
result = sales_df.join(
    broadcast(products_df),
    sales_df.product_id == products_df.product_id
)

# ❌ BAD: Regular join for small dimension
result = sales_df.join(
    products_df,
    sales_df.product_id == products_df.product_id
)
```

#### Partitioning and Bucketing

```python
# Repartition for balanced processing
sales_df = spark.read.format("delta").load("/delta/sales")

# Repartition by key for aggregations
sales_by_customer = sales_df.repartition(200, "customer_id") \
    .groupBy("customer_id") \
    .agg({"amount": "sum", "order_id": "count"})

# Coalesce for reducing partitions
result_df = sales_by_customer.coalesce(10)

# Write with bucketing for joins
sales_df.write \
    .format("delta") \
    .bucketBy(50, "customer_id") \
    .sortBy("order_date") \
    .saveAsTable("sales_bucketed")
```

#### Caching Strategy

```python
from pyspark.storagelevel import StorageLevel

# Cache frequently accessed data
dim_customer = spark.read.format("delta").load("/delta/customers")
dim_customer.persist(StorageLevel.MEMORY_AND_DISK)

# Use cached data in multiple operations
high_value = dim_customer.filter("lifetime_value > 10000")
active = dim_customer.filter("last_order_date > current_date() - 90")

# Unpersist when done
dim_customer.unpersist()
```

### Delta Lake Optimization

```python
from delta.tables import DeltaTable

# Optimize table (compaction)
deltaTable = DeltaTable.forPath(spark, "/delta/sales")
deltaTable.optimize().executeCompaction()

# Optimize with Z-Ordering
deltaTable.optimize().executeZOrderBy("customer_id", "order_date")

# Vacuum old files (remove files older than 7 days)
deltaTable.vacuum(retentionHours=168)

# Auto-optimize on write
spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
spark.conf.set("spark.databricks.delta.autoCompact.enabled", "true")

# Write with optimizations
df.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .save("/delta/sales")
```

## Integration Pipeline Optimization

### Pipeline Design Patterns

```json
{
  "name": "OptimizedETLPipeline",
  "properties": {
    "activities": [
      {
        "name": "IncrementalLoad",
        "type": "Copy",
        "inputs": [
          {
            "referenceName": "SourceDataset",
            "type": "DatasetReference",
            "parameters": {
              "watermarkColumn": "modified_date",
              "lastWatermark": "@pipeline().parameters.lastLoadDate"
            }
          }
        ],
        "typeProperties": {
          "source": {
            "type": "SqlSource",
            "sqlReaderQuery": "SELECT * FROM source WHERE modified_date > '@{pipeline().parameters.lastLoadDate}'"
          },
          "enableStaging": true,
          "stagingSettings": {
            "linkedServiceName": "AzureBlobStorage",
            "path": "staging"
          },
          "parallelCopies": 32,
          "dataIntegrationUnits": 16
        }
      }
    ]
  }
}
```

### Copy Activity Optimization

```json
{
  "name": "OptimizedCopy",
  "type": "Copy",
  "typeProperties": {
    "source": {
      "type": "ParquetSource",
      "storeSettings": {
        "type": "AzureBlobFSReadSettings",
        "recursive": true,
        "wildcardFileName": "*.parquet",
        "enablePartitionDiscovery": true
      }
    },
    "sink": {
      "type": "SqlDWSink",
      "preCopyScript": "TRUNCATE TABLE staging.sales",
      "writeBehavior": "Insert",
      "tableOption": "autoCreate",
      "disableMetricsCollection": false
    },
    "enableStaging": true,
    "stagingSettings": {
      "linkedServiceName": "AzureBlobStorage",
      "path": "staging",
      "enableCompression": true
    },
    "parallelCopies": 32,
    "dataIntegrationUnits": 32,
    "enableSkipIncompatibleRow": true
  }
}
```

## Monitoring and Troubleshooting

### Performance Monitoring Queries

```sql
-- Long running queries
SELECT
    r.request_id,
    r.status,
    r.submit_time,
    r.start_time,
    r.total_elapsed_time,
    r.command,
    r.resource_class,
    w.type AS wait_type,
    w.state AS wait_state
FROM sys.dm_pdw_exec_requests r
LEFT JOIN sys.dm_pdw_waits w ON r.request_id = w.request_id
WHERE r.total_elapsed_time > 60000  -- > 1 minute
ORDER BY r.total_elapsed_time DESC;

-- Resource waits analysis
SELECT
    wait_type,
    COUNT(*) AS wait_count,
    AVG(wait_time) AS avg_wait_time_ms,
    MAX(wait_time) AS max_wait_time_ms
FROM sys.dm_pdw_waits
WHERE request_id IS NOT NULL
GROUP BY wait_type
ORDER BY avg_wait_time_ms DESC;

-- Table skew analysis
SELECT
    t.name AS table_name,
    COUNT(DISTINCT p.distribution_id) AS distribution_count,
    MIN(p.rows) AS min_rows,
    MAX(p.rows) AS max_rows,
    AVG(p.rows) AS avg_rows,
    (MAX(p.rows) - MIN(p.rows)) * 100.0 / NULLIF(MAX(p.rows), 0) AS skew_percentage
FROM sys.tables t
INNER JOIN sys.pdw_table_mappings tm ON t.object_id = tm.object_id
INNER JOIN sys.pdw_nodes_tables nt ON tm.physical_name = nt.name
INNER JOIN sys.pdw_nodes_partitions p ON nt.object_id = p.object_id
GROUP BY t.name
HAVING (MAX(p.rows) - MIN(p.rows)) * 100.0 / NULLIF(MAX(p.rows), 0) > 10
ORDER BY skew_percentage DESC;
```

### Azure Monitor Queries

```kusto
// Slow query analysis
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.SYNAPSE"
| where Category == "SqlRequests"
| extend Duration = todouble(duration_d) / 1000
| where Duration > 60  // Queries > 60 seconds
| summarize
    Count = count(),
    AvgDuration = avg(Duration),
    P95Duration = percentile(Duration, 95)
by tostring(command_s), bin(TimeGenerated, 1h)
| order by P95Duration desc
```

## Performance Checklist

### Dedicated SQL Pool

- [ ] Tables distributed appropriately (HASH/REPLICATE/ROUND_ROBIN)
- [ ] Statistics created and updated
- [ ] Result set caching enabled
- [ ] Workload management configured
- [ ] Clustered columnstore indexes used
- [ ] Table skew < 10%

### Serverless SQL Pool

- [ ] Partition pruning implemented
- [ ] Column pruning applied
- [ ] Parquet format used
- [ ] External tables created for frequent queries
- [ ] Query results cached

### Spark Pool

- [ ] Adaptive query execution enabled
- [ ] Broadcast joins for small tables
- [ ] DataFrame caching for reuse
- [ ] Delta Lake optimized and compacted
- [ ] Appropriate partition count
- [ ] Auto-scaling configured

---

> **🔷 Continuous Optimization**
> Monitor query performance, analyze execution plans, and adjust configurations based on workload patterns. Set up automated alerts for performance degradation.
