# Tutorial: Migrate Snowflake Data Sharing to Delta Sharing

**Status:** Authored 2026-04-30
**Audience:** Data architects, data stewards, and engineers managing Snowflake Secure Data Sharing
**Prerequisites:** Databricks workspace with Unity Catalog, partner agencies identified, existing Snowflake shares documented

---

## What you will build

By the end of this tutorial, you will have:

1. Inventoried all existing Snowflake shares (provider and consumer)
2. Set up Delta Sharing on your Databricks workspace
3. Created shares and recipients for each partner
4. Configured OneLake shortcuts for Azure-to-Azure consumers
5. Validated data parity between Snowflake shares and Delta shares
6. Provided consumer access instructions for multiple client types

---

## Step 1: Inventory existing Snowflake shares

### 1.1 List all outbound shares (you are the provider)

```sql
-- Snowflake: List all shares you provide
SHOW SHARES;

-- Detailed share information
SELECT
    share_name,
    database_name,
    owner,
    kind,
    created_on,
    comment
FROM INFORMATION_SCHEMA.APPLICABLE_ROLES
-- Or use:
SHOW GRANTS OF SHARE <share_name>;
```

### 1.2 List all inbound shares (you are the consumer)

```sql
-- Snowflake: List shares you consume
SHOW SHARES;

-- Filter to inbound shares
SELECT *
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "kind" = 'INBOUND';
```

### 1.3 Document each share

Create an inventory spreadsheet:

| Share name         | Direction | Partner       | Objects shared    | Refresh | SLA   | Consumers | Notes        |
| ------------------ | --------- | ------------- | ----------------- | ------- | ----- | --------- | ------------ |
| finance_data_share | Outbound  | Agency B      | 5 tables, 2 views | Live    | 99.5% | 3 users   | MOU-2026-042 |
| hr_analytics_share | Outbound  | Agency C      | 3 tables          | Live    | 99.0% | 5 users   | DUA-2025-018 |
| census_data        | Inbound   | Census Bureau | 12 tables         | Daily   | N/A   | 10 users  | Public data  |

---

## Step 2: Set up Delta Sharing (provider side)

### 2.1 Verify Unity Catalog sharing is enabled

```sql
-- Databricks SQL: Check metastore sharing settings
-- Navigate to: Databricks Workspace > Catalog > Sharing > Enabled
-- Or via API:
-- GET /api/2.1/unity-catalog/metastore-summary
```

### 2.2 Create shares for each outbound share

**Example: Migrating `finance_data_share`**

```sql
-- Create the Delta share
CREATE SHARE IF NOT EXISTS finance_data_share
COMMENT 'Financial data shared with Agency B per MOU-2026-042. Migrated from Snowflake share.';

-- Add tables to the share
ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.fct_invoice_aging;

ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.fct_payment_summary;

ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.dim_vendors;

ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.dim_cost_centers;

ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.dim_fiscal_periods;

-- Add views if needed
ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.v_vendor_performance;

ALTER SHARE finance_data_share
ADD TABLE analytics_prod.marts.v_aging_summary;
```

### 2.3 Verify share contents

```sql
-- List all objects in the share
SHOW ALL IN SHARE finance_data_share;

-- Verify table data is accessible
SELECT COUNT(*) FROM analytics_prod.marts.fct_invoice_aging;
```

---

## Step 3: Create recipients

### 3.1 Create a recipient for each consumer

```sql
-- Create recipient for Agency B
CREATE RECIPIENT IF NOT EXISTS agency_b_finance_team
COMMENT 'Agency B data engineering team - MOU-2026-042';

-- Grant the share to the recipient
GRANT SELECT ON SHARE finance_data_share TO RECIPIENT agency_b_finance_team;

-- Get the activation link
DESCRIBE RECIPIENT agency_b_finance_team;
-- Copy the 'activation_link' value -- this is a one-time URL
```

### 3.2 For recipients with Databricks (open sharing)

If the recipient has their own Databricks workspace:

```sql
-- Create recipient using the recipient's sharing identifier
CREATE RECIPIENT IF NOT EXISTS agency_b_databricks
USING ID 'aws:us-east-1:recipient-sharing-id'
COMMENT 'Agency B Databricks workspace';

GRANT SELECT ON SHARE finance_data_share TO RECIPIENT agency_b_databricks;
```

### 3.3 Document recipients

| Recipient             | Activation method | Platform         | Contact               | Share(s)           |
| --------------------- | ----------------- | ---------------- | --------------------- | ------------------ |
| agency_b_finance_team | Activation link   | pandas/DuckDB    | data-team@agencyb.gov | finance_data_share |
| agency_b_databricks   | Sharing ID        | Databricks       | data-team@agencyb.gov | finance_data_share |
| agency_c_fabric       | Activation link   | Microsoft Fabric | analytics@agencyc.gov | hr_analytics_share |

---

## Step 4: Set up OneLake shortcuts (Azure-to-Azure)

For consumers who are also on Azure (Fabric or Azure storage), OneLake shortcuts are simpler than Delta Sharing.

### 4.1 Provider: Ensure data is in OneLake or ADLS Gen2

If your Delta tables are in a Databricks-managed location, you may need to create an external location first:

```sql
-- Create external location pointing to your ADLS Gen2
CREATE EXTERNAL LOCATION IF NOT EXISTS finance_external
URL 'abfss://finance@stadatalakeprod.dfs.core.windows.net/'
WITH (STORAGE CREDENTIAL finance_storage_cred);
```

### 4.2 Provider: Grant consumer access to storage

```bash
# Azure CLI: Grant the consumer's Entra identity read access
# (The consumer's service principal or managed identity)
az role assignment create \
    --role "Storage Blob Data Reader" \
    --assignee "consumer-service-principal-id" \
    --scope "/subscriptions/sub-id/resourceGroups/rg-name/providers/Microsoft.Storage/storageAccounts/stadatalakeprod/blobServices/default/containers/finance"
```

### 4.3 Consumer: Create OneLake shortcut in Fabric

The consumer does this in their Fabric workspace:

1. Open the Fabric Lakehouse
2. Right-click the **Tables** folder
3. Select **New shortcut**
4. Choose **Azure Data Lake Storage Gen2**
5. Enter the provider's storage URL: `https://stadatalakeprod.dfs.core.windows.net/`
6. Authenticate with their service principal
7. Browse to the Delta table folder (e.g., `finance/marts/fct_invoice_aging/`)
8. Name the shortcut (e.g., `fct_invoice_aging`)
9. Click **Create**

The shared table now appears as a native Lakehouse table in the consumer's workspace.

### 4.4 Consumer: Create OneLake shortcut via REST API

```python
# Fabric REST API: Create shortcut programmatically
import requests

headers = {
    "Authorization": f"Bearer {fabric_token}",
    "Content-Type": "application/json"
}

shortcut_payload = {
    "path": "Tables/fct_invoice_aging",
    "target": {
        "adlsGen2": {
            "location": "https://stadatalakeprod.dfs.core.windows.net/",
            "subpath": "finance/marts/fct_invoice_aging",
            "connectionId": "connection-guid"
        }
    }
}

response = requests.post(
    f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}/items/{lakehouse_id}/shortcuts",
    headers=headers,
    json=shortcut_payload
)
print(f"Shortcut created: {response.status_code}")
```

---

## Step 5: Consumer access guide

Send this guide to each consumer based on their platform.

### 5.1 Databricks consumer

```sql
-- Step 1: Accept the share (via activation link or sharing ID)
-- Navigate to Databricks Workspace > Catalog > Shared with me
-- Click on the pending share and accept it

-- Step 2: Create a catalog from the share
CREATE CATALOG IF NOT EXISTS agency_a_finance_shared
USING SHARE provider_org.finance_data_share;

-- Step 3: Query shared data
SELECT *
FROM agency_a_finance_shared.marts.fct_invoice_aging
WHERE aging_bucket = '60+'
ORDER BY amount DESC
LIMIT 100;

-- Step 4: Verify freshness
SELECT MAX(updated_at) AS latest_data
FROM agency_a_finance_shared.marts.fct_invoice_aging;
```

