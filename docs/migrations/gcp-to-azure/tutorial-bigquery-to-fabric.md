# Tutorial: Migrate BigQuery Tables to Fabric / Databricks

**A hands-on, step-by-step walkthrough for data engineers migrating BigQuery datasets to Microsoft Fabric and Azure Databricks, using the csa-inabox medallion architecture.**

**Estimated time:** 4-6 hours (full pipeline); 1-2 hours (single table)
**Difficulty:** Intermediate
**GCP experience assumed:** BigQuery SQL, `bq` CLI, GCS basics

---

## Prerequisites

Before starting this tutorial, ensure you have the following:

| Requirement                    | Details                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **GCP project**                | With BigQuery datasets you intend to migrate; `roles/bigquery.dataViewer` and `roles/bigquery.jobUser` on the source project |
| **GCS bucket**                 | For staging Parquet exports; `roles/storage.objectAdmin` on the bucket                                                       |
| **`gcloud` CLI**               | Authenticated with `gcloud auth login` and project set via `gcloud config set project PROJECT_ID`                            |
| **`bq` CLI**                   | Bundled with `gcloud`; verify with `bq version`                                                                              |
| **Azure subscription**         | With permissions to create Storage Account, Databricks workspace, and Fabric capacity                                        |
| **ADLS Gen2 storage account**  | Provisioned with hierarchical namespace enabled                                                                              |
| **Azure Databricks workspace** | With Unity Catalog enabled; `CREATE CATALOG` / `CREATE SCHEMA` privileges                                                    |
| **AzCopy**                     | Installed locally or available in Cloud Shell; `azcopy --version`                                                            |
| **dbt Core**                   | `pip install dbt-databricks` (v1.7+)                                                                                         |
| **Git**                        | For version-controlling dbt models                                                                                           |

> **GCP comparison:** In BigQuery, storage and compute are billed separately but managed as one service. On Azure, ADLS Gen2 provides the storage layer and Databricks SQL provides the compute layer. The separation is explicit, which gives you more control over cost and scaling.

---

## Scenario

You are migrating a BigQuery project `acme-gov` containing:

- A `sales` dataset with `order_lines` (500 GB, partitioned by `order_date`, clustered by `region`)
- A `finance` dataset with `fact_sales_daily` (materialized via scheduled query) and dimension tables
- Scheduled queries that refresh `fact_sales_daily` at 02:00 UTC daily
- A Looker explore consuming the finance dataset (covered in the companion Looker tutorial)

By the end of this tutorial you will have these tables in Delta Lake on ADLS Gen2, queryable through Databricks SQL, with dbt models replacing BigQuery scheduled queries.

---

## Step 1: Inventory BigQuery datasets

Before exporting anything, build a complete inventory of what you are migrating.

### 1.1 List all datasets and tables

```bash
# List all datasets in the project
bq ls --project_id=acme-gov

# List all tables in a dataset with details
bq ls --format=prettyjson acme-gov:sales
bq ls --format=prettyjson acme-gov:finance
```

### 1.2 Collect table metadata

For each table, record the schema, row count, size, partitioning, and clustering:

```bash
# Get table schema and metadata
bq show --format=prettyjson acme-gov:sales.order_lines

# Get row count and size
bq query --nouse_legacy_sql \
  "SELECT table_id, row_count, size_bytes,
          ROUND(size_bytes / POW(1024, 3), 2) AS size_gb
   FROM \`acme-gov.sales.__TABLES__\`
   ORDER BY size_bytes DESC"
```

### 1.3 Identify partitioning and clustering

```bash
# Check partition and cluster columns
bq query --nouse_legacy_sql \
  "SELECT table_name, partition_column, clustering_columns
   FROM \`acme-gov.sales.INFORMATION_SCHEMA.TABLE_OPTIONS\`
   WHERE option_name IN ('partition_expiration_days',
                         'require_partition_filter')"

# Detailed partition info
bq query --nouse_legacy_sql \
  "SELECT table_name,
          column_name AS partition_column,
          data_type AS partition_type
   FROM \`acme-gov.sales.INFORMATION_SCHEMA.COLUMNS\`
   WHERE is_partitioning_column = 'YES'"
```

### 1.4 Build inventory spreadsheet

