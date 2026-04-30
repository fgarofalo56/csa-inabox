# Tutorial: Convert Hive SQL to dbt Models on Databricks

**A step-by-step tutorial that walks through converting Hive SQL workloads to dbt models running on Databricks, including metastore migration, model creation, testing, and orchestration.**

---

## Prerequisites

Before starting this tutorial, you need:

- [ ] HDFS data already migrated to ADLS Gen2 (see [Tutorial: HDFS to ADLS](tutorial-hdfs-to-adls.md))
- [ ] A Databricks workspace with Unity Catalog enabled
- [ ] Python 3.9+ installed on your development machine
- [ ] dbt-core and dbt-databricks installed (`pip install dbt-databricks`)
- [ ] Access to Hive metastore (to export DDL) or Hive DDL export files
- [ ] Git installed for version control

### What you will build

By the end of this tutorial, you will have:

1. A dbt project configured for Databricks
2. Hive table DDL converted to dbt source definitions
3. Hive SQL scripts converted to dbt models (staging, silver, gold)
4. Schema tests validating data quality
5. dbt documentation generated from your models
6. A working dbt build pipeline on Databricks

### Estimated time

| Step | Duration |
|---|---|
| Step 1: Set up dbt project | 20 minutes |
| Step 2: Export and convert Hive DDL | 30 minutes |
| Step 3: Create dbt source definitions | 20 minutes |
| Step 4: Convert Hive scripts to dbt models | 60 minutes |
| Step 5: Add schema tests | 30 minutes |
| Step 6: Run dbt build and fix issues | 30 minutes |
| Step 7: Generate documentation | 10 minutes |
| Step 8: Set up orchestration | 20 minutes |
| **Total** | **~3.5 hours** |

---

## Step 1: Set up dbt project

### 1.1 Install dbt-databricks

```bash
# Create a virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dbt with Databricks adapter
pip install dbt-databricks==1.8.0
```

### 1.2 Initialize dbt project

```bash
dbt init hadoop_migration

# When prompted:
# - Which database: databricks
# - host: adb-XXXX.azuredatabricks.net
# - http_path: /sql/1.0/warehouses/XXXX
# - token: dapi_XXXX (Databricks personal access token)
# - catalog: migration
# - schema: silver
# - threads: 4
```

### 1.3 Verify project structure

```
hadoop_migration/
├── dbt_project.yml
├── profiles.yml          # Connection configuration
├── models/
│   ├── staging/          # Raw data cleaning (we will create)
│   ├── silver/           # Business logic (we will create)
│   └── gold/             # Aggregates (we will create)
├── tests/                # Custom data tests
├── macros/               # Reusable SQL macros
└── seeds/                # Static reference data
```

### 1.4 Configure dbt_project.yml

```yaml
# dbt_project.yml
name: 'hadoop_migration'
version: '1.0.0'
config-version: 2

profile: 'hadoop_migration'

model-paths: ["models"]
analysis-paths: ["analyses"]
test-paths: ["tests"]
seed-paths: ["seeds"]
macro-paths: ["macros"]

target-path: "target"
clean-targets:
  - "target"
  - "dbt_packages"

models:
  hadoop_migration:
    staging:
      +materialized: view
      +schema: staging
    silver:
      +materialized: table
      +schema: silver
      +file_format: delta
    gold:
      +materialized: table
      +schema: gold
      +file_format: delta
```

### 1.5 Configure profiles.yml

```yaml
# ~/.dbt/profiles.yml
hadoop_migration:
  target: dev
  outputs:
    dev:
      type: databricks
      catalog: migration
      schema: silver
      host: adb-XXXXXXXXXXXX.azuredatabricks.net
      http_path: /sql/1.0/warehouses/XXXXXXXXXXXX
      token: "{{ env_var('DBT_DATABRICKS_TOKEN') }}"
      threads: 4

    prod:
      type: databricks
      catalog: production
      schema: silver
      host: adb-XXXXXXXXXXXX.azuredatabricks.net
      http_path: /sql/1.0/warehouses/XXXXXXXXXXXX
      token: "{{ env_var('DBT_DATABRICKS_TOKEN') }}"
      threads: 8
```

### 1.6 Test connection

