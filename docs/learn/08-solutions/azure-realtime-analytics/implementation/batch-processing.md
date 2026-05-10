# Batch Processing Setup

---

![Databricks](https://img.shields.io/badge/Databricks-FF3621?style=flat-square&logo=databricks&logoColor=white)
![Delta Lake](https://img.shields.io/badge/Delta_Lake-00ADD8?style=flat-square)
![Status](https://img.shields.io/badge/Status-Production_Ready-brightgreen?style=flat-square)

## Overview

This guide covers implementing batch processing pipelines using Azure Databricks and Delta Lake for scheduled data processing, aggregations, and ETL workflows.

## Table of Contents

- [Batch Job Patterns](#batch-job-patterns)
- [Data Factory Integration](#data-factory-integration)
- [Delta Lake Batch Operations](#delta-lake-batch-operations)
- [Performance Optimization](#performance-optimization)
- [Monitoring and Alerting](#monitoring-and-alerting)

---

## Batch Job Patterns

### Incremental Batch Processing

```python
from delta.tables import DeltaTable
from pyspark.sql.functions import *

def incremental_batch_load(source_table, target_table, watermark_column="updated_at"):
    """
    Incrementally load data using watermark
    """
    # Get last processed watermark
    last_watermark = spark.sql(f"""
        SELECT MAX({watermark_column}) as max_timestamp
        FROM {target_table}
    """).collect()[0]["max_timestamp"]

    # Read incremental data
    incremental_data = (spark
        .read
        .table(source_table)
        .filter(col(watermark_column) > lit(last_watermark))
    )

    # Merge into target
    target_delta = DeltaTable.forName(spark, target_table)

    target_delta.alias("target").merge(
        incremental_data.alias("source"),
        "target.id = source.id"
    ).whenMatchedUpdateAll(
    ).whenNotMatchedInsertAll(
    ).execute()

# Example usage
incremental_batch_load("bronze.events", "silver.events_validated")
```

### Full Refresh Pattern

```python
def full_refresh_with_swap(source_table, target_table):
    """
    Full refresh using table swap for zero downtime
    """
    temp_table = f"{target_table}_temp"

    # Process full dataset
    full_data = spark.table(source_table)

    # Apply transformations
    processed_data = (full_data
        .filter(col("is_valid") == True)
        .withColumn("processed_timestamp", current_timestamp())
    )

    # Write to temp table
    processed_data.write.mode("overwrite").saveAsTable(temp_table)

    # Swap tables atomically
    spark.sql(f"ALTER TABLE {target_table} RENAME TO {target_table}_old")
    spark.sql(f"ALTER TABLE {temp_table} RENAME TO {target_table}")

    # Drop old table
    spark.sql(f"DROP TABLE IF EXISTS {target_table}_old")
```

---

## Data Factory Integration

### ADF Pipeline Configuration

```json
{
  "name": "DailyBatchProcessing",
  "properties": {
    "activities": [
      {
        "name": "TriggerDatabricksJob",
        "type": "DatabricksNotebook",
        "typeProperties": {
          "notebookPath": "/Shared/BatchProcessing/daily_aggregation",
          "baseParameters": {
            "processing_date": "@{formatDateTime(pipeline().parameters.ProcessingDate, 'yyyy-MM-dd')}"
          }
        },
        "linkedServiceName": {
          "referenceName": "AzureDatabricks",
          "type": "LinkedServiceReference"
        }
      }
    ],
    "parameters": {
      "ProcessingDate": {
        "type": "string",
        "defaultValue": "@utcnow()"
      }
    },
    "annotations": []
  }
}
```

---

## Delta Lake Batch Operations

### Batch Merge Operations

```python
def batch_merge_scd_type2(source_df, target_table, business_keys, scd_columns):
    """
    Implement SCD Type 2 in batch mode
    """
    from delta.tables import DeltaTable

    target = DeltaTable.forName(spark, target_table)

    # Build merge condition
    merge_condition = " AND ".join([
        f"target.{key} = source.{key}" for key in business_keys
    ])
    merge_condition += " AND target.is_current = true"

    # Check for changes
    change_condition = " OR ".join([
        f"target.{col} != source.{col}" for col in scd_columns
    ])

    # Merge with SCD Type 2 logic
    target.alias("target").merge(
        source_df.alias("source"),
        merge_condition
    ).whenMatchedUpdate(
        condition=change_condition,
        set={
            "is_current": "false",
            "end_date": "source.effective_date"
        }
    ).whenNotMatchedInsert(
        values={
            **{key: f"source.{key}" for key in business_keys},
            **{col: f"source.{col}" for col in scd_columns},
            "is_current": "true",
            "start_date": "source.effective_date",
            "end_date": "cast(null as timestamp)"
        }
    ).execute()
```

### Batch Optimization

```python
def optimize_delta_tables(database_name):
    """
    Optimize all Delta tables in a database
    """
    tables = spark.sql(f"SHOW TABLES IN {database_name}").collect()

    for table in tables:
        table_name = f"{database_name}.{table.tableName}"

        print(f"Optimizing {table_name}...")

        # Optimize
        spark.sql(f"OPTIMIZE {table_name}")

        # Z-order by commonly queried columns
        spark.sql(f"OPTIMIZE {table_name} ZORDER BY (date, customer_id)")

        # Vacuum old files (7 days retention)
        spark.sql(f"VACUUM {table_name} RETAIN 168 HOURS")

        # Analyze statistics
        spark.sql(f"ANALYZE TABLE {table_name} COMPUTE STATISTICS FOR ALL COLUMNS")
```

---

## Performance Optimization

### Partition Pruning

```python
# Configure partition columns for better performance
spark.sql("""
    CREATE TABLE gold.customer_daily_metrics (
        customer_id STRING,
        metric_date DATE,
        total_revenue DECIMAL(10,2),
        event_count BIGINT
    )
    USING DELTA
    PARTITIONED BY (metric_date)
""")

# Query with partition pruning
df = spark.sql("""
    SELECT * FROM gold.customer_daily_metrics
    WHERE metric_date BETWEEN '2025-01-01' AND '2025-01-31'
""")
```

### Caching Strategy

```python
# Cache frequently accessed tables
spark.sql("CACHE TABLE gold.dim_customer")

# Execute batch job
result = spark.sql("""
    SELECT c.*, m.total_revenue
    FROM gold.dim_customer c
    JOIN gold.fact_metrics m ON c.customer_id = m.customer_id
""")

# Uncache after use
spark.sql("UNCACHE TABLE gold.dim_customer")
```

---

## Monitoring and Alerting

### Job Monitoring

```python
from datetime import datetime

def log_batch_job(job_name, status, records_processed):
    """
    Log batch job execution
    """
    log_entry = spark.createDataFrame([{
        "job_name": job_name,
        "status": status,
        "records_processed": records_processed,
        "execution_timestamp": datetime.now(),
        "cluster_id": spark.conf.get("spark.databricks.clusterUsageTags.clusterId")
    }])

    log_entry.write.mode("append").saveAsTable("monitoring.batch_job_logs")

# Usage
try:
    # Execute batch job
    result_df = incremental_batch_load(...)
    records = result_df.count()

    log_batch_job("daily_aggregation", "SUCCESS", records)
except Exception as e:
    log_batch_job("daily_aggregation", "FAILED", 0)
    raise
```

---

## Related Documentation

- [Stream Processing Setup](stream-processing.md)
- [Data Quality Implementation](data-quality.md)
- [Performance Optimization](../operations/performance.md)

---

**Last Updated:** January 2025
**Version:** 1.0.0
**Status:** Production Ready
