# Tutorial: Migrating a Foundry Pipeline to ADF and dbt

**A hands-on, step-by-step walkthrough for data engineers migrating a Palantir Foundry pipeline to Azure Data Factory with dbt transforms, following the medallion architecture.**

**Estimated time:** 2-3 hours
**Difficulty:** Intermediate

---

## Prerequisites

Before starting this tutorial, ensure you have the following:

| Requirement                          | Details                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| **Azure subscription**               | With permissions to create Data Factory, Storage Account, and SQL resources |
| **Azure Data Factory**               | A provisioned ADF instance (or permissions to create one)                   |
| **dbt Core**                         | Installed locally (`pip install dbt-sqlserver` or `pip install dbt-fabric`) |
| **Git**                              | For version-controlling dbt models and ADF ARM templates                    |
| **Azure CLI**                        | Authenticated with `az login`                                               |
| **SQL database or Fabric lakehouse** | Target warehouse for transformed data                                       |
| **Foundry access**                   | Read access to the pipeline you are migrating (for documentation purposes)  |

---

## Scenario

You are migrating a Foundry pipeline that processes customer order data through three stages:

1. **Ingest** raw CSV files from an SFTP source into a Foundry raw dataset
2. **Transform** the data using Python transforms with `@transform` decorators to clean, validate, and join customer and order records
3. **Output** a final business-ready dataset consumed by a Quiver dashboard

By the end of this tutorial you will have an equivalent pipeline running on Azure with ADF handling ingestion, dbt handling transforms, and the medallion architecture organizing your data layers.

---

## Step 1: Document the Foundry pipeline

Before writing any Azure code, you need a complete inventory of what the Foundry pipeline does. Open your Foundry project and record the following.

### 1.1 List pipeline stages

Map every stage from source to output. For our example pipeline:

```
SFTP (CSV files)
  → Raw Dataset: /datasets/raw/customers
  → Raw Dataset: /datasets/raw/orders
    → Transform: clean_customers (Python)
    → Transform: clean_orders (Python)
      → Transform: joined_order_summary (Python)
        → Output Dataset: /datasets/gold/order_summary
          → Quiver Dashboard: "Customer Order KPIs"
```

### 1.2 Identify source connections

Document every external connection the pipeline uses:

| Property          | Value                               |
| ----------------- | ----------------------------------- |
| **Source type**   | SFTP                                |
| **Hostname**      | `sftp.example.com`                  |
| **Port**          | 22                                  |
| **Auth method**   | SSH key (stored in Foundry secrets) |
| **File pattern**  | `customers_*.csv`, `orders_*.csv`   |
| **Sync schedule** | Daily at 02:00 UTC                  |

### 1.3 Document transform logic

Export or screenshot every transform. Here is our example Foundry Python transform that cleans and joins the data:

```python
# Foundry Python transform: clean_customers
from transforms.api import transform, Input, Output

@transform(
    customers_raw=Input("/datasets/raw/customers"),
    customers_clean=Output("/datasets/staging/customers_clean"),
)
def compute(customers_raw, customers_clean):
    df = customers_raw.dataframe()

    # Standardize email to lowercase, trim whitespace
    df = df.withColumn("email", F.lower(F.trim(F.col("email"))))

    # Remove records with null customer_id
    df = df.filter(F.col("customer_id").isNotNull())

    # Deduplicate on customer_id, keeping latest record
    window = Window.partitionBy("customer_id").orderBy(F.desc("updated_at"))
    df = df.withColumn("row_num", F.row_number().over(window))
    df = df.filter(F.col("row_num") == 1).drop("row_num")

    customers_clean.write_dataframe(df)
```

```python
# Foundry Python transform: joined_order_summary
from transforms.api import transform, Input, Output

@transform(
    customers=Input("/datasets/staging/customers_clean"),
    orders=Input("/datasets/staging/orders_clean"),
    order_summary=Output("/datasets/gold/order_summary"),
)
def compute(customers, orders, order_summary):
    cust_df = customers.dataframe()
    ord_df = orders.dataframe()

    # Join customers to orders
    joined = ord_df.join(cust_df, on="customer_id", how="inner")

    # Aggregate order metrics per customer
    summary = joined.groupBy(
        "customer_id", "email", "customer_name"
    ).agg(
        F.count("order_id").alias("total_orders"),
        F.sum("order_amount").alias("total_revenue"),
        F.max("order_date").alias("last_order_date"),
    )

    order_summary.write_dataframe(summary)
```

