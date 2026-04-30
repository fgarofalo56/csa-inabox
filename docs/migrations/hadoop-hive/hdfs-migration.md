# HDFS to ADLS Gen2 Migration

**A comprehensive guide for migrating data from Hadoop Distributed File System (HDFS) to Azure Data Lake Storage Gen2, covering bulk transfer, format conversion, partition preservation, small-file compaction, and data validation.**

---

## Overview

HDFS to ADLS Gen2 is the foundational migration step. Every other component — Hive, Spark, HBase, Oozie — depends on data being accessible in Azure storage. The good news: ADLS Gen2 implements the HDFS-compatible API (via the `abfss://` driver), which means most Spark and Hive code requires only a URI change.

This guide covers:

1. Understanding the HDFS-compatible API on ADLS
2. Bulk data transfer with DistCp and AzCopy
3. File format conversion (ORC, Parquet, Avro to Delta Lake)
4. Partition layout preservation
5. Solving the small-file problem with Delta compaction
6. Snapshot and versioning equivalents
7. Data validation strategies
8. Worked example with end-to-end commands

---

## 1. HDFS-compatible API on ADLS Gen2

ADLS Gen2 exposes an HDFS-compatible REST API via the Azure Blob File System (ABFS) driver. This is not an emulation layer — it is a native protocol that supports:

- Hierarchical namespace (real directories, not prefix-based simulation)
- POSIX ACLs
- Atomic rename operations
- Append operations
- `abfss://` URI scheme (TLS-encrypted by default)

### URI mapping

```
# Hadoop HDFS
hdfs://namenode.cluster.local:8020/user/hive/warehouse/orders

# ADLS Gen2 equivalent
abfss://raw@mystorageaccount.dfs.core.windows.net/user/hive/warehouse/orders

# Breakdown
# abfss://  → protocol (ABFS over TLS)
# raw       → container (file system) name
# @mystorageaccount.dfs.core.windows.net → storage account DFS endpoint
# /user/hive/warehouse/orders → path (identical to HDFS path)
```

### Spark configuration

```python
# In Spark session configuration (Databricks or Fabric)
spark.conf.set(
    "fs.azure.account.key.mystorageaccount.dfs.core.windows.net",
    dbutils.secrets.get(scope="storage", key="account-key")
)

# Or using managed identity / service principal (recommended)
spark.conf.set(
    "fs.azure.account.auth.type.mystorageaccount.dfs.core.windows.net",
    "OAuth"
)
spark.conf.set(
    "fs.azure.account.oauth.provider.type.mystorageaccount.dfs.core.windows.net",
    "org.apache.hadoop.fs.azurebfs.oauth2.MsiTokenProvider"
)
```

### Code change: minimal

```python
# Before (HDFS)
df = spark.read.parquet("hdfs://namenode:8020/data/orders/")

# After (ADLS Gen2)
df = spark.read.parquet("abfss://raw@storage.dfs.core.windows.net/data/orders/")
```

That is the only code change required for most Spark jobs. The ABFS driver handles all storage operations natively.

---

## 2. Bulk data transfer

### Option A: DistCp (Hadoop native)

DistCp (Distributed Copy) is the standard Hadoop tool for large-scale data movement. It runs as a MapReduce job that copies files in parallel across the cluster.

**Prerequisites:**

- Azure ABFS driver JARs installed on the Hadoop cluster
- Storage account access configured (shared key, SAS token, or service principal)
- Network connectivity (ExpressRoute or VPN recommended for >10 TB)

**Basic DistCp command:**

```bash
hadoop distcp \
  -Dfs.azure.account.key.mystorageaccount.dfs.core.windows.net=<key> \
  -m 100 \
  -bandwidth 500 \
  -update \
  -strategy dynamic \
  hdfs://namenode:8020/user/hive/warehouse/ \
  abfss://raw@mystorageaccount.dfs.core.windows.net/hive/warehouse/
```

**Parameter explanation:**

