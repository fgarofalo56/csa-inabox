# Tutorial: Migrate Redshift Warehouse to Fabric / Databricks SQL

**Status:** Authored 2026-04-30
**Audience:** Data engineers and DBAs migrating Amazon Redshift clusters to Databricks SQL Warehouses on Azure, with Power BI Direct Lake for BI serving.
**Prerequisites knowledge:** Redshift administration, SQL, basic Databricks and Azure familiarity.
**Time estimate:** 2-6 weeks per Redshift cluster depending on complexity.

---

## Overview

Amazon Redshift is a columnar MPP warehouse. Databricks SQL Warehouses on Azure provide equivalent analytical query capability over Delta Lake tables, with the added benefits of open storage format, Unity Catalog governance, and native integration with Power BI Direct Lake.

This tutorial covers the complete migration path: profiling your Redshift workload, exporting schema and data, converting SQL dialect, rebuilding transformations in dbt, and standing up Power BI semantic models.

> **AWS comparison:** Redshift is a tightly coupled compute+storage warehouse (even RA3 decouples storage, it remains Redshift-managed). Databricks SQL separates compute (SQL Warehouses) from storage (Delta Lake on ADLS Gen2), giving you independent scaling and open-format data that any tool can read.

---

## Prerequisites

### Tools

| Tool              | Minimum version | Purpose                             |
| ----------------- | --------------- | ----------------------------------- |
| AWS CLI           | 2.x             | Redshift access and UNLOAD commands |
| `psql` or DBeaver | Latest          | Connect to Redshift for profiling   |
| Azure CLI         | 2.60+           | Azure resource provisioning         |
| AzCopy            | 10.24+          | S3-to-ADLS data transfer            |
| Databricks CLI    | 0.220+          | Workspace and job management        |
| dbt-databricks    | 1.8+            | Transformation layer                |
| Power BI Desktop  | Latest          | Semantic model creation             |

### AWS access

- Redshift cluster endpoint, database name, and credentials (master user or read-only analytics user).
- IAM role with `s3:PutObject` permission on an UNLOAD staging bucket.
- `redshift:DescribeClusters`, `redshift:GetClusterCredentials` permissions.

### Azure access

- Databricks workspace with Unity Catalog enabled and a SQL Warehouse provisioned.
- ADLS Gen2 storage account (see [tutorial-s3-to-adls.md](tutorial-s3-to-adls.md) Step 2).
- Power BI Premium or Fabric capacity (F64+ for Direct Lake).

---

## Step 1: Profile the Redshift workload

Understanding your current workload is essential before migrating. Redshift stores query history and table metadata that map directly to Databricks sizing decisions.

### Gather cluster metadata

```sql
-- Connect to Redshift via psql
-- psql -h acme-analytics.abc123.us-gov-west-1.redshift.amazonaws.com -U admin -d analytics -p 5439

-- Cluster node configuration
SELECT
  node_type,
  number_of_nodes
FROM stv_wlm_service_class_config
LIMIT 1;

-- Database sizes
SELECT
  trim(pgdb.datname) AS database_name,
  ROUND(SUM(b.mbytes)::NUMERIC / 1024, 2) AS size_gb
FROM stv_tbl_perm a
JOIN pg_database pgdb ON pgdb.oid = a.db_id
JOIN (
  SELECT tbl, COUNT(*) AS mbytes
  FROM stv_blocklist
  GROUP BY tbl
) b ON a.id = b.tbl
GROUP BY 1
ORDER BY 2 DESC;
```

### Profile query patterns

```sql
-- Top 20 most expensive queries (by execution time) in the last 30 days
SELECT
  trim(querytxt) AS query_text,
  COUNT(*) AS execution_count,
  AVG(total_exec_time) / 1000000 AS avg_seconds,
  MAX(total_exec_time) / 1000000 AS max_seconds,
  SUM(total_exec_time) / 1000000 AS total_seconds
FROM stl_query
WHERE starttime > DATEADD(day, -30, GETDATE())
  AND querytxt NOT LIKE 'padb_fetch_sample%'
  AND querytxt NOT LIKE 'COPY%'
  AND querytxt NOT LIKE 'UNLOAD%'
GROUP BY 1
ORDER BY total_seconds DESC
LIMIT 20;

-- WLM queue utilization
SELECT
  service_class,
  trim(name) AS queue_name,
  num_queued_queries,
  num_executing_queries,
  avg_queue_time / 1000000 AS avg_queue_seconds
FROM stl_wlm_query
JOIN stv_wlm_service_class_config USING (service_class)
WHERE starttime > DATEADD(day, -7, GETDATE())
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1;

-- Table scan frequency (identifies hot tables)
SELECT
  trim(s.perm_table_name) AS table_name,
  COUNT(*) AS scan_count,
  AVG(s.rows_pre_filter) AS avg_rows_scanned,
  AVG(s.rows) AS avg_rows_returned
FROM stl_scan s
WHERE s.starttime > DATEADD(day, -30, GETDATE())
  AND s.perm_table_name NOT LIKE 'stl_%'
  AND s.perm_table_name NOT LIKE 'pg_%'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 30;
```

