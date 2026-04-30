# Data Migration — Teradata to Azure

> **Audience:** Data engineers responsible for physically moving data from Teradata systems to Azure (ADLS Gen2 + Delta Lake). Covers TPT export, BTEQ export, ADF ingestion, FastLoad/MultiLoad equivalents, CDC during migration, and data validation frameworks.

---

## 1. Migration architecture overview

```
┌────────────────────┐         ┌──────────────────┐         ┌────────────────────┐
│  Teradata System   │         │  Transit Layer   │         │  Azure Target      │
│                    │         │                  │         │                    │
│  ┌──────────────┐  │  TPT    │  ┌────────────┐  │ azcopy  │  ┌──────────────┐  │
│  │  Tables      │──┼────────>│  │ Parquet    │──┼────────>│  │ ADLS Gen2    │  │
│  │  Views       │  │  Export │  │ Files      │  │ Upload  │  │ (Bronze)     │  │
│  │  Stored Proc │  │         │  └────────────┘  │         │  └──────┬───────┘  │
│  └──────────────┘  │         │                  │         │         │          │
│                    │  JDBC   │  ┌────────────┐  │  ADF    │  ┌──────▼───────┐  │
│  ┌──────────────┐  │────────>│  │ ADF SHIR   │──┼────────>│  │ Delta Lake   │  │
│  │  Change Data │  │  CDC    │  │ (On-prem)  │  │  Copy   │  │ (Silver)     │  │
│  │  (Journal)   │  │         │  └────────────┘  │         │  └──────────────┘  │
│  └──────────────┘  │         │                  │         │                    │
└────────────────────┘         └──────────────────┘         └────────────────────┘
```

### Two primary paths

| Path | Best for | Throughput | Complexity |
| --- | --- | --- | --- |
| **TPT export → Parquet → azcopy** | Initial bulk load, large tables | Very high (TB/hour) | Medium |
| **ADF with JDBC connector** | Incremental loads, smaller tables, ongoing CDC | Moderate (GB/hour) | Low-Medium |

For most migrations, use **TPT for the initial bulk load** and **ADF for ongoing incremental sync**.

---

## 2. TPT export to Parquet

### 2.1 TPT export script template

TPT natively exports to delimited files. For Parquet, export to CSV/pipe-delimited first, then convert, or use a Spark job to read via JDBC and write Parquet directly.

**Option A: TPT to delimited, then convert to Parquet**

```
DEFINE JOB EXPORT_ORDERS
DESCRIPTION 'Export orders table to pipe-delimited file'
(
  DEFINE SCHEMA order_schema
  (
    order_id     INTEGER,
    customer_id  INTEGER,
    order_date   DATE,
    amount       DECIMAL(12,2),
    status       VARCHAR(20)
  );

  DEFINE OPERATOR EXPORT_OP
  TYPE EXPORT
  SCHEMA order_schema
  ATTRIBUTES
  (
    VARCHAR TdpId        = 'teradata_server',
    VARCHAR UserName     = @username,
    VARCHAR UserPassword = @password,
    VARCHAR SelectStmt   = 'SELECT order_id, customer_id, order_date, amount, status
                            FROM production.orders
                            WHERE order_date >= DATE ''2020-01-01'';'
  );

  DEFINE OPERATOR WRITER_OP
  TYPE DATACONNECTOR CONSUMER
  SCHEMA order_schema
  ATTRIBUTES
  (
    VARCHAR DirectoryPath = '/data/export/orders/',
    VARCHAR FileName      = 'orders_export.dat',
    VARCHAR Format        = 'DELIMITED',
    VARCHAR TextDelimiter = '|',
    VARCHAR OpenMode      = 'Write'
  );

  APPLY TO OPERATOR (WRITER_OP)
  SELECT * FROM OPERATOR (EXPORT_OP);
);
```

Run the export:

```bash
tbuild -f export_orders.tpt -v export_orders.log \
    -u "username=dbc_user,password=$TD_PASSWORD"
```

Convert to Parquet using Spark (locally or on a gateway server):

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("td_export_convert").getOrCreate()

df = spark.read.csv(
    "/data/export/orders/orders_export.dat",
    sep="|",
    header=False,
    schema="order_id INT, customer_id INT, order_date DATE, amount DECIMAL(12,2), status STRING"
)

