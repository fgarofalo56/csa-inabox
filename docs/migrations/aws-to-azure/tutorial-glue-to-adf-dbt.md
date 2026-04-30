# Tutorial: Convert AWS Glue ETL Job to ADF + dbt Pipeline

**Status:** Authored 2026-04-30
**Audience:** Data engineers converting AWS Glue ETL jobs (PySpark and Python Shell) to Azure Data Factory orchestration with dbt transformation models on Databricks.
**Prerequisites knowledge:** AWS Glue, PySpark basics, SQL, Azure Data Factory concepts.
**Time estimate:** 1-3 days per Glue job depending on complexity.

---

## Overview

AWS Glue combines orchestration (triggers, workflows), cataloging (Glue Data Catalog), and compute (Glue Spark/Python jobs) into one service. In csa-inabox on Azure, these responsibilities separate cleanly:

| Glue responsibility | Azure equivalent | Why |
|-------------------|-----------------|-----|
| Orchestration (triggers, workflows) | Azure Data Factory (ADF) | Purpose-built orchestrator; see ADR-0001 |
| Catalog (databases, tables) | Unity Catalog + Purview | Runtime + enterprise governance |
| Compute (Spark jobs) | Databricks Jobs | Managed Spark with Photon; see ADR-0002 |
| Transforms (PySpark / Python) | dbt models (SQL-first) or Databricks notebooks | SQL for most transforms; notebooks for complex logic |

This tutorial walks through converting a single Glue ETL job to the ADF + dbt pattern, end to end.

> **AWS comparison:** In AWS, Glue is a single service that does orchestration, cataloging, and compute. In Azure, you get purpose-built services for each concern. This seems like "more services," but it means each piece scales and governs independently. ADF handles orchestration (like Step Functions + Glue triggers), dbt handles transformations (like Glue PySpark but in SQL), and Databricks provides compute (like EMR but managed).

---

## Prerequisites

### Tools

| Tool | Minimum version | Purpose |
|------|----------------|---------|
| AWS CLI | 2.x | Export Glue job definitions |
| Azure CLI | 2.60+ | ADF and Databricks provisioning |
| dbt-databricks | 1.8+ | Transformation layer |
| Databricks CLI | 0.220+ | Workspace management |
| Python | 3.10+ | Local dbt development |

### AWS access

- `glue:GetJob`, `glue:GetJobRun`, `glue:GetTables`, `glue:GetDatabases` permissions.
- Access to the S3 bucket where Glue job scripts are stored.

### Azure access

- An ADF instance (or Fabric Data Factory).
- A Databricks workspace with Unity Catalog enabled.
- ADLS Gen2 storage account with data already migrated (see [tutorial-s3-to-adls.md](tutorial-s3-to-adls.md)).

---

## Step 1: Document the existing Glue job

Before converting anything, fully document what the Glue job does.

### Export Glue job definition

```bash
# Get the Glue job definition
aws glue get-job --job-name daily-customer-etl --output json > glue_job_def.json

# Key fields to capture:
# - Command.ScriptLocation (S3 path to the PySpark script)
# - DefaultArguments (parameters passed to the job)
# - Connections (data sources)
# - MaxCapacity or NumberOfWorkers + WorkerType (DPU sizing)
# - Timeout
# - GlueVersion

# Download the PySpark script
SCRIPT_LOCATION=$(cat glue_job_def.json | jq -r '.Job.Command.ScriptLocation')
aws s3 cp ${SCRIPT_LOCATION} ./glue_scripts/

# Get trigger (schedule) information
aws glue get-trigger --name daily-customer-etl-trigger --output json > glue_trigger.json

# Get Glue Catalog tables used by this job
aws glue get-tables --database-name analytics --output json > glue_tables.json
```

### Document the job profile

| Attribute | Value |
|-----------|-------|
| Job name | `daily-customer-etl` |
| Type | Spark (Glue 4.0) |
| DPU / Workers | 10 DPU (G.1X, 5 workers) |
| Schedule | Daily at 03:00 UTC |
| Script location | `s3://acme-glue-scripts/jobs/daily_customer_etl.py` |
| Source tables | `raw.customer_events`, `raw.customer_profiles` |
| Target table | `curated.customer_360` |
| Connections | `redshift-analytics` (JDBC), `s3-raw-bucket` |
| Avg runtime | 18 minutes |
| Bookmarks | Enabled (incremental) |