```bash
cd hadoop_migration
dbt debug
# Should show: "All checks passed!"
```

---

## Step 2: Export and convert Hive DDL

### 2.1 Export Hive table definitions

On your Hadoop cluster, export all DDL:

```bash
# Export DDL for all tables in the analytics database
hive -e "USE analytics; SHOW TABLES;" 2>/dev/null | while read table; do
    echo "-- Table: analytics.${table}"
    hive -e "USE analytics; SHOW CREATE TABLE ${table};" 2>/dev/null
    echo ";"
    echo ""
done > hive_ddl_export.sql
```

### 2.2 Examine the exported DDL

A typical Hive DDL looks like:

```sql
-- Table: analytics.orders
CREATE EXTERNAL TABLE `analytics`.`orders`(
  `order_id` bigint,
  `customer_id` bigint,
  `product_id` bigint,
  `amount` decimal(10,2),
  `quantity` int,
  `status` string,
  `created_at` timestamp,
  `updated_at` timestamp)
PARTITIONED BY (
  `order_date` date)
ROW FORMAT SERDE
  'org.apache.hadoop.hive.ql.io.orc.OrcSerde'
STORED AS INPUTFORMAT
  'org.apache.hadoop.hive.ql.io.orc.OrcInputFormat'
OUTPUTFORMAT
  'org.apache.hadoop.hive.ql.io.orc.OrcOutputFormat'
LOCATION
  'hdfs://namenode:8020/user/hive/warehouse/analytics.db/orders'
TBLPROPERTIES (
  'orc.compress'='SNAPPY');
```

### 2.3 Identify tables to migrate

Create a migration inventory:

```bash
# Create a simple inventory CSV
echo "database,table,format,partitioned_by,estimated_rows,priority" > migration_inventory.csv
# Fill in from your Hive metastore
echo "analytics,orders,ORC,order_date,50000000,high" >> migration_inventory.csv
echo "analytics,customers,ORC,none,2000000,high" >> migration_inventory.csv
echo "analytics,products,Parquet,none,50000,medium" >> migration_inventory.csv
echo "analytics,order_items,ORC,order_date,200000000,high" >> migration_inventory.csv
echo "analytics,daily_revenue,ORC,report_date,3650,high" >> migration_inventory.csv
```

---

## Step 3: Create dbt source definitions

### 3.1 Define sources (migrated Delta tables)

The tables migrated from HDFS to ADLS Gen2 and converted to Delta (from the previous tutorial) become dbt "sources" — external tables that dbt reads but does not manage.

```yaml
# models/staging/sources.yml
version: 2

sources:
  - name: raw_hadoop
    description: "Tables migrated from Hadoop HDFS, converted to Delta Lake on ADLS Gen2"
    database: migration      # Unity Catalog catalog
    schema: raw              # Unity Catalog schema where raw Delta tables are registered
    tables:
      - name: orders
        description: "Customer orders migrated from Hive analytics.orders"
        columns:
          - name: order_id
            description: "Unique order identifier"
            tests:
              - unique
              - not_null
          - name: customer_id
            description: "FK to customers table"
            tests:
              - not_null
          - name: amount
            description: "Order total amount"
          - name: order_date
            description: "Date the order was placed (partition column)"
        loaded_at_field: updated_at
        freshness:
          warn_after: {count: 24, period: hour}
          error_after: {count: 48, period: hour}

      - name: customers
        description: "Customer master data migrated from Hive analytics.customers"
        columns:
          - name: customer_id
            description: "Unique customer identifier"
            tests:
              - unique
              - not_null
          - name: name
            description: "Customer full name"
          - name: email
            description: "Customer email address"
          - name: segment
            description: "Customer segment (enterprise, mid-market, smb)"

      - name: products
        description: "Product catalog migrated from Hive analytics.products"
        columns:
          - name: product_id
            tests:
              - unique
              - not_null
          - name: name
            description: "Product name"
          - name: category
            description: "Product category"
          - name: price
            description: "Unit price"

      - name: order_items
        description: "Order line items migrated from Hive analytics.order_items"
        columns:
          - name: order_id
            tests:
              - not_null
          - name: product_id
            tests:
              - not_null
          - name: quantity
            tests:
              - not_null
          - name: unit_price
            description: "Price at time of order"
```

