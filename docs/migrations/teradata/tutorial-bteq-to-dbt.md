# Tutorial — Convert BTEQ Script to dbt Model

> **Audience:** Data engineers converting Teradata BTEQ scripts to dbt models running on Databricks or Synapse. This step-by-step tutorial takes a real-world BTEQ script through the full conversion process: analysis, SQL translation, dbt project setup, testing, and deployment.

---

## Prerequisites

- dbt Core or dbt Cloud installed
- Databricks or Synapse workspace available
- Basic familiarity with BTEQ and SQL
- Python 3.9+ (for sqlglot)

---

## 1. The source BTEQ script

We will convert a typical Teradata BTEQ script that builds a daily revenue summary. This is representative of the thousands of BTEQ scripts found in enterprise Teradata environments.

**Original: `daily_revenue_summary.bteq`**

```sql
.LOGON tdserver/etl_user,${ETL_PASSWORD}

.SET WIDTH 200
.SET ERRORLEVEL SEVERITY 8

DATABASE production;

/*----------------------------------------------------------
  DAILY REVENUE SUMMARY
  Runs daily at 06:00 via cron
  Owner: finance-data-team@company.com
  Dependencies: orders, customers, products, regions
----------------------------------------------------------*/

/* Step 1: Drop and recreate volatile staging table */
DROP TABLE tmp_daily_orders;
CREATE VOLATILE TABLE tmp_daily_orders AS (
    SELECT
        o.order_id,
        o.customer_id,
        o.order_date,
        o.amount,
        o.discount,
        o.amount - o.discount AS net_amount,
        c.customer_name,
        c.customer_segment,
        p.product_category,
        r.region_name,
        r.territory
    FROM orders o
    INNER JOIN customers c ON o.customer_id = c.customer_id
    INNER JOIN products p ON o.product_id = p.product_id
    INNER JOIN regions r ON o.region_id = r.region_id
    WHERE o.order_date = CURRENT_DATE - 1
      AND o.status = 'COMPLETED'
) WITH DATA
PRIMARY INDEX (order_id)
ON COMMIT PRESERVE ROWS;

.IF ERRORCODE <> 0 THEN .GOTO ERROR_EXIT

/* Step 2: Collect statistics on staging table */
COLLECT STATISTICS ON tmp_daily_orders COLUMN (order_date);
COLLECT STATISTICS ON tmp_daily_orders COLUMN (customer_segment);
COLLECT STATISTICS ON tmp_daily_orders COLUMN (region_name);

/* Step 3: Delete existing data for the date (idempotent reload) */
DELETE FROM daily_revenue_summary
WHERE report_date = CURRENT_DATE - 1;

.IF ERRORCODE <> 0 THEN .GOTO ERROR_EXIT

/* Step 4: Insert aggregated results */
INSERT INTO daily_revenue_summary
SELECT
    CURRENT_DATE - 1 AS report_date,
    t.region_name,
    t.territory,
    t.customer_segment,
    t.product_category,
    COUNT(*) AS order_count,
    COUNT(DISTINCT t.customer_id) AS unique_customers,
    SUM(t.amount) AS gross_revenue,
    SUM(t.discount) AS total_discount,
    SUM(t.net_amount) AS net_revenue,
    AVG(t.net_amount) AS avg_order_value,
    CURRENT_TIMESTAMP AS loaded_at
FROM tmp_daily_orders t
GROUP BY 2, 3, 4, 5;

.IF ERRORCODE <> 0 THEN .GOTO ERROR_EXIT

/* Step 5: Update control table */
UPDATE etl_control
SET last_run = CURRENT_TIMESTAMP,
    row_count = (SELECT COUNT(*) FROM daily_revenue_summary WHERE report_date = CURRENT_DATE - 1),
    status = 'SUCCESS'
WHERE job_name = 'daily_revenue_summary';

/* Step 6: Export report to file for downstream systems */
.EXPORT FILE=daily_revenue_${DATE}.csv
SELECT * FROM daily_revenue_summary
WHERE report_date = CURRENT_DATE - 1
ORDER BY region_name, territory, customer_segment;
.EXPORT RESET

.LOGOFF
.QUIT 0

.LABEL ERROR_EXIT
.EXPORT FILE=daily_revenue_error_${DATE}.log
SELECT 'ERROR: daily_revenue_summary failed at ' || CAST(CURRENT_TIMESTAMP AS VARCHAR(30));
.EXPORT RESET

UPDATE etl_control
SET status = 'FAILED', last_run = CURRENT_TIMESTAMP
WHERE job_name = 'daily_revenue_summary';

.LOGOFF
.QUIT 8
```

