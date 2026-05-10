# Spark Performance Tuning

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **[Synapse](README.md)** | **Spark Performance**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Performance-green?style=flat-square)

Advanced Spark performance tuning for Azure Synapse Analytics.

---

## Execution Optimization

### Catalyst Optimizer

```python
# Enable all optimizations
spark.conf.set("spark.sql.optimizer.excludedRules", "")

# Check applied optimizations
df.explain(True)  # Look for "== Optimized Logical Plan =="
```

### Code Generation

```python
# Enable whole-stage code generation
spark.conf.set("spark.sql.codegen.wholeStage", "true")
spark.conf.set("spark.sql.codegen.factoryMode", "CODEGEN_ONLY")
```

---

## Join Optimization

### Join Strategies

| Strategy | When to Use | Configuration |
|----------|-------------|---------------|
| Broadcast Hash | Small table < 10MB | Auto or hint |
| Sort Merge | Large tables, equality | Default |
| Shuffle Hash | Medium tables | Hint required |

### Broadcast Join

```python
from pyspark.sql.functions import broadcast

# Explicit broadcast (recommended for control)
result = large_df.join(broadcast(small_df), "key")

# Configure threshold
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "50MB")
```

### Sort Merge Join Optimization

```python
# Pre-sort data for repeated joins
sorted_df = df.sortWithinPartitions("key")
sorted_df.write.bucketBy(100, "key").saveAsTable("bucketed_table")

# Joins on bucketed tables skip shuffle
spark.table("bucketed_table").join(spark.table("other_bucketed"), "key")
```

---

## Serialization

### Kryo Serialization

```python
# Enable Kryo (faster than Java serialization)
spark.conf.set("spark.serializer", "org.apache.spark.serializer.KryoSerializer")
spark.conf.set("spark.kryo.registrationRequired", "false")

# Register custom classes
spark.conf.set("spark.kryo.classesToRegister", "com.company.CustomClass")
```

---

## Caching Strategy

### When to Cache

```python
# Cache when DataFrame is reused multiple times
df = spark.read.parquet("/data/large_table")
df.cache()  # Or persist(StorageLevel.MEMORY_AND_DISK)

# Multiple operations on cached data
df.groupBy("region").count().show()
df.groupBy("product").sum("revenue").show()
df.filter("year = 2024").count()

# Release when done
df.unpersist()
```

### Storage Levels

| Level | Use Case |
|-------|----------|
| MEMORY_ONLY | Fast, fits in memory |
| MEMORY_AND_DISK | Large DataFrames |
| DISK_ONLY | Very large, infrequent access |
| MEMORY_ONLY_SER | Memory constrained |

---

## Partition Tuning

### Partition Count

```python
# Rule of thumb: 2-4x CPU cores
num_executors = 10
cores_per_executor = 4
target_partitions = num_executors * cores_per_executor * 3  # = 120

spark.conf.set("spark.sql.shuffle.partitions", str(target_partitions))
```

### Coalesce vs Repartition

```python
# Coalesce: Reduce partitions (no shuffle)
df.coalesce(10).write.parquet("/output")

# Repartition: Change partition count (shuffle)
df.repartition(100).write.parquet("/output")

# Repartition by column (shuffle, then partition)
df.repartition(100, "key").write.parquet("/output")
```

---

## I/O Optimization

### Read Optimization

```python
# Column pruning
df = spark.read.parquet("/data").select("col1", "col2")

# Predicate pushdown
df = spark.read.parquet("/data").filter("date >= '2024-01-01'")

# Schema specification (faster than inference)
schema = StructType([
    StructField("id", LongType()),
    StructField("name", StringType())
])
df = spark.read.schema(schema).parquet("/data")
```

### Write Optimization

```python
# Optimal file size
spark.conf.set("spark.sql.files.maxRecordsPerFile", 1000000)

# Avoid small files
df.coalesce(50).write.parquet("/output")

# Partition by low-cardinality columns
df.write.partitionBy("year", "month").parquet("/output")
```

---

## Monitoring & Profiling

### Spark Metrics

```python
# Enable metrics collection
spark.conf.set("spark.metrics.conf.*.sink.console.class", "org.apache.spark.metrics.sink.ConsoleSink")

# Access via Spark UI or programmatically
sc = spark.sparkContext
print(f"Active jobs: {len(sc.statusTracker().getActiveJobIds())}")
```

### Query Profiling

```sql
-- In Spark SQL
SET spark.sql.codegen.comments = true;
EXPLAIN COST SELECT * FROM table WHERE col = 'value';
```

---

## Performance Checklist

| Metric | Target | Impact |
|--------|--------|--------|
| Task time variance | < 2x | Reduce skew |
| Shuffle read | Minimize | Use broadcast |
| Spill | 0 | Increase memory |
| GC time | < 10% | Tune executor memory |
| Serialization | < 5% | Use Kryo |

---

## Related Documentation

- [Spark Best Practices](spark-best-practices.md)
- [Spark Troubleshooting](../../../troubleshooting/spark-troubleshooting.md)
- [Spark Pool Configuration](../../../02-services/analytics-compute/azure-synapse/spark-pools/README.md)

---

*Last Updated: January 2025*
