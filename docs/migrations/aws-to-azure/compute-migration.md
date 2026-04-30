# Compute Migration: Redshift, EMR, and Athena to Azure

**A deep-dive guide for data engineers migrating AWS compute services to Databricks, Fabric, and Synapse on Azure.**

---

## Executive summary

The AWS analytics compute layer is three services with three different programming models: Redshift for SQL warehousing, EMR for Spark/Hadoop, and Athena for serverless ad-hoc queries. Each has its own query dialect, its own performance tuning model, and its own cost structure. Migrating these to Azure means mapping three compute models onto a unified Databricks + Fabric platform.

The consolidation payoff is significant. Instead of managing Redshift clusters, EMR fleets, and Athena workgroups independently, the target architecture uses Databricks SQL Warehouses for interactive queries, Databricks Jobs for batch processing, and Fabric SQL endpoints for lightweight ad-hoc access. One engine, one billing model, one monitoring surface.

---

## Part 1: Redshift to Databricks SQL

### Architecture mapping

| Redshift concept | Databricks SQL equivalent | Notes |
|---|---|---|
| Cluster (RA3 nodes) | SQL Warehouse (Classic or Serverless) | Serverless recommended for variable workloads |
| Database | Unity Catalog catalog | One Redshift database per catalog |
| Schema | Unity Catalog schema | 1:1 mapping |
| Table (distribution style) | Delta table (partitioned) | See distribution mapping below |
| External table (Spectrum) | OneLake shortcut / external location | Zero-copy reads from S3 |
| View | View in Unity Catalog | 1:1 mapping |
| Materialized view | dbt incremental model / Databricks MV | dbt preferred for testability |
| Stored procedure | dbt macro / notebook job | See SP migration section |
| WLM queue | SQL Warehouse | One warehouse per workload class |
| User/group | Entra ID user/group + Unity Catalog grants | See [Security Migration](security-migration.md) |

### SQL dialect differences

Redshift SQL is PostgreSQL-derivative. Databricks SQL is SparkSQL-based. Most standard SQL works on both, but there are differences.

#### Date and time functions

| Operation | Redshift SQL | Databricks SQL |
|---|---|---|
| Current date | `GETDATE()` or `CURRENT_DATE` | `CURRENT_DATE()` or `CURRENT_DATE` |
| Current timestamp | `GETDATE()` or `SYSDATE` | `CURRENT_TIMESTAMP()` or `NOW()` |
| Date add | `DATEADD(day, 7, date_col)` | `DATE_ADD(date_col, 7)` |
| Date diff | `DATEDIFF(day, start, end)` | `DATEDIFF(end, start)` (note: reversed arg order) |
| Date trunc | `DATE_TRUNC('month', date_col)` | `DATE_TRUNC('month', date_col)` (same) |
| Extract | `EXTRACT(year FROM date_col)` | `YEAR(date_col)` or `EXTRACT(YEAR FROM date_col)` |
| String to date | `TO_DATE(str, 'YYYY-MM-DD')` | `TO_DATE(str, 'yyyy-MM-dd')` (Java format) |
| Date to string | `TO_CHAR(date_col, 'YYYY-MM-DD')` | `DATE_FORMAT(date_col, 'yyyy-MM-dd')` |

#### String functions

| Operation | Redshift SQL | Databricks SQL |
|---|---|---|
| Concatenate | `col1 \|\| col2` or `CONCAT(a, b)` | `CONCAT(a, b)` or `a \|\| b` |
| Substring | `SUBSTRING(str, start, len)` | `SUBSTRING(str, start, len)` (same) |
| Length | `LEN(str)` | `LENGTH(str)` or `LEN(str)` |
| Trim | `TRIM(str)` | `TRIM(str)` (same) |
| Replace | `REPLACE(str, old, new)` | `REPLACE(str, old, new)` (same) |
| Regex match | `str ~ 'pattern'` | `str RLIKE 'pattern'` |
| NVL | `NVL(a, b)` | `COALESCE(a, b)` or `NVL(a, b)` |
| DECODE | `DECODE(col, val1, res1, val2, res2, default)` | `CASE WHEN col = val1 THEN res1 ...` |

#### Data types

