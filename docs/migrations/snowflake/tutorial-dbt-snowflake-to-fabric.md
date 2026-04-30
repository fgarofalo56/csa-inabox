# Tutorial: Migrate a dbt-Snowflake Project to dbt-Databricks or dbt-Fabric

**Status:** Authored 2026-04-30
**Audience:** dbt developers and data engineers with existing dbt-snowflake projects
**Prerequisites:** Working dbt project on Snowflake, Databricks workspace with Unity Catalog (or Fabric Lakehouse), Git access to dbt project

---

## What you will build

By the end of this tutorial, you will have:

1. Converted a `dbt-snowflake` project to `dbt-databricks` (or `dbt-fabric`)
2. Fixed all SQL dialect differences
3. Translated Snowflake-specific materializations to Delta Lake equivalents
4. Validated data parity between Snowflake and Databricks
5. Set up CI/CD for the migrated project

---

## Step 1: Assess your dbt project

Before touching code, understand the scope of the migration.

### 1.1 Count models by materialization

```bash
# In your dbt project directory
grep -r "materialized=" models/ | sort | uniq -c | sort -rn
```

Typical output:

```
  45 materialized='view'
  32 materialized='table'
  18 materialized='incremental'
   5 materialized='ephemeral'
```

### 1.2 Identify Snowflake-specific SQL

```bash
# Find Snowflake-specific function calls
grep -rn "IFF\|DATEADD\|DATEDIFF.*day\|TRY_TO_\|ARRAY_AGG\|OBJECT_CONSTRUCT\|VARIANT\|::" models/ --include="*.sql"

# Find Snowflake-specific materializations
grep -rn "dynamic_table\|secure_view" models/ --include="*.sql"

# Find Snowflake-specific macros
grep -rn "snowflake__\|target.type.*snowflake" macros/ --include="*.sql"
```

### 1.3 Document sources

```bash
# List all sources
grep -rn "source(" models/ --include="*.sql" | sort -u
```

---

## Step 2: Swap the dbt adapter

### 2.1 Update requirements

```txt
# requirements.txt (before)
dbt-snowflake==1.7.0

# requirements.txt (after -- choose one)
dbt-databricks==1.7.0
# OR
dbt-fabric==1.7.0
```

```bash
pip install dbt-databricks
# OR
pip install dbt-fabric
```

### 2.2 Update profiles.yml

**Snowflake profile (before):**

```yaml
my_project:
  outputs:
    prod:
      type: snowflake
      account: ACMEGOV.us-gov-west-1.snowflake-gov
      user: DBT_SVC
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
      role: DATA_ENGINEER
      database: ANALYTICS_DB
      warehouse: TRANSFORM_WH
      schema: MARTS
      threads: 8
    dev:
      type: snowflake
      account: ACMEGOV.us-gov-west-1.snowflake-gov
      user: "{{ env_var('SNOWFLAKE_USER') }}"
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
      role: DATA_ENGINEER
      database: ANALYTICS_DEV
      warehouse: DEV_WH
      schema: "dev_{{ env_var('USER') }}"
      threads: 4
  target: dev
```

**Databricks profile (after):**

```yaml
my_project:
  outputs:
    prod:
      type: databricks
      host: adb-acmegov-analytics.12.databricks.azure.us
      http_path: /sql/1.0/warehouses/abc123def456
      catalog: analytics_prod
      schema: marts
      token: "{{ env_var('DATABRICKS_TOKEN') }}"
      threads: 8
    dev:
      type: databricks
      host: adb-acmegov-analytics.12.databricks.azure.us
      http_path: /sql/1.0/warehouses/dev789ghi012
      catalog: analytics_dev
      schema: "dev_{{ env_var('USER') }}"
      token: "{{ env_var('DATABRICKS_TOKEN') }}"
      threads: 4
  target: dev
```

**Fabric profile (alternative):**

```yaml
my_project:
  outputs:
    prod:
      type: fabric
      driver: "ODBC Driver 18 for SQL Server"
      server: "acmegov-analytics.datawarehouse.fabric.microsoft.com"
      database: "analytics_lakehouse"
      schema: marts
      authentication: ServicePrincipal
      tenant_id: "{{ env_var('AZURE_TENANT_ID') }}"
      client_id: "{{ env_var('AZURE_CLIENT_ID') }}"
      client_secret: "{{ env_var('AZURE_CLIENT_SECRET') }}"
      threads: 8
  target: prod
```

### 2.3 Update dbt_project.yml

```yaml
# dbt_project.yml changes

# Remove Snowflake-specific configs
# Before:
# models:
#   my_project:
#     +transient: true  # Snowflake-specific

# After (Databricks):
models:
  my_project:
    staging:
      +materialized: view
    marts:
      +materialized: incremental
      +incremental_strategy: merge
      +file_format: delta
```