### 1.4 Note scheduling and dependencies

| Property             | Foundry value                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| **Schedule type**    | Cron                                                                     |
| **Cron expression**  | `0 2 * * *` (daily at 02:00 UTC)                                         |
| **Dependency chain** | `raw_sync` → `clean_customers` + `clean_orders` → `joined_order_summary` |
| **Retry policy**     | 2 retries with 5-minute backoff                                          |
| **Alerts**           | Email on failure to `data-team@example.com`                              |

---

## Step 2: Create the ADF pipeline structure

### 2.1 Create linked services

Linked services define connections to external systems. Create two: one for the SFTP source and one for the target storage.

**SFTP linked service** (via ADF Studio or ARM template):

```json
{
    "name": "ls_sftp_source",
    "type": "Microsoft.DataFactory/factories/linkedservices",
    "properties": {
        "type": "Sftp",
        "typeProperties": {
            "host": "sftp.example.com",
            "port": 22,
            "authenticationType": "SshPublicKey",
            "userName": "data_extract",
            "privateKeyPath": "",
            "privateKeyContent": {
                "type": "AzureKeyVaultSecret",
                "store": {
                    "referenceName": "ls_keyvault",
                    "type": "LinkedServiceReference"
                },
                "secretName": "sftp-private-key"
            }
        }
    }
}
```

**Azure Data Lake Storage linked service** (target for raw/bronze data):

```json
{
    "name": "ls_adls_datalake",
    "type": "Microsoft.DataFactory/factories/linkedservices",
    "properties": {
        "type": "AzureBlobFS",
        "typeProperties": {
            "url": "https://yourstorageaccount.dfs.core.windows.net",
            "accountKey": {
                "type": "AzureKeyVaultSecret",
                "store": {
                    "referenceName": "ls_keyvault",
                    "type": "LinkedServiceReference"
                },
                "secretName": "adls-account-key"
            }
        }
    }
}
```

> **Security note:** Never hard-code credentials. Use Azure Key Vault references as shown above. This replaces Foundry's built-in secrets manager.

### 2.2 Create datasets

Define the source and sink datasets that the Copy Activity will use:

```json
{
    "name": "ds_sftp_customers_csv",
    "properties": {
        "type": "DelimitedText",
        "linkedServiceName": {
            "referenceName": "ls_sftp_source",
            "type": "LinkedServiceReference"
        },
        "typeProperties": {
            "location": {
                "type": "SftpLocation",
                "folderPath": "/exports/customers",
                "fileName": "customers_*.csv"
            },
            "columnDelimiter": ",",
            "firstRowAsHeader": true
        }
    }
}
```

```json
{
    "name": "ds_adls_customers_raw",
    "properties": {
        "type": "Parquet",
        "linkedServiceName": {
            "referenceName": "ls_adls_datalake",
            "type": "LinkedServiceReference"
        },
        "typeProperties": {
            "location": {
                "type": "AzureBlobFSLocation",
                "fileSystem": "bronze",
                "folderPath": "customers"
            }
        }
    }
}
```

### 2.3 Build a Copy Activity for data ingestion (bronze layer)

The Copy Activity replaces Foundry's Data Connection sync. It reads from SFTP and writes Parquet files to the bronze layer in ADLS:

```json
{
    "name": "pl_ingest_customer_orders",
    "properties": {
        "activities": [
            {
                "name": "copy_customers",
                "type": "Copy",
                "inputs": [
                    {
                        "referenceName": "ds_sftp_customers_csv",
                        "type": "DatasetReference"
                    }
                ],
                "outputs": [
                    {
                        "referenceName": "ds_adls_customers_raw",
                        "type": "DatasetReference"
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "DelimitedTextSource"
                    },
                    "sink": {
                        "type": "ParquetSink"
                    }
                }
            },
            {
                "name": "copy_orders",
                "type": "Copy",
                "dependsOn": [],
                "inputs": [
                    {
                        "referenceName": "ds_sftp_orders_csv",
                        "type": "DatasetReference"
                    }
                ],
                "outputs": [
                    {
                        "referenceName": "ds_adls_orders_raw",
                        "type": "DatasetReference"
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "DelimitedTextSource"
                    },
                    "sink": {
                        "type": "ParquetSink"
                    }
                }
            }
        ]
    }
}
```

### 2.4 ADF visual versus JSON

In ADF Studio you build this visually by dragging Copy Activities onto the canvas and connecting them. The JSON above is what ADF generates behind the scenes. Key mapping from Foundry:

| Foundry Pipeline Builder    | ADF equivalent                        |
| --------------------------- | ------------------------------------- |
| Visual drag-and-drop canvas | ADF Studio pipeline canvas            |
| Data Connection sync        | Copy Activity with linked service     |
| Dataset node                | ADF Dataset resource                  |
| Dependency arrows           | `dependsOn` property in activity JSON |
| Secrets manager             | Azure Key Vault linked service        |

---

## Step 3: Convert Foundry transforms to dbt

This is the core of the migration. Each Foundry Python transform becomes a dbt SQL model.

### 3.1 Initialize a dbt project

```bash
# Create a new dbt project
dbt init customer_orders

cd customer_orders

# Configure your profile in ~/.dbt/profiles.yml
# Example for Azure SQL Database:
```

Add the following to `~/.dbt/profiles.yml`:

```yaml
customer_orders:
    target: dev
    outputs:
        dev:
            type: sqlserver
            driver: "ODBC Driver 18 for SQL Server"
            server: your-server.database.windows.net
            port: 1433
            database: your_database
            schema: analytics
            authentication: CLI
```

### 3.2 Convert the clean_customers transform

**Before (Foundry Python):**

```python
@transform(
    customers_raw=Input("/datasets/raw/customers"),
    customers_clean=Output("/datasets/staging/customers_clean"),
)
def compute(customers_raw, customers_clean):
    df = customers_raw.dataframe()
    df = df.withColumn("email", F.lower(F.trim(F.col("email"))))
    df = df.filter(F.col("customer_id").isNotNull())
    window = Window.partitionBy("customer_id").orderBy(F.desc("updated_at"))
    df = df.withColumn("row_num", F.row_number().over(window))
    df = df.filter(F.col("row_num") == 1).drop("row_num")
    customers_clean.write_dataframe(df)
```

**After (dbt SQL model):** `models/staging/stg_customers.sql`

```sql
-- models/staging/stg_customers.sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('bronze', 'customers_raw') }}
),

cleaned as (
    select
        customer_id,
        customer_name,
        lower(trim(email)) as email,
        phone,
        created_at,
        updated_at
    from source
    where customer_id is not null
),

deduplicated as (
    select
        *,
        row_number() over (
            partition by customer_id
            order by updated_at desc
        ) as row_num
    from cleaned
)

select
    customer_id,
    customer_name,
    email,
    phone,
    created_at,
    updated_at
from deduplicated
where row_num = 1
```

The translation is line-for-line. The Foundry `@transform` decorator maps to dbt's `{{ source() }}` and `{{ config() }}` macros. PySpark column operations become standard SQL.

### 3.3 Convert the orders transform

**After (dbt SQL model):** `models/staging/stg_orders.sql`

```sql
-- models/staging/stg_orders.sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('bronze', 'orders_raw') }}
),

cleaned as (
    select
        order_id,
        customer_id,
        order_date,
        order_amount,
        order_status,
        created_at
    from source
    where order_id is not null
      and order_amount > 0
)

select * from cleaned
```

### 3.4 Handle incremental logic

Foundry uses `@incremental` to process only new rows. dbt has an equivalent `incremental` materialization.

**Before (Foundry incremental):**