### Inventory tables and sizes

```sql
-- All user tables with row counts, sizes, and distribution/sort keys
SELECT
  trim(n.nspname) AS schema_name,
  trim(c.relname) AS table_name,
  t.diststyle,
  trim(d.colname) AS dist_key,
  trim(sk.attname) AS sort_key,
  t.tbl_rows::BIGINT AS row_count,
  t.size AS size_mb,
  CASE WHEN t.unsorted > 0 THEN t.unsorted ELSE 0 END AS unsorted_pct
FROM svv_table_info t
JOIN pg_class c ON t.table_id = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
LEFT JOIN (
  SELECT attrelid, trim(attname) AS colname
  FROM pg_attribute
  WHERE attisdistkey = true
) d ON c.oid = d.attrelid
LEFT JOIN pg_attribute sk ON c.oid = sk.attrelid AND sk.attsortkeyord = 1
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
ORDER BY t.size DESC;
```

Document the results:

| Schema.Table        | Rows | Size (GB) | Dist style | Dist key    | Sort key   | Scan freq |
| ------------------- | ---- | --------- | ---------- | ----------- | ---------- | --------- |
| public.fact_orders  | 2.1B | 340       | KEY        | customer_id | order_date | 12,400/mo |
| public.dim_products | 850K | 0.5       | ALL        | -           | product_id | 11,200/mo |
| public.fact_events  | 5.8B | 890       | KEY        | event_type  | event_ts   | 3,200/mo  |

---

## Step 2: Export schema DDL and convert to Databricks SQL

### Export Redshift DDL

```sql
-- Generate DDL for all tables in a schema
SELECT
  ddl
FROM admin.v_generate_tbl_ddl
WHERE schemaname = 'public'
ORDER BY tablename, seq;

-- If admin.v_generate_tbl_ddl is not available, use pg_dump:
-- pg_dump -h <host> -U admin -d analytics --schema-only --no-owner -t 'public.*' > redshift_schema.sql
```

### Convert DDL to Databricks SQL

The core differences between Redshift DDL and Databricks SQL DDL:

| Redshift DDL feature   | Databricks SQL equivalent                | Notes                                 |
| ---------------------- | ---------------------------------------- | ------------------------------------- |
| `DISTKEY(col)`         | `PARTITIONED BY (col)` or omit           | See distribution mapping below        |
| `DISTSTYLE ALL`        | Omit (Delta handles broadcast joins)     | Small dimension tables auto-broadcast |
| `DISTSTYLE EVEN`       | Omit (default)                           | Delta distributes by file             |
| `SORTKEY(col1, col2)`  | `ZORDER BY (col1, col2)` via OPTIMIZE    | Applied post-load, not at CREATE      |
| `INTERLEAVED SORTKEY`  | `ZORDER BY` (native interleaving)        | ZORDER is interleaved by default      |
| `ENCODE` compression   | Omit (Delta/Parquet handles compression) | Delta uses snappy/zstd automatically  |
| `VARCHAR(256)`         | `STRING`                                 | Databricks STRING is unbounded        |
| `SMALLINT`             | `SMALLINT` or `INT`                      | Direct mapping                        |
| `TIMESTAMP`            | `TIMESTAMP`                              | Check timezone handling               |
| `IDENTITY(seed, step)` | `GENERATED ALWAYS AS IDENTITY`           | Databricks supports identity columns  |
| `DEFAULT getdate()`    | `DEFAULT current_timestamp()`            | Function name difference              |

### Example conversion

**Redshift:**

