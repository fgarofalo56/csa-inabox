# Tutorial: Convert a NiFi Flow to an ADF Pipeline

**A step-by-step walkthrough of converting an Apache NiFi data ingestion flow into an Azure Data Factory pipeline with equivalent functionality, error handling, and scheduling.**

---

## Prerequisites

- Azure subscription with a resource group
- Azure Data Factory instance deployed
- Databricks workspace deployed (for validation steps)
- ADLS Gen2 storage account with bronze/silver containers
- Access to the source NiFi flow (running or exported)
- Basic familiarity with ADF Pipeline Editor

**Estimated time:** 2-3 hours

---

## The NiFi flow we are converting

This tutorial converts a real-world NiFi flow that ingests CSV files from an SFTP server, validates the schema, converts to Parquet, enriches with metadata, and loads to HDFS (migrated to ADLS Gen2).

### NiFi flow diagram

```
ListSFTP (vendor-sftp:/outbound/*.csv)
  ↓
FetchSFTP
  ↓
ValidateRecord (CSV schema: order_id INT, customer_id INT, amount DECIMAL, order_date DATE, status STRING)
  ↓ [valid]                          ↓ [invalid]
UpdateAttribute                    LogAttribute
(add: ingestion_ts, source=vendor)   ↓
  ↓                                PutFile (/quarantine/)
ConvertRecord (CSV → Parquet)        ↓
  ↓                                PutEmail (alert team)
PutHDFS (/data/raw/vendor_orders/)
```

### NiFi flow characteristics

- **Schedule:** Runs every 15 minutes
- **Volume:** 50-200 files per day, 1-50 MB each
- **Schema validation:** Enforces column names and types
- **Error handling:** Invalid files quarantined; email alert sent
- **Metadata:** Adds ingestion timestamp and source system tag

---

## Step 1: Create linked services

Before building the pipeline, create the connections ADF will use.

### 1.1 SFTP linked service

In ADF Studio, navigate to **Manage** > **Linked services** > **New**.

| Setting | Value |
|---|---|
| Name | `ls_sftp_vendor` |
| Type | SFTP |
| Host | `vendor-sftp.example.com` |
| Port | 22 |
| Authentication | SSH public key or password |
| Username | `vendor_user` |
| Key Vault reference | Select Key Vault secret for SSH key or password |

### 1.2 ADLS Gen2 linked service

| Setting | Value |
|---|---|
| Name | `ls_adls_datalake` |
| Type | Azure Data Lake Storage Gen2 |
| Authentication | Managed Identity (recommended) |
| URL | `https://yourstorageaccount.dfs.core.windows.net` |

### 1.3 Logic App linked service (for email alerts)

| Setting | Value |
|---|---|
| Name | `ls_logicapp_alert` |
| Type | REST (or Web Activity target) |
| Base URL | Logic App HTTP trigger URL |

---

## Step 2: Create datasets

### 2.1 Source dataset: SFTP CSV files

| Setting | Value |
|---|---|
| Name | `ds_sftp_vendor_csv` |
| Linked service | `ls_sftp_vendor` |
| Format | Delimited text (CSV) |
| Path | `/outbound/` |
| First row as header | Yes |
| Column delimiter | Comma |
| Parameters | `fileName` (String) |

### 2.2 Sink dataset: ADLS Parquet (bronze)

| Setting | Value |
|---|---|
| Name | `ds_adls_bronze_parquet` |
| Linked service | `ls_adls_datalake` |
| Format | Parquet |
| Path | `bronze/vendor_orders/` |
| Parameters | `fileName` (String) |

### 2.3 Quarantine dataset: ADLS CSV (quarantine)

| Setting | Value |
|---|---|
| Name | `ds_adls_quarantine_csv` |
| Linked service | `ls_adls_datalake` |
| Format | Delimited text (CSV) |
| Path | `quarantine/vendor_orders/` |

---

## Step 3: Build the pipeline

### 3.1 Pipeline overview

Create a new pipeline named `pl_vendor_order_ingestion`.

The pipeline structure:

```
GetMetadata (list SFTP files)
  ↓
Filter (*.csv files only)
  ↓
ForEach (parallel, batch=10)
  ├── Copy Activity (SFTP CSV → ADLS Bronze Parquet)
  │     ├── On Success → Set Variable (success_count += 1)
  │     └── On Failure → Copy to Quarantine + Web Activity (alert)
```

### 3.2 Activity 1: GetMetadata -- list files on SFTP

Drag a **GetMetadata** activity onto the canvas.

| Setting | Value |
|---|---|
| Name | `get_sftp_file_list` |
| Dataset | `ds_sftp_vendor_csv` |
| Field list | `childItems` |