df.write.parquet("/data/export/orders/parquet/", mode="overwrite")
```

**Option B: Direct JDBC to Parquet (preferred for medium tables)**

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("td_jdbc_export") \
    .config("spark.jars", "/path/to/terajdbc4.jar,/path/to/tdgssconfig.jar") \
    .getOrCreate()

df = spark.read.format("jdbc") \
    .option("url", "jdbc:teradata://teradata_server/DATABASE=production") \
    .option("dbtable", "orders") \
    .option("user", "dbc_user") \
    .option("password", td_password) \
    .option("fetchsize", "100000") \
    .option("numPartitions", "16") \
    .option("partitionColumn", "order_id") \
    .option("lowerBound", "1") \
    .option("upperBound", "100000000") \
    .load()

df.write.parquet("/data/export/orders/parquet/", mode="overwrite")
```

### 2.2 Upload to ADLS

```bash
# Install azcopy (one-time)
# https://learn.microsoft.com/azure/storage/common/storage-use-azcopy-v10

# Upload Parquet files to ADLS
azcopy copy "/data/export/orders/parquet/" \
    "https://<storage>.dfs.core.windows.net/raw/teradata-bulk/orders/?<sas>" \
    --recursive \
    --put-md5 \
    --log-level=INFO

# For very large transfers, use multiple azcopy jobs in parallel
for table in orders customers products inventory; do
    azcopy copy "/data/export/${table}/parquet/" \
        "https://<storage>.dfs.core.windows.net/raw/teradata-bulk/${table}/?<sas>" \
        --recursive --put-md5 &
done
wait
```

### 2.3 Convert to Delta in Azure

```sql
-- Databricks notebook: bronze → silver conversion
-- For each table exported from Teradata:

CREATE TABLE IF NOT EXISTS bronze.orders
USING PARQUET
LOCATION 'abfss://raw@<storage>.dfs.core.windows.net/teradata-bulk/orders/';

CREATE TABLE silver.orders
USING DELTA
PARTITIONED BY (order_month)
LOCATION 'abfss://silver@<storage>.dfs.core.windows.net/orders/'
AS
SELECT
    *,
    DATE_FORMAT(order_date, 'yyyy-MM') AS order_month,
    CURRENT_TIMESTAMP() AS _loaded_at,
    'teradata-bulk' AS _source
FROM bronze.orders;

-- Optimize for query performance
OPTIMIZE silver.orders ZORDER BY (customer_id);

-- Verify
SELECT COUNT(*) AS row_count, SUM(amount) AS total_amount FROM silver.orders;
```

---

## 3. BTEQ export scripts

For smaller tables or ad-hoc exports, BTEQ can export directly:

```sql
.LOGON teradata_server/dbc_user,${TD_PASSWORD}

.SET WIDTH 65535
.SET SEPARATOR '|'

DATABASE production;

.EXPORT REPORT FILE=/data/export/customers/customers.csv

SELECT
    TRIM(customer_id) || '|' ||
    TRIM(customer_name) || '|' ||
    TRIM(email) || '|' ||
    CAST(created_date AS VARCHAR(10) FORMAT 'YYYY-MM-DD')
FROM customers
ORDER BY customer_id;

.EXPORT RESET

.LOGOFF
.QUIT
```

**Batch BTEQ export wrapper:**

```bash
#!/bin/bash
# export_all_tables.sh
# Export all tables in a database using BTEQ

TABLES=(customers orders products inventory shipments)
EXPORT_DIR="/data/export"
TD_SERVER="teradata_server"

for TABLE in "${TABLES[@]}"; do
    echo "Exporting ${TABLE}..."
    mkdir -p "${EXPORT_DIR}/${TABLE}"

    bteq <<EOF
.LOGON ${TD_SERVER}/dbc_user,${TD_PASSWORD}
.SET WIDTH 65535
.SET SEPARATOR '|'
DATABASE production;
.EXPORT REPORT FILE=${EXPORT_DIR}/${TABLE}/${TABLE}.csv
SELECT * FROM ${TABLE};
.EXPORT RESET
.LOGOFF
.QUIT
EOF

    if [ $? -eq 0 ]; then
        echo "  OK: ${TABLE} exported"
        wc -l "${EXPORT_DIR}/${TABLE}/${TABLE}.csv"
    else
        echo "  FAIL: ${TABLE} export failed" >&2
    fi
done
```