---

## Step 4: Convert Hive scripts to dbt models

### 4.1 Staging models (light cleansing)

```sql
-- models/staging/stg_orders.sql
-- Converted from: Hive analytics.orders (cleaning step)
-- Original Hive: SELECT * FROM analytics.orders WHERE status != 'cancelled'

WITH source AS (
    SELECT * FROM {{ source('raw_hadoop', 'orders') }}
),

cleaned AS (
    SELECT
        order_id,
        customer_id,
        product_id,
        CAST(amount AS DECIMAL(10,2)) AS amount,
        quantity,
        LOWER(TRIM(status)) AS status,
        created_at,
        updated_at,
        order_date
    FROM source
    WHERE status IS NOT NULL
      AND status != 'cancelled'
      AND order_id IS NOT NULL
)

SELECT * FROM cleaned
```

```sql
-- models/staging/stg_customers.sql
-- Converted from: Hive analytics.customers

WITH source AS (
    SELECT * FROM {{ source('raw_hadoop', 'customers') }}
),

cleaned AS (
    SELECT
        customer_id,
        TRIM(name) AS name,
        LOWER(TRIM(email)) AS email,
        LOWER(TRIM(segment)) AS segment,
        created_at,
        updated_at
    FROM source
    WHERE customer_id IS NOT NULL
)

SELECT * FROM cleaned
```

```sql
-- models/staging/stg_products.sql
WITH source AS (
    SELECT * FROM {{ source('raw_hadoop', 'products') }}
),

cleaned AS (
    SELECT
        product_id,
        TRIM(name) AS product_name,
        LOWER(TRIM(category)) AS category,
        CAST(price AS DECIMAL(10,2)) AS price,
        is_active
    FROM source
    WHERE product_id IS NOT NULL
)

SELECT * FROM cleaned
```

### 4.2 Silver models (business logic)

```sql
-- models/silver/orders_enriched.sql
-- Converted from Hive script: enrich_orders.hql
-- Original Hive:
--   INSERT OVERWRITE TABLE analytics.orders_enriched PARTITION (order_date)
--   SELECT o.*, c.name, c.segment, p.category
--   FROM analytics.orders o
--   JOIN analytics.customers c ON o.customer_id = c.customer_id
--   JOIN analytics.products p ON o.product_id = p.product_id;

{{ config(
    materialized='incremental',
    unique_key='order_id',
    partition_by=['order_date'],
    file_format='delta',
    incremental_strategy='merge'
) }}

SELECT
    o.order_id,
    o.customer_id,
    o.product_id,
    o.amount,
    o.quantity,
    o.status,
    o.created_at,
    o.updated_at,
    o.order_date,
    c.name AS customer_name,
    c.segment AS customer_segment,
    p.product_name,
    p.category AS product_category,
    p.price AS unit_price,
    o.amount / NULLIF(o.quantity, 0) AS effective_unit_price
FROM {{ ref('stg_orders') }} o
LEFT JOIN {{ ref('stg_customers') }} c
    ON o.customer_id = c.customer_id
LEFT JOIN {{ ref('stg_products') }} p
    ON o.product_id = p.product_id

{% if is_incremental() %}
WHERE o.updated_at > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
```

### 4.3 Gold models (aggregates)

```sql
-- models/gold/daily_revenue.sql
-- Converted from Hive script: daily_revenue_report.hql
-- Original Hive:
--   SET hive.exec.parallel=true;
--   INSERT OVERWRITE TABLE analytics.daily_revenue PARTITION (report_date)
--   SELECT SUM(amount), COUNT(*), COUNT(DISTINCT customer_id), ...
--   FROM analytics.orders WHERE order_date = '${hiveconf:report_date}'
--   GROUP BY ...;

{{ config(
    materialized='incremental',
    unique_key='report_date',
    file_format='delta'
) }}

SELECT
    order_date AS report_date,
    COUNT(*) AS total_orders,
    COUNT(DISTINCT customer_id) AS unique_customers,
    SUM(amount) AS total_revenue,
    AVG(amount) AS avg_order_value,
    SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) AS completed_revenue,
    SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) AS refunded_amount,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_orders,
    COUNT(CASE WHEN status = 'refunded' THEN 1 END) AS refunded_orders
FROM {{ ref('orders_enriched') }}

{% if is_incremental() %}
WHERE order_date > (SELECT MAX(report_date) FROM {{ this }})
{% endif %}

GROUP BY order_date
```

