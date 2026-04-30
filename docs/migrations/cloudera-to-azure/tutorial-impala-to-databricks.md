# Tutorial: Migrate an Impala Workload to Databricks SQL

**A step-by-step walkthrough of migrating an Impala analytical workload to Databricks SQL, including data transfer, SQL conversion, Kudu-to-Delta migration, and performance validation.**

---

## Prerequisites

- Azure subscription with a resource group
- Databricks workspace deployed with Unity Catalog enabled
- ADLS Gen2 storage account mounted in Databricks
- Access to the source Impala cluster (CDH or CDP)
- Source Impala tables (Parquet on HDFS and/or Kudu)
- Basic familiarity with Databricks SQL Editor

**Estimated time:** 2-3 hours

---

## What we are migrating

This tutorial migrates a retail analytics workload consisting of:

- **3 Parquet tables on HDFS:** `orders`, `customers`, `products` (partitioned by date)
- **1 Kudu table:** `inventory` (mutable, updated in near-real-time)
- **5 Impala SQL queries:** Daily revenue report, customer segmentation, product performance, inventory alerts, and a dashboard summary view
- **1 Impala view:** `v_daily_kpis`

---

## Step 1: Export table schemas from Impala

Connect to Impala via `impala-shell` or Beeline and extract DDL for all tables.

```bash
# On the CDH/CDP cluster
impala-shell -q "SHOW CREATE TABLE retail.orders;" > schemas/orders.sql
impala-shell -q "SHOW CREATE TABLE retail.customers;" > schemas/customers.sql
impala-shell -q "SHOW CREATE TABLE retail.products;" > schemas/products.sql
impala-shell -q "SHOW CREATE TABLE retail.inventory;" > schemas/inventory.sql
impala-shell -q "SHOW CREATE VIEW retail.v_daily_kpis;" > schemas/v_daily_kpis.sql

# Get row counts for validation baseline
impala-shell -q "
SELECT 'orders' AS tbl, COUNT(*) AS cnt FROM retail.orders
UNION ALL
SELECT 'customers', COUNT(*) FROM retail.customers
UNION ALL
SELECT 'products', COUNT(*) FROM retail.products
UNION ALL
SELECT 'inventory', COUNT(*) FROM retail.inventory;
" > validation/source_row_counts.csv

# Get column checksums for validation
impala-shell -q "
SELECT
    COUNT(*) AS total_rows,
    SUM(CAST(order_id AS BIGINT)) AS sum_order_id,
    SUM(CAST(amount * 100 AS BIGINT)) AS sum_amount_cents,
    COUNT(DISTINCT customer_id) AS distinct_customers
FROM retail.orders
WHERE order_date >= '2025-01-01';
" > validation/source_checksums.csv
```

---

## Step 2: Transfer data to ADLS Gen2

### 2.1 Parquet tables (HDFS to ADLS)

For tables stored as Parquet on HDFS, use `distcp` + `azcopy` or ADF Copy Activity.

```bash
# Option A: distcp to local staging, then azcopy to ADLS
hadoop distcp \
    hdfs:///user/hive/warehouse/retail.db/orders \
    hdfs:///staging/export/retail/orders

# On a machine with azcopy installed
azcopy copy \
    "/mnt/staging/export/retail/orders" \
    "https://yourstorage.blob.core.windows.net/bronze/retail/orders" \
    --recursive

# Repeat for customers and products
azcopy copy "/mnt/staging/export/retail/customers" \
    "https://yourstorage.blob.core.windows.net/bronze/retail/customers" --recursive
azcopy copy "/mnt/staging/export/retail/products" \
    "https://yourstorage.blob.core.windows.net/bronze/retail/products" --recursive
```

### 2.2 Kudu table (export to Parquet, then transfer)

Kudu data cannot be copied directly. Export via Spark on the CDH cluster.

```python
# Run on CDH Spark cluster
spark.read \
    .format("org.apache.kudu.spark.kudu") \
    .option("kudu.master", "kudu-master-host:7051") \
    .option("kudu.table", "impala::retail.inventory") \
    .load() \
    .write.format("parquet") \
    .mode("overwrite") \
    .save("hdfs:///staging/export/retail/inventory")
```

Then transfer to ADLS using azcopy:

```bash
azcopy copy "/mnt/staging/export/retail/inventory" \
    "https://yourstorage.blob.core.windows.net/bronze/retail/inventory" --recursive
```

---

## Step 3: Create Delta tables on Databricks

Open a Databricks notebook and create the target schema and tables.

### 3.1 Create catalog and schema

