---
title: "️ Data Lakehouse Integration Tutorial"
description: "Build a complete data lakehouse architecture using Azure Synapse and Delta Lake. Implement medallion architecture with bronze, silver, and gold layers."
tags:
  - tutorials
  - integration
---
# 🏞️ Data Lakehouse Integration Tutorial

![Level](https://img.shields.io/badge/Level-Intermediate-orange)
![Duration](https://img.shields.io/badge/Duration-3--4_hours-green)

Build a complete data lakehouse architecture using Azure Synapse and Delta Lake. Implement medallion architecture with bronze, silver, and gold layers.

## 🎯 Learning Objectives

- ✅ **Design lakehouse architecture** with medallion pattern
- ✅ **Implement Delta Lake** for ACID transactions
- ✅ **Build data quality** frameworks
- ✅ **Create unified analytics** with SQL and Spark
- ✅ **Optimize performance** for lakehouse queries

## 📋 Prerequisites

- Understanding of data lake concepts
- Completed [Delta Lake Deep Dive](../code-labs/delta-lake-deep-dive.md)
- Synapse workspace with Spark pool
- Delta Lake enabled

## 🏗️ Architecture Overview

### **Medallion Architecture**

```plaintext
┌─────────────────────────────────────────────────────────────┐
│                      GOLD LAYER                             │
│  (Business-level aggregations, ML features, dashboards)     │
│                    Delta Tables                             │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
┌─────────────────────────────────────────────────────────────┐
│                     SILVER LAYER                            │
│  (Cleaned, conformed, enriched data)                        │
│                    Delta Tables                             │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
┌─────────────────────────────────────────────────────────────┐
│                     BRONZE LAYER                            │
│  (Raw data ingestion, no transformations)                   │
│                    Delta Tables                             │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Implementation Guide

### **Module 1: Bronze Layer - Raw Ingestion**

```python
from delta.tables import DeltaTable

# Configure storage paths
bronze_path = "abfss://bronze@datalake.dfs.core.windows.net/"
silver_path = "abfss://silver@datalake.dfs.core.windows.net/"
gold_path = "abfss://gold@datalake.dfs.core.windows.net/"

# Ingest raw data to bronze
raw_df = spark.read \
    .format("json") \
    .option("inferSchema", "true") \
    .load("abfss://landing@datalake.dfs.core.windows.net/sales/")

# Add metadata columns
bronze_df = raw_df \
    .withColumn("ingestion_timestamp", current_timestamp()) \
    .withColumn("source_file", input_file_name()) \
    .withColumn("processing_date", current_date())

# Write to bronze layer
bronze_df.write \
    .format("delta") \
    .mode("append") \
    .partitionBy("processing_date") \
    .save(f"{bronze_path}/sales/")

print(f"Ingested {bronze_df.count()} records to bronze layer")
```

### **Module 2: Silver Layer - Cleansing & Enrichment**

```python
from pyspark.sql.functions import *
from delta.tables import DeltaTable

# Read from bronze
bronze_sales = spark.read.format("delta").load(f"{bronze_path}/sales/")

# Data quality checks and cleansing
silver_df = bronze_sales \
    .filter(col("transaction_id").isNotNull()) \
    .filter(col("amount") > 0) \
    .filter(col("customer_id").isNotNull()) \
    .withColumn("amount", round(col("amount"), 2)) \
    .withColumn("category", upper(trim(col("category")))) \
    .withColumn("transaction_date", to_date(col("transaction_timestamp"))) \
    .dropDuplicates(["transaction_id"]) \
    .withColumn("data_quality_score", lit(1.0)) \
    .withColumn("silver_timestamp", current_timestamp())

# Enrich with reference data
customers_df = spark.read.format("delta").load(f"{silver_path}/customers/")

enriched_df = silver_df \
    .join(customers_df, "customer_id", "left") \
    .select(
        silver_df["*"],
        customers_df["customer_name"],
        customers_df["customer_segment"],
        customers_df["customer_tier"]
    )

# Merge into silver layer (SCD Type 1)
if DeltaTable.isDeltaTable(spark, f"{silver_path}/sales/"):
    silver_table = DeltaTable.forPath(spark, f"{silver_path}/sales/")

    silver_table.alias("target") \
        .merge(
            enriched_df.alias("source"),
            "target.transaction_id = source.transaction_id"
        ) \
        .whenMatchedUpdateAll() \
        .whenNotMatchedInsertAll() \
        .execute()
else:
    enriched_df.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("transaction_date") \
        .save(f"{silver_path}/sales/")
```

### **Module 3: Gold Layer - Business Aggregations**

```python
# Read from silver
silver_sales = spark.read.format("delta").load(f"{silver_path}/sales/")

# Create gold layer aggregations for analytics
daily_sales_summary = silver_sales \
    .groupBy("transaction_date", "category", "customer_segment") \
    .agg(
        count("*").alias("transaction_count"),
        sum("amount").alias("total_revenue"),
        avg("amount").alias("avg_transaction_value"),
        countDistinct("customer_id").alias("unique_customers"),
        max("amount").alias("max_transaction")
    ) \
    .withColumn("revenue_per_customer", col("total_revenue") / col("unique_customers")) \
    .withColumn("gold_timestamp", current_timestamp())

# Write to gold layer
daily_sales_summary.write \
    .format("delta") \
    .mode("overwrite") \
    .partitionBy("transaction_date") \
    .save(f"{gold_path}/daily_sales_summary/")

# Create ML features
customer_features = silver_sales \
    .groupBy("customer_id") \
    .agg(
        count("*").alias("total_transactions"),
        sum("amount").alias("lifetime_value"),
        avg("amount").alias("avg_order_value"),
        max("transaction_date").alias("last_purchase_date"),
        countDistinct("category").alias("category_diversity")
    ) \
    .withColumn("days_since_last_purchase",
                datediff(current_date(), col("last_purchase_date")))

customer_features.write \
    .format("delta") \
    .mode("overwrite") \
    .save(f"{gold_path}/customer_features/")
```

### **Module 4: Unified Analytics**

```sql
-- Create Synapse database
CREATE DATABASE LakehouseDB;

USE LakehouseDB;

-- Create external tables pointing to Delta Lake
CREATE EXTERNAL TABLE sales_bronze
USING DELTA
LOCATION 'abfss://bronze@datalake.dfs.core.windows.net/sales/';

CREATE EXTERNAL TABLE sales_silver
USING DELTA
LOCATION 'abfss://silver@datalake.dfs.core.windows.net/sales/';

CREATE EXTERNAL TABLE daily_sales_summary
USING DELTA
LOCATION 'abfss://gold@datalake.dfs.core.windows.net/daily_sales_summary/';

-- Query across layers
SELECT
    g.transaction_date,
    g.category,
    g.total_revenue,
    g.transaction_count,
    COUNT(DISTINCT s.customer_id) as actual_customers
FROM daily_sales_summary g
JOIN sales_silver s
    ON g.transaction_date = s.transaction_date
    AND g.category = s.category
GROUP BY g.transaction_date, g.category, g.total_revenue, g.transaction_count;
```

## 🎯 Best Practices

- **Bronze**: Keep raw data unchanged, add metadata
- **Silver**: Enforce data quality, deduplicate, conform schema
- **Gold**: Create business-specific aggregations and features
- **Delta Lake**: Use ACID transactions, time travel, optimize regularly
- **Partitioning**: Partition by date for better query performance

## 📚 Additional Resources

- [Medallion Architecture](https://docs.delta.io/latest/best-practices.html#medallion-architecture)
- [Delta Lake Best Practices](https://docs.delta.io/latest/best-practices.html)
- [Azure Synapse Lake Database](https://docs.microsoft.com/azure/synapse-analytics/database-designer/concepts-lake-database)

---

*Last Updated: January 2025*