---

## 4. ADF ingestion from Teradata

### 4.1 Prerequisites

1. **Self-Hosted Integration Runtime (SHIR)** installed on a server with network access to Teradata
2. **Teradata JDBC driver** installed on the SHIR machine
3. **Teradata linked service** configured in ADF

See `docs/SELF_HOSTED_IR.md` for SHIR setup details.

### 4.2 Teradata linked service configuration

```json
{
    "name": "TeradataLinkedService",
    "type": "Microsoft.DataFactory/factories/linkedservices",
    "properties": {
        "type": "Teradata",
        "typeProperties": {
            "connectionString": "DBCName=teradata_server;Database=production",
            "authenticationType": "Basic",
            "username": "adf_user",
            "password": {
                "type": "AzureKeyVaultSecret",
                "store": {
                    "referenceName": "KeyVaultLinkedService",
                    "type": "LinkedServiceReference"
                },
                "secretName": "teradata-adf-password"
            }
        },
        "connectVia": {
            "referenceName": "SelfHostedIR",
            "type": "IntegrationRuntimeReference"
        }
    }
}
```

### 4.3 ADF Copy Activity — full table load

```json
{
    "name": "CopyTeradataOrders",
    "type": "Copy",
    "inputs": [{
        "referenceName": "TeradataOrdersDataset",
        "type": "DatasetReference"
    }],
    "outputs": [{
        "referenceName": "ADLSOrdersParquet",
        "type": "DatasetReference"
    }],
    "typeProperties": {
        "source": {
            "type": "TeradataSource",
            "query": "SELECT * FROM production.orders WHERE order_date >= DATE '2020-01-01'",
            "partitionOption": "Hash",
            "partitionSettings": {
                "partitionColumnName": "order_id",
                "partitionUpperBound": "100000000",
                "partitionLowerBound": "1",
                "partitionCount": 16
            }
        },
        "sink": {
            "type": "ParquetSink",
            "storeSettings": {
                "type": "AzureBlobFSWriteSettings"
            },
            "formatSettings": {
                "type": "ParquetWriteSettings",
                "maxRowsPerFile": 1000000
            }
        },
        "enableStaging": false,
        "parallelCopies": 16
    }
}
```

### 4.4 ADF Copy Activity — incremental load (watermark pattern)

```json
{
    "name": "IncrementalCopyOrders",
    "type": "Copy",
    "typeProperties": {
        "source": {
            "type": "TeradataSource",
            "query": {
                "value": "SELECT * FROM production.orders WHERE updated_at > CAST('@{activity('GetWatermark').output.firstRow.watermark}' AS TIMESTAMP)",
                "type": "Expression"
            }
        },
        "sink": {
            "type": "ParquetSink",
            "storeSettings": {
                "type": "AzureBlobFSWriteSettings",
                "copyBehavior": "PreserveHierarchy"
            }
        }
    }
}
```

### 4.5 Throughput optimization

| Tuning knob | Recommendation | Impact |
| --- | --- | --- |
| `parallelCopies` | 8-32 (depends on Teradata capacity) | Linear throughput improvement |
| `partitionOption` | Hash or DynamicRange | Parallel extraction |
| SHIR sizing | 8+ cores, 32+ GB RAM | Avoids bottleneck |
| Teradata workload class | Dedicate a class for ADF exports | Prevents impact on production queries |
| Batch size | 1M rows per Parquet file | Optimal file size for Delta |
| Network | ExpressRoute (not VPN) for >1 TB | 10x throughput |

---

## 5. FastLoad and MultiLoad equivalents

### 5.1 FastLoad → ADF bulk copy (full table overwrite)

| FastLoad concept | ADF equivalent |
| --- | --- |
| Empty table requirement | ADF sink: `tableActionOption: "Overwrite"` |
| High-speed parallel insert | `parallelCopies: 16-32` |
| Error tables (ET/UV) | ADF fault tolerance: redirect incompatible rows |
| Checkpoint/restart | ADF pipeline retry policy |