```sql
-- Create catalog (if not exists)
CREATE CATALOG IF NOT EXISTS retail_catalog;
USE CATALOG retail_catalog;

-- Create schemas following medallion architecture
CREATE SCHEMA IF NOT EXISTS bronze;
CREATE SCHEMA IF NOT EXISTS silver;
CREATE SCHEMA IF NOT EXISTS gold;
```

### 3.2 Convert Parquet to Delta (orders table)

```sql
-- Create Delta table from imported Parquet data
CREATE TABLE silver.orders
USING DELTA
PARTITIONED BY (order_date)
AS SELECT
    order_id,
    customer_id,
    amount,
    status,
    order_date
FROM parquet.`abfss://bronze@yourstorage.dfs.core.windows.net/retail/orders/`;

-- Enable auto-optimization
ALTER TABLE silver.orders SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);

-- Apply Z-ordering for common query patterns
OPTIMIZE silver.orders ZORDER BY (customer_id);
```

### 3.3 Convert Parquet to Delta (customers table)

```sql
CREATE TABLE silver.customers
USING DELTA
AS SELECT * FROM parquet.`abfss://bronze@yourstorage.dfs.core.windows.net/retail/customers/`;

ALTER TABLE silver.customers SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

### 3.4 Convert Parquet to Delta (products table)

```sql
CREATE TABLE silver.products
USING DELTA
AS SELECT * FROM parquet.`abfss://bronze@yourstorage.dfs.core.windows.net/retail/products/`;

ALTER TABLE silver.products SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

### 3.5 Convert Kudu export to Delta (inventory table)

The inventory table was Kudu (mutable). Delta Lake supports the same UPSERT/MERGE patterns.

```sql
CREATE TABLE silver.inventory
USING DELTA
AS SELECT * FROM parquet.`abfss://bronze@yourstorage.dfs.core.windows.net/retail/inventory/`;

ALTER TABLE silver.inventory SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);

-- Z-order by product_id (common lookup key)
OPTIMIZE silver.inventory ZORDER BY (product_id);
```

---

## Step 4: Compute statistics

On Impala, `COMPUTE STATS` was essential for query performance. On Databricks, Delta Lake collects basic stats automatically, but full column statistics improve the optimizer.

```sql
ANALYZE TABLE silver.orders COMPUTE STATISTICS FOR ALL COLUMNS;
ANALYZE TABLE silver.customers COMPUTE STATISTICS FOR ALL COLUMNS;
ANALYZE TABLE silver.products COMPUTE STATISTICS FOR ALL COLUMNS;
ANALYZE TABLE silver.inventory COMPUTE STATISTICS FOR ALL COLUMNS;
```

---

## Step 5: Convert Impala SQL queries

### 5.1 Daily revenue report

```sql
-- Impala (before)
COMPUTE INCREMENTAL STATS retail.orders;

SELECT
    order_date,
    COUNT(*) AS order_count,
    SUM(amount) AS total_revenue,
    NDV(customer_id) AS unique_customers,
    APPX_MEDIAN(amount) AS median_order_value
FROM retail.orders
WHERE order_date BETWEEN '2025-01-01' AND '2025-12-31'
  AND status = 'completed'
GROUP BY order_date
ORDER BY order_date;
```

```sql
-- Databricks SQL (after)
SELECT
    order_date,
    COUNT(*) AS order_count,
    SUM(amount) AS total_revenue,
    APPROX_COUNT_DISTINCT(customer_id) AS unique_customers,
    PERCENTILE_APPROX(amount, 0.5) AS median_order_value
FROM silver.orders
WHERE order_date BETWEEN '2025-01-01' AND '2025-12-31'
  AND status = 'completed'
GROUP BY order_date
ORDER BY order_date;
```

**Changes:** `NDV()` to `APPROX_COUNT_DISTINCT()`, `APPX_MEDIAN()` to `PERCENTILE_APPROX(col, 0.5)`, table reference to `silver.orders`.

### 5.2 Customer segmentation

```sql
-- Impala (before)
SELECT
    c.segment,
    c.region,
    COUNT(DISTINCT o.customer_id) AS customers,
    SUM(o.amount) AS revenue,
    GROUP_CONCAT(DISTINCT o.status, ', ') AS statuses
FROM retail.orders o
JOIN retail.customers c ON o.customer_id = c.customer_id
WHERE o.order_date >= '2025-01-01'
GROUP BY c.segment, c.region
ORDER BY revenue DESC;
```

```sql
-- Databricks SQL (after)
SELECT
    c.segment,
    c.region,
    COUNT(DISTINCT o.customer_id) AS customers,
    SUM(o.amount) AS revenue,
    CONCAT_WS(', ', COLLECT_SET(o.status)) AS statuses