### 5.2 Microsoft Fabric consumer

**Option A: Delta Sharing shortcut**

1. Open Fabric Lakehouse
2. Right-click Tables > New shortcut > Delta Sharing
3. Paste the activation link
4. Select tables to import
5. Tables appear in the Lakehouse

**Option B: OneLake shortcut (if provider granted ADLS access)**

See Step 4.3 above.

### 5.3 pandas / DuckDB consumer (no platform needed)

```python
# Consumer: Read Delta shares with pandas
import delta_sharing

# Download and save the share profile from the activation link
# Save as 'config.share' (JSON file)

# List available tables
profile = delta_sharing.SharingProfile.read("config.share")
tables = delta_sharing.list_all_tables(profile)
for table in tables:
    print(f"  {table.share}.{table.schema}.{table.name}")

# Read a shared table into pandas
df = delta_sharing.load_as_pandas(
    "config.share#finance_data_share.marts.fct_invoice_aging"
)
print(f"Rows: {len(df)}")
print(df.head())
```

```python
# Consumer: Read Delta shares with DuckDB
import duckdb

conn = duckdb.connect()
conn.sql("INSTALL delta; LOAD delta;")

# Read via Delta Sharing protocol
df = conn.sql("""
    SELECT *
    FROM delta_scan('path/to/shared/table')
    WHERE aging_bucket = '60+'
""").fetchdf()
```

### 5.4 Power BI consumer

1. In Power BI Desktop, select **Get Data** > **Delta Sharing**
2. Enter the activation link URL
3. Select tables to import
4. Build reports on shared data

---

## Step 6: Validate data parity

### 6.1 Row count comparison

```sql
-- Run on Snowflake (existing share)
SELECT
    'fct_invoice_aging' AS table_name,
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount,
    MAX(updated_at) AS latest_update
FROM FINANCE_DB.MARTS.FCT_INVOICE_AGING

UNION ALL

SELECT
    'dim_vendors',
    COUNT(*),
    NULL,
    MAX(updated_at)
FROM FINANCE_DB.MARTS.DIM_VENDORS;
```

```sql
-- Run on Databricks (new share)
SELECT
    'fct_invoice_aging' AS table_name,
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount,
    MAX(updated_at) AS latest_update
FROM analytics_prod.marts.fct_invoice_aging

UNION ALL

SELECT
    'dim_vendors',
    COUNT(*),
    NULL,
    MAX(updated_at)
FROM analytics_prod.marts.dim_vendors;
```

### 6.2 Schema comparison

```python
# Compare schemas between Snowflake and Databricks
import pandas as pd

snowflake_schema = pd.DataFrame([
    {"column": "invoice_id", "type": "VARCHAR", "nullable": False},
    {"column": "amount", "type": "NUMBER(18,2)", "nullable": False},
    {"column": "aging_bucket", "type": "VARCHAR", "nullable": True},
    # ... etc
])

databricks_schema = spark.table("analytics_prod.marts.fct_invoice_aging").schema
for field in databricks_schema:
    print(f"  {field.name}: {field.dataType} (nullable: {field.nullable})")
```

### 6.3 Data quality checks

```sql
-- Reconciliation query (run on Databricks after data is migrated)
SELECT
    'Row count match' AS check_name,
    CASE WHEN sf_count = db_count THEN 'PASS' ELSE 'FAIL' END AS status,
    sf_count AS snowflake_value,
    db_count AS databricks_value
FROM (
    SELECT
        (SELECT COUNT(*) FROM analytics_prod.validation.sf_invoice_aging_snapshot) AS sf_count,
        (SELECT COUNT(*) FROM analytics_prod.marts.fct_invoice_aging) AS db_count
)

UNION ALL

SELECT
    'Total amount match',
    CASE WHEN ABS(sf_total - db_total) / NULLIF(sf_total, 0) < 0.001 THEN 'PASS' ELSE 'FAIL' END,
    CAST(sf_total AS STRING),
    CAST(db_total AS STRING)
FROM (
    SELECT
        (SELECT SUM(amount) FROM analytics_prod.validation.sf_invoice_aging_snapshot) AS sf_total,
        (SELECT SUM(amount) FROM analytics_prod.marts.fct_invoice_aging) AS db_total
);
```