**ADF pipeline for full-table replacement:**

```json
{
    "activities": [
        {
            "name": "TruncateAndLoad",
            "type": "Copy",
            "typeProperties": {
                "source": {
                    "type": "ParquetSource",
                    "storeSettings": { "type": "AzureBlobFSReadSettings", "recursive": true }
                },
                "sink": {
                    "type": "DeltaLakeSink",
                    "storeSettings": { "type": "AzureBlobFSWriteSettings" },
                    "importSettings": {
                        "type": "DeltaLakeImportCommand",
                        "writeMode": "Overwrite"
                    }
                }
            }
        }
    ]
}
```

### 5.2 MultiLoad → ADF + Delta MERGE (upsert)

| MultiLoad concept | Azure equivalent |
| --- | --- |
| Insert/Update/Delete/Upsert | Delta MERGE with match conditions |
| Multiple DML in single pass | Single MERGE with WHEN MATCHED / NOT MATCHED |
| Apply table → staging table | ADF loads to staging Delta table |
| Error table | ADF fault tolerance + error logging |

**Two-step pattern: ADF load → Databricks MERGE:**

Step 1 — ADF loads incremental data to staging:
```sql
-- ADF copies new/changed rows to staging
-- Target: staging.orders_incremental
```

Step 2 — Databricks notebook merges to target:
```sql
MERGE INTO silver.orders AS target
USING staging.orders_incremental AS source
ON target.order_id = source.order_id
WHEN MATCHED AND source._operation = 'D' THEN DELETE
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED AND source._operation != 'D' THEN INSERT *;

-- Clean up staging
TRUNCATE TABLE staging.orders_incremental;
```

---

## 6. CDC (Change Data Capture) during migration

During the 6-18 month migration window, Teradata continues receiving writes. You need continuous sync.

### 6.1 Options

| Approach | Latency | Complexity | Cost |
| --- | --- | --- | --- |
| **Qlik Replicate (Attunity)** | Near real-time (seconds) | Low | $$ (commercial license) |
| **Teradata journal tables** | Minutes-hours | Medium | $ (built-in if configured) |
| **Timestamp-based incremental** | Hours (batch) | Low | $ (ADF only) |
| **Full daily re-extract** | Daily | Very low | $ (for small tables only) |

### 6.2 Qlik Replicate approach

Qlik Replicate reads Teradata change data and writes to ADLS/Kafka:

```
Teradata → Qlik Replicate → Event Hubs → Spark Structured Streaming → Delta Lake
                           → ADLS (Parquet) → ADF → Delta Lake
```

Configuration highlights:
- Source: Teradata (ODBC connection)
- Target: Azure Event Hubs or ADLS
- Replication mode: Full Load + CDC
- Change processing: Apply changes (MERGE semantics)

### 6.3 Journal table approach

If Teradata is configured with journal tables:

```sql
-- Teradata: Query journal for changes since last sync
SELECT
    j.RowId,
    j.OperationType,  -- I=Insert, U=Update, D=Delete
    j.TimeStamp,
    t.*
FROM DBC.TransientJournal j
JOIN production.orders t ON j.RowId = t.ROWID
WHERE j.TimeStamp > CAST('2024-01-15 10:30:00' AS TIMESTAMP)
ORDER BY j.TimeStamp;
```

### 6.4 Timestamp-based incremental (most common)

Most tables have an `updated_at` or `modified_date` column. Use ADF watermark pattern:

```sql
-- ADF query with parameterized watermark
SELECT * FROM production.orders
WHERE updated_at > CAST('@{pipeline().parameters.lastWatermark}' AS TIMESTAMP)
  AND updated_at <= CAST('@{pipeline().parameters.currentWatermark}' AS TIMESTAMP);
```

Schedule ADF pipeline to run every 15-60 minutes during migration.

---

## 7. Data validation framework

### 7.1 Row count validation

```sql
-- Teradata side
SELECT 'orders' AS table_name, COUNT(*) AS row_count FROM production.orders
UNION ALL
SELECT 'customers', COUNT(*) FROM production.customers
UNION ALL
SELECT 'products', COUNT(*) FROM production.products;

-- Azure side (Databricks)
SELECT 'orders' AS table_name, COUNT(*) AS row_count FROM silver.orders
UNION ALL
SELECT 'customers', COUNT(*) FROM silver.customers
UNION ALL
SELECT 'products', COUNT(*) FROM silver.products;
```

