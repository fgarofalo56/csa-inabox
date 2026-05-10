# Tutorial 10: Dedicated SQL Pools

## Overview

This tutorial covers Azure Synapse Dedicated SQL pools, providing enterprise-grade data warehousing capabilities with MPP (Massively Parallel Processing) architecture for high-performance analytics at scale.

## Prerequisites

- Completed [Tutorial 9: Serverless SQL Queries](09-serverless-sql.md)
- Understanding of data warehouse concepts
- Familiarity with T-SQL

## Learning Objectives

By the end of this tutorial, you will be able to:

- Create and configure dedicated SQL pools
- Design optimized table structures with distribution
- Implement data loading patterns
- Optimize query performance
- Manage workload and resources

---

## Section 1: Understanding Dedicated SQL Pools

### MPP Architecture

Dedicated SQL pools use Massively Parallel Processing:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Control Node                                  │
│                  (Query Optimization)                            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Compute Node 1 │ │  Compute Node 2 │ │  Compute Node N │
│   Distribution  │ │   Distribution  │ │   Distribution  │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Azure Storage  │ │  Azure Storage  │ │  Azure Storage  │
│  (Data Files)   │ │  (Data Files)   │ │  (Data Files)   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Creating a Dedicated SQL Pool

```sql
-- Via Azure Portal or Azure CLI
-- az synapse sql pool create --name mypool --workspace-name myworkspace --performance-level DW100c

-- Connect to dedicated pool and verify
SELECT @@VERSION;
SELECT DB_NAME();

-- Check current performance level
SELECT
    DB_NAME() AS database_name,
    (CASE WHEN is_paused = 0 THEN 'Running' ELSE 'Paused' END) AS status
FROM sys.databases
WHERE name = DB_NAME();
```

---

## Section 2: Table Design and Distribution

### Distribution Strategies

```sql
-- ROUND_ROBIN Distribution (default)
-- Good for: Staging tables, tables without clear join key
CREATE TABLE staging.Sales
(
    SaleID INT,
    ProductID INT,
    CustomerID INT,
    SaleAmount DECIMAL(10,2),
    SaleDate DATE
)
WITH
(
    DISTRIBUTION = ROUND_ROBIN,
    CLUSTERED COLUMNSTORE INDEX
);

-- HASH Distribution
-- Good for: Large fact tables, frequent join columns
CREATE TABLE fact.Sales
(
    SaleID INT NOT NULL,
    ProductID INT NOT NULL,
    CustomerID INT NOT NULL,
    DateKey INT NOT NULL,
    Quantity INT,
    UnitPrice DECIMAL(10,2),
    TotalAmount DECIMAL(12,2),
    DiscountAmount DECIMAL(10,2)
)
WITH
(
    DISTRIBUTION = HASH(CustomerID),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION (DateKey RANGE RIGHT FOR VALUES
        (20240101, 20240201, 20240301, 20240401,
         20240501, 20240601, 20240701, 20240801,
         20240901, 20241001, 20241101, 20241201))
);

-- REPLICATE Distribution
-- Good for: Small dimension tables (<2GB compressed)
CREATE TABLE dim.Product
(
    ProductKey INT NOT NULL,
    ProductID VARCHAR(20) NOT NULL,
    ProductName VARCHAR(100),
    Category VARCHAR(50),
    SubCategory VARCHAR(50),
    Brand VARCHAR(50),
    UnitPrice DECIMAL(10,2),
    IsActive BIT
)
WITH
(
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);

CREATE TABLE dim.Customer
(
    CustomerKey INT NOT NULL,
    CustomerID VARCHAR(20) NOT NULL,
    CustomerName VARCHAR(100),
    Segment VARCHAR(50),
    Region VARCHAR(50),
    Country VARCHAR(50),
    City VARCHAR(100)
)
WITH
(
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);
```

### Indexing Strategies