```sql
CREATE TABLE public.fact_orders (
  order_id       BIGINT       IDENTITY(1,1) NOT NULL,
  customer_id    INTEGER      NOT NULL ENCODE lzo,
  order_date     DATE         NOT NULL,
  product_id     INTEGER      NOT NULL ENCODE lzo,
  quantity       SMALLINT     NOT NULL ENCODE raw,
  unit_price     DECIMAL(10,2) NOT NULL ENCODE az64,
  gross_amount   DECIMAL(12,2) NOT NULL ENCODE az64,
  region         VARCHAR(64)  NOT NULL ENCODE bytedict,
  order_status   VARCHAR(32)  NOT NULL ENCODE bytedict,
  created_at     TIMESTAMP    DEFAULT getdate() ENCODE az64
)
DISTKEY(customer_id)
COMPOUND SORTKEY(order_date, region);
```

**Databricks SQL:**

```sql
CREATE TABLE IF NOT EXISTS analytics_prod.gold.fact_orders (
  order_id       BIGINT       GENERATED ALWAYS AS IDENTITY,
  customer_id    INT          NOT NULL,
  order_date     DATE         NOT NULL,
  product_id     INT          NOT NULL,
  quantity       SMALLINT     NOT NULL,
  unit_price     DECIMAL(10,2) NOT NULL,
  gross_amount   DECIMAL(12,2) NOT NULL,
  region         STRING       NOT NULL,
  order_status   STRING       NOT NULL,
  created_at     TIMESTAMP    DEFAULT current_timestamp()
)
USING DELTA
PARTITIONED BY (order_date)
COMMENT 'Migrated from Redshift public.fact_orders'
TBLPROPERTIES (
  'delta.autoOptimize.optimizeWrite' = 'true',
  'delta.autoOptimize.autoCompact' = 'true',
  'quality' = 'gold',
  'source_system' = 'redshift_migration'
);

-- Apply Z-ordering after initial data load
-- OPTIMIZE analytics_prod.gold.fact_orders ZORDER BY (customer_id, region);
```

---

## Step 3: Export data using UNLOAD to S3, then AzCopy to ADLS

### UNLOAD from Redshift to S3

```sql
-- UNLOAD each table to S3 in Parquet format
UNLOAD ('SELECT * FROM public.fact_orders')
TO 's3://acme-migration-staging/redshift-export/fact_orders/'
IAM_ROLE 'arn:aws-us-gov:iam::123456789:role/redshift-unload-role'
FORMAT AS PARQUET
PARALLEL ON
MAXFILESIZE 256 MB
ALLOWOVERWRITE;

-- For large tables, UNLOAD with partition predicate to parallelize
UNLOAD ('SELECT * FROM public.fact_orders WHERE order_date >= ''2024-01-01''')
TO 's3://acme-migration-staging/redshift-export/fact_orders/2024/'
IAM_ROLE 'arn:aws-us-gov:iam::123456789:role/redshift-unload-role'
FORMAT AS PARQUET
PARALLEL ON
MAXFILESIZE 256 MB;

UNLOAD ('SELECT * FROM public.fact_orders WHERE order_date < ''2024-01-01''')
TO 's3://acme-migration-staging/redshift-export/fact_orders/pre-2024/'
IAM_ROLE 'arn:aws-us-gov:iam::123456789:role/redshift-unload-role'
FORMAT AS PARQUET
PARALLEL ON
MAXFILESIZE 256 MB;
```

### Transfer from S3 to ADLS Gen2

```bash
# Use AzCopy (see tutorial-s3-to-adls.md Step 4 for full setup)
export AWS_ACCESS_KEY_ID="<key>"
export AWS_SECRET_ACCESS_KEY="<secret>"

azcopy copy \
  "https://s3-us-gov-west-1.amazonaws.com/acme-migration-staging/redshift-export/" \
  "https://acmeanalyticsgov.blob.core.usgovcloudapi.net/bronze/redshift-export/?${SAS_TOKEN}" \
  --recursive \
  --log-level INFO
```

---

## Step 4: Create Delta tables in Databricks

### Load exported Parquet into Delta tables