| Redshift type | Databricks SQL type | Notes |
|---|---|---|
| `SMALLINT` | `SMALLINT` | Same |
| `INTEGER` | `INT` | Same |
| `BIGINT` | `BIGINT` | Same |
| `DECIMAL(p,s)` | `DECIMAL(p,s)` | Same |
| `REAL` / `FLOAT4` | `FLOAT` | Same |
| `DOUBLE PRECISION` / `FLOAT8` | `DOUBLE` | Same |
| `BOOLEAN` | `BOOLEAN` | Same |
| `CHAR(n)` | `STRING` | Databricks uses variable-length strings |
| `VARCHAR(n)` | `STRING` | Length constraint enforced at application layer |
| `DATE` | `DATE` | Same |
| `TIMESTAMP` | `TIMESTAMP` | Same |
| `TIMESTAMPTZ` | `TIMESTAMP` | Databricks stores UTC; apply timezone in queries |
| `SUPER` (semi-structured) | `STRING` (JSON) + JSON functions | Use `:` notation for JSON field access |
| `HLLSKETCH` | `approx_count_distinct()` | Function-based rather than type-based |
| `GEOMETRY` | `STRING` (WKT) + H3 functions | Spatial support via H3 and Mosaic libraries |

### Distribution and sort key mapping

Redshift distribution styles control how data is physically distributed across nodes. Delta Lake uses partitioning and Z-ordering instead.

| Redshift distribution | Delta Lake equivalent | Migration approach |
|---|---|---|
| `DISTSTYLE KEY (col)` | `PARTITIONED BY (col)` | High-cardinality keys become partition columns |
| `DISTSTYLE EVEN` | No partition (or hash partition) | Let Delta auto-optimize; add Z-order if needed |
| `DISTSTYLE ALL` | Broadcast hint in joins | Small dimension tables; use `/*+ BROADCAST(dim) */` |
| `SORTKEY (col1, col2)` | `ZORDER BY (col1, col2)` | Run after initial load: `OPTIMIZE tbl ZORDER BY (col1, col2)` |
| `COMPOUND SORTKEY` | `ZORDER BY (col1, col2)` | Z-order handles multi-column optimization |
| `INTERLEAVED SORTKEY` | `ZORDER BY (col1, col2)` | Z-order is inherently multi-dimensional |

**Example: convert a Redshift table definition**

```sql
-- Redshift DDL
CREATE TABLE sales.fact_orders (
  order_id BIGINT,
  customer_id BIGINT,
  order_date DATE,
  region VARCHAR(50),
  product_id BIGINT,
  quantity INTEGER,
  amount DECIMAL(18,2)
)
DISTSTYLE KEY
DISTKEY (customer_id)
COMPOUND SORTKEY (order_date, region);
```

```sql
-- Databricks SQL DDL
CREATE TABLE sales_prod.gold.fact_orders (
  order_id BIGINT,
  customer_id BIGINT,
  order_date DATE,
  region STRING,
  product_id BIGINT,
  quantity INT,
  amount DECIMAL(18,2)
)
USING DELTA
PARTITIONED BY (order_date)
COMMENT 'Migrated from Redshift sales.fact_orders';

-- After initial data load, optimize
OPTIMIZE sales_prod.gold.fact_orders
  ZORDER BY (region, customer_id);
```

### Workload Management (WLM) to SQL Warehouse sizing

| WLM queue | Typical use | Databricks SQL Warehouse | Sizing guidance |
|---|---|---|---|
| ETL queue (high memory) | Batch loads, CTAS | Databricks Job cluster | Auto-scaling; Photon enabled |
| BI queue (high concurrency) | Dashboard queries | SQL Warehouse (Serverless) | Auto-scale 1-10; 2XS-M size |
| Ad-hoc queue | Analyst queries | SQL Warehouse (Pro) | Auto-scale 1-4; S-M size |
| Short query queue | Sub-second lookups | SQL Warehouse (Serverless) | Auto-scale; smallest size |
| Superuser queue | Admin/DDL | SQL Warehouse (Classic) | Fixed size; restricted access |

### Stored procedure migration

Redshift stored procedures use a PL/pgSQL-like syntax. There is no direct equivalent in Databricks SQL. Migration paths depend on the SP complexity:

**Path 1: SQL-only logic to dbt macros (recommended)**

```sql
-- Redshift SP
CREATE OR REPLACE PROCEDURE refresh_daily_sales(run_date DATE)
AS $$
BEGIN
  DELETE FROM gold.fact_sales_daily WHERE sales_date = run_date;
  INSERT INTO gold.fact_sales_daily
    SELECT DATE(order_ts) AS sales_date, region, product_id,
           SUM(quantity) AS units, SUM(amount) AS revenue
    FROM silver.orders
    WHERE DATE(order_ts) = run_date
    GROUP BY 1, 2, 3;
END;
$$ LANGUAGE plpgsql;
```

