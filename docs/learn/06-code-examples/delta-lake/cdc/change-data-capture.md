# Change Data Capture (CDC) with Delta Lake in Azure Synapse Analytics

[🏠 Home](../../../../README.md) > [💻 Code Examples](../../../README.md) > [🏞️ Delta Lake](../../README.md) > 📄 Change Data Capture

This guide provides detailed examples for implementing Change Data Capture (CDC) patterns with Delta Lake in Azure Synapse Analytics.

## Introduction to CDC with Delta Lake

Change Data Capture (CDC) is a pattern for efficiently tracking and processing changes to data. Delta Lake provides built-in features that make implementing CDC patterns straightforward and efficient in Azure Synapse Analytics.

## Prerequisites

- Azure Synapse Analytics workspace
- Storage account with a container
- Appropriate permissions and access to Azure resources

## CDC Implementation Methods

### Method 1: Using Delta Lake Change Data Feed

Delta Lake's Change Data Feed captures row-level changes between versions of a Delta table. Here's how to enable and use it in Azure Synapse Analytics:

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import pyspark.sql.functions as F

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta Lake CDC Example") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define paths
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/customer_table/"

# Enable Change Data Feed (CDF) - For new tables
spark.sql(f"""
CREATE TABLE IF NOT EXISTS customer_table
USING DELTA
LOCATION '{delta_table_path}'
TBLPROPERTIES (delta.enableChangeDataFeed = true)
""")

# For existing tables, you can enable CDF using:
spark.sql(f"""
ALTER TABLE delta.`{delta_table_path}`
SET TBLPROPERTIES (delta.enableChangeDataFeed = true)
""")

# Make some changes to the table (insert, update, delete)
# ...

# Read the Change Data Feed to get all changes between versions
changes_df = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 0) \
    .option("endingVersion", 10) \
    .load(delta_table_path)

# The changes dataframe includes these CDC-specific columns:
# - _change_type: insert, update_preimage, update_postimage, delete
# - _commit_version: Delta version for this change
# - _commit_timestamp: Timestamp when this change was committed

# Filter for specific change types
inserts_df = changes_df.filter("_change_type = 'insert'")
updates_df = changes_df.filter("_change_type = 'update_postimage'")
deletes_df = changes_df.filter("_change_type = 'delete'")

# Display the changes
inserts_df.show()
updates_df.show()
deletes_df.show()
```

### Method 2: Time Travel and Table Comparison

You can also implement CDC by comparing table versions using Delta Lake's time travel capability:

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import pyspark.sql.functions as F

# Create Spark session with Delta Lake support
spark = SparkSession.builder \
    .appName("Delta Lake Time Travel CDC") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define paths
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/product_table/"

# Read current version
current_df = spark.read.format("delta").load(delta_table_path)

# Read previous version using time travel
previous_df = spark.read.format("delta").option("versionAsOf", 5).load(delta_table_path)

# Register temporary views for SQL comparison
current_df.createOrReplaceTempView("current_version")
previous_df.createOrReplaceTempView("previous_version")

# Identify inserted records (in current but not in previous)
inserted_records = spark.sql("""
SELECT c.* 
FROM current_version c
LEFT JOIN previous_version p ON c.id = p.id
WHERE p.id IS NULL
""")

# Identify deleted records (in previous but not in current)
deleted_records = spark.sql("""
SELECT p.* 
FROM previous_version p
LEFT JOIN current_version c ON p.id = c.id
WHERE c.id IS NULL
""")

# Identify updated records (in both but with different values)
# This assumes a 'last_modified' column exists to detect changes
updated_records = spark.sql("""
SELECT c.* 
FROM current_version c
JOIN previous_version p ON c.id = p.id
WHERE c.last_modified > p.last_modified
""")

# Display the changes
inserted_records.show()
deleted_records.show()
updated_records.show()
```

## Advanced CDC Patterns

### CDC with Streaming for Real-time Processing

```python
# Import required libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, current_timestamp

# Create Spark session
spark = SparkSession.builder \
    .appName("CDC Streaming with Delta") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define paths
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/orders_table/"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/orders_cdc/"

# Stream changes from the Change Data Feed
cdc_stream = spark.readStream \
    .format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 0) \
    .load(delta_table_path)

# Process changes based on change type
def process_cdc_batch(batch_df, batch_id):
    # Split batch by operation type
    inserts = batch_df.filter("_change_type = 'insert'")
    updates = batch_df.filter("_change_type = 'update_postimage'")
    deletes = batch_df.filter("_change_type = 'delete'")
    
    # Process each type differently (e.g., send to different destinations)
    if not inserts.isEmpty():
        inserts.drop("_change_type", "_commit_version", "_commit_timestamp") \
            .write \
            .format("delta") \
            .mode("append") \
            .save("abfss://container@storage.dfs.core.windows.net/delta/orders_inserts/")
    
    if not updates.isEmpty():
        updates.drop("_change_type", "_commit_version", "_commit_timestamp") \
            .write \
            .format("delta") \
            .mode("append") \
            .save("abfss://container@storage.dfs.core.windows.net/delta/orders_updates/")
    
    if not deletes.isEmpty():
        deletes.drop("_change_type", "_commit_version", "_commit_timestamp") \
            .write \
            .format("delta") \
            .mode("append") \
            .save("abfss://container@storage.dfs.core.windows.net/delta/orders_deletes/")

# Start streaming process
query = cdc_stream.writeStream \
    .foreachBatch(process_cdc_batch) \
    .option("checkpointLocation", checkpoint_path) \
    .trigger(processingTime="5 minutes") \
    .start()

# Wait for the query to terminate
query.awaitTermination()
```