```python
@transform(
    orders_raw=Input("/datasets/raw/orders"),
    orders_clean=Output("/datasets/staging/orders_clean"),
)
@incremental()
def compute(orders_raw, orders_clean, ctx):
    df = orders_raw.dataframe("added")  # Only new rows
    # ... transform logic ...
    orders_clean.write_dataframe(df)
```

**After (dbt incremental):** `models/staging/stg_orders_incremental.sql`

```sql
-- models/staging/stg_orders_incremental.sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge'
) }}

with source as (
    select * from {{ source('bronze', 'orders_raw') }}
)

select
    order_id,
    customer_id,
    order_date,
    order_amount,
    order_status,
    created_at
from source
where order_id is not null
  and order_amount > 0

{% if is_incremental() %}
  -- Only process rows newer than the latest in the target table
  and created_at > (select max(created_at) from {{ this }})
{% endif %}
```

### 3.5 Replace Foundry Data Expectations with dbt tests

Foundry Data Expectations let you assert quality rules on pipeline outputs. dbt provides the same capability through schema tests and custom tests.

**Foundry Data Expectation (declarative):**

```python
# Foundry: applied via the Checks tab or in-code expectations
@check("customer_id is never null", on="customers_clean")
@check("email matches regex", on="customers_clean")
```

**dbt schema tests:** `models/staging/schema.yml`

```yaml
# models/staging/schema.yml
version: 2

sources:
    - name: bronze
      schema: bronze
      tables:
          - name: customers_raw
          - name: orders_raw

models:
    - name: stg_customers
      description: "Cleaned and deduplicated customer records"
      columns:
          - name: customer_id
            description: "Primary key"
            tests:
                - not_null
                - unique
          - name: email
            description: "Lowercase, trimmed email address"
            tests:
                - not_null

    - name: stg_orders
      description: "Validated order records"
      columns:
          - name: order_id
            tests:
                - not_null
                - unique
          - name: customer_id
            tests:
                - not_null
                - relationships:
                      to: ref('stg_customers')
                      field: customer_id
          - name: order_amount
            tests:
                - not_null
```

Run tests with:

```bash
dbt test
```

---

## Step 4: Set up the medallion architecture

### 4.1 Layer definitions

| Layer      | Purpose                                  | Managed by        | Naming convention                                               |
| ---------- | ---------------------------------------- | ----------------- | --------------------------------------------------------------- |
| **Bronze** | Raw ingestion, no transforms             | ADF Copy Activity | Tables named after source (`customers_raw`, `orders_raw`)       |
| **Silver** | Cleaned, validated, deduplicated         | dbt models        | `stg_` prefix (`stg_customers`, `stg_orders`)                   |
| **Gold**   | Business-ready aggregates and dimensions | dbt models        | `dim_` / `fact_` prefix (`dim_customers`, `fact_order_summary`) |

### 4.2 Build the gold layer models

**Customer dimension:** `models/gold/dim_customers.sql`

```sql
-- models/gold/dim_customers.sql
{{ config(materialized='table') }}

select
    customer_id,
    customer_name,
    email,
    phone,
    created_at,
    updated_at
from {{ ref('stg_customers') }}
```

**Order summary fact:** `models/gold/fact_order_summary.sql`

```sql
-- models/gold/fact_order_summary.sql
{{ config(materialized='table') }}

with orders as (
    select * from {{ ref('stg_orders') }}
),

customers as (
    select * from {{ ref('stg_customers') }}
)

select
    c.customer_id,
    c.email,
    c.customer_name,
    count(o.order_id)       as total_orders,
    sum(o.order_amount)     as total_revenue,
    avg(o.order_amount)     as avg_order_value,
    min(o.order_date)       as first_order_date,
    max(o.order_date)       as last_order_date
from orders o
inner join customers c
    on o.customer_id = c.customer_id
group by
    c.customer_id,
    c.email,
    c.customer_name
```

This replaces the Foundry `joined_order_summary` transform from Step 1.

### 4.3 dbt DAG structure

Your project directory should look like this:

```
customer_orders/
├── dbt_project.yml
├── models/
│   ├── staging/
│   │   ├── schema.yml
│   │   ├── stg_customers.sql
│   │   └── stg_orders.sql
│   └── gold/
│       ├── schema.yml
│       ├── dim_customers.sql
│       └── fact_order_summary.sql
└── tests/
    └── assert_revenue_positive.sql
```

