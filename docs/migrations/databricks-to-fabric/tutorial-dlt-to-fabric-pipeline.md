# Tutorial — Migrate a DLT Pipeline to Fabric Data Pipeline + dbt

**Status:** Authored 2026-04-30
**Audience:** Data engineers converting a Delta Live Tables pipeline to Fabric Data Pipelines with dbt-fabric for transformations and dbt tests for quality enforcement.
**Scope:** End-to-end walkthrough from DLT pipeline definition through Fabric implementation, including expectations migration, orchestration setup, and quality monitoring.

---

## Prerequisites

- [ ] Fabric workspace with a Lakehouse (F8 or higher)
- [ ] dbt-core and dbt-fabric adapter installed (`pip install dbt-fabric`)
- [ ] Azure DevOps or GitHub repo for dbt project source control
- [ ] Access to the source data (via OneLake shortcut or direct ADLS)
- [ ] The original DLT pipeline definition (Python or SQL notebooks)

---

## Scenario

You have a Databricks DLT pipeline that implements a medallion architecture:

1. **Bronze:** Ingests raw JSON files from ADLS into a streaming table
2. **Silver:** Cleans and deduplicates data with quality expectations
3. **Gold:** Aggregates into business-level summary tables with quality expectations

The pipeline uses DLT expectations to enforce data quality (drop invalid rows, fail on critical violations).

We will convert this to:

1. **Bronze:** Fabric Data Pipeline copy activity (batch ingestion to Lakehouse)
2. **Silver:** dbt-fabric model with dbt tests replacing DLT expectations
3. **Gold:** dbt-fabric model with dbt tests
4. **Orchestration:** Fabric Data Pipeline running dbt via notebook
5. **Monitoring:** dbt test results stored for Power BI quality dashboard

---

## Step 1: Understand the original DLT pipeline

**DLT Bronze (Python):**
```python
import dlt
from pyspark.sql import functions as F

@dlt.table(
    comment="Raw order events ingested from ADLS JSON files",
    table_properties={"quality": "bronze"}
)
def raw_orders():
    return (
        spark.readStream
        .format("cloudFiles")
        .option("cloudFiles.format", "json")
        .option("cloudFiles.inferColumnTypes", "true")
        .option("cloudFiles.schemaLocation", "/mnt/schema/orders")
        .load("/mnt/landing/orders/")
    )
```

**DLT Silver (Python):**
```python
@dlt.table(
    comment="Cleaned orders with quality enforcement",
    table_properties={"quality": "silver"}
)
@dlt.expect_or_drop("valid_order_id", "order_id IS NOT NULL")
@dlt.expect_or_drop("valid_amount", "amount > 0 AND amount < 1000000")
@dlt.expect_or_drop("valid_customer", "customer_id IS NOT NULL")
@dlt.expect("valid_date", "order_date IS NOT NULL AND order_date >= '2020-01-01'")
def orders_clean():
    return (
        dlt.read("raw_orders")
        .withColumn("order_date", F.to_date("order_date"))
        .withColumn("amount", F.col("amount").cast("decimal(12,2)"))
        .withColumn("customer_id", F.trim(F.upper(F.col("customer_id"))))
        .withColumn("etl_timestamp", F.current_timestamp())
        .dropDuplicates(["order_id"])
    )
```

**DLT Gold (Python):**
```python
@dlt.table(
    comment="Daily sales summary by product category",
    table_properties={"quality": "gold"}
)
@dlt.expect_or_fail("has_records", "total_orders > 0")
def daily_sales_summary():
    return (
        dlt.read("orders_clean")
        .groupBy("order_date", "product_category")
        .agg(
            F.sum("amount").alias("total_revenue"),
            F.count("*").alias("total_orders"),
            F.avg("amount").alias("avg_order_value"),
            F.countDistinct("customer_id").alias("unique_customers")
        )
    )

@dlt.table(
    comment="Customer lifetime value",
    table_properties={"quality": "gold"}
)
@dlt.expect("positive_ltv", "lifetime_value >= 0")
def customer_ltv():
    return (
        dlt.read("orders_clean")
        .groupBy("customer_id")
        .agg(
            F.sum("amount").alias("lifetime_value"),
            F.count("*").alias("total_orders"),
            F.min("order_date").alias("first_order"),
            F.max("order_date").alias("last_order")
        )
    )
```

