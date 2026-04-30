# ETL Migration: Glue to ADF, dbt, and Purview

**A deep-dive guide for data engineers migrating AWS Glue ETL pipelines, crawlers, and the Glue Data Catalog to Azure Data Factory, dbt, and Microsoft Purview.**

---

## Executive summary

AWS Glue is three things in one: a metadata catalog (Glue Data Catalog), an ETL engine (Glue Jobs), and a schema discovery tool (Glue Crawlers). On Azure, these responsibilities split across purpose-built services: Azure Data Factory handles orchestration and data movement, dbt handles transformation logic, Unity Catalog manages runtime metadata, and Purview provides enterprise governance, classification, and lineage. This decomposition trades Glue's single-service simplicity for deeper capability in each function.

This guide covers each Glue component, its Azure equivalent, migration patterns, and worked examples including a full Glue PySpark job converted to a dbt SQL model.

---

## Component mapping overview

| Glue component          | Primary Azure equivalent                         | Secondary option            | Notes                                            |
| ----------------------- | ------------------------------------------------ | --------------------------- | ------------------------------------------------ |
| Glue Data Catalog       | Unity Catalog (runtime) + Purview (business)     | N/A                         | Unity Catalog for Spark; Purview for governance  |
| Glue ETL Jobs (PySpark) | Databricks Jobs + dbt models                     | ADF Data Flows              | dbt for SQL logic; Databricks for PySpark        |
| Glue Python Shell       | Azure Functions                                  | Databricks lightweight task | Serverless for lightweight jobs                  |
| Glue Crawlers           | Purview scan jobs + Auto Loader schema inference | N/A                         | Purview for governance; Auto Loader for runtime  |
| Glue Studio (visual)    | ADF visual pipeline designer                     | Fabric Data Factory         | Visual ETL in ADF; logic in dbt                  |
| Glue Streaming          | Databricks Structured Streaming                  | Stream Analytics            | Delta Live Tables for streaming ETL              |
| Glue DataBrew           | Power Query in Fabric                            | dbt                         | Visual prep in Power Query; SQL in dbt           |
| Glue Data Quality       | dbt tests + Great Expectations                   | data-product contracts      | Contract-driven quality                          |
| Glue Workflows          | ADF pipeline orchestration                       | Databricks Workflows        | ADF for cross-service; Databricks for Spark-only |
| Step Functions          | ADF pipeline + Logic Apps                        | Durable Functions           | ADF for data; Logic Apps for integration         |

---

## Part 1: Glue Data Catalog to Unity Catalog and Purview

### Architecture comparison

**Glue Data Catalog:**

- Stores database, table, and partition metadata
- Integrated with Athena, EMR, Redshift Spectrum
- Per-account, per-region (not global)
- No built-in classification, lineage, or business glossary
- Lake Formation layered on top for access control

**Unity Catalog:**

- Three-level namespace: catalog.schema.table
- Integrated with Databricks SQL, Jobs, ML
- Cross-workspace (organization-wide)
- Built-in access control (grants, row filters, column masks)
- Lineage tracking for tables, columns, and notebooks

**Purview:**

- Enterprise-wide data catalog and governance
- Classification (PII, PHI, financial, government)
- Business glossary with term relationships
- Lineage across ADF, Databricks, Power BI
- Scan sources: ADLS, SQL, Databricks, S3 (cross-cloud)

### Migration approach

```
Glue Data Catalog
  ├── databases → Unity Catalog catalogs
  ├── tables → Unity Catalog tables (managed or external)
  ├── partitions → Delta partitions (auto-managed)
  └── metadata → Purview glossary terms + classifications
```

**Step 1: Export Glue Catalog metadata**

```bash
# Export all databases
aws glue get-databases --output json > glue_databases.json

# Export tables per database
for db in $(cat glue_databases.json | jq -r '.DatabaseList[].Name'); do
  aws glue get-tables --database-name $db --output json > "glue_tables_${db}.json"
done

# Export partitions for partitioned tables
aws glue get-partitions \
  --database-name sales \
  --table-name fact_orders \
  --output json > glue_partitions_sales_fact_orders.json
```

**Step 2: Create Unity Catalog structure**

