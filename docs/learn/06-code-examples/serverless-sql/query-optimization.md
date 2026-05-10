# Serverless SQL Query Optimization in Azure Synapse Analytics

[🏠 Home](../../../README.md) > [💻 Code Examples](../../README.md) > ☁️ Serverless SQL > 📄 Query Optimization

This guide provides detailed examples for optimizing SQL queries in Azure Synapse Serverless SQL pools to improve performance and reduce costs.

## Introduction to Serverless SQL Optimization

Azure Synapse Serverless SQL pools provide on-demand query processing for data in data lakes. Optimizing these queries is essential for reducing costs and improving query performance.

## Prerequisites

- Azure Synapse Analytics workspace
- Storage account with data files (Parquet, CSV, JSON, etc.)
- Appropriate permissions to execute SQL queries

## Query Optimization Techniques

### 1. File Format Selection

One of the most important optimization factors is choosing the right file format:

```sql
-- Query against Parquet (recommended) - most efficient
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales];

-- Query against CSV - less efficient
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/csv/sales_data/*.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE
) AS [sales];

-- Query against JSON - least efficient for large datasets
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/json/sales_data/*.json',
    FORMAT = 'CSV',
    FIELDTERMINATOR = '0x0b',
    FIELDQUOTE = '0x0b',
    ROWTERMINATOR = '0x0b'
) WITH (jsonDoc NVARCHAR(MAX)) AS [sales]
CROSS APPLY OPENJSON(jsonDoc)
WITH (
    order_id INT,
    customer_id INT,
    product_id INT,
    quantity INT,
    price DECIMAL(10,2),
    order_date DATE
);
```

### 2. Column Pruning

Only select the columns you need to reduce data scanning:

```sql
-- Inefficient - scans all columns
SELECT *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales];

-- Optimized - only scans necessary columns
SELECT customer_id, SUM(price * quantity) AS total_spent
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales]
GROUP BY customer_id
ORDER BY total_spent DESC;
```

### 3. Predicate Pushdown

Utilize filter conditions that can be pushed down to storage:

```sql
-- Inefficient - filters after loading all data
SELECT *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales]
WHERE YEAR(order_date) = 2023 AND MONTH(order_date) = 6;

-- Optimized - uses predicate pushdown
SELECT *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales]
WHERE order_date BETWEEN '2023-06-01' AND '2023-06-30';
```

### 4. Partition Elimination

Leverage partitioned data for efficient queries:

```sql
-- Query against partitioned data
-- Data is stored in a folder structure like: /year=2023/month=06/day=15/data.parquet
SELECT *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/year=*/month=*/day=*/*.parquet',
    FORMAT = 'PARQUET'
) WITH (
    order_id INT,
    customer_id INT,
    product_id INT,
    quantity INT,
    price DECIMAL(10,2),
    order_date DATE,
    year INT,
    month INT,
    day INT
) AS [sales]
WHERE year = 2023 AND month = 6;
```

### 5. External Tables for Better Performance

Create external tables with optimized statistics:

```sql
-- Create database for external tables
CREATE DATABASE SalesData;
GO
USE SalesData;
GO

-- Create external data source
CREATE EXTERNAL DATA SOURCE ExampleDataSource
WITH (
    LOCATION = 'https://synapseexampledata.blob.core.windows.net/data/'
);
GO

-- Create file format
CREATE EXTERNAL FILE FORMAT ParquetFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);
GO

-- Create external table
CREATE EXTERNAL TABLE SalesTable (
    order_id INT,
    customer_id INT,
    product_id INT,
    quantity INT,
    price DECIMAL(10,2),
    order_date DATE,
    year INT,
    month INT,
    day INT
)
WITH (
    LOCATION = '/parquet/sales_data/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = ParquetFormat
);
GO

-- Create statistics on the external table
CREATE STATISTICS stat_customer_id ON SalesTable(customer_id);
CREATE STATISTICS stat_order_date ON SalesTable(order_date);
CREATE STATISTICS stat_product_id ON SalesTable(product_id);
GO

-- Query the external table with statistics
SELECT 
    year,
    month,
    SUM(quantity * price) AS total_sales
FROM SalesTable
WHERE order_date BETWEEN '2023-01-01' AND '2023-12-31'
GROUP BY year, month
ORDER BY year, month;
```

## Advanced Optimization Techniques

### 1. Query Plan Analysis

Use the EXPLAIN command to analyze query plans:

```sql
-- View the query execution plan
EXPLAIN
SELECT 
    customer_id,
    SUM(price * quantity) AS total_spent
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales]
GROUP BY customer_id
ORDER BY total_spent DESC;
```

### 2. Optimizing Joins

Optimize joins by using the proper join type and join order:

```sql
-- Create customer external table
CREATE EXTERNAL TABLE CustomerTable (
    customer_id INT,
    customer_name NVARCHAR(100),
    customer_segment NVARCHAR(50),
    customer_region NVARCHAR(50)
)
WITH (
    LOCATION = '/parquet/customer_data/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = ParquetFormat
);

-- Create statistics on join columns
CREATE STATISTICS stat_sales_customer_id ON SalesTable(customer_id);
CREATE STATISTICS stat_customer_customer_id ON CustomerTable(customer_id);

-- Inefficient join - larger table on left side
SELECT 
    c.customer_name,
    SUM(s.price * s.quantity) AS total_spent
FROM SalesTable s
LEFT JOIN CustomerTable c ON s.customer_id = c.customer_id
GROUP BY c.customer_name
ORDER BY total_spent DESC;

-- Optimized join - smaller table on left side
SELECT 
    c.customer_name,
    SUM(s.price * s.quantity) AS total_spent
FROM CustomerTable c
INNER JOIN SalesTable s ON c.customer_id = s.customer_id
WHERE s.year = 2023
GROUP BY c.customer_name
ORDER BY total_spent DESC;
```

### 3. Data Skew Handling

Address data skew with more granular partitioning or CETAS (Create External Table As Select):

```sql
-- Identify data skew
SELECT 
    product_id,
    COUNT(*) as row_count
FROM SalesTable
GROUP BY product_id
ORDER BY row_count DESC;

-- Handle skew using CETAS for high-volume products
CREATE EXTERNAL TABLE HighVolumeProducts
WITH (
    LOCATION = '/optimized/high_volume_products/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = ParquetFormat
)
AS
SELECT *
FROM SalesTable
WHERE product_id IN (101, 202, 303); -- High volume product IDs

-- Handle skew using CETAS for normal-volume products
CREATE EXTERNAL TABLE NormalVolumeProducts
WITH (
    LOCATION = '/optimized/normal_volume_products/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = ParquetFormat
)
AS
SELECT *
FROM SalesTable
WHERE product_id NOT IN (101, 202, 303); -- Exclude high volume product IDs

-- Union the results when querying
SELECT * FROM HighVolumeProducts
UNION ALL
SELECT * FROM NormalVolumeProducts;
```

### 4. Caching with Materialized Views

Use materialized views for frequently accessed aggregated data:

```sql
-- Create materialized view
CREATE EXTERNAL TABLE MonthlySalesSummary
WITH (
    LOCATION = '/optimized/monthly_sales_summary/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = ParquetFormat
)
AS
SELECT 
    year,
    month,
    product_id,
    SUM(quantity) AS total_quantity,
    SUM(price * quantity) AS total_sales,
    COUNT(DISTINCT order_id) AS order_count
FROM SalesTable
GROUP BY year, month, product_id;

-- Query the materialized view
SELECT 
    year,
    month,
    SUM(total_sales) AS monthly_revenue
FROM MonthlySalesSummary
WHERE year = 2023
GROUP BY year, month
ORDER BY year, month;
```

### 5. Result Set Caching

Enable result set caching for repeated queries:

```sql
-- Enable result set caching
ALTER DATABASE SalesData
SET RESULT_SET_CACHING ON;

-- Run a query that will be cached
SELECT TOP 100 *
FROM SalesTable
WHERE year = 2023 AND month = 6;

-- Run the same query again - will use the cached results
SELECT TOP 100 *
FROM SalesTable
WHERE year = 2023 AND month = 6;
```

## Working with Different File Types

### 1. CSV File Optimization

```sql
-- Create external table for CSV with optimal settings
CREATE EXTERNAL TABLE SalesCSV (
    order_id INT,
    customer_id INT,
    product_id INT,
    quantity INT,
    price DECIMAL(10,2),
    order_date DATE
)
WITH (
    LOCATION = '/csv/sales_data/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = DELIMITED TEXT WITH (
        FIELD_TERMINATOR = ',',
        USE_TYPE_DEFAULT = TRUE,
        STRING_DELIMITER = '"',
        DATE_FORMAT = 'yyyy-MM-dd',
        PARSER_VERSION = '2.0',
        FIRST_ROW = 2 -- Skip header row
    )
);

-- Query with optimal file handling
SELECT 
    YEAR(order_date) AS year,
    MONTH(order_date) AS month,
    SUM(price * quantity) AS total_sales
FROM SalesCSV
GROUP BY YEAR(order_date), MONTH(order_date)
ORDER BY year, month;
```

### 2. JSON File Optimization