| Dataset | Table            | Rows | Size (GB) | Partition Column | Cluster Columns    | Scheduled Query   | Priority |
| ------- | ---------------- | ---- | --------- | ---------------- | ------------------ | ----------------- | -------- |
| sales   | order_lines      | 2.1B | 498       | order_date       | region, product_id | No                | High     |
| finance | fact_sales_daily | 45M  | 12        | sales_date       | region, product_id | Yes (daily 02:00) | High     |
| finance | dim_region       | 250  | 0.001     | --               | --                 | No                | Medium   |
| finance | dim_product      | 12K  | 0.01      | --               | --                 | No                | Medium   |
| finance | dim_date         | 36K  | 0.002     | --               | --                 | No                | Medium   |

> **GCP comparison:** BigQuery `INFORMATION_SCHEMA` views provide this metadata natively. On Azure, Unity Catalog `information_schema` provides equivalent catalog metadata once the tables land in Databricks.

---

## Step 2: Export BigQuery tables to GCS as Parquet

### 2.1 Create a staging GCS bucket

```bash
# Create a regional bucket near your BigQuery dataset
gsutil mb -l us-east4 -p acme-gov gs://acme-gov-migration-staging/
```

### 2.2 Export small tables (< 1 GB) with `bq extract`

```bash
# Export dimension tables as single Parquet files
bq extract \
  --destination_format=PARQUET \
  --compression=SNAPPY \
  acme-gov:finance.dim_region \
  gs://acme-gov-migration-staging/finance/dim_region/dim_region.parquet

bq extract \
  --destination_format=PARQUET \
  --compression=SNAPPY \
  acme-gov:finance.dim_product \
  gs://acme-gov-migration-staging/finance/dim_product/dim_product.parquet

bq extract \
  --destination_format=PARQUET \
  --compression=SNAPPY \
  acme-gov:finance.dim_date \
  gs://acme-gov-migration-staging/finance/dim_date/dim_date.parquet
```

### 2.3 Export large tables with `EXPORT DATA` (partition-aware)

For tables over 1 GB, use `EXPORT DATA` to export as sharded Parquet files, preserving partition structure:

```sql
-- Export order_lines partitioned by order_date
EXPORT DATA OPTIONS (
  uri = 'gs://acme-gov-migration-staging/sales/order_lines/*.parquet',
  format = 'PARQUET',
  compression = 'SNAPPY',
  overwrite = true
) AS
SELECT *
FROM `acme-gov.sales.order_lines`
WHERE order_date BETWEEN '2022-01-01' AND '2024-12-31';
```

For very large tables, export in date-range batches to control GCS costs and allow incremental transfer:

```bash
# Export year-by-year for 500 GB table
for YEAR in 2022 2023 2024; do
  bq query --nouse_legacy_sql \
    "EXPORT DATA OPTIONS (
       uri = 'gs://acme-gov-migration-staging/sales/order_lines/${YEAR}/*.parquet',
       format = 'PARQUET',
       compression = 'SNAPPY',
       overwrite = true
     ) AS
     SELECT *
     FROM \`acme-gov.sales.order_lines\`
     WHERE order_date >= '${YEAR}-01-01'
       AND order_date < '$((YEAR+1))-01-01'"
done
```

### 2.4 Verify exports

```bash
# Check file count and total size
gsutil du -sh gs://acme-gov-migration-staging/sales/order_lines/
gsutil ls -l gs://acme-gov-migration-staging/finance/dim_region/
```

> **GCP comparison:** BigQuery's `EXPORT DATA` writes Parquet natively. This is the cleanest exit path because Parquet is already the base format for Delta Lake. There is no proprietary format conversion.

---

## Step 3: Transfer GCS to ADLS Gen2

You have three options. Choose based on volume and network constraints.

### Option A: AzCopy with GCS interop (recommended for < 5 TB)

```bash
# Authenticate AzCopy to Azure
azcopy login --tenant-id <TENANT_ID>

# Generate a GCS HMAC key (Settings > Interoperability in GCS console)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json

# Copy from GCS to ADLS Gen2
azcopy copy \
  "https://storage.googleapis.com/acme-gov-migration-staging/sales/" \
  "https://<STORAGE_ACCOUNT>.dfs.core.windows.net/bronze/sales/" \
  --recursive \
  --s2s-preserve-properties=false
```

### Option B: ADF Copy Activity (recommended for automation and > 5 TB)

Create an ADF pipeline with a Copy Activity:

1. **Source:** Google Cloud Storage linked service (service account key)
2. **Sink:** ADLS Gen2 linked service (managed identity)
3. **Format:** Parquet (source) to Parquet (sink)
4. **Parallelism:** Set DIU to 16-64 depending on volume