```python
# Databricks notebook: load_redshift_export.py

STORAGE_ACCOUNT = "acmeanalyticsgov"
EXPORT_PATH = f"abfss://bronze@{STORAGE_ACCOUNT}.dfs.core.usgovcloudapi.net/redshift-export"
TARGET_CATALOG = "analytics_prod"

# Table loading configuration
tables = [
    {
        "name": "fact_orders",
        "partition_by": ["order_date"],
        "zorder_by": ["customer_id", "region"],
    },
    {
        "name": "dim_products",
        "partition_by": [],
        "zorder_by": ["product_id"],
    },
    {
        "name": "fact_events",
        "partition_by": ["event_date"],
        "zorder_by": ["event_type", "user_id"],
    },
]

for tbl in tables:
    source = f"{EXPORT_PATH}/{tbl['name']}/"
    target = f"{TARGET_CATALOG}.gold.{tbl['name']}"

    print(f"Loading {source} -> {target}")

    df = spark.read.parquet(source)

    writer = df.write.format("delta").mode("overwrite")
    if tbl["partition_by"]:
        writer = writer.partitionBy(*tbl["partition_by"])

    writer.saveAsTable(target)

    # Optimize with Z-ordering
    if tbl["zorder_by"]:
        zorder_cols = ", ".join(tbl["zorder_by"])
        spark.sql(f"OPTIMIZE {target} ZORDER BY ({zorder_cols})")

    count = spark.sql(f"SELECT COUNT(*) AS cnt FROM {target}").first().cnt
    print(f"  Loaded {count:,} rows into {target}")
```

### Set table properties for auto-optimization

```sql
-- Enable auto-optimize for ongoing writes
ALTER TABLE analytics_prod.gold.fact_orders SET TBLPROPERTIES (
  'delta.autoOptimize.optimizeWrite' = 'true',
  'delta.autoOptimize.autoCompact' = 'true',
  'delta.columnMapping.mode' = 'name',
  'delta.minReaderVersion' = '2',
  'delta.minWriterVersion' = '5'
);

-- Enable change data feed for downstream CDC consumers
ALTER TABLE analytics_prod.gold.fact_orders SET TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true'
);
```

---

## Step 5: Convert Redshift SQL to SparkSQL / Databricks SQL

### SQL dialect differences

This is the most labor-intensive part of the migration. The table below covers the 25 most common dialect differences.

| #   | Redshift SQL                           | Databricks SQL                                              | Category                                |
| --- | -------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| 1   | `GETDATE()`                            | `current_timestamp()`                                       | Date/time                               |
| 2   | `SYSDATE`                              | `current_timestamp()`                                       | Date/time                               |
| 3   | `DATEADD(day, 7, col)`                 | `date_add(col, 7)` or `col + INTERVAL 7 DAYS`               | Date/time                               |
| 4   | `DATEDIFF(day, start, end)`            | `datediff(end, start)`                                      | Date/time (note arg order reversal)     |
| 5   | `CONVERT(VARCHAR, col, 112)`           | `date_format(col, 'yyyyMMdd')`                              | Date/time                               |
| 6   | `TO_CHAR(col, 'YYYY-MM-DD')`           | `date_format(col, 'yyyy-MM-dd')`                            | Date/time (case-sensitive format)       |
| 7   | `EXTRACT(DOW FROM col)`                | `dayofweek(col)`                                            | Date/time                               |
| 8   | `TRUNC(col)` (date truncation)         | `date_trunc('day', col)`                                    | Date/time                               |
| 9   | `NVL(a, b)`                            | `coalesce(a, b)` or `nvl(a, b)`                             | Null handling (both work in Databricks) |
| 10  | `NVL2(a, b, c)`                        | `CASE WHEN a IS NOT NULL THEN b ELSE c END`                 | Null handling                           |
| 11  | `ISNULL(col)`                          | `col IS NULL` or `isnull(col)`                              | Null handling                           |
| 12  | `TOP n`                                | `LIMIT n`                                                   | Query structure                         |
| 13  | `SELECT INTO #temp`                    | `CREATE TEMP VIEW temp AS SELECT ...`                       | Temp tables                             |
| 14  | `CREATE TEMP TABLE`                    | `CREATE OR REPLACE TEMP VIEW`                               | Temp tables                             |
| 15  | `IDENTITY(seed, step)`                 | `GENERATED ALWAYS AS IDENTITY`                              | DDL                                     |
| 16  | `VARCHAR(n)`                           | `STRING`                                                    | Data types                              |
| 17  | `SUPER` (semi-structured)              | `VARIANT` or `STRING` + JSON functions                      | Data types                              |
| 18  | `APPROXIMATE COUNT(DISTINCT)`          | `approx_count_distinct(col)`                                | Aggregation                             |
| 19  | `LISTAGG(col, ',')`                    | `concat_ws(',', collect_list(col))`                         | Aggregation                             |
| 20  | `MEDIAN(col)`                          | `percentile_approx(col, 0.5)`                               | Aggregation                             |
| 21  | `LEN(col)`                             | `length(col)`                                               | String                                  |
| 22  | `STRTOL(hex, 16)`                      | `conv(hex, 16, 10)`                                         | String                                  |
| 23  | `DECODE(col, v1, r1, v2, r2, default)` | `CASE col WHEN v1 THEN r1 WHEN v2 THEN r2 ELSE default END` | Conditional                             |
| 24  | `\|\|` (string concat)                 | `concat(a, b)` or `\|\|`                                    | String (both work)                      |
| 25  | `COPY FROM`                            | ADF Copy Activity or Auto Loader                            | Data loading                            |