The dependency graph (DAG) flows as:

```
bronze.customers_raw ──→ stg_customers ──→ dim_customers ──┐
                                                            ├──→ fact_order_summary
bronze.orders_raw ────→ stg_orders ────────────────────────┘
```

Run the full DAG with:

```bash
dbt run
```

---

## Step 5: Configure scheduling

### 5.1 ADF schedule trigger

Replace Foundry's cron scheduling with an ADF Schedule Trigger:

```json
{
    "name": "tr_daily_0200_utc",
    "properties": {
        "type": "ScheduleTrigger",
        "typeProperties": {
            "recurrence": {
                "frequency": "Day",
                "interval": 1,
                "startTime": "2025-01-01T02:00:00Z",
                "timeZone": "UTC"
            }
        },
        "pipelines": [
            {
                "pipelineReference": {
                    "referenceName": "pl_ingest_customer_orders",
                    "type": "PipelineReference"
                }
            }
        ]
    }
}
```

### 5.2 Dependency-based execution

In Foundry, transforms automatically run when upstream datasets are updated. In ADF, you chain activities using `dependsOn` and call dbt after ingestion completes.

Add a **Web Activity** or **Azure Batch Activity** to run dbt after the Copy Activities finish:

```json
{
    "name": "run_dbt_transforms",
    "type": "AzureBatch",
    "dependsOn": [
        {
            "activity": "copy_customers",
            "dependencyConditions": ["Succeeded"]
        },
        {
            "activity": "copy_orders",
            "dependencyConditions": ["Succeeded"]
        }
    ],
    "typeProperties": {
        "command": "dbt run --project-dir /mnt/dbt/customer_orders --profiles-dir /mnt/dbt/profiles",
        "resourceLinkedService": {
            "referenceName": "ls_azure_batch",
            "type": "LinkedServiceReference"
        }
    }
}
```

The complete pipeline flow in ADF becomes:

```
Trigger (02:00 UTC)
  ├── copy_customers (Copy Activity)
  ├── copy_orders (Copy Activity)
  └── run_dbt_transforms (depends on both copies succeeding)
```

### 5.3 Mapping Foundry scheduling to ADF

| Foundry scheduling feature                  | ADF equivalent                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Cron schedule                               | Schedule Trigger                                                               |
| Dependency-based (upstream dataset updated) | `dependsOn` with `Succeeded` condition                                         |
| Event trigger (file arrival)                | Storage Event Trigger or Custom Event Trigger                                  |
| Retry on failure                            | Activity-level retry policy (`"retryCount": 2, "retryIntervalInSeconds": 300`) |
| Manual trigger                              | ADF Studio "Trigger Now" or REST API call                                      |

---

## Step 6: Set up monitoring

### 6.1 ADF monitoring dashboard

ADF provides a built-in monitoring view at **ADF Studio > Monitor > Pipeline runs**. For each run you can see:

- Pipeline status (Succeeded, Failed, In Progress, Cancelled)
- Duration per activity
- Rows read and written
- Error messages on failure

### 6.2 dbt test results and source freshness

After each dbt run, capture test results to detect data quality issues:

```bash
# Run tests and capture results
dbt test --store-failures

# Check source freshness (replaces Foundry Health Checks)
dbt source freshness
```

Add freshness checks to your `schema.yml`:

```yaml
sources:
    - name: bronze
      schema: bronze
      freshness:
          warn_after: { count: 6, period: hour }
          error_after: { count: 12, period: hour }
      loaded_at_field: _loaded_at
      tables:
          - name: customers_raw
          - name: orders_raw
```

### 6.3 Azure Monitor alerts for pipeline failures

Create an alert rule that fires when any ADF pipeline fails:

```bash
# Create an action group for email notifications
az monitor action-group create \
  --resource-group rg-data-platform \
  --name ag-data-team \
  --short-name DataTeam \
  --email-receiver name=DataTeam email=data-team@example.com

# Create an alert rule for ADF pipeline failures
az monitor metrics alert create \
  --resource-group rg-data-platform \
  --name alert-adf-pipeline-failure \
  --scopes /subscriptions/{sub-id}/resourceGroups/rg-data-platform/providers/Microsoft.DataFactory/factories/adf-customer-orders \
  --condition "total PipelineFailedRuns > 0" \
  --window-size 5m \
  --evaluation-frequency 5m \
  --action ag-data-team \
  --description "Alert when ADF pipeline fails"
```

This replaces Foundry's built-in Health Checks and alert routing.

---

## Step 7: Validate data parity

Before decommissioning the Foundry pipeline, confirm that the Azure pipeline produces identical results.

### 7.1 Compare row counts

Query both systems and compare:

```sql
-- Azure: count rows in the gold table
SELECT COUNT(*) AS azure_row_count
FROM gold.fact_order_summary;

-- Compare against the Foundry dataset row count
-- (retrieve from Foundry's dataset preview or API)
```

| Metric                    | Foundry | Azure   | Match |
| ------------------------- | ------- | ------- | ----- |
| Row count (customers)     | 45,231  | 45,231  | Yes   |
| Row count (orders)        | 312,876 | 312,876 | Yes   |
| Row count (order_summary) | 45,231  | 45,231  | Yes   |

### 7.2 Compare key metrics

```sql
-- Azure: aggregate metrics
SELECT
    COUNT(DISTINCT customer_id) AS unique_customers,
    SUM(total_orders)           AS total_order_count,
    SUM(total_revenue)          AS total_revenue,
    AVG(avg_order_value)        AS avg_order_value
FROM gold.fact_order_summary;
```

| Metric            | Foundry        | Azure          | Variance |
| ----------------- | -------------- | -------------- | -------- |
| Unique customers  | 45,231         | 45,231         | 0%       |
| Total order count | 312,876        | 312,876        | 0%       |
| Total revenue     | $14,502,340.00 | $14,502,340.00 | 0%       |
| Avg order value   | $46.35         | $46.35         | 0%       |

### 7.3 Document reconciliation

Create a reconciliation checklist and sign off before cutting over:

- [ ] Row counts match across all three layers (bronze, silver, gold)
- [ ] Key aggregate metrics match within acceptable tolerance (< 0.01%)
- [ ] Data types are consistent between Foundry and Azure schemas
- [ ] Null handling produces identical results
- [ ] Incremental runs produce the same delta as Foundry
- [ ] Dashboard queries return identical visualizations

---

## Step 8: Deploy with CI/CD

### 8.1 GitHub Actions workflow for dbt

Create `.github/workflows/dbt-deploy.yml`:

```yaml
name: dbt Deploy

on:
    push:
        branches: [main]
        paths:
            - "dbt/customer_orders/**"

jobs:
    dbt-run:
        runs-on: ubuntu-latest
        environment: production

        steps:
            - name: Checkout repository
              uses: actions/checkout@v4

            - name: Set up Python
              uses: actions/setup-python@v5
              with:
                  python-version: "3.11"

            - name: Install dbt
              run: pip install dbt-sqlserver

            - name: Write dbt profiles
              run: |
                  mkdir -p ~/.dbt
                  cat <<EOF > ~/.dbt/profiles.yml
                  customer_orders:
                    target: prod
                    outputs:
                      prod:
                        type: sqlserver
                        driver: "ODBC Driver 18 for SQL Server"
                        server: ${{ secrets.SQL_SERVER }}
                        port: 1433
                        database: ${{ secrets.SQL_DATABASE }}
                        schema: analytics
                        authentication: ServicePrincipal
                        tenant_id: ${{ secrets.AZURE_TENANT_ID }}
                        client_id: ${{ secrets.AZURE_CLIENT_ID }}
                        client_secret: ${{ secrets.AZURE_CLIENT_SECRET }}
                  EOF

            - name: Run dbt
              run: |
                  cd dbt/customer_orders
                  dbt deps
                  dbt run --target prod
                  dbt test --target prod

            - name: Check source freshness
              run: |
                  cd dbt/customer_orders
                  dbt source freshness --target prod
```

