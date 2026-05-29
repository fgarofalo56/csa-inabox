---
title: "Azure Synapse Analytics Code Examples"
description: "Comprehensive code examples for Azure Synapse Analytics covering Spark pools, SQL pools, and data processing patterns."
tags:
  - code-examples
  - by-service
  - synapse
---
# 📊 Azure Synapse Analytics Code Examples

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


![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Beginner_to_Advanced-blue?style=flat-square)
![Languages](https://img.shields.io/badge/Languages-PySpark_|_T--SQL_|_Spark_SQL-orange?style=flat-square)

Comprehensive code examples for Azure Synapse Analytics covering Spark pools, SQL pools, and data processing patterns.

---

## 📋 Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [PySpark Examples](#pyspark-examples)
- [T-SQL Examples](#t-sql-examples)
- [Performance Optimization](#performance-optimization)
- [Best Practices](#best-practices)

---

## 🌟 Overview

This section provides production-ready code examples for Azure Synapse Analytics, organized by compute engine and complexity level.

### Complexity Levels

| Level | Description | Examples |
|-------|-------------|----------|
| ![Beginner](https://img.shields.io/badge/Level-Beginner-green?style=flat-square) | Basic operations | Data loading, simple queries |
| ![Intermediate](https://img.shields.io/badge/Level-Intermediate-orange?style=flat-square) | Data transformations | Joins, aggregations |
| ![Advanced](https://img.shields.io/badge/Level-Advanced-red?style=flat-square) | Advanced operations | Delta Lake, tuning |

---

## 📝 Prerequisites

### Azure Resources

- Azure Synapse Analytics workspace
- Apache Spark pool (for PySpark examples)
- Serverless SQL pool (built-in)
- Azure Data Lake Storage Gen2 account

### Development Environment

```bash
# Install required tools
pip install pyspark==3.3.0
pip install azure-storage-file-datalake
pip install azure-identity
```

### Permissions

- Storage Blob Data Contributor (on ADLS Gen2)
- Synapse Contributor (on Synapse workspace)
- Synapse SQL Administrator (for SQL operations)

---

## 🐍 PySpark Examples

### Example 1: Basic DataFrame Operations

![Complexity](https://img.shields.io/badge/Complexity-Beginner-green?style=flat-square)

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, sum as _sum, avg, count

# Initialize Spark session
spark = SparkSession.builder.appName("BasicOperations").getOrCreate()

# Read CSV file from data lake
df = spark.read \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .csv("abfss://container@storage.dfs.core.windows.net/data/sales.csv")

# Display schema
df.printSchema()

# Basic transformations
transformed_df = df \
    .filter(col("order_status") == "completed") \
    .select("order_id", "customer_id", "total_amount") \
    .orderBy(col("total_amount").desc())

# Show top 10 results
transformed_df.show(10)

# Compute aggregations
summary = df \
    .groupBy("product_category") \
    .agg(
        _sum("total_amount").alias("total_sales"),
        avg("total_amount").alias("avg_order_value"),
        count("order_id").alias("order_count")
    ) \
    .orderBy(col("total_sales").desc())

summary.show()
```

__Expected Output:__

```text+----------------+-----------+---------------+-----------+
|product_category|total_sales|avg_order_value|order_count|
+----------------+-----------+---------------+-----------+
|Electronics     |1234567.89 |456.78         |2703       |
|Clothing        |987654.32  |123.45         |8000       |
+----------------+-----------+---------------+-----------+
```

---

### Example 2: Advanced Data Transformation

![Complexity](https://img.shields.io/badge/Complexity-Intermediate-orange?style=flat-square)

```python
from pyspark.sql.functions import (
    col, when, year, month, concat_ws,
    sum as _sum, count, avg, round as _round,
    row_number
)
from pyspark.sql.window import Window

# Read data
orders = spark.read.format("delta").load("/mnt/delta/orders")
customers = spark.read.format("delta").load("/mnt/delta/customers")

# Join and enrich
enriched = orders \
    .join(customers, "customer_id", "left") \
    .withColumn("order_year", year(col("order_date"))) \
    .withColumn("order_month", month(col("order_date"))) \
    .withColumn(
        "customer_tier",
        when(col("customer_segment") == "Premium", "Tier 1")
        .otherwise("Tier 2")
    )

# Window functions
window_spec = Window.partitionBy("customer_id").orderBy(col("order_date").desc())

result = enriched \
    .withColumn("order_rank", row_number().over(window_spec)) \
    .filter(col("order_rank") <= 5)

# Show results
result.select("customer_id", "order_date", "total_amount", "order_rank").show()
```

---

## 🗄️ T-SQL Examples

### Example 1: Serverless SQL - Query Data Lake

![Complexity](https://img.shields.io/badge/Complexity-Beginner-green?style=flat-square)

```sql
-- Query CSV files directly
SELECT TOP 100
    *
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/sales/*.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE
) AS [sales_data]
ORDER BY [order_date] DESC;

-- Query with explicit schema
SELECT
    order_id,
    customer_id,
    CAST(order_date AS DATE) AS order_date,
    CAST(total_amount AS DECIMAL(10,2)) AS total_amount
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/sales/*.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE
)
WITH (
    order_id VARCHAR(50),
    customer_id VARCHAR(50),
    order_date VARCHAR(50),
    total_amount VARCHAR(20)
) AS [sales_data]
WHERE CAST(order_date AS DATE) >= '2024-01-01';
```

---

### Example 2: Create External Tables

![Complexity](https://img.shields.io/badge/Complexity-Intermediate-orange?style=flat-square)

```sql
-- Create database
CREATE DATABASE SalesAnalytics;
GO

USE SalesAnalytics;
GO

-- Create external data source
CREATE EXTERNAL DATA SOURCE SalesDataLake
WITH (
    LOCATION = 'https://storage.dfs.core.windows.net/sales'
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
CREATE EXTERNAL TABLE [dbo].[sales_external]
(
    [order_id] VARCHAR(50),
    [customer_id] VARCHAR(50),
    [order_date] DATE,
    [total_amount] DECIMAL(10,2)
)
WITH (
    LOCATION = '/sales/*.parquet',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
);
GO

-- Query external table
SELECT
    product_category,
    COUNT(*) AS order_count,
    SUM(total_amount) AS total_revenue
FROM [dbo].[sales_external]
WHERE order_date >= '2024-01-01'
GROUP BY product_category;
```

---

## ⚡ Performance Optimization

### Partitioning Strategy

```python
from pyspark.sql.functions import year, month

# Optimal partitioning
df.withColumn("year", year("order_date")) \
  .withColumn("month", month("order_date")) \
  .write \
  .format("delta") \
  .partitionBy("year", "month") \
  .mode("overwrite") \
  .save("/mnt/delta/orders")
```

### Caching

```python
# Cache frequently accessed data
df.cache()
result = df.filter(col("status") == "active").count()
df.unpersist()
```

---

## 💡 Best Practices

1. __Use Delta Lake__ for ACID transactions
2. __Partition strategically__ based on query patterns
3. __Cache wisely__ for iterative operations
4. __Monitor performance__ using Spark UI
5. __Optimize file sizes__ (128MB - 1GB recommended)

---

*Last Updated: 2025-12-09*
*Version: 1.0.0*
