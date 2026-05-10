# Tutorial 8: Delta Lake Operations

## Overview

This tutorial covers Delta Lake operations in Azure Synapse Analytics, including ACID transactions, time travel, schema evolution, and optimization techniques for building reliable data lakehouse architectures.

## Prerequisites

- Completed [Tutorial 7: PySpark Processing](07-pyspark-processing.md)
- Understanding of data lake concepts
- Familiarity with ACID properties

## Learning Objectives

By the end of this tutorial, you will be able to:

- Create and manage Delta tables
- Implement ACID transactions
- Use time travel for data versioning
- Perform schema evolution operations
- Optimize Delta tables for performance
- Implement CDC patterns with Delta Lake

---

## Section 1: Introduction to Delta Lake

### What is Delta Lake?

Delta Lake is an open-source storage layer that brings ACID transactions to Apache Spark and big data workloads. It provides:

- **ACID Transactions**: Serializable isolation levels ensure data integrity
- **Scalable Metadata**: Spark handles metadata at scale
- **Time Travel**: Access and revert to earlier versions of data
- **Schema Enforcement**: Prevents bad data from corrupting tables
- **Schema Evolution**: Allows schema changes without rewriting data

### Delta Lake Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Delta Lake Table                          │
├─────────────────────────────────────────────────────────────┤
│  Transaction Log (_delta_log/)                               │
│  ├── 00000000000000000000.json                              │
│  ├── 00000000000000000001.json                              │
│  ├── 00000000000000000002.json                              │
│  └── ...checkpoint files...                                  │
├─────────────────────────────────────────────────────────────┤
│  Data Files (Parquet)                                        │
│  ├── part-00000-xxx.parquet                                 │
│  ├── part-00001-xxx.parquet                                 │
│  └── ...                                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Section 2: Creating Delta Tables

### Method 1: Create from DataFrame

```python
from pyspark.sql import SparkSession
from pyspark.sql.types import *

# Initialize Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("DeltaLakeTutorial") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Storage configuration
storage_account = "yourstorageaccount"
container = "data"
delta_path = f"abfss://{container}@{storage_account}.dfs.core.windows.net/delta/sales"

# Create sample data
data = [
    (1, "Product A", "Electronics", 299.99, "2024-01-15"),
    (2, "Product B", "Clothing", 49.99, "2024-01-16"),
    (3, "Product C", "Electronics", 199.99, "2024-01-17"),
    (4, "Product D", "Home", 89.99, "2024-01-18"),
    (5, "Product E", "Clothing", 79.99, "2024-01-19")
]

schema = StructType([
    StructField("product_id", IntegerType(), False),
    StructField("product_name", StringType(), True),
    StructField("category", StringType(), True),
    StructField("price", DoubleType(), True),
    StructField("sale_date", StringType(), True)
])

df = spark.createDataFrame(data, schema)

# Write as Delta table
df.write \
    .format("delta") \
    .mode("overwrite") \
    .save(delta_path)

print(f"Delta table created at: {delta_path}")
```

### Method 2: Create Managed Table

```python
# Create database
spark.sql("CREATE DATABASE IF NOT EXISTS sales_db")

# Create managed Delta table
spark.sql("""
    CREATE TABLE IF NOT EXISTS sales_db.products (
        product_id INT NOT NULL,
        product_name STRING,
        category STRING,
        price DOUBLE,
        sale_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    USING DELTA
    PARTITIONED BY (category)
    COMMENT 'Product sales data'
    TBLPROPERTIES (
        'delta.autoOptimize.optimizeWrite' = 'true',
        'delta.autoOptimize.autoCompact' = 'true'
    )
""")

# Describe table
spark.sql("DESCRIBE EXTENDED sales_db.products").show(truncate=False)
```

### Method 3: Convert Existing Parquet

```python
from delta.tables import DeltaTable

parquet_path = f"abfss://{container}@{storage_account}.dfs.core.windows.net/parquet/legacy_data"

# Convert Parquet to Delta
DeltaTable.convertToDelta(spark, f"parquet.`{parquet_path}`")

print("Parquet table converted to Delta format")
```

---