---

## Step 7: Cutover plan

### 7.1 Parallel run (2+ weeks)

1. Keep Snowflake share active
2. Start Delta share / OneLake shortcut
3. Ask consumers to validate both sources
4. Monitor freshness and accuracy daily
5. Collect consumer sign-off

### 7.2 Cutover execution

| Day    | Action                                         |
| ------ | ---------------------------------------------- |
| Day 0  | All consumers confirmed on Delta Sharing       |
| Day 1  | Set Snowflake share to read-only (no new data) |
| Day 3  | Verify no queries hitting Snowflake share      |
| Day 7  | Revoke Snowflake share grants                  |
| Day 14 | Drop Snowflake share                           |
| Day 30 | Update MOU/DUA documentation                   |

### 7.3 Communication template

Send to each consumer partner:

```
Subject: Data Sharing Migration: Snowflake to Delta Sharing

Dear [Partner Team],

We are migrating our data sharing infrastructure from Snowflake Secure
Data Sharing to Delta Sharing (open protocol). This change provides:

- Cross-platform access (Databricks, Fabric, pandas, Power BI, DuckDB)
- No licensing requirements on your side
- Open standard (Linux Foundation Delta Sharing protocol)
- Improved freshness and governance

Timeline:
- [Date]: Delta share available for testing
- [Date]: Parallel run begins (both shares active)
- [Date]: Snowflake share read-only
- [Date]: Snowflake share decommissioned

Your activation link: [link]
Consumer guide: [URL to this document]

Please confirm your access by [Date] and report any issues to
[data-platform-team@agency.gov].

Regards,
[Your Team]
```

---

## Step 8: Handle inbound shares (you are the consumer)

### 8.1 Partner stays on Snowflake

If a partner continues to share via Snowflake and you are leaving Snowflake:

**Option A: Lakehouse Federation** (read Snowflake from Databricks)

```sql
-- Create a connection to the partner's Snowflake
CREATE CONNECTION partner_snowflake
TYPE snowflake
OPTIONS (
    host 'partner-account.snowflakecomputing.com',
    port '443',
    user 'shared_reader',
    password SECRET ('scope', 'partner-snowflake-password')
);

-- Create a foreign catalog
CREATE FOREIGN CATALOG partner_census
USING CONNECTION partner_snowflake
OPTIONS (database 'CENSUS_DATA');

-- Query partner data via federation
SELECT * FROM partner_census.public.population_estimates LIMIT 100;
```

**Option B: Negotiate Delta Sharing** with the partner

Request that the partner also set up Delta Sharing, so both sides use the open protocol.

### 8.2 Partner moves to Azure

If the partner is also on Azure, negotiate OneLake shortcuts for the simplest setup.

---

## Common issues and solutions

| Issue                                   | Solution                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| Activation link expired                 | Generate a new recipient and activation link                                           |
| Consumer cannot authenticate            | Verify Entra ID permissions for OneLake shortcuts; verify activation for Delta Sharing |
| Data freshness lag                      | Delta shares are live (latest Delta version); check table update pipeline              |
| Schema mismatch                         | Compare Snowflake schema vs Delta schema; handle type differences (VARCHAR vs STRING)  |
| Consumer needs data in non-Delta format | Delta Sharing delivers Parquet; consumers can convert as needed                        |
| Partner refuses to leave Snowflake      | Use Lakehouse Federation as a bridge; plan for long-term federation                    |

---

## Related documents

- [Data Sharing Migration](data-sharing-migration.md) -- comprehensive data sharing migration guide
- [Feature Mapping](feature-mapping-complete.md) -- Section 8 for data sharing features
- [Security Migration](security-migration.md) -- access control for shared data
- [Best Practices](best-practices.md) -- data sharing alternatives and common pitfalls
- [Master playbook](../snowflake.md) -- Section 5, Phase 6 for data sharing cutover

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