```sql
-- Create catalog (one per Glue database or per domain)
CREATE CATALOG IF NOT EXISTS sales_prod;
USE CATALOG sales_prod;

-- Create schemas
CREATE SCHEMA IF NOT EXISTS bronze COMMENT 'Raw ingested data';
CREATE SCHEMA IF NOT EXISTS silver COMMENT 'Cleaned and conformed data';
CREATE SCHEMA IF NOT EXISTS gold   COMMENT 'Business-ready aggregates';

-- Register external location for existing ADLS data
CREATE EXTERNAL LOCATION IF NOT EXISTS sales_raw
  URL 'abfss://raw@acmeanalyticsgov.dfs.core.usgovcloudapi.net/sales/'
  WITH (STORAGE CREDENTIAL sales_credential);
```

**Step 3: Register Purview governance**

```python
# Purview scan configuration (via purview_automation.py pattern)
# Cross-reference: csa_platform/csa_platform/governance/purview/purview_automation.py

scan_config = {
    "name": "scan-databricks-sales",
    "kind": "AzureDatabricks",
    "properties": {
        "scanRulesetName": "default",
        "collection": {
            "referenceName": "sales-domain"
        }
    }
}
```

---

## Part 2: Glue Jobs to Databricks Jobs and dbt

### Decision matrix: which target?

| Glue job type                         | Target                          | Reasoning                               |
| ------------------------------------- | ------------------------------- | --------------------------------------- |
| PySpark job doing SQL transforms      | dbt SQL model                   | SQL is more testable and versionable    |
| PySpark job with complex Python logic | Databricks notebook/job         | Preserve PySpark; update paths          |
| Python Shell job (lightweight)        | Azure Function                  | Serverless, no cluster overhead         |
| Glue streaming job                    | Databricks Structured Streaming | Delta Live Tables for managed streaming |
| Glue visual job (Studio)              | ADF Data Flow or dbt            | Depends on complexity                   |

### Worked example: Glue PySpark job to dbt SQL model

**Original Glue PySpark job:**

```python
import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from awsglue.context import GlueContext
from pyspark.context import SparkContext
from awsglue.job import Job

args = getResolvedOptions(sys.argv, ['JOB_NAME', 'run_date'])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# Read from Glue Catalog
orders_dyf = glueContext.create_dynamic_frame.from_catalog(
    database="sales",
    table_name="raw_orders"
)
orders_df = orders_dyf.toDF()

# Filter and transform
from pyspark.sql.functions import col, sum as spark_sum, date_format, current_timestamp

daily_sales = orders_df \
    .filter(col("order_date") == args['run_date']) \
    .groupBy("region", "product_id") \
    .agg(
        spark_sum("quantity").alias("total_units"),
        spark_sum("gross_amount").alias("total_revenue")
    ) \
    .withColumn("sales_date", col("order_date")) \
    .withColumn("etl_timestamp", current_timestamp())

# Write back to Glue Catalog
daily_sales.write \
    .mode("overwrite") \
    .format("parquet") \
    .partitionBy("sales_date") \
    .saveAsTable("sales.fact_sales_daily")

job.commit()
```

**Migrated dbt SQL model:**

```sql
-- models/gold/fact_sales_daily.sql
{{ config(
    materialized='incremental',
    unique_key=['sales_date', 'region', 'product_id'],
    incremental_strategy='merge',
    partition_by=['sales_date'],
    tags=['daily', 'sales']
) }}

WITH source_orders AS (
    SELECT
        order_date AS sales_date,
        region,
        product_id,
        quantity,
        gross_amount
    FROM {{ ref('stg_orders') }}
    {% if is_incremental() %}
    WHERE order_date >= DATE_SUB(CURRENT_DATE(), 3)
    {% endif %}
)

SELECT
    sales_date,
    region,
    product_id,
    SUM(quantity) AS total_units,
    SUM(gross_amount) AS total_revenue,
    CURRENT_TIMESTAMP() AS etl_timestamp
FROM source_orders
GROUP BY sales_date, region, product_id
```

**dbt test for the model:**

```yaml
# models/gold/schema.yml
models:
    - name: fact_sales_daily
      description: "Daily sales aggregation by region and product"
      columns:
          - name: sales_date
            tests:
                - not_null
          - name: region
            tests:
                - not_null
                - accepted_values:
                      values: ["EAST", "WEST", "CENTRAL", "SOUTH"]
          - name: total_units
            tests:
                - not_null
                - dbt_utils.expression_is_true:
                      expression: ">= 0"
          - name: total_revenue
            tests:
                - not_null
                - dbt_utils.expression_is_true:
                      expression: ">= 0"
```

**What changed:**