```sql
-- Clustered Columnstore Index (default, best for analytics)
CREATE TABLE fact.Orders
(
    OrderID BIGINT,
    CustomerID INT,
    OrderDate DATE,
    TotalAmount DECIMAL(12,2)
)
WITH
(
    DISTRIBUTION = HASH(CustomerID),
    CLUSTERED COLUMNSTORE INDEX
);

-- Clustered Index (good for point lookups)
CREATE TABLE dim.DateDimension
(
    DateKey INT NOT NULL,
    FullDate DATE NOT NULL,
    Year INT,
    Quarter INT,
    Month INT,
    MonthName VARCHAR(20),
    Day INT,
    DayOfWeek INT,
    DayName VARCHAR(20),
    IsWeekend BIT,
    IsHoliday BIT
)
WITH
(
    DISTRIBUTION = REPLICATE,
    CLUSTERED INDEX (DateKey)
);

-- Heap (good for staging/temporary tables)
CREATE TABLE staging.RawData
(
    RawID BIGINT IDENTITY(1,1),
    JsonData NVARCHAR(MAX),
    LoadDate DATETIME DEFAULT GETDATE()
)
WITH
(
    DISTRIBUTION = ROUND_ROBIN,
    HEAP
);

-- Adding Non-Clustered Indexes
CREATE NONCLUSTERED INDEX IX_Customer_Region
ON dim.Customer(Region);

CREATE NONCLUSTERED INDEX IX_Product_Category
ON dim.Product(Category, SubCategory);
```

### Partitioning

```sql
-- Create partitioned table
CREATE TABLE fact.SalesPartitioned
(
    SaleID BIGINT NOT NULL,
    DateKey INT NOT NULL,
    ProductKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    Quantity INT,
    Amount DECIMAL(12,2)
)
WITH
(
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION (DateKey RANGE RIGHT FOR VALUES
        (20230101, 20230401, 20230701, 20231001,
         20240101, 20240401, 20240701, 20241001))
);

-- Switch partition (fast data loading)
-- Create staging table with same structure
CREATE TABLE staging.SalesQ1
(
    SaleID BIGINT NOT NULL,
    DateKey INT NOT NULL,
    ProductKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    Quantity INT,
    Amount DECIMAL(12,2)
)
WITH
(
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX
);

-- Load data into staging table
-- Then switch partition
ALTER TABLE staging.SalesQ1
SWITCH TO fact.SalesPartitioned PARTITION 5;

-- Split partition for new data
ALTER TABLE fact.SalesPartitioned
SPLIT RANGE (20250101);

-- Merge partitions (combine old partitions)
ALTER TABLE fact.SalesPartitioned
MERGE RANGE (20230101);
```

---

## Section 3: Data Loading Patterns

### COPY Command (Recommended)

```sql
-- Basic COPY command
COPY INTO staging.Sales
FROM 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet'
WITH (
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity')
);

-- COPY with options
COPY INTO staging.Customers
FROM 'https://yourstorageaccount.dfs.core.windows.net/data/customers/'
WITH (
    FILE_TYPE = 'CSV',
    CREDENTIAL = (IDENTITY = 'Managed Identity'),
    FIELDTERMINATOR = ',',
    ROWTERMINATOR = '\n',
    FIRSTROW = 2,
    ENCODING = 'UTF8',
    DATEFORMAT = 'ymd',
    MAXERRORS = 10,
    ERRORFILE = 'https://yourstorageaccount.dfs.core.windows.net/errors/'
);

-- COPY with column mapping
COPY INTO fact.Sales (SaleID, ProductKey, CustomerKey, DateKey, Quantity, Amount)
FROM 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet'
WITH (
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity')
);

-- COPY from multiple files with pattern
COPY INTO staging.DailySales
FROM 'https://yourstorageaccount.dfs.core.windows.net/data/sales/2024/*/sales_*.parquet'
WITH (
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity')
);
```

### PolyBase (External Tables)