```sql
-- models/gold/customer_360.sql
-- Converted from Hive script: customer_360.hql
-- This was a full-table CTAS in Hive; now an incremental dbt model

{{ config(
    materialized='table',
    file_format='delta'
) }}

WITH order_stats AS (
    SELECT
        customer_id,
        COUNT(*) AS lifetime_orders,
        SUM(amount) AS lifetime_revenue,
        AVG(amount) AS avg_order_value,
        MIN(order_date) AS first_order_date,
        MAX(order_date) AS last_order_date,
        DATEDIFF(CURRENT_DATE(), MAX(order_date)) AS days_since_last_order
    FROM {{ ref('orders_enriched') }}
    WHERE status = 'completed'
    GROUP BY customer_id
),

segment_assignment AS (
    SELECT
        *,
        CASE
            WHEN lifetime_revenue > 10000 AND lifetime_orders > 20 THEN 'champion'
            WHEN lifetime_revenue > 5000 THEN 'loyal'
            WHEN days_since_last_order < 30 THEN 'active'
            WHEN days_since_last_order < 90 THEN 'at_risk'
            ELSE 'churned'
        END AS rfm_segment
    FROM order_stats
)

SELECT
    c.customer_id,
    c.name,
    c.email,
    c.segment AS business_segment,
    s.rfm_segment,
    s.lifetime_orders,
    s.lifetime_revenue,
    s.avg_order_value,
    s.first_order_date,
    s.last_order_date,
    s.days_since_last_order,
    CURRENT_TIMESTAMP() AS calculated_at
FROM {{ ref('stg_customers') }} c
LEFT JOIN segment_assignment s
    ON c.customer_id = s.customer_id
```

---

## Step 5: Add schema tests

### 5.1 Silver model tests

```yaml
# models/silver/schema.yml
version: 2

models:
  - name: orders_enriched
    description: "Orders enriched with customer and product details"
    columns:
      - name: order_id
        description: "Unique order identifier"
        tests:
          - unique
          - not_null
      - name: customer_id
        tests:
          - not_null
          - relationships:
              to: ref('stg_customers')
              field: customer_id
      - name: amount
        tests:
          - not_null
      - name: status
        tests:
          - not_null
          - accepted_values:
              values: ['pending', 'processing', 'completed', 'refunded', 'shipped']
      - name: customer_segment
        tests:
          - accepted_values:
              values: ['enterprise', 'mid-market', 'smb']
              config:
                where: "customer_segment IS NOT NULL"
```

### 5.2 Gold model tests

```yaml
# models/gold/schema.yml
version: 2

models:
  - name: daily_revenue
    description: "Daily revenue aggregates"
    columns:
      - name: report_date
        tests:
          - unique
          - not_null
      - name: total_orders
        tests:
          - not_null
      - name: total_revenue
        tests:
          - not_null

  - name: customer_360
    description: "Customer 360-degree view with RFM segmentation"
    columns:
      - name: customer_id
        tests:
          - unique
          - not_null
      - name: rfm_segment
        tests:
          - accepted_values:
              values: ['champion', 'loyal', 'active', 'at_risk', 'churned']
              config:
                where: "rfm_segment IS NOT NULL"
```

---

## Step 6: Run dbt build and fix issues

### 6.1 Compile and check SQL

```bash
# Compile models to SQL without running (catches syntax errors)
dbt compile
```

### 6.2 Run staging models first

```bash
# Run staging models only
dbt run --select staging
```

### 6.3 Run all models

```bash
# Run full build (models + tests)
dbt build
```

### 6.4 Common errors and fixes