| Parameter           | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `-m 100`            | Use 100 mapper tasks for parallel copy                      |
| `-bandwidth 500`    | Limit each mapper to 500 MB/s (prevent saturating network)  |
| `-update`           | Only copy files that are new or modified (incremental sync) |
| `-strategy dynamic` | Dynamic work distribution (handles skewed file sizes)       |

**Performance expectations:**

| Network              | Bandwidth           | 100 TB transfer time |
| -------------------- | ------------------- | -------------------- |
| ExpressRoute 10 Gbps | ~1 GB/s effective   | ~28 hours            |
| VPN (1 Gbps)         | ~100 MB/s effective | ~12 days             |
| Internet (100 Mbps)  | ~10 MB/s effective  | ~120 days            |

**Recommendation:** Use ExpressRoute for any migration over 10 TB. For migrations over 100 TB, consider Azure Data Box for the initial bulk load, followed by DistCp for incremental sync.

### Option B: AzCopy

AzCopy is Microsoft's command-line tool for high-performance data transfer to and from Azure Storage. It runs outside the Hadoop cluster and copies data directly.

**When to use AzCopy instead of DistCp:**

- HDFS data is accessible via NFS or local mount
- You want to copy from a staging server rather than running MapReduce
- The Hadoop cluster cannot run additional MapReduce jobs (resource-constrained)

```bash
# Copy from local/NFS mount to ADLS Gen2
azcopy copy \
  "/mnt/hdfs-export/hive/warehouse/" \
  "https://mystorageaccount.dfs.core.windows.net/raw/hive/warehouse/?<SAS>" \
  --recursive \
  --put-md5 \
  --log-level=INFO
```

### Option C: Azure Data Box (>100 TB)

For very large datasets, Azure Data Box provides offline transfer:

1. Order a Data Box Heavy (up to 1 PB)
2. Copy data from HDFS to Data Box via NFS mount
3. Ship Data Box to Azure datacenter
4. Data appears in ADLS Gen2
5. Run DistCp for delta sync (files changed after Data Box snapshot)

---

## 3. File format conversion

### Why convert to Delta Lake?

| Feature               | Parquet/ORC on HDFS | Delta Lake on ADLS                                |
| --------------------- | ------------------- | ------------------------------------------------- |
| ACID transactions     | No                  | Yes                                               |
| Time travel           | No                  | Yes (30-day default, configurable)                |
| Schema evolution      | Manual              | Managed (additive by default, mergeSchema option) |
| MERGE (upserts)       | Not supported       | First-class operation                             |
| Small-file compaction | Manual scripts      | `OPTIMIZE` command                                |
| Z-ORDER indexing      | Not available       | Built-in data skipping                            |

### ORC to Delta

```python
# Read ORC from HDFS or ADLS staging area
df = spark.read.format("orc").load(
    "abfss://raw@storage.dfs.core.windows.net/staging/orders_orc/"
)

# Write as Delta to curated zone
df.write.format("delta") \
    .mode("overwrite") \
    .partitionBy("year", "month") \
    .save("abfss://silver@storage.dfs.core.windows.net/orders/")

# Register as table in Unity Catalog
spark.sql("""
    CREATE TABLE silver.orders
    USING DELTA
    LOCATION 'abfss://silver@storage.dfs.core.windows.net/orders/'
""")
```

### Parquet to Delta (in-place conversion)

If data is already in Parquet format, Delta supports in-place conversion without rewriting the data files:

```sql
-- Convert existing Parquet directory to Delta (no data rewrite)
CONVERT TO DELTA parquet.`abfss://raw@storage.dfs.core.windows.net/orders_parquet/`
PARTITIONED BY (year INT, month INT);
```

This adds a Delta transaction log to the existing Parquet files. The underlying data files are not copied or rewritten.

### Avro to Delta

```python
# Read Avro
df = spark.read.format("avro").load(
    "abfss://raw@storage.dfs.core.windows.net/staging/events_avro/"
)

# Write as Delta
df.write.format("delta") \
    .mode("overwrite") \
    .save("abfss://silver@storage.dfs.core.windows.net/events/")