```sql
-- dbt incremental model (replaces SP)
-- models/gold/fact_sales_daily.sql
{{ config(
    materialized='incremental',
    unique_key=['sales_date', 'region', 'product_id'],
    incremental_strategy='merge',
    partition_by=['sales_date']
) }}

SELECT
  DATE(order_ts) AS sales_date,
  region,
  product_id,
  SUM(quantity) AS units,
  SUM(amount) AS revenue
FROM {{ ref('stg_orders') }}
{% if is_incremental() %}
WHERE DATE(order_ts) >= DATE_SUB(CURRENT_DATE(), 3)
{% endif %}
GROUP BY 1, 2, 3
```

**Path 2: Complex imperative logic to Databricks notebooks**

```python
# Databricks notebook (replaces complex SP with control flow)
import pyspark.sql.functions as F
from datetime import date, timedelta

# Parameters (from Databricks Job)
run_date = dbutils.widgets.get("run_date")

# Read source
orders = spark.table("sales_prod.silver.orders") \
    .filter(F.col("order_date") == run_date)

# Complex business logic that was in SP
if orders.count() == 0:
    dbutils.notebook.exit("No data for date")

# Aggregation with conditional logic
result = orders.groupBy("region", "product_id") \
    .agg(
        F.sum("quantity").alias("units"),
        F.sum("amount").alias("revenue"),
        F.countDistinct("customer_id").alias("unique_customers")
    )

# Merge into target
result.write \
    .format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", f"sales_date = '{run_date}'") \
    .saveAsTable("sales_prod.gold.fact_sales_daily")
```

---

## Part 2: EMR to Databricks

### Spark version compatibility

| EMR release | Spark version | Databricks Runtime | Notes |
|---|---|---|---|
| EMR 6.15 | Spark 3.4.1 | DBR 13.3 LTS | Direct compatibility |
| EMR 6.12 | Spark 3.4.0 | DBR 13.3 LTS | Direct compatibility |
| EMR 7.0 | Spark 3.5.0 | DBR 14.3 LTS | Direct compatibility |
| EMR 7.1 | Spark 3.5.1 | DBR 15.4 LTS | Direct compatibility |

**Key point:** Spark code written for EMR runs on Databricks with minimal changes. The Spark API is the same. The differences are in cluster configuration, library management, and filesystem paths.

### Common code changes

**File system paths:**

```python
# EMR (S3)
df = spark.read.parquet("s3a://acme-analytics-raw/sales/")
df.write.parquet("s3a://acme-analytics-curated/sales_daily/")

# Databricks (ADLS Gen2)
df = spark.read.parquet("abfss://raw@acmeanalyticsgov.dfs.core.usgovcloudapi.net/sales/")
df.write.format("delta").save("abfss://curated@acmeanalyticsgov.dfs.core.usgovcloudapi.net/sales_daily/")

# Databricks (Unity Catalog - preferred)
df = spark.table("sales_prod.bronze.raw_sales")
df.write.format("delta").mode("overwrite").saveAsTable("sales_prod.gold.fact_sales_daily")
```

**Credential configuration:**

```python
# EMR: IAM Instance Profile (automatic)
# No credential configuration needed in code

# Databricks: Managed Identity (automatic with Unity Catalog)
# No credential configuration needed in code when using Unity Catalog
# Unity Catalog + managed identity handles auth transparently
```

**Library management:**

| EMR approach | Databricks equivalent | Notes |
|---|---|---|
| Bootstrap action (install packages) | Init script | Place in DBFS or workspace files |
| EMR step (jar submission) | Job task (jar/wheel) | Attach library to job or cluster |
| `--py-files` (PySpark dependencies) | Workspace library / PyPI install | `%pip install` in notebook or cluster library |
| Conda/virtualenv | Databricks cluster library | Install at cluster level or notebook level |

### EMR Step to Databricks Job conversion

```json
{
  "name": "daily_sales_agg",
  "schedule": {
    "quartz_cron_expression": "0 0 2 * * ?",
    "timezone_id": "UTC"
  },
  "tasks": [
    {
      "task_key": "aggregate",
      "notebook_task": {
        "notebook_path": "/Repos/analytics/sales/jobs/daily_sales_agg",
        "base_parameters": {
          "run_date": "{{job.start_time[yyyy-MM-dd]}}"
        }
      },
      "job_cluster_key": "agg_cluster"
    }
  ],
  "job_clusters": [
    {
      "job_cluster_key": "agg_cluster",
      "new_cluster": {
        "spark_version": "15.4.x-scala2.12",
        "node_type_id": "Standard_D8s_v5",
        "num_workers": 4,
        "data_security_mode": "SINGLE_USER",
        "runtime_engine": "PHOTON"
      }
    }
  ]
}
```