### Redshift distribution strategy to Databricks partitioning

| Redshift distribution                     | Databricks equivalent                                    | When to use                                                                           |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DISTKEY(col)` on high-cardinality column | `PARTITIONED BY (date_col)` + `ZORDER BY (col)`          | Fact tables joined on the dist key; partition by date, Z-order by the former dist key |
| `DISTKEY(col)` on low-cardinality column  | `PARTITIONED BY (col)`                                   | If cardinality is < 1000 (e.g., region), partition directly                           |
| `DISTSTYLE ALL`                           | No partitioning needed                                   | Small dimension tables (< 1M rows) broadcast automatically in Databricks              |
| `DISTSTYLE EVEN`                          | Default (no partitioning) or `PARTITIONED BY (date_col)` | When the table has no natural join key                                                |
| `COMPOUND SORTKEY(a, b)`                  | `ZORDER BY (a, b)` via `OPTIMIZE`                        | Z-ordering is interleaved by nature; compound ordering is approximated                |
| `INTERLEAVED SORTKEY(a, b, c)`            | `ZORDER BY (a, b, c)` via `OPTIMIZE`                     | Direct mapping; Z-ordering is natively interleaved                                    |

---

## Step 6: Build dbt models to replace Redshift stored procedures

Redshift stored procedures (PL/pgSQL) need to be converted to dbt models (SQL) or Databricks notebooks (Python) for imperative logic.

### Set up dbt project

```bash
# Initialize dbt project
dbt init redshift_migration
cd redshift_migration

# Install Databricks adapter
pip install dbt-databricks>=1.8.0
```

### Configure profiles.yml

```yaml
# ~/.dbt/profiles.yml
redshift_migration:
    target: dev
    outputs:
        dev:
            type: databricks
            catalog: analytics_dev
            schema: gold
            host: adb-1234567890.1.azuredatabricks.net
            http_path: /sql/1.0/warehouses/abc123def456
            token: "{{ env_var('DATABRICKS_TOKEN') }}"
            threads: 8
        prod:
            type: databricks
            catalog: analytics_prod
            schema: gold
            host: adb-1234567890.1.azuredatabricks.net
            http_path: /sql/1.0/warehouses/prod789xyz
            token: "{{ env_var('DATABRICKS_TOKEN') }}"
            threads: 16
```

### Example conversion: Redshift stored procedure to dbt model

**Redshift stored procedure (before):**

```sql
CREATE OR REPLACE PROCEDURE sp_daily_revenue_summary(run_date DATE)
AS $$
BEGIN
  DELETE FROM reporting.daily_revenue WHERE report_date = run_date;

  INSERT INTO reporting.daily_revenue
  SELECT
    run_date AS report_date,
    p.category,
    r.region,
    COUNT(DISTINCT o.customer_id) AS unique_customers,
    SUM(o.quantity) AS total_units,
    SUM(o.gross_amount) AS total_revenue,
    AVG(o.gross_amount) AS avg_order_value,
    GETDATE() AS generated_at
  FROM public.fact_orders o
  JOIN public.dim_products p ON o.product_id = p.product_id
  JOIN public.dim_regions r ON o.region = r.region_code
  WHERE o.order_date = run_date
  GROUP BY 1, 2, 3;