```

### CSV/Text to Delta

```python
# Read CSV with schema inference
df = spark.read.format("csv") \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .load("abfss://raw@storage.dfs.core.windows.net/staging/legacy_csv/")

# Write as Delta with explicit schema
df.write.format("delta") \
    .mode("overwrite") \
    .save("abfss://silver@storage.dfs.core.windows.net/legacy_data/")
```

---

## 4. Partition layout preservation

### HDFS partition structure

Hive-style partitioning creates directory trees:

```
/user/hive/warehouse/orders/
  year=2024/
    month=01/
      part-00000.parquet
      part-00001.parquet
    month=02/
      ...
  year=2025/
    ...
```

### ADLS Gen2 partition structure

Delta Lake supports the same Hive-style partitioning. DistCp preserves the directory structure, so partitions map 1:1:

```
abfss://silver@storage.dfs.core.windows.net/orders/
  year=2024/
    month=01/
      part-00000.snappy.parquet
      part-00001.snappy.parquet
    month=02/
      ...
  year=2025/
    ...
```

### Partition optimization: from Hive partitioning to liquid clustering

For new workloads, consider using Databricks liquid clustering instead of traditional partitioning:

```sql
-- Traditional Hive-style partitioning (compatible but not optimal)
CREATE TABLE silver.orders
USING DELTA
PARTITIONED BY (year, month)
LOCATION 'abfss://silver@storage.dfs.core.windows.net/orders/';

-- Modern liquid clustering (better for most query patterns)
CREATE TABLE silver.orders_v2
USING DELTA
CLUSTER BY (order_date, customer_id)
LOCATION 'abfss://silver@storage.dfs.core.windows.net/orders_v2/';
```

Liquid clustering automatically handles data layout optimization. It replaces the need for manual partitioning decisions and Z-ORDER operations.

---

## 5. The small-file problem and Delta compaction

### The problem

HDFS clusters accumulate millions of small files over time:

- Streaming jobs that write micro-batches every few seconds
- Hive INSERT INTO statements that create one file per insert
- MapReduce jobs that create one file per mapper
- Failed/retried jobs that leave orphan files

Small files cause:

- NameNode memory pressure (HDFS) / transaction log bloat (Delta)
- Slow query performance (many file opens per query)
- Increased storage API costs (ADLS charges per transaction)

### The Delta solution: OPTIMIZE

```sql
-- Compact small files into optimal-sized files (target: 1 GB per file)
OPTIMIZE silver.orders;

-- Compact with Z-ORDER for query acceleration
OPTIMIZE silver.orders
ZORDER BY (customer_id, order_date);

-- Compact specific partitions only
OPTIMIZE silver.orders
WHERE year = 2025 AND month = 4;
```

### Automated compaction

In Databricks, enable auto-compaction:

```sql
ALTER TABLE silver.orders
SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

### Pre-migration compaction

Before migrating from HDFS, consider compacting small files on the source to reduce transfer time:

```bash
# On Hadoop: merge small files using Spark
spark-submit --class com.example.SmallFileCompactor \
  --master yarn \
  --num-executors 20 \
  compact-job.jar \
  --input hdfs:///user/hive/warehouse/orders/ \
  --output hdfs:///staging/orders_compacted/ \
  --target-size 256mb
```

---

## 6. HDFS snapshots vs ADLS soft delete and Delta time travel

### HDFS snapshots

HDFS provides directory-level snapshots: read-only, point-in-time copies of a directory tree.

```bash
# Create HDFS snapshot
hdfs dfs -createSnapshot /user/hive/warehouse/orders snapshot_20250430
# Access snapshot data
hdfs dfs -ls /user/hive/warehouse/orders/.snapshot/snapshot_20250430/
```

### Azure equivalents