### Bootstrap actions to init scripts

```bash
# EMR bootstrap action
#!/bin/bash
sudo pip3 install pandas==2.1.0 pyarrow==14.0.0
sudo yum install -y libgdal-devel
```

```bash
# Databricks init script (place in workspace or DBFS)
#!/bin/bash
pip install pandas==2.1.0 pyarrow==14.0.0
apt-get update && apt-get install -y libgdal-dev
```

---

## Part 3: Athena to Fabric SQL endpoint / Databricks SQL

### Migration path selection

| Athena usage pattern | Recommended Azure target | Reasoning |
|---|---|---|
| Ad-hoc analyst queries | Databricks SQL Warehouse (Serverless) | Auto-scales to zero; pay per query |
| Scheduled reports/dashboards | Databricks SQL Warehouse (Pro) | Consistent performance; integrates with Power BI |
| Federated queries (DynamoDB, RDS) | Databricks Lakehouse Federation | Native connectors for common sources |
| Lightweight exploration | Fabric SQL endpoint | Zero-config for data already in OneLake |
| Cost-sensitive scanning | Fabric SQL endpoint | No per-scan charge; included in Fabric capacity |

### Athena saved queries migration

Athena saved queries and named queries are SQL text stored in Athena. Extract and adapt:

```bash
# Export all saved queries from Athena
aws athena list-named-queries --output json > athena_queries.json

# For each query ID, get the SQL
for qid in $(cat athena_queries.json | jq -r '.NamedQueryIds[]'); do
  aws athena get-named-query --named-query-id $qid --output json >> query_definitions.json
done
```

**Common Athena-to-Databricks SQL adaptations:**

```sql
-- Athena: partition projection (no direct equivalent)
-- CREATE EXTERNAL TABLE logs (...)
-- PARTITIONED BY (dt STRING)
-- TBLPROPERTIES (
--   'projection.enabled' = 'true',
--   'projection.dt.type' = 'date',
--   'projection.dt.range' = '2020-01-01,NOW'
-- )

-- Databricks: Auto Loader handles dynamic partition discovery
-- Or: explicit partition columns in Delta table
CREATE TABLE logs_prod.bronze.logs
USING DELTA
PARTITIONED BY (dt)
AS SELECT *, DATE(event_time) AS dt FROM ...;
```

```sql
-- Athena: CTAS (Create Table As Select) for results
CREATE TABLE results.monthly_summary
WITH (
  format = 'PARQUET',
  external_location = 's3://results/monthly/'
) AS SELECT ...

-- Databricks: CREATE TABLE or INSERT OVERWRITE
CREATE OR REPLACE TABLE results_prod.gold.monthly_summary
USING DELTA
AS SELECT ...;
```

### Athena workgroup to SQL Warehouse mapping

| Athena workgroup setting | Databricks SQL Warehouse equivalent |
|---|---|
| `BytesScannedCutoffPerQuery` | SQL Warehouse query timeout + Azure budget alerts |
| `RequesterPaysEnabled` | N/A --- ADLS does not have requester-pays |
| `OutputLocation` | Default warehouse location in Unity Catalog |
| `EncryptionConfiguration` | Storage account encryption (CMK via Key Vault) |
| `EnforceWorkGroupConfiguration` | SQL Warehouse access control + cluster policies |

---

## Data migration tooling comparison

| Tool | Best for | Throughput | Cost |
|---|---|---|---|
| AzCopy | Bulk S3 to ADLS copy | 5-10 Gbps over ExpressRoute | Free (egress charges apply) |
| ADF Copy Activity | Orchestrated, incremental copies | Scales with DIU count | Per-DIU-hour pricing |
| Databricks notebook | Format conversion (Parquet to Delta) | Scales with cluster size | Per-DBU pricing |
| OneLake shortcut | Zero-copy bridge | N/A (no data movement) | No data movement cost |
| AWS DMS | Database-to-database (Redshift to SQL) | Varies by instance | Per-instance-hour |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Storage Migration](storage-migration.md) | [ETL Migration](etl-migration.md) | [Migration Playbook](../aws-to-azure.md)
