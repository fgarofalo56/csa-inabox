# Tutorial 9: Serverless SQL Queries

## Overview

This tutorial covers Azure Synapse Serverless SQL pools, enabling you to query data directly in Azure Data Lake Storage without data movement. Learn to query Parquet, Delta Lake, CSV, and JSON files using familiar T-SQL syntax.

## Prerequisites

- Completed [Tutorial 8: Delta Lake Operations](08-delta-lake.md)
- Understanding of T-SQL fundamentals
- Data Lake Storage with sample data

## Learning Objectives

By the end of this tutorial, you will be able to:

- Query various file formats using OPENROWSET
- Create external tables and views
- Optimize serverless SQL query performance
- Implement security with managed identities
- Build data virtualization patterns

---

## Section 1: Understanding Serverless SQL

### What is Serverless SQL Pool?

Serverless SQL pool is a query service over data in your data lake:

- **No Infrastructure Management**: No clusters to provision or manage
- **Pay-Per-Query**: Only pay for data processed
- **T-SQL Support**: Use familiar SQL syntax
- **Multiple Formats**: Query Parquet, Delta, CSV, JSON directly

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Azure Synapse Analytics                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐  │
│  │ Serverless SQL   │───▶│  Azure Data Lake Storage     │  │
│  │ Pool (Built-in)  │    │  ├── Parquet files           │  │
│  └──────────────────┘    │  ├── Delta tables            │  │
│           │              │  ├── CSV files               │  │
│           ▼              │  └── JSON files              │  │
│  ┌──────────────────┐    └──────────────────────────────┘  │
│  │ Query Results    │                                       │
│  └──────────────────┘                                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Section 2: OPENROWSET Fundamentals

### Querying Parquet Files

```sql
-- Query single Parquet file
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/2024/01/sales_20240115.parquet',
    FORMAT = 'PARQUET'
) AS sales;

-- Query with explicit schema
SELECT
    product_id,
    product_name,
    category,
    price,
    sale_date
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/2024/01/*.parquet',
    FORMAT = 'PARQUET'
) WITH (
    product_id INT,
    product_name VARCHAR(100),
    category VARCHAR(50),
    price DECIMAL(10,2),
    sale_date DATE
) AS sales
WHERE category = 'Electronics';
```

### Querying Delta Lake Tables

```sql
-- Query Delta Lake table
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/delta/sales/',
    FORMAT = 'DELTA'
) AS delta_sales;

-- Query specific version (time travel)
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/delta/sales/',
    FORMAT = 'DELTA'
) AS delta_sales
OPTION (VERSION = 5);

-- Query as of timestamp
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/delta/sales/',
    FORMAT = 'DELTA'
) AS delta_sales
OPTION (TIMESTAMP_AS_OF = '2024-01-20T10:00:00Z');
```

### Querying CSV Files

```sql
-- Query CSV with header row
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/csv/customers.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE
) AS customers;

-- Query CSV with explicit schema and options
SELECT
    customer_id,
    full_name,
    email,
    registration_date
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/csv/customers/*.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    FIELDTERMINATOR = ',',
    ROWTERMINATOR = '\n',
    FIRSTROW = 2,
    FIELDQUOTE = '"',
    ESCAPECHAR = '\\'
) WITH (
    customer_id INT 1,
    full_name VARCHAR(100) 2,
    email VARCHAR(200) 3,
    registration_date DATE 4
) AS customers;

-- Handle different encodings
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/csv/international.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE,
    ENCODING = 'UTF-8'
) AS data;
```

### Querying JSON Files