### Analyze the PySpark script

Here is a representative Glue PySpark job:

```python
# daily_customer_etl.py (AWS Glue)
import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.context import SparkContext
from pyspark.sql.functions import col, when, lit, current_timestamp, datediff

args = getResolvedOptions(sys.argv, ['JOB_NAME', 'run_date'])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# Read from Glue Catalog
events_dyf = glueContext.create_dynamic_frame.from_catalog(
    database="raw",
    table_name="customer_events",
    push_down_predicate=f"event_date = '{args['run_date']}'"
)

profiles_dyf = glueContext.create_dynamic_frame.from_catalog(
    database="raw",
    table_name="customer_profiles"
)

# Convert to DataFrames for complex transforms
events_df = events_dyf.toDF()
profiles_df = profiles_dyf.toDF()

# Business logic: build customer 360
customer_360 = events_df \
    .groupBy("customer_id") \
    .agg(
        {"event_type": "count", "revenue": "sum", "event_date": "max"}
    ) \
    .withColumnRenamed("count(event_type)", "total_events") \
    .withColumnRenamed("sum(revenue)", "lifetime_revenue") \
    .withColumnRenamed("max(event_date)", "last_activity_date") \
    .join(profiles_df, "customer_id", "left") \
    .withColumn("customer_segment",
        when(col("lifetime_revenue") > 10000, lit("platinum"))
        .when(col("lifetime_revenue") > 5000, lit("gold"))
        .when(col("lifetime_revenue") > 1000, lit("silver"))
        .otherwise(lit("bronze"))
    ) \
    .withColumn("days_since_activity",
        datediff(current_timestamp(), col("last_activity_date"))
    ) \
    .withColumn("is_active", col("days_since_activity") < 90) \
    .withColumn("etl_timestamp", current_timestamp())

# Write to Glue Catalog target
glueContext.write_dynamic_frame.from_catalog(
    frame=DynamicFrame.fromDF(customer_360, glueContext, "customer_360"),
    database="curated",
    table_name="customer_360",
    additional_options={"enableUpdateCatalog": True}
)

job.commit()
```

---

## Step 2: Create ADF Linked Services for source and target

ADF Linked Services are the equivalent of Glue Connections.

### Create ADLS Gen2 linked service

```json
{
  "name": "ls_adls_analytics",
  "type": "Microsoft.DataFactory/factories/linkedservices",
  "properties": {
    "type": "AzureBlobFS",
    "typeProperties": {
      "url": "https://acmeanalyticsgov.dfs.core.usgovcloudapi.net",
      "accountKey": {
        "type": "AzureKeyVaultSecret",
        "store": {
          "referenceName": "ls_keyvault",
          "type": "LinkedServiceReference"
        },
        "secretName": "storage-account-key"
      }
    }
  }
}
```

### Create Databricks linked service

```json
{
  "name": "ls_databricks",
  "type": "Microsoft.DataFactory/factories/linkedservices",
  "properties": {
    "type": "AzureDatabricks",
    "typeProperties": {
      "domain": "https://adb-1234567890.1.azuredatabricks.net",
      "authentication": "MSI",
      "workspaceResourceId": "/subscriptions/<sub-id>/resourceGroups/rg-analytics/providers/Microsoft.Databricks/workspaces/dbx-analytics",
      "newClusterNodeType": "Standard_D4s_v5",
      "newClusterNumOfWorker": "2:8",
      "newClusterSparkEnvVars": {
        "PYSPARK_PYTHON": "/databricks/python3/bin/python3"
      },
      "newClusterVersion": "15.4.x-scala2.12"
    }
  }
}
```

> **AWS comparison:** Glue Connections store JDBC/S3 credentials. ADF Linked Services are the same concept but with richer auth options -- managed identity (no credentials stored), Key Vault references, or service principal. Prefer managed identity (`"authentication": "MSI"`) to eliminate credential management entirely.

