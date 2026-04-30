# Streams, Tasks, and Dynamic Tables Migration Guide

**Status:** Authored 2026-04-30
**Audience:** Data engineers managing CDC pipelines, scheduled transformations, and materialized views on Snowflake
**Scope:** Streams to ADF CDC / Fabric mirroring, Tasks to ADF triggers / Databricks workflows, Dynamic Tables to dbt incremental + materialized views

---

## 1. Architecture comparison

### Snowflake orchestration model

Snowflake provides three tightly coupled orchestration primitives:

| Primitive          | Purpose                                  | How it works                                                                        |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| **Streams**        | Change data capture (CDC)                | Tracks DML changes (inserts, updates, deletes) on a table; consumes changes on read |
| **Tasks**          | Scheduled SQL execution                  | Cron or interval-based SQL execution; supports DAG dependencies via `AFTER` clause  |
| **Dynamic Tables** | Declarative materialized transformations | SQL definition + lag target; Snowflake auto-refreshes at the specified interval     |

These work well together because they share the same execution engine and metadata layer.

### Azure orchestration model

Azure distributes orchestration across purpose-built services:

| Snowflake primitive | Azure equivalent(s)                                          | Why multiple                                                                                |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Streams             | Delta change-data-feed (CDF) + Databricks DLT + ADF CDC      | CDF for Delta-native CDC; DLT for streaming pipelines; ADF for cross-source CDC             |
| Tasks               | ADF triggers + Databricks Jobs + dbt Cloud jobs              | ADF for orchestration; Databricks Jobs for notebook/JAR execution; dbt Cloud for SQL models |
| Dynamic Tables      | dbt incremental models + Databricks materialized views + DLT | dbt for SQL transformations; MV for simple cases; DLT for streaming materialization         |

The Azure model is more flexible but requires choosing the right tool for each pattern.

---

## 2. Streams migration

### How Snowflake Streams work

```sql
-- Create a stream on a table
CREATE STREAM raw_orders_stream ON TABLE raw.orders;

-- Consume changes (inserts, updates, deletes)
SELECT *
FROM raw_orders_stream
WHERE METADATA$ACTION = 'INSERT';

-- After consuming, the stream offset advances
-- (stream is consumed by reading it in a DML transaction)
INSERT INTO staging.orders_changes
SELECT * FROM raw_orders_stream;
```

Key characteristics:

- Streams track changes since last consumption
- Changes include `METADATA$ACTION` (INSERT/DELETE), `METADATA$ISUPDATE`, `METADATA$ROW_ID`
- Consuming a stream in a DML statement advances the offset
- Streams are table-specific; one stream per tracked table

### Option A: Delta Change Data Feed (CDF)

Delta CDF is the closest equivalent to Snowflake Streams:

```sql
-- Enable change data feed on a Delta table
ALTER TABLE analytics_prod.raw.orders
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');

-- Read changes since a version
SELECT *
FROM table_changes('analytics_prod.raw.orders', 5)
WHERE _change_type IN ('insert', 'update_postimage');

-- Read changes since a timestamp
SELECT *
FROM table_changes('analytics_prod.raw.orders', '2026-04-01T00:00:00')
WHERE _change_type = 'insert';
```

**Translation mapping:**

| Snowflake Stream metadata           | Delta CDF column                    | Values                  |
| ----------------------------------- | ----------------------------------- | ----------------------- |
| `METADATA$ACTION = 'INSERT'`        | `_change_type = 'insert'`           | New row                 |
| `METADATA$ACTION = 'DELETE'`        | `_change_type = 'delete'`           | Deleted row             |
| `METADATA$ISUPDATE = TRUE` + DELETE | `_change_type = 'update_preimage'`  | Row before update       |
| `METADATA$ISUPDATE = TRUE` + INSERT | `_change_type = 'update_postimage'` | Row after update        |
| `METADATA$ROW_ID`                   | No direct equivalent                | Use primary key instead |

**Key difference:** Delta CDF does not auto-advance an offset. You must track the last processed version or timestamp yourself:

```python
# Track last processed version in a checkpoint table
last_version = spark.sql("""
    SELECT MAX(processed_version) as v
    FROM analytics_prod.ops.cdf_checkpoints
    WHERE table_name = 'raw.orders'
""").collect()[0]["v"] or 0

changes = spark.sql(f"""
    SELECT * FROM table_changes('analytics_prod.raw.orders', {last_version + 1})
    WHERE _change_type IN ('insert', 'update_postimage')
""")

# Process changes
changes.write.mode("append").saveAsTable("analytics_prod.staging.orders_changes")

# Update checkpoint
spark.sql(f"""
    MERGE INTO analytics_prod.ops.cdf_checkpoints AS t
    USING (SELECT 'raw.orders' AS table_name,
                  (SELECT MAX(_commit_version) FROM table_changes('analytics_prod.raw.orders', {last_version + 1})) AS processed_version) AS s
    ON t.table_name = s.table_name
    WHEN MATCHED THEN UPDATE SET processed_version = s.processed_version
    WHEN NOT MATCHED THEN INSERT (table_name, processed_version) VALUES (s.table_name, s.processed_version)
""")
```

### Option B: Databricks Delta Live Tables (DLT)

For streaming CDC pipelines, DLT is the most natural replacement:

```python
# DLT pipeline: streaming CDC from Delta CDF
import dlt
from pyspark.sql.functions import col

@dlt.table(
    name="orders_cdc",
    comment="CDC stream from raw orders"
)
def orders_cdc():
    return (
        spark.readStream
        .option("readChangeFeed", "true")
        .option("startingVersion", 0)
        .table("analytics_prod.raw.orders")
        .filter(col("_change_type").isin("insert", "update_postimage"))
    )

@dlt.table(
    name="orders_cleaned",
    comment="Cleaned orders with deduplication"
)
def orders_cleaned():
    return (
        dlt.read_stream("orders_cdc")
        .dropDuplicates(["order_id"])
        .select("order_id", "customer_id", "amount", "order_date", "status")
    )
```

### Option C: ADF CDC (for cross-source CDC)

When CDC needs to capture changes from non-Delta sources (SQL Server, PostgreSQL, etc.):

```json
{
    "name": "CDC_Orders_Pipeline",
    "properties": {
        "activities": [
            {
                "name": "GetChanges",
                "type": "Copy",
                "inputs": [{ "referenceName": "SqlServerSource" }],
                "outputs": [{ "referenceName": "DeltaLakeSink" }],
                "typeProperties": {
                    "source": {
                        "type": "SqlServerSource",
                        "sqlReaderQuery": "SELECT * FROM cdc.dbo_orders_CT WHERE __$start_lsn > @{pipeline().parameters.lastLSN}"
                    },
                    "sink": {
                        "type": "DeltaLakeSink",
                        "writeBehavior": "upsert",
                        "mergeKey": ["order_id"]
                    }
                }
            }
        ]
    }
}
```

### Decision tree: which CDC approach

```
Is the source a Delta table?
├── Yes → Delta CDF (simplest, native)
│         Is it a streaming pipeline?
│         ├── Yes → DLT with readChangeFeed
│         └── No → Batch CDF reads with checkpoint tracking
└── No → ADF CDC
          Is the source SQL Server?
          ├── Yes → ADF with SQL Server CDC connector
          └── No → ADF with watermark-based incremental copy
```

---

## 3. Tasks migration

### Snowflake Tasks overview

```sql
-- Simple scheduled task
CREATE TASK refresh_staging
    WAREHOUSE = 'TRANSFORM_WH'
    SCHEDULE = 'USING CRON 0 */2 * * * America/New_York'
AS
    INSERT OVERWRITE INTO staging.customers_clean
    SELECT * FROM raw.customers WHERE status != 'deleted';

-- Task with dependency (DAG)
CREATE TASK build_mart
    WAREHOUSE = 'TRANSFORM_WH'
    AFTER refresh_staging
AS
    INSERT OVERWRITE INTO marts.customer_summary
    SELECT customer_id, SUM(revenue) AS total_revenue
    FROM staging.orders_clean
    GROUP BY customer_id;

-- Enable tasks
ALTER TASK build_mart RESUME;
ALTER TASK refresh_staging RESUME;
```

### Option A: dbt + Databricks Jobs (recommended for SQL transformations)

Most Snowflake Tasks that run SQL transformations should become dbt models scheduled via Databricks Jobs:

```yaml
# dbt_project.yml
models:
    my_project:
        staging:
            +materialized: view
        marts:
            +materialized: incremental
            +incremental_strategy: merge
```