## Section 3: ACID Transactions

### Insert Operations

```python
from delta.tables import DeltaTable
from pyspark.sql.functions import *

# Get Delta table reference
delta_table = DeltaTable.forPath(spark, delta_path)

# Insert new records
new_data = [
    (6, "Product F", "Electronics", 349.99, "2024-01-20"),
    (7, "Product G", "Home", 129.99, "2024-01-21")
]

new_df = spark.createDataFrame(new_data, schema)

# Append data
new_df.write \
    .format("delta") \
    .mode("append") \
    .save(delta_path)

# Verify insert
spark.read.format("delta").load(delta_path).show()
```

### Update Operations

```python
# Update specific records
delta_table.update(
    condition="category = 'Electronics'",
    set={"price": "price * 1.1"}  # 10% price increase
)

# Update with complex conditions
delta_table.update(
    condition=(col("product_id") == 1) & (col("price") < 350),
    set={
        "price": lit(329.99),
        "product_name": lit("Product A - Updated")
    }
)

# Verify updates
delta_table.toDF().filter("category = 'Electronics'").show()
```

### Delete Operations

```python
# Delete specific records
delta_table.delete(condition="price < 50")

# Delete with complex condition
delta_table.delete(
    condition=(col("category") == "Clothing") & (col("sale_date") < "2024-01-17")
)

# Verify deletions
delta_table.toDF().show()
```

### Merge (Upsert) Operations

```python
# Source data for merge
updates = [
    (1, "Product A Premium", "Electronics", 399.99, "2024-01-22"),  # Update
    (8, "Product H", "Sports", 159.99, "2024-01-22"),  # Insert
    (9, "Product I", "Electronics", 249.99, "2024-01-22")  # Insert
]

updates_df = spark.createDataFrame(updates, schema)

# Perform merge operation
delta_table.alias("target") \
    .merge(
        updates_df.alias("source"),
        "target.product_id = source.product_id"
    ) \
    .whenMatchedUpdate(set={
        "product_name": "source.product_name",
        "price": "source.price",
        "sale_date": "source.sale_date"
    }) \
    .whenNotMatchedInsert(values={
        "product_id": "source.product_id",
        "product_name": "source.product_name",
        "category": "source.category",
        "price": "source.price",
        "sale_date": "source.sale_date"
    }) \
    .execute()

print("Merge operation completed")
delta_table.toDF().orderBy("product_id").show()
```

### Conditional Merge Operations

```python
# Merge with conditions
delta_table.alias("target") \
    .merge(
        updates_df.alias("source"),
        "target.product_id = source.product_id"
    ) \
    .whenMatchedUpdate(
        condition="source.price > target.price",  # Only update if new price is higher
        set={
            "price": "source.price",
            "sale_date": "source.sale_date"
        }
    ) \
    .whenMatchedDelete(
        condition="source.price <= 0"  # Delete if price is zero or negative
    ) \
    .whenNotMatchedInsert(
        condition="source.price > 0",  # Only insert positive prices
        values={
            "product_id": "source.product_id",
            "product_name": "source.product_name",
            "category": "source.category",
            "price": "source.price",
            "sale_date": "source.sale_date"
        }
    ) \
    .execute()
```

---

## Section 4: Time Travel

### View Table History

```python
# Get table history
history_df = delta_table.history()
history_df.select("version", "timestamp", "operation", "operationMetrics").show(truncate=False)

# Using SQL
spark.sql(f"DESCRIBE HISTORY delta.`{delta_path}`").show()
```

### Query Historical Versions

```python
# Query by version number
df_version_0 = spark.read \
    .format("delta") \
    .option("versionAsOf", 0) \
    .load(delta_path)

print("Data at version 0:")
df_version_0.show()

# Query by timestamp
df_timestamp = spark.read \
    .format("delta") \
    .option("timestampAsOf", "2024-01-20 10:00:00") \
    .load(delta_path)

print("Data as of specific timestamp:")
df_timestamp.show()

# Using SQL
spark.sql(f"""
    SELECT * FROM delta.`{delta_path}` VERSION AS OF 2
""").show()

spark.sql(f"""
    SELECT * FROM delta.`{delta_path}` TIMESTAMP AS OF '2024-01-20 10:00:00'
""").show()
```