| HDFS feature             | Azure equivalent                            | Scope                   |
| ------------------------ | ------------------------------------------- | ----------------------- |
| HDFS directory snapshot  | ADLS Gen2 soft delete (7-365 day retention) | Container or blob level |
| HDFS snapshot diff       | Delta Lake time travel                      | Table level             |
| HDFS snapshot for backup | ADLS blob versioning + lifecycle management | Blob level              |

### Delta time travel

Delta time travel is more powerful than HDFS snapshots because it operates at the table level with full query support:

```sql
-- Query data as it was 7 days ago
SELECT * FROM silver.orders TIMESTAMP AS OF '2025-04-23';

-- Query data as it was at a specific version
SELECT * FROM silver.orders VERSION AS OF 42;

-- Restore table to a previous version
RESTORE TABLE silver.orders TO VERSION AS OF 42;
```

---

## 7. Data validation

### Checksum-based validation

```bash
# Generate HDFS checksums
hdfs dfs -checksum /user/hive/warehouse/orders/year=2025/month=04/part-00000.parquet

# Generate ADLS checksum (via AzCopy with MD5)
azcopy copy --put-md5 ...
# Then validate MD5 matches via Azure Storage API
```

### Row count validation

```python
# Count rows in HDFS source
hdfs_count = spark.read.parquet("hdfs:///user/hive/warehouse/orders/").count()

# Count rows in ADLS target
adls_count = spark.read.format("delta").load(
    "abfss://silver@storage.dfs.core.windows.net/orders/"
).count()

assert hdfs_count == adls_count, f"Row count mismatch: HDFS={hdfs_count}, ADLS={adls_count}"
```

### Schema validation

```python
# Compare schemas
hdfs_schema = spark.read.parquet("hdfs:///user/hive/warehouse/orders/").schema
adls_schema = spark.read.format("delta").load(
    "abfss://silver@storage.dfs.core.windows.net/orders/"
).schema

assert hdfs_schema == adls_schema, "Schema mismatch detected"
```

### Aggregate validation

```python
# Compare key aggregates
hdfs_agg = spark.read.parquet("hdfs:///user/hive/warehouse/orders/") \
    .agg(
        F.count("*").alias("row_count"),
        F.sum("amount").alias("total_amount"),
        F.countDistinct("customer_id").alias("unique_customers"),
        F.min("order_date").alias("min_date"),
        F.max("order_date").alias("max_date")
    ).collect()[0]

adls_agg = spark.read.format("delta").load(
    "abfss://silver@storage.dfs.core.windows.net/orders/"
).agg(
    F.count("*").alias("row_count"),
    F.sum("amount").alias("total_amount"),
    F.countDistinct("customer_id").alias("unique_customers"),
    F.min("order_date").alias("min_date"),
    F.max("order_date").alias("max_date")
).collect()[0]

# Compare each metric
for field in ["row_count", "total_amount", "unique_customers", "min_date", "max_date"]:
    assert hdfs_agg[field] == adls_agg[field], f"Mismatch in {field}"
```

---

## 8. Worked example: end-to-end HDFS to ADLS migration

### Scenario

Migrate 50 TB Hive warehouse from a 60-node Cloudera CDH cluster to ADLS Gen2, converting ORC to Delta Lake.

### Step 1: Inventory

```bash
# Count files and total size per table
hdfs dfs -du -s -h /user/hive/warehouse/* | sort -rh | head -20
```

### Step 2: Provision Azure resources

```bash
# Create storage account with hierarchical namespace
az storage account create \
  --name migrationlake \
  --resource-group rg-migration \
  --location eastus2 \
  --sku Standard_ZRS \
  --kind StorageV2 \
  --hns true

# Create containers
az storage fs create --name raw --account-name migrationlake
az storage fs create --name silver --account-name migrationlake
az storage fs create --name gold --account-name migrationlake
```

### Step 3: Install ABFS driver on Hadoop cluster

```bash
# Download and install azure-storage JARs to Hadoop classpath
# (Version depends on your Hadoop version)
cp azure-storage-*.jar $HADOOP_HOME/share/hadoop/common/lib/
cp hadoop-azure-*.jar $HADOOP_HOME/share/hadoop/common/lib/
```

