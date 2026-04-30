# Tutorial — Replace TPT Pipeline with ADF + ADLS + dbt

> **Audience:** Data engineers replacing Teradata Parallel Transporter (TPT) export/load pipelines with Azure Data Factory (ADF), ADLS Gen2, and dbt. This step-by-step tutorial covers JDBC connection setup, full and incremental load patterns, and end-to-end pipeline orchestration.

---

## Prerequisites

- Azure Data Factory workspace provisioned
- Self-Hosted Integration Runtime (SHIR) installed with network access to Teradata
- Teradata JDBC drivers installed on SHIR machine
- ADLS Gen2 storage account
- Databricks workspace with SQL warehouse
- dbt project configured (see [Tutorial — BTEQ to dbt](tutorial-bteq-to-dbt.md))

---

## 1. The source TPT pipeline

We will replace a TPT pipeline that extracts order data from Teradata, transforms it, and loads it into a summary table. This is a representative export/load pattern.

**Original: `orders_etl.tpt`**

```
DEFINE JOB ORDERS_ETL
DESCRIPTION 'Extract orders, transform, load to summary'
(
    /* ---- STEP 1: Export from Teradata ---- */
    DEFINE SCHEMA orders_schema
    (
        order_id       INTEGER,
        customer_id    INTEGER,
        product_id     INTEGER,
        order_date     DATE,
        amount         DECIMAL(12,2),
        discount       DECIMAL(12,2),
        status         VARCHAR(20),
        region_id      INTEGER,
        updated_at     TIMESTAMP
    );

    DEFINE OPERATOR EXPORT_ORDERS
    TYPE EXPORT
    SCHEMA orders_schema
    ATTRIBUTES
    (
        VARCHAR TdpId        = 'td_prod_server',
        VARCHAR UserName     = @ETL_USER,
        VARCHAR UserPassword = @ETL_PASSWORD,
        VARCHAR SelectStmt   = 'SELECT order_id, customer_id, product_id,
                                       order_date, amount, discount, status,
                                       region_id, updated_at
                                FROM production.orders
                                WHERE updated_at > CAST(''' || @LAST_WATERMARK || ''' AS TIMESTAMP)
                                  AND updated_at <= CAST(''' || @CURRENT_WATERMARK || ''' AS TIMESTAMP);'
    );

    DEFINE OPERATOR FILE_WRITER
    TYPE DATACONNECTOR CONSUMER
    SCHEMA orders_schema
    ATTRIBUTES
    (
        VARCHAR DirectoryPath = '/data/staging/orders/',
        VARCHAR FileName      = 'orders_incremental.dat',
        VARCHAR Format        = 'DELIMITED',
        VARCHAR TextDelimiter = '|',
        VARCHAR OpenMode      = 'Write'
    );

    APPLY TO OPERATOR (FILE_WRITER)
    SELECT * FROM OPERATOR (EXPORT_ORDERS);
);
```

**Associated load script: `orders_load.bteq`**

```sql
.LOGON td_prod_server/etl_user,${ETL_PASSWORD}

/* Load exported data into staging */
.IMPORT DATA FILE=/data/staging/orders/orders_incremental.dat

USING (
    order_id       INTEGER,
    customer_id    INTEGER,
    product_id     INTEGER,
    order_date     DATE,
    amount         DECIMAL(12,2),
    discount       DECIMAL(12,2),
    status         VARCHAR(20),
    region_id      INTEGER,
    updated_at     TIMESTAMP
)

INSERT INTO staging.orders_incremental VALUES (:order_id, :customer_id,
    :product_id, :order_date, :amount, :discount, :status, :region_id, :updated_at);

/* Merge staging into target */
MERGE INTO production.orders_summary tgt
USING (
    SELECT
        order_date,
        region_id,
        COUNT(*) AS order_count,
        SUM(amount) AS gross_revenue,
        SUM(discount) AS total_discount,
        SUM(amount - discount) AS net_revenue
    FROM staging.orders_incremental
    WHERE status = 'COMPLETED'
    GROUP BY order_date, region_id
) src
ON tgt.order_date = src.order_date AND tgt.region_id = src.region_id
WHEN MATCHED THEN UPDATE SET
    tgt.order_count = src.order_count,
    tgt.gross_revenue = src.gross_revenue,
    tgt.total_discount = src.total_discount,
    tgt.net_revenue = src.net_revenue
WHEN NOT MATCHED THEN INSERT VALUES (
    src.order_date, src.region_id, src.order_count,
    src.gross_revenue, src.total_discount, src.net_revenue
);

DELETE FROM staging.orders_incremental ALL;

.LOGOFF
.QUIT
```