---

## Step 3: Build ADF Copy Activity for data ingestion

If the Glue job includes a data-copy step (reading from an external source into the lake), convert that to an ADF Copy Activity.

### ADF pipeline JSON

```json
{
  "name": "pl_ingest_customer_events",
  "properties": {
    "activities": [
      {
        "name": "copy_customer_events",
        "type": "Copy",
        "inputs": [
          {
            "referenceName": "ds_source_customer_events",
            "type": "DatasetReference"
          }
        ],
        "outputs": [
          {
            "referenceName": "ds_adls_bronze_customer_events",
            "type": "DatasetReference"
          }
        ],
        "typeProperties": {
          "source": {
            "type": "ParquetSource",
            "storeSettings": {
              "type": "AzureBlobFSReadSettings",
              "recursive": true,
              "wildcardFolderPath": {
                "value": "@formatDateTime(pipeline().parameters.run_date, 'yyyy/MM/dd')",
                "type": "Expression"
              }
            }
          },
          "sink": {
            "type": "ParquetSink",
            "storeSettings": {
              "type": "AzureBlobFSWriteSettings"
            },
            "formatSettings": {
              "type": "ParquetWriteSettings"
            }
          },
          "enableStaging": false
        }
      },
      {
        "name": "run_dbt_transforms",
        "type": "DatabricksNotebook",
        "dependsOn": [
          {
            "activity": "copy_customer_events",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "linkedServiceName": {
          "referenceName": "ls_databricks",
          "type": "LinkedServiceReference"
        },
        "typeProperties": {
          "notebookPath": "/Repos/acme/analytics/notebooks/run_dbt",
          "baseParameters": {
            "dbt_command": "dbt run --select customer_360",
            "run_date": {
              "value": "@pipeline().parameters.run_date",
              "type": "Expression"
            }
          }
        }
      }
    ],
    "parameters": {
      "run_date": {
        "type": "string",
        "defaultValue": "@utcnow('yyyy-MM-dd')"
      }
    }
  }
}
```

---

## Step 4: Convert Glue PySpark transforms to dbt SQL models

This is where the core transformation logic moves from PySpark to SQL. Most Glue PySpark transforms translate directly to SQL, which is easier to test, version, and audit.

### Before: Glue PySpark (from Step 1)

The PySpark script does: read events, aggregate by customer, join profiles, compute segments, write output.

### After: dbt SQL models

**Staging model -- clean and type-cast source data:**

```sql
-- models/staging/stg_customer_events.sql
{{ config(materialized='view') }}

SELECT
  customer_id,
  event_type,
  CAST(revenue AS DOUBLE) AS revenue,
  CAST(event_date AS DATE) AS event_date,
  event_timestamp
FROM {{ source('bronze', 'customer_events') }}
WHERE event_date IS NOT NULL
```

**Staging model -- customer profiles:**

```sql
-- models/staging/stg_customer_profiles.sql
{{ config(materialized='view') }}

SELECT
  customer_id,
  first_name,
  last_name,
  email,
  signup_date,
  account_status
FROM {{ source('bronze', 'customer_profiles') }}
```

**Gold model -- customer 360 (replaces the Glue PySpark transform):**

```sql
-- models/gold/customer_360.sql
{{ config(
    materialized='incremental',
    unique_key='customer_id',
    incremental_strategy='merge',
    partition_by=['customer_segment'],
    post_hook="OPTIMIZE {{ this }} ZORDER BY (customer_id)"
) }}

WITH event_summary AS (
    SELECT
        customer_id,
        COUNT(event_type)          AS total_events,
        SUM(revenue)               AS lifetime_revenue,
        MAX(event_date)            AS last_activity_date
    FROM {{ ref('stg_customer_events') }}
    {% if is_incremental() %}
    WHERE event_date >= date_sub(current_date(), 3)
    {% endif %}
    GROUP BY customer_id
)

SELECT
    e.customer_id,
    e.total_events,
    e.lifetime_revenue,
    e.last_activity_date,
    p.first_name,
    p.last_name,
    p.email,
    p.signup_date,
    p.account_status,
    CASE
        WHEN e.lifetime_revenue > 10000 THEN 'platinum'
        WHEN e.lifetime_revenue > 5000  THEN 'gold'
        WHEN e.lifetime_revenue > 1000  THEN 'silver'
        ELSE 'bronze'
    END AS customer_segment,
    datediff(current_date(), e.last_activity_date) AS days_since_activity,
    datediff(current_date(), e.last_activity_date) < 90 AS is_active,
    current_timestamp() AS etl_timestamp
FROM event_summary e
LEFT JOIN {{ ref('stg_customer_profiles') }} p
    ON e.customer_id = p.customer_id
```