```sql
-- Create external table for JSON with optimal settings
CREATE EXTERNAL TABLE SalesJSON
WITH (
    LOCATION = '/json/sales_data/',
    DATA_SOURCE = ExampleDataSource,
    FILE_FORMAT = JSON
)
AS
SELECT 
    JSON_VALUE(jsonDoc, '$.order_id') AS order_id,
    JSON_VALUE(jsonDoc, '$.customer_id') AS customer_id,
    JSON_VALUE(jsonDoc, '$.product_id') AS product_id,
    JSON_VALUE(jsonDoc, '$.quantity') AS quantity,
    JSON_VALUE(jsonDoc, '$.price') AS price,
    CONVERT(DATE, JSON_VALUE(jsonDoc, '$.order_date')) AS order_date
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/json/sales_data/*.json',
    FORMAT = 'CSV',
    FIELDTERMINATOR = '0x0b',
    FIELDQUOTE = '0x0b',
    ROWTERMINATOR = '0x0b'
) WITH (jsonDoc NVARCHAR(MAX)) AS [sales];

-- Query the optimized JSON table
SELECT 
    YEAR(order_date) AS year,
    MONTH(order_date) AS month,
    SUM(CAST(quantity AS INT) * CAST(price AS DECIMAL(10,2))) AS total_sales
FROM SalesJSON
GROUP BY YEAR(order_date), MONTH(order_date)
ORDER BY year, month;
```

## Resource Management and Concurrency

### 1. Setting Appropriate DWU

```sql
-- Check current resource utilization
SELECT * FROM sys.dm_exec_requests;

-- Check query resource consumption
SELECT
    r.request_id,
    r.total_elapsed_time,
    r.cpu_time,
    r.reads,
    r.writes,
    r.logical_reads,
    t.text
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id > 50 -- Filter out system sessions
ORDER BY r.total_elapsed_time DESC;
```

### 2. Optimizing for Concurrency

Use query hints for better concurrency:

```sql
-- Add resource allocation hints
SELECT 
    year,
    month,
    SUM(quantity * price) AS total_sales
FROM SalesTable
WHERE order_date BETWEEN '2023-01-01' AND '2023-12-31'
GROUP BY year, month
ORDER BY year, month
OPTION (LABEL = 'Monthly Sales Report', MAXDOP 4);
```

## Cost Optimization Strategies

### 1. Reduce Data Scanning

```sql
-- Use partitioning and file filtering
SELECT *
FROM OPENROWSET(
    BULK 'https://synapseexampledata.blob.core.windows.net/data/parquet/sales_data/year=2023/month=06/day=*/*.parquet',
    FORMAT = 'PARQUET'
) AS [sales];
```

### 2. Query Monitoring for Cost Control

```sql
-- Monitor data processed by queries
SELECT
    r.session_id,
    r.request_id,
    r.start_time,
    r.end_time,
    r.total_elapsed_time,
    s.bytes_processed,
    s.files_processed,
    t.text
FROM sys.dm_exec_requests r
JOIN sys.dm_external_work_stats s ON r.request_id = s.request_id
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
ORDER BY s.bytes_processed DESC;
```

## Best Practices

1. __Use Parquet Format__: Parquet provides the best performance for both storage and query efficiency.

2. __Apply Column Pruning__: Always select only the columns you need instead of using SELECT *.

3. __Leverage Partitioning__: Use partitioned data and partition elimination in your queries.

4. __Create Statistics__: Create statistics on external tables for better query optimization.

5. __Use CETAS__: Create External Table As Select (CETAS) to materialize intermediate results and optimize complex queries.

6. __Regular Monitoring__: Monitor query performance and data processed to identify optimization opportunities.

7. __Proper File Sizes__: Aim for file sizes between 100MB and 1GB for optimal performance.

8. __Minimize File Count__: Reduce the number of small files by using CETAS to combine them.

9. __Enable Result Set Caching__: For frequently executed identical queries.

10. __Use WITH Clause__: Simplify complex queries with common table expressions.

## Common Issues and Solutions

### Issue: Slow query performance on CSV files

__Solution__: Convert CSV to Parquet using CETAS for better performance.

### Issue: Out of memory errors

__Solution__:

- Reduce the amount of data processed in a single query
- Implement proper partitioning
- Use CETAS for large intermediate results

### Issue: High costs due to excessive data scanning

__Solution__:

- Implement column pruning
- Use partitioning and partition elimination
- Convert to Parquet format
- Create smaller, focused external tables

## Related Links

- [Azure Synapse Analytics documentation](https://learn.microsoft.com/en-us/azure/synapse-analytics/)
- [Serverless SQL pool best practices](https://learn.microsoft.com/en-us/azure/synapse-analytics/sql/best-practices-serverless-sql-pool)
- [Query optimization techniques for serverless SQL pools](https://learn.microsoft.com/en-us/azure/synapse-analytics/sql/query-optimization-techniques)
