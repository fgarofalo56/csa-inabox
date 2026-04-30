# Tutorial: Migrate HDFS Data to ADLS Gen2

**A step-by-step tutorial that walks through an end-to-end HDFS to ADLS Gen2 migration, including provisioning, data transfer, format conversion, validation, and verification.**

---

## Prerequisites

Before starting this tutorial, you need:

- [ ] An on-premises Hadoop cluster with HDFS access (or equivalent cloud Hadoop)
- [ ] An Azure subscription with Contributor access
- [ ] Azure CLI installed (`az` command available)
- [ ] Network connectivity between Hadoop cluster and Azure (ExpressRoute, VPN, or internet)
- [ ] A Databricks workspace (for format conversion and validation)

### What you will build

By the end of this tutorial, you will have:

1. An ADLS Gen2 storage account with hierarchical namespace
2. HDFS data copied to ADLS Gen2 via DistCp
3. Data converted from ORC/Parquet to Delta Lake
4. Tables registered in Unity Catalog (Databricks)
5. Validated data integrity between source and target

### Estimated time

| Step                                    | Duration                                  |
| --------------------------------------- | ----------------------------------------- |
| Step 1: Provision Azure resources       | 15 minutes                                |
| Step 2: Configure ABFS driver on Hadoop | 30 minutes                                |
| Step 3: Run DistCp for bulk transfer    | Varies (1 hour per 10 TB on ExpressRoute) |
| Step 4: Convert to Delta Lake           | 30-60 minutes                             |
| Step 5: Register in Unity Catalog       | 15 minutes                                |
| Step 6: Validate data integrity         | 30 minutes                                |
| **Total (excluding transfer time)**     | **~2.5 hours + transfer**                 |

---

## Step 1: Provision Azure resources

### 1.1 Create a resource group

```bash
az group create \
  --name rg-hadoop-migration \
  --location eastus2
```

### 1.2 Create an ADLS Gen2 storage account

```bash
az storage account create \
  --name hadoopmigrationlake \
  --resource-group rg-hadoop-migration \
  --location eastus2 \
  --sku Standard_ZRS \
  --kind StorageV2 \
  --hns true \
  --allow-blob-public-access false \
  --min-tls-version TLS1_2 \
  --require-infrastructure-encryption true
```

Key parameters:

- `--hns true` enables hierarchical namespace (required for HDFS compatibility)
- `--sku Standard_ZRS` provides zone-redundant storage (3 copies across availability zones)
- `--require-infrastructure-encryption true` enables double encryption

### 1.3 Create containers (file systems)

```bash
# Raw zone: landing area for migrated data (original format)
az storage fs create \
  --name raw \
  --account-name hadoopmigrationlake

# Silver zone: cleansed and converted data (Delta format)
az storage fs create \
  --name silver \
  --account-name hadoopmigrationlake

# Gold zone: business-level aggregates (Delta format)
az storage fs create \
  --name gold \
  --account-name hadoopmigrationlake
```

### 1.4 Get storage account key (for DistCp authentication)

```bash
STORAGE_KEY=$(az storage account keys list \
  --account-name hadoopmigrationlake \
  --query '[0].value' -o tsv)
echo "Storage key retrieved (do not log this value in production)"
```

For production migrations, use a service principal or SAS token instead of a storage account key.

---

## Step 2: Configure ABFS driver on Hadoop cluster

### 2.1 Determine your Hadoop version

```bash
hadoop version
# Example output: Hadoop 3.1.1
```

### 2.2 Download Azure Storage JARs

Download JARs matching your Hadoop version from Maven Central:

```bash
# For Hadoop 3.1.x
HADOOP_AZURE_VERSION="3.1.1"
AZURE_STORAGE_VERSION="7.0.1"

cd /tmp
wget "https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-azure/${HADOOP_AZURE_VERSION}/hadoop-azure-${HADOOP_AZURE_VERSION}.jar"
wget "https://repo1.maven.org/maven2/com/microsoft/azure/azure-storage/${AZURE_STORAGE_VERSION}/azure-storage-${AZURE_STORAGE_VERSION}.jar"
wget "https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-azure-datalake/${HADOOP_AZURE_VERSION}/hadoop-azure-datalake-${HADOOP_AZURE_VERSION}.jar"
```

### 2.3 Install JARs on all nodes