### 3.3 Activity 2: Filter -- select only CSV files

Drag a **Filter** activity and connect it after GetMetadata.

| Setting | Value |
|---|---|
| Name | `filter_csv_files` |
| Items | `@activity('get_sftp_file_list').output.childItems` |
| Condition | `@endswith(item().name, '.csv')` |

### 3.4 Activity 3: ForEach -- process each file

Drag a **ForEach** activity and connect it after Filter.

| Setting | Value |
|---|---|
| Name | `for_each_csv_file` |
| Items | `@activity('filter_csv_files').output.value` |
| Sequential | No (parallel execution) |
| Batch count | 10 |

### 3.5 Inside ForEach: Copy Activity (main copy)

Inside the ForEach, add a **Copy Activity**.

| Setting | Value |
|---|---|
| Name | `copy_sftp_to_bronze` |
| Source dataset | `ds_sftp_vendor_csv` |
| Source file name | `@item().name` |
| Sink dataset | `ds_adls_bronze_parquet` |
| Sink file name | `@concat(replace(item().name, '.csv', ''), '_', formatDateTime(utcNow(), 'yyyyMMddHHmmss'), '.parquet')` |

**Mapping tab:** Define explicit column mapping to enforce schema (equivalent to NiFi's ValidateRecord):

| Source column | Sink column | Type |
|---|---|---|
| `order_id` | `order_id` | Int32 |
| `customer_id` | `customer_id` | Int32 |
| `amount` | `amount` | Decimal |
| `order_date` | `order_date` | Date |
| `status` | `status` | String |

**Additional columns** (equivalent to NiFi's UpdateAttribute):

| Column name | Value |
|---|---|
| `ingestion_timestamp` | `@utcNow()` |
| `source_system` | `vendor_sftp` |

### 3.6 Inside ForEach: failure handling

Add a **Copy Activity** for quarantine, connected to the main Copy on **Failure** dependency.

| Setting | Value |
|---|---|
| Name | `copy_to_quarantine` |
| Source | `ds_sftp_vendor_csv` with `@item().name` |
| Sink | `ds_adls_quarantine_csv` |
| Dependency | `copy_sftp_to_bronze` on Failure |

Add a **Web Activity** after the quarantine copy (equivalent to NiFi's PutEmail):

| Setting | Value |
|---|---|
| Name | `send_failure_alert` |
| URL | Logic App HTTP trigger URL |
| Method | POST |
| Body | `@json(concat('{"file":"', item().name, '","error":"', activity('copy_sftp_to_bronze').error.message, '","pipeline":"', pipeline().Pipeline, '","timestamp":"', utcNow(), '"}'))` |
| Dependency | `copy_to_quarantine` on Success |

---

## Step 4: Create the Logic App for email alerts

This replaces NiFi's PutEmail processor.

### 4.1 Create Logic App

In the Azure Portal:

1. Create a new **Logic App** (Consumption tier)
2. Name: `la-vendor-ingestion-alert`
3. Add trigger: **When an HTTP request is received**
4. Define JSON schema:

```json
{
    "type": "object",
    "properties": {
        "file": { "type": "string" },
        "error": { "type": "string" },
        "pipeline": { "type": "string" },
        "timestamp": { "type": "string" }
    }
}
```

5. Add action: **Send an email (V2)** (Office 365 Outlook connector)

| Setting | Value |
|---|---|
| To | `data-eng@example.com` |
| Subject | `Vendor file ingestion failure: @{triggerBody()?['file']}` |
| Body | `Pipeline @{triggerBody()?['pipeline']} failed to process file @{triggerBody()?['file']} at @{triggerBody()?['timestamp']}. Error: @{triggerBody()?['error']}` |

6. Save and copy the HTTP trigger URL into the ADF Web Activity.

---

## Step 5: Add schedule trigger

This replaces NiFi's scheduling (every 15 minutes).

1. In ADF Studio, go to the pipeline and click **Add trigger** > **New/Edit**
2. Create a **Schedule trigger**:

| Setting | Value |
|---|---|
| Name | `tr_vendor_ingestion_15min` |
| Type | Schedule |
| Recurrence | Every 15 minutes |
| Start date | `2026-05-01T00:00:00Z` |
| Time zone | UTC |

3. Publish the pipeline and trigger.

---

## Step 6: Validate the conversion

### 6.1 Functional validation

Run the pipeline manually and verify:

- [ ] Files are listed from SFTP correctly
- [ ] CSV files are copied and converted to Parquet in `bronze/vendor_orders/`
- [ ] Additional columns (`ingestion_timestamp`, `source_system`) are present in Parquet
- [ ] Invalid files (wrong schema) are quarantined in `quarantine/vendor_orders/`
- [ ] Email alert is sent for failed files
- [ ] Pipeline completes within expected time

### 6.2 Data validation

```sql
-- Databricks SQL: verify data landed correctly
SELECT
    COUNT(*) AS row_count,
    MIN(ingestion_timestamp) AS earliest_ingestion,
    MAX(ingestion_timestamp) AS latest_ingestion,
    COUNT(DISTINCT source_system) AS source_count
FROM bronze.vendor_orders;

-- Verify schema
DESCRIBE EXTENDED bronze.vendor_orders;

-- Spot-check data quality
SELECT *
FROM bronze.vendor_orders
WHERE order_id IS NULL OR customer_id IS NULL OR amount IS NULL
LIMIT 10;
```

### 6.3 Comparison with NiFi output

Run both NiFi and ADF on the same input files and compare:

```sql
-- Compare row counts
SELECT 'nifi' AS source, COUNT(*) AS rows FROM bronze.vendor_orders_nifi
UNION ALL
SELECT 'adf' AS source, COUNT(*) AS rows FROM bronze.vendor_orders_adf;

-- Compare checksums
SELECT
    SUM(CAST(order_id AS BIGINT)) AS sum_order_id,
    SUM(CAST(amount * 100 AS BIGINT)) AS sum_amount_cents
FROM bronze.vendor_orders_nifi;

SELECT
    SUM(CAST(order_id AS BIGINT)) AS sum_order_id,
    SUM(CAST(amount * 100 AS BIGINT)) AS sum_amount_cents
FROM bronze.vendor_orders_adf;
```

---

## Step 7: Add monitoring

### 7.1 ADF monitoring (replaces NiFi bulletin board)

ADF provides built-in pipeline monitoring:

- **ADF Studio** > **Monitor** > **Pipeline runs**: View all executions, duration, and status
- **Activity runs**: Drill into each activity for row counts, duration, and errors
- **Trigger runs**: Verify schedule trigger is firing correctly

### 7.2 Azure Monitor alerts (replaces NiFi process group alerts)

Create alerts for:

| Alert | Condition | Action |
|---|---|---|
| Pipeline failure | Pipeline run status = Failed | Email + Teams notification |
| Long-running pipeline | Duration > 30 minutes | Email notification |
| No data in 2 hours | Custom metric (row count = 0) | Email + PagerDuty |

---

## NiFi to ADF mapping summary for this tutorial

| NiFi component | ADF equivalent | Tutorial step |
|---|---|---|
| ListSFTP | GetMetadata activity | Step 3.2 |
| FetchSFTP | Copy Activity (source) | Step 3.5 |
| ValidateRecord | Copy Activity column mapping (schema enforcement) | Step 3.5 |
| UpdateAttribute | Copy Activity additional columns | Step 3.5 |
| ConvertRecord (CSV → Parquet) | Copy Activity sink format = Parquet | Step 3.5 |
| PutHDFS | Copy Activity sink (ADLS Gen2) | Step 3.5 |
| RouteOnAttribute (valid/invalid) | Copy Activity success/failure dependency | Step 3.6 |
| PutFile (quarantine) | Copy Activity to quarantine container | Step 3.6 |
| PutEmail | Logic App via Web Activity | Step 4 |
| NiFi schedule (15 min) | ADF Schedule Trigger | Step 5 |
| NiFi bulletin board | ADF Monitor + Azure Monitor alerts | Step 7 |

---

## Common issues during NiFi-to-ADF conversion

| Issue | Cause | Solution |
|---|---|---|
| SFTP connection timeout | Firewall blocking ADF | Use Self-Hosted IR behind the firewall. |
| Schema mismatch errors | Source CSV has unexpected columns | Add fault tolerance in Copy Activity settings. |
| Duplicate files on retry | ADF re-processes after partial failure | Use file naming with timestamps to avoid overwrites. |
| Email not sent on failure | Logic App URL incorrect or expired | Regenerate Logic App trigger URL; test independently. |
| Slow file processing | Sequential ForEach | Set `isSequential: false` and `batchCount: 10+`. |
| Files left on SFTP | NiFi auto-deleted after fetch; ADF does not | Add a Delete Activity after successful copy. |

---

## Next steps

1. **Review the [NiFi Migration Guide](nifi-migration.md)** for the full processor mapping
2. **Try the [Impala to Databricks Tutorial](tutorial-impala-to-databricks.md)** for SQL workload migration
3. **Read the [Best Practices](best-practices.md)** for migration strategy guidance

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
