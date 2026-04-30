# Impala Migration: Impala to Databricks SQL

**A detailed guide for migrating Apache Impala workloads to Databricks SQL, including SQL dialect conversion, Kudu-to-Delta migration, performance tuning, and worked examples.**

---

## Overview

Impala is Cloudera's interactive SQL engine, designed for low-latency analytical queries on HDFS and Kudu data. It serves BI dashboards, ad-hoc analysis, and scheduled reporting workloads. On Azure, these workloads migrate to Databricks SQL Warehouses, which provide comparable or better interactive query performance through the Photon engine, adaptive query execution, and result caching.

The good news: Impala SQL is very close to Spark SQL / ANSI SQL. The migration is primarily a dialect conversion exercise with a few structural changes around metadata management and storage format.

---

## SQL dialect comparison

### Syntax that works identically

The following Impala SQL constructs work without modification on Databricks SQL:

- `SELECT`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`
- `JOIN` (INNER, LEFT, RIGHT, FULL OUTER, CROSS)
- `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`
- `CASE WHEN ... THEN ... ELSE ... END`
- `WITH` (Common Table Expressions)
- `WINDOW` functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, `SUM OVER`, etc.)
- `LATERAL VIEW EXPLODE`
- `IN`, `EXISTS`, subqueries
- `CAST`, `COALESCE`, `NULLIF`, `NVL`
- Most string functions: `CONCAT`, `SUBSTR`, `TRIM`, `UPPER`, `LOWER`, `LENGTH`, `REGEXP_REPLACE`
- Most date functions: `YEAR`, `MONTH`, `DAY`, `DATE_ADD`, `DATE_SUB`, `DATEDIFF`
- Most aggregate functions: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `COUNT(DISTINCT ...)`

### Syntax that requires conversion

| Impala SQL | Databricks SQL | Notes |
|---|---|---|
| `COMPUTE STATS table_name` | `ANALYZE TABLE table_name COMPUTE STATISTICS` | Required for optimizer. Delta Lake also collects stats automatically. |
| `COMPUTE INCREMENTAL STATS` | `ANALYZE TABLE ... COMPUTE STATISTICS FOR COLUMNS` | Delta stats are column-level by default. |
| `SHOW TABLE STATS table_name` | `DESCRIBE DETAIL table_name` | Delta table metadata. |
| `SHOW COLUMN STATS table_name` | `DESCRIBE EXTENDED table_name column_name` | Column-level statistics. |
| `INVALIDATE METADATA` | Not needed | Delta and Unity Catalog maintain metadata automatically. |
| `REFRESH table_name` | `REFRESH TABLE table_name` | Identical syntax; rarely needed with Delta. |
| `INSERT OVERWRITE ... PARTITION (col=val)` | `INSERT OVERWRITE ... PARTITION (col)` | Dynamic partition overwrite mode. Or use `MERGE INTO` for incremental. |
| `CREATE TABLE ... STORED AS PARQUET` | `CREATE TABLE ... USING DELTA` | Default to Delta for all new tables. |
| `CREATE TABLE ... STORED AS KUDU` | `CREATE TABLE ... USING DELTA` | See Kudu migration section below. |
| `ALTER TABLE ... ADD PARTITION` | Not needed for Delta | Delta manages partitions automatically. |
| `ALTER TABLE ... DROP PARTITION` | `DELETE FROM table WHERE partition_col = val` | Delta supports row-level deletes. |
| `UPSERT INTO` (Kudu) | `MERGE INTO ... WHEN MATCHED THEN UPDATE WHEN NOT MATCHED THEN INSERT` | Delta MERGE is the equivalent. |
| `[SHUFFLE]` / `[NOSHUFFLE]` hints | Not applicable | Databricks adaptive query execution handles this. |
| `STRAIGHT_JOIN` hint | Not applicable | Optimizer handles join ordering. |
| `/* +NOCLUSTERED */` hint | Not applicable | Photon engine optimizes automatically. |
| `APPX_MEDIAN()` | `PERCENTILE_APPROX(col, 0.5)` | Approximate median function. |
| `GROUP_CONCAT()` | `COLLECT_LIST()` + `CONCAT_WS()` | Or `ARRAY_JOIN(COLLECT_LIST(...), ',')`. |
| `NDV()` (approximate distinct) | `APPROX_COUNT_DISTINCT()` | HyperLogLog approximate distinct count. |
| `EXTRACT(epoch FROM ts)` | `UNIX_TIMESTAMP(ts)` | Epoch extraction. |
| `FROM_UNIXTIME(ts, 'yyyy-MM-dd')` | `FROM_UNIXTIME(ts, 'yyyy-MM-dd')` | Identical. |
| `STRLEFT(s, n)` / `STRRIGHT(s, n)` | `LEFT(s, n)` / `RIGHT(s, n)` | Standard SQL function names. |
| `TRUNC(ts, 'MONTH')` | `TRUNC(ts, 'MONTH')` | Identical. |

---

## Kudu to Delta Lake migration

Kudu is Impala's mutable storage engine, designed for fast inserts, updates, and deletes on analytical data. Delta Lake is the direct replacement.

### Feature comparison

| Kudu feature | Delta Lake equivalent | Notes |
|---|---|---|
| **Primary key** | Not enforced; use `MERGE INTO` with key columns | Delta does not enforce primary keys but supports merge-on-key patterns. |
| **INSERT / UPDATE / DELETE** | `INSERT` / `UPDATE` / `DELETE` / `MERGE INTO` | Full DML support on Delta. |
| **UPSERT** | `MERGE INTO ... WHEN MATCHED THEN UPDATE WHEN NOT MATCHED THEN INSERT` | Standard SQL MERGE. |
| **Hash partitioning** | Delta partitioning + Z-ordering | Z-ORDER BY provides skip-based optimization for high-cardinality columns. |
| **Range partitioning** | Delta partitioning (directory-based) | Use for low-cardinality columns (date, region). |
| **Auto-compaction** | Delta auto-optimize (`optimizeWrite`, `autoCompact`) | Enable on table properties. |
| **Tablet servers** | Managed by Databricks | No user-managed tablet infrastructure. |
| **Replication factor** | ADLS Gen2 redundancy (LRS/ZRS/GRS) | Storage-level redundancy; no application-level replication. |

### Kudu table migration script

```python
# Step 1: Read from Kudu (on CDH cluster, export to Parquet on HDFS)
# Run this on the CDH cluster
spark.read \
    .format("org.apache.kudu.spark.kudu") \
    .option("kudu.master", "kudu-master:7051") \
    .option("kudu.table", "my_database.my_table") \
    .load() \
    .write.format("parquet") \
    .mode("overwrite") \
    .save("hdfs:///export/kudu/my_database/my_table")

