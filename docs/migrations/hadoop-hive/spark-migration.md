# Spark on YARN to Databricks / Fabric Spark Migration

**A comprehensive guide for migrating Apache Spark workloads from YARN-managed Hadoop clusters to Databricks and Microsoft Fabric Spark, covering version compatibility, job submission, cluster policies, library management, and Delta Lake integration.**

---

## Overview

Spark on YARN is the compute workhorse of most Hadoop clusters. The good news: Spark code is highly portable. PySpark, Scala Spark, and SparkSQL code that runs on YARN will run on Databricks and Fabric with minimal changes. The migration is primarily about operational concerns — how jobs are submitted, how clusters are managed, and how libraries are installed — rather than rewriting application logic.

This guide covers:

1. Spark version compatibility (2.x to 3.x migration)
2. Job submission: spark-submit to Databricks Jobs API / Fabric notebooks
3. Resource management: YARN queues to Databricks cluster policies
4. Library management: manual JARs to managed environments
5. Delta Lake integration
6. PySpark, Scala, and Java compatibility

---

## 1. Spark version compatibility

### The 2.x to 3.x migration

Many Hadoop clusters still run Spark 2.x (2.3 or 2.4). Databricks and Fabric run Spark 3.x (3.4+). This version jump includes breaking changes.

### Key breaking changes: Spark 2.x to 3.x

| Area | Spark 2.x behavior | Spark 3.x behavior | Migration action |
|---|---|---|---|
| `Dataset.unionAll` | Deprecated but functional | Removed | Replace with `union()` |
| `SQLContext` | Primary entry point | Removed | Use `SparkSession` |
| `HiveContext` | Used for Hive access | Removed | Use `SparkSession.enableHiveSupport()` |
| Implicit type coercion | Lenient (string to int) | Strict ANSI mode | Review type casts |
| `pandas_udf` decorator | `@pandas_udf(schema, type)` | `@pandas_udf(returnType)` | Update decorator signature |
| Date/timestamp | Based on Java Calendar | Based on Java 8 time API (Proleptic Gregorian) | Test date edge cases |
| `spark.sql.legacy.timeParserPolicy` | LEGACY by default | EXCEPTION by default | Set policy or fix date formats |
| `acc` / accumulators | `sc.accumulator()` | `sc.accumulator()` (unchanged but deprecated) | Use `AccumulatorV2` |
| Scala 2.11 | Supported | Dropped (Scala 2.12/2.13 only) | Recompile Scala JARs |

### Automated compatibility check

```python
# Run this on your YARN Spark cluster to identify compatibility issues
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

# Check for deprecated API usage
print(f"Spark version: {spark.version}")
print(f"Scala version: {spark.sparkContext._jvm.scala.util.Properties.versionString()}")

# Check for legacy configurations
legacy_configs = [
    "spark.sql.legacy.timeParserPolicy",
    "spark.sql.legacy.createHiveTableByDefault",
    "spark.sql.legacy.allowCreatingManagedTableUsingNonemptyLocation",
]
for config in legacy_configs:
    try:
        val = spark.conf.get(config)
        print(f"  {config} = {val}")
    except Exception:
        print(f"  {config} = not set")
```

### Spark 3.x feature gains

Migrating to Spark 3.x is not just a compatibility exercise — it brings significant improvements:

| Feature | Benefit |
|---|---|
| Adaptive Query Execution (AQE) | Automatic optimization of joins, shuffles, and partition sizes |
| Dynamic Partition Pruning | Faster queries on partitioned tables |
| Photon engine (Databricks) | C++ native engine, 2-8x faster for SQL/DataFrame workloads |
| Structured streaming improvements | Better exactly-once semantics, trigger.availableNow |
| Python 3.8+ support | Modern Python features, better type hints |
| Pandas API on Spark | Drop-in replacement for pandas at scale |
| Delta Lake native integration | First-class Delta support in Spark 3.x |

---

## 2. Job submission: spark-submit to Databricks/Fabric

### YARN spark-submit (before)

