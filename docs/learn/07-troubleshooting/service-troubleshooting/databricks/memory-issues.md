# Azure Databricks Memory Issues Troubleshooting

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

Guide for diagnosing and resolving memory-related issues in Azure Databricks including OutOfMemoryError, executor crashes, and memory pressure.

## Table of Contents

- [Common Memory Issues](#common-memory-issues)
- [Diagnostic Approach](#diagnostic-approach)
- [Resolution Strategies](#resolution-strategies)
- [Prevention Best Practices](#prevention-best-practices)
- [Related Resources](#related-resources)

---

## Common Memory Issues

### Issue 1: OutOfMemoryError

**Symptoms:**
- `java.lang.OutOfMemoryError: Java heap space`
- Executor failures
- Driver crashes
- Job failures during shuffle operations

**Common Causes:**

| Cause | Likelihood | Impact | Solution |
|:------|:-----------|:-------|:---------|
| Insufficient executor memory | High | High | Increase memory allocation |
| Memory-intensive operations | High | High | Optimize transformations |
| Data skew | Medium | High | Repartition data |
| Broadcast joins too large | Medium | High | Use shuffle join instead |
| Caching too much data | Medium | Medium | Selective caching |

**Resolution:**

```python
# Check current Spark configuration
print("Current Memory Configuration:")
print(f"Driver Memory: {spark.conf.get('spark.driver.memory')}")
print(f"Executor Memory: {spark.conf.get('spark.executor.memory')}")
print(f"Executor Cores: {spark.conf.get('spark.executor.cores')}")

# Optimize memory configuration
spark.conf.set("spark.executor.memory", "16g")
spark.conf.set("spark.executor.memoryOverhead", "4g")
spark.conf.set("spark.driver.memory", "8g")
spark.conf.set("spark.memory.fraction", "0.8")
spark.conf.set("spark.memory.storageFraction", "0.3")
```

### Issue 2: Executor Memory Pressure

**Symptoms:**
- Slow garbage collection
- Frequent executor restarts
- Spilling to disk
- Performance degradation

**Resolution:**

```python
from pyspark.sql import functions as F

# Monitor task metrics
def analyze_task_metrics():
    """Analyze task-level memory usage."""

    # Get metrics from SparkUI
    sc = spark.sparkContext
    status_tracker = sc.statusTracker()

    active_jobs = status_tracker.getActiveJobIds()

    for job_id in active_jobs:
        job_info = status_tracker.getJobInfo(job_id)
        stage_ids = job_info.stageIds()

        for stage_id in stage_ids:
            stage_info = status_tracker.getStageInfo(stage_id)

            if stage_info:
                print(f"Stage {stage_id}:")
                print(f"  Tasks: {stage_info.numTasks}")
                print(f"  Memory Spilled: {stage_info.memoryBytesSpilled}")
                print(f"  Disk Spilled: {stage_info.diskBytesSpilled}")

# Optimize partition size
def optimize_partitions(df, target_partition_size_mb=128):
    """Optimize DataFrame partitions."""

    # Calculate current partition size
    num_partitions = df.rdd.getNumPartitions()
    df_size_mb = df.rdd.map(lambda x: len(str(x))).sum() / (1024 * 1024)

    # Calculate optimal partitions
    optimal_partitions = max(1, int(df_size_mb / target_partition_size_mb))

    print(f"Current partitions: {num_partitions}")
    print(f"DataFrame size: {df_size_mb:.2f} MB")
    print(f"Recommended partitions: {optimal_partitions}")

    if num_partitions != optimal_partitions:
        df = df.repartition(optimal_partitions)

    return df
```

---

## Diagnostic Approach

### Check Memory Metrics

```python
import requests
import json

def get_executor_memory_metrics(cluster_id):
    """Get executor memory metrics from Spark UI."""

    # Access Spark UI metrics endpoint
    spark_ui_url = f"https://<workspace>.cloud.databricks.com/driver-proxy-api/o/0/{cluster_id}/api/v1/applications"

    # Get application executors
    response = requests.get(f"{spark_ui_url}/executors")
    executors = response.json()

    print("💾 Executor Memory Status:")
    for executor in executors:
        executor_id = executor.get('id')
        memory_used = executor.get('memoryUsed', 0)
        memory_total = executor.get('totalMemory', 1)
        memory_percent = (memory_used / memory_total) * 100

        print(f"\nExecutor {executor_id}:")
        print(f"  Memory Used: {memory_used / (1024**3):.2f} GB")
        print(f"  Total Memory: {memory_total / (1024**3):.2f} GB")
        print(f"  Usage: {memory_percent:.1f}%")

        if memory_percent > 80:
            print(f"  ⚠️ HIGH MEMORY USAGE!")
```

---

## Resolution Strategies

### 1. Optimize Spark Configuration

```python
# Recommended memory configuration
optimal_config = {
    # Executor memory settings
    "spark.executor.memory": "16g",
    "spark.executor.memoryOverhead": "4g",  # 25% of executor memory
    "spark.executor.cores": "4",

    # Driver memory settings
    "spark.driver.memory": "8g",
    "spark.driver.maxResultSize": "4g",

    # Memory management
    "spark.memory.fraction": "0.8",  # 80% for execution and storage
    "spark.memory.storageFraction": "0.3",  # 30% of memory fraction for caching

    # Shuffle settings
    "spark.sql.shuffle.partitions": "200",
    "spark.shuffle.file.buffer": "1m",

    # Optimization
    "spark.sql.adaptive.enabled": "true",
    "spark.sql.adaptive.coalescePartitions.enabled": "true"
}

# Apply configuration
for key, value in optimal_config.items():
    spark.conf.set(key, value)
```

### 2. Optimize Data Operations

```python
# Avoid collecting large datasets
# Bad
large_df = spark.read.parquet("/data/large_dataset")
results = large_df.collect()  # ❌ Loads all data into driver memory

# Good
results = large_df.limit(1000).collect()  # ✅ Limit data size

# Use efficient joins
# Bad - broadcast join on large table
large_df1.join(broadcast(large_df2), "id")  # ❌ OOM if df2 is too large

# Good - check size before broadcast
df2_size = large_df2.count()
if df2_size < 10000:
    result = large_df1.join(broadcast(large_df2), "id")
else:
    result = large_df1.join(large_df2, "id")  # Shuffle join

# Selective caching
# Bad
large_df.cache()  # ❌ Caches entire dataset

# Good
filtered_df = large_df.filter(F.col("date") >= "2024-01-01")
filtered_df.cache()  # ✅ Cache only needed data
```

---

## Prevention Best Practices

### Memory Monitoring

```python
def setup_memory_monitoring():
    """Configure memory monitoring and alerts."""

    # Log memory metrics periodically
    from py4j.java_gateway import java_import

    jvm = spark.sparkContext._jvm
    java_import(jvm, "java.lang.management.ManagementFactory")

    mem_bean = jvm.ManagementFactory.getMemoryMXBean()
    heap_usage = mem_bean.getHeapMemoryUsage()

    print(f"Heap Memory:")
    print(f"  Used: {heap_usage.getUsed() / (1024**3):.2f} GB")
    print(f"  Committed: {heap_usage.getCommitted() / (1024**3):.2f} GB")
    print(f"  Max: {heap_usage.getMax() / (1024**3):.2f} GB")
```

---

## Related Resources

| Resource | Description |
|----------|-------------|
| [Query Performance](query-performance.md) | Query optimization techniques |
| [Shuffle Optimization](shuffle-optimization.md) | Reduce shuffle memory usage |
| [Databricks Performance Guide](https://docs.databricks.com/optimizations/index.html) | Official documentation |

---

> **💡 Memory Tip:** Always monitor memory usage and set appropriate limits. Prevent issues before they cause job failures.

**Last Updated:** 2025-12-10
**Version:** 1.0.0
