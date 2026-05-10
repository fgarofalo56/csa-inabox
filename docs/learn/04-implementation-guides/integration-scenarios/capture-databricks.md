# Change Data Capture with Databricks

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __Databricks CDC__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)

Implement CDC pipelines using Delta Lake Change Data Feed and Structured Streaming.

---

## Overview

Databricks provides native CDC capabilities through:

- **Delta Lake Change Data Feed (CDF)**: Track row-level changes in Delta tables
- **Structured Streaming**: Process changes in near real-time
- **Auto Loader**: Incrementally ingest new files

---

## Implementation

### Step 1: Enable Change Data Feed

```sql
-- Enable CDF on existing table
ALTER TABLE bronze.sales.orders SET TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- Create new table with CDF enabled
CREATE TABLE silver.sales.orders_cleaned (
    order_id BIGINT,
    customer_id STRING,
    order_date DATE,
    amount DECIMAL(18,2),
    status STRING
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true);
```

### Step 2: Read Change Data Feed

```python
# Read changes since specific version
changes_df = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 10) \
    .table("bronze.sales.orders")

# Read changes since timestamp
changes_df = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingTimestamp", "2024-01-01 00:00:00") \
    .table("bronze.sales.orders")

# Display change types
changes_df.select(
    "_change_type",  # insert, update_preimage, update_postimage, delete
    "_commit_version",
    "_commit_timestamp",
    "order_id",
    "amount"
).show()
```

### Step 3: Streaming CDC Pipeline

```python
from pyspark.sql.functions import *

def process_cdc_stream():
    """Process CDC changes as a streaming pipeline."""

    # Read CDC stream
    cdc_stream = spark.readStream.format("delta") \
        .option("readChangeFeed", "true") \
        .option("startingVersion", "latest") \
        .table("bronze.sales.orders")

    # Filter to only process relevant changes
    processed_stream = cdc_stream \
        .filter(col("_change_type").isin(["insert", "update_postimage"])) \
        .withColumn("processed_at", current_timestamp()) \
        .drop("_change_type", "_commit_version", "_commit_timestamp")

    # Write to silver layer
    query = processed_stream.writeStream \
        .format("delta") \
        .outputMode("append") \
        .option("checkpointLocation", "/checkpoints/orders_cdc") \
        .trigger(processingTime="1 minute") \
        .toTable("silver.sales.orders_stream")

    return query

# Start the streaming job
cdc_query = process_cdc_stream()
```

### Step 4: CDC with MERGE for Upserts

```python
from delta.tables import DeltaTable

def apply_cdc_with_merge(batch_df, batch_id):
    """Apply CDC changes using merge operation."""

    # Get target table
    target_table = DeltaTable.forName(spark, "silver.sales.orders_merged")

    # Separate inserts/updates from deletes
    upserts = batch_df.filter(
        col("_change_type").isin(["insert", "update_postimage"])
    ).drop("_change_type", "_commit_version", "_commit_timestamp")

    deletes = batch_df.filter(col("_change_type") == "delete")

    # Apply upserts
    if upserts.count() > 0:
        target_table.alias("target").merge(
            upserts.alias("source"),
            "target.order_id = source.order_id"
        ).whenMatchedUpdateAll() \
         .whenNotMatchedInsertAll() \
         .execute()

    # Apply deletes
    if deletes.count() > 0:
        delete_ids = [row.order_id for row in deletes.select("order_id").collect()]
        target_table.delete(col("order_id").isin(delete_ids))

# Run streaming merge
cdc_stream = spark.readStream.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", "latest") \
    .table("bronze.sales.orders")

merge_query = cdc_stream.writeStream \
    .foreachBatch(apply_cdc_with_merge) \
    .option("checkpointLocation", "/checkpoints/orders_merge") \
    .trigger(processingTime="5 minutes") \
    .start()
```

### Step 5: Auto Loader for File-Based CDC

```python
def setup_auto_loader_cdc(source_path: str, target_table: str):
    """Set up Auto Loader for incremental file ingestion."""

    stream = spark.readStream.format("cloudFiles") \
        .option("cloudFiles.format", "json") \
        .option("cloudFiles.schemaLocation", f"/schemas/{target_table}") \
        .option("cloudFiles.inferColumnTypes", "true") \
        .option("cloudFiles.schemaEvolutionMode", "addNewColumns") \
        .load(source_path)

    # Add metadata columns
    enriched = stream \
        .withColumn("_ingested_at", current_timestamp()) \
        .withColumn("_source_file", input_file_name())

    # Write with merge schema for schema evolution
    query = enriched.writeStream \
        .format("delta") \
        .outputMode("append") \
        .option("checkpointLocation", f"/checkpoints/{target_table}") \
        .option("mergeSchema", "true") \
        .trigger(availableNow=True) \
        .toTable(target_table)

    return query

# Usage
auto_loader_query = setup_auto_loader_cdc(
    source_path="abfss://landing@datalake.dfs.core.windows.net/orders/",
    target_table="bronze.sales.orders_raw"
)
```

---

## Monitoring CDC Pipelines

```python
def monitor_cdc_health(table_name: str):
    """Monitor CDC pipeline health metrics."""

    # Get table history
    history = spark.sql(f"DESCRIBE HISTORY {table_name}").toPandas()

    # Calculate metrics
    metrics = {
        "total_versions": len(history),
        "last_commit": history.iloc[0]["timestamp"],
        "operations_24h": len(history[history["timestamp"] > (datetime.now() - timedelta(days=1))]),
        "avg_rows_per_commit": history["operationMetrics"].apply(
            lambda x: x.get("numOutputRows", 0) if x else 0
        ).mean()
    }

    return metrics

# Create monitoring dashboard query
spark.sql("""
    SELECT
        table_name,
        MAX(_commit_timestamp) as last_change,
        COUNT(DISTINCT _commit_version) as version_count,
        SUM(CASE WHEN _change_type = 'insert' THEN 1 ELSE 0 END) as inserts,
        SUM(CASE WHEN _change_type LIKE 'update%' THEN 1 ELSE 0 END) as updates,
        SUM(CASE WHEN _change_type = 'delete' THEN 1 ELSE 0 END) as deletes
    FROM cdc_monitoring_view
    GROUP BY table_name
""")
```

---

## Related Documentation

- [Data Factory CDC](capture-data-factory.md)
- [Delta Lake Best Practices](../../05-best-practices/service-specific/databricks.md)
- [Streaming Architectures](../../03-architecture-patterns/streaming-architectures/README.md)

---

*Last Updated: January 2025*