### Restore to Previous Version

```python
# Restore table to a previous version
delta_table.restoreToVersion(2)

# Or restore to timestamp
delta_table.restoreToTimestamp("2024-01-20 10:00:00")

# Verify restoration
delta_table.toDF().show()
```

### Compare Versions

```python
# Get two versions for comparison
version_0 = spark.read.format("delta").option("versionAsOf", 0).load(delta_path)
version_current = spark.read.format("delta").load(delta_path)

# Find new records
new_records = version_current.subtract(version_0)
print("New records added:")
new_records.show()

# Find deleted records
deleted_records = version_0.subtract(version_current)
print("Deleted records:")
deleted_records.show()

# Find modified records (join on key, filter where values differ)
modified = version_current.alias("current") \
    .join(version_0.alias("old"), "product_id") \
    .filter("current.price != old.price OR current.product_name != old.product_name") \
    .select(
        col("product_id"),
        col("old.price").alias("old_price"),
        col("current.price").alias("new_price"),
        col("old.product_name").alias("old_name"),
        col("current.product_name").alias("new_name")
    )

print("Modified records:")
modified.show()
```

---

## Section 5: Schema Evolution

### Add New Columns

```python
# Enable schema evolution
spark.conf.set("spark.databricks.delta.schema.autoMerge.enabled", "true")

# New data with additional column
new_schema_data = [
    (10, "Product J", "Electronics", 299.99, "2024-01-23", "USA"),
    (11, "Product K", "Home", 199.99, "2024-01-23", "UK")
]

new_schema = StructType([
    StructField("product_id", IntegerType(), False),
    StructField("product_name", StringType(), True),
    StructField("category", StringType(), True),
    StructField("price", DoubleType(), True),
    StructField("sale_date", StringType(), True),
    StructField("region", StringType(), True)  # New column
])

new_df = spark.createDataFrame(new_schema_data, new_schema)

# Write with schema merge
new_df.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .save(delta_path)

# Verify schema evolution
delta_table.toDF().printSchema()
delta_table.toDF().show()
```

### Replace Schema (Overwrite)

```python
# Complete schema replacement
completely_new_schema = StructType([
    StructField("id", IntegerType(), False),
    StructField("name", StringType(), True),
    StructField("value", DoubleType(), True),
    StructField("timestamp", TimestampType(), True)
])

# This will replace the entire schema
# Use with caution - this overwrites the table
new_data_df = spark.createDataFrame([], completely_new_schema)
new_data_df.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save(delta_path)
```

### Schema Enforcement

```python
# Schema enforcement prevents bad data
bad_data = [
    ("not_an_int", "Product Bad", "Electronics", 299.99, "2024-01-23")
]

bad_schema = StructType([
    StructField("product_id", StringType(), False),  # Wrong type!
    StructField("product_name", StringType(), True),
    StructField("category", StringType(), True),
    StructField("price", DoubleType(), True),
    StructField("sale_date", StringType(), True)
])

bad_df = spark.createDataFrame(bad_data, bad_schema)

try:
    # This will fail due to schema mismatch
    bad_df.write \
        .format("delta") \
        .mode("append") \
        .save(delta_path)
except Exception as e:
    print(f"Schema enforcement prevented bad data: {e}")
```

---

## Section 6: Performance Optimization

### OPTIMIZE Command

```python
# Compact small files
spark.sql(f"OPTIMIZE delta.`{delta_path}`")

# Optimize with Z-ordering for query performance
spark.sql(f"""
    OPTIMIZE delta.`{delta_path}`
    ZORDER BY (category, sale_date)
""")

# Using Python API
from delta.tables import DeltaTable

delta_table = DeltaTable.forPath(spark, delta_path)
delta_table.optimize().executeCompaction()

# With Z-ordering
delta_table.optimize().executeZOrderBy("category", "sale_date")
```

### VACUUM Command

