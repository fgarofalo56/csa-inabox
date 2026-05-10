# Delta Table Optimization in Azure Synapse Analytics

[🏠 Home](../../../../README.md) > [💻 Code Examples](../../../README.md) > [🌞️ Delta Lake](../../README.md) > 📄 Table Optimization

This guide provides detailed examples for optimizing Delta Lake tables in Azure Synapse Analytics to improve query performance and reduce costs.

## Introduction to Delta Table Optimization

Delta Lake tables can accumulate many small files over time, especially with streaming or incremental data loads. Optimization techniques help maintain performance by compacting small files and optimizing data layout.

## Prerequisites

- Azure Synapse Analytics workspace
- Storage account with a Delta Lake table
- Appropriate permissions to run Spark jobs

## Core Optimization Commands

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

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/sales_table/"

# Run basic OPTIMIZE command
spark.sql(f"OPTIMIZE delta.`{delta_table_path}`")

# Run OPTIMIZE with Z-ORDER for better data clustering
spark.sql(f"OPTIMIZE delta.`{delta_table_path}` ZORDER BY (date, region, product_id)")

# Run OPTIMIZE with custom file size target
spark.sql(f"""
OPTIMIZE delta.`{delta_table_path}`
WHERE date >= '2023-01-01'
""")
```

### VACUUM Command

The `VACUUM` command removes files that are no longer needed by a Delta table:

```python
# Set retention period (default is 7 days)
spark.conf.set("spark.databricks.delta.retentionDurationCheck.enabled", "false")
spark.conf.set("spark.databricks.delta.vacuum.logging.enabled", "true")

# List files that would be deleted (dry run)
spark.sql(f"VACUUM delta.`{delta_table_path}` RETAIN 168 HOURS DRY RUN")

# Actually remove files older than retention period
spark.sql(f"VACUUM delta.`{delta_table_path}` RETAIN 168 HOURS")

# Run VACUUM with shorter retention (use with caution)
spark.sql(f"VACUUM delta.`{delta_table_path}` RETAIN 24 HOURS")
```

## Advanced Optimization Strategies

### Scheduled Optimization with Automated Workflows

```python
# Import required libraries
from pyspark.sql import SparkSession
from datetime import datetime

# Create Spark session
spark = SparkSession.builder \
    .appName("Automated Delta Optimization") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define logging function
def log_optimization(delta_path, optimization_type, start_time):
    end_time = datetime.now()
    duration = (end_time - start_time).total_seconds()
    
    log_data = [(delta_path, optimization_type, start_time.isoformat(), 
                end_time.isoformat(), duration)]
    
    schema = ["table_path", "operation", "start_time", "end_time", "duration_seconds"]
    log_df = spark.createDataFrame(log_data, schema)
    
    # Write to optimization log table
    log_df.write \
        .format("delta") \
        .mode("append") \
        .save("abfss://container@storage.dfs.core.windows.net/logs/optimization_history/")

# Get list of tables to optimize
tables_to_optimize = [
    "abfss://container@storage.dfs.core.windows.net/delta/sales_table/",
    "abfss://container@storage.dfs.core.windows.net/delta/customer_table/",
    "abfss://container@storage.dfs.core.windows.net/delta/product_table/"
]

# Perform optimization for each table
for table_path in tables_to_optimize:
    # Run OPTIMIZE
    start_time = datetime.now()
    spark.sql(f"OPTIMIZE delta.`{table_path}`")
    log_optimization(table_path, "OPTIMIZE", start_time)
    
    # Run VACUUM (if table is old enough)
    start_time = datetime.now()
    spark.sql(f"VACUUM delta.`{table_path}` RETAIN 168 HOURS")
    log_optimization(table_path, "VACUUM", start_time)
```

### Partition-Aware Optimization

Optimize specific partitions for large tables:

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import pyspark.sql.functions as F

# Create Spark session
spark = SparkSession.builder \
    .appName("Partition-Aware Optimization") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/large_partitioned_table/"

# Load Delta table
delta_table = DeltaTable.forPath(spark, delta_table_path)

# Get list of partitions
partitions_df = spark.sql(f"SHOW PARTITIONS delta.`{delta_table_path}`")
partitions = [row.partition for row in partitions_df.collect()]

# Get file counts for each partition
file_stats = []
for partition in partitions:
    # Extract partition values (assuming year/month partitioning)
    # Example partition format: "year=2023/month=01"
    year = partition.split('/')[0].split('=')[1]
    month = partition.split('/')[1].split('=')[1]
    
    # Count files in the partition
    files_df = spark.sql(f"""
        SELECT COUNT(*) as file_count
        FROM delta.`{delta_table_path}`
        WHERE year = {year} AND month = {month}
    """)
    
    file_count = files_df.first()[0]
    file_stats.append((partition, file_count, year, month))

# Sort partitions by file count (optimize those with most files first)
file_stats.sort(key=lambda x: x[1], reverse=True)

# Optimize partitions with more than 100 files
for partition, file_count, year, month in file_stats:
    if file_count > 100:
        print(f"Optimizing partition {partition} with {file_count} files")
        spark.sql(f"""
            OPTIMIZE delta.`{delta_table_path}`
            WHERE year = {year} AND month = {month}
            ZORDER BY (customer_id, product_id)
        """)
```