```sql
-- Query JSON documents
SELECT
    JSON_VALUE(doc, '$.id') AS id,
    JSON_VALUE(doc, '$.name') AS name,
    JSON_VALUE(doc, '$.category') AS category,
    CAST(JSON_VALUE(doc, '$.price') AS DECIMAL(10,2)) AS price
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/json/products/*.json',
    FORMAT = 'CSV',
    FIELDTERMINATOR = '0x0b',
    FIELDQUOTE = '0x0b',
    ROWTERMINATOR = '0x0a'
) WITH (doc NVARCHAR(MAX)) AS products;

-- Query JSON Lines format (JSONL)
SELECT
    JSON_VALUE(jsonContent, '$.orderId') AS order_id,
    JSON_VALUE(jsonContent, '$.customerId') AS customer_id,
    JSON_QUERY(jsonContent, '$.items') AS items,
    JSON_VALUE(jsonContent, '$.totalAmount') AS total_amount
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/json/orders/*.jsonl',
    FORMAT = 'CSV',
    FIELDTERMINATOR = '0x0b',
    FIELDQUOTE = '0x0b'
) WITH (jsonContent NVARCHAR(MAX)) AS orders;

-- Expand JSON arrays
SELECT
    JSON_VALUE(jsonContent, '$.orderId') AS order_id,
    item.*
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/json/orders/*.jsonl',
    FORMAT = 'CSV',
    FIELDTERMINATOR = '0x0b',
    FIELDQUOTE = '0x0b'
) WITH (jsonContent NVARCHAR(MAX)) AS orders
CROSS APPLY OPENJSON(JSON_QUERY(jsonContent, '$.items'))
WITH (
    product_id INT '$.productId',
    quantity INT '$.quantity',
    unit_price DECIMAL(10,2) '$.unitPrice'
) AS item;
```

---

## Section 3: External Tables and Views

### Creating External Data Sources

```sql
-- Create database for external objects
CREATE DATABASE sales_lake;
GO

USE sales_lake;
GO

-- Create master key (required for credentials)
CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'YourStrongPassword123!';
GO

-- Create database scoped credential (for storage access)
CREATE DATABASE SCOPED CREDENTIAL StorageCredential
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = 'your-sas-token-here';
GO

-- Alternative: Use managed identity
CREATE DATABASE SCOPED CREDENTIAL ManagedIdentityCredential
WITH IDENTITY = 'Managed Identity';
GO

-- Create external data source
CREATE EXTERNAL DATA SOURCE SalesDataLake
WITH (
    LOCATION = 'https://yourstorageaccount.dfs.core.windows.net/data',
    CREDENTIAL = ManagedIdentityCredential
);
GO

-- Create external data source for Delta Lake
CREATE EXTERNAL DATA SOURCE DeltaLakeSource
WITH (
    LOCATION = 'https://yourstorageaccount.dfs.core.windows.net/delta'
);
GO
```

### Creating External File Formats

```sql
-- Parquet format
CREATE EXTERNAL FILE FORMAT ParquetFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);
GO

-- CSV format with header
CREATE EXTERNAL FILE FORMAT CsvWithHeader
WITH (
    FORMAT_TYPE = DELIMITEDTEXT,
    FORMAT_OPTIONS (
        FIELD_TERMINATOR = ',',
        STRING_DELIMITER = '"',
        FIRST_ROW = 2,
        USE_TYPE_DEFAULT = TRUE,
        ENCODING = 'UTF8'
    )
);
GO

-- Delta format
CREATE EXTERNAL FILE FORMAT DeltaFormat
WITH (
    FORMAT_TYPE = DELTA
);
GO
```

### Creating External Tables

```sql
-- External table on Parquet files
CREATE EXTERNAL TABLE dbo.Sales (
    product_id INT,
    product_name VARCHAR(100),
    category VARCHAR(50),
    price DECIMAL(10,2),
    quantity INT,
    sale_date DATE,
    region VARCHAR(50)
)
WITH (
    LOCATION = 'sales/2024/',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
);
GO

-- External table on Delta Lake
CREATE EXTERNAL TABLE dbo.SalesDelta (
    product_id INT,
    product_name VARCHAR(100),
    category VARCHAR(50),
    price DECIMAL(10,2),
    sale_date DATE
)
WITH (
    LOCATION = 'sales/',
    DATA_SOURCE = DeltaLakeSource,
    FILE_FORMAT = DeltaFormat
);
GO

-- Query external tables like regular tables
SELECT
    category,
    SUM(price * quantity) AS total_sales,
    COUNT(*) AS transaction_count
FROM dbo.Sales
WHERE sale_date >= '2024-01-01'
GROUP BY category
ORDER BY total_sales DESC;
```