# Step 2: Transfer Parquet files to ADLS Gen2 (azcopy or ADF)
# azcopy copy "hdfs-export-path" "abfss://bronze@storage.dfs.core.windows.net/kudu/my_table"

# Step 3: Create Delta table on Databricks
spark.read.parquet("abfss://bronze@storage.dfs.core.windows.net/kudu/my_table") \
    .write.format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .partitionBy("date_col") \
    .saveAsTable("silver.my_database.my_table")

# Step 4: Enable auto-optimization
spark.sql("""
    ALTER TABLE silver.my_database.my_table
    SET TBLPROPERTIES (
        'delta.autoOptimize.optimizeWrite' = 'true',
        'delta.autoOptimize.autoCompact' = 'true'
    )
""")

# Step 5: Apply Z-ordering for high-cardinality query columns
spark.sql("""
    OPTIMIZE silver.my_database.my_table
    ZORDER BY (customer_id, order_date)
""")
```

---

## Impala partitioning to Delta partitioning

### Decision framework

| Impala partition type | Cardinality | Delta recommendation |
|---|---|---|
| Date column (daily) | ~365/year | **Partition** by date column. Matches Impala behavior. |
| Date column (hourly) | ~8,760/year | **Partition** by date (daily), not hourly. Z-ORDER by hour if needed. |
| Region / country | 10-200 | **Partition** if < 100 values; otherwise Z-ORDER. |
| Customer ID | 10K-10M | **Z-ORDER**, do not partition. Too many partitions degrades performance. |
| Transaction ID | Very high | **Z-ORDER**. Never partition by high-cardinality columns. |

### Example: convert Impala partitioned table

```sql
-- Impala (before)
CREATE TABLE sales.orders (
    order_id BIGINT,
    customer_id BIGINT,
    amount DECIMAL(18,2),
    status STRING
)
PARTITIONED BY (order_date DATE)
STORED AS PARQUET;

