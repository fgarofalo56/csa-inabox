# Comprehensive Delta Lake Guide for Azure Synapse Analytics

[Home](../../README.md) > Code Examples > Delta Lake Guide

!!! info "Guide Overview"
    This comprehensive guide provides detailed examples for working with Delta Lake in Azure Synapse Analytics, covering data ingestion, change data capture, and table optimization techniques.

<div class="grid cards" markdown>
- 📥 __Data Ingestion__
  
  Auto Loader techniques for efficient and reliable data ingestion

- 📜 __Change Data Capture__
  
  Tracking and processing data changes with Delta Lake

- 🔄 __Table Optimization__
  
  Best practices for maintaining Delta Lake performance

</div>

## Table of Contents

- [Data Ingestion with Auto Loader](#data-ingestion-with-auto-loader)
  - [Basic Auto Loader Example](#basic-auto-loader-example)
  - [Schema Evolution with Auto Loader](#schema-evolution-with-auto-loader)
  - [Partition Management with Auto Loader](#partition-management-with-auto-loader)
- [Change Data Capture (CDC) Patterns](#change-data-capture-cdc-patterns)
  - [Using Delta Lake Change Data Feed](#using-delta-lake-change-data-feed)
  - [Time Travel for Table Comparisons](#time-travel-for-table-comparisons)
  - [SCD Type 2 Implementation](#scd-type-2-implementation)
- [Table Optimization Techniques](#table-optimization-techniques)
  - [OPTIMIZE Command](#optimize-command)
  - [VACUUM Command](#vacuum-command)
  - [Z-Order Indexing](#z-order-indexing)

## Data Ingestion with Auto Loader

![Data Ingestion](https://raw.githubusercontent.com/microsoft/azuredatastudio/main/extensions/resource-deployment/images/delta-lake.svg)

!!! abstract "Auto Loader Overview"
    Auto Loader provides an efficient way to incrementally process new files as they arrive in Azure Storage without having to list or reprocess the entire directory. It uses Azure Storage change feed notifications to efficiently identify new files.

!!! note "Prerequisites"
    - Azure Synapse Analytics workspace
    - Storage account with a container for data ingestion
    - Appropriate permissions and access to Azure resources
    - Delta Lake tables created in Synapse workspace

### Basic Auto Loader Example

```python
# Import required libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import current_timestamp

# Create Spark session
spark = SparkSession.builder \
    .appName("Auto Loader Example") \
    .getOrCreate()

# Source and destination paths
source_path = "abfss://container@storage.dfs.core.windows.net/raw-data/"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/autoloader/"
destination_path = "abfss://container@storage.dfs.core.windows.net/delta/table/"

# Use Auto Loader to load data
df = spark.readStream \
    .format("cloudFiles") \
    .option("cloudFiles.format", "csv") \
    .option("cloudFiles.schemaLocation", checkpoint_path) \
    .option("cloudFiles.inferColumnTypes", "true") \
    .option("header", "true") \
    .load(source_path)

# Add ingestion timestamp
df = df.withColumn("ingestion_time", current_timestamp())

# Write to Delta table
query = df.writeStream \
    .format("delta") \
    .option("checkpointLocation", checkpoint_path) \
    .outputMode("append") \
    .start(destination_path)

# Wait for the query to terminate
query.awaitTermination()
```

### Schema Evolution with Auto Loader

```python
# Import required libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import current_timestamp, input_file_name

# Create Spark session
spark = SparkSession.builder \
    .appName("Auto Loader with Schema Evolution") \
    .getOrCreate()

# Source and destination paths
source_path = "abfss://container@storage.dfs.core.windows.net/raw-data/"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/autoloader-schema-evolution/"
destination_path = "abfss://container@storage.dfs.core.windows.net/delta/evolved-table/"

# Use Auto Loader with schema evolution
df = spark.readStream \
    .format("cloudFiles") \
    .option("cloudFiles.format", "json") \
    .option("cloudFiles.schemaLocation", checkpoint_path) \
    .option("cloudFiles.inferColumnTypes", "true") \
    .option("cloudFiles.schemaEvolutionMode", "addNewColumns") \
    .load(source_path)

# Add metadata columns
df = df.withColumn("ingestion_time", current_timestamp()) \
       .withColumn("source_file", input_file_name())

# Write to Delta table with schema evolution enabled
query = df.writeStream \
    .format("delta") \
    .option("checkpointLocation", checkpoint_path) \
    .option("mergeSchema", "true") \
    .outputMode("append") \
    .start(destination_path)

# Wait for the query to terminate
query.awaitTermination()
```

### Partition Management with Auto Loader

```python
# Import required libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import year, month, dayofmonth, to_date, col

# Create Spark session
spark = SparkSession.builder \
    .appName("Auto Loader with Partitioning") \
    .getOrCreate()

# Source and destination paths
source_path = "abfss://container@storage.dfs.core.windows.net/raw-data/"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/autoloader-partitioned/"
destination_path = "abfss://container@storage.dfs.core.windows.net/delta/partitioned-table/"

# Use Auto Loader to load data
df = spark.readStream \
    .format("cloudFiles") \
    .option("cloudFiles.format", "parquet") \
    .option("cloudFiles.schemaLocation", checkpoint_path) \
    .load(source_path)

# Assuming the data has a 'date' column, extract partitioning columns
df = df.withColumn("date", to_date(col("date"))) \
       .withColumn("year", year(col("date"))) \
       .withColumn("month", month(col("date"))) \
       .withColumn("day", dayofmonth(col("date")))

# Write to Delta table with partitioning
query = df.writeStream \
    .format("delta") \
    .option("checkpointLocation", checkpoint_path) \
    .partitionBy("year", "month", "day") \
    .outputMode("append") \
    .start(destination_path)

# Wait for the query to terminate
query.awaitTermination()
```

## Change Data Capture (CDC) Patterns

Change Data Capture (CDC) is a pattern for efficiently tracking and processing changes to data. Delta Lake provides built-in features that make implementing CDC patterns straightforward and efficient in Azure Synapse Analytics.

### Using Delta Lake Change Data Feed

Delta Lake's Change Data Feed captures row-level changes between versions of a Delta table:

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import pyspark.sql.functions as F

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta CDC Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Enable Change Data Feed on an existing table
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/customer-table/"
spark.sql(f"ALTER TABLE delta.`{delta_table_path}` SET TBLPROPERTIES (delta.enableChangeDataFeed = true)")

# Make some changes to the table (insert, update, delete operations)
# ...

# Read the change data feed
changes_df = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 1) \
    .option("endingVersion", 2) \
    .load(delta_table_path)

# Display changes with operation type
changes_df.select("_change_type", "*").show()
```

### Time Travel for Table Comparisons

Use Delta Lake's time travel feature to compare table versions:

```python
# Import required libraries
from pyspark.sql import SparkSession
import pyspark.sql.functions as F

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta Time Travel Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Path to Delta table
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/sales-table/"

# Read current version
current_df = spark.read.format("delta").load(delta_table_path)

# Read previous version (e.g., version 5)
previous_df = spark.read.format("delta").option("versionAsOf", 5).load(delta_table_path)

# Compare versions by finding differences
# Get new records (in current but not in previous)
new_records = current_df.subtract(previous_df)

# Get removed records (in previous but not in current)
removed_records = previous_df.subtract(current_df)

# Display results
print(f"New records count: {new_records.count()}")
print(f"Removed records count: {removed_records.count()}")
```

### SCD Type 2 Implementation

Implement Slowly Changing Dimension Type 2 (maintaining history of changes) with Delta Lake:

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import pyspark.sql.functions as F
from pyspark.sql.types import *
from datetime import datetime

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta SCD Type 2 Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Path to Delta table
scd_table_path = "abfss://container@storage.dfs.core.windows.net/delta/customer-scd2/"

# Create or get reference to the SCD Type 2 table
if DeltaTable.isDeltaTable(spark, scd_table_path):
    deltaTable = DeltaTable.forPath(spark, scd_table_path)
else:
    # Create the initial SCD Type 2 table with required columns for tracking history
    schema = StructType([
        StructField("customer_id", StringType(), False),
        StructField("name", StringType(), True),
        StructField("email", StringType(), True),
        StructField("address", StringType(), True),
        StructField("effective_date", TimestampType(), False),
        StructField("end_date", TimestampType(), True),
        StructField("is_current", BooleanType(), False)
    ])
    
    empty_df = spark.createDataFrame([], schema)
    empty_df.write.format("delta").save(scd_table_path)
    deltaTable = DeltaTable.forPath(spark, scd_table_path)

# New data to be merged
new_data = [
    ("C001", "John Smith", "john.updated@example.com", "123 Main St"),
    ("C002", "Jane Doe", "jane@example.com", "456 Oak Ave"),
    ("C003", "Robert Brown", "robert@example.com", "789 Pine Rd")
]
columns = ["customer_id", "name", "email", "address"]
updates_df = spark.createDataFrame(new_data, columns)

# Current timestamp for effective dating
current_timestamp = datetime.now()

# Perform SCD Type 2 merge operation
deltaTable.alias("target").merge(
    updates_df.alias("source"),
    "target.customer_id = source.customer_id AND target.is_current = true"
).whenMatched(
    # When there's a change to tracked columns, update current record and insert new one
    "(target.name <> source.name OR target.email <> source.email OR target.address <> source.address) AND target.is_current = true"
).updateExpr(
    {
        "is_current": "false",
        "end_date": f"'{current_timestamp}'"
    }
).whenNotMatched(
    # Insert new customer records
).insert(
    {
        "customer_id": "source.customer_id",
        "name": "source.name",
        "email": "source.email",
        "address": "source.address",
        "effective_date": f"'{current_timestamp}'",
        "end_date": "null",
        "is_current": "true"
    }
).execute()

# Insert new version of changed records
# We need to do this in a separate operation after closing current records
staged_updates_df = spark.sql(f"""
    SELECT 
        source.customer_id,
        source.name,
        source.email,
        source.address,
        '{current_timestamp}' as effective_date,
        null as end_date,
        true as is_current
    FROM {updates_df.createOrReplaceTempView("source")}
    JOIN delta.`{scd_table_path}` target
    ON source.customer_id = target.customer_id
    WHERE target.is_current = false 
    AND target.end_date = '{current_timestamp}'
""")

# Append the new version records
staged_updates_df.write.format("delta").mode("append").save(scd_table_path)

# Display the SCD Type 2 table with history
spark.read.format("delta").load(scd_table_path).orderBy("customer_id", "effective_date").show()
```

## Table Optimization Techniques

Delta Lake tables can accumulate many small files over time, especially with streaming or incremental data loads. Optimization techniques help maintain performance by compacting small files and optimizing data layout.

### OPTIMIZE Command

The `OPTIMIZE` command compacts small files into larger ones for better read performance:

```python
# Import required libraries
from pyspark.sql import SparkSession

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta Optimization Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Path to Delta table
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/sales-table/"

# Run OPTIMIZE command
spark.sql(f"OPTIMIZE delta.`{delta_table_path}`")

# Check the history of the table after optimization
spark.sql(f"DESCRIBE HISTORY delta.`{delta_table_path}`").show(truncate=False)
```

### VACUUM Command

The `VACUUM` command removes files no longer needed by the Delta table (based on retention period):

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta Vacuum Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Path to Delta table
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/sales-table/"

# Get Delta table object
delta_table = DeltaTable.forPath(spark, delta_table_path)

# First, retain history for 7 days (instead of default 30 days)
spark.sql(f"ALTER TABLE delta.`{delta_table_path}` SET TBLPROPERTIES (delta.logRetentionDuration = '7 days')")

# For safety, first run with dry run to see what would be deleted
delta_table.vacuum(retention_hours=168, dry_run=True)

# Then run actual vacuum - CAUTION: This permanently removes files
delta_table.vacuum(retention_hours=168)
```

### Z-Order Indexing

Z-ordering is a technique that co-locates related data to optimize queries that filter on specific columns:

```python
# Import required libraries
from pyspark.sql import SparkSession

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta Z-Order Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Path to Delta table
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/sales-table/"

# Run OPTIMIZE with Z-ORDER BY
spark.sql(f"OPTIMIZE delta.`{delta_table_path}` ZORDER BY (region, product_category)")

# Check operation history
spark.sql(f"DESCRIBE HISTORY delta.`{delta_table_path}`").show(truncate=False)
```

## Related Topics

- [Serverless SQL with Delta Lake](../serverless-sql/README.md)
- [Integration with Azure ML](integration/azure-ml.md)
- [Delta Lake Architecture Overview](../../architecture/delta-lakehouse/README.md)