**dbt tests (replaces Glue DataQuality):**

```yaml
# models/gold/customer_360.yml
version: 2
models:
  - name: customer_360
    description: >
      Customer 360 view combining event aggregates with profile data.
      Migrated from Glue job: daily-customer-etl.
      Original script: s3://acme-glue-scripts/jobs/daily_customer_etl.py
    columns:
      - name: customer_id
        tests:
          - not_null
          - unique
      - name: lifetime_revenue
        tests:
          - not_null
          - dbt_utils.accepted_range:
              min_value: 0
      - name: customer_segment
        tests:
          - accepted_values:
              values: ['platinum', 'gold', 'silver', 'bronze']
      - name: total_events
        tests:
          - not_null
          - dbt_utils.accepted_range:
              min_value: 1
```

### Conversion cheat sheet: Glue PySpark to dbt SQL

| Glue PySpark pattern | dbt SQL equivalent |
|---------------------|--------------------|
| `glueContext.create_dynamic_frame.from_catalog(...)` | `{{ source('schema', 'table') }}` |
| `dyf.toDF().filter(...)` | `WHERE` clause |
| `df.groupBy(...).agg(...)` | `GROUP BY` + aggregate functions |
| `df.join(other, "key", "left")` | `LEFT JOIN ... ON` |
| `df.withColumn("new", expr)` | `expression AS new` in SELECT |
| `when(...).when(...).otherwise(...)` | `CASE WHEN ... WHEN ... ELSE ... END` |
| `datediff(col1, col2)` | `datediff(col1, col2)` (same in Databricks SQL) |
| `current_timestamp()` | `current_timestamp()` (same) |
| `df.write.mode("overwrite").saveAsTable(...)` | `{{ config(materialized='table') }}` |
| `df.write.mode("append")` | `{{ config(materialized='incremental') }}` |
| Glue bookmarks (incremental reads) | `{% if is_incremental() %} WHERE ... {% endif %}` |
| `ResolveChoice` (schema conflicts) | `CAST(col AS type)` in staging model |
| `glueContext.write_dynamic_frame.from_catalog(...)` | Automatic (dbt writes to configured target) |

---

## Step 5: Set up dbt project with profiles.yml for Databricks

### Project structure

```
redshift_migration/
  dbt_project.yml
  packages.yml
  models/
    staging/
      _sources.yml
      stg_customer_events.sql
      stg_customer_profiles.sql
    gold/
      customer_360.sql
      customer_360.yml
  tests/
    validate_customer_360_parity.sql
  macros/
    generate_schema_name.sql
```

### dbt_project.yml

```yaml
name: analytics_migration
version: '1.0.0'
config-version: 2

profile: 'analytics_migration'

model-paths: ["models"]
test-paths: ["tests"]
macro-paths: ["macros"]

models:
  analytics_migration:
    staging:
      +materialized: view
      +schema: staging
    gold:
      +materialized: incremental
      +schema: gold
      +tags: ['daily']
```

### Sources configuration

```yaml
# models/staging/_sources.yml
version: 2
sources:
  - name: bronze
    database: analytics_prod
    schema: bronze
    tables:
      - name: customer_events
        description: "Raw customer events (migrated from S3 via AzCopy)"
        loaded_at_field: event_date
        freshness:
          warn_after: {count: 24, period: hour}
          error_after: {count: 48, period: hour}
      - name: customer_profiles
        description: "Customer profile data (migrated from Redshift)"
```