```bash
spark-submit \
  --master yarn \
  --deploy-mode cluster \
  --driver-memory 8g \
  --executor-memory 16g \
  --executor-cores 4 \
  --num-executors 20 \
  --queue production \
  --conf spark.dynamicAllocation.enabled=true \
  --conf spark.dynamicAllocation.minExecutors=5 \
  --conf spark.dynamicAllocation.maxExecutors=50 \
  --jars hdfs:///lib/mysql-connector.jar,hdfs:///lib/custom-udf.jar \
  --py-files hdfs:///lib/utils.zip \
  hdfs:///apps/etl/daily_orders.py \
  --date 2025-04-30
```

### Databricks Jobs API (after)

```json
{
    "name": "daily_orders_etl",
    "tasks": [
        {
            "task_key": "daily_orders",
            "spark_python_task": {
                "python_file": "dbfs:/apps/etl/daily_orders.py",
                "parameters": ["--date", "{{job.trigger_time.iso_date}}"]
            },
            "new_cluster": {
                "spark_version": "14.3.x-scala2.12",
                "node_type_id": "Standard_D16s_v5",
                "autoscale": {
                    "min_workers": 5,
                    "max_workers": 50
                },
                "spark_conf": {
                    "spark.sql.shuffle.partitions": "auto"
                }
            },
            "libraries": [
                {"pypi": {"package": "mysql-connector-python"}},
                {"jar": "dbfs:/lib/custom-udf.jar"}
            ]
        }
    ],
    "schedule": {
        "quartz_cron_expression": "0 0 2 * * ?",
        "timezone_id": "America/New_York"
    }
}
```

### Fabric notebook scheduling (after)

```python
# In a Fabric notebook, the code is the same PySpark
# Scheduling is configured in the Fabric UI or via REST API

# The notebook runs in a Fabric Spark pool with auto-scaling
# No spark-submit needed — the notebook IS the job

from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

# Same PySpark code as before, just change paths
df = spark.read.format("delta").load(
    "abfss://silver@onelake.dfs.fabric.microsoft.com/warehouse/orders/"
)
# ... transformations ...
df.write.format("delta").mode("overwrite").save(
    "abfss://gold@onelake.dfs.fabric.microsoft.com/warehouse/daily_orders/"
)
```

### Mapping spark-submit parameters

| spark-submit parameter | Databricks equivalent | Fabric equivalent |
|---|---|---|
| `--master yarn` | Not needed (managed) | Not needed (managed) |
| `--deploy-mode cluster` | Default behavior | Default behavior |
| `--driver-memory 8g` | `driver_node_type_id` | Spark pool configuration |
| `--executor-memory 16g` | `node_type_id` | Spark pool node size |
| `--executor-cores 4` | Determined by node type | Determined by node size |
| `--num-executors 20` | `autoscale.min_workers` | Pool min nodes |
| `--queue production` | Cluster policy | Workspace/capacity allocation |
| `--jars` | `libraries[].jar` | Environment configuration |
| `--py-files` | `libraries[].whl` or dbfs upload | Environment configuration |
| `--conf` | `spark_conf{}` | `%%configure` magic or Spark pool settings |

---

## 3. Resource management: YARN to cluster policies

### YARN queue model

```xml
<!-- YARN capacity-scheduler.xml (before) -->
<property>
    <name>yarn.scheduler.capacity.root.queues</name>
    <value>production,development,adhoc</value>
</property>
<property>
    <name>yarn.scheduler.capacity.root.production.capacity</name>
    <value>60</value>
</property>
<property>
    <name>yarn.scheduler.capacity.root.development.capacity</name>
    <value>25</value>
</property>
<property>
    <name>yarn.scheduler.capacity.root.adhoc.capacity</name>
    <value>15</value>
</property>
```

### Databricks cluster policies (after)

```json
{
    "name": "Production ETL Policy",
    "definition": {
        "spark_version": {
            "type": "allowlist",
            "values": ["14.3.x-scala2.12", "15.0.x-scala2.12"]
        },
        "node_type_id": {
            "type": "allowlist",
            "values": ["Standard_D16s_v5", "Standard_D32s_v5"]
        },
        "autoscale.min_workers": {
            "type": "range",
            "minValue": 2,
            "maxValue": 10,
            "defaultValue": 4
        },
        "autoscale.max_workers": {
            "type": "range",
            "minValue": 4,
            "maxValue": 100,
            "defaultValue": 20
        },
        "custom_tags.Environment": {
            "type": "fixed",
            "value": "production"
        },
        "spark_conf.spark.databricks.cluster.profile": {
            "type": "fixed",
            "value": "singleNode",
            "hidden": true
        }
    }
}
```