### 8.2 ADF ARM template deployment

Export your ADF resources as ARM templates and deploy them through CI/CD:

```yaml
# Add to your GitHub Actions workflow or use a separate workflow
name: ADF Deploy

on:
    push:
        branches: [main]
        paths:
            - "infra/adf/**"

jobs:
    deploy-adf:
        runs-on: ubuntu-latest
        environment: production

        steps:
            - name: Checkout repository
              uses: actions/checkout@v4

            - name: Azure Login
              uses: azure/login@v2
              with:
                  creds: ${{ secrets.AZURE_CREDENTIALS }}

            - name: Deploy ADF ARM template
              uses: azure/arm-deploy@v2
              with:
                  resourceGroupName: rg-data-platform
                  template: infra/adf/arm-template.json
                  parameters: infra/adf/arm-template-parameters.json
```

---

## Complete flow summary

The following diagram shows the end-to-end flow after migration:

```
┌─────────────────────────────────────────────────────────────────┐
│                        ADF Pipeline                             │
│                                                                 │
│   Schedule Trigger (02:00 UTC)                                  │
│       │                                                         │
│       ├── Copy Activity: SFTP → ADLS Bronze (customers)         │
│       ├── Copy Activity: SFTP → ADLS Bronze (orders)            │
│       └── Azure Batch: dbt run (depends on both copies)         │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                        dbt Project                              │
│                                                                 │
│   Bronze (raw)         Silver (clean)         Gold (business)   │
│   ┌───────────┐       ┌───────────────┐      ┌──────────────┐  │
│   │customers_ │──────→│stg_customers  │─────→│dim_customers │  │
│   │raw        │       └───────────────┘   ┌─→│              │  │
│   └───────────┘                           │  └──────────────┘  │
│   ┌───────────┐       ┌───────────────┐   │  ┌──────────────┐  │
│   │orders_raw │──────→│stg_orders     │───┴─→│fact_order_   │  │
│   │           │       └───────────────┘      │summary       │  │
│   └───────────┘                              └──────┬───────┘  │
│                                                     │          │
├─────────────────────────────────────────────────────┼──────────┤
│                        Consumers                     │          │
│                                                     ▼          │
│                              Power BI / Dashboard Query         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick reference: Foundry to Azure mapping

| Foundry concept        | Azure equivalent                           | Notes                                                           |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Data Connection (sync) | ADF Copy Activity                          | Linked services replace Foundry connectors                      |
| `@transform` decorator | dbt SQL model                              | `{{ source() }}` and `{{ ref() }}` replace `Input()`/`Output()` |
| `@incremental`         | `{{ config(materialized='incremental') }}` | Use `{% if is_incremental() %}` for delta logic                 |
| Data Expectations      | dbt tests (`schema.yml`)                   | `not_null`, `unique`, `relationships`, custom tests             |
| Pipeline Builder       | ADF Studio canvas                          | Visual designer with JSON export                                |
| Cron scheduling        | ADF Schedule Trigger                       | Identical cron semantics                                        |
| Dependency triggers    | `dependsOn` in ADF activities              | Explicit dependency conditions                                  |
| Health Checks          | Azure Monitor + dbt source freshness       | Combined monitoring replaces single Foundry view                |
| Foundry secrets        | Azure Key Vault                            | Linked service references to Key Vault secrets                  |
| Quiver dashboard       | Power BI                                   | Connect directly to gold layer tables                           |

---

## Next steps

After completing this tutorial:

1. **Scale the pattern.** Apply the same bronze-silver-gold approach to additional Foundry pipelines in your organization.
2. **Add more data quality tests.** Expand `schema.yml` with custom tests for business rules specific to your domain.
3. **Enable incremental ingestion in ADF.** Use watermark columns or change data capture to avoid full reloads in the Copy Activity.
4. **Connect Power BI.** Point Power BI datasets at the gold layer tables to replace Foundry Quiver dashboards.
5. **Review the full migration guides.** See [Pipeline & Transform Migration](pipeline-migration.md) and [Data Integration Migration](data-integration-migration.md) for comprehensive coverage of all Foundry pipeline patterns.