### Data Skipping with Z-ORDER

Optimize table for specific query patterns using Z-ORDER:

```python
# Import required libraries
from pyspark.sql import SparkSession
import time

# Create Spark session
spark = SparkSession.builder \
    .appName("Z-ORDER Optimization") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/query_table/"

# Define test query
test_query = f"""
    SELECT COUNT(*) 
    FROM delta.`{delta_table_path}`
    WHERE region = 'Europe' AND transaction_date BETWEEN '2023-01-01' AND '2023-01-31'
"""

# Run query before optimization and measure time
start_time = time.time()
spark.sql(test_query).show()
before_time = time.time() - start_time
print(f"Query time before optimization: {before_time:.2f} seconds")

# Run OPTIMIZE with Z-ORDER on query columns
spark.sql(f"""
    OPTIMIZE delta.`{delta_table_path}`
    ZORDER BY (region, transaction_date)
""")

# Run the same query after optimization
start_time = time.time()
spark.sql(test_query).show()
after_time = time.time() - start_time
print(f"Query time after optimization: {after_time:.2f} seconds")
print(f"Performance improvement: {(before_time - after_time) / before_time * 100:.2f}%")
```

## Delta Cache Optimization

Leverage Delta Lake caching for frequently accessed data:

```python
# Import required libraries
from pyspark.sql import SparkSession
import time

# Create Spark session with Delta Lake and cache support
spark = SparkSession.builder \
    .appName("Delta Cache Optimization") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .config("spark.databricks.io.cache.enabled", "true") \
    .getOrCreate()

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/frequently_accessed_table/"

# Query without cache priming
start_time = time.time()
result = spark.sql(f"""
    SELECT region, product_category, SUM(sales_amount) AS total_sales
    FROM delta.`{delta_table_path}`
    GROUP BY region, product_category
    ORDER BY total_sales DESC
    LIMIT 10
""").collect()
first_query_time = time.time() - start_time

# The second execution should use cache
start_time = time.time()
result = spark.sql(f"""
    SELECT region, product_category, SUM(sales_amount) AS total_sales
    FROM delta.`{delta_table_path}`
    GROUP BY region, product_category
    ORDER BY total_sales DESC
    LIMIT 10
""").collect()
second_query_time = time.time() - start_time

print(f"First query time: {first_query_time:.2f} seconds")
print(f"Second query time (cached): {second_query_time:.2f} seconds")
print(f"Cache speedup: {first_query_time / second_query_time:.2f}x")

# Cache specific columns for better memory utilization
spark.sql(f"""
    CACHE SELECT region, product_category, sales_amount
    FROM delta.`{delta_table_path}`
    WHERE transaction_date >= '2023-01-01'
""")
```

## Monitoring and Maintaining Delta Tables

### Table History and Statistics

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable

# Create Spark session
spark = SparkSession.builder \
    .appName("Delta Table Monitoring") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/monitored_table/"

# Check table history
history_df = spark.sql(f"DESCRIBE HISTORY delta.`{delta_table_path}`")
history_df.show(10, truncate=False)

# Get table details and statistics
details_df = spark.sql(f"DESCRIBE DETAIL delta.`{delta_table_path}`")
details_df.show(truncate=False)

# Get file sizes and distribution
files_df = spark.sql(f"""
    DESCRIBE DETAIL delta.`{delta_table_path}`
""").select("location").first()

table_location = files_df["location"]

# List all files in the Delta table directory
files = spark.sparkContext.wholeTextFiles(f"{table_location}/[^_]*").keys().collect()

# Convert to DataFrame for analysis
files_info = [(f.split("/")[-1], f) for f in files if f.endswith(".parquet")]
file_df = spark.createDataFrame(files_info, ["filename", "path"])

# Show file stats
print(f"Total number of files: {file_df.count()}")

# Analyze file size distribution
spark.sql(f"""
    CREATE OR REPLACE TEMPORARY VIEW delta_files AS
    SELECT 
        input_file_name() AS file_path,
        COUNT(*) AS record_count
    FROM delta.`{delta_table_path}`
    GROUP BY input_file_name()
""")