### Creating Views

```sql
-- Simple view on external data
CREATE VIEW dbo.vw_RecentSales
AS
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/2024/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
WHERE sale_date >= DATEADD(day, -30, GETDATE());
GO

-- Aggregated view
CREATE VIEW dbo.vw_SalesByCategory
AS
SELECT
    category,
    CAST(sale_date AS DATE) AS sale_date,
    SUM(price * quantity) AS total_revenue,
    SUM(quantity) AS total_units,
    AVG(price) AS avg_price
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/**/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
GROUP BY category, CAST(sale_date AS DATE);
GO

-- View combining multiple sources
CREATE VIEW dbo.vw_SalesWithCustomers
AS
SELECT
    s.product_id,
    s.product_name,
    s.price,
    s.quantity,
    s.sale_date,
    c.customer_name,
    c.customer_segment
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/**/*.parquet',
    FORMAT = 'PARQUET'
) AS s
JOIN OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/customers/*.parquet',
    FORMAT = 'PARQUET'
) AS c ON s.customer_id = c.customer_id;
GO
```

---

## Section 4: Performance Optimization

### Partition Elimination

```sql
-- Use filepath() function for partition pruning
SELECT
    filepath(1) AS year,
    filepath(2) AS month,
    product_id,
    product_name,
    price
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/year=*/month=*/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
WHERE filepath(1) = '2024' AND filepath(2) = '01';

-- Partition-aware external table
CREATE EXTERNAL TABLE dbo.SalesPartitioned (
    product_id INT,
    product_name VARCHAR(100),
    price DECIMAL(10,2),
    quantity INT
)
WITH (
    LOCATION = 'sales/year=*/month=*/',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
);

-- Query with partition filter
SELECT *
FROM dbo.SalesPartitioned
WHERE $filepath LIKE '%year=2024%' AND $filepath LIKE '%month=01%';
```

### Column Projection

```sql
-- Only select needed columns (reduces data scanned)
SELECT
    product_id,
    product_name,
    price
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) WITH (
    product_id INT,
    product_name VARCHAR(100),
    price DECIMAL(10,2)
    -- Only specify columns you need
) AS sales;
```

### Statistics and Query Hints

```sql
-- Create statistics for better query plans
CREATE STATISTICS stats_sales_category ON dbo.Sales(category);
CREATE STATISTICS stats_sales_date ON dbo.Sales(sale_date);

-- Use query hints
SELECT *
FROM dbo.Sales
WHERE category = 'Electronics'
OPTION (
    MAXDOP 8,
    FORCE ORDER
);

-- Check query statistics
SET STATISTICS IO ON;
SET STATISTICS TIME ON;

SELECT category, COUNT(*)
FROM dbo.Sales
GROUP BY category;

SET STATISTICS IO OFF;
SET STATISTICS TIME OFF;
```

### File Layout Optimization

```sql
-- Check file sizes (should be 100MB-1GB for optimal performance)
SELECT
    r.filepath() AS file_path,
    COUNT(*) AS row_count
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/**/*.parquet',
    FORMAT = 'PARQUET'
) AS r
GROUP BY r.filepath()
ORDER BY row_count;

-- CETAS to reorganize data (Create External Table As Select)
CREATE EXTERNAL TABLE dbo.SalesOptimized
WITH (
    LOCATION = 'sales_optimized/',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
)
AS
SELECT *
FROM dbo.Sales
WHERE sale_date >= '2024-01-01';
```