### Multi-tenancy mapping

| YARN concept | Databricks equivalent | Fabric equivalent |
|---|---|---|
| Queue | Cluster policy | Workspace + capacity |
| Capacity percentage | Max DBU budget per policy | Capacity units (CU) allocation |
| User ACL on queue | Cluster policy permissions | Workspace role assignment |
| Preemption | Serverless SQL (auto-managed) | Capacity burst |
| Fair scheduling | SQL warehouse auto-scaling | Fabric capacity auto-scale |

---

## 4. Library management

### YARN library management (before)

```bash
# Method 1: Ship JARs with spark-submit
spark-submit --jars custom-udf.jar,mysql-connector.jar ...

# Method 2: Put JARs on HDFS
hdfs dfs -put custom-udf.jar /lib/
spark-submit --jars hdfs:///lib/custom-udf.jar ...

# Method 3: Install on every node (fragile)
ansible -i hadoop-nodes -m copy -a "src=custom-udf.jar dest=/opt/spark/jars/"
```

### Databricks library management (after)

```python
# Method 1: Cluster libraries (installed on cluster start)
# Configure in cluster settings or via API:
# - PyPI packages: pandas, numpy, scikit-learn
# - Maven packages: com.mysql:mysql-connector-j:8.0.33
# - Custom JARs: uploaded to DBFS or Unity Catalog volumes

# Method 2: Notebook-scoped libraries
%pip install pandas==2.1.0 scikit-learn==1.3.0

# Method 3: Init scripts (for system-level dependencies)
# dbfs:/init-scripts/install-gdal.sh
#!/bin/bash
apt-get install -y gdal-bin libgdal-dev

# Method 4: Unity Catalog volumes (recommended for JARs)
# Upload JAR to volume, reference in cluster config
```

### Fabric library management (after)

```python
# Method 1: Fabric environment configuration
# Define Python packages and JARs in the Fabric environment UI

# Method 2: In-line installation in notebooks
%pip install pandas==2.1.0

# Method 3: Custom Spark properties
%%configure
{
    "conf": {
        "spark.jars": "abfss://libs@onelake.dfs.fabric.microsoft.com/custom-udf.jar"
    }
}
```

---

## 5. Delta Lake integration

### Converting Spark jobs to use Delta

Most Spark jobs on YARN read and write Parquet or ORC. Converting to Delta requires minimal code changes:

```python
# BEFORE: Parquet on HDFS
df = spark.read.parquet("hdfs:///data/orders/")
df.write.mode("overwrite").parquet("hdfs:///data/daily_orders/")

# AFTER: Delta on ADLS Gen2
df = spark.read.format("delta").load("abfss://silver@storage.dfs.core.windows.net/orders/")
df.write.format("delta").mode("overwrite").save("abfss://gold@storage.dfs.core.windows.net/daily_orders/")
```

### Delta-specific features to adopt

```python
# MERGE (upsert) — replaces complex insert-overwrite patterns
from delta.tables import DeltaTable

target = DeltaTable.forPath(spark, "abfss://silver@storage.dfs.core.windows.net/orders/")
source = spark.read.format("delta").load("abfss://bronze@storage.dfs.core.windows.net/new_orders/")

target.alias("t").merge(
    source.alias("s"),
    "t.order_id = s.order_id"
).whenMatchedUpdate(set={
    "amount": "s.amount",
    "status": "s.status",
    "updated_at": "current_timestamp()"
}).whenNotMatchedInsert(values={
    "order_id": "s.order_id",
    "customer_id": "s.customer_id",
    "amount": "s.amount",
    "status": "s.status",
    "created_at": "current_timestamp()",
    "updated_at": "current_timestamp()"
}).execute()
```

### Structured streaming: YARN to Databricks