```json
{
    "name": "copy_gcs_to_adls",
    "type": "Copy",
    "typeProperties": {
        "source": {
            "type": "ParquetSource",
            "storeSettings": {
                "type": "GoogleCloudStorageReadSettings",
                "recursive": true
            }
        },
        "sink": {
            "type": "ParquetSink",
            "storeSettings": {
                "type": "AzureBlobFSWriteSettings"
            }
        }
    }
}
```

### Option C: Google Transfer Appliance + Azure Data Box (for > 50 TB)

For very large datasets where network transfer is impractical:

1. Request Google Transfer Appliance to export from GCS to a physical appliance
2. Ship to Azure datacenter region
3. Use Azure Data Box to ingest into ADLS Gen2
4. Estimated timeline: 2-4 weeks for physical transfer

### 3.1 Verify transfer

```bash
# Check file count and sizes on ADLS Gen2
az storage fs file list \
  --account-name <STORAGE_ACCOUNT> \
  --file-system bronze \
  --path sales/order_lines \
  --query "[].{name:name, size:contentLength}" \
  --output table
```

> **GCP comparison:** GCS egress charges apply during transfer. Budget approximately $0.12/GB for standard egress from GCS to Azure. OneLake shortcuts can serve as a zero-egress bridge during migration if you need to query GCS data from Azure without copying it first.

---

## Step 4: Create Delta tables in Databricks from Parquet files

### 4.1 Create Unity Catalog structure

```sql
-- Create a catalog mirroring the BigQuery project
CREATE CATALOG IF NOT EXISTS acme_gov;

-- Create schemas mirroring BigQuery datasets
CREATE SCHEMA IF NOT EXISTS acme_gov.sales;
CREATE SCHEMA IF NOT EXISTS acme_gov.finance;
```

### 4.2 Create Delta tables from Parquet (small tables)

```sql
-- Dimension tables: direct CTAS from Parquet
CREATE TABLE acme_gov.finance.dim_region
USING DELTA
AS SELECT * FROM parquet.`abfss://bronze@<STORAGE>.dfs.core.windows.net/finance/dim_region/`;

CREATE TABLE acme_gov.finance.dim_product
USING DELTA
AS SELECT * FROM parquet.`abfss://bronze@<STORAGE>.dfs.core.windows.net/finance/dim_product/`;

CREATE TABLE acme_gov.finance.dim_date
USING DELTA
AS SELECT * FROM parquet.`abfss://bronze@<STORAGE>.dfs.core.windows.net/finance/dim_date/`;
```

### 4.3 Create partitioned Delta table (large tables)

```sql
-- Create order_lines with partition matching BigQuery
CREATE TABLE acme_gov.sales.order_lines
USING DELTA
PARTITIONED BY (order_date)
AS SELECT * FROM parquet.`abfss://bronze@<STORAGE>.dfs.core.windows.net/sales/order_lines/`;

-- Apply Z-ordering (BigQuery clustering equivalent)
OPTIMIZE acme_gov.sales.order_lines
ZORDER BY (region, product_id);
```

### 4.4 Validate row counts

```sql
-- Compare against BigQuery inventory from Step 1
SELECT 'order_lines' AS table_name, COUNT(*) AS row_count
FROM acme_gov.sales.order_lines
UNION ALL
SELECT 'dim_region', COUNT(*) FROM acme_gov.finance.dim_region
UNION ALL
SELECT 'dim_product', COUNT(*) FROM acme_gov.finance.dim_product
UNION ALL
SELECT 'dim_date', COUNT(*) FROM acme_gov.finance.dim_date;
```

> **GCP comparison:** BigQuery partitions by date columns natively in DDL. In Databricks, `PARTITIONED BY` handles the partition column, while `OPTIMIZE ... ZORDER BY` replaces BigQuery's `CLUSTER BY` for query acceleration. Z-ordering is a post-write optimization rather than a DDL declaration.

---

## Step 5: Convert BigQuery SQL to dbt models

### 5.1 Initialize dbt project

```bash
dbt init acme_gov_analytics
cd acme_gov_analytics
```

Configure `profiles.yml` for Databricks:

```yaml
acme_gov_analytics:
    target: dev
    outputs:
        dev:
            type: databricks
            catalog: acme_gov
            schema: finance
            host: <DATABRICKS_HOST>
            http_path: /sql/1.0/warehouses/<WAREHOUSE_ID>
            token: "{{ env_var('DBT_DATABRICKS_TOKEN') }}"
            threads: 4