```sql
-- models/staging/stg_customers_clean.sql
SELECT *
FROM {{ source('raw', 'customers') }}
WHERE status != 'deleted'

-- models/marts/customer_summary.sql
{{ config(
    materialized='incremental',
    unique_key='customer_id',
    incremental_strategy='merge'
) }}

SELECT
    customer_id,
    SUM(revenue) AS total_revenue
FROM {{ ref('stg_orders_clean') }}
GROUP BY customer_id
{% if is_incremental() %}
HAVING MAX(updated_at) > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
```

Schedule via Databricks Job:

```json
{
    "name": "dbt-daily-build",
    "schedule": {
        "quartz_cron_expression": "0 0 */2 * * ?",
        "timezone_id": "America/New_York"
    },
    "tasks": [
        {
            "task_key": "dbt-run",
            "dbt_task": {
                "commands": ["dbt run --select staging marts"],
                "project_directory": "/Repos/team/dbt-project"
            },
            "existing_cluster_id": "cluster-id"
        }
    ]
}
```

### Option B: ADF triggers (for orchestration across services)

When tasks coordinate across multiple services (not just SQL):

```json
{
    "name": "Daily_Refresh_Pipeline",
    "properties": {
        "activities": [
            {
                "name": "RunDbtStaging",
                "type": "DatabricksSparkJar",
                "dependsOn": [],
                "typeProperties": {
                    "mainClassName": "com.acme.DbtRunner",
                    "parameters": ["--select", "staging"]
                }
            },
            {
                "name": "RunDbtMarts",
                "type": "DatabricksSparkJar",
                "dependsOn": [
                    {
                        "activity": "RunDbtStaging",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "mainClassName": "com.acme.DbtRunner",
                    "parameters": ["--select", "marts"]
                }
            },
            {
                "name": "RefreshPowerBI",
                "type": "WebActivity",
                "dependsOn": [
                    {
                        "activity": "RunDbtMarts",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "method": "POST",
                    "url": "https://api.powerbi.com/v1.0/myorg/groups/{workspace}/datasets/{dataset}/refreshes"
                }
            }
        ],
        "triggers": [
            {
                "name": "EveryTwoHours",
                "type": "ScheduleTrigger",
                "recurrence": {
                    "frequency": "Hour",
                    "interval": 2,
                    "timeZone": "Eastern Standard Time"
                }
            }
        ]
    }
}
```

### Task DAG translation

| Snowflake DAG pattern               | Azure equivalent                                              |
| ----------------------------------- | ------------------------------------------------------------- |
| `TASK A` (root)                     | dbt model A (no upstream ref) or ADF activity (no dependency) |
| `TASK B AFTER A`                    | dbt `ref('model_a')` in model B or ADF activity dependency    |
| `TASK C AFTER A, B`                 | dbt `ref('model_a')` + `ref('model_b')` in model C            |
| Tree-shaped DAG                     | dbt DAG (natural) or ADF pipeline with parallel branches      |
| Conditional task (`WHEN condition`) | ADF `If Condition` activity or dbt `run_query` + `if`         |

---

## 4. Dynamic Tables migration

### How Dynamic Tables work

```sql
-- Snowflake dynamic table
CREATE DYNAMIC TABLE marts.daily_revenue
    TARGET_LAG = '15 minutes'
    WAREHOUSE = 'ANALYTICS_WH'
AS
    SELECT
        DATE_TRUNC('day', order_date) AS revenue_date,
        SUM(amount) AS total_revenue,
        COUNT(*) AS order_count
    FROM staging.orders_clean
    GROUP BY DATE_TRUNC('day', order_date);
```

Dynamic Tables are declarative: you define the SQL and a freshness target (lag), and Snowflake handles scheduling and incremental refresh.

### Option A: dbt incremental models (recommended)

```sql
-- models/marts/daily_revenue.sql
{{ config(
    materialized='incremental',
    unique_key='revenue_date',
    incremental_strategy='merge',
    tblproperties={'delta.autoOptimize.autoCompact': 'true'}
) }}

SELECT
    DATE_TRUNC('day', order_date) AS revenue_date,
    SUM(amount) AS total_revenue,
    COUNT(*) AS order_count
FROM {{ ref('stg_orders_clean') }}
{% if is_incremental() %}
WHERE order_date > (SELECT MAX(revenue_date) - INTERVAL 1 DAY FROM {{ this }})
{% endif %}
GROUP BY DATE_TRUNC('day', order_date)
```