### Step 4: Bulk copy with DistCp

```bash
# Phase 1: Initial bulk copy
hadoop distcp \
  -Dfs.azure.account.key.migrationlake.dfs.core.windows.net=$STORAGE_KEY \
  -m 200 \
  -bandwidth 500 \
  -log /tmp/distcp-log \
  hdfs://namenode:8020/user/hive/warehouse/ \
  abfss://raw@migrationlake.dfs.core.windows.net/hive/warehouse/
```

### Step 5: Convert ORC to Delta (Databricks notebook)

```python
import os
from pyspark.sql import functions as F

# List all tables in the migrated warehouse
tables = dbutils.fs.ls("abfss://raw@migrationlake.dfs.core.windows.net/hive/warehouse/")

for table_dir in tables:
    table_name = table_dir.name.rstrip("/")
    source_path = table_dir.path
    target_path = f"abfss://silver@migrationlake.dfs.core.windows.net/{table_name}/"

    print(f"Converting {table_name}...")

    # Read ORC
    df = spark.read.format("orc").load(source_path)

    # Write as Delta with same partitioning
    partition_cols = [c for c in df.columns if c.startswith("year") or c.startswith("month")]
    writer = df.write.format("delta").mode("overwrite")
    if partition_cols:
        writer = writer.partitionBy(*partition_cols)
    writer.save(target_path)

    # Register in Unity Catalog
    spark.sql(f"""
        CREATE TABLE IF NOT EXISTS silver.{table_name}
        USING DELTA
        LOCATION '{target_path}'
    """)

    print(f"  Registered silver.{table_name}")
```

### Step 6: Validate

```python
# Run validation for each table
validation_results = []
for table_dir in tables:
    table_name = table_dir.name.rstrip("/")
    source_count = spark.read.format("orc").load(table_dir.path).count()
    target_count = spark.table(f"silver.{table_name}").count()
    match = source_count == target_count
    validation_results.append((table_name, source_count, target_count, match))

# Display results
validation_df = spark.createDataFrame(
    validation_results,
    ["table", "source_rows", "target_rows", "match"]
)
validation_df.show(100, truncate=False)
```

### Step 7: Delta sync (catch changes during migration)

```bash
# Run DistCp in update mode to catch files changed during conversion
hadoop distcp \
  -Dfs.azure.account.key.migrationlake.dfs.core.windows.net=$STORAGE_KEY \
  -m 50 \
  -update \
  hdfs://namenode:8020/user/hive/warehouse/ \
  abfss://raw@migrationlake.dfs.core.windows.net/hive/warehouse/
```

---

## Common issues and solutions

| Issue                        | Cause                                      | Solution                                                                          |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| DistCp fails with OOM        | Too many small files overwhelming NameNode | Use `-strategy dynamic` and reduce `-m` count                                     |
| ABFS driver not found        | Missing JARs on Hadoop classpath           | Install `hadoop-azure` and `azure-storage` JARs                                   |
| Permission denied on ADLS    | Incorrect authentication configuration     | Use shared key, SAS, or service principal with Storage Blob Data Contributor role |
| Slow transfer speed          | Network bottleneck (VPN)                   | Use ExpressRoute or Azure Data Box for large datasets                             |
| File count mismatch          | .hive-staging or \_SUCCESS files           | Filter these during validation; they are metadata, not data                       |
| ORC to Delta schema mismatch | Hive complex types (STRUCT, MAP, ARRAY)    | Verify complex type compatibility; most work natively                             |

---

## Related

- [Tutorial: HDFS to ADLS Gen2](tutorial-hdfs-to-adls.md) — step-by-step tutorial
- [Hive Migration](hive-migration.md) — metastore and SQL migration
- [Feature Mapping](feature-mapping-complete.md) — all component mappings
- [Migration Hub](index.md) — full migration center

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Tutorial: HDFS to ADLS](tutorial-hdfs-to-adls.md) | [Hive Migration](hive-migration.md) | [Migration Hub](index.md)