```sql
-- Create external data source
CREATE EXTERNAL DATA SOURCE AzureDataLake
WITH (
    TYPE = HADOOP,
    LOCATION = 'abfss://data@yourstorageaccount.dfs.core.windows.net',
    CREDENTIAL = StorageCredential
);

-- Create external file format
CREATE EXTERNAL FILE FORMAT ParquetFileFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);

-- Create external table
CREATE EXTERNAL TABLE ext.Sales
(
    SaleID BIGINT,
    ProductID INT,
    CustomerID INT,
    SaleDate DATE,
    Amount DECIMAL(12,2)
)
WITH (
    LOCATION = '/sales/2024/',
    DATA_SOURCE = AzureDataLake,
    FILE_FORMAT = ParquetFileFormat
);

-- Load via CTAS (Create Table As Select)
CREATE TABLE fact.Sales
WITH (
    DISTRIBUTION = HASH(CustomerID),
    CLUSTERED COLUMNSTORE INDEX
)
AS
SELECT
    SaleID,
    ProductID AS ProductKey,
    CustomerID AS CustomerKey,
    CONVERT(INT, FORMAT(SaleDate, 'yyyyMMdd')) AS DateKey,
    Amount
FROM ext.Sales;
```

### Incremental Loading Pattern

```sql
-- Create watermark table
CREATE TABLE etl.Watermark
(
    TableName VARCHAR(100),
    WatermarkColumn VARCHAR(100),
    WatermarkValue DATETIME2
)
WITH (DISTRIBUTION = REPLICATE);

-- Insert initial watermark
INSERT INTO etl.Watermark VALUES ('fact.Sales', 'ModifiedDate', '2024-01-01');

-- Incremental load procedure
CREATE PROCEDURE etl.IncrementalLoadSales
AS
BEGIN
    DECLARE @LastWatermark DATETIME2;
    DECLARE @NewWatermark DATETIME2 = GETUTCDATE();

    -- Get last watermark
    SELECT @LastWatermark = WatermarkValue
    FROM etl.Watermark
    WHERE TableName = 'fact.Sales';

    -- Load incremental data
    INSERT INTO fact.Sales
    SELECT
        SaleID,
        ProductKey,
        CustomerKey,
        DateKey,
        Quantity,
        Amount
    FROM staging.Sales
    WHERE ModifiedDate > @LastWatermark
      AND ModifiedDate <= @NewWatermark;

    -- Update watermark
    UPDATE etl.Watermark
    SET WatermarkValue = @NewWatermark
    WHERE TableName = 'fact.Sales';
END;
```

---

## Section 4: Query Optimization

### Explain Plans

```sql
-- View estimated execution plan
EXPLAIN
SELECT
    c.CustomerName,
    p.Category,
    SUM(f.TotalAmount) AS TotalSales
FROM fact.Sales f
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
JOIN dim.Product p ON f.ProductKey = p.ProductKey
WHERE f.DateKey >= 20240101
GROUP BY c.CustomerName, p.Category;

-- View actual execution with statistics
SET STATISTICS IO ON;
SET STATISTICS TIME ON;

SELECT
    c.CustomerName,
    p.Category,
    SUM(f.TotalAmount) AS TotalSales
FROM fact.Sales f
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
JOIN dim.Product p ON f.ProductKey = p.ProductKey
WHERE f.DateKey >= 20240101
GROUP BY c.CustomerName, p.Category;

SET STATISTICS IO OFF;
SET STATISTICS TIME OFF;
```

### Statistics Management

```sql
-- Create statistics on filter columns
CREATE STATISTICS Stats_Sales_DateKey ON fact.Sales(DateKey);
CREATE STATISTICS Stats_Sales_CustomerKey ON fact.Sales(CustomerKey);
CREATE STATISTICS Stats_Sales_ProductKey ON fact.Sales(ProductKey);

-- Create multi-column statistics
CREATE STATISTICS Stats_Sales_DateProduct
ON fact.Sales(DateKey, ProductKey);

-- Update statistics
UPDATE STATISTICS fact.Sales;

-- Update with full scan (more accurate)
UPDATE STATISTICS fact.Sales WITH FULLSCAN;

-- View statistics info
DBCC SHOW_STATISTICS ('fact.Sales', 'Stats_Sales_DateKey');

-- Check statistics age
SELECT
    t.name AS table_name,
    s.name AS stats_name,
    STATS_DATE(s.object_id, s.stats_id) AS stats_updated
FROM sys.stats s
JOIN sys.tables t ON s.object_id = t.object_id
WHERE t.name = 'Sales'
ORDER BY stats_updated DESC;
```

### Query Hints and Optimization