---

## Step 3: Fix SQL dialect differences

### 3.1 Automated fixes (safe to batch)

Create a migration script for common changes:

```bash
#!/bin/bash
# migrate-sql-dialect.sh
# Run from dbt project root

echo "Migrating SQL dialect from Snowflake to Databricks..."

# IFF() -> IF()
find models/ -name "*.sql" -exec sed -i 's/\bIFF(/IF(/g' {} +

# DATEADD(unit, amount, date) -> DATE_ADD(date, amount) for day unit
# NOTE: This handles the simple case. Complex DATEADD with non-day units needs manual review.
echo "WARNING: DATEADD conversions need manual review for non-day units"

# TRY_TO_NUMBER -> TRY_CAST
find models/ -name "*.sql" -exec sed -i 's/TRY_TO_NUMBER(\([^)]*\))/TRY_CAST(\1 AS NUMERIC)/g' {} +

# TRY_TO_DATE -> TRY_CAST
find models/ -name "*.sql" -exec sed -i 's/TRY_TO_DATE(\([^)]*\))/TRY_CAST(\1 AS DATE)/g' {} +

# ARRAY_AGG -> COLLECT_LIST
find models/ -name "*.sql" -exec sed -i 's/\bARRAY_AGG(/COLLECT_LIST(/g' {} +

echo "Done. Review changes before committing."
echo "Run: git diff models/"
```

### 3.2 Manual fixes (require review)

#### DATEADD / DATEDIFF

```sql
-- Snowflake
DATEADD(day, 7, order_date)
DATEADD(month, -3, CURRENT_TIMESTAMP())
DATEDIFF(day, start_date, end_date)

-- Databricks
DATE_ADD(order_date, 7)
ADD_MONTHS(CURRENT_TIMESTAMP(), -3)
DATEDIFF(end_date, start_date)  -- Note: argument order reversed!
```

**Warning:** `DATEDIFF` argument order is reversed between Snowflake and Databricks. This is the most common source of bugs during migration.

#### VARIANT / semi-structured data

```sql
-- Snowflake: VARIANT column with colon notation
SELECT
    raw_json:customer.name::STRING AS customer_name,
    raw_json:order.items[0].price::NUMBER AS first_item_price
FROM raw.events;

-- Databricks: STRUCT/MAP with dot notation
SELECT
    raw_json.customer.name AS customer_name,
    raw_json.order.items[0].price AS first_item_price
FROM analytics_prod.raw.events;

-- If raw_json is a STRING containing JSON:
SELECT
    GET_JSON_OBJECT(raw_json, '$.customer.name') AS customer_name,
    GET_JSON_OBJECT(raw_json, '$.order.items[0].price') AS first_item_price
FROM analytics_prod.raw.events;

-- Or parse with FROM_JSON:
SELECT
    FROM_JSON(raw_json, 'STRUCT<customer: STRUCT<name: STRING>, order: STRUCT<items: ARRAY<STRUCT<price: DOUBLE>>>>') AS parsed
FROM analytics_prod.raw.events;
```

#### OBJECT_CONSTRUCT

```sql
-- Snowflake
SELECT OBJECT_CONSTRUCT(
    'name', customer_name,
    'email', customer_email,
    'total', total_revenue
) AS customer_json
FROM marts.customer_summary;

-- Databricks
SELECT TO_JSON(NAMED_STRUCT(
    'name', customer_name,
    'email', customer_email,
    'total', total_revenue
)) AS customer_json
FROM analytics_prod.marts.customer_summary;
```

#### QUALIFY

```sql
-- Snowflake (QUALIFY is supported)
SELECT *
FROM raw.events
QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at DESC) = 1;

-- Databricks (QUALIFY is supported in Runtime 13+)
-- Same syntax works! No change needed.
SELECT *
FROM analytics_prod.raw.events
QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at DESC) = 1;
```

### 3.3 Complete SQL translation reference

