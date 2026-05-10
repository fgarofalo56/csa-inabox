---
title: "Video Script: Performance Tuning for Azure Synapse"
tags:
  - multimedia
  - video
---
# Video Script: Performance Tuning for Azure Synapse

![Duration: 32 minutes](https://img.shields.io/badge/Duration-32%20minutes-blue)
![Level: Advanced](https://img.shields.io/badge/Level-Advanced-red)
![Version: 1.0](https://img.shields.io/badge/Version-1.0-blue)

## Video Metadata

- **Title**: Performance Tuning for Azure Synapse Analytics
- **Duration**: 32:00
- **Target Audience**: Data engineers, performance specialists
- **Skill Level**: Advanced
- **Prerequisites**:
  - Strong SQL knowledge
  - Understanding of distributed systems
  - Spark programming experience
  - Azure Synapse workspace with data

## Learning Objectives

1. Optimize Dedicated SQL pool table design
2. Tune Spark job performance
3. Implement efficient data loading strategies
4. Optimize query execution plans
5. Configure resource classes and workload management
6. Monitor and troubleshoot performance issues

## Video Script

### Opening (0:00 - 1:30)

**NARRATOR**:
"Performance issues cost time and money. A poorly optimized query that takes 10 minutes could run in seconds with the right design. In this advanced tutorial, you'll learn proven techniques to dramatically improve Azure Synapse Analytics performance."

### Section 1: SQL Pool Table Design (1:30 - 10:00)

#### Distribution Strategies (1:30 - 4:30)

```sql
-- HASH distribution for large fact tables
CREATE TABLE dbo.SalesFact
(
    SalesKey BIGINT NOT NULL,
    DateKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    ProductKey INT NOT NULL,
    Quantity INT NOT NULL,
    UnitPrice DECIMAL(19,4),
    TotalAmount DECIMAL(19,4)
)
WITH
(
    DISTRIBUTION = HASH(CustomerKey),  -- Choose column with uniform distribution
    CLUSTERED COLUMNSTORE INDEX
);

-- ROUND_ROBIN for staging tables
CREATE TABLE dbo.SalesStaging
(
    RawData NVARCHAR(MAX)
)
WITH
(
    DISTRIBUTION = ROUND_ROBIN,
    HEAP
);

-- REPLICATE for small dimension tables
CREATE TABLE dbo.DateDimension
(
    DateKey INT NOT NULL,
    FullDate DATE NOT NULL,
    DayOfWeek NVARCHAR(10),
    MonthName NVARCHAR(10)
)
WITH
(
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);

-- Check data distribution
DBCC PDW_SHOWSPACEUSED('dbo.SalesFact');

-- Identify skew
SELECT
    DISTINCT TableName = t.name,
    DistributionId = pnp.distribution_id,
    RowCount = pnp.row_count,
    ReservedSpaceMB = pnp.reserved_page_count * 8.0 / 1024
FROM
    sys.pdw_table_mappings AS tm
    INNER JOIN sys.tables AS t ON tm.object_id = t.object_id
    INNER JOIN sys.pdw_nodes_tables AS nt ON tm.physical_name = nt.name
    INNER JOIN sys.pdw_nodes_partitions AS pnp ON nt.object_id = pnp.object_id
WHERE
    t.name = 'SalesFact'
ORDER BY
    RowCount DESC;
```

#### Partitioning Strategies (4:30 - 7:00)

```sql
-- Partition large tables by date
CREATE TABLE dbo.SalesFactPartitioned
(
    SalesKey BIGINT NOT NULL,
    DateKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    TotalAmount DECIMAL(19,4)
)
WITH
(
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION
    (
        DateKey RANGE RIGHT FOR VALUES
        (
            20240101, 20240201, 20240301, 20240401,
            20240501, 20240601, 20240701, 20240801,
            20240901, 20241001, 20241101, 20241201
        )
    )
);

-- Partition switching for fast data loads
-- Create staging table with matching structure
CREATE TABLE dbo.SalesStaging_202401
(
    SalesKey BIGINT NOT NULL,
    DateKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    TotalAmount DECIMAL(19,4)
)
WITH
(
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX
);

-- Load data into staging
-- ... data load operations ...

-- Switch partition (sub-second operation)
ALTER TABLE dbo.SalesStaging_202401
SWITCH TO dbo.SalesFactPartitioned
PARTITION 1;

-- Drop staging table
DROP TABLE dbo.SalesStaging_202401;
```

#### Indexing Strategies (7:00 - 10:00)

```sql
-- Clustered columnstore index (default, best for analytics)
CREATE TABLE dbo.SalesAnalytics
(
    -- columns
)
WITH
(
    CLUSTERED COLUMNSTORE INDEX
);

-- Heap for staging (fastest loads)
CREATE TABLE dbo.StagingData
(
    RawData NVARCHAR(MAX)
)
WITH
(
    HEAP
);

-- Clustered index for small lookup tables
CREATE TABLE dbo.LookupTable
(
    Id INT NOT NULL,
    Description NVARCHAR(100)
)
WITH
(
    CLUSTERED INDEX (Id)
);

-- Monitor columnstore health
SELECT
    OBJECT_NAME(object_id) AS TableName,
    partition_number AS PartitionNumber,
    row_group_id AS RowGroupId,
    state_description AS State,
    total_rows AS TotalRows,
    deleted_rows AS DeletedRows,
    size_in_bytes / 1024 / 1024 AS SizeMB
FROM
    sys.dm_pdw_nodes_db_column_store_row_group_physical_stats
WHERE
    OBJECT_NAME(object_id) = 'SalesFact'
ORDER BY
    partition_number, row_group_id;

-- Rebuild columnstore index
ALTER INDEX ALL ON dbo.SalesFact REBUILD;

-- Update statistics
CREATE STATISTICS stat_CustomerKey ON dbo.SalesFact(CustomerKey) WITH FULLSCAN;
UPDATE STATISTICS dbo.SalesFact;
```

### Section 2: Query Optimization (10:00 - 17:00)

#### Query Plans (10:00 - 12:30)

```sql
-- Enable actual execution plan
SET SHOWPLAN_XML ON;

-- Analyze query plan
EXPLAIN
SELECT
    d.MonthName,
    SUM(f.TotalAmount) AS Revenue
FROM
    dbo.SalesFact f
    INNER JOIN dbo.DateDimension d ON f.DateKey = d.DateKey
WHERE
    d.Year = 2024
GROUP BY
    d.MonthName;

-- Look for:
-- - Data movement operations (broadcast, shuffle)
-- - Table scans vs index seeks
-- - Estimated vs actual row counts

-- Optimize with statistics
CREATE STATISTICS stat_DateKey ON dbo.SalesFact(DateKey) WITH FULLSCAN;
CREATE STATISTICS stat_CustomerKey ON dbo.SalesFact(CustomerKey) WITH FULLSCAN;

-- Re-run query and compare plans
```

#### Result Set Caching (12:30 - 14:00)

```sql
-- Enable result set caching at database level
ALTER DATABASE SynapseDW
SET RESULT_SET_CACHING ON;

-- Check if query used cache
SELECT
    request_id,
    command,
    result_cache_hit,
    total_elapsed_time
FROM
    sys.dm_pdw_exec_requests
WHERE
    session_id = SESSION_ID()
ORDER BY
    submit_time DESC;

-- Disable for specific query
SELECT
    ProductKey,
    SUM(TotalAmount) AS Revenue
FROM
    dbo.SalesFact
GROUP BY
    ProductKey
OPTION (LABEL = 'NoCache', USE HINT ('DISABLE_RESULT_CACHE'));

-- Clear cache for troubleshooting
DBCC DROPCLEANBUFFERS;
DBCC FREEPROCCACHE;
```

#### Materialized Views (14:00 - 17:00)

```sql
-- Create materialized view for common aggregation
CREATE MATERIALIZED VIEW dbo.SalesByMonth
WITH (DISTRIBUTION = HASH(MonthKey))
AS
SELECT
    d.Year,
    d.MonthKey,
    d.MonthName,
    f.ProductKey,
    SUM(f.Quantity) AS TotalQuantity,
    SUM(f.TotalAmount) AS TotalRevenue,
    AVG(f.UnitPrice) AS AvgUnitPrice,
    COUNT(*) AS TransactionCount
FROM
    dbo.SalesFact f
    INNER JOIN dbo.DateDimension d ON f.DateKey = d.DateKey
GROUP BY
    d.Year,
    d.MonthKey,
    d.MonthName,
    f.ProductKey;

-- Query automatically uses materialized view
SELECT
    Year,
    MonthName,
    SUM(TotalRevenue) AS Revenue
FROM
    dbo.SalesByMonth
WHERE
    Year = 2024
GROUP BY
    Year,
    MonthName;

-- Refresh materialized view
ALTER MATERIALIZED VIEW dbo.SalesByMonth REBUILD;

-- Check overhead
SELECT
    name,
    is_materialized_view,
    overhead_ratio
FROM
    sys.pdw_materialized_view_distribution_properties
WHERE
    name = 'SalesByMonth';
```

### Section 3: Workload Management (17:00 - 22:00)

#### Resource Classes (17:00 - 19:00)

```sql
-- View available resource classes
SELECT * FROM sys.dm_pdw_resource_class_name;

-- Assign user to resource class
EXEC sp_addrolemember 'largerc', 'ETLUser';

-- Check current resource allocation
SELECT
    session_id,
    request_id,
    resource_class,
    concurrency_slots_used,
    importance
FROM
    sys.dm_pdw_exec_requests
WHERE
    status = 'Running';

-- Remove from resource class
EXEC sp_droprolemember 'largerc', 'ETLUser';
```

#### Workload Classification (19:00 - 22:00)

```sql
-- Create workload classifier
CREATE WORKLOAD CLASSIFIER ETLWorkload
WITH
(
    WORKLOAD_GROUP = 'ETLGroup',
    MEMBERNAME = 'ETLUser',
    IMPORTANCE = HIGH,
    START_TIME = '09:00',
    END_TIME = '17:00'
);

-- Create workload group
CREATE WORKLOAD GROUP ETLGroup
WITH
(
    MIN_PERCENTAGE_RESOURCE = 20,
    CAP_PERCENTAGE_RESOURCE = 60,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 5,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 20
);

-- Monitor workload groups
SELECT
    workload_group_name,
    request_id,
    importance,
    resource_allocation_percentage,
    queued_time_ms
FROM
    sys.dm_pdw_exec_requests
WHERE
    status IN ('Running', 'Suspended');

-- Drop classifier
DROP WORKLOAD CLASSIFIER ETLWorkload;
```

### Section 4: Spark Optimization (22:00 - 28:00)

#### Spark Configuration (22:00 - 24:00)

```python
# Configure Spark session
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")

# Configure shuffle partitions
spark.conf.set("spark.sql.shuffle.partitions", "200")

# Configure memory
spark.conf.set("spark.executor.memory", "8g")
spark.conf.set("spark.executor.cores", "4")
spark.conf.set("spark.driver.memory", "4g")

# Enable dynamic allocation
spark.conf.set("spark.dynamicAllocation.enabled", "true")
spark.conf.set("spark.dynamicAllocation.minExecutors", "2")
spark.conf.set("spark.dynamicAllocation.maxExecutors", "10")

# Configure broadcasting
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "10485760")  # 10MB
```

#### Data Skew Handling (24:00 - 26:00)

```python
from pyspark.sql.functions import *

# Identify skew
df = spark.read.parquet("abfss://data@datalake.dfs.core.windows.net/sales/")

# Check partition distribution
df.groupBy(spark_partition_id()).count().show()

# Repartition by key
df_repartitioned = df.repartition(200, "customer_id")

# Use salting for skewed joins
# Add salt column
df_left = df_left.withColumn("salt", (rand() * 10).cast("int"))
df_right = df_right.withColumn("salt", lit(col("id") % 10))

# Join on salted key
result = df_left.join(
    df_right,
    (df_left.customer_id == df_right.customer_id) &
    (df_left.salt == df_right.salt)
)

# Remove salt column
result = result.drop("salt")
```

#### Delta Lake Optimization (26:00 - 28:00)

```python
from delta.tables import *

# Read Delta table
deltaTable = DeltaTable.forPath(spark, "abfss://data@datalake.dfs.core.windows.net/sales/")

# Optimize (compaction)
deltaTable.optimize().executeCompaction()

# Z-order for better data skipping
deltaTable.optimize().executeZOrderBy("customer_id", "order_date")

# Vacuum old files (7 days retention)
deltaTable.vacuum(168)  # hours

# Configure auto-optimize
spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
spark.conf.set("spark.databricks.delta.autoCompact.enabled", "true")

# Cache frequently accessed data
df.cache()
df.count()  # Trigger caching

# Monitor cache
print(f"Is cached: {df.is_cached}")
print(f"Storage level: {df.storageLevel}")

# Unpersist when done
df.unpersist()
```

### Section 5: Data Loading Optimization (28:00 - 30:30)

#### Bulk Loading (28:00 - 29:30)

```sql
-- COPY command (fastest for bulk loads)
COPY INTO dbo.SalesStaging
FROM 'https://datalake.dfs.core.windows.net/raw/sales/*.parquet'
WITH
(
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity'),
    MAXERRORS = 10,
    ERRORFILE = 'https://datalake.dfs.core.windows.net/errors/',
    COMPRESSION = 'SNAPPY'
);

-- PolyBase (alternative)
CREATE EXTERNAL TABLE ExternalSales
WITH
(
    LOCATION = '/sales/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = ParquetFormat
)
AS
SELECT * FROM dbo.SalesStaging;

-- Insert into final table
INSERT INTO dbo.SalesFact
SELECT * FROM ExternalSales;
```

#### Batch Size Optimization (29:30 - 30:30)

```python
# Optimize write batch size
df.write \
    .format("delta") \
    .mode("append") \
    .option("maxRecordsPerFile", 1000000) \
    .option("optimizeWrite", "true") \
    .save("abfss://data@datalake.dfs.core.windows.net/sales/")

# Parallel writes
df.repartition(20).write \
    .format("parquet") \
    .mode("append") \
    .save("abfss://data@datalake.dfs.core.windows.net/processed/")
```

### Conclusion (30:30 - 32:00)

**Performance Optimization Checklist**:

**SQL Pool**:
- [ ] Choose optimal distribution strategy
- [ ] Partition large tables appropriately
- [ ] Create and maintain statistics
- [ ] Use materialized views for common queries
- [ ] Enable result set caching
- [ ] Implement workload management

**Spark**:
- [ ] Configure adaptive query execution
- [ ] Handle data skew
- [ ] Optimize Delta tables regularly
- [ ] Use appropriate partition counts
- [ ] Cache frequently accessed data
- [ ] Monitor resource utilization

**General**:
- [ ] Monitor query performance regularly
- [ ] Test changes in non-production first
- [ ] Document optimization decisions
- [ ] Review and update statistics weekly

## Related Resources

- [Monitoring Dashboards](monitoring-dashboards.md)
- [Advanced Features](advanced-features.md)
- [CI/CD Pipelines](ci-cd-pipelines.md)

---

*Last Updated: January 2025*