### SCD Type 2 Implementation with Delta Lake

Slowly Changing Dimension Type 2 (SCD Type 2) preserves the history of data changes by creating new records for changed dimensions:

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import pyspark.sql.functions as F
from datetime import datetime

# Create Spark session
spark = SparkSession.builder \
    .appName("SCD Type 2 with Delta") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define paths
dim_customer_path = "abfss://container@storage.dfs.core.windows.net/delta/dim_customer/"
customer_updates_path = "abfss://container@storage.dfs.core.windows.net/landing/customer_updates/"

# Load the current dimension table (if it exists)
if DeltaTable.isDeltaTable(spark, dim_customer_path):
    # If table exists, load as DeltaTable
    customerDimTable = DeltaTable.forPath(spark, dim_customer_path)
    
    # Read the new data that contains updates
    newCustomerData = spark.read.format("parquet").load(customer_updates_path)
    
    # Current time for setting effective dates
    current_time = datetime.now()
    
    # Execute SCD Type 2 operation
    (customerDimTable.alias("dim")
        .merge(
            newCustomerData.alias("updates"),
            "dim.customer_id = updates.customer_id AND dim.is_current = true"
        )
        .whenMatchedAndExpressionsMatch(
            [
                "dim.name <> updates.name OR " + 
                "dim.address <> updates.address OR " +
                "dim.phone <> updates.phone"
            ]
        )
        .updateAll(
            {
                "is_current": "false",
                "end_date": F.lit(current_time)
            }
        )
        .whenMatchedAndExpressionsNotMatch(
            [
                "dim.name <> updates.name OR " + 
                "dim.address <> updates.address OR " +
                "dim.phone <> updates.phone"
            ]
        )
        .updateAll()  # No changes if attributes match
        .whenNotMatchedInsertAll()
        .execute())
    
    # Insert new records for the updated customers
    customerDimTable = DeltaTable.forPath(spark, dim_customer_path)
    
    matched_updates = (customerDimTable.alias("dim")
        .merge(
            newCustomerData.alias("updates"),
            "dim.customer_id = updates.customer_id AND dim.is_current = false AND dim.end_date = '{}'".format(current_time)
        )
        .whenMatchedUpdateAll()
        .execute())
    
    # Load dimension table as DataFrame
    dimDF = spark.read.format("delta").load(dim_customer_path)
    
    # Get updated records that need a new current version
    updatedCustomers = (dimDF
        .filter(F.col("is_current") == False)
        .filter(F.col("end_date") == current_time))
    
    # Create new current records
    newCurrentRecords = (updatedCustomers
        .select(
            "customer_id", "name", "address", "phone", "email", "other_attributes"
        )
        .withColumn("is_current", F.lit(True))
        .withColumn("start_date", F.lit(current_time))
        .withColumn("end_date", F.lit(None)))
    
    # Write new current records to the dimension table
    newCurrentRecords.write \
        .format("delta") \
        .mode("append") \
        .save(dim_customer_path)

else:
    # If table doesn't exist, create it with initial data
    initial_data = spark.read.format("parquet").load(customer_updates_path) \
        .withColumn("is_current", F.lit(True)) \
        .withColumn("start_date", F.lit(datetime.now())) \
        .withColumn("end_date", F.lit(None))
    
    initial_data.write \
        .format("delta") \
        .save(dim_customer_path)
```

## Implementing CDC from External Source Systems

### CDC from SQL Server Using Debezium

This example demonstrates how to capture changes from SQL Server using Debezium and process them with Delta Lake:

```python
# Import required libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import from_json, col
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, TimestampType

# Create Spark session
spark = SparkSession.builder \
    .appName("SQL Server CDC with Delta") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define Kafka parameters for Debezium CDC events
kafka_bootstrap_servers = "kafka:9092"
kafka_topic = "sqlserver.dbo.customers"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/sqlserver_cdc/"
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/customers_from_sqlserver/"