FROM silver.orders o
JOIN silver.customers c ON o.customer_id = c.customer_id
WHERE o.order_date >= '2025-01-01'
GROUP BY c.segment, c.region
ORDER BY revenue DESC;
```

**Changes:** `GROUP_CONCAT(DISTINCT ...)` to `CONCAT_WS(', ', COLLECT_SET(...))`.

### 5.3 Inventory alerts (Kudu query migrated)

```sql
-- Impala on Kudu (before)
SELECT
    i.product_id,
    p.product_name,
    i.quantity_on_hand,
    i.reorder_point,
    i.last_updated
FROM retail.inventory i
JOIN retail.products p ON i.product_id = p.product_id
WHERE i.quantity_on_hand < i.reorder_point
ORDER BY (i.reorder_point - i.quantity_on_hand) DESC;
```

```sql
-- Databricks SQL on Delta (after)
-- No syntax changes needed! This query ports directly.
SELECT
    i.product_id,
    p.product_name,
    i.quantity_on_hand,
    i.reorder_point,
    i.last_updated
FROM silver.inventory i
JOIN silver.products p ON i.product_id = p.product_id
WHERE i.quantity_on_hand < i.reorder_point
ORDER BY (i.reorder_point - i.quantity_on_hand) DESC;
```

**Changes:** Table references only. Standard SQL works identically.

### 5.4 Convert the Impala view

```sql
-- Impala (before)
CREATE VIEW retail.v_daily_kpis AS
SELECT
    o.order_date,
    COUNT(*) AS orders,
    SUM(o.amount) AS revenue,
    NDV(o.customer_id) AS customers,
    AVG(o.amount) AS avg_order_value
FROM retail.orders o
WHERE o.status = 'completed'
GROUP BY o.order_date;
```

```sql
-- Databricks SQL (after)
CREATE OR REPLACE VIEW gold.v_daily_kpis AS
SELECT
    o.order_date,
    COUNT(*) AS orders,
    SUM(o.amount) AS revenue,
    APPROX_COUNT_DISTINCT(o.customer_id) AS customers,
    AVG(o.amount) AS avg_order_value
FROM silver.orders o
WHERE o.status = 'completed'
GROUP BY o.order_date;
```

### 5.5 Kudu UPSERT pattern on Delta

If your Impala workload includes Kudu UPSERT operations, here is the Delta equivalent:

```sql
-- Impala on Kudu (before)
UPSERT INTO retail.inventory
VALUES (1001, 500, 100, CURRENT_TIMESTAMP());
```

```sql
-- Databricks SQL on Delta (after)
MERGE INTO silver.inventory AS target
USING (SELECT 1001 AS product_id, 500 AS quantity_on_hand,
              100 AS reorder_point, CURRENT_TIMESTAMP() AS last_updated) AS source
ON target.product_id = source.product_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;
```

---

## Step 6: Validate the migration

### 6.1 Row count comparison

```sql
-- On Databricks: compare with source counts from Step 1
SELECT 'orders' AS tbl, COUNT(*) AS cnt FROM silver.orders
UNION ALL
SELECT 'customers', COUNT(*) FROM silver.customers
UNION ALL
SELECT 'products', COUNT(*) FROM silver.products
UNION ALL
SELECT 'inventory', COUNT(*) FROM silver.inventory;

-- Compare against source_row_counts.csv from Step 1
-- All counts must match exactly
```

### 6.2 Checksum comparison

```sql
-- On Databricks
SELECT
    COUNT(*) AS total_rows,
    SUM(CAST(order_id AS BIGINT)) AS sum_order_id,
    SUM(CAST(amount * 100 AS BIGINT)) AS sum_amount_cents,
    APPROX_COUNT_DISTINCT(customer_id) AS distinct_customers
FROM silver.orders
WHERE order_date >= '2025-01-01';

-- Compare against source_checksums.csv from Step 1
-- Note: APPROX_COUNT_DISTINCT may differ slightly from Impala NDV()
-- For exact comparison, use COUNT(DISTINCT customer_id) on both sides
```

### 6.3 Schema comparison

```sql
-- List all columns and types
DESCRIBE EXTENDED silver.orders;
DESCRIBE EXTENDED silver.customers;
DESCRIBE EXTENDED silver.products;
DESCRIBE EXTENDED silver.inventory;

-- Verify against original Impala DDL from Step 1
-- Check: column names match, types are compatible, partitioning is correct
```

### 6.4 Query result comparison

Run each converted query on Databricks and compare results with Impala output:

```python
# In a Databricks notebook
import pandas as pd

# Load Impala baseline results (exported earlier)
impala_results = pd.read_csv("/Volumes/retail_catalog/validation/impala_daily_revenue.csv")