1. Glue `DynamicFrame` / `GlueContext` removed; replaced by dbt `ref()` and SQL.
2. PySpark DataFrame operations expressed as SQL GROUP BY.
3. S3/Parquet write replaced by Delta Lake incremental merge.
4. Data quality checks added as dbt tests (not possible in Glue without custom code).
5. Lineage automatically tracked by dbt and visible in Purview.

---

## Part 3: Glue Crawlers to Purview and Auto Loader

### Glue Crawlers: what they do

Glue Crawlers scan data sources (S3, JDBC), infer schemas, and register tables in the Glue Data Catalog. They run on a schedule and detect schema changes.

### Azure equivalents

**Purview scan jobs (governance discovery):**

```json
{
    "name": "scan-adls-raw",
    "kind": "AdlsGen2",
    "properties": {
        "scanRulesetName": "AdlsGen2DefaultScanRuleSet",
        "collection": { "referenceName": "raw-data-collection" },
        "credential": { "referenceName": "managed-identity-credential" },
        "endpoint": "https://acmeanalyticsgov.dfs.core.usgovcloudapi.net/",
        "resourceTypes": { "AdlsGen2": { "scanRulesetType": "System" } }
    }
}
```

Purview scans discover assets, classify columns (PII, PHI), and build lineage graphs. They are the governance equivalent of crawlers.

**Databricks Auto Loader (runtime schema inference):**

```python
# Auto Loader: stream new files from ADLS, infer schema, write to Delta
(spark.readStream
  .format("cloudFiles")
  .option("cloudFiles.format", "json")
  .option("cloudFiles.schemaLocation", "dbfs:/schemas/raw_events")
  .option("cloudFiles.inferColumnTypes", "true")
  .option("cloudFiles.schemaEvolutionMode", "addNewColumns")
  .load("abfss://raw@acmeanalyticsgov.dfs.core.usgovcloudapi.net/events/")
  .writeStream
  .format("delta")
  .option("checkpointLocation", "dbfs:/checkpoints/raw_events")
  .option("mergeSchema", "true")
  .trigger(availableNow=True)
  .toTable("events_prod.bronze.raw_events"))
```

Auto Loader provides runtime schema evolution --- it detects new columns in source files and evolves the Delta table schema automatically. This is more capable than Glue Crawlers for streaming/semi-structured ingestion.

---

## Part 4: Glue Studio to ADF visual pipelines

### ADF pipeline structure

```json
{
    "name": "pipeline_daily_sales_etl",
    "properties": {
        "activities": [
            {
                "name": "RunDbtSalesModels",
                "type": "DatabricksNotebook",
                "typeProperties": {
                    "notebookPath": "/Repos/analytics/sales/run_dbt",
                    "baseParameters": {
                        "dbt_command": "dbt run --select tag:daily"
                    }
                },
                "linkedServiceName": {
                    "referenceName": "AzureDatabricksLinkedService",
                    "type": "LinkedServiceReference"
                }
            },
            {
                "name": "RunDbtTests",
                "type": "DatabricksNotebook",
                "dependsOn": [
                    {
                        "activity": "RunDbtSalesModels",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "notebookPath": "/Repos/analytics/sales/run_dbt",
                    "baseParameters": {
                        "dbt_command": "dbt test --select tag:daily"
                    }
                },
                "linkedServiceName": {
                    "referenceName": "AzureDatabricksLinkedService",
                    "type": "LinkedServiceReference"
                }
            },
            {
                "name": "RefreshPowerBIDataset",
                "type": "WebActivity",
                "dependsOn": [
                    {
                        "activity": "RunDbtTests",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "url": "https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/datasets/{dataset_id}/refreshes",
                    "method": "POST",
                    "authentication": {
                        "type": "MSI",
                        "resource": "https://analysis.windows.net/powerbi/api"
                    }
                }
            }
        ],
        "parameters": {
            "run_date": { "type": "string", "defaultValue": "" }
        }
    }
}
```

---

## Part 5: Step Functions to ADF pipeline orchestration

### Architecture comparison

| Step Functions concept | ADF equivalent                         | Notes                              |
| ---------------------- | -------------------------------------- | ---------------------------------- |
| State machine          | Pipeline                               | Visual orchestration               |
| Task state             | Activity                               | Execute an action                  |
| Choice state           | If Condition activity                  | Branching logic                    |
| Parallel state         | ForEach (parallel)                     | Concurrent execution               |
| Wait state             | Wait activity                          | Time-based delay                   |
| Map state              | ForEach activity                       | Iterate over collection            |
| Fail/Succeed state     | Fail activity / pipeline success       | Terminal states                    |
| Retry/Catch            | Activity retry policy + error handling | Built-in retry with backoff        |
| Step Functions Express | ADF with Durable Functions             | High-volume, short-lived workflows |