| Error | Cause | Fix |
|---|---|---|
| `PARSE_SYNTAX_ERROR` | HiveQL syntax not compatible with SparkSQL | Fix SQL syntax (see [Hive Migration](hive-migration.md)) |
| `TABLE_OR_VIEW_NOT_FOUND` | Source table not registered in Unity Catalog | Run `CREATE TABLE ... LOCATION` for the source |
| `SCHEMA_NOT_FOUND` | Target schema does not exist | Run `CREATE SCHEMA IF NOT EXISTS migration.silver` |
| `DELTA_TABLE_NOT_FOUND` | Incremental model referencing non-existent target | Run with `--full-refresh` for first build |
| `Permission denied` | Databricks token lacks access | Check Unity Catalog grants |

### 6.5 Run with full refresh (first time)

```bash
# First run must be full-refresh for incremental models
dbt build --full-refresh
```

### 6.6 Run tests independently

```bash
# Run all tests
dbt test

# Run tests for specific model
dbt test --select orders_enriched
```

---

## Step 7: Generate documentation

### 7.1 Generate docs

```bash
dbt docs generate
```

### 7.2 View documentation locally

```bash
dbt docs serve --port 8080
# Open browser to http://localhost:8080
```

The generated documentation includes:

- Model descriptions from YAML
- Column-level documentation
- Source freshness status
- Test results
- DAG visualization (model lineage)

This replaces the manual documentation that was typically maintained alongside Hive scripts.

---

## Step 8: Set up orchestration

### 8.1 Option A: ADF + dbt (recommended)

Create an ADF pipeline that triggers dbt builds:

```json
{
    "name": "daily-dbt-build",
    "activities": [
        {
            "name": "dbt-build",
            "type": "DatabricksNotebook",
            "typeProperties": {
                "notebookPath": "/orchestration/run_dbt",
                "baseParameters": {
                    "dbt_command": "dbt build --select silver gold",
                    "full_refresh": "false"
                }
            }
        }
    ],
    "triggers": [{
        "name": "daily-2am",
        "type": "ScheduleTrigger",
        "recurrence": {
            "frequency": "Day",
            "interval": 1,
            "startTime": "02:00:00"
        }
    }]
}
```

### 8.2 Option B: Databricks Workflows

```python
# Databricks notebook: /orchestration/run_dbt
import subprocess

dbt_command = dbutils.widgets.get("dbt_command")
full_refresh = dbutils.widgets.get("full_refresh")

cmd = f"cd /Workspace/Repos/hadoop_migration && {dbt_command}"
if full_refresh == "true":
    cmd += " --full-refresh"

result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
print(result.stdout)
if result.returncode != 0:
    print(result.stderr)
    raise Exception(f"dbt command failed with return code {result.returncode}")
```

---

## Comparison: before and after

| Aspect | Hive scripts | dbt on Databricks |
|---|---|---|
| Code location | HDFS or edge node filesystem | Git repository |
| Dependency management | Manual script ordering in Oozie | Automatic via `ref()` and DAG |
| Testing | None or custom scripts | Built-in schema tests, custom tests |
| Documentation | External wiki (often outdated) | Auto-generated from YAML |
| Lineage | Atlas (if configured) | Built-in DAG + Purview integration |
| Incremental loads | Custom HiveQL logic per script | `is_incremental()` macro |
| Environment management | Different Hive configs per cluster | `profiles.yml` (dev/staging/prod) |
| Execution engine | Tez or MapReduce | Photon (2-8x faster) |

---

## Next steps

1. **Migrate remaining Hive scripts:** Use the patterns above for each script
2. **Add source freshness checks:** Configure `loaded_at_field` for critical sources
3. **Implement CI/CD:** Add dbt to your CI/CD pipeline (GitHub Actions, Azure DevOps)
4. **Set up alerts:** Configure ADF or Databricks alerts for failed dbt runs
5. **Decommission Hive:** After parallel-run validation, shut down HiveServer2

---

## Related

- [Hive Migration Guide](hive-migration.md) — detailed HiveQL to SparkSQL reference
- [Tutorial: HDFS to ADLS](tutorial-hdfs-to-adls.md) — prerequisite tutorial
- [Best Practices](best-practices.md) — operational best practices
- [Migration Hub](index.md) — full migration center

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Hive Migration](hive-migration.md) | [Tutorial: HDFS to ADLS](tutorial-hdfs-to-adls.md) | [Migration Hub](index.md)