**Orchestration: cron job**

```
# Run every 15 minutes
*/15 * * * * /opt/teradata/scripts/run_orders_etl.sh
```

---

## 2. Design the Azure replacement

### Architecture

```
┌──────────────┐    JDBC     ┌──────────┐    Write    ┌──────────────┐
│  Teradata    │────────────>│   ADF    │───────────>│  ADLS Gen2   │
│  production  │   (SHIR)   │  Pipeline │  Parquet   │  /raw/orders │
│  .orders     │            │          │            │              │
└──────────────┘            └──────────┘            └──────┬───────┘
                                                          │
                                                    ┌─────▼────────┐
                                                    │  Databricks  │
                                                    │  dbt run     │
                                                    │  (MERGE)     │
                                                    └─────┬────────┘
                                                          │
                                                    ┌─────▼────────┐
                                                    │  Delta Lake  │
                                                    │  silver      │
                                                    │  .orders     │
                                                    │  .orders_    │
                                                    │   summary    │
                                                    └──────────────┘
```

### Component mapping

| TPT/BTEQ component | Azure replacement | Purpose |
| --- | --- | --- |
| TPT Export operator | ADF Copy Activity (JDBC) | Extract from Teradata |
| File writer (pipe-delimited) | ADF Parquet sink | Write to ADLS |
| BTEQ load to staging | ADF Copy → Delta staging | Load to staging table |
| BTEQ MERGE to target | dbt incremental model | Transform and merge |
| cron schedule | ADF trigger (tumbling window) | Orchestration |
| Watermark tracking | ADF watermark activity | Track incremental position |

---

## 3. Set up ADF Teradata connection

### Step 3.1: Install SHIR and Teradata JDBC driver

```bash
# On the SHIR machine (Windows or Linux with network access to Teradata)

# 1. Download and install SHIR from Azure Portal
# ADF → Manage → Integration runtimes → New → Self-Hosted

# 2. Install Teradata JDBC driver
# Download from: https://downloads.teradata.com/download/connectivity/jdbc-driver
# Place JAR files in SHIR custom driver directory:
#   Windows: C:\Program Files\Microsoft Integration Runtime\5.0\Shared\Jars\
#   Linux: /opt/microsoft/integration-runtime/shared/jars/

# Required files:
#   - terajdbc4.jar
#   - tdgssconfig.jar
```

### Step 3.2: Create Teradata linked service

In ADF Studio → Manage → Linked Services → New:

```json
{
    "name": "ls_teradata_production",
    "type": "Teradata",
    "typeProperties": {
        "connectionString": "DBCName=td_prod_server;Database=production;",
        "authenticationType": "Basic",
        "username": "adf_extract_user",
        "password": {
            "type": "AzureKeyVaultSecret",
            "store": {
                "referenceName": "ls_keyvault",
                "type": "LinkedServiceReference"
            },
            "secretName": "teradata-adf-password"
        }
    },
    "connectVia": {
        "referenceName": "ir_self_hosted",
        "type": "IntegrationRuntimeReference"
    }
}
```

### Step 3.3: Create ADLS linked service

```json
{
    "name": "ls_adls_datalake",
    "type": "AzureBlobFS",
    "typeProperties": {
        "url": "https://csadatalake.dfs.core.windows.net",
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
```