```python
# Set retention period (default is 7 days)
spark.conf.set("spark.databricks.delta.retentionDurationCheck.enabled", "false")

# Remove files older than 168 hours (7 days)
spark.sql(f"VACUUM delta.`{delta_path}` RETAIN 168 HOURS")

# Dry run first to see what would be deleted
spark.sql(f"VACUUM delta.`{delta_path}` RETAIN 168 HOURS DRY RUN")

# Using Python API
delta_table.vacuum(168)  # hours
```

### Auto-Optimization Settings

```python
# Enable auto-optimization at table level
spark.sql(f"""
    ALTER TABLE delta.`{delta_path}`
    SET TBLPROPERTIES (
        'delta.autoOptimize.optimizeWrite' = 'true',
        'delta.autoOptimize.autoCompact' = 'true',
        'delta.targetFileSize' = '134217728'  -- 128 MB
    )
""")

# Session-level settings
spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
spark.conf.set("spark.databricks.delta.autoCompact.enabled", "true")
```

### Partitioning Best Practices

```python
# Create partitioned Delta table
partitioned_path = f"abfss://{container}@{storage_account}.dfs.core.windows.net/delta/sales_partitioned"

df.write \
    .format("delta") \
    .mode("overwrite") \
    .partitionBy("category") \
    .save(partitioned_path)

# Query with partition pruning
spark.read \
    .format("delta") \
    .load(partitioned_path) \
    .filter("category = 'Electronics'") \
    .explain(True)  # Check for partition pruning in plan
```

---

## Section 7: Change Data Capture (CDC)

### Enable Change Data Feed

```python
# Enable CDF on existing table
spark.sql(f"""
    ALTER TABLE delta.`{delta_path}`
    SET TBLPROPERTIES (delta.enableChangeDataFeed = true)
""")

# Create table with CDF enabled
spark.sql("""
    CREATE TABLE sales_db.cdc_enabled_table (
        id INT,
        name STRING,
        value DOUBLE,
        updated_at TIMESTAMP
    )
    USING DELTA
    TBLPROPERTIES (delta.enableChangeDataFeed = true)
""")
```

### Read Change Data Feed

```python
# Read changes from specific version
changes_df = spark.read \
    .format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 5) \
    .load(delta_path)

changes_df.show()

# Read changes within timestamp range
changes_df = spark.read \
    .format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingTimestamp", "2024-01-20 00:00:00") \
    .option("endingTimestamp", "2024-01-22 23:59:59") \
    .load(delta_path)

# Filter by change type
inserts = changes_df.filter("_change_type = 'insert'")
updates_before = changes_df.filter("_change_type = 'update_preimage'")
updates_after = changes_df.filter("_change_type = 'update_postimage'")
deletes = changes_df.filter("_change_type = 'delete'")

print(f"Inserts: {inserts.count()}")
print(f"Updates: {updates_after.count()}")
print(f"Deletes: {deletes.count()}")
```

### Streaming CDC

```python
# Stream changes as they happen
changes_stream = spark.readStream \
    .format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 0) \
    .load(delta_path)

# Process stream
query = changes_stream \
    .writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", f"{delta_path}/_checkpoints/cdc_stream") \
    .trigger(processingTime="10 seconds") \
    .start(f"{delta_path}_cdc_target")
```

---

## Section 8: Advanced Patterns

### Slowly Changing Dimensions (SCD Type 2)