# Define schema for the customer data
customer_schema = StructType([
    StructField("id", IntegerType(), True),
    StructField("name", StringType(), True),
    StructField("email", StringType(), True),
    StructField("phone", StringType(), True),
    StructField("address", StringType(), True),
    StructField("created_at", TimestampType(), True),
    StructField("updated_at", TimestampType(), True)
])

# Define schema for the CDC event
cdc_schema = StructType([
    StructField("before", customer_schema, True),
    StructField("after", customer_schema, True),
    StructField("source", StructType([
        StructField("version", StringType(), True),
        StructField("connector", StringType(), True),
        StructField("name", StringType(), True),
        StructField("ts_ms", TimestampType(), True),
        StructField("snapshot", StringType(), True),
        StructField("db", StringType(), True),
        StructField("table", StringType(), True),
        StructField("server_id", StringType(), True),
        StructField("file", StringType(), True),
        StructField("pos", StringType(), True)
    ]), True),
    StructField("op", StringType(), True),
    StructField("ts_ms", TimestampType(), True)
])

# Read Debezium CDC events from Kafka
cdc_stream = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", kafka_bootstrap_servers) \
    .option("subscribe", kafka_topic) \
    .option("startingOffsets", "earliest") \
    .load()

# Parse the CDC events
parsed_stream = cdc_stream \
    .selectExpr("CAST(value AS STRING)") \
    .select(from_json(col("value"), cdc_schema).alias("data")) \
    .select("data.*")

# Process CDC operations
def process_cdc_batch(batch_df, batch_id):
    if batch_df.isEmpty():
        return
    
    # Get the DeltaTable object
    if DeltaTable.isDeltaTable(spark, delta_table_path):
        delta_table = DeltaTable.forPath(spark, delta_table_path)
    else:
        # If the table doesn't exist, create it with an empty dataframe
        empty_df = spark.createDataFrame([], customer_schema)
        empty_df.write.format("delta").save(delta_table_path)
        delta_table = DeltaTable.forPath(spark, delta_table_path)
    
    # Process inserts (op = 'c' for create)
    inserts = batch_df.filter("op = 'c'").select("after.*")
    if not inserts.isEmpty():
        inserts.write.format("delta").mode("append").save(delta_table_path)
    
    # Process updates (op = 'u' for update)
    updates = batch_df.filter("op = 'u'").select("after.*")
    if not updates.isEmpty():
        for row in updates.collect():
            customer_id = row.id
            delta_table.update(
                condition=f"id = {customer_id}",
                set={
                    "name": row.name,
                    "email": row.email,
                    "phone": row.phone,
                    "address": row.address,
                    "updated_at": row.updated_at
                }
            )
    
    # Process deletes (op = 'd' for delete)
    deletes = batch_df.filter("op = 'd'").select("before.id")
    if not deletes.isEmpty():
        for row in deletes.collect():
            customer_id = row.id
            delta_table.delete(f"id = {customer_id}")

# Start the streaming query
query = parsed_stream.writeStream \
    .foreachBatch(process_cdc_batch) \
    .option("checkpointLocation", checkpoint_path) \
    .start()

# Wait for the query to terminate
query.awaitTermination()
```

## Best Practices

1. __Enable Change Data Feed Proactively__: Enable it on tables where you anticipate needing change tracking.

2. __Optimize for Write Performance__: When implementing CDC patterns that involve frequent updates:

   ```python
   spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
   spark.conf.set("spark.databricks.delta.autoCompact.enabled", "true")
   ```

3. __Set Appropriate Retention Period__: Configure the change data feed retention period:

   ```python
   spark.sql(f"""
   ALTER TABLE delta.`{delta_table_path}`
   SET TBLPROPERTIES (delta.logRetentionDuration = '30 days')
   """)
   ```

4. __Consider Partitioning__: Partition your data appropriately to improve CDC query performance:

   ```python
   df.write \
     .format("delta") \
     .partitionBy("year", "month") \
     .save(delta_table_path)
   ```

5. __Optimize After Large CDC Operations__: Run OPTIMIZE after large CDC operations:

   ```python
   spark.sql(f"OPTIMIZE delta.`{delta_table_path}`")
   ```

## Common Issues and Solutions

### Issue: Change Data Feed is not capturing changes

__Solution__: Verify that Change Data Feed is enabled and that you are reading with the correct version range.

### Issue: Performance degradation with large change volumes

__Solution__:

- Use appropriate partitioning
- Implement incremental processing with smaller batch sizes
- Consider compaction after large change operations

### Issue: Duplicate records in CDC processing

__Solution__: Implement idempotent operations and use checkpoints to ensure exactly-once processing.

## Related Links

- [Azure Synapse Analytics documentation](https://learn.microsoft.com/en-us/azure/synapse-analytics/)
- [Delta Lake Change Data Feed documentation](https://docs.delta.io/latest/delta-change-data-feed.html)
- [Debezium documentation](https://debezium.io/documentation/)