spark.sql("""
    SELECT 
        percentile_approx(record_count, 0.5) AS median_records_per_file,
        MIN(record_count) AS min_records,
        MAX(record_count) AS max_records,
        AVG(record_count) AS avg_records
    FROM delta_files
""").show()
```

### Auto-Optimize Configuration

```python
# Import required libraries
from pyspark.sql import SparkSession
from delta.tables import DeltaTable

# Create Spark session with auto-optimize enabled
spark = SparkSession.builder \
    .appName("Delta Auto Optimization") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .config("spark.databricks.delta.optimizeWrite.enabled", "true") \
    .config("spark.databricks.delta.autoCompact.enabled", "true") \
    .getOrCreate()

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/auto_optimized_table/"

# Create a new table with auto-optimize properties
spark.sql(f"""
CREATE TABLE IF NOT EXISTS auto_optimized_table
USING DELTA
LOCATION '{delta_table_path}'
TBLPROPERTIES (
  delta.autoOptimize.optimizeWrite = true,
  delta.autoOptimize.autoCompact = true
)
""")

# For existing tables, you can set these properties:
spark.sql(f"""
ALTER TABLE delta.`{delta_table_path}`
SET TBLPROPERTIES (
  delta.autoOptimize.optimizeWrite = true,
  delta.autoOptimize.autoCompact = true
)
""")
```

## Performance Tuning Best Practices

### 1. File Size Optimization

Aim for file sizes between 128MB to 1GB:

```python
# Import required libraries
from pyspark.sql import SparkSession

# Create Spark session
spark = SparkSession.builder \
    .appName("File Size Optimization") \
    .config("spark.sql.files.maxPartitionBytes", "134217728") # 128 MB
    .config("spark.sql.shuffle.partitions", "200")
    .getOrCreate()

# Configure write operation for optimal file sizes
df = spark.read.format("delta").load("abfss://container@storage.dfs.core.windows.net/delta/input_table/")

# Write with target file size of ~128MB
df.repartition(200) \
    .write \
    .option("maxRecordsPerFile", 500000) \
    .format("delta") \
    .save("abfss://container@storage.dfs.core.windows.net/delta/optimized_table/")
```

### 2. Partitioning Strategy

Create effective partitioning based on query patterns:

```python
# Import required libraries
from pyspark.sql import SparkSession
import pyspark.sql.functions as F

# Create Spark session
spark = SparkSession.builder \
    .appName("Delta Partitioning Strategy") \
    .getOrCreate()

# Load data
df = spark.read.format("delta").load("abfss://container@storage.dfs.core.windows.net/delta/source_table/")

# Add partitioning columns
df = df.withColumn("year", F.year("transaction_date")) \
       .withColumn("month", F.month("transaction_date"))

# Write with partitioning
df.write \
    .format("delta") \
    .partitionBy("year", "month") \
    .save("abfss://container@storage.dfs.core.windows.net/delta/well_partitioned_table/")

# For time-series data with high cardinality, consider limiting partitions
df.write \
    .format("delta") \
    .partitionBy("year") \
    .save("abfss://container@storage.dfs.core.windows.net/delta/balanced_partitioned_table/")
```

### 3. Compact Metadata with Delta Protocol Upgrades

```python
# Import required libraries
from pyspark.sql import SparkSession

# Create Spark session
spark = SparkSession.builder \
    .appName("Delta Protocol Upgrade") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Define Delta table path
delta_table_path = "abfss://container@storage.dfs.core.windows.net/delta/large_table/"

# Check current protocol version
spark.sql(f"""
    DESCRIBE DETAIL delta.`{delta_table_path}`
""").select("protocol.*").show()

# Upgrade to latest protocol version for metadata improvements
spark.sql(f"""
    ALTER TABLE delta.`{delta_table_path}` 
    SET TBLPROPERTIES (delta.minReaderVersion = 2, delta.minWriterVersion = 5)
""")

# Verify upgrade
spark.sql(f"""
    DESCRIBE DETAIL delta.`{delta_table_path}`
""").select("protocol.*").show()
```

## Common Issues and Solutions

### Issue: Slow query performance despite optimization

__Solution__:

- Check data skew in partitions
- Verify Z-ORDER columns match query predicates
- Consider adjusting file sizes for your specific workload

### Issue: VACUUM removing files that are still needed

__Solution__:

- Use longer retention periods (7 days minimum recommended)
- Always run with DRY RUN first
- Ensure no long-running queries or operations are using old versions

### Issue: Out of memory errors during OPTIMIZE

__Solution__:

- Optimize smaller partitions individually
- Increase executor memory
- Use bin-packing optimization instead of Z-ORDER for very large tables

## Related Links

- [Azure Synapse Analytics documentation](https://learn.microsoft.com/en-us/azure/synapse-analytics/)
- [Delta Lake optimization documentation](https://docs.delta.io/latest/optimizations-oss.html)
- [Performance tuning guide for Spark in Azure Synapse](https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-performance-hyperspace)