---

## Section 5: Security Implementation

### Managed Identity Authentication

```sql
-- Use workspace managed identity (recommended)
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) AS sales;

-- Grant Storage Blob Data Reader role to Synapse managed identity
-- (Done in Azure Portal or via Azure CLI)
```

### SAS Token Authentication

```sql
-- Create credential with SAS token
CREATE DATABASE SCOPED CREDENTIAL SalesDataCredential
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = 'sv=2021-06-08&ss=bfqt&srt=sco&sp=rwdlacupitfx&se=2024-12-31T23:59:59Z&st=2024-01-01T00:00:00Z&spr=https&sig=xxx';
GO

-- Use credential in data source
CREATE EXTERNAL DATA SOURCE SecuredDataSource
WITH (
    LOCATION = 'https://yourstorageaccount.dfs.core.windows.net/secure-data',
    CREDENTIAL = SalesDataCredential
);
GO
```

### Row-Level Security

```sql
-- Create security predicate function
CREATE SCHEMA Security;
GO

CREATE FUNCTION Security.fn_SecurityPredicate(@Region AS VARCHAR(50))
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN SELECT 1 AS result
WHERE @Region = USER_NAME()
    OR USER_NAME() = 'admin';
GO

-- Apply security policy
CREATE SECURITY POLICY SalesSecurityPolicy
ADD FILTER PREDICATE Security.fn_SecurityPredicate(region)
ON dbo.Sales
WITH (STATE = ON);
GO
```

### Column-Level Security

```sql
-- Create view with column masking
CREATE VIEW dbo.vw_SalesMasked
AS
SELECT
    product_id,
    product_name,
    category,
    CASE
        WHEN IS_MEMBER('SalesManagers') = 1 THEN price
        ELSE NULL
    END AS price,
    CASE
        WHEN IS_MEMBER('SalesManagers') = 1 THEN customer_email
        ELSE CONCAT(LEFT(customer_email, 2), '***@***', RIGHT(customer_email, 4))
    END AS customer_email,
    sale_date
FROM dbo.Sales;
GO
```

---

## Section 6: Data Virtualization Patterns

### Logical Data Warehouse

```sql
-- Create database for logical DW
CREATE DATABASE LogicalDW;
GO

USE LogicalDW;
GO

-- Dimension tables (external)
CREATE EXTERNAL TABLE dim.Product (
    product_key INT,
    product_id VARCHAR(20),
    product_name VARCHAR(100),
    category VARCHAR(50),
    subcategory VARCHAR(50),
    brand VARCHAR(50)
)
WITH (
    LOCATION = 'dimensions/product/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = ParquetFormat
);

CREATE EXTERNAL TABLE dim.Customer (
    customer_key INT,
    customer_id VARCHAR(20),
    customer_name VARCHAR(100),
    segment VARCHAR(50),
    region VARCHAR(50),
    country VARCHAR(50)
)
WITH (
    LOCATION = 'dimensions/customer/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = ParquetFormat
);

CREATE EXTERNAL TABLE dim.Date (
    date_key INT,
    full_date DATE,
    year INT,
    quarter INT,
    month INT,
    month_name VARCHAR(20),
    day INT,
    day_of_week INT,
    is_weekend BIT
)
WITH (
    LOCATION = 'dimensions/date/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = ParquetFormat
);

-- Fact table (external on Delta Lake)
CREATE EXTERNAL TABLE fact.Sales (
    sale_key BIGINT,
    product_key INT,
    customer_key INT,
    date_key INT,
    quantity INT,
    unit_price DECIMAL(10,2),
    total_amount DECIMAL(12,2),
    discount_amount DECIMAL(10,2)
)
WITH (
    LOCATION = 'facts/sales/',
    DATA_SOURCE = DeltaLakeSource,
    FILE_FORMAT = DeltaFormat
);

-- Star schema query
SELECT
    d.year,
    d.quarter,
    p.category,
    c.segment,
    SUM(f.total_amount) AS total_revenue,
    SUM(f.quantity) AS total_units,
    COUNT(DISTINCT f.customer_key) AS unique_customers
FROM fact.Sales f
JOIN dim.Product p ON f.product_key = p.product_key
JOIN dim.Customer c ON f.customer_key = c.customer_key
JOIN dim.Date d ON f.date_key = d.date_key
WHERE d.year = 2024
GROUP BY d.year, d.quarter, p.category, c.segment
ORDER BY total_revenue DESC;
```