```sql
-- Force specific distribution
SELECT *
FROM fact.Sales
OPTION (FORCE SHUFFLE);

-- Force broadcast join
SELECT f.*, c.CustomerName
FROM fact.Sales f
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
OPTION (FORCE BROADCAST);

-- Label queries for monitoring
SELECT
    c.Region,
    SUM(f.TotalAmount) AS TotalSales
FROM fact.Sales f
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
GROUP BY c.Region
OPTION (LABEL = 'Regional_Sales_Report');

-- Result set caching
SET RESULT_SET_CACHING ON;

SELECT
    Category,
    SUM(TotalAmount) AS TotalSales
FROM fact.Sales f
JOIN dim.Product p ON f.ProductKey = p.ProductKey
GROUP BY Category;

-- Check if result was cached
SELECT
    result_cache_hit,
    request_id
FROM sys.dm_pdw_exec_requests
WHERE [label] = 'Regional_Sales_Report';
```

### Materialized Views

```sql
-- Create materialized view for common aggregations
CREATE MATERIALIZED VIEW mv.SalesByCategory
WITH (DISTRIBUTION = HASH(Category))
AS
SELECT
    p.Category,
    p.SubCategory,
    d.Year,
    d.Month,
    SUM(f.TotalAmount) AS TotalAmount,
    SUM(f.Quantity) AS TotalQuantity,
    COUNT_BIG(*) AS TransactionCount
FROM fact.Sales f
JOIN dim.Product p ON f.ProductKey = p.ProductKey
JOIN dim.DateDimension d ON f.DateKey = d.DateKey
GROUP BY p.Category, p.SubCategory, d.Year, d.Month;

-- Query uses materialized view automatically
SELECT
    Category,
    Year,
    SUM(TotalAmount) AS YearlyTotal
FROM fact.Sales f
JOIN dim.Product p ON f.ProductKey = p.ProductKey
JOIN dim.DateDimension d ON f.DateKey = d.DateKey
GROUP BY Category, Year;

-- Refresh materialized view
ALTER MATERIALIZED VIEW mv.SalesByCategory REBUILD;

-- Check materialized view state
SELECT
    name,
    is_valid,
    definition
FROM sys.materialized_views;
```

---

## Section 5: Workload Management

### Resource Classes

```sql
-- View available resource classes
SELECT * FROM sys.database_principals
WHERE type = 'R' AND name LIKE '%rc%';

-- Assign user to resource class
EXEC sp_addrolemember 'largerc', 'DataLoadUser';

-- View current user's resource class
SELECT
    r.name AS resource_class,
    m.name AS member_name
FROM sys.database_role_members rm
JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id
WHERE r.name LIKE '%rc%';

-- Resource class memory allocation
SELECT
    wc.name AS resource_class,
    wc.min_percentage_resource,
    wc.max_percentage_resource,
    wc.cap_percentage_resource
FROM sys.workload_management_workload_classifiers wc;
```

### Workload Groups and Classifiers

```sql
-- Create workload group for reporting
CREATE WORKLOAD GROUP ReportingWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 10,
    MAX_PERCENTAGE_RESOURCE = 50,
    CAP_PERCENTAGE_RESOURCE = 50,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 5,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 25,
    IMPORTANCE = NORMAL,
    QUERY_EXECUTION_TIMEOUT_SEC = 3600
);

-- Create workload group for data loading
CREATE WORKLOAD GROUP DataLoadWorkload
WITH (
    MIN_PERCENTAGE_RESOURCE = 25,
    MAX_PERCENTAGE_RESOURCE = 100,
    CAP_PERCENTAGE_RESOURCE = 100,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 25,
    IMPORTANCE = HIGH
);

-- Create classifier for reporting users
CREATE WORKLOAD CLASSIFIER ReportingClassifier
WITH (
    WORKLOAD_GROUP = 'ReportingWorkload',
    MEMBERNAME = 'ReportingUser',
    IMPORTANCE = NORMAL
);

-- Create classifier for data load users
CREATE WORKLOAD CLASSIFIER DataLoadClassifier
WITH (
    WORKLOAD_GROUP = 'DataLoadWorkload',
    MEMBERNAME = 'DataLoadUser',
    IMPORTANCE = HIGH
);

-- Classifier based on label
CREATE WORKLOAD CLASSIFIER DashboardClassifier
WITH (
    WORKLOAD_GROUP = 'ReportingWorkload',
    LABEL = 'Dashboard%',
    IMPORTANCE = HIGH
);
```