| Snowflake | Databricks | Notes |
|---|---|---|
| `IFF(cond, a, b)` | `IF(cond, a, b)` | Function name |
| `DATEADD(day, n, date)` | `DATE_ADD(date, n)` | Arg order; day-only shortcut |
| `DATEADD(month, n, date)` | `ADD_MONTHS(date, n)` | Month-specific function |
| `DATEADD(hour, n, ts)` | `ts + INTERVAL n HOURS` | Interval syntax |
| `DATEDIFF(day, a, b)` | `DATEDIFF(b, a)` | **Args reversed** |
| `TRY_TO_NUMBER(x)` | `TRY_CAST(x AS NUMERIC)` | Use TRY_CAST |
| `TRY_TO_DATE(x)` | `TRY_CAST(x AS DATE)` | Use TRY_CAST |
| `TRY_TO_TIMESTAMP(x)` | `TRY_CAST(x AS TIMESTAMP)` | Use TRY_CAST |
| `ARRAY_AGG(x)` | `COLLECT_LIST(x)` | Function name |
| `OBJECT_CONSTRUCT(...)` | `TO_JSON(NAMED_STRUCT(...))` | Two functions |
| `col:field::TYPE` | `col.field` or `GET_JSON_OBJECT` | Notation differs |
| `FLATTEN(...)` | `EXPLODE(...)` | Array/object expansion |
| `PARSE_JSON(x)` | `FROM_JSON(x, schema)` | Schema required |
| `TYPEOF(x)` | `TYPEOF(x)` | Same (Runtime 13+) |
| `LISTAGG(x, ',')` | `CONCAT_WS(',', COLLECT_LIST(x))` | Two functions |
| `QUALIFY` | `QUALIFY` | Same (Runtime 13+) |
| `CURRENT_TIMESTAMP()` | `CURRENT_TIMESTAMP()` | Same |
| `CURRENT_DATE()` | `CURRENT_DATE()` | Same |
| `TO_VARCHAR(x, fmt)` | `DATE_FORMAT(x, fmt)` | Format strings differ |
| `SPLIT_PART(x, d, n)` | `SPLIT(x, d)[n-1]` | 0-indexed array |
| `REGEXP_SUBSTR(x, p)` | `REGEXP_EXTRACT(x, p)` | Function name |
| `$1, $2` (stage columns) | Named columns | No positional refs |

---

## Step 4: Convert materializations

### 4.1 Dynamic Tables to incremental models

```sql
-- Snowflake dynamic table (before)
-- This was defined in Snowflake directly, not in dbt

-- dbt incremental model (after)
-- models/marts/fct_daily_revenue.sql
{{ config(
    materialized='incremental',
    unique_key='revenue_date',
    incremental_strategy='merge',
    tblproperties={
        'delta.autoOptimize.autoCompact': 'true',
        'delta.autoOptimize.optimizeWrite': 'true'
    }
) }}

SELECT
    DATE_TRUNC('day', order_date) AS revenue_date,
    region,
    SUM(amount) AS total_revenue,
    COUNT(DISTINCT customer_id) AS unique_customers,
    COUNT(*) AS order_count
FROM {{ ref('stg_orders') }}
{% if is_incremental() %}
WHERE order_date > (SELECT MAX(revenue_date) - INTERVAL 1 DAY FROM {{ this }})
{% endif %}
GROUP BY DATE_TRUNC('day', order_date), region
```

### 4.2 Transient tables

```yaml
# Snowflake: transient tables (no fail-safe, lower cost)
# dbt_project.yml
# models:
#   +transient: true  # Snowflake-specific, remove this

# Databricks: all Delta tables have configurable retention
# dbt_project.yml
models:
  my_project:
    staging:
      +materialized: view  # Views for staging (no storage cost)
    marts:
      +materialized: incremental
```

### 4.3 Secure views

```sql
-- Snowflake: secure view
{{ config(materialized='view', secure=true) }}

-- Databricks: views with row filters and column masks
-- Secure views don't exist as a concept; security is enforced via UC
{{ config(materialized='view') }}
-- Apply row filters and column masks via Unity Catalog ALTER TABLE/VIEW commands
```

---

## Step 5: Update sources

### 5.1 Update source definitions

```yaml
# models/sources.yml (before)
sources:
  - name: raw
    database: ANALYTICS_DB
    schema: RAW
    tables:
      - name: orders
      - name: customers
      - name: products

# models/sources.yml (after -- Databricks)
sources:
  - name: raw
    database: analytics_prod  # catalog name
    schema: raw
    tables:
      - name: orders
      - name: customers
      - name: products
```

### 5.2 Handle case sensitivity

Snowflake uppercases all unquoted identifiers. Databricks preserves case.

```yaml
# If your Snowflake sources use uppercase:
sources:
  - name: raw
    database: analytics_prod
    schema: raw
    tables:
      - name: orders
        # If the actual Delta table is lowercase, this works as-is
        # If you need to reference an uppercase table from Snowflake:
        # identifier: ORDERS  # explicit override
```

---

## Step 6: Run and validate

### 6.1 Compile first (catch syntax errors)

```bash
dbt compile --target dev
```

Fix any compilation errors. Most will be SQL dialect issues from Step 3.