---

## 2. Analyze the BTEQ script

Break the script into logical components:

| BTEQ component               | What it does           | dbt equivalent                         |
| ---------------------------- | ---------------------- | -------------------------------------- |
| `.LOGON` / `.LOGOFF`         | Connection management  | dbt profile (connection config)        |
| `DROP/CREATE VOLATILE TABLE` | Staging transformation | CTE or ephemeral model                 |
| `COLLECT STATISTICS`         | Optimizer hints        | Not needed (Delta auto-stats)          |
| `DELETE + INSERT`            | Idempotent reload      | dbt incremental model (merge strategy) |
| `.IF ERRORCODE`              | Error handling         | dbt built-in error handling            |
| `UPDATE etl_control`         | Job tracking           | dbt metadata (run results)             |
| `.EXPORT FILE`               | File export            | Separate pipeline (ADF or Spark write) |
| `GROUP BY 2, 3, 4, 5`        | Positional GROUP BY    | Named GROUP BY (dbt best practice)     |

### Key decisions

1. **Volatile table** → CTE (no need for a staging table in dbt)
2. **DELETE + INSERT** → `incremental` materialization with `merge` strategy
3. **Error handling** → dbt's built-in retry and failure handling
4. **File export** → Separate ADF pipeline (not part of dbt model)
5. **Control table** → dbt run results + Azure Monitor

---

## 3. Convert Teradata SQL to Spark SQL

### Step 3.1: Auto-translate with sqlglot

```python
import sqlglot

teradata_sql = """
SELECT
    CURRENT_DATE - 1 AS report_date,
    t.region_name,
    t.territory,
    t.customer_segment,
    t.product_category,
    COUNT(*) AS order_count,
    COUNT(DISTINCT t.customer_id) AS unique_customers,
    SUM(t.amount) AS gross_revenue,
    SUM(t.discount) AS total_discount,
    SUM(t.net_amount) AS net_revenue,
    AVG(t.net_amount) AS avg_order_value,
    CURRENT_TIMESTAMP AS loaded_at
FROM tmp_daily_orders t
GROUP BY 2, 3, 4, 5
"""

spark_sql = sqlglot.transpile(teradata_sql, read="teradata", write="spark")[0]
print(spark_sql)
```

### Step 3.2: Manual adjustments

| Teradata syntax          | Spark SQL equivalent                   | Notes                |
| ------------------------ | -------------------------------------- | -------------------- |
| `CURRENT_DATE - 1`       | `DATE_SUB(CURRENT_DATE(), 1)`          | Date arithmetic      |
| `CURRENT_TIMESTAMP`      | `CURRENT_TIMESTAMP()`                  | Function call syntax |
| `GROUP BY 2, 3, 4, 5`    | `GROUP BY region_name, territory, ...` | Use named columns    |
| `CAST(x AS VARCHAR(30))` | `CAST(x AS STRING)`                    | STRING in Spark      |

---

## 4. Set up dbt project

### Step 4.1: Initialize dbt project

```bash
# Create new dbt project (or add to existing)
dbt init teradata_migration

cd teradata_migration
```

### Step 4.2: Configure dbt profile

**`~/.dbt/profiles.yml`** (for Databricks):

```yaml
teradata_migration:
    target: dev
    outputs:
        dev:
            type: databricks
            catalog: main
            schema: silver
            host: "adb-1234567890.12.azuredatabricks.net"
            http_path: "/sql/1.0/warehouses/abc123def456"
            token: "{{ env_var('DBT_DATABRICKS_TOKEN') }}"
            threads: 4

        prod:
            type: databricks
            catalog: main
            schema: silver
            host: "adb-1234567890.12.azuredatabricks.net"
            http_path: "/sql/1.0/warehouses/prod-warehouse"
            token: "{{ env_var('DBT_DATABRICKS_TOKEN') }}"
            threads: 8
```