---

## 4. Build ADF extraction pipeline

### Step 4.1: Create Teradata source dataset

```json
{
    "name": "ds_teradata_orders",
    "type": "TeradataTable",
    "linkedServiceName": {
        "referenceName": "ls_teradata_production",
        "type": "LinkedServiceReference"
    },
    "typeProperties": {
        "database": "production",
        "table": "orders"
    }
}
```

### Step 4.2: Create ADLS sink dataset

```json
{
    "name": "ds_adls_orders_parquet",
    "type": "Parquet",
    "linkedServiceName": {
        "referenceName": "ls_adls_datalake",
        "type": "LinkedServiceReference"
    },
    "typeProperties": {
        "location": {
            "type": "AzureBlobFSLocation",
            "fileSystem": "raw",
            "folderPath": {
                "value": "teradata/orders/@{formatDateTime(pipeline().TriggerTime, 'yyyy/MM/dd/HH')}",
                "type": "Expression"
            },
            "fileName": "orders_incremental.parquet"
        },
        "compressionCodec": "snappy"
    }
}
```

### Step 4.3: Build the pipeline

**Pipeline: `pl_teradata_orders_incremental`**

```json
{
    "name": "pl_teradata_orders_incremental",
    "properties": {
        "activities": [
            {
                "name": "GetLastWatermark",
                "type": "Lookup",
                "typeProperties": {
                    "source": {
                        "type": "DatabricksDeltaLakeSource",
                        "query": "SELECT COALESCE(MAX(watermark_value), '1900-01-01 00:00:00') AS last_watermark FROM silver.etl_watermarks WHERE table_name = 'orders'"
                    },
                    "dataset": { "referenceName": "ds_databricks_watermarks" }
                }
            },
            {
                "name": "GetCurrentWatermark",
                "type": "Lookup",
                "dependsOn": [],
                "typeProperties": {
                    "source": {
                        "type": "TeradataSource",
                        "query": "SELECT CAST(CURRENT_TIMESTAMP AS VARCHAR(26)) AS current_watermark;"
                    },
                    "dataset": { "referenceName": "ds_teradata_orders" }
                }
            },
            {
                "name": "CopyIncrementalOrders",
                "type": "Copy",
                "dependsOn": [
                    { "activity": "GetLastWatermark", "dependencyConditions": ["Succeeded"] },
                    { "activity": "GetCurrentWatermark", "dependencyConditions": ["Succeeded"] }
                ],
                "typeProperties": {
                    "source": {
                        "type": "TeradataSource",
                        "query": {
                            "value": "SELECT order_id, customer_id, product_id, order_date, amount, discount, status, region_id, updated_at FROM production.orders WHERE updated_at > CAST('@{activity('GetLastWatermark').output.firstRow.last_watermark}' AS TIMESTAMP) AND updated_at <= CAST('@{activity('GetCurrentWatermark').output.firstRow.current_watermark}' AS TIMESTAMP)",
                            "type": "Expression"
                        },
                        "partitionOption": "Hash",
                        "partitionSettings": {
                            "partitionColumnName": "order_id",
                            "partitionUpperBound": "100000000",
                            "partitionLowerBound": "1",
                            "partitionCount": 8
                        }
                    },
                    "sink": {
                        "type": "ParquetSink",
                        "storeSettings": { "type": "AzureBlobFSWriteSettings" },
                        "formatSettings": {
                            "type": "ParquetWriteSettings",
                            "maxRowsPerFile": 500000
                        }
                    },
                    "enableStaging": false,
                    "parallelCopies": 8
                }
            },
            {
                "name": "UpdateWatermark",
                "type": "DatabricksNotebook",
                "dependsOn": [
                    { "activity": "CopyIncrementalOrders", "dependencyConditions": ["Succeeded"] }
                ],
                "typeProperties": {
                    "notebookPath": "/Repos/data-team/teradata-migration/notebooks/update_watermark",
                    "baseParameters": {
                        "table_name": "orders",
                        "watermark_value": {
                            "value": "@activity('GetCurrentWatermark').output.firstRow.current_watermark",
                            "type": "Expression"
                        },
                        "rows_copied": {
                            "value": "@string(activity('CopyIncrementalOrders').output.rowsCopied)",
                            "type": "Expression"
                        }
                    }
                }
            },
            {
                "name": "RunDbtModels",
                "type": "DatabricksNotebook",
                "dependsOn": [
                    { "activity": "UpdateWatermark", "dependencyConditions": ["Succeeded"] }
                ],
                "typeProperties": {
                    "notebookPath": "/Repos/data-team/teradata-migration/notebooks/run_dbt",
                    "baseParameters": {
                        "models": "stg_orders orders_summary"
                    }
                }
            }
        ],
        "annotations": ["teradata-migration", "orders", "incremental"]
    }
}
```