END;
$$ LANGUAGE plpgsql;
```

**dbt incremental model (after):**

```sql
-- models/gold/daily_revenue_summary.sql
{{ config(
    materialized='incremental',
    unique_key=['report_date', 'category', 'region'],
    incremental_strategy='merge',
    partition_by=['report_date']
) }}

SELECT
  o.order_date                        AS report_date,
  p.category,
  r.region,
  COUNT(DISTINCT o.customer_id)       AS unique_customers,
  SUM(o.quantity)                     AS total_units,
  SUM(o.gross_amount)                 AS total_revenue,
  AVG(o.gross_amount)                 AS avg_order_value,
  current_timestamp()                 AS generated_at
FROM {{ ref('stg_fact_orders') }} o
JOIN {{ ref('stg_dim_products') }} p ON o.product_id = p.product_id
JOIN {{ ref('stg_dim_regions') }} r  ON o.region = r.region_code
{% if is_incremental() %}
WHERE o.order_date >= date_sub(current_date(), 3)
{% endif %}
GROUP BY 1, 2, 3
```

```yaml
# models/gold/daily_revenue_summary.yml
version: 2
models:
    - name: daily_revenue_summary
      description: "Daily revenue summary by category and region. Migrated from Redshift sp_daily_revenue_summary."
      columns:
          - name: report_date
            tests: [not_null]
          - name: total_revenue
            tests:
                - not_null
                - dbt_utils.accepted_range:
                      min_value: 0
```

---

## Step 7: Create Power BI semantic model with Direct Lake

Direct Lake mode reads Delta Lake tables directly from OneLake without import or DirectQuery overhead.

### Create the semantic model

1. Open Power BI Desktop.
2. Select **Get Data > Microsoft Fabric > Lakehouse**.
3. Connect to your Fabric workspace and select the lakehouse containing the Delta tables.
4. Select the tables: `fact_orders`, `dim_products`, `dim_regions`, `daily_revenue_summary`.
5. Power BI auto-detects Direct Lake mode when connected to OneLake-backed Delta tables.

### Define relationships

```
fact_orders.product_id -> dim_products.product_id (many-to-one)
fact_orders.region -> dim_regions.region_code (many-to-one)
daily_revenue_summary.category -> dim_products.category (many-to-one)
```

### Add DAX measures

```dax
// Revenue metrics
Total Revenue = SUM(fact_orders[gross_amount])

Revenue YoY Growth =
VAR CurrentYear = [Total Revenue]
VAR PriorYear = CALCULATE([Total Revenue], SAMEPERIODLASTYEAR('dim_date'[date]))
RETURN DIVIDE(CurrentYear - PriorYear, PriorYear)

Avg Order Value = DIVIDE([Total Revenue], DISTINCTCOUNT(fact_orders[order_id]))
```

### Publish and validate

```bash
# Publish to Fabric workspace (via Power BI Desktop: File > Publish)
# Then configure scheduled refresh (not needed for Direct Lake -- it reads live)
```

> **AWS comparison:** In AWS, QuickSight connects to Redshift via SPICE (import) or direct query. Power BI Direct Lake is more comparable to SPICE in that it pre-caches columnar data, but the data stays in Delta Lake format on OneLake rather than being copied into a proprietary cache. This means no refresh schedule is needed for Direct Lake -- it reads the latest Delta version automatically.

---

## Step 8: Validate query results match

### Side-by-side query validation

Run identical analytical queries on both Redshift and Databricks SQL, then compare results.

```python
# Databricks notebook: validate_redshift_migration.py

import pandas as pd

# Queries to validate (run on both platforms)
validation_queries = [
    {
        "name": "total_revenue_by_month",
        "redshift_sql": """
            SELECT DATE_TRUNC('month', order_date) AS month,
                   SUM(gross_amount) AS revenue
            FROM public.fact_orders
            WHERE order_date >= '2025-01-01'
            GROUP BY 1 ORDER BY 1
        """,
        "databricks_sql": """
            SELECT date_trunc('month', order_date) AS month,
                   SUM(gross_amount) AS revenue
            FROM analytics_prod.gold.fact_orders
            WHERE order_date >= '2025-01-01'
            GROUP BY 1 ORDER BY 1
        """,
        "tolerance": 0.01
    },
    {
        "name": "customer_count_by_region",
        "redshift_sql": """
            SELECT region, COUNT(DISTINCT customer_id) AS customers
            FROM public.fact_orders
            GROUP BY 1 ORDER BY 1
        """,
        "databricks_sql": """
            SELECT region, COUNT(DISTINCT customer_id) AS customers
            FROM analytics_prod.gold.fact_orders
            GROUP BY 1 ORDER BY 1
        """,
        "tolerance": 0
    }
]