```bash
# Copy to Hadoop common lib on every node
# (Use your cluster management tool — Ansible, Puppet, Ambari, CM)
HADOOP_LIB=$(hadoop classpath | tr ':' '\n' | grep "share/hadoop/common/lib" | head -1)

sudo cp /tmp/hadoop-azure-*.jar ${HADOOP_LIB}/
sudo cp /tmp/azure-storage-*.jar ${HADOOP_LIB}/
sudo cp /tmp/hadoop-azure-datalake-*.jar ${HADOOP_LIB}/
```

### 2.4 Configure core-site.xml

Add Azure storage configuration to `core-site.xml` on the cluster:

```xml
<!-- Add to core-site.xml on all nodes -->
<property>
    <name>fs.azure.account.key.hadoopmigrationlake.dfs.core.windows.net</name>
    <value>${STORAGE_KEY}</value>
    <description>Storage account key for ADLS Gen2</description>
</property>

<property>
    <name>fs.abfss.impl</name>
    <value>org.apache.hadoop.fs.azurebfs.SecureAzureBlobFileSystem</value>
</property>
```

### 2.5 Verify connectivity

```bash
# Test ABFS access from Hadoop cluster
hdfs dfs -ls abfss://raw@hadoopmigrationlake.dfs.core.windows.net/
# Should return empty listing (no files yet)
```

---

## Step 3: Run DistCp for bulk transfer

### 3.1 Inventory source data

```bash
# List top-level directories and sizes
hdfs dfs -du -s -h /user/hive/warehouse/*

# Example output:
# 12.3 T  /user/hive/warehouse/orders
# 8.7 T   /user/hive/warehouse/customers
# 3.1 T   /user/hive/warehouse/products
# 45.6 G  /user/hive/warehouse/regions
# 120.2 T /user/hive/warehouse/events
```

### 3.2 Start with a small table (proof of concept)

```bash
# Copy the smallest table first as a proof of concept
hadoop distcp \
  -m 4 \
  -bandwidth 100 \
  -log /tmp/distcp-log-regions \
  hdfs:///user/hive/warehouse/regions \
  abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/regions
```

### 3.3 Verify the small table copy

```bash
# Check file count and size on source
hdfs dfs -count /user/hive/warehouse/regions
# Example: 1 12 48682345678 /user/hive/warehouse/regions

# Check on target
hdfs dfs -count abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/regions
# Should match source
```

### 3.4 Copy all tables (full migration)

```bash
# Full migration with higher parallelism
hadoop distcp \
  -m 100 \
  -bandwidth 500 \
  -update \
  -strategy dynamic \
  -log /tmp/distcp-log-full \
  hdfs:///user/hive/warehouse/ \
  abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/

# Monitor progress
yarn application -list  # Find DistCp application ID
yarn logs -applicationId application_XXXX_YYYY  # View logs
```

### 3.5 Handle failures

If DistCp fails partway through:

```bash
# Re-run with -update flag (only copies new/modified files)
hadoop distcp \
  -m 100 \
  -bandwidth 500 \
  -update \
  -strategy dynamic \
  -log /tmp/distcp-log-retry \
  hdfs:///user/hive/warehouse/ \
  abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/
```

The `-update` flag ensures DistCp only copies files that do not exist on the target or have different sizes.

---

## Step 4: Convert to Delta Lake (Databricks)

### 4.1 Open a Databricks notebook

Log into your Databricks workspace and create a new Python notebook.

### 4.2 Configure storage access

```python
# Cell 1: Configure ADLS access
# (If using managed identity, this is automatic on Databricks)
# If using account key:
spark.conf.set(
    "fs.azure.account.key.hadoopmigrationlake.dfs.core.windows.net",
    dbutils.secrets.get(scope="migration", key="storage-key")
)
```

### 4.3 List migrated tables

```python
# Cell 2: List tables in raw zone
tables = dbutils.fs.ls("abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/")
for t in tables:
    print(f"{t.name:40s} {t.size:>15,} bytes")
```

### 4.4 Convert a single table (proof of concept)