### Monitoring Queries

```sql
-- View running queries
SELECT
    request_id,
    status,
    submit_time,
    start_time,
    total_elapsed_time / 1000.0 AS elapsed_seconds,
    [label],
    command,
    resource_class
FROM sys.dm_pdw_exec_requests
WHERE status NOT IN ('Completed', 'Failed', 'Cancelled')
ORDER BY submit_time DESC;

-- View query steps
SELECT
    request_id,
    step_index,
    operation_type,
    distribution_type,
    location_type,
    status,
    total_elapsed_time / 1000.0 AS elapsed_seconds,
    row_count,
    command
FROM sys.dm_pdw_request_steps
WHERE request_id = 'QID12345'
ORDER BY step_index;

-- View data movement
SELECT
    request_id,
    step_index,
    pdw_node_id,
    distribution_id,
    type,
    status,
    rows_processed,
    bytes_processed / 1024.0 / 1024.0 AS mb_processed
FROM sys.dm_pdw_dms_workers
WHERE request_id = 'QID12345'
ORDER BY step_index, pdw_node_id;

-- View waits
SELECT
    request_id,
    type,
    state,
    priority,
    object_type,
    object_name,
    request_time
FROM sys.dm_pdw_waits
WHERE request_id = 'QID12345';
```

---

## Section 6: Maintenance Operations

### Table Maintenance

```sql
-- Rebuild columnstore indexes
ALTER INDEX ALL ON fact.Sales REBUILD;

-- Reorganize columnstore indexes (less resource intensive)
ALTER INDEX ALL ON fact.Sales REORGANIZE;

-- Check index health
SELECT
    OBJECT_NAME(i.object_id) AS table_name,
    i.name AS index_name,
    ips.index_type_desc,
    ips.avg_fragmentation_in_percent,
    ips.page_count
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id
WHERE ips.avg_fragmentation_in_percent > 10;

-- Check columnstore segment quality
SELECT
    OBJECT_NAME(rg.object_id) AS table_name,
    rg.partition_number,
    rg.state_desc,
    rg.total_rows,
    rg.deleted_rows,
    rg.size_in_bytes / 1024.0 / 1024.0 AS size_mb
FROM sys.column_store_row_groups rg
WHERE OBJECT_NAME(rg.object_id) = 'Sales'
ORDER BY partition_number, row_group_id;
```

### Scale Operations

```sql
-- Scale pool (via Azure CLI or Portal)
-- az synapse sql pool update --name mypool --workspace-name myworkspace --performance-level DW200c

-- Pause pool (cost savings)
-- az synapse sql pool pause --name mypool --workspace-name myworkspace

-- Resume pool
-- az synapse sql pool resume --name mypool --workspace-name myworkspace

-- Check current DWU level
SELECT COUNT(*) * 100 AS approximate_dwu_level
FROM sys.dm_pdw_nodes
WHERE type = 'COMPUTE';
```

---

## Exercises

### Exercise 1: Design Table Distribution
Create a star schema with appropriate distribution strategies for a retail analytics scenario.

### Exercise 2: Optimize Data Loading
Implement an incremental loading pattern using COPY command and watermarks.

### Exercise 3: Query Performance Tuning
Take a slow query and optimize it using statistics, indexes, and materialized views.

---

## Best Practices Summary

| Practice | Recommendation |
|----------|----------------|
| Distribution | HASH for large facts, REPLICATE for small dims |
| Indexing | Columnstore for analytics, B-tree for lookups |
| Partitioning | By date for time-series data, 10-100 partitions |
| Loading | COPY command for best performance |
| Statistics | Create on filter/join columns, update regularly |
| Maintenance | Rebuild indexes weekly, update stats daily |

---

## Next Steps

- Continue to [Tutorial 11: Power BI Integration](11-power-bi-integration.md)
- Explore [SQL Performance Best Practices](../../best-practices/sql-performance.md)
- Review [Dedicated SQL Troubleshooting](../../troubleshooting/dedicated-sql-troubleshooting.md)