### Run and test

```bash
# Install dbt packages
dbt deps

# Run the models
dbt run --select customer_360

# Run tests
dbt test --select customer_360

# Generate documentation
dbt docs generate
dbt docs serve
```

---

## Step 6: Configure ADF pipeline to trigger dbt runs

### Databricks notebook to execute dbt

```python
# notebooks/run_dbt.py
# This notebook is called by ADF to execute dbt commands

import subprocess
import sys

# Get parameters from ADF
dbt_command = dbutils.widgets.get("dbt_command")
run_date = dbutils.widgets.get("run_date")

# Set the run date as a dbt variable
full_command = f"{dbt_command} --vars '{{\"run_date\": \"{run_date}\"}}'"

print(f"Executing: {full_command}")

# Execute dbt
result = subprocess.run(
    full_command,
    shell=True,
    cwd="/Workspace/Repos/acme/analytics",
    capture_output=True,
    text=True
)

print("STDOUT:", result.stdout)
if result.returncode != 0:
    print("STDERR:", result.stderr)
    dbutils.notebook.exit(f"FAILED: {result.stderr[-500:]}")
else:
    dbutils.notebook.exit("SUCCESS")
```

### ADF pipeline with dbt activity

The pipeline from Step 3 already includes the `run_dbt_transforms` activity. Here is the complete orchestration pattern:

```
[ADF Trigger: Daily 03:00 UTC]
  -> [Copy Activity: Ingest new data to bronze]
    -> [Databricks Notebook: dbt run --select customer_360]
      -> [Databricks Notebook: dbt test --select customer_360]
        -> [Web Activity: Notify on success/failure]
```

---

## Step 7: Set up scheduling (Glue triggers to ADF triggers)

### Glue trigger to ADF trigger mapping

| Glue trigger type | ADF trigger type | Configuration |
|------------------|-----------------|---------------|
| Schedule trigger | Schedule trigger | Cron expression |
| On-demand | Manual trigger | REST API call or portal |
| EventBridge event | Event trigger (Storage events) | Blob created/modified events |
| Crawler completion trigger | Pipeline dependency | Activity dependency chain |
| Workflow trigger | Pipeline trigger | Tumbling window or schedule |

### Create an ADF schedule trigger

```json
{
  "name": "tr_daily_customer_etl",
  "properties": {
    "type": "ScheduleTrigger",
    "typeProperties": {
      "recurrence": {
        "frequency": "Day",
        "interval": 1,
        "startTime": "2026-04-30T03:00:00Z",
        "timeZone": "UTC"
      }
    },
    "pipelines": [
      {
        "pipelineReference": {
          "referenceName": "pl_ingest_customer_events",
          "type": "PipelineReference"
        },
        "parameters": {
          "run_date": "@trigger().scheduledTime"
        }
      }
    ]
  }
}
```

### Create an event-based trigger (replacing Glue EventBridge triggers)

```json
{
  "name": "tr_new_file_arrival",
  "properties": {
    "type": "BlobEventsTrigger",
    "typeProperties": {
      "blobPathBeginsWith": "/bronze/customer_events/",
      "blobPathEndsWith": ".parquet",
      "ignoreEmptyBlobs": true,
      "scope": "/subscriptions/<sub>/resourceGroups/rg-analytics/providers/Microsoft.Storage/storageAccounts/acmeanalyticsgov",
      "events": ["Microsoft.Storage.BlobCreated"]
    },
    "pipelines": [
      {
        "pipelineReference": {
          "referenceName": "pl_ingest_customer_events",
          "type": "PipelineReference"
        }
      }
    ]
  }
}
```

> **AWS comparison:** Glue triggers work with CloudWatch Events / EventBridge. ADF triggers work with Azure Event Grid (for storage events) or built-in schedules. The main UX difference is that ADF triggers are configured alongside the pipeline, while Glue triggers are separate resources. Functionally they are equivalent.

---

## Step 8: Validate output parity

### Side-by-side comparison

