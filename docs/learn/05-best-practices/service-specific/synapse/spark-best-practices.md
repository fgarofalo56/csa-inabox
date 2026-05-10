# Spark Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **[Synapse](README.md)** | **Spark**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Synapse%20Spark-purple?style=flat-square)

Best practices for Apache Spark pools in Azure Synapse Analytics.

---

## Pool Configuration

### Sizing Guidelines

| Workload | Node Size | Min Nodes | Max Nodes |
|----------|-----------|-----------|-----------|
| Development | Small | 3 | 5 |
| ETL (light) | Medium | 3 | 10 |
| ETL (heavy) | Large | 5 | 20 |
| ML Training | Large | 10 | 50 |

### Spark Configuration

```python
# Recommended settings
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")
spark.conf.set("spark.sql.shuffle.partitions", "200")
spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
```

---

## Memory Management

### Executor Tuning

```python
# Memory allocation
spark.conf.set("spark.executor.memory", "8g")
spark.conf.set("spark.executor.memoryOverhead", "2g")
spark.conf.set("spark.driver.memory", "4g")

# For memory-intensive operations
spark.conf.set("spark.memory.fraction", "0.8")
spark.conf.set("spark.memory.storageFraction", "0.3")
```

### Avoiding OOM

```python
# Repartition large DataFrames
df = df.repartition(200)

# Use checkpoint for complex DAGs
df.checkpoint()

# Persist strategically
df.persist(StorageLevel.MEMORY_AND_DISK)
# ... use df multiple times ...
df.unpersist()
```

---

## Shuffle Optimization

### Reduce Shuffles

```python
# Good: Broadcast small tables
from pyspark.sql.functions import broadcast

result = large_df.join(broadcast(small_df), "key")

# Good: Use coalesce instead of repartition for reduction
df.coalesce(10).write.parquet("/output")

# Avoid: Unnecessary shuffles
# df.repartition(100).groupBy("key").count()  # Double shuffle
```

### AQE Settings

```python
# Enable Adaptive Query Execution
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.skewedPartitionFactor", "5")
```

---

## Data Skew Handling

### Identify Skew

```python
# Check partition sizes
df.groupBy(spark_partition_id()).count().show()

# Check key distribution
df.groupBy("key").count().orderBy(desc("count")).show(20)
```

### Fix Skew

```python
# Salting for skewed joins
from pyspark.sql.functions import rand, concat, lit

# Add salt to skewed key
salt_range = 10
df_salted = df.withColumn("salted_key",
    concat(col("key"), lit("_"), (rand() * salt_range).cast("int")))

# Join with exploded salt
```

---

## File Optimization

### Optimal File Sizes

```python
# Target 128MB - 1GB files
# Repartition based on data size
data_size_gb = 50
target_file_size_mb = 256
num_partitions = int(data_size_gb * 1024 / target_file_size_mb)

df.repartition(num_partitions).write.parquet("/output")
```

### Partition Pruning

```python
# Write with partitions
df.write \
    .partitionBy("year", "month") \
    .mode("overwrite") \
    .parquet("/data/events")

# Read with filter (partition pruning)
spark.read.parquet("/data/events") \
    .filter("year = 2024 AND month = 1")  # Only reads that partition
```

---

## Performance Checklist

| Check | Target | Fix |
|-------|--------|-----|
| Shuffle partitions | Match data size | Adjust spark.sql.shuffle.partitions |
| Spill to disk | 0 | Increase memory or reduce data |
| Skewed tasks | < 2x mean | Salt keys or use AQE |
| Task duration | < 2 minutes | Increase parallelism |
| GC time | < 10% | Tune memory settings |

---

## Debugging

### Explain Plan

```python
# View execution plan
df.explain(True)

# View physical plan
df.explain("formatted")
```

### Spark UI Metrics

| Tab | Look For |
|-----|----------|
| Jobs | Failed stages, retries |
| Stages | Skewed tasks, shuffle read/write |
| Storage | Cached RDDs, memory usage |
| SQL | Query plans, scan metrics |

---

## Related Documentation

- [Spark Performance Tuning](spark-performance.md)
- [Spark Pool Configuration](../../../02-services/analytics-compute/azure-synapse/spark-pools/README.md)
- [Delta Lake Best Practices](../databricks/delta-lake.md)

---

*Last Updated: January 2025*