### Connection management: Glue connections to ADF Linked Services

| Glue connection type | ADF linked service     | Key Vault integration          |
| -------------------- | ---------------------- | ------------------------------ |
| JDBC (PostgreSQL)    | AzurePostgreSql        | Connection string in Key Vault |
| JDBC (MySQL)         | MySql                  | Connection string in Key Vault |
| JDBC (SQL Server)    | SqlServer              | Connection string in Key Vault |
| JDBC (Redshift)      | AmazonRedshift         | Connection string in Key Vault |
| S3                   | AmazonS3               | Access key/secret in Key Vault |
| DynamoDB             | AmazonDynamoDB         | Access key/secret in Key Vault |
| Kafka (MSK)          | N/A --- use Event Hubs | Kafka endpoint in connection   |
| Custom (REST API)    | RestService            | API key/token in Key Vault     |

**Key Vault integration pattern:**

```json
{
    "name": "PostgreSQLLinkedService",
    "type": "AzurePostgreSql",
    "typeProperties": {
        "connectionString": {
            "type": "AzureKeyVaultSecret",
            "store": {
                "referenceName": "KeyVaultLinkedService",
                "type": "LinkedServiceReference"
            },
            "secretName": "postgres-connection-string"
        }
    }
}
```

Cross-reference: `domains/shared/pipelines/adf/` for ADF pipeline patterns; ADR-0001 `docs/adr/0001-adf-dbt-over-airflow.md` for the ADF + dbt architecture decision.

---

## Part 6: Glue Data Quality to dbt tests and contracts

### Migration mapping

| Glue Data Quality rule               | dbt equivalent                 | Notes                            |
| ------------------------------------ | ------------------------------ | -------------------------------- |
| `ColumnExists "col_name"`            | `schema.yml` column definition | Schema enforcement at build time |
| `IsComplete "col_name"`              | `not_null` test                | Column-level test                |
| `IsUnique "col_name"`                | `unique` test                  | Column-level test                |
| `ColumnValues "col" between X and Y` | `dbt_utils.accepted_range`     | Custom test                      |
| `RowCount > 0`                       | `dbt_utils.expression_is_true` | Model-level test                 |
| `DataFreshness "col" < 24hrs`        | `freshness` in `sources.yml`   | Source freshness monitoring      |
| `CustomSQL "SELECT COUNT(*)..."`     | Custom SQL test                | `tests/custom_test.sql`          |

### Data product contract pattern

```yaml
# contract.yaml (per data product)
# Cross-reference: domains/finance/data-products/invoices/contract.yaml
name: fact_sales_daily
version: "1.0"
owner: sales-analytics-team
sla:
    freshness: 4h
    availability: 99.5%
schema:
    - name: sales_date
      type: DATE
      nullable: false
      description: "Date of sales aggregation"
    - name: region
      type: STRING
      nullable: false
      description: "Sales region"
      allowed_values: ["EAST", "WEST", "CENTRAL", "SOUTH"]
    - name: total_units
      type: BIGINT
      nullable: false
      constraints:
          - ">= 0"
    - name: total_revenue
      type: DECIMAL(18,2)
      nullable: false
      constraints:
          - ">= 0"
quality_rules:
    - row_count: "> 0"
    - unique_key: ["sales_date", "region", "product_id"]
```

CI validates contracts via `.github/workflows/validate-contracts.yml`.

---

## Migration sequence for ETL

| Phase                  | Duration   | Activities                                                                           |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------ |
| 1. Catalog inventory   | 1-2 weeks  | Export Glue Catalog; map databases to Unity Catalog catalogs; identify all Glue jobs |
| 2. Catalog migration   | 2-3 weeks  | Create Unity Catalog structure; register external locations; configure Purview scans |
| 3. Pilot ETL migration | 3-4 weeks  | Convert 3-5 representative Glue jobs to dbt models; validate with dual-run           |
| 4. Bulk ETL migration  | 6-10 weeks | Convert remaining Glue jobs; establish ADF orchestration; deploy contracts           |
| 5. Crawler replacement | 2-3 weeks  | Configure Purview scan schedules; deploy Auto Loader for streaming sources           |
| 6. Validation          | 2-3 weeks  | Dual-run reconciliation; aggregate parity checks; lineage verification               |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Compute Migration](compute-migration.md) | [Analytics Migration](analytics-migration.md) | [Migration Playbook](../aws-to-azure.md)