-- Databricks SQL (after)
CREATE TABLE silver.sales.orders (
    order_id BIGINT,
    customer_id BIGINT,
    amount DECIMAL(18,2),
    status STRING,
    order_date DATE
)
USING DELTA
PARTITIONED BY (order_date);

-- Apply Z-ordering for customer_id queries
OPTIMIZE silver.sales.orders ZORDER BY (customer_id);
```

---

## Performance tuning comparison

### Impala performance knobs vs Databricks equivalents

| Impala tuning technique | Databricks equivalent | Notes |
|---|---|---|
| `COMPUTE STATS` for all tables | `ANALYZE TABLE ... COMPUTE STATISTICS` | Delta also collects stats automatically on write. |
| Impala admission control | Databricks SQL Warehouse sizing (T-shirt sizes) | Choose warehouse size based on concurrency needs. |
| Impala memory limits per query | Databricks SQL Warehouse auto-manages memory | Photon engine manages memory allocation. |
| Impala partition pruning | Delta partition pruning + data skipping | Delta uses file-level min/max stats in addition to partition pruning. |
| Impala runtime filters | Databricks adaptive query execution (AQE) | AQE dynamically optimizes joins and shuffles. |
| `SET MEM_LIMIT=4g` per query | Warehouse sizing | No per-query memory configuration. |
| Impala catalog caching | Unity Catalog + result caching | Enable result caching: `SET use_cached_result = true`. |
| Impala HDFS short-circuit reads | Not applicable | ADLS Gen2 reads are network-based; Photon compensates. |
| Impala codegen | Photon native vectorized engine | Photon is ~2-8x faster than non-vectorized execution. |
| Impala resource pools | SQL Warehouse scaling (min/max clusters) | Multi-cluster auto-scaling for concurrency. |

### Common performance issues after migration

| Issue | Cause | Solution |
|---|---|---|
| Queries slower than Impala | Missing statistics | Run `ANALYZE TABLE` on migrated tables. |
| High shuffle in joins | Default shuffle partitions too low | `SET spark.sql.shuffle.partitions = 200` (or higher for large tables). |
| Full table scans on partitioned data | Partition predicate not recognized | Use literal values in WHERE clause, not functions on partition columns. |
| Slow small queries | Warehouse startup time | Use Serverless SQL Warehouse (instant startup). |
| Concurrent query throttling | Single-cluster warehouse | Enable multi-cluster scaling (2-8 clusters). |
| OOM on large aggregations | Insufficient warehouse size | Scale up to larger warehouse size (Medium, Large, X-Large). |

---

## Worked example: full query migration

### Original Impala query

```sql
-- Impala: Daily revenue report with customer segmentation
COMPUTE INCREMENTAL STATS sales.orders;
COMPUTE INCREMENTAL STATS sales.customers;

SELECT
    o.order_date,
    c.segment,
    COUNT(*) AS order_count,
    SUM(o.amount) AS total_revenue,
    NDV(o.customer_id) AS unique_customers,
    APPX_MEDIAN(o.amount) AS median_order_value,
    GROUP_CONCAT(DISTINCT o.status, ', ') AS statuses_seen
FROM sales.orders o
JOIN sales.customers c ON o.customer_id = c.customer_id
WHERE o.order_date BETWEEN '2025-01-01' AND '2025-12-31'
  AND o.status != 'cancelled'
GROUP BY o.order_date, c.segment
HAVING SUM(o.amount) > 1000
ORDER BY o.order_date, total_revenue DESC;
```

### Migrated Databricks SQL query

```sql
-- Databricks SQL: Daily revenue report with customer segmentation
-- Statistics are collected automatically on Delta tables, but you can force:
ANALYZE TABLE silver.sales.orders COMPUTE STATISTICS FOR ALL COLUMNS;
ANALYZE TABLE silver.sales.customers COMPUTE STATISTICS FOR ALL COLUMNS;