Schedule dbt to run every 15 minutes via Databricks Jobs to match the original lag target.

### Option B: Databricks materialized views

For simple aggregations, Databricks materialized views (GA in Runtime 13+) are the closest equivalent:

```sql
-- Databricks materialized view
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_prod.marts.daily_revenue
AS
    SELECT
        DATE_TRUNC('day', order_date) AS revenue_date,
        SUM(amount) AS total_revenue,
        COUNT(*) AS order_count
    FROM analytics_prod.staging.orders_clean
    GROUP BY DATE_TRUNC('day', order_date);

-- Refresh manually or on schedule
REFRESH MATERIALIZED VIEW analytics_prod.marts.daily_revenue;
```

### Option C: Delta Live Tables (DLT) for streaming materialization

For dynamic tables that need near-real-time refresh:

```python
import dlt
from pyspark.sql.functions import date_trunc, sum as sum_, count

@dlt.table(
    name="daily_revenue",
    comment="Daily revenue aggregation, refreshed continuously"
)
def daily_revenue():
    return (
        dlt.read_stream("orders_clean")
        .groupBy(date_trunc("day", "order_date").alias("revenue_date"))
        .agg(
            sum_("amount").alias("total_revenue"),
            count("*").alias("order_count")
        )
    )
```

### Decision tree: Dynamic Table replacement

```
How critical is the freshness (lag target)?
├── > 1 hour → dbt incremental model (schedule hourly or less)
├── 5 min - 1 hour → dbt incremental (schedule at lag interval) or Databricks MV
├── < 5 min → Delta Live Tables (streaming)
└── Real-time → Delta Live Tables with structured streaming

How complex is the SQL?
├── Simple aggregation → Databricks materialized view
├── Multi-table join with incremental logic → dbt incremental model
└── Complex CDC + streaming → Delta Live Tables
```

---

## 5. Combined migration patterns

### Pattern: Stream + Task + Dynamic Table pipeline

This is the most common Snowflake orchestration pattern:

```
Snowflake:
  Stream on raw.orders → Task: INSERT INTO staging.orders_changes → Dynamic Table: marts.order_summary

Azure equivalent:
  Delta CDF on raw.orders → dbt incremental: stg_orders_changes → dbt incremental: order_summary
  (scheduled via Databricks Jobs every 15 minutes)
```

### Pattern: Multi-stream fan-in

```
Snowflake:
  Stream on raw.orders     ─┐
  Stream on raw.inventory  ─┤→ Task: merge_and_calculate → Dynamic Table: marts.supply_demand
  Stream on raw.shipments  ─┘

Azure equivalent:
  Delta CDF on raw.orders     ─┐
  Delta CDF on raw.inventory  ─┤→ dbt incremental: supply_demand (refs all three)
  Delta CDF on raw.shipments  ─┘
  (dbt handles the merge via ref() dependencies)
```

---

## 6. Migration execution checklist

- [ ] Inventory all Streams, Tasks, and Dynamic Tables
- [ ] Map each Stream to Delta CDF, DLT, or ADF CDC
- [ ] Map each Task to dbt model, Databricks Job, or ADF trigger
- [ ] Map each Dynamic Table to dbt incremental, Databricks MV, or DLT
- [ ] Enable `delta.enableChangeDataFeed` on all tracked tables
- [ ] Create dbt incremental models for each Dynamic Table
- [ ] Set up Databricks Jobs or ADF triggers for scheduling
- [ ] Implement checkpoint tracking for batch CDF consumers
- [ ] Test freshness: validate lag meets SLA
- [ ] Test correctness: reconcile output counts and aggregates
- [ ] Run parallel for 2+ weeks before cutover

---

## Related documents

- [Feature Mapping](feature-mapping-complete.md) -- Section 4 and 9 for transformation and orchestration features
- [Tutorial: dbt Migration](tutorial-dbt-snowflake-to-fabric.md) -- dbt-specific migration steps
- [Warehouse Migration](warehouse-migration.md) -- compute sizing for scheduled workloads
- [Master playbook](../snowflake.md) -- Section 2 for Streams/Tasks/Dynamic Tables mapping

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