```

### 5.2 Create staging models

Port the BigQuery scheduled query to a dbt incremental model:

**`models/gold/fact_sales_daily.sql`**

```sql
{{ config(
    materialized='incremental',
    unique_key=['sales_date', 'region', 'product_id'],
    incremental_strategy='merge',
    partition_by=['sales_date'],
    tblproperties={
      'delta.autoOptimize.autoCompact': 'true',
      'delta.autoOptimize.optimizeWrite': 'true'
    }
) }}

SELECT
  DATE(order_ts) AS sales_date,
  region,
  product_id,
  SUM(quantity) AS units_sold,
  SUM(gross_amount) AS gross_amount
FROM {{ source('sales', 'order_lines') }}
{% if is_incremental() %}
WHERE DATE(order_ts) >= DATE_SUB(CURRENT_DATE(), 3)
{% endif %}
GROUP BY 1, 2, 3
```

### 5.3 Add schema tests

**`models/gold/schema.yml`**

```yaml
version: 2

models:
    - name: fact_sales_daily
      description: "Daily sales rollup by region and product"
      columns:
          - name: sales_date
            tests:
                - not_null
          - name: region
            tests:
                - not_null
          - name: product_id
            tests:
                - not_null
          - name: units_sold
            tests:
                - not_null
          - name: gross_amount
            tests:
                - not_null
```

### 5.4 Run and test

```bash
dbt run --select fact_sales_daily
dbt test --select fact_sales_daily
```

---

## Step 6: Set up scheduling

### 6.1 Replace BigQuery scheduled queries with Databricks Workflows

BigQuery scheduled queries run in the BigQuery UI with a cron expression. The Databricks equivalent is a Workflow job with a schedule trigger.

**Databricks Workflow JSON (via REST API or Terraform):**

```json
{
    "name": "daily_sales_rollup",
    "tasks": [
        {
            "task_key": "dbt_run",
            "description": "Run dbt fact_sales_daily model",
            "new_cluster": {
                "spark_version": "14.3.x-scala2.12",
                "node_type_id": "Standard_D4s_v3",
                "num_workers": 2
            },
            "libraries": [{ "pypi": { "package": "dbt-databricks==1.7.0" } }],
            "python_wheel_task": {
                "package_name": "dbt",
                "entry_point": "main",
                "parameters": ["run", "--select", "fact_sales_daily"]
            }
        }
    ],
    "schedule": {
        "quartz_cron_expression": "0 0 2 * * ?",
        "timezone_id": "UTC"
    }
}
```

### 6.2 Alternative: ADF trigger for cross-system orchestration

If you need to coordinate dbt runs with Power BI refresh or Fabric pipelines:

```json
{
    "name": "tr_daily_sales_pipeline",
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
                    "referenceName": "pl_daily_sales_refresh",
                    "type": "PipelineReference"
                }
            }
        ]
    }
}
```

| BigQuery scheduling        | Azure equivalent                     | Notes                                 |
| -------------------------- | ------------------------------------ | ------------------------------------- |
| Scheduled query (cron)     | Databricks Workflow schedule         | 1:1 mapping; cron syntax is identical |
| Scheduled query (interval) | ADF Schedule Trigger                 | For cross-service orchestration       |
| On-demand refresh          | Databricks Job API / ADF trigger now | REST API or portal                    |

---

## Step 7: Create Power BI report with Direct Lake

### 7.1 Create a Fabric lakehouse shortcut to Delta tables

In the Fabric portal:

1. Open your Fabric workspace
2. Create a new Lakehouse (or use existing)
3. Navigate to **Get Data > New shortcut > Azure Data Lake Storage Gen2**
4. Point to `abfss://gold@<STORAGE>.dfs.core.windows.net/finance/`
5. The Delta tables appear as tables in the lakehouse

### 7.2 Create a Direct Lake semantic model

1. From the lakehouse, select **New semantic model**
2. Select the fact and dimension tables: `fact_sales_daily`, `dim_region`, `dim_product`, `dim_date`
3. Define relationships:
    - `fact_sales_daily[region]` to `dim_region[region_id]`
    - `fact_sales_daily[product_id]` to `dim_product[product_id]`
    - `fact_sales_daily[sales_date]` to `dim_date[date_key]`

### 7.3 Add DAX measures