SELECT
    o.order_date,
    c.segment,
    COUNT(*) AS order_count,
    SUM(o.amount) AS total_revenue,
    APPROX_COUNT_DISTINCT(o.customer_id) AS unique_customers,
    PERCENTILE_APPROX(o.amount, 0.5) AS median_order_value,
    CONCAT_WS(', ', COLLECT_SET(o.status)) AS statuses_seen
FROM silver.sales.orders o
JOIN silver.sales.customers c ON o.customer_id = c.customer_id
WHERE o.order_date BETWEEN '2025-01-01' AND '2025-12-31'
  AND o.status != 'cancelled'
GROUP BY o.order_date, c.segment
HAVING SUM(o.amount) > 1000
ORDER BY o.order_date, total_revenue DESC;
```

### Key changes annotated

| Line | Change | Reason |
|---|---|---|
| `COMPUTE INCREMENTAL STATS` | `ANALYZE TABLE ... COMPUTE STATISTICS FOR ALL COLUMNS` | Syntax difference; Delta auto-collects basic stats. |
| `sales.orders` | `silver.sales.orders` | Three-level namespace: catalog.schema.table. |
| `NDV()` | `APPROX_COUNT_DISTINCT()` | Spark SQL function name for HyperLogLog. |
| `APPX_MEDIAN()` | `PERCENTILE_APPROX(col, 0.5)` | Spark SQL approximate median. |
| `GROUP_CONCAT(DISTINCT ...)` | `CONCAT_WS(', ', COLLECT_SET(...))` | Spark uses COLLECT_SET for distinct + CONCAT_WS for joining. |

---

## Impala metadata caching vs Direct Lake / Databricks SQL caching

Impala relies on metadata caching in the Impala Catalog daemon (catalogd) to avoid repeated HMS lookups. On Databricks SQL, two caching mechanisms replace this:

### Databricks SQL result caching

- Automatically caches query results for identical queries
- Cache invalidated when underlying Delta table changes
- No configuration required; enabled by default on SQL Warehouses

### Databricks SQL disk caching

- Caches remote ADLS Gen2 data on local SSDs of warehouse nodes
- Reduces repeated reads from storage
- Enabled by default on SQL Warehouse worker nodes

### Fabric Direct Lake (alternative target)

For organizations also using Microsoft Fabric, Direct Lake mode provides:

- Power BI reads Delta tables directly from OneLake -- no data import
- Sub-second query response for dashboards
- No separate caching layer to manage

---

## Migration checklist for Impala workloads

- [ ] Inventory all Impala queries (scheduled reports, BI connections, ad-hoc)
- [ ] Export Kudu table schemas and data to Parquet
- [ ] Transfer Parquet data to ADLS Gen2
- [ ] Create Delta tables with appropriate partitioning
- [ ] Convert Impala SQL to Databricks SQL (use dialect table above)
- [ ] Replace `COMPUTE STATS` with `ANALYZE TABLE`
- [ ] Replace Impala-specific functions (NDV, APPX_MEDIAN, GROUP_CONCAT)
- [ ] Update JDBC/ODBC connection strings for BI tools
- [ ] Run `OPTIMIZE ... ZORDER BY` on frequently queried columns
- [ ] Enable auto-optimization on all Delta tables
- [ ] Benchmark query latency: Impala vs Databricks SQL
- [ ] Validate row counts and checksums between source and target
- [ ] Update monitoring dashboards to use Azure Monitor
- [ ] Train BI users on Databricks SQL Editor (minimal change from Impala shell)

---

## Next steps

1. **Walk through the [Impala to Databricks Tutorial](tutorial-impala-to-databricks.md)** for a hands-on migration exercise
2. **Review the [Benchmarks](benchmarks.md)** for Impala vs Databricks SQL performance data
3. **See the [Complete Feature Mapping](feature-mapping-complete.md)** for the full component comparison

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
