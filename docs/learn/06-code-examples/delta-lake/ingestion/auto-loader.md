# Auto Loader for Delta Lake in Azure Synapse Analytics

[🏠 Home](../../../../README.md) > [💻 Code Examples](../../../README.md) > [🌞️ Delta Lake](../../README.md) > 📄 Auto Loader

This guide provides detailed examples for using Auto Loader with Azure Synapse Analytics to efficiently ingest data into Delta Lake tables.

## What is Auto Loader?

Auto Loader provides an efficient way to incrementally process new files as they arrive in Azure Storage without having to list or reprocess the entire directory. It uses Azure Storage change feed notifications to efficiently identify new files.

## Prerequisites

- Azure Synapse Analytics workspace
- Storage account with a container for data ingestion
- Appropriate permissions and access to Azure resources

## Basic Auto Loader Example

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

## Advanced Auto Loader Configuration

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

## Optimization Strategies for Auto Loader

### Trigger-Based Processing

```python
# Import required libraries
from pyspark.sql import SparkSession

# Create Spark session
spark = SparkSession.builder \
    .appName("Auto Loader with Trigger") \
    .getOrCreate()

# Source and destination paths
source_path = "abfss://container@storage.dfs.core.windows.net/raw-data/"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/autoloader-trigger/"
destination_path = "abfss://container@storage.dfs.core.windows.net/delta/trigger-table/"

# Use Auto Loader to load data
df = spark.readStream \
    .format("cloudFiles") \
    .option("cloudFiles.format", "csv") \
    .option("cloudFiles.schemaLocation", checkpoint_path) \
    .option("cloudFiles.maxFilesPerTrigger", 1000) \
    .option("header", "true") \
    .load(source_path)

# Write to Delta table with trigger
query = df.writeStream \
    .format("delta") \
    .option("checkpointLocation", checkpoint_path) \
    .trigger(processingTime="5 minutes") \
    .outputMode("append") \
    .start(destination_path)

# Wait for the query to terminate
query.awaitTermination()
```

### Cost-Optimized Auto Loader

```python
# Import required libraries
from pyspark.sql import SparkSession

# Create Spark session
spark = SparkSession.builder \
    .appName("Cost-Optimized Auto Loader") \
    .getOrCreate()

# Source and destination paths
source_path = "abfss://container@storage.dfs.core.windows.net/raw-data/"
checkpoint_path = "abfss://container@storage.dfs.core.windows.net/checkpoints/autoloader-cost-optimized/"
destination_path = "abfss://container@storage.dfs.core.windows.net/delta/cost-optimized-table/"

# Use Auto Loader with optimized configuration
df = spark.readStream \
    .format("cloudFiles") \
    .option("cloudFiles.format", "parquet") \
    .option("cloudFiles.schemaLocation", checkpoint_path) \
    .option("cloudFiles.maxFilesPerTrigger", 100) \
    .option("cloudFiles.maxFileAge", "7d") \
    .option("cloudFiles.useNotifications", "true") \
    .load(source_path)

# Write to Delta table with optimized configuration
query = df.writeStream \
    .format("delta") \
    .option("checkpointLocation", checkpoint_path) \
    .option("maxRecordsPerFile", 1000000) \
    .option("optimizeWrite", "true") \
    .trigger(processingTime="15 minutes") \
    .outputMode("append") \
    .start(destination_path)

# Wait for the query to terminate
query.awaitTermination()
```

## Best Practices

1. __Schema Inference__: Use schema inference for development but consider providing an explicit schema in production for better control.

2. __Checkpoint Management__: Always set a checkpoint location to keep track of which files have been processed.

3. __Error Handling__: Add error handling options to handle corrupted files:

   ```python
   .option("cloudFiles.schemaLocation", checkpoint_path)
   .option("cloudFiles.rescuedDataColumn", "_rescued_data")
   ```

4. __Resource Allocation__: Adjust `maxFilesPerTrigger` based on your cluster's processing capacity.

5. __Notification Mode__: Use notification mode when available for more efficient file discovery:

   ```python
   .option("cloudFiles.useNotifications", "true")
   ```

## Common Issues and Solutions

### Issue: Files are not being processed

__Solution__: Check if the service principal has appropriate permissions on the storage account.

### Issue: Schema mismatch errors

__Solution__: Enable schema evolution with `mergeSchema` and `cloudFiles.schemaEvolutionMode`.

### Issue: Performance bottlenecks

__Solution__:

- Increase parallelism with `spark.sql.shuffle.partitions`
- Use efficient file formats like Parquet
- Optimize file sizes (aim for 128MB to 1GB)

## Related Links

- [Azure Synapse Analytics documentation](https://learn.microsoft.com/en-us/azure/synapse-analytics/)
- [Delta Lake documentation](https://docs.delta.io/)
- [Auto Loader performance tuning](https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-performance-hyperspace)