### Federated Queries

```sql
-- Create linked server to Azure SQL Database (if needed)
-- Note: This requires dedicated SQL pool, not serverless

-- Query combining lake data with external SQL
CREATE VIEW dbo.vw_EnrichedSales
AS
SELECT
    s.product_id,
    s.product_name,
    s.price,
    s.sale_date,
    ref.product_description,
    ref.manufacturer
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) AS s
JOIN OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/reference/products.parquet',
    FORMAT = 'PARQUET'
) AS ref ON s.product_id = ref.product_id;
GO
```

---

## Section 7: Monitoring and Troubleshooting

### Query Execution Monitoring

```sql
-- View recent query history
SELECT
    start_time,
    end_time,
    DATEDIFF(second, start_time, end_time) AS duration_seconds,
    data_processed_mb,
    status,
    error_id,
    query_text
FROM sys.dm_exec_requests_history
WHERE start_time >= DATEADD(hour, -24, GETUTCDATE())
ORDER BY start_time DESC;

-- View data processed per query
SELECT
    query_hash,
    COUNT(*) AS execution_count,
    AVG(data_processed_mb) AS avg_data_mb,
    MAX(data_processed_mb) AS max_data_mb,
    AVG(DATEDIFF(second, start_time, end_time)) AS avg_duration_sec
FROM sys.dm_exec_requests_history
WHERE start_time >= DATEADD(day, -7, GETUTCDATE())
GROUP BY query_hash
ORDER BY AVG(data_processed_mb) DESC;
```

### Common Errors and Solutions

```sql
-- Error: Cannot bulk load
-- Solution: Check file path and permissions
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/test.parquet',
    FORMAT = 'PARQUET'
) AS test;

-- Error: Schema mismatch
-- Solution: Use explicit WITH clause
SELECT *
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) WITH (
    -- Explicitly define expected schema
    product_id INT,
    price DECIMAL(10,2)
) AS sales;

-- Error: Memory exceeded
-- Solution: Use column projection and filters
SELECT product_id, price  -- Only needed columns
FROM OPENROWSET(
    BULK 'https://yourstorageaccount.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
WHERE sale_date >= '2024-01-01';  -- Add filters
```

---

## Exercises

### Exercise 1: Query Multiple Formats
Create views that query Parquet, CSV, and JSON files from the same database.

### Exercise 2: Build a Logical Data Warehouse
Implement a star schema using external tables on your data lake.

### Exercise 3: Optimize Query Performance
Take a slow query and optimize it using partition elimination and column projection.

---

## Best Practices Summary

| Practice | Recommendation |
|----------|----------------|
| File Format | Use Parquet or Delta for analytics workloads |
| File Size | Target 100 MB - 1 GB per file |
| Partitioning | Use year/month/day for time-series data |
| Column Projection | Only select columns you need |
| Authentication | Use managed identity when possible |
| Statistics | Create statistics on filter columns |
| Views | Use views for commonly accessed queries |

---

## Next Steps

- Continue to [Tutorial 10: Dedicated SQL Pools](10-dedicated-sql.md)
- Explore [Serverless SQL Best Practices](../../best-practices/serverless-sql-best-practices.md)
- Review [Serverless SQL Troubleshooting](../../troubleshooting/serverless-sql-troubleshooting.md)