```python
# Databricks notebook: validate_glue_migration.py

# Load Glue-produced output (from S3 via OneLake shortcut)
glue_output = spark.read.table("migration_bridge.curated.customer_360")

# Load dbt-produced output
dbt_output = spark.read.table("analytics_prod.gold.customer_360")

# Row count comparison
glue_count = glue_output.count()
dbt_count = dbt_output.count()
print(f"Glue output: {glue_count:,} rows")
print(f"dbt output:  {dbt_count:,} rows")
print(f"Difference:  {abs(glue_count - dbt_count):,} rows")

# Aggregate comparison
for col_name in ["lifetime_revenue", "total_events"]:
    glue_sum = glue_output.agg({col_name: "sum"}).first()[0]
    dbt_sum = dbt_output.agg({col_name: "sum"}).first()[0]
    pct_diff = abs(glue_sum - dbt_sum) / glue_sum * 100
    status = "PASS" if pct_diff < 0.01 else "FAIL"
    print(f"{col_name}: Glue={glue_sum:,.2f} dbt={dbt_sum:,.2f} diff={pct_diff:.4f}% [{status}]")

# Segment distribution comparison
print("\nSegment distribution:")
glue_segments = glue_output.groupBy("customer_segment").count().orderBy("customer_segment")
dbt_segments = dbt_output.groupBy("customer_segment").count().orderBy("customer_segment")
glue_segments.show()
dbt_segments.show()
```

### Dual-run period

Run both the Glue job and the ADF+dbt pipeline in parallel for at least 5 business days. Compare outputs daily. Only decommission the Glue job after consistent parity is confirmed.

---

## Glue Catalog to Purview migration

The Glue Data Catalog metadata (databases, tables, partitions) should be migrated to Unity Catalog (runtime) and Purview (governance).

### Export Glue Catalog metadata

```bash
# Export all databases
aws glue get-databases --output json > glue_databases.json

# Export tables for each database
for DB in $(aws glue get-databases --query 'DatabaseList[].Name' --output text); do
  aws glue get-tables --database-name ${DB} --output json > "glue_tables_${DB}.json"
done
```

### Register in Unity Catalog

```sql
-- Create catalogs and schemas matching Glue databases
CREATE CATALOG IF NOT EXISTS analytics_prod;
CREATE SCHEMA IF NOT EXISTS analytics_prod.bronze;
CREATE SCHEMA IF NOT EXISTS analytics_prod.silver;
CREATE SCHEMA IF NOT EXISTS analytics_prod.gold;

-- Register migrated tables (already loaded as Delta)
-- Tables created by dbt are automatically registered in Unity Catalog
```

### Connect Purview to scan Unity Catalog

```bash
# Register the Databricks workspace as a Purview data source
az purview account add-root-collection-admin \
  --account-name purview-analytics \
  --resource-group rg-analytics \
  --object-id <databricks-managed-identity-object-id>

# Purview will scan Unity Catalog and populate:
# - Business glossary terms
# - Data classifications (PII, PHI, etc.)
# - Lineage (dbt model dependencies)
```

> **AWS comparison:** Glue Data Catalog is both the runtime catalog and the governance layer (via Lake Formation). In Azure, these are separate: Unity Catalog handles runtime metadata (what Spark/Databricks sees), and Purview handles enterprise governance (classifications, lineage, glossary, access policies). This separation means Purview can govern data across Databricks, ADF, Power BI, and external systems -- not just the Spark runtime.

---

## Related resources

- [AWS-to-Azure migration playbook](../aws-to-azure.md) -- full capability mapping, Glue section 2.3
- [S3 to ADLS tutorial](tutorial-s3-to-adls.md) -- storage migration prerequisite
- [Redshift to Fabric tutorial](tutorial-redshift-to-fabric.md) -- warehouse migration
- [Best practices](best-practices.md) -- migration patterns and pitfalls
- `docs/adr/0001-adf-dbt-over-airflow.md` -- why ADF + dbt over Airflow
- `docs/adr/0006-purview-over-atlas.md` -- Purview as the governance layer
- `domains/shared/pipelines/adf/` -- reference ADF pipeline patterns
- `domains/shared/dbt/dbt_project.yml` -- reference dbt project structure

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
