---
title: "Synapse-Specific Best Practices"
description: "Comprehensive best practices for Azure Synapse Analytics implementation"
author: "CSA Documentation Team"
last_updated: "2025-12-09"
version: "1.0.0"
category: "Best Practices - Services"
---

# Synapse-Specific Best Practices

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)
![Scope](https://img.shields.io/badge/Scope-Comprehensive-blue)

> **🔷 Synapse Excellence Framework**
> Complete best practices covering dedicated SQL pools, serverless SQL pools, Spark pools, and integration pipelines.

## 📋 Table of Contents

- [Dedicated SQL Pools](#dedicated-sql-pools)
- [Serverless SQL Pools](#serverless-sql-pools)
- [Spark Pools](#spark-pools)
- [Integration Pipelines](#integration-pipelines)
- [Workspace Management](#workspace-management)
- [Implementation Checklist](#implementation-checklist)

## Dedicated SQL Pools

### Table Design Best Practices

#### Distribution Strategy Selection

```sql
-- Decision tree for distribution strategy

-- 1. Large fact tables (> 2 GB): HASH distribution
CREATE TABLE FactSales (
    SaleKey BIGINT NOT NULL,
    DateKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    ProductKey INT NOT NULL,
    SalesAmount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = HASH(CustomerKey),  -- Frequently joined column
    CLUSTERED COLUMNSTORE INDEX
);

-- 2. Small dimension tables (< 2 GB): REPLICATE
CREATE TABLE DimDate (
    DateKey INT NOT NULL,
    Date DATE NOT NULL,
    Year INT,
    Quarter INT,
    Month INT,
    DayOfWeek INT
)
WITH (
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);

-- 3. Staging/ETL tables: ROUND_ROBIN with HEAP
CREATE TABLE StagingSales (
    SaleID BIGINT,
    CustomerID INT,
    SaleDate DATE,
    Amount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = ROUND_ROBIN,
    HEAP
);
```

#### Partitioning Guidelines

```sql
-- Partition large tables by date for performance and manageability
CREATE TABLE FactSales (
    SaleKey BIGINT NOT NULL,
    SaleDate DATE NOT NULL,
    CustomerKey INT,
    SalesAmount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION (
        SaleDate RANGE RIGHT FOR VALUES (
            '2023-01-01', '2023-02-01', '2023-03-01',
            '2023-04-01', '2023-05-01', '2023-06-01',
            '2023-07-01', '2023-08-01', '2023-09-01',
            '2023-10-01', '2023-11-01', '2023-12-01',
            '2024-01-01'
        )
    )
);

-- Partition switching for efficient data loading
-- 1. Create partition function and scheme
CREATE PARTITION FUNCTION PF_SaleDate (DATE)
AS RANGE RIGHT FOR VALUES ('2024-01-01', '2024-02-01', '2024-03-01');

-- 2. Load new data into staging table
INSERT INTO StagingSales_202401
SELECT * FROM ExternalDataSource
WHERE SaleDate >= '2024-01-01' AND SaleDate < '2024-02-01';

-- 3. Switch partition
ALTER TABLE StagingSales_202401 SWITCH TO FactSales PARTITION 13;
```

### Indexing Strategy

```sql
-- Clustered Columnstore Index (default for analytics)
CREATE TABLE Sales (
    SaleID BIGINT,
    ProductID INT,
    Amount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = HASH(ProductID),
    CLUSTERED COLUMNSTORE INDEX
);

-- Ordered Clustered Columnstore Index (better segment elimination)
CREATE TABLE SalesOrdered (
    SaleID BIGINT,
    ProductID INT,
    SaleDate DATE,
    Amount DECIMAL(18,2)
)
WITH (
    DISTRIBUTION = HASH(ProductID),
    CLUSTERED COLUMNSTORE INDEX ORDER (SaleDate, ProductID)
);

-- Heap with Non-Clustered Index (for point queries)
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
ON CustomerLookup(Email)
INCLUDE (CustomerName);
```

### Workload Management

```sql
-- Create workload groups with resource allocation
CREATE WORKLOAD GROUP ETLWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 30,
    CAP_PERCENTAGE_RESOURCE = 70,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 10,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 25
);

CREATE WORKLOAD GROUP ReportingWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 10,
    CAP_PERCENTAGE_RESOURCE = 30,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 3,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 10
);

CREATE WORKLOAD GROUP AdHocWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 10,
    CAP_PERCENTAGE_RESOURCE = 20,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 3
);

-- Create classifiers to route queries
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
    WLM_LABEL = 'reporting',
    IMPORTANCE = NORMAL
);

-- Use query labels
SELECT COUNT(*)
FROM FactSales
OPTION (LABEL = 'reporting:daily_sales_report');
```

### Performance Tuning

#### Statistics Management

```sql
-- Create statistics on all join/filter columns
CREATE STATISTICS stats_customer_key ON FactSales(CustomerKey) WITH FULLSCAN;
CREATE STATISTICS stats_product_key ON FactSales(ProductKey) WITH FULLSCAN;
CREATE STATISTICS stats_sale_date ON FactSales(SaleDate) WITH FULLSCAN;

-- Multi-column statistics for correlated columns
CREATE STATISTICS stats_customer_product ON FactSales(CustomerKey, ProductKey) WITH FULLSCAN;

-- Automated statistics management
ALTER DATABASE SalesDB SET AUTO_CREATE_STATISTICS ON;
ALTER DATABASE SalesDB SET AUTO_UPDATE_STATISTICS ON;
ALTER DATABASE SalesDB SET AUTO_UPDATE_STATISTICS_ASYNC ON;

-- Identify missing statistics
SELECT
    sm.name + '.' + tb.name AS table_name,
    co.name AS column_name
FROM sys.tables tb
INNER JOIN sys.schemas sm ON tb.schema_id = sm.schema_id
INNER JOIN sys.columns co ON tb.object_id = co.object_id
LEFT JOIN sys.stats st ON tb.object_id = st.object_id
WHERE co.column_id NOT IN (
    SELECT column_id
    FROM sys.stats_columns
    WHERE object_id = tb.object_id
)
AND tb.is_external = 0
ORDER BY table_name, column_name;
```

#### Result Set Caching

```sql
-- Enable at database level
ALTER DATABASE SalesDB SET RESULT_SET_CACHING ON;

-- Check if query used cache
SELECT
    request_id,
    command,
    result_cache_hit,
    total_elapsed_time / 1000.0 AS elapsed_seconds,
    submit_time
FROM sys.dm_pdw_exec_requests
WHERE command LIKE '%SELECT%'
ORDER BY submit_time DESC;

-- Disable for specific query
SELECT COUNT(*) FROM FactSales
OPTION (LABEL = 'no_cache', RESULT_SET_CACHING OFF);

-- Clear cache
DBCC DROPCLEANBUFFERS;
```

## Serverless SQL Pools

### Query Optimization

#### Partition Pruning

```sql
-- ✅ GOOD: Partition columns in path
SELECT
    customer_id,
    SUM(amount) AS total_sales
FROM OPENROWSET(
    BULK 'https://datalake.dfs.core.windows.net/sales/year=2024/month=12/**',
    FORMAT = 'PARQUET'
) AS sales
GROUP BY customer_id;

-- ❌ BAD: Filtering after reading all data
SELECT
    customer_id,
    SUM(amount) AS total_sales
FROM OPENROWSET(
    BULK 'https://datalake.dfs.core.windows.net/sales/**',
    FORMAT = 'PARQUET'
) AS sales
WHERE year = 2024 AND month = 12
GROUP BY customer_id;
```

#### External Tables

```sql
-- Create database scoped credential
CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'StrongPassword123!';

CREATE DATABASE SCOPED CREDENTIAL StorageCredential
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = 'sv=2022-11-02&ss=bfqt&srt=sco&sp=rwdlacupiyx...';

-- Create external data source
CREATE EXTERNAL DATA SOURCE SalesDataLake
WITH (
    LOCATION = 'https://datalake.dfs.core.windows.net/sales',
    CREDENTIAL = StorageCredential
);

-- Create external file format
CREATE EXTERNAL FILE FORMAT ParquetFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);

-- Create external table
CREATE EXTERNAL TABLE SalesExternal (
    sale_id BIGINT,
    customer_id INT,
    product_id INT,
    amount DECIMAL(18,2),
    year INT,
    month INT
)
WITH (
    LOCATION = '/',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
);

-- Query external table with partition pruning
SELECT customer_id, SUM(amount)
FROM SalesExternal
WHERE year = 2024 AND month = 12
GROUP BY customer_id;
```

### Cost Optimization

```sql
-- Minimize data scanned
-- ✅ Select specific columns
SELECT customer_id, product_id, amount
FROM OPENROWSET(...) AS sales;

-- ✅ Use file format with compression
-- Parquet: 60-70% smaller than CSV
-- ORC: Similar to Parquet

-- ✅ Partition by frequently filtered columns
-- year=2024/month=12/day=09/

-- ✅ Use CETAS to cache results
CREATE EXTERNAL TABLE CachedResults
WITH (
    LOCATION = 'cached_results/',
    DATA_SOURCE = ResultsDataLake,
    FILE_FORMAT = ParquetFormat
)
AS
SELECT customer_id, SUM(amount) AS total
FROM SalesExternal
WHERE year = 2024
GROUP BY customer_id;

-- Subsequent queries use cached results (no scanning cost)
SELECT * FROM CachedResults WHERE customer_id = 12345;
```

## Spark Pools

### Configuration Best Practices

```python
# Optimal Spark configuration for Synapse
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("OptimizedDataProcessing") \
    .config("spark.sql.adaptive.enabled", "true") \
    .config("spark.sql.adaptive.coalescePartitions.enabled", "true") \
    .config("spark.sql.adaptive.skewJoin.enabled", "true") \
    .config("spark.sql.adaptive.localShuffleReader.enabled", "true") \
    .config("spark.sql.autoBroadcastJoinThreshold", "10485760") \
    .config("spark.sql.files.maxPartitionBytes", "134217728") \
    .config("spark.sql.shuffle.partitions", "200") \
    .config("spark.databricks.delta.optimizeWrite.enabled", "true") \
    .config("spark.databricks.delta.autoCompact.enabled", "true") \
    .getOrCreate()

# Executor memory and cores
spark.conf.set("spark.executor.memory", "8g")
spark.conf.set("spark.executor.cores", "4")
spark.conf.set("spark.driver.memory", "8g")
```

### Delta Lake Best Practices

```python
from delta.tables import DeltaTable
from pyspark.sql.functions import col, current_timestamp

# Write with optimizations
df.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .option("optimizeWrite", "true") \
    .option("overwriteSchema", "false") \
    .partitionBy("year", "month") \
    .save("/delta/sales")

# MERGE operation (UPSERT)
deltaTable = DeltaTable.forPath(spark, "/delta/customers")

updates_df = spark.read.parquet("/staging/customer_updates")

deltaTable.alias("target") \
    .merge(
        updates_df.alias("source"),
        "target.customer_id = source.customer_id"
    ) \
    .whenMatchedUpdateAll() \
    .whenNotMatchedInsertAll() \
    .execute()

# Optimize and Z-order
deltaTable.optimize().executeCompaction()
deltaTable.optimize().executeZOrderBy("customer_id", "last_order_date")

# Vacuum old files (7 day retention)
deltaTable.vacuum(retentionHours=168)

# Time travel queries
# Read version 5 of the table
df_v5 = spark.read.format("delta").option("versionAsOf", 5).load("/delta/sales")

# Read as of timestamp
df_yesterday = spark.read.format("delta") \
    .option("timestampAsOf", "2024-12-08") \
    .load("/delta/sales")
```

### Performance Optimization

```python
# Broadcast joins for small dimension tables
from pyspark.sql.functions import broadcast

fact_df = spark.read.format("delta").load("/delta/fact_sales")
dim_product = spark.read.format("delta").load("/delta/dim_product")

# Broadcast dimension (< 10 MB)
result = fact_df.join(
    broadcast(dim_product),
    fact_df.product_id == dim_product.product_id
)

# Repartition for balanced processing
sales_df = spark.read.format("delta").load("/delta/sales")

# Repartition by customer for aggregations
customer_summary = sales_df.repartition(200, "customer_id") \
    .groupBy("customer_id") \
    .agg({"amount": "sum", "order_id": "count"})

# Coalesce to reduce output files
customer_summary.coalesce(10).write \
    .format("delta") \
    .mode("overwrite") \
    .save("/delta/customer_summary")

# Cache frequently used DataFrames
reference_data = spark.read.format("delta").load("/delta/reference")
reference_data.cache()

# Use in multiple operations
filtered1 = reference_data.filter(col("category") == "A")
filtered2 = reference_data.filter(col("category") == "B")

# Unpersist when done
reference_data.unpersist()
```

## Integration Pipelines

### Pipeline Design Patterns

#### Incremental Load Pattern

```json
{
  "name": "IncrementalLoadPipeline",
  "properties": {
    "activities": [
      {
        "name": "GetLastWatermark",
        "type": "Lookup",
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT MAX(last_modified_date) AS watermark FROM control.watermark WHERE table_name = 'sales'"
          }
        }
      },
      {
        "name": "CopyIncrementalData",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "GetLastWatermark",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "source": {
            "type": "SqlSource",
            "sqlReaderQuery": "SELECT * FROM sales WHERE modified_date > '@{activity('GetLastWatermark').output.firstRow.watermark}'"
          },
          "sink": {
            "type": "ParquetSink"
          }
        }
      },
      {
        "name": "UpdateWatermark",
        "type": "SqlServerStoredProcedure",
        "dependsOn": [
          {
            "activity": "CopyIncrementalData",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "storedProcedureName": "usp_update_watermark",
          "storedProcedureParameters": {
            "table_name": "sales",
            "watermark_value": "@{activity('CopyIncrementalData').output.executionDetails[0].source.rowsRead}"
          }
        }
      }
    ]
  }
}
```

#### Error Handling Pattern

```json
{
  "name": "RobustETLPipeline",
  "properties": {
    "activities": [
      {
        "name": "DataProcessing",
        "type": "DatabricksNotebook",
        "typeProperties": {
          "notebookPath": "/etl/process_data"
        },
        "policy": {
          "timeout": "0.01:00:00",
          "retry": 3,
          "retryIntervalInSeconds": 60
        },
        "userProperties": [],
        "linkedServiceName": {
          "referenceName": "DatabricksLinkedService",
          "type": "LinkedServiceReference"
        }
      },
      {
        "name": "LogSuccess",
        "type": "SqlServerStoredProcedure",
        "dependsOn": [
          {
            "activity": "DataProcessing",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "storedProcedureName": "usp_log_pipeline_run",
          "storedProcedureParameters": {
            "pipeline_name": "@{pipeline().Pipeline}",
            "run_id": "@{pipeline().RunId}",
            "status": "Success"
          }
        }
      },
      {
        "name": "LogFailure",
        "type": "SqlServerStoredProcedure",
        "dependsOn": [
          {
            "activity": "DataProcessing",
            "dependencyConditions": ["Failed"]
          }
        ],
        "typeProperties": {
          "storedProcedureName": "usp_log_pipeline_run",
          "storedProcedureParameters": {
            "pipeline_name": "@{pipeline().Pipeline}",
            "run_id": "@{pipeline().RunId}",
            "status": "Failed",
            "error_message": "@{activity('DataProcessing').error.message}"
          }
        }
      },
      {
        "name": "SendAlertEmail",
        "type": "WebActivity",
        "dependsOn": [
          {
            "activity": "DataProcessing",
            "dependencyConditions": ["Failed"]
          }
        ],
        "typeProperties": {
          "url": "https://prod-logicapp.azurewebsites.net/api/send-alert",
          "method": "POST",
          "body": {
            "pipeline": "@{pipeline().Pipeline}",
            "error": "@{activity('DataProcessing').error.message}"
          }
        }
      }
    ]
  }
}
```

## Workspace Management

### Security Configuration

```bash
# Enable managed virtual network
az synapse workspace create \
    --name synapse-workspace \
    --resource-group rg-synapse \
    --storage-account datalakestorage \
    --sql-admin-login-user sqladmin \
    --sql-admin-login-password 'StrongPassword123!' \
    --location eastus \
    --managed-virtual-network true \
    --prevent-data-exfiltration true

# Configure private endpoints
az synapse workspace create \
    --name synapse-workspace \
    --resource-group rg-synapse \
    --storage-account datalakestorage \
    --sql-admin-login-user sqladmin \
    --location eastus \
    --public-network-access Disabled
```

### Git Integration

```bash
# Configure Git integration (via Synapse Studio)
# 1. Navigate to Synapse Studio > Manage > Git configuration
# 2. Select repository type (Azure DevOps or GitHub)
# 3. Configure repository details
# 4. Set collaboration branch: main
# 5. Set publish branch: workspace_publish
# 6. Root folder: /synapse
```

## Implementation Checklist

### Dedicated SQL Pools

- [ ] Distribution strategy selected based on table size and join patterns
- [ ] Large tables partitioned by date
- [ ] Clustered columnstore indexes used for analytics tables
- [ ] Statistics created on join/filter columns
- [ ] Result set caching enabled
- [ ] Workload management configured
- [ ] Table skew < 10%

### Serverless SQL Pools

- [ ] External tables created for frequently queried data
- [ ] Partition pruning implemented
- [ ] Column selection minimized
- [ ] Parquet/ORC format used
- [ ] CETAS used for result caching
- [ ] Database scoped credentials secured

### Spark Pools

- [ ] Adaptive query execution enabled
- [ ] Auto-scaling configured
- [ ] Delta Lake used for data storage
- [ ] Z-ordering applied to frequently filtered columns
- [ ] Broadcast joins for small dimensions
- [ ] DataFrames cached for reuse

### Integration Pipelines

- [ ] Incremental load patterns implemented
- [ ] Error handling and retry logic configured
- [ ] Pipeline monitoring and logging enabled
- [ ] Metadata-driven design used
- [ ] Git integration configured
- [ ] CI/CD pipelines established

---

> **🔷 Synapse Best Practices are Foundational**
> Following these best practices ensures optimal performance, cost efficiency, and maintainability of your Synapse Analytics implementation.