### Step 4.4: Create tumbling window trigger (replaces cron)

```json
{
    "name": "tr_orders_incremental_15min",
    "type": "TumblingWindowTrigger",
    "typeProperties": {
        "frequency": "Minute",
        "interval": 15,
        "startTime": "2024-01-01T00:00:00Z",
        "delay": "00:01:00",
        "maxConcurrency": 1,
        "retryPolicy": {
            "count": 3,
            "intervalInSeconds": 60
        }
    },
    "pipeline": {
        "pipelineReference": {
            "referenceName": "pl_teradata_orders_incremental",
            "type": "PipelineReference"
        }
    }
}
```

---

## 5. Build dbt models for transformation

### Step 5.1: Staging model (load Parquet into Delta)

**`models/staging/stg_orders.sql`:**

```sql
-- Replaces: TPT export + BTEQ load to staging
-- Reads from raw Parquet files landed by ADF

{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    file_format='delta'
) }}

SELECT
    order_id,
    customer_id,
    product_id,
    order_date,
    CAST(amount AS DECIMAL(12,2)) AS amount,
    CAST(discount AS DECIMAL(12,2)) AS discount,
    status,
    region_id,
    updated_at,
    CURRENT_TIMESTAMP() AS _loaded_at,
    'adf-teradata' AS _source
FROM {{ source('raw_teradata', 'orders') }}

{% if is_incremental() %}
WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
```

### Step 5.2: Summary model (replaces BTEQ MERGE)

**`models/marts/orders_summary.sql`:**

```sql
-- Replaces: MERGE INTO production.orders_summary from orders_load.bteq
-- Aggregates orders by date and region

{{ config(
    materialized='incremental',
    unique_key=['order_date', 'region_id'],
    incremental_strategy='merge',
    file_format='delta',
    partition_by=['order_date']
) }}

SELECT
    order_date,
    region_id,
    COUNT(*) AS order_count,
    SUM(amount) AS gross_revenue,
    SUM(discount) AS total_discount,
    SUM(amount - discount) AS net_revenue,
    CURRENT_TIMESTAMP() AS _updated_at
FROM {{ ref('stg_orders') }}
WHERE status = 'COMPLETED'

{% if is_incremental() %}
    AND order_date >= DATE_SUB(CURRENT_DATE(), 3)  -- Reprocess last 3 days for late arrivals
{% endif %}

GROUP BY order_date, region_id
```

### Step 5.3: Watermark management notebook

**`notebooks/update_watermark.py`:**

```python
# Databricks notebook: update_watermark
# Called by ADF after successful copy

dbutils.widgets.text("table_name", "")
dbutils.widgets.text("watermark_value", "")
dbutils.widgets.text("rows_copied", "0")

table_name = dbutils.widgets.get("table_name")
watermark_value = dbutils.widgets.get("watermark_value")
rows_copied = int(dbutils.widgets.get("rows_copied"))

spark.sql(f"""
    MERGE INTO silver.etl_watermarks AS target
    USING (SELECT
        '{table_name}' AS table_name,
        CAST('{watermark_value}' AS TIMESTAMP) AS watermark_value,
        {rows_copied} AS rows_copied,
        CURRENT_TIMESTAMP() AS updated_at
    ) AS source
    ON target.table_name = source.table_name
    WHEN MATCHED THEN UPDATE SET
        target.watermark_value = source.watermark_value,
        target.rows_copied = source.rows_copied,
        target.updated_at = source.updated_at
    WHEN NOT MATCHED THEN INSERT *
""")

print(f"Watermark updated: {table_name} = {watermark_value} ({rows_copied} rows)")
```