### 7.2 Checksum validation

```sql
-- Teradata: column-level checksums
SELECT
    COUNT(*) AS row_count,
    SUM(CAST(HASHROW(order_id, customer_id, amount) AS BIGINT)) AS hash_sum,
    SUM(amount) AS amount_sum,
    MIN(order_date) AS min_date,
    MAX(order_date) AS max_date
FROM production.orders;

-- Azure (Databricks): equivalent checksums
SELECT
    COUNT(*) AS row_count,
    SUM(CAST(HASH(order_id, customer_id, amount) AS BIGINT)) AS hash_sum,
    SUM(amount) AS amount_sum,
    MIN(order_date) AS min_date,
    MAX(order_date) AS max_date
FROM silver.orders;
```

> Note: Hash functions differ between Teradata and Spark. Use aggregate sums and counts for cross-platform validation; reserve hash comparison for same-platform checks.

### 7.3 Golden query validation

Identify 20-50 critical business queries ("golden queries") and run them on both platforms:

```python
# golden_query_validation.py
import pandas as pd
from decimal import Decimal

GOLDEN_QUERIES = [
    {
        "name": "monthly_revenue",
        "teradata_sql": """
            SELECT EXTRACT(YEAR FROM order_date) AS yr,
                   EXTRACT(MONTH FROM order_date) AS mo,
                   SUM(amount) AS total
            FROM production.orders
            GROUP BY 1, 2
            ORDER BY 1, 2;
        """,
        "azure_sql": """
            SELECT YEAR(order_date) AS yr,
                   MONTH(order_date) AS mo,
                   SUM(amount) AS total
            FROM silver.orders
            GROUP BY yr, mo
            ORDER BY yr, mo;
        """,
        "tolerance": Decimal("0.01"),  # Allow $0.01 rounding difference
    },
    {
        "name": "customer_order_counts",
        "teradata_sql": "SELECT customer_id, COUNT(*) AS cnt FROM production.orders GROUP BY 1 ORDER BY 1;",
        "azure_sql": "SELECT customer_id, COUNT(*) AS cnt FROM silver.orders GROUP BY customer_id ORDER BY customer_id;",
        "tolerance": Decimal("0"),  # Exact match required
    },
]

def validate_golden_queries(td_conn, az_conn):
    results = []
    for gq in GOLDEN_QUERIES:
        td_df = pd.read_sql(gq["teradata_sql"], td_conn)
        az_df = pd.read_sql(gq["azure_sql"], az_conn)

        row_match = len(td_df) == len(az_df)

        numeric_cols = td_df.select_dtypes(include="number").columns
        value_match = True
        for col in numeric_cols:
            diff = abs(td_df[col].sum() - az_df[col].sum())
            if diff > float(gq["tolerance"]):
                value_match = False

        results.append({
            "query": gq["name"],
            "td_rows": len(td_df),
            "az_rows": len(az_df),
            "row_match": row_match,
            "value_match": value_match,
            "status": "PASS" if (row_match and value_match) else "FAIL"
        })

    return pd.DataFrame(results)
```

### 7.4 dbt data tests

```yaml
# models/silver/schema.yml
models:
  - name: orders
    description: "Migrated from Teradata production.orders"
    columns:
      - name: order_id
        tests:
          - unique
          - not_null
      - name: customer_id
        tests:
          - not_null
          - relationships:
              to: ref('customers')
              field: customer_id
      - name: amount
        tests:
          - not_null
          - dbt_expectations.expect_column_values_to_be_between:
              min_value: 0
              max_value: 1000000
      - name: order_date
        tests:
          - not_null
          - dbt_expectations.expect_column_values_to_be_between:
              min_value: "'2010-01-01'"
              max_value: "'2030-12-31'"
    tests:
      - dbt_utils.equal_rowcount:
          compare_model: ref('teradata_orders_count')
```

### 7.5 Validation dashboard

Build a Power BI dashboard tracking:

| Metric | Source | Target | Status |
| --- | --- | --- | --- |
| Table count | 3,247 | 3,247 | Match |
| Total rows | 45.2B | 45.2B | Match |
| Checksum (orders) | 8,291,038,291 | 8,291,038,291 | Match |
| Golden query 1 | $142.3M | $142.3M | Match |
| Golden query 2 | 89,201 | 89,201 | Match |
| CDC lag | — | 12 min | OK |
| Last sync | — | 2024-01-15 14:30 | OK |

---

## 8. Bulk transfer for large estates

### 8.1 Azure Data Box for initial load

| Data volume | Recommended approach | Timeline |
| --- | --- | --- |
| < 10 TB | ExpressRoute direct transfer | 1-3 days |
| 10-100 TB | ExpressRoute (allow 3-14 days) | 1-2 weeks |
| 100 TB - 1 PB | Azure Data Box Heavy (multiple devices) | 2-4 weeks |
| > 1 PB | Data Box Heavy + ExpressRoute for delta | 4-8 weeks |

### 8.2 Data Box workflow

```
1. Order Data Box Heavy from Azure Portal
2. Receive device (5-10 business days)
3. Connect to on-prem network
4. TPT export → Parquet → Data Box local storage
5. Ship Data Box to Azure datacenter
6. Microsoft uploads to ADLS
7. Verify data in ADLS (checksums)
8. Convert Parquet → Delta in Databricks
```

### 8.3 Parallel extraction strategy

For large estates, parallelize extraction by table and by partition:

```bash
#!/bin/bash
# parallel_extract.sh
# Run multiple TPT exports simultaneously

MAX_PARALLEL=8
RUNNING=0

for TABLE_SCRIPT in /scripts/tpt/*.tpt; do
    while [ $RUNNING -ge $MAX_PARALLEL ]; do
        wait -n
        RUNNING=$((RUNNING - 1))
    done

    echo "Starting export: $(basename $TABLE_SCRIPT)"
    tbuild -f "$TABLE_SCRIPT" -v "/logs/$(basename $TABLE_SCRIPT .tpt).log" &
    RUNNING=$((RUNNING + 1))
done

wait
echo "All exports complete"
```

---

## 9. Migration runbook template

### Pre-migration checklist

- [ ] SHIR installed and connected to ADF
- [ ] Teradata JDBC driver deployed on SHIR
- [ ] Teradata linked service tested in ADF
- [ ] ADLS containers created (raw, bronze, silver)
- [ ] Network connectivity verified (ExpressRoute or VPN)
- [ ] Teradata export user created with read-only access
- [ ] Teradata workload class allocated for export queries
- [ ] TPT scripts generated for all in-scope tables
- [ ] Golden queries documented and baseline results captured

### Migration day checklist

- [ ] Start TPT bulk export (largest tables first)
- [ ] Monitor Teradata workload impact (ViewPoint)
- [ ] Upload completed exports to ADLS (azcopy)
- [ ] Verify row counts per table
- [ ] Start bronze → silver conversion (Databricks)
- [ ] Run column-level checksum validation
- [ ] Start CDC pipeline (Qlik / ADF incremental)
- [ ] Run golden query validation
- [ ] Document any discrepancies and resolution

### Post-migration checklist

- [ ] All tables migrated and validated
- [ ] CDC pipeline running with < 30 min latency
- [ ] Golden queries passing (100%)
- [ ] BI dashboards repointed and validated
- [ ] Downstream consumers repointed and tested
- [ ] Teradata set to read-only mode
- [ ] 14-day parallel run initiated

---

## 10. Related resources

- [SQL Migration](sql-migration.md) — SQL conversion patterns
- [Tutorial — TPT to ADF](tutorial-tpt-to-adf.md) — Step-by-step TPT replacement
- [Tutorial — BTEQ to dbt](tutorial-bteq-to-dbt.md) — BTEQ script conversion
- [Feature Mapping](feature-mapping-complete.md) — TPT/BTEQ/FastLoad/MultiLoad equivalents
- [Teradata Migration Overview](../teradata.md) — Bulk load and CDC overview
- `docs/SELF_HOSTED_IR.md` — SHIR setup guide
- `docs/ADF_SETUP.md` — ADF configuration

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