---

## Step 2: Set up the Fabric Lakehouse structure

Create lakehouses in the Fabric workspace:

```
Workspace: Orders-Analytics
├── bronze_lakehouse   (raw ingested data)
├── silver_lakehouse   (cleaned, deduplicated)
└── gold_lakehouse     (business aggregations)
```

Create an OneLake shortcut in `bronze_lakehouse`:
- **Files/landing_orders/** -> shortcut to ADLS path `/container/landing/orders/`

---

## Step 3: Set up the dbt-fabric project

### 3.1 Initialize dbt project

```bash
# On your local machine or in a Fabric notebook terminal
dbt init orders_pipeline
cd orders_pipeline
```

### 3.2 Configure profiles.yml

```yaml
# ~/.dbt/profiles.yml
orders_pipeline:
  target: fabric
  outputs:
    fabric:
      type: fabric
      driver: "ODBC Driver 18 for SQL Server"
      server: "<workspace-id>.datawarehouse.fabric.microsoft.com"
      database: "silver_lakehouse"  # default target lakehouse
      schema: "dbo"
      authentication: "CLI"  # Uses Azure CLI auth
      threads: 4
```

### 3.3 Project structure

```
orders_pipeline/
├── dbt_project.yml
├── models/
│   ├── bronze/
│   │   ├── _bronze_sources.yml
│   │   └── stg_raw_orders.sql
│   ├── silver/
│   │   ├── _silver_models.yml
│   │   └── orders_clean.sql
│   └── gold/
│       ├── _gold_models.yml
│       ├── daily_sales_summary.sql
│       └── customer_ltv.sql
├── tests/
│   └── generic/
│       └── positive_value.sql
├── macros/
│   └── quality_logging.sql
└── packages.yml
```

### 3.4 dbt_project.yml

```yaml
name: 'orders_pipeline'
version: '1.0.0'
config-version: 2

profile: 'orders_pipeline'

model-paths: ["models"]
test-paths: ["tests"]
macro-paths: ["macros"]

vars:
  quality_schema: "audit"

models:
  orders_pipeline:
    bronze:
      +materialized: view
      +database: bronze_lakehouse
    silver:
      +materialized: table
      +database: silver_lakehouse
    gold:
      +materialized: table
      +database: gold_lakehouse

on-run-end:
  - "{{ log_test_summary() }}"
```

### 3.5 packages.yml

```yaml
packages:
  - package: dbt-labs/dbt_utils
    version: ">=1.1.0"
```

---

## Step 4: Create dbt models (replacing DLT tables)

### 4.1 Bronze: Source definition + staging model

**models/bronze/_bronze_sources.yml:**
```yaml
version: 2

sources:
  - name: landing
    database: bronze_lakehouse
    schema: dbo
    description: "Raw data ingested from ADLS landing zone"
    tables:
      - name: raw_orders
        description: "Raw order events from JSON files"
        columns:
          - name: order_id
            description: "Unique order identifier"
          - name: customer_id
            description: "Customer identifier"
          - name: amount
            description: "Order amount in USD"
          - name: order_date
            description: "Date of the order"
          - name: product_category
            description: "Product category"
```

**models/bronze/stg_raw_orders.sql:**
```sql
-- models/bronze/stg_raw_orders.sql
-- Staging model: minimal transformation, type casting only
-- Replaces DLT raw_orders streaming table (batch version)

{{ config(
    materialized='view',
    description='Staged raw orders with type casting'
) }}

SELECT
    order_id,
    customer_id,
    CAST(amount AS DECIMAL(12,2)) AS amount,
    CAST(order_date AS DATE) AS order_date,
    product_category,
    _metadata_file_name,
    CURRENT_TIMESTAMP() AS staged_at
FROM {{ source('landing', 'raw_orders') }}
```

### 4.2 Silver: Cleaned orders (replacing DLT orders_clean)

**models/silver/orders_clean.sql:**
```sql
-- models/silver/orders_clean.sql
-- Replaces DLT orders_clean with expectations
-- DLT expect_or_drop -> WHERE filters
-- DLT expect (warn only) -> dbt test with severity: warn

{{ config(
    materialized='table',
    description='Cleaned orders with deduplication and quality enforcement'
) }}

WITH deduped AS (
    SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY staged_at DESC) AS rn
    FROM {{ ref('stg_raw_orders') }}
    WHERE
        -- Replaces @dlt.expect_or_drop("valid_order_id", "order_id IS NOT NULL")
        order_id IS NOT NULL
        -- Replaces @dlt.expect_or_drop("valid_amount", "amount > 0 AND amount < 1000000")
        AND amount > 0 AND amount < 1000000
        -- Replaces @dlt.expect_or_drop("valid_customer", "customer_id IS NOT NULL")
        AND customer_id IS NOT NULL
)

SELECT
    order_id,
    TRIM(UPPER(customer_id)) AS customer_id,
    amount,
    order_date,
    product_category,
    CURRENT_TIMESTAMP() AS etl_timestamp
FROM deduped
WHERE rn = 1
```

**models/silver/_silver_models.yml:**
```yaml
version: 2

models:
  - name: orders_clean
    description: "Cleaned, deduplicated orders. Replaces DLT orders_clean."
    columns:
      - name: order_id
        description: "Unique order identifier"
        tests:
          - not_null
          - unique
      - name: customer_id
        description: "Standardized customer identifier"
        tests:
          - not_null
      - name: amount
        description: "Order amount in USD"
        tests:
          - not_null
          - dbt_utils.expression_is_true:
              expression: "amount > 0 AND amount < 1000000"
              config:
                severity: error
                store_failures: true
      - name: order_date
        description: "Date of the order"
        tests:
          # Replaces @dlt.expect("valid_date", ...) -- warn only
          - not_null:
              config:
                severity: warn
          - dbt_utils.expression_is_true:
              expression: "order_date >= '2020-01-01'"
              config:
                severity: warn
                store_failures: true
```

### 4.3 Gold: Summary tables (replacing DLT gold tables)

**models/gold/daily_sales_summary.sql:**
```sql
-- models/gold/daily_sales_summary.sql
-- Replaces DLT daily_sales_summary

{{ config(
    materialized='table',
    description='Daily sales summary by product category'
) }}

SELECT
    order_date,
    product_category,
    SUM(amount) AS total_revenue,
    COUNT(*) AS total_orders,
    AVG(amount) AS avg_order_value,
    COUNT(DISTINCT customer_id) AS unique_customers
FROM {{ ref('orders_clean') }}
GROUP BY order_date, product_category
```

**models/gold/customer_ltv.sql:**
```sql
-- models/gold/customer_ltv.sql
-- Replaces DLT customer_ltv

{{ config(
    materialized='table',
    description='Customer lifetime value'
) }}

SELECT
    customer_id,
    SUM(amount) AS lifetime_value,
    COUNT(*) AS total_orders,
    MIN(order_date) AS first_order,
    MAX(order_date) AS last_order
FROM {{ ref('orders_clean') }}
GROUP BY customer_id
```

**models/gold/_gold_models.yml:**
```yaml
version: 2

models:
  - name: daily_sales_summary
    description: "Daily sales aggregation by product category"
    columns:
      - name: total_orders
        tests:
          # Replaces @dlt.expect_or_fail("has_records", "total_orders > 0")
          - dbt_utils.expression_is_true:
              expression: "total_orders > 0"
              config:
                severity: error  # fail pipeline
      - name: total_revenue
        tests:
          - not_null

  - name: customer_ltv
    description: "Customer lifetime value metrics"
    columns:
      - name: lifetime_value
        tests:
          # Replaces @dlt.expect("positive_ltv", "lifetime_value >= 0")
          - dbt_utils.expression_is_true:
              expression: "lifetime_value >= 0"
              config:
                severity: warn
                store_failures: true
      - name: customer_id
        tests:
          - not_null
          - unique
```

---

## Step 5: Create the Bronze ingestion pipeline

Since DLT's Auto Loader handled Bronze ingestion, we need a Fabric Data Pipeline for that:

1. In the workspace, click **New > Data Pipeline**
2. Name it `orders_bronze_ingest`
3. Add a **Copy activity**:
   - Source: ADLS Gen2, JSON files at `/container/landing/orders/`
   - Sink: Lakehouse table `raw_orders` in `bronze_lakehouse`
   - Settings: Incremental (use folder date partitions or file modification time)
4. Add a **Schedule trigger**: Run every hour (or use storage event trigger)

---

## Step 6: Create the dbt runner notebook

Create a Fabric notebook that runs dbt commands:

**Notebook: `dbt_runner`**

```python
# Cell 1: Install dbt (or use Fabric environment)
%pip install dbt-core dbt-fabric dbt-utils

# Cell 2: Get parameters
dbt_command = mssparkutils.notebook.getParam("dbt_command", "dbt run")
project_path = mssparkutils.notebook.getParam("project_path", "/lakehouse/default/Files/dbt/orders_pipeline")

# Cell 3: Run dbt
import subprocess
import sys

result = subprocess.run(
    dbt_command.split(),
    cwd=project_path,
    capture_output=True,
    text=True,
    env={**dict(__import__('os').environ), "DBT_PROFILES_DIR": project_path}
)

print("STDOUT:")
print(result.stdout)

if result.returncode != 0:
    print("STDERR:")
    print(result.stderr)
    raise Exception(f"dbt command failed with return code {result.returncode}")

print(f"dbt command completed successfully: {dbt_command}")

# Cell 4: Exit with status
mssparkutils.notebook.exit(f"SUCCESS: {dbt_command}")
```

---

## Step 7: Orchestrate with Fabric Data Pipeline

Create the main orchestration pipeline:

**Pipeline: `orders_pipeline_main`**

```
Activity 1: "Ingest Bronze"
  Type: Execute Pipeline
  Pipeline: orders_bronze_ingest

Activity 2: "Run dbt models"
  Type: Notebook
  Notebook: dbt_runner
  Parameters:
    dbt_command: "dbt run --select tag:orders"
  Depends on: Activity 1 (Succeeded)

Activity 3: "Run dbt tests"
  Type: Notebook
  Notebook: dbt_runner
  Parameters:
    dbt_command: "dbt test --select tag:orders"
  Depends on: Activity 2 (Succeeded)

Activity 4: "Alert on test failure"
  Type: Web Activity
  URL: Teams webhook URL
  Method: POST
  Body: {"text": "dbt tests failed for orders pipeline"}
  Depends on: Activity 3 (Failed)
```

Schedule: Daily at 07:00 UTC (after bronze ingest completes).

---

## Step 8: Set up quality monitoring

### 8.1 Store test failures

With `store_failures: true` in the dbt test config, failed rows are stored in the `audit` schema. Create a Power BI report on these tables:

```sql
-- Query audit tables for quality dashboard
SELECT
    'orders_clean.amount' AS test_name,
    COUNT(*) AS failure_count,
    CURRENT_DATE() AS test_date
FROM audit.dbt_utils_expression_is_true_orders_clean_amount__0_AND_amount__1000000
UNION ALL
SELECT
    'orders_clean.order_date' AS test_name,
    COUNT(*) AS failure_count,
    CURRENT_DATE() AS test_date
FROM audit.not_null_orders_clean_order_date
```

### 8.2 Quality dashboard (replaces DLT expectations UI)

Build a Power BI report with:

- **Card:** Total test failures today
- **Trend line:** Test failures over time
- **Table:** Failed rows by test name
- **Alert:** Data Activator trigger when failure count exceeds threshold

---

## Step 9: Validate migration

Run both the DLT pipeline and the Fabric pipeline against the same input data:

| Metric | DLT result | Fabric result | Match? |
| --- | --- | --- | --- |
| Bronze row count | ______ | ______ | [ ] |
| Silver row count (after quality filters) | ______ | ______ | [ ] |
| Rows dropped by expectations | ______ | ______ | [ ] |
| Gold: daily_sales_summary rows | ______ | ______ | [ ] |
| Gold: total_revenue sum | ______ | ______ | [ ] |
| Gold: customer_ltv count | ______ | ______ | [ ] |

---

## Step 10: Decommission DLT pipeline

After 2 weeks of parallel operation with matching results:

1. Disable the DLT pipeline in Databricks
2. Archive DLT notebooks to Git
3. Remove the DLT compute cluster
4. Update downstream consumers to point to Fabric Lakehouse tables
5. Update monitoring dashboards

---

## DLT-to-Fabric translation reference

| DLT concept | Fabric equivalent | Implementation |
| --- | --- | --- |
| `@dlt.table` | dbt model (`.sql` file) | `{{ config(materialized='table') }}` |
| `@dlt.view` | dbt model (view) | `{{ config(materialized='view') }}` |
| `dlt.read("table")` | `{{ ref('table') }}` | dbt reference |
| `dlt.read_stream("table")` | Eventstream + Eventhouse or Spark Streaming | See streaming-migration.md |
| `@dlt.expect("name", "expr")` | dbt test with `severity: warn` | YAML test definition |
| `@dlt.expect_or_drop` | WHERE filter in model + `severity: error` test | SQL filter + test |
| `@dlt.expect_or_fail` | dbt test with `severity: error` | Pipeline fails on test failure |
| DLT quality metrics | `store_failures` + audit tables | Power BI dashboard |
| DLT pipeline config | Fabric Data Pipeline JSON | Pipeline activities |
| DLT compute | Fabric Spark (CU-based) | Serverless, no cluster config |
| `cloudFiles` (Auto Loader) | Data Pipeline copy activity + trigger | Batch file ingestion |

---

## Common pitfalls

| Pitfall | Mitigation |
| --- | --- |
| Trying to make dbt behave like DLT | Accept the paradigm shift: dbt is SQL-first, model-based, test-after-run |
| Not storing test failures | Always use `store_failures: true` for quality visibility |
| Running dbt without tests | Chain `dbt test` after `dbt run` in the pipeline; never skip |
| Ignoring DLT's incremental processing | Use dbt `incremental` materialization with `unique_key` for efficiency |
| Not testing the dbt-fabric connection | Test `dbt debug` before building models |
| Large dbt runs exceeding CU budget | Use `dbt run --select tag:priority` to run critical models first |

---

## Related

- [DLT Migration](dlt-migration.md) -- complete DLT migration reference
- [Notebook Migration](notebook-migration.md) -- for non-DLT notebook conversion
- [Streaming Migration](streaming-migration.md) -- for DLT streaming workloads
- [Feature Mapping](feature-mapping-complete.md) -- DLT and orchestration section
- [Best Practices](best-practices.md) -- pipeline patterns
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)
- dbt-fabric adapter: <https://github.com/microsoft/dbt-fabric>
- dbt testing documentation: <https://docs.getdbt.com/docs/build/data-tests>

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