### Step 5.4: dbt runner notebook

**`notebooks/run_dbt.py`:**

```python
# Databricks notebook: run_dbt
# Called by ADF to execute dbt models

import subprocess

dbutils.widgets.text("models", "")
models = dbutils.widgets.get("models")

# Run dbt from the repo
result = subprocess.run(
    ["dbt", "run", "--select", models, "--profiles-dir", "/dbfs/dbt/profiles/"],
    capture_output=True,
    text=True,
    cwd="/Workspace/Repos/data-team/teradata-migration"
)

print("STDOUT:", result.stdout)
if result.returncode != 0:
    print("STDERR:", result.stderr)
    raise Exception(f"dbt run failed with return code {result.returncode}")

# Run tests
result = subprocess.run(
    ["dbt", "test", "--select", models, "--profiles-dir", "/dbfs/dbt/profiles/"],
    capture_output=True,
    text=True,
    cwd="/Workspace/Repos/data-team/teradata-migration"
)

print("TEST STDOUT:", result.stdout)
if result.returncode != 0:
    print("TEST STDERR:", result.stderr)
    raise Exception(f"dbt test failed with return code {result.returncode}")
```

---

## 6. Monitoring and alerting

### Step 6.1: ADF monitoring

ADF provides built-in monitoring for pipeline runs:

| Metric | Where to find | Alert threshold |
| --- | --- | --- |
| Pipeline success/failure | ADF Monitor → Pipeline runs | Alert on any failure |
| Copy activity duration | Activity run details | >10 min (normally ~3 min) |
| Rows copied | Copy activity output | 0 rows (data gap) |
| SHIR health | ADF → Integration runtimes | Offline status |

### Step 6.2: Azure Monitor alerts

```json
{
    "name": "alert-teradata-pipeline-failure",
    "type": "Microsoft.Insights/metricAlerts",
    "properties": {
        "criteria": {
            "allOf": [{
                "metricName": "PipelineFailedRuns",
                "metricNamespace": "Microsoft.DataFactory/factories",
                "operator": "GreaterThan",
                "threshold": 0,
                "timeAggregation": "Total"
            }]
        },
        "windowSize": "PT15M",
        "evaluationFrequency": "PT5M",
        "actions": [{
            "actionGroupId": "/subscriptions/.../actionGroups/data-platform-alerts"
        }]
    }
}
```

### Step 6.3: Data quality monitoring

```sql
-- Daily data quality check (dbt test or standalone)
SELECT
    'orders' AS table_name,
    COUNT(*) AS total_rows,
    COUNT(DISTINCT order_date) AS distinct_dates,
    MIN(order_date) AS earliest_date,
    MAX(order_date) AS latest_date,
    SUM(CASE WHEN order_date = DATE_SUB(CURRENT_DATE(), 1) THEN 1 ELSE 0 END) AS yesterday_rows,
    CURRENT_TIMESTAMP() AS checked_at
FROM silver.orders;

-- Alert if yesterday has 0 rows (pipeline may have failed silently)
```

---

## 7. Full load pipeline (initial migration)

For the initial bulk migration, create a separate full-load pipeline:

### Step 7.1: Full load ADF pipeline