```python
# Cell 3: Convert regions table (smallest)
source_path = "abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/regions"
target_path = "abfss://silver@hadoopmigrationlake.dfs.core.windows.net/regions"

# Read source (auto-detect format: ORC or Parquet)
try:
    df = spark.read.format("orc").load(source_path)
    source_format = "ORC"
except:
    df = spark.read.format("parquet").load(source_path)
    source_format = "Parquet"

print(f"Source format: {source_format}")
print(f"Row count: {df.count():,}")
print(f"Schema:")
df.printSchema()

# Write as Delta
df.write.format("delta") \
    .mode("overwrite") \
    .save(target_path)

print(f"Successfully converted {source_format} to Delta at {target_path}")
```

### 4.5 Convert all tables (batch)

```python
# Cell 4: Batch convert all tables
from pyspark.sql import functions as F

results = []

for table_dir in tables:
    table_name = table_dir.name.rstrip("/")
    source_path = table_dir.path
    target_path = f"abfss://silver@hadoopmigrationlake.dfs.core.windows.net/{table_name}"

    try:
        # Attempt to read as ORC first, then Parquet
        try:
            df = spark.read.format("orc").load(source_path)
            fmt = "ORC"
        except:
            df = spark.read.format("parquet").load(source_path)
            fmt = "Parquet"

        row_count = df.count()

        # Detect partition columns (Hive-style partition directories)
        partition_cols = [c for c in df.columns
                         if c in ("year", "month", "day", "date", "region", "country")]

        # Write as Delta
        writer = df.write.format("delta").mode("overwrite")
        if partition_cols:
            writer = writer.partitionBy(*partition_cols)
        writer.save(target_path)

        results.append((table_name, fmt, row_count, "SUCCESS", ", ".join(partition_cols) or "none"))
        print(f"  [OK] {table_name}: {row_count:,} rows ({fmt} -> Delta)")

    except Exception as e:
        results.append((table_name, "unknown", 0, f"FAILED: {str(e)[:100]}", ""))
        print(f"  [FAIL] {table_name}: {str(e)[:100]}")

# Display summary
results_df = spark.createDataFrame(results, ["table", "source_format", "rows", "status", "partitions"])
display(results_df)
```

---

## Step 5: Register in Unity Catalog

### 5.1 Create catalog and schema

```sql
-- Cell 5: Create catalog and schema
CREATE CATALOG IF NOT EXISTS migration;
CREATE SCHEMA IF NOT EXISTS migration.silver;
```

### 5.2 Register each table

```python
# Cell 6: Register all Delta tables in Unity Catalog
for table_dir in tables:
    table_name = table_dir.name.rstrip("/")
    target_path = f"abfss://silver@hadoopmigrationlake.dfs.core.windows.net/{table_name}"

    try:
        spark.sql(f"""
            CREATE TABLE IF NOT EXISTS migration.silver.{table_name}
            USING DELTA
            LOCATION '{target_path}'
        """)
        print(f"  [OK] Registered migration.silver.{table_name}")
    except Exception as e:
        print(f"  [FAIL] {table_name}: {str(e)[:100]}")
```

### 5.3 Verify catalog registration

```sql
-- Cell 7: Verify tables are registered
SHOW TABLES IN migration.silver;
```

```sql
-- Cell 8: Query a table to verify
SELECT * FROM migration.silver.regions LIMIT 10;
```

---

## Step 6: Validate data integrity

### 6.1 Row count validation

```python
# Cell 9: Compare row counts between raw (source format) and silver (Delta)
validation = []

for table_dir in tables:
    table_name = table_dir.name.rstrip("/")
    raw_path = table_dir.path
    silver_path = f"abfss://silver@hadoopmigrationlake.dfs.core.windows.net/{table_name}"

    try:
        # Count in raw zone
        try:
            raw_count = spark.read.format("orc").load(raw_path).count()
        except:
            raw_count = spark.read.format("parquet").load(raw_path).count()

        # Count in silver zone (Delta)
        silver_count = spark.read.format("delta").load(silver_path).count()

        match = raw_count == silver_count
        validation.append((table_name, raw_count, silver_count, match))

    except Exception as e:
        validation.append((table_name, -1, -1, False))

val_df = spark.createDataFrame(validation, ["table", "raw_count", "delta_count", "match"])
display(val_df)

# Assert all match
failures = val_df.filter("match = false")
if failures.count() > 0:
    print("VALIDATION FAILED for the following tables:")
    display(failures)
else:
    print("ALL TABLES VALIDATED SUCCESSFULLY")
```

### 6.2 Aggregate validation (spot check)