### Step 4.3: Create source definitions

**`models/staging/sources.yml`:**

```yaml
version: 2

sources:
    - name: teradata_raw
      description: "Tables migrated from Teradata production database"
      database: main
      schema: bronze
      tables:
          - name: orders
            description: "Customer orders (migrated from Teradata production.orders)"
            columns:
                - name: order_id
                  tests: [unique, not_null]
                - name: customer_id
                  tests: [not_null]
                - name: order_date
                  tests: [not_null]
                - name: amount
                  tests: [not_null]
                - name: status
                  tests: [not_null]

          - name: customers
            description: "Customer master (migrated from Teradata production.customers)"
            columns:
                - name: customer_id
                  tests: [unique, not_null]

          - name: products
            description: "Product catalog (migrated from Teradata production.products)"
            columns:
                - name: product_id
                  tests: [unique, not_null]

          - name: regions
            description: "Region lookup (migrated from Teradata production.regions)"
            columns:
                - name: region_id
                  tests: [unique, not_null]
```

---

## 5. Create dbt models

### Step 5.1: Staging model (replaces VOLATILE TABLE)

**`models/staging/stg_daily_orders.sql`:**

```sql
-- Replaces: CREATE VOLATILE TABLE tmp_daily_orders
-- Source: daily_revenue_summary.bteq (Step 1)

{{ config(materialized='ephemeral') }}

SELECT
    o.order_id,
    o.customer_id,
    o.order_date,
    o.amount,
    o.discount,
    o.amount - o.discount AS net_amount,
    c.customer_name,
    c.customer_segment,
    p.product_category,
    r.region_name,
    r.territory
FROM {{ source('teradata_raw', 'orders') }} o
INNER JOIN {{ source('teradata_raw', 'customers') }} c
    ON o.customer_id = c.customer_id
INNER JOIN {{ source('teradata_raw', 'products') }} p
    ON o.product_id = p.product_id
INNER JOIN {{ source('teradata_raw', 'regions') }} r
    ON o.region_id = r.region_id
WHERE o.status = 'COMPLETED'
{% if is_incremental() %}
    AND o.order_date >= DATE_SUB(CURRENT_DATE(), 3)
{% endif %}
```

### Step 5.2: Mart model (replaces INSERT INTO daily_revenue_summary)

**`models/marts/finance/daily_revenue_summary.sql`:**

```sql
-- Replaces: daily_revenue_summary.bteq (Steps 3-4)
-- Original: DELETE FROM daily_revenue_summary WHERE report_date = CURRENT_DATE - 1;
--           INSERT INTO daily_revenue_summary SELECT ...
-- Converted to: dbt incremental model with merge strategy

{{ config(
    materialized='incremental',
    unique_key=['report_date', 'region_name', 'territory', 'customer_segment', 'product_category'],
    incremental_strategy='merge',
    file_format='delta',
    partition_by=['report_date'],
    post_hook=[
        "OPTIMIZE {{ this }} ZORDER BY (region_name, customer_segment)"
    ]
) }}

WITH daily_orders AS (
    SELECT * FROM {{ ref('stg_daily_orders') }}
)

SELECT
    order_date AS report_date,
    region_name,
    territory,
    customer_segment,
    product_category,
    COUNT(*) AS order_count,
    COUNT(DISTINCT customer_id) AS unique_customers,
    SUM(amount) AS gross_revenue,
    SUM(discount) AS total_discount,
    SUM(net_amount) AS net_revenue,
    AVG(net_amount) AS avg_order_value,
    CURRENT_TIMESTAMP() AS loaded_at
FROM daily_orders
GROUP BY
    order_date,
    region_name,
    territory,
    customer_segment,
    product_category
```

---

## 6. Add dbt tests

### Step 6.1: Schema tests

**`models/marts/finance/schema.yml`:**