```json
{
    "name": "pl_teradata_orders_full_load",
    "properties": {
        "activities": [
            {
                "name": "CopyFullOrders",
                "type": "Copy",
                "typeProperties": {
                    "source": {
                        "type": "TeradataSource",
                        "query": "SELECT * FROM production.orders",
                        "partitionOption": "Hash",
                        "partitionSettings": {
                            "partitionColumnName": "order_id",
                            "partitionUpperBound": "100000000",
                            "partitionLowerBound": "1",
                            "partitionCount": 32
                        }
                    },
                    "sink": {
                        "type": "ParquetSink",
                        "storeSettings": { "type": "AzureBlobFSWriteSettings" },
                        "formatSettings": {
                            "type": "ParquetWriteSettings",
                            "maxRowsPerFile": 1000000
                        }
                    },
                    "parallelCopies": 32
                }
            }
        ]
    }
}
```

### Step 7.2: Performance comparison

| Metric | TPT (original) | ADF (replacement) |
| --- | --- | --- |
| Full load (100M rows) | ~45 min (TPT direct) | ~60 min (JDBC via SHIR) |
| Incremental (100K rows) | ~2 min (TPT + BTEQ) | ~3 min (ADF + dbt) |
| Network bandwidth used | Dedicated VLAN | ExpressRoute / VPN |
| Parallelism | TPT instances | ADF partition count |
| Error handling | TPT error tables | ADF fault tolerance |
| Scheduling | cron | ADF triggers (tumbling window) |
| Monitoring | Log files + email | ADF Monitor + Azure Monitor |

---

## 8. Cutover plan

### Phase 1: Parallel run (2-4 weeks)

Run both TPT/BTEQ and ADF/dbt pipelines simultaneously:

```
Teradata → TPT → Teradata target    (existing)
Teradata → ADF → ADLS → dbt → Delta (new)
```

Compare outputs daily:
```sql
-- Compare Teradata target with Azure target
SELECT 'teradata' AS source, order_date, region_id, order_count, net_revenue
FROM teradata_mirror.orders_summary
WHERE order_date = DATE_SUB(CURRENT_DATE(), 1)

UNION ALL

SELECT 'azure', order_date, region_id, order_count, net_revenue
FROM silver.orders_summary
WHERE order_date = DATE_SUB(CURRENT_DATE(), 1)

ORDER BY order_date, region_id, source;
```

### Phase 2: Switch primary (1 week)

- ADF/dbt becomes primary pipeline
- TPT/BTEQ runs as backup
- All consumers read from Azure

### Phase 3: Decommission TPT (after 30 days stable)

- Disable TPT/BTEQ cron jobs
- Archive scripts to version control
- Remove Teradata extract user permissions
- Update documentation

---

## 9. Troubleshooting

| Issue | Cause | Resolution |
| --- | --- | --- |
| ADF JDBC timeout | Large query, slow network | Increase timeout, add partitioning |
| SHIR out of memory | Too many parallel copies | Reduce `parallelCopies`, increase SHIR RAM |
| Teradata session limit | Too many ADF partitions | Reduce `partitionCount`, coordinate with DBA |
| Parquet schema mismatch | Teradata column type change | Update ADF dataset schema mapping |
| dbt MERGE conflicts | Late-arriving data overlaps | Use wider incremental window (3-7 days) |
| Watermark gap | ADF failure between copy and watermark update | Re-run with manual watermark override |
| Data duplication | Retry without idempotent MERGE | Ensure `unique_key` in dbt incremental |

---

## 10. Related resources

- [Data Migration](data-migration.md) — Comprehensive data migration guide
- [Tutorial — BTEQ to dbt](tutorial-bteq-to-dbt.md) — BTEQ script conversion
- [SQL Migration](sql-migration.md) — SQL conversion patterns
- [Feature Mapping](feature-mapping-complete.md) — TPT feature mapping
- `docs/SELF_HOSTED_IR.md` — SHIR setup guide
- `docs/ADF_SETUP.md` — ADF configuration guide
- ADF Teradata connector: <https://learn.microsoft.com/azure/data-factory/connector-teradata>
- ADF Copy Activity tuning: <https://learn.microsoft.com/azure/data-factory/copy-activity-performance>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