```python
from pyspark.sql.functions import *
from delta.tables import DeltaTable

# SCD Type 2 implementation
def apply_scd_type2(spark, target_path, source_df, key_columns, tracked_columns):
    """
    Implement SCD Type 2 pattern for dimension tables.
    """
    current_ts = current_timestamp()

    # Add SCD columns to source
    source_with_scd = source_df \
        .withColumn("effective_date", current_ts) \
        .withColumn("end_date", lit(None).cast("timestamp")) \
        .withColumn("is_current", lit(True))

    # Check if target exists
    try:
        target_table = DeltaTable.forPath(spark, target_path)

        # Build merge condition
        merge_condition = " AND ".join([f"target.{c} = source.{c}" for c in key_columns])
        merge_condition += " AND target.is_current = true"

        # Build change detection condition
        change_condition = " OR ".join([f"target.{c} != source.{c}" for c in tracked_columns])

        # Merge with SCD Type 2 logic
        target_table.alias("target") \
            .merge(
                source_with_scd.alias("source"),
                merge_condition
            ) \
            .whenMatchedUpdate(
                condition=change_condition,
                set={
                    "end_date": current_ts,
                    "is_current": lit(False)
                }
            ) \
            .whenNotMatchedInsertAll() \
            .execute()

        # Insert new versions for changed records
        changed_records = source_with_scd.alias("source") \
            .join(
                target_table.toDF().filter("is_current = false AND end_date IS NOT NULL").alias("target"),
                [source_with_scd[c] == target_table.toDF()[c] for c in key_columns]
            ) \
            .select("source.*")

        if changed_records.count() > 0:
            changed_records.write \
                .format("delta") \
                .mode("append") \
                .save(target_path)

    except Exception:
        # Target doesn't exist, create it
        source_with_scd.write \
            .format("delta") \
            .mode("overwrite") \
            .save(target_path)

# Example usage
dimension_data = [
    (1, "Customer A", "New York", "Gold"),
    (2, "Customer B", "Los Angeles", "Silver"),
    (3, "Customer C", "Chicago", "Bronze")
]

dim_schema = StructType([
    StructField("customer_id", IntegerType(), False),
    StructField("customer_name", StringType(), True),
    StructField("city", StringType(), True),
    StructField("tier", StringType(), True)
])

dim_df = spark.createDataFrame(dimension_data, dim_schema)

apply_scd_type2(
    spark=spark,
    target_path=f"abfss://{container}@{storage_account}.dfs.core.windows.net/delta/customer_dim",
    source_df=dim_df,
    key_columns=["customer_id"],
    tracked_columns=["customer_name", "city", "tier"]
)
```

### Data Quality Constraints

```python
# Add constraints to Delta table
spark.sql(f"""
    ALTER TABLE delta.`{delta_path}`
    ADD CONSTRAINT price_positive CHECK (price > 0)
""")

spark.sql(f"""
    ALTER TABLE delta.`{delta_path}`
    ADD CONSTRAINT valid_category CHECK (category IN ('Electronics', 'Clothing', 'Home', 'Sports'))
""")

# View constraints
spark.sql(f"SHOW TBLPROPERTIES delta.`{delta_path}`").show(truncate=False)

# Drop constraint
spark.sql(f"""
    ALTER TABLE delta.`{delta_path}`
    DROP CONSTRAINT price_positive
""")
```

---

## Exercises

### Exercise 1: Create Delta Lake Pipeline

Build a complete pipeline that:
1. Creates a Delta table from raw CSV data
2. Performs incremental updates using merge
3. Implements data quality checks
4. Maintains historical versions

### Exercise 2: Implement CDC Pattern

Create a CDC solution that:
1. Enables change data feed on a table
2. Captures all changes (inserts, updates, deletes)
3. Streams changes to a downstream table
4. Aggregates change metrics

### Exercise 3: Optimize Delta Table

Take an unoptimized Delta table and:
1. Analyze file sizes and distribution
2. Apply Z-ordering on query columns
3. Implement partitioning strategy
4. Configure auto-optimization

---

## Best Practices Summary

| Practice | Recommendation |
|----------|----------------|
| Partitioning | Use columns with low cardinality (10-1000 partitions) |
| Z-Ordering | Apply on high-cardinality columns used in filters |
| File Size | Target 128 MB - 1 GB per file |
| VACUUM | Run weekly, retain at least 7 days |
| Schema Evolution | Enable auto-merge for flexibility |
| CDC | Enable only when needed (storage overhead) |
| Time Travel | Configure retention based on audit requirements |
| Constraints | Add for critical data quality rules |

---

## Next Steps

- Continue to [Tutorial 9: Serverless SQL Queries](09-serverless-sql.md)
- Explore [Delta Lake Best Practices](../../best-practices/delta-lake-optimization.md)
- Review [Delta Lake Troubleshooting](../../troubleshooting/delta-lake-troubleshooting.md)