```python
# BEFORE: Structured streaming on YARN reading from Kafka
df = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "kafka1:9092,kafka2:9092") \
    .option("subscribe", "orders") \
    .load()

parsed = df.selectExpr("CAST(value AS STRING)").select(from_json("value", schema).alias("data")).select("data.*")

parsed.writeStream \
    .format("parquet") \
    .option("checkpointLocation", "hdfs:///checkpoints/orders/") \
    .option("path", "hdfs:///data/streaming_orders/") \
    .trigger(processingTime="1 minute") \
    .start()

# AFTER: Structured streaming on Databricks reading from Event Hubs (Kafka protocol)
df = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "mynamespace.servicebus.windows.net:9093") \
    .option("subscribe", "orders") \
    .option("kafka.security.protocol", "SASL_SSL") \
    .option("kafka.sasl.mechanism", "PLAIN") \
    .option("kafka.sasl.jaas.config",
        'org.apache.kafka.common.security.plain.PlainLoginModule required '
        'username="$ConnectionString" '
        f'password="{dbutils.secrets.get("eventhubs", "connection-string")}";') \
    .load()

parsed = df.selectExpr("CAST(value AS STRING)").select(from_json("value", schema).alias("data")).select("data.*")

parsed.writeStream \
    .format("delta") \
    .option("checkpointLocation", "abfss://checkpoints@storage.dfs.core.windows.net/orders/") \
    .trigger(availableNow=True) \
    .toTable("silver.streaming_orders")
```

---

## 6. PySpark, Scala, and Java compatibility

### PySpark (highest compatibility)

PySpark code is the most portable. Most PySpark jobs run on Databricks/Fabric with only path changes:

| Change needed | Effort |
|---|---|
| HDFS paths to ADLS paths | Find-and-replace |
| `SparkContext`/`HiveContext` to `SparkSession` | Minor refactor |
| Python 2 to Python 3 | May require significant effort if still on Python 2 |
| Custom UDFs | Re-register in Databricks/Fabric |

### Scala Spark

Scala Spark jobs require recompilation for the target Spark and Scala version:

| Change needed | Effort |
|---|---|
| Recompile for Scala 2.12 (from 2.11) | Update build.sbt, fix deprecations |
| Update Spark dependency version | Update build.sbt, test for API changes |
| Remove Hadoop-specific imports | Replace `org.apache.hadoop.*` with ABFS equivalents where needed |
| Package as fat JAR or wheel | Standard sbt assembly |

### Java Spark

Java Spark jobs follow the same pattern as Scala:

| Change needed | Effort |
|---|---|
| Update Maven POM for Spark 3.x | Update dependency versions |
| Recompile and test | Standard Maven build |
| Replace deprecated APIs | `JavaSparkContext` → `SparkSession` patterns |

---

## Configuration migration reference

| YARN Spark config | Databricks equivalent | Notes |
|---|---|---|
| `spark.executor.memory` | Determined by `node_type_id` | Node type defines memory |
| `spark.executor.cores` | Determined by `node_type_id` | Node type defines cores |
| `spark.dynamicAllocation.enabled` | Autoscale enabled by default | Built into cluster config |
| `spark.yarn.queue` | Cluster policy | Different paradigm |
| `spark.hadoop.fs.defaultFS` | Not needed | ADLS configured per workspace |
| `spark.sql.warehouse.dir` | Managed by Unity Catalog | Auto-configured |
| `spark.eventLog.dir` | Managed by Databricks | Auto-configured to DBFS |
| `spark.sql.shuffle.partitions` | `auto` (AQE handles this) | Let AQE decide |
| `spark.serializer` | KryoSerializer (default) | Already optimized |

---

## Common pitfalls

| Pitfall | Mitigation |
|---|---|
| Hardcoded HDFS paths throughout codebase | Use configuration files or environment variables for all paths |
| Spark 2.x APIs that broke in 3.x | Run Spark migration tool, test thoroughly |
| Scala 2.11 JARs on Scala 2.12 runtime | Recompile all Scala libraries |
| YARN queue assumptions in code | Remove queue references; use cluster policies |
| `spark-submit` scripts as entry points | Convert to Databricks Jobs API or Fabric notebook scheduling |
| Checkpoints on HDFS | Recreate checkpoints on ADLS (streaming jobs restart from scratch) |

---

## Related

- [HDFS Migration](hdfs-migration.md) — storage migration (prerequisite)
- [Hive Migration](hive-migration.md) — Hive/SparkSQL workloads
- [Feature Mapping](feature-mapping-complete.md) — all component mappings
- [Benchmarks](benchmarks.md) — performance comparison data

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [HDFS Migration](hdfs-migration.md) | [Hive Migration](hive-migration.md) | [Benchmarks](benchmarks.md)
