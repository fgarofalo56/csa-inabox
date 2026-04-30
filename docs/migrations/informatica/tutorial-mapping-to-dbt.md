# Tutorial: Convert a PowerCenter Mapping to a dbt Model

**A step-by-step walkthrough for converting a real-world PowerCenter mapping to dbt SQL, including transformation conversion, testing, documentation, and deployment.**

---

## Prerequisites

- Basic SQL knowledge
- dbt CLI or dbt Cloud account
- Access to your PowerCenter repository (for mapping export)
- Target Azure SQL or Synapse database provisioned
- Git repository for dbt project

**Estimated time:** 2-3 hours

---

## What you will build

By the end of this tutorial, you will have:

1. Exported a PowerCenter mapping's metadata
2. Analyzed the transformation logic
3. Created equivalent dbt models (staging, intermediate, mart)
4. Written dbt tests replacing manual QA
5. Generated documentation
6. Deployed through CI/CD

---

## Step 1: Export the PowerCenter mapping (15 min)

### Option A: PowerCenter Designer export

1. Open PowerCenter Designer
2. Navigate to the mapping you want to convert (we'll use `m_ORDER_FACT` as our example)
3. Right-click -> Properties -> note all transformation names and types
4. For each transformation, record:
    - Transformation type (Expression, Lookup, Aggregator, etc.)
    - Input/output ports and their expressions
    - Lookup SQL overrides
    - Filter conditions

### Option B: Repository query

```sql
-- Export mapping metadata from PowerCenter repository
SELECT
    m.MAPPING_NAME,
    wi.WIDGET_TYPE AS transformation_type,
    wi.WIDGET_NAME AS transformation_name,
    p.PORT_NAME,
    p.PORT_TYPE,  -- INPUT, OUTPUT, INPUT/OUTPUT
    p.EXPRESSION,
    p.DATATYPE,
    p.PRECISION,
    p.SCALE
FROM REP_MAPPINGS m
JOIN REP_WIDGET_INST wi ON m.MAPPING_ID = wi.MAPPING_ID
JOIN REP_WIDGET_ATTR p ON wi.WIDGET_ID = p.WIDGET_ID
WHERE m.MAPPING_NAME = 'm_ORDER_FACT'
ORDER BY wi.WIDGET_NAME, p.PORT_NAME;
```

### Our example mapping: `m_ORDER_FACT`

This mapping loads an order fact table with the following transformations:

```
SQ_ORDERS (Source Qualifier)
  -> Filter: WHERE order_date >= $$START_DATE
  -> Joiner: INNER JOIN to CUSTOMERS on customer_id
  |
  v
EXP_DERIVE (Expression)
  -> order_amount_usd = order_amount * exchange_rate
  -> order_year = TO_CHAR(order_date, 'YYYY')
  -> order_month = TO_CHAR(order_date, 'MM')
  -> is_high_value = IIF(order_amount_usd > 10000, 'Y', 'N')
  |
  v
LKP_PRODUCT (Lookup)
  -> LEFT JOIN to DIM_PRODUCT on product_id
  -> Returns: product_name, product_category
  |
  v
LKP_REGION (Lookup)
  -> LEFT JOIN to REF_REGION on region_code
  -> Returns: region_name
  |
  v
AGG_MONTHLY (Aggregator)
  -> GROUP BY: customer_id, order_year, order_month, product_category, region_name
  -> SUM(order_amount_usd), COUNT(order_id)
  |
  v
UPD_INSERT (Update Strategy)
  -> DD_INSERT for all rows (append-only fact)
  |
  v
TGT_FACT_ORDERS (Target)
  -> INSERT into DW.FACT_ORDER_MONTHLY
```

---

## Step 2: Set up the dbt project (20 min)

### Initialize project

```bash
# Create a new dbt project (skip if you have an existing one)
dbt init order_analytics

# Navigate to the project
cd order_analytics
```

### Configure connection

Edit `profiles.yml` to connect to your Azure SQL or Synapse database:

```yaml
# ~/.dbt/profiles.yml
order_analytics:
    target: dev
    outputs:
        dev:
            type: sqlserver # or synapse, fabric
            driver: "ODBC Driver 18 for SQL Server"
            server: your-server.database.windows.net
            database: your_database
            schema: dbt_dev
            authentication: ActiveDirectoryInteractive # or ActiveDirectoryServicePrincipal
            encrypt: true
            trust_cert: false
```

### Define sources

Create source definitions for the tables the PowerCenter mapping reads from:

```yaml
# models/staging/erp/_erp__sources.yml
version: 2

sources:
    - name: erp
      description: ERP system (source for order data)
      database: source_db
      schema: dbo
      tables:
          - name: orders
            description: Raw order transactions
            columns:
                - name: order_id
                  tests: [unique, not_null]
                - name: customer_id
                  tests: [not_null]
                - name: order_date
                  tests: [not_null]
            loaded_at_field: updated_at
            freshness:
                warn_after: { count: 24, period: hour }
                error_after: { count: 48, period: hour }

          - name: customers
            description: Customer master data
            columns:
                - name: customer_id
                  tests: [unique, not_null]

    - name: ref
      description: Reference data
      database: source_db
      schema: ref
      tables:
          - name: regions
            description: Region reference lookup
          - name: exchange_rates
            description: Currency exchange rates
```

---

## Step 3: Create staging models (30 min)

Staging models are 1:1 with source tables. They handle renaming, type casting, and basic cleansing.

### Orders staging model

```sql
-- models/staging/erp/stg_erp__orders.sql

WITH source AS (
    SELECT * FROM {{ source('erp', 'orders') }}
),

renamed AS (
    SELECT
        order_id,
        customer_id,
        product_id,
        region_code,
        CAST(order_date AS DATE) AS order_date,
        CAST(order_amount AS DECIMAL(18, 2)) AS order_amount,
        currency_code,
        order_status,
        updated_at
    FROM source
    WHERE order_status != 'cancelled'  -- equivalent to SQ filter
)

SELECT * FROM renamed
```

### Customers staging model

```sql
-- models/staging/erp/stg_erp__customers.sql

WITH source AS (
    SELECT * FROM {{ source('erp', 'customers') }}
)

SELECT
    customer_id,
    customer_name,
    customer_segment,
    country_code
FROM source
```

### Exchange rates staging model

```sql
-- models/staging/ref/stg_ref__exchange_rates.sql

SELECT
    currency_code,
    rate_date,
    exchange_rate_to_usd
FROM {{ source('ref', 'exchange_rates') }}
```

---

## Step 4: Create intermediate model (30 min)

The intermediate model replaces the PowerCenter Expression, Lookups, and Joiner transformations.

```sql
-- models/intermediate/int_orders__enriched.sql
-- Replaces: SQ_ORDERS join + EXP_DERIVE + LKP_PRODUCT + LKP_REGION

WITH orders AS (
    SELECT * FROM {{ ref('stg_erp__orders') }}
),

customers AS (
    SELECT * FROM {{ ref('stg_erp__customers') }}
),

products AS (
    SELECT * FROM {{ ref('stg_ref__products') }}
),

regions AS (
    SELECT * FROM {{ ref('stg_ref__regions') }}
),

exchange_rates AS (
    SELECT * FROM {{ ref('stg_ref__exchange_rates') }}
),

-- Step 1: Join orders to customers (replaces SQ_ORDERS Joiner)
orders_with_customers AS (
    SELECT
        o.order_id,
        o.customer_id,
        c.customer_name,
        c.customer_segment,
        o.product_id,
        o.region_code,
        o.order_date,
        o.order_amount,
        o.currency_code
    FROM orders o
    INNER JOIN customers c
        ON o.customer_id = c.customer_id
),

-- Step 2: Apply exchange rate (replaces EXP_DERIVE.order_amount_usd)
orders_with_usd AS (
    SELECT
        oc.*,
        COALESCE(er.exchange_rate_to_usd, 1.0) AS exchange_rate,
        oc.order_amount * COALESCE(er.exchange_rate_to_usd, 1.0) AS order_amount_usd,
        YEAR(oc.order_date) AS order_year,
        MONTH(oc.order_date) AS order_month
    FROM orders_with_customers oc
    LEFT JOIN exchange_rates er
        ON oc.currency_code = er.currency_code
        AND oc.order_date = er.rate_date
),

-- Step 3: Lookup product (replaces LKP_PRODUCT)
orders_with_product AS (
    SELECT
        ou.*,
        p.product_name,
        p.product_category
    FROM orders_with_usd ou
    LEFT JOIN products p
        ON ou.product_id = p.product_id
),

-- Step 4: Lookup region (replaces LKP_REGION)
final AS (
    SELECT
        op.*,
        r.region_name,
        -- Derived fields (replaces EXP_DERIVE)
        CASE
            WHEN op.order_amount_usd > 10000 THEN 'Y'
            ELSE 'N'
        END AS is_high_value
    FROM orders_with_product op
    LEFT JOIN regions r
        ON op.region_code = r.region_code
)

SELECT * FROM final
```

### Mapping each PowerCenter transformation to dbt

| PowerCenter transformation          | dbt CTE                 | What it does                              |
| ----------------------------------- | ----------------------- | ----------------------------------------- |
| SQ_ORDERS (Source Qualifier + JOIN) | `orders_with_customers` | Joins orders to customers (INNER JOIN)    |
| EXP_DERIVE (order_amount_usd)       | `orders_with_usd`       | Applies exchange rate; derives year/month |
| LKP_PRODUCT                         | `orders_with_product`   | LEFT JOIN to product dimension            |
| LKP_REGION                          | `final`                 | LEFT JOIN to region reference             |
| EXP_DERIVE (is_high_value)          | `final`                 | CASE expression for high-value flag       |

---

## Step 5: Create the mart model (20 min)

The mart model replaces the PowerCenter Aggregator and produces the final fact table.

```sql
-- models/marts/finance/fct_order_monthly.sql
-- Replaces: AGG_MONTHLY + UPD_INSERT + TGT_FACT_ORDERS

{{ config(
    materialized='incremental',
    unique_key=['customer_id', 'order_year', 'order_month', 'product_category', 'region_name'],
    incremental_strategy='merge'
) }}

SELECT
    -- Dimension keys
    customer_id,
    customer_name,
    order_year,
    order_month,
    product_category,
    region_name,

    -- Measures (replaces AGG_MONTHLY)
    SUM(order_amount_usd) AS total_order_amount_usd,
    COUNT(order_id) AS order_count,
    AVG(order_amount_usd) AS avg_order_amount_usd,
    SUM(CASE WHEN is_high_value = 'Y' THEN 1 ELSE 0 END) AS high_value_order_count,

    -- Metadata
    CURRENT_TIMESTAMP AS loaded_at

FROM {{ ref('int_orders__enriched') }}

{% if is_incremental() %}
WHERE order_date > (SELECT MAX(order_date) FROM {{ this }})
{% endif %}

GROUP BY
    customer_id,
    customer_name,
    order_year,
    order_month,
    product_category,
    region_name
```

---

## Step 6: Write tests (20 min)

Replace manual QA with automated dbt tests.

```yaml
# models/marts/finance/_finance__models.yml
version: 2

models:
    - name: fct_order_monthly
      description: |
          Monthly aggregated order facts by customer, product category, and region.
          Replaces PowerCenter mapping m_ORDER_FACT.
      columns:
          - name: customer_id
            description: Foreign key to dim_customer
            tests:
                - not_null
                - relationships:
                      to: ref('stg_erp__customers')
                      field: customer_id
          - name: order_year
            tests:
                - not_null
                - accepted_values:
                      values:
                          [
                              "2020",
                              "2021",
                              "2022",
                              "2023",
                              "2024",
                              "2025",
                              "2026",
                          ]
          - name: total_order_amount_usd
            tests:
                - not_null
                - dbt_expectations.expect_column_values_to_be_between:
                      min_value: 0
                      max_value: 100000000 # $100M max per customer-month
          - name: order_count
            tests:
                - not_null
                - dbt_expectations.expect_column_values_to_be_between:
                      min_value: 1
```

### Custom test: reconciliation with PowerCenter

During parallel run, verify row counts and totals match:

```sql
-- tests/reconciliation/assert_fct_order_monthly_matches_powercenter.sql
-- Compare dbt output to PowerCenter output during parallel run

WITH dbt_totals AS (
    SELECT
        order_year,
        order_month,
        SUM(total_order_amount_usd) AS dbt_total,
        SUM(order_count) AS dbt_count
    FROM {{ ref('fct_order_monthly') }}
    GROUP BY order_year, order_month
),

pc_totals AS (
    SELECT
        order_year,
        order_month,
        SUM(total_order_amount_usd) AS pc_total,
        SUM(order_count) AS pc_count
    FROM {{ source('powercenter', 'fact_order_monthly_pc') }}
    GROUP BY order_year, order_month
)

SELECT
    d.order_year,
    d.order_month,
    d.dbt_total,
    p.pc_total,
    ABS(d.dbt_total - p.pc_total) AS amount_diff,
    d.dbt_count,
    p.pc_count
FROM dbt_totals d
JOIN pc_totals p ON d.order_year = p.order_year AND d.order_month = p.order_month
WHERE ABS(d.dbt_total - p.pc_total) > 0.01  -- tolerance
   OR d.dbt_count != p.pc_count
```

---

## Step 7: Add documentation (10 min)

dbt auto-generates documentation from your YAML files.

```yaml
# models/intermediate/_int__models.yml
version: 2

models:
    - name: int_orders__enriched
      description: |
          Orders enriched with customer, product, region, and exchange rate data.
          Converts order amounts to USD.

          **PowerCenter origin:** Mapping `m_ORDER_FACT`, transformations SQ_ORDERS through LKP_REGION.

          **Key business rules:**
          - Orders joined to customers via INNER JOIN (only matched orders)
          - Exchange rate applied from rate effective on order date
          - Products and regions are LEFT JOINed (nulls allowed)
          - High-value flag set at $10,000 USD threshold
      columns:
          - name: order_id
            description: Unique order identifier from ERP
          - name: order_amount_usd
            description: Order amount converted to USD using daily exchange rate
          - name: is_high_value
            description: "'Y' if order_amount_usd > 10000, else 'N'"
```

Generate and serve documentation:

```bash
# Generate docs
dbt docs generate

# Serve locally (opens browser)
dbt docs serve
```

---

## Step 8: Run and validate (20 min)

### Run the models

```bash
# Run all models in dependency order
dbt run

# Output:
# Running 1 of 5: stg_erp__orders .............. OK
# Running 2 of 5: stg_erp__customers ........... OK
# Running 3 of 5: stg_ref__exchange_rates ...... OK
# Running 4 of 5: int_orders__enriched ......... OK
# Running 5 of 5: fct_order_monthly ............ OK
```

### Run tests

```bash
# Run all tests
dbt test

# Output:
# Running 1 of 8: unique_fct_order_monthly_customer_id_order_year_order_month ... PASS
# Running 2 of 8: not_null_fct_order_monthly_customer_id ........................ PASS
# Running 3 of 8: relationships_fct_order_monthly_customer_id ................... PASS
# ...
```

### Check source freshness

```bash
# Verify source data is fresh
dbt source freshness

# Output:
# Running freshness check: erp.orders ... PASS (last updated 2 hours ago)
```

---

## Step 9: Deploy through CI/CD (15 min)

### GitHub Actions workflow

```yaml
# .github/workflows/dbt-deploy.yml
name: dbt Deploy

on:
    push:
        branches: [main]
    pull_request:
        branches: [main]

jobs:
    dbt-test:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-python@v5
              with:
                  python-version: "3.11"
            - run: pip install dbt-sqlserver
            - run: dbt deps
            - run: dbt build --target ci # runs models + tests
              env:
                  DBT_PROFILES_DIR: .

    dbt-deploy:
        needs: dbt-test
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-python@v5
              with:
                  python-version: "3.11"
            - run: pip install dbt-sqlserver
            - run: dbt deps
            - run: dbt run --target prod
              env:
                  DBT_PROFILES_DIR: .
```

---

## Step 10: Comparison summary

| Aspect          | PowerCenter m_ORDER_FACT      | dbt equivalent                    |
| --------------- | ----------------------------- | --------------------------------- |
| Files           | 1 mapping (XML in repository) | 5 SQL files + 2 YAML files        |
| Version control | Repository export             | Git (full diff, branch, PR)       |
| Testing         | Manual QA after each run      | 8+ automated tests, CI-integrated |
| Documentation   | Separate wiki page            | Auto-generated from YAML          |
| Deployment      | Repository export + import    | `git push` triggers CI/CD         |
| Debugging       | PowerCenter session log       | dbt logs + SQL profiler           |
| Reusability     | Mapplet (limited)             | Macros (full Jinja templating)    |
| Execution time  | ~5 min (PowerCenter)          | ~3 min (dbt incremental)          |

---

## Next steps

1. **Convert your next mapping** using this same pattern
2. **Prioritize simple mappings first** (Tier A in the assessment)
3. **Set up parallel run** using the reconciliation test above
4. **Read:** [Tutorial: Workflow to ADF](tutorial-workflow-to-adf.md) for orchestration
5. **Read:** [PowerCenter Migration Guide](powercenter-migration.md) for the full transformation reference

---

## Related resources

- [PowerCenter Migration Guide](powercenter-migration.md) -- Complete transformation mapping
- [Tutorial: Workflow to ADF](tutorial-workflow-to-adf.md) -- Orchestration tutorial
- [Complete Feature Mapping](feature-mapping-complete.md) -- All features mapped
- [Best Practices](best-practices.md) -- Migration execution guidance
- [Migration Playbook](../informatica.md) -- End-to-end migration guide

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