```dax
Units Sold = SUM(fact_sales_daily[units_sold])

Gross Revenue = SUM(fact_sales_daily[gross_amount])

Avg Revenue Per Unit = DIVIDE([Gross Revenue], [Units Sold], 0)

YoY Revenue Growth =
VAR CurrentYear = [Gross Revenue]
VAR PriorYear = CALCULATE([Gross Revenue], SAMEPERIODLASTYEAR(dim_date[date_key]))
RETURN DIVIDE(CurrentYear - PriorYear, PriorYear, 0)
```

> **GCP comparison:** Direct Lake reads Delta files directly from OneLake without importing data into a separate cache. This is conceptually similar to BigQuery BI Engine, which provides an in-memory acceleration layer. The key difference is that Direct Lake works over open Delta format, whereas BI Engine is tightly coupled to BigQuery storage.

---

## Step 8: Validate query results match

### 8.1 Run identical aggregation queries on both platforms

**BigQuery:**

```sql
SELECT
  region,
  SUM(units_sold) AS total_units,
  SUM(gross_amount) AS total_revenue,
  COUNT(*) AS row_count
FROM `acme-gov.finance.fact_sales_daily`
WHERE sales_date BETWEEN '2024-01-01' AND '2024-12-31'
GROUP BY region
ORDER BY region;
```

**Databricks SQL:**

```sql
SELECT
  region,
  SUM(units_sold) AS total_units,
  SUM(gross_amount) AS total_revenue,
  COUNT(*) AS row_count
FROM acme_gov.finance.fact_sales_daily
WHERE sales_date BETWEEN '2024-01-01' AND '2024-12-31'
GROUP BY region
ORDER BY region;
```

### 8.2 Reconciliation checklist

- [ ] Row counts match per table (tolerance: 0%)
- [ ] Aggregate sums match (tolerance: < 0.01% for floating-point rounding)
- [ ] Partition pruning works (check query plan with `EXPLAIN`)
- [ ] Z-order accelerates filtered queries (compare scan sizes)
- [ ] dbt incremental runs produce correct delta
- [ ] Power BI report matches Looker dashboard numbers

---

## BigQuery SQL to Databricks SQL conversion reference

This table covers the 20+ most common patterns that need conversion during migration.

### Data types

| BigQuery                    | Databricks SQL                                   | Notes                                                          |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `INT64`                     | `BIGINT`                                         | Direct rename                                                  |
| `FLOAT64`                   | `DOUBLE`                                         | Direct rename                                                  |
| `NUMERIC` / `BIGNUMERIC`    | `DECIMAL(38, 18)`                                | Specify precision explicitly                                   |
| `BOOL`                      | `BOOLEAN`                                        | Direct rename                                                  |
| `STRING`                    | `STRING`                                         | Identical                                                      |
| `BYTES`                     | `BINARY`                                         | Direct rename                                                  |
| `DATE`                      | `DATE`                                           | Identical                                                      |
| `DATETIME`                  | `TIMESTAMP_NTZ`                                  | BigQuery DATETIME has no timezone; use `TIMESTAMP_NTZ`         |
| `TIMESTAMP`                 | `TIMESTAMP`                                      | Both are UTC-aware                                             |
| `TIME`                      | `STRING` (workaround)                            | Databricks lacks native TIME type; store as string or interval |
| `GEOGRAPHY`                 | `STRING` (WKT)                                   | Use Mosaic or H3 libraries for geospatial in Databricks        |
| `STRUCT<a INT64, b STRING>` | `STRUCT<a: BIGINT, b: STRING>`                   | Colon syntax differs                                           |
| `ARRAY<STRING>`             | `ARRAY<STRING>`                                  | Identical                                                      |
| `JSON`                      | `STRING` with `from_json()` / `schema_of_json()` | Parse at read time                                             |

### Functions