```python
# Cell 10: Aggregate validation for a key table
table_name = "orders"  # Replace with your largest/most important table
raw_path = f"abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/{table_name}"
silver_path = f"abfss://silver@hadoopmigrationlake.dfs.core.windows.net/{table_name}"

try:
    raw_df = spark.read.format("orc").load(raw_path)
except:
    raw_df = spark.read.format("parquet").load(raw_path)

silver_df = spark.read.format("delta").load(silver_path)

# Compare key metrics
for df, label in [(raw_df, "RAW"), (silver_df, "DELTA")]:
    stats = df.agg(
        F.count("*").alias("row_count"),
        F.sum("amount").alias("total_amount"),
        F.countDistinct("customer_id").alias("unique_customers"),
        F.min("order_date").alias("min_date"),
        F.max("order_date").alias("max_date")
    ).collect()[0]

    print(f"\n{label}:")
    print(f"  Row count:        {stats['row_count']:,}")
    print(f"  Total amount:     {stats['total_amount']:,.2f}")
    print(f"  Unique customers: {stats['unique_customers']:,}")
    print(f"  Date range:       {stats['min_date']} to {stats['max_date']}")
```

### 6.3 Schema comparison

```python
# Cell 11: Schema comparison
table_name = "orders"
raw_path = f"abfss://raw@hadoopmigrationlake.dfs.core.windows.net/hive/warehouse/{table_name}"
silver_path = f"abfss://silver@hadoopmigrationlake.dfs.core.windows.net/{table_name}"

try:
    raw_schema = spark.read.format("orc").load(raw_path).schema
except:
    raw_schema = spark.read.format("parquet").load(raw_path).schema

silver_schema = spark.read.format("delta").load(silver_path).schema

# Compare field by field
print(f"{'Column':<30} {'Raw Type':<20} {'Delta Type':<20} {'Match'}")
print("-" * 90)
for raw_field in raw_schema.fields:
    delta_field = silver_schema[raw_field.name] if raw_field.name in silver_schema.fieldNames() else None
    if delta_field:
        match = str(raw_field.dataType) == str(delta_field.dataType)
        print(f"{raw_field.name:<30} {str(raw_field.dataType):<20} {str(delta_field.dataType):<20} {'OK' if match else 'MISMATCH'}")
    else:
        print(f"{raw_field.name:<30} {str(raw_field.dataType):<20} {'MISSING':<20} FAIL")
```

---

## Step 7: Optimize Delta tables (post-migration)

```sql
-- Cell 12: Optimize large tables
OPTIMIZE migration.silver.orders ZORDER BY (customer_id, order_date);
OPTIMIZE migration.silver.events ZORDER BY (event_type, event_date);

-- Enable auto-optimization for ongoing writes
ALTER TABLE migration.silver.orders SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

---

## Cleanup and next steps

### What to do after successful migration

1. **Run delta sync:** Re-run DistCp with `-update` to catch any files written during migration
2. **Migrate metastore:** Follow [Hive Migration](hive-migration.md) to convert DDL and register tables
3. **Migrate Spark jobs:** Follow [Spark Migration](spark-migration.md) to port job submission
4. **Migrate security:** Follow [Security Migration](security-migration.md) to port ACLs and policies
5. **Parallel run:** Run workloads on both Hadoop and Azure for 14+ days
6. **Cutover:** Switch consumers to Azure endpoints

### Troubleshooting

| Problem                                    | Solution                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| DistCp fails with `ClassNotFoundException` | ABFS JARs not on Hadoop classpath; re-install on all nodes             |
| DistCp extremely slow                      | Check network bandwidth; consider Data Box for >100 TB                 |
| Delta conversion OOM                       | Increase Databricks cluster size; process tables one at a time         |
| Row count mismatch after conversion        | Check for `_SUCCESS`, `.hive-staging*`, and `.crc` files in raw        |
| Schema mismatch                            | Complex types (STRUCT, MAP) may serialize differently; verify manually |

---

## Related

- [HDFS Migration Guide](hdfs-migration.md) — detailed migration reference
- [Hive Migration](hive-migration.md) — next step: metastore migration
- [Spark Migration](spark-migration.md) — next step: job migration
- [Migration Hub](index.md) — full migration center

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [HDFS Migration](hdfs-migration.md) | [Hive Migration](hive-migration.md) | [Migration Hub](index.md)
