# ⚡ Serverless SQL Pools

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Pricing](https://img.shields.io/badge/Pricing-Pay%20per%20Query-blue?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Query data in your Azure Data Lake without provisioning or managing infrastructure. Pay only for the data processed by your queries.

---

## 🌟 Overview

Serverless SQL Pools provide an on-demand query execution service for data in Azure Data Lake Storage. No infrastructure to manage, automatic scaling, and T-SQL support for querying files directly.

### 🔥 Key Benefits

- __Zero Infrastructure Management__: No servers to provision or manage
- __Pay-per-Query Pricing__: Billed only for data processed (per TB)
- __T-SQL Compatibility__: Familiar SQL syntax for data lake queries
- __Automatic Scaling__: Scales automatically based on workload
- __Multi-Format Support__: Query Parquet, CSV, JSON, and Delta Lake files
- __Instant Access__: No cold start delays

---

## 🚀 Quick Start

### Query CSV Files

```sql
-- Query CSV files with automatic schema inference
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://mystorageaccount.dfs.core.windows.net/data/sales/2024/*.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE,
    FIRSTROW = 2
) AS sales_data
WHERE TotalAmount > 1000;
```

### Query Parquet Files

```sql
-- Query Parquet files (most efficient format)
SELECT
    ProductCategory,
    COUNT(*) as OrderCount,
    SUM(OrderAmount) as TotalRevenue,
    AVG(OrderAmount) as AvgOrderValue
FROM OPENROWSET(
    BULK 'https://mystorageaccount.dfs.core.windows.net/data/orders/**/*.parquet',
    FORMAT = 'PARQUET'
) AS orders
GROUP BY ProductCategory
ORDER BY TotalRevenue DESC;
```

---

## 📊 Working with External Tables

### Create External Data Source

```sql
CREATE DATABASE SalesAnalytics;
GO

USE SalesAnalytics;
GO

CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'YourStrongPassword123!';
GO

CREATE DATABASE SCOPED CREDENTIAL DataLakeCredential
WITH IDENTITY = 'Managed Identity';
GO

CREATE EXTERNAL DATA SOURCE SalesDataLake
WITH (
    LOCATION = 'https://mystorageaccount.dfs.core.windows.net/sales',
    CREDENTIAL = DataLakeCredential
);
GO
```

---

*Last Updated: 2025-01-28*
*Service Version: General Availability*
*Documentation Status: Complete*