```yaml
version: 2

models:
    - name: daily_revenue_summary
      description: |
          Daily revenue summary aggregated by region, territory, customer segment,
          and product category. Migrated from Teradata BTEQ script
          daily_revenue_summary.bteq.
      columns:
          - name: report_date
            description: "The date of the orders being summarized"
            tests:
                - not_null
                - dbt_expectations.expect_column_values_to_be_of_type:
                      column_type: date

          - name: region_name
            tests: [not_null]

          - name: territory
            tests: [not_null]

          - name: customer_segment
            tests: [not_null]

          - name: order_count
            tests:
                - not_null
                - dbt_expectations.expect_column_values_to_be_between:
                      min_value: 1

          - name: gross_revenue
            tests:
                - not_null
                - dbt_expectations.expect_column_values_to_be_between:
                      min_value: 0

          - name: net_revenue
            tests:
                - not_null
                - dbt_expectations.expect_column_values_to_be_between:
                      min_value: 0

          - name: total_discount
            tests:
                - dbt_expectations.expect_column_values_to_be_between:
                      min_value: 0

      tests:
          - dbt_utils.unique_combination_of_columns:
                combination_of_columns:
                    - report_date
                    - region_name
                    - territory
                    - customer_segment
                    - product_category
```

### Step 6.2: Custom data test (golden query validation)

**`tests/validate_daily_revenue_totals.sql`:**

```sql
-- Validate that daily revenue totals are within expected bounds
-- This replaces manual reconciliation against Teradata output

WITH daily_totals AS (
    SELECT
        report_date,
        SUM(gross_revenue) AS total_gross,
        SUM(net_revenue) AS total_net,
        SUM(order_count) AS total_orders
    FROM {{ ref('daily_revenue_summary') }}
    WHERE report_date >= DATE_SUB(CURRENT_DATE(), 7)
    GROUP BY report_date
)

SELECT *
FROM daily_totals
WHERE total_gross <= 0                    -- No revenue = problem
   OR total_net > total_gross             -- Net > gross = logic error
   OR total_orders < 100                  -- Suspiciously low order count
   OR total_gross > 100000000             -- Suspiciously high ($100M/day)
```

### Step 6.3: Cross-platform reconciliation test

**`tests/reconcile_with_teradata.sql`:**

```sql
-- During parallel-run period: compare dbt output with Teradata output
-- Remove this test after Teradata decommission

{% if var('parallel_run', false) %}

WITH teradata_totals AS (
    SELECT report_date, SUM(net_revenue) AS td_net
    FROM {{ source('teradata_raw', 'daily_revenue_summary_td') }}
    WHERE report_date = DATE_SUB(CURRENT_DATE(), 1)
    GROUP BY report_date
),
azure_totals AS (
    SELECT report_date, SUM(net_revenue) AS az_net
    FROM {{ ref('daily_revenue_summary') }}
    WHERE report_date = DATE_SUB(CURRENT_DATE(), 1)
    GROUP BY report_date
)

SELECT
    t.report_date,
    t.td_net,
    a.az_net,
    ABS(t.td_net - a.az_net) AS diff
FROM teradata_totals t
JOIN azure_totals a ON t.report_date = a.report_date
WHERE ABS(t.td_net - a.az_net) > 0.01  -- Allow 1 cent rounding

{% else %}
-- Parallel run disabled; skip reconciliation
SELECT 1 WHERE FALSE
{% endif %}
```

---

## 7. Run and validate

### Step 7.1: Compile and check SQL

```bash
# Compile to see generated SQL (without executing)
dbt compile --select daily_revenue_summary

# Review the compiled SQL
cat target/compiled/teradata_migration/models/marts/finance/daily_revenue_summary.sql
```

### Step 7.2: Run the model

```bash
# Run in dev environment
dbt run --select stg_daily_orders daily_revenue_summary

# Expected output:
# 07:00:01  Running with dbt=1.7.0
# 07:00:01  Found 2 models, 12 tests, 4 sources
# 07:00:02  Concurrency: 4 threads
# 07:00:02  1 of 2 START sql ephemeral model silver.stg_daily_orders ......... [RUN]
# 07:00:02  2 of 2 START sql incremental model silver.daily_revenue_summary .. [RUN]
# 07:00:15  2 of 2 OK created sql incremental model silver.daily_revenue_summary [MERGE 847 rows in 13.2s]
```

### Step 7.3: Run tests