| BigQuery StandardSQL             | Databricks SQL                                | Notes                                          |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `DATE_SUB(d, INTERVAL 3 DAY)`    | `DATE_SUB(d, 3)`                              | No `INTERVAL` keyword in Databricks            |
| `DATE_ADD(d, INTERVAL 3 DAY)`    | `DATE_ADD(d, 3)`                              | Same pattern                                   |
| `DATE_DIFF(d1, d2, DAY)`         | `DATEDIFF(d1, d2)`                            | Different name and arg order                   |
| `TIMESTAMP_DIFF(t1, t2, SECOND)` | `TIMESTAMPDIFF(SECOND, t2, t1)`               | Arg order reversed                             |
| `FORMAT_DATE('%Y-%m', d)`        | `DATE_FORMAT(d, 'yyyy-MM')`                   | Java-style format codes                        |
| `FORMAT_TIMESTAMP(...)`          | `DATE_FORMAT(CAST(t AS TIMESTAMP), ...)`      | Same pattern                                   |
| `PARSE_DATE('%Y%m%d', s)`        | `TO_DATE(s, 'yyyyMMdd')`                      | Function name differs                          |
| `PARSE_TIMESTAMP(...)`           | `TO_TIMESTAMP(s, fmt)`                        | Function name differs                          |
| `SAFE_CAST(x AS INT64)`          | `TRY_CAST(x AS BIGINT)`                       | `SAFE_` prefix becomes `TRY_`                  |
| `SAFE_DIVIDE(a, b)`              | `TRY_DIVIDE(a, b)` or `a / NULLIF(b, 0)`      | `SAFE_` becomes `TRY_`                         |
| `IFNULL(a, b)`                   | `COALESCE(a, b)` or `IFNULL(a, b)`            | Both work in Databricks                        |
| `ARRAY_AGG(x)`                   | `COLLECT_LIST(x)`                             | Different name                                 |
| `ARRAY_AGG(DISTINCT x)`          | `COLLECT_SET(x)`                              | Set-based for distinct                         |
| `UNNEST(arr)`                    | `EXPLODE(arr)`                                | `LATERAL VIEW EXPLODE()` or inline `EXPLODE()` |
| `GENERATE_DATE_ARRAY(...)`       | `SEQUENCE(start, stop, INTERVAL 1 DAY)`       | Different name                                 |
| `STRING_AGG(x, ',')`             | `CONCAT_WS(',', COLLECT_LIST(x))`             | Two-step in Databricks                         |
| `REGEXP_EXTRACT(s, r)`           | `REGEXP_EXTRACT(s, r, 0)`                     | Add group index explicitly                     |
| `REGEXP_CONTAINS(s, r)`          | `s RLIKE r`                                   | Operator syntax in Databricks                  |
| `STARTS_WITH(s, prefix)`         | `s LIKE 'prefix%'` or `STARTSWITH(s, prefix)` | DBR 13.3+ has `STARTSWITH`                     |
| `ENDS_WITH(s, suffix)`           | `s LIKE '%suffix'` or `ENDSWITH(s, suffix)`   | DBR 13.3+ has `ENDSWITH`                       |

### DDL and DML patterns

| BigQuery                                                         | Databricks SQL                                                                         | Notes                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| `CREATE OR REPLACE TABLE ... PARTITION BY col CLUSTER BY c1, c2` | `CREATE OR REPLACE TABLE ... PARTITIONED BY (col)` + `OPTIMIZE ... ZORDER BY (c1, c2)` | Clustering is a post-write operation |
| `MERGE INTO t USING s ON ...`                                    | `MERGE INTO t USING s ON ...`                                                          | Identical syntax                     |
| `INSERT INTO t SELECT ...`                                       | `INSERT INTO t SELECT ...`                                                             | Identical                            |
| `EXPORT DATA OPTIONS(...)`                                       | `COPY INTO` or DataFrame API                                                           | Different export idiom               |
| `CREATE MATERIALIZED VIEW`                                       | `CREATE MATERIALIZED VIEW` (Databricks) or dbt incremental                             | Available in Databricks SQL          |
| `@@project_id`                                                   | `current_catalog()`                                                                    | Session context                      |
| `@@dataset_id`                                                   | `current_schema()`                                                                     | Session context                      |
| Implicit comma cross-join `FROM a, b`                            | Explicit `CROSS JOIN` required                                                         | Edit-heavy but safer                 |

---

## Next steps

After completing this tutorial:

1. **Migrate remaining datasets.** Apply the same pattern to additional BigQuery datasets, working through your inventory from Step 1.
2. **Set up Auto Loader for ongoing ingestion.** If GCS still receives new data during the bridge period, configure Databricks Auto Loader to continuously ingest from OneLake shortcuts.
3. **Port Looker explores.** See [Tutorial: Convert Looker/LookML to Power BI](tutorial-looker-to-powerbi.md) for the semantic-model migration.
4. **Implement data contracts.** Ship a `contract.yaml` per data product following the pattern in `domains/finance/data-products/invoices/contract.yaml`.
5. **Review the migration playbook.** See [GCP to Azure Migration Playbook](../gcp-to-azure.md) for the full phased project plan.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Playbook](../gcp-to-azure.md) | [Looker to Power BI Tutorial](tutorial-looker-to-powerbi.md) | [Benchmarks](benchmarks.md) | [Best Practices](best-practices.md)