### 6.2 Run against dev

```bash
# Run all models
dbt run --target dev

# Run a specific model to debug
dbt run --target dev --select stg_orders

# Run with full refresh (rebuild all incremental models)
dbt run --target dev --full-refresh
```

### 6.3 Run tests

```bash
dbt test --target dev
```

### 6.4 Data reconciliation

Create a reconciliation model that compares Snowflake and Databricks outputs:

```sql
-- models/reconciliation/recon_orders.sql
-- Run this during parallel-run phase

WITH snowflake_counts AS (
    SELECT
        DATE_TRUNC('day', order_date) AS dt,
        COUNT(*) AS sf_count,
        SUM(amount) AS sf_total
    FROM {{ source('snowflake_bridge', 'orders') }}
    GROUP BY 1
),
databricks_counts AS (
    SELECT
        DATE_TRUNC('day', order_date) AS dt,
        COUNT(*) AS db_count,
        SUM(amount) AS db_total
    FROM {{ ref('stg_orders') }}
    GROUP BY 1
)
SELECT
    COALESCE(s.dt, d.dt) AS dt,
    s.sf_count,
    d.db_count,
    s.sf_count - d.db_count AS count_diff,
    s.sf_total,
    d.db_total,
    ABS(s.sf_total - d.db_total) AS total_diff,
    CASE WHEN ABS(s.sf_total - d.db_total) / NULLIF(s.sf_total, 0) > 0.005
         THEN 'FAIL' ELSE 'PASS' END AS status
FROM snowflake_counts s
FULL OUTER JOIN databricks_counts d ON s.dt = d.dt
ORDER BY dt DESC
```

---

## Step 7: Set up CI/CD

### 7.1 GitHub Actions workflow

```yaml
# .github/workflows/dbt-ci.yml
name: dbt CI

on:
  pull_request:
    paths:
      - 'models/**'
      - 'macros/**'
      - 'tests/**'
      - 'dbt_project.yml'

jobs:
  dbt-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install dbt-databricks==1.7.0

      - name: dbt deps
        run: dbt deps

      - name: dbt compile
        run: dbt compile --target ci
        env:
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}

      - name: dbt run (changed models only)
        run: dbt run --target ci --select state:modified+
        env:
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}

      - name: dbt test
        run: dbt test --target ci --select state:modified+
        env:
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}
```

### 7.2 Contract validation

Wire to csa-inabox contract validation:

```yaml
# Add to .github/workflows/validate-contracts.yml
- name: Validate dbt contracts
  run: |
    dbt compile --target ci
    python scripts/validate_contracts.py --dbt-manifest target/manifest.json
```

---

## Step 8: Production deployment

### 8.1 Deploy to production

```bash
# Full refresh for initial production deployment
dbt run --target prod --full-refresh

# Run tests
dbt test --target prod

# Generate docs
dbt docs generate --target prod
```

### 8.2 Schedule production runs

Set up a Databricks Job to run dbt on schedule:

```json
{
    "name": "dbt-production-daily",
    "schedule": {
        "quartz_cron_expression": "0 0 6 * * ?",
        "timezone_id": "America/New_York"
    },
    "tasks": [
        {
            "task_key": "dbt-run",
            "dbt_task": {
                "commands": [
                    "dbt deps",
                    "dbt run --target prod",
                    "dbt test --target prod"
                ],
                "project_directory": "/Repos/production/dbt-project"
            }
        }
    ],
    "email_notifications": {
        "on_failure": ["data-engineering@agency.gov"]
    }
}
```

---

## Common pitfalls and solutions

| Pitfall | Symptom | Solution |
|---|---|---|
| DATEDIFF arg order | Negative values where positive expected | Swap arguments: `DATEDIFF(end, start)` on Databricks |
| Case sensitivity | Table not found errors | Check catalog/schema/table name casing |
| VARIANT column access | Syntax errors with `:` notation | Use dot notation or GET_JSON_OBJECT |
| Snowflake-specific macros | Compilation errors in macros/ | Rewrite macros for Databricks SQL dialect |
| Transient table config | Warning about unknown config | Remove `+transient: true` from dbt_project.yml |
| Warehouse not found | Connection errors | Verify http_path in profiles.yml |

---

## Related documents

- [Warehouse Migration](warehouse-migration.md) -- compute sizing for dbt workloads
- [Streams & Tasks Migration](streams-tasks-migration.md) -- Task to dbt Job conversion
- [Feature Mapping](feature-mapping-complete.md) -- full SQL function translation
- [Best Practices](best-practices.md) -- parallel-run and reconciliation guidance
- [Master playbook](../snowflake.md) -- Section 4 for the original worked example

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