# Run Databricks query
dbx_results = spark.sql("""
    SELECT order_date, COUNT(*) AS order_count, SUM(amount) AS total_revenue
    FROM silver.orders
    WHERE order_date BETWEEN '2025-01-01' AND '2025-12-31'
      AND status = 'completed'
    GROUP BY order_date
    ORDER BY order_date
""").toPandas()

# Compare
comparison = impala_results.merge(dbx_results, on='order_date', suffixes=('_impala', '_dbx'))
comparison['count_match'] = comparison['order_count_impala'] == comparison['order_count_dbx']
comparison['revenue_diff'] = abs(comparison['total_revenue_impala'] - comparison['total_revenue_dbx'])

print(f"Row count matches: {comparison['count_match'].all()}")
print(f"Max revenue difference: {comparison['revenue_diff'].max()}")

# Assert
assert comparison['count_match'].all(), "Row count mismatch detected!"
assert comparison['revenue_diff'].max() < 0.01, "Revenue mismatch detected!"
print("All validations passed.")
```

---

## Step 7: Performance benchmarking

### 7.1 Benchmark methodology

Run each query 5 times on both Impala and Databricks SQL, discard the first run (cold cache), and average the remaining 4.

```python
import time

queries = {
    "daily_revenue": "SELECT order_date, COUNT(*), SUM(amount) FROM silver.orders WHERE order_date >= '2025-01-01' GROUP BY order_date",
    "customer_segmentation": "SELECT c.segment, SUM(o.amount) FROM silver.orders o JOIN silver.customers c ON o.customer_id = c.customer_id GROUP BY c.segment",
    "inventory_alerts": "SELECT i.product_id, i.quantity_on_hand FROM silver.inventory i WHERE i.quantity_on_hand < i.reorder_point",
}

results = {}
for name, query in queries.items():
    times = []
    for i in range(5):
        start = time.time()
        spark.sql(query).collect()
        elapsed = time.time() - start
        if i > 0:  # Skip first run (cold cache)
            times.append(elapsed)
    results[name] = {
        "avg_seconds": sum(times) / len(times),
        "min_seconds": min(times),
        "max_seconds": max(times)
    }

for name, r in results.items():
    print(f"{name}: avg={r['avg_seconds']:.2f}s, min={r['min_seconds']:.2f}s, max={r['max_seconds']:.2f}s")
```

### 7.2 Expected performance comparison

| Query | Impala (typical) | Databricks SQL Serverless | Notes |
|---|---|---|---|
| Daily revenue (aggregation) | 2-5 seconds | 1-3 seconds | Photon accelerates aggregations. |
| Customer segmentation (join) | 5-10 seconds | 3-7 seconds | AQE optimizes join strategy. |
| Inventory alerts (filter) | < 1 second | < 1 second | Both are fast on filtered scans. |
| Dashboard view (KPIs) | 3-8 seconds | 2-5 seconds | Result caching helps repeated queries. |

---

## Step 8: Update BI tool connections

If BI tools (Tableau, Power BI, Qlik) connect to Impala via JDBC/ODBC, update the connection strings.

### Impala JDBC (before)

```
jdbc:impala://impala-host:21050/retail;AuthMech=1;KrbRealm=EXAMPLE.COM;KrbHostFQDN=impala-host.example.com;KrbServiceName=impala
```

### Databricks SQL JDBC (after)

```
jdbc:databricks://adb-1234567890.1.azuredatabricks.net:443/default;transportMode=http;ssl=1;httpPath=/sql/1.0/warehouses/abc123;AuthMech=3;UID=token;PWD=<personal-access-token>
```

### Power BI connection

1. Open Power BI Desktop
2. **Get Data** > **Azure Databricks**
3. Enter: Server hostname, HTTP path, catalog name
4. Authenticate with Entra ID (Azure AD)
5. Select tables from `silver` schema

---

## Migration complete -- verification checklist

- [ ] All 4 tables created as Delta in Databricks
- [ ] Row counts match source (exact match required)
- [ ] Column checksums match source (within rounding tolerance)
- [ ] All 5 queries converted and returning correct results
- [ ] View `v_daily_kpis` created in gold schema
- [ ] Kudu UPSERT pattern tested with Delta MERGE
- [ ] Statistics computed on all tables
- [ ] Z-ordering applied to frequently queried columns
- [ ] Auto-optimization enabled on all tables
- [ ] BI tool connections updated and tested
- [ ] Performance benchmarks documented (Impala vs Databricks)
- [ ] Monitoring configured (Azure Monitor for SQL Warehouse)

---

## Next steps

1. **Review the [Impala Migration Guide](impala-migration.md)** for the full SQL dialect reference
2. **See the [Benchmarks](benchmarks.md)** for broader performance comparison data
3. **Read the [Best Practices](best-practices.md)** for ongoing optimization guidance

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