for vq in validation_queries:
    # Run Databricks query
    dbx_df = spark.sql(vq["databricks_sql"]).toPandas()

    # Compare against pre-exported Redshift results
    # (Export Redshift results to CSV and upload to ADLS before this step)
    rs_df = spark.read.csv(
        f"abfss://bronze@acmeanalyticsgov.dfs.core.usgovcloudapi.net/validation/{vq['name']}.csv",
        header=True, inferSchema=True
    ).toPandas()

    # Compare
    merged = pd.merge(rs_df, dbx_df, on=rs_df.columns[0], suffixes=('_rs', '_dbx'))
    for col in rs_df.columns[1:]:
        diff = abs(merged[f"{col}_rs"] - merged[f"{col}_dbx"])
        max_diff = diff.max()
        if max_diff > vq["tolerance"]:
            print(f"FAIL: {vq['name']}.{col} max diff = {max_diff}")
        else:
            print(f"PASS: {vq['name']}.{col} max diff = {max_diff}")
```

### Automated regression test suite

```yaml
# dbt test for parity validation
# tests/validate_migration_parity.sql
-- This test fails if the Databricks daily_revenue_summary
-- deviates from the expected row count by more than 0.1%

SELECT
report_date,
ABS(dbx_revenue - expected_revenue) / expected_revenue AS pct_diff
FROM (
SELECT
report_date,
total_revenue AS dbx_revenue
FROM {{ ref('daily_revenue_summary') }}
) dbx
JOIN {{ ref('seed_redshift_revenue_baseline') }} baseline
USING (report_date)
WHERE ABS(dbx_revenue - expected_revenue) / expected_revenue > 0.001
```

---

## Performance tuning tips

### Sizing Databricks SQL Warehouses

| Redshift node type     | Recommended Databricks SQL Warehouse | Notes               |
| ---------------------- | ------------------------------------ | ------------------- |
| dc2.large (2 nodes)    | Small (2X-Small serverless)          | Light ad-hoc        |
| dc2.8xlarge (4 nodes)  | Medium serverless                    | Standard analytics  |
| ra3.xlplus (6 nodes)   | Large serverless                     | Heavy dashboards    |
| ra3.4xlarge (8+ nodes) | X-Large or 2X-Large serverless       | Concurrent BI + ETL |

### Key optimization techniques

1. **Use serverless SQL Warehouses** -- they auto-scale to zero and handle concurrency spikes better than dedicated.
2. **OPTIMIZE frequently** -- run `OPTIMIZE ... ZORDER BY` on hot tables after bulk loads.
3. **Leverage Photon** -- enable the Photon runtime for 2-5x faster queries on Delta Lake.
4. **Partition wisely** -- partition by date for time-series fact tables; avoid over-partitioning (< 1 GB per partition is too small).
5. **Cache results** -- Databricks SQL result caching (enabled by default) eliminates redundant computation for repeated dashboard queries.
6. **Use liquid clustering** -- for Databricks Runtime 13.3+, liquid clustering replaces static partitioning + Z-ordering with adaptive physical layout.

---

## Related resources

- [AWS-to-Azure migration playbook](../aws-to-azure.md) -- full capability mapping, Redshift section 2.1
- [S3 to ADLS tutorial](tutorial-s3-to-adls.md) -- storage migration prerequisite
- [Glue to ADF + dbt tutorial](tutorial-glue-to-adf-dbt.md) -- ETL pipeline migration
- [Benchmarks](benchmarks.md) -- Redshift vs Databricks SQL performance comparison
- [Best practices](best-practices.md) -- migration patterns and pitfalls
- `docs/adr/0001-adf-dbt-over-airflow.md` -- why dbt replaces stored procedures
- `docs/adr/0002-databricks-over-oss-spark.md` -- Databricks as the compute platform
- `docs/adr/0003-delta-lake-over-iceberg-and-parquet.md` -- Delta Lake format rationale
- `domains/shared/dbt/dbt_project.yml` -- reference dbt project configuration

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