```bash
# Run all tests for the model
dbt test --select daily_revenue_summary

# Expected output:
# 07:01:00  Running with dbt=1.7.0
# 07:01:00  Found 12 tests
# 07:01:02  1 of 12 PASS unique_daily_revenue_summary_composite ......... [PASS in 1.2s]
# 07:01:03  2 of 12 PASS not_null_daily_revenue_summary_report_date ..... [PASS in 0.8s]
# ...
# 07:01:10  12 of 12 PASS validate_daily_revenue_totals ................. [PASS in 2.1s]
```

### Step 7.4: Generate documentation

```bash
dbt docs generate
dbt docs serve
# Opens browser with auto-generated documentation including DAG visualization
```

---

## 8. Deploy to production

### Step 8.1: dbt Cloud deployment (recommended)

```yaml
# dbt Cloud job configuration
name: "Daily Revenue Summary"
schedule:
    cron: "0 6 * * *" # 06:00 daily (matching original BTEQ cron)
environment: production
commands:
    - "dbt run --select stg_daily_orders daily_revenue_summary"
    - "dbt test --select daily_revenue_summary"
notifications:
    email:
        - finance-data-team@company.com
    on_failure: true
    on_success: false
```

### Step 8.2: Databricks Jobs deployment (alternative)

```python
# Databricks job definition
{
    "name": "dbt-daily-revenue-summary",
    "tasks": [
        {
            "task_key": "dbt_run",
            "dbt_task": {
                "commands": [
                    "dbt run --select stg_daily_orders daily_revenue_summary",
                    "dbt test --select daily_revenue_summary"
                ],
                "project_directory": "/Repos/data-team/teradata-migration",
                "warehouse_id": "production-tier2"
            }
        }
    ],
    "schedule": {
        "quartz_cron_expression": "0 0 6 * * ?",
        "timezone_id": "America/New_York"
    },
    "email_notifications": {
        "on_failure": ["finance-data-team@company.com"]
    }
}
```

### Step 8.3: Replace the file export

The original BTEQ script exported results to a CSV file. Replace with ADF or Spark:

```python
# Databricks notebook: export daily revenue to CSV for downstream systems
from pyspark.sql import SparkSession
from datetime import date, timedelta

spark = SparkSession.builder.getOrCreate()

yesterday = date.today() - timedelta(days=1)

df = spark.sql(f"""
    SELECT * FROM silver.daily_revenue_summary
    WHERE report_date = '{yesterday}'
    ORDER BY region_name, territory, customer_segment
""")

# Write to ADLS for downstream consumption
df.coalesce(1).write.csv(
    f"abfss://exports@datalake.dfs.core.windows.net/daily_revenue/{yesterday}/",
    header=True,
    mode="overwrite"
)
```

---

## 9. Conversion checklist

| BTEQ component             | Status    | dbt equivalent                        |
| -------------------------- | --------- | ------------------------------------- |
| `.LOGON` / `.LOGOFF`       | Replaced  | dbt profile                           |
| `CREATE VOLATILE TABLE`    | Replaced  | `stg_daily_orders` (ephemeral model)  |
| `COLLECT STATISTICS`       | Removed   | Delta auto-stats + OPTIMIZE post-hook |
| `DELETE + INSERT`          | Replaced  | Incremental model (merge strategy)    |
| `.IF ERRORCODE`            | Replaced  | dbt built-in error handling           |
| `INSERT INTO ... GROUP BY` | Replaced  | `daily_revenue_summary` model         |
| `UPDATE etl_control`       | Replaced  | dbt run results + monitoring          |
| `.EXPORT FILE`             | Replaced  | Separate Spark/ADF export job         |
| Date arithmetic            | Converted | `DATE_SUB(CURRENT_DATE(), 1)`         |
| Positional GROUP BY        | Converted | Named column GROUP BY                 |

---

## 10. Related resources

- [SQL Migration](sql-migration.md) — Complete SQL conversion reference
- [Tutorial — TPT to ADF](tutorial-tpt-to-adf.md) — Data loading pipeline conversion
- [Feature Mapping](feature-mapping-complete.md) — BTEQ feature mapping
- [Best Practices](best-practices.md) — dbt project organization
- dbt documentation: <https://docs.getdbt.com>
- dbt-databricks adapter: <https://github.com/databricks/dbt-databricks>
- sqlglot: <https://github.com/tobymao/sqlglot>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
