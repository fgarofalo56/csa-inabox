# Tutorial: Migrate an S3 Bucket to ADLS Gen2

**Status:** Authored 2026-04-30
**Audience:** Data engineers migrating AWS S3 storage to Azure Data Lake Storage Gen2 as part of a broader AWS-to-Azure analytics migration.
**Prerequisites knowledge:** AWS S3, Azure Storage, CLI tools, basic networking.
**Time estimate:** 4-8 hours for a single bucket (excluding data transfer time for large datasets).

---

## Overview

This tutorial walks through migrating a single S3 bucket to ADLS Gen2, setting up a hybrid bridge via OneLake shortcuts, converting file formats to Delta Lake, and validating data parity. By the end, your data lives natively on ADLS Gen2 with Delta Lake tables registered in Unity Catalog.

> **AWS comparison:** In AWS, your data lake is S3 buckets + Glue Catalog. In Azure, the equivalent is ADLS Gen2 containers + Unity Catalog (runtime metadata) + Purview (enterprise governance). OneLake provides a unified namespace across all storage, similar to how S3 Access Points abstract bucket topology.

---

## Prerequisites

### Tools

| Tool | Minimum version | Install |
|------|----------------|---------|
| AWS CLI | 2.x | `pip install awscli` or MSI installer |
| Azure CLI | 2.60+ | `curl -sL https://aka.ms/InstallAzureCLIDeb \| sudo bash` |
| AzCopy | 10.24+ | [Download](https://learn.microsoft.com/azure/storage/common/storage-use-azcopy-v10) |
| Databricks CLI | 0.220+ | `pip install databricks-cli` |
| jq | 1.6+ | `sudo apt install jq` or `brew install jq` |

### AWS access

- IAM credentials with `s3:ListBucket`, `s3:GetObject`, `s3:GetBucketLocation` on the source bucket.
- If using S3-to-AzCopy directly: the bucket must allow public-list or you must generate pre-signed URLs / use an IAM role with programmatic access.

### Azure access

- An Azure subscription (commercial or Azure Government).
- Permissions: `Contributor` on the resource group, `Storage Blob Data Contributor` on the target storage account.
- A Databricks workspace with Unity Catalog enabled (for format conversion steps).

---

## Step 1: Inventory the S3 bucket

Before migrating anything, understand what you are moving.

```bash
# Set the source bucket
SOURCE_BUCKET="s3://acme-analytics-raw"

# List top-level prefixes (folders)
aws s3 ls ${SOURCE_BUCKET}/ --summarize

# Get total object count and size
aws s3 ls ${SOURCE_BUCKET} --recursive --summarize | tail -2
# Example output:
#   Total Objects: 1,247,832
#   Total Size: 2.3 TiB

# Inventory file types
aws s3 ls ${SOURCE_BUCKET} --recursive | \
  awk '{print $4}' | \
  sed 's/.*\.//' | \
  sort | uniq -c | sort -rn | head -20
# Example output:
#   834210 parquet
#   201445 json
#   112034 csv
#   100143 orc

# Check bucket region
aws s3api get-bucket-location --bucket acme-analytics-raw
# Example: {"LocationConstraint": "us-gov-west-1"}

# List lifecycle rules (to replicate on Azure)
aws s3api get-bucket-lifecycle-configuration --bucket acme-analytics-raw
```

Record the following in your migration tracker:

| Attribute | Value |
|-----------|-------|
| Bucket name | `acme-analytics-raw` |
| Region | `us-gov-west-1` |
| Total size | 2.3 TiB |
| Object count | 1,247,832 |
| Primary formats | Parquet (67%), JSON (16%), CSV (9%), ORC (8%) |
| Lifecycle rules | 90-day transition to S3-IA, 365-day to Glacier |
| Encryption | SSE-S3 (AES-256) |
| Versioning | Enabled |

> **AWS comparison:** In AWS, `aws s3 ls --recursive --summarize` is the standard inventory command. In Azure, the equivalent is `az storage blob list --account-name <name> --container-name <name> --query "[].{name:name, size:properties.contentLength}" -o table`.

---

## Step 2: Create the ADLS Gen2 storage account

```bash
# Variables
RESOURCE_GROUP="rg-analytics-migration"
STORAGE_ACCOUNT="acmeanalyticsgov"    # Must be globally unique, 3-24 chars, lowercase
LOCATION="usgovvirginia"              # Use "eastus2" for commercial Azure
SUBSCRIPTION="<your-subscription-id>"

# Set subscription
az account set --subscription ${SUBSCRIPTION}

# Create resource group (if it doesn't exist)
az group create \
  --name ${RESOURCE_GROUP} \
  --location ${LOCATION}

# Create ADLS Gen2 storage account with hierarchical namespace
az storage account create \
  --name ${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --location ${LOCATION} \
  --sku Standard_ZRS \
  --kind StorageV2 \
  --hns true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --require-infrastructure-encryption true \
  --encryption-services blob file \
  --tags environment=migration project=analytics-migration

# Create containers matching the medallion architecture
for CONTAINER in bronze silver gold archive; do
  az storage container create \
    --name ${CONTAINER} \
    --account-name ${STORAGE_ACCOUNT} \
    --auth-mode login
done

# Verify HNS is enabled (this is what makes it "Gen2")
az storage account show \
  --name ${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --query "isHnsEnabled"
# Expected: true
```

> **AWS comparison:** In AWS, you create an S3 bucket with `aws s3 mb`. ADLS Gen2 is a storage account with hierarchical namespace (HNS) enabled. HNS gives you true directory operations (rename is O(1), not O(n) like S3 prefix renames). The `--hns true` flag is critical -- without it, you get Blob Storage, not Data Lake Storage Gen2.

### Set up lifecycle management (matching S3 lifecycle rules)

```bash
# Create lifecycle policy JSON
cat > /tmp/lifecycle-policy.json << 'EOF'
{
  "rules": [
    {
      "enabled": true,
      "name": "archive-old-bronze",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToCool": { "daysAfterModificationGreaterThan": 90 },
            "tierToArchive": { "daysAfterModificationGreaterThan": 365 }
          }
        },
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["bronze/"]
        }
      }
    }
  ]
}
EOF

az storage account management-policy create \
  --account-name ${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --policy @/tmp/lifecycle-policy.json
```

---

## Step 3: Configure networking

Choose one of the following approaches based on your migration scenario.

### Option A: ExpressRoute / VPN (recommended for production)

If you have an ExpressRoute circuit or site-to-site VPN between AWS and Azure:

```bash
# Enable private endpoint for the storage account
az network private-endpoint create \
  --name pe-${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --vnet-name vnet-analytics \
  --subnet snet-private-endpoints \
  --private-connection-resource-id $(az storage account show \
    --name ${STORAGE_ACCOUNT} \
    --resource-group ${RESOURCE_GROUP} \
    --query id -o tsv) \
  --group-id blob \
  --connection-name plc-${STORAGE_ACCOUNT}

# Disable public network access after private endpoint is confirmed
az storage account update \
  --name ${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --public-network-access Disabled
```

### Option B: Public endpoint with IP restrictions (for initial migration)

```bash
# Allow only your migration server's IP
MIGRATION_SERVER_IP="203.0.113.50"

az storage account network-rule add \
  --account-name ${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --ip-address ${MIGRATION_SERVER_IP}

az storage account update \
  --name ${STORAGE_ACCOUNT} \
  --resource-group ${RESOURCE_GROUP} \
  --default-action Deny
```

> **AWS comparison:** In AWS, you restrict bucket access via bucket policies and VPC endpoints. In Azure, you use network rules (IP allowlists), private endpoints (equivalent to VPC endpoints), and service endpoints. The Private Endpoint model is more explicit than S3's VPC endpoint -- each storage account gets a dedicated NIC in your VNet.

---

## Step 4: Run AzCopy from S3 to ADLS Gen2

AzCopy natively supports S3-to-Azure transfers without an intermediate staging location.

### Generate a SAS token for the target

```bash
# Generate a SAS token valid for 7 days
END_DATE=$(date -u -d "+7 days" '+%Y-%m-%dT%H:%MZ')

SAS_TOKEN=$(az storage account generate-sas \
  --account-name ${STORAGE_ACCOUNT} \
  --permissions rwdlacup \
  --resource-types sco \
  --services b \
  --expiry ${END_DATE} \
  --output tsv)
```

### Set AWS credentials for AzCopy

```bash
# AzCopy reads these environment variables for S3 access
export AWS_ACCESS_KEY_ID="<your-access-key>"
export AWS_SECRET_ACCESS_KEY="<your-secret-key>"
# For GovCloud:
export AWS_REGION="us-gov-west-1"
```

### Run the transfer

```bash
# Full bucket copy: S3 → ADLS Gen2 bronze container
azcopy copy \
  "https://s3-us-gov-west-1.amazonaws.com/acme-analytics-raw/" \
  "https://${STORAGE_ACCOUNT}.blob.core.usgovcloudapi.net/bronze/?${SAS_TOKEN}" \
  --recursive \
  --s2s-preserve-access-tier=false \
  --include-pattern "*.parquet;*.json;*.csv;*.orc" \
  --log-level INFO \
  --cap-mbps 1000

# Monitor progress (AzCopy logs to ~/.azcopy/)
azcopy jobs list
azcopy jobs show <job-id>

# For very large migrations (10+ TiB), run in parallel by prefix:
for PREFIX in sales/ inventory/ customers/ logs/; do
  azcopy copy \
    "https://s3-us-gov-west-1.amazonaws.com/acme-analytics-raw/${PREFIX}" \
    "https://${STORAGE_ACCOUNT}.blob.core.usgovcloudapi.net/bronze/${PREFIX}?${SAS_TOKEN}" \
    --recursive \
    --s2s-preserve-access-tier=false \
    --log-level INFO &
done
wait
```

**Expected transfer rates:**

| Network path | Throughput | 2 TiB estimate |
|-------------|-----------|-----------------|
| Public internet | 200-500 Mbps | 9-22 hours |
| ExpressRoute 1 Gbps | 800-900 Mbps | 5-6 hours |
| ExpressRoute 10 Gbps | 5-8 Gbps | 35-55 minutes |

> **AWS comparison:** In AWS, cross-region replication or `aws s3 sync` handles bucket-to-bucket copies. AzCopy is the Azure equivalent of `aws s3 sync` but with native S3-source support. For datasets over 50 TiB, consider Azure Data Box instead of network transfer.

---

## Step 5: Set up OneLake shortcut to S3 (hybrid bridge)

During the migration period, consumers need to read from both S3 (historical data not yet migrated) and ADLS Gen2 (newly landing data). OneLake shortcuts solve this without copying data.

### Create the shortcut via Fabric REST API

```bash
# Prerequisites: a Fabric workspace and lakehouse
WORKSPACE_ID="<fabric-workspace-id>"
LAKEHOUSE_ID="<fabric-lakehouse-id>"

# Create an S3 shortcut in OneLake
curl -X POST \
  "https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE_ID}/items/${LAKEHOUSE_ID}/shortcuts" \
  -H "Authorization: Bearer $(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Tables/s3_raw_sales",
    "name": "s3_raw_sales",
    "target": {
      "amazonS3": {
        "location": "https://s3.us-gov-west-1.amazonaws.com",
        "subpath": "acme-analytics-raw/sales/",
        "connectionId": "<s3-connection-id>"
      }
    }
  }'
```

### Register the shortcut in Databricks via Unity Catalog

```sql
-- In Databricks SQL, create an external location pointing to the S3 shortcut
CREATE EXTERNAL LOCATION IF NOT EXISTS s3_bridge_raw
  URL 'abfss://raw@onelake.dfs.fabric.microsoft.com/sales/'
  WITH (STORAGE CREDENTIAL onelake_credential);

-- Create a table over the shortcut (read-only during migration)
CREATE TABLE IF NOT EXISTS migration_bridge.raw.sales_s3
  USING PARQUET
  LOCATION 'abfss://raw@onelake.dfs.fabric.microsoft.com/sales/';
```

> **AWS comparison:** In AWS, Athena's federated queries or Redshift Spectrum let you query data in external locations. OneLake shortcuts serve the same purpose but work across cloud boundaries -- your Databricks queries read S3 data through OneLake without copying it. This is the single most valuable migration pattern: keep S3 read-only while Azure warms up.

---

## Step 6: Convert Parquet/ORC to Delta Lake format

Once data is on ADLS Gen2, convert it to Delta Lake for ACID transactions, time travel, and Z-ordering.

### Databricks notebook: Bulk format conversion

```python
# Notebook: convert_to_delta.py
# Run on a Databricks cluster with Unity Catalog enabled

from pyspark.sql import SparkSession
from pyspark.sql.functions import input_file_name, current_timestamp
import logging

# Configuration
STORAGE_ACCOUNT = "acmeanalyticsgov"
SOURCE_CONTAINER = "bronze"
TARGET_CATALOG = "analytics_prod"
TARGET_SCHEMA = "bronze"

source_base = f"abfss://{SOURCE_CONTAINER}@{STORAGE_ACCOUNT}.dfs.core.usgovcloudapi.net"

# List of datasets to convert (prefix, format, partition_cols)
datasets = [
    ("sales/", "parquet", ["year", "month"]),
    ("inventory/", "parquet", ["region"]),
    ("customers/", "json", []),
    ("logs/", "orc", ["date"]),
]

for prefix, fmt, partition_cols in datasets:
    source_path = f"{source_base}/{prefix}"
    table_name = prefix.rstrip("/").replace("/", "_")
    full_table = f"{TARGET_CATALOG}.{TARGET_SCHEMA}.{table_name}"

    print(f"Converting {source_path} ({fmt}) -> {full_table}")

    # Read source format
    df = spark.read.format(fmt).load(source_path)

    # Add metadata columns
    df = df.withColumn("_source_file", input_file_name()) \
           .withColumn("_ingested_at", current_timestamp())

    # Write as Delta with optional partitioning
    writer = df.write.format("delta").mode("overwrite")
    if partition_cols:
        writer = writer.partitionBy(*partition_cols)

    writer.saveAsTable(full_table)

    # Optimize the new Delta table
    spark.sql(f"OPTIMIZE {full_table}")

    row_count = spark.sql(f"SELECT COUNT(*) AS cnt FROM {full_table}").first().cnt
    print(f"  -> {full_table}: {row_count:,} rows written")
```

### Run OPTIMIZE and ZORDER for query performance

```sql
-- After conversion, optimize tables for common query patterns
OPTIMIZE analytics_prod.bronze.sales
  ZORDER BY (product_id, region);

OPTIMIZE analytics_prod.bronze.inventory
  ZORDER BY (sku, warehouse_id);

-- Verify table properties
DESCRIBE EXTENDED analytics_prod.bronze.sales;
-- Look for: Provider = delta, Location = abfss://...
```

> **AWS comparison:** In AWS, you might use Glue jobs or Athena CTAS to convert between formats. In Azure, Databricks notebooks with `spark.read.format("parquet").write.format("delta")` serve the same purpose. The key difference is that Delta Lake tables are ACID-compliant -- you get time travel, schema enforcement, and `MERGE` operations that Parquet-on-S3 lacks without Iceberg/Hudi.

---

## Step 7: Validate data parity

Never trust a migration without validation. Run these checks for every dataset.

### Row count validation

```python
# Databricks notebook: validate_parity.py

import hashlib

datasets_to_validate = [
    {
        "name": "sales",
        "s3_table": "migration_bridge.raw.sales_s3",
        "azure_table": "analytics_prod.bronze.sales",
        "key_columns": ["order_id"],
        "measure_columns": ["quantity", "gross_amount"],
    }
]

results = []

for ds in datasets_to_validate:
    # Row counts
    s3_count = spark.sql(f"SELECT COUNT(*) AS cnt FROM {ds['s3_table']}").first().cnt
    az_count = spark.sql(f"SELECT COUNT(*) AS cnt FROM {ds['azure_table']}").first().cnt

    # Aggregate checksums on measure columns
    measures = ", ".join([f"SUM(CAST({c} AS DOUBLE)) AS sum_{c}" for c in ds["measure_columns"]])
    s3_sums = spark.sql(f"SELECT {measures} FROM {ds['s3_table']}").first()
    az_sums = spark.sql(f"SELECT {measures} FROM {ds['azure_table']}").first()

    match = (s3_count == az_count)
    for c in ds["measure_columns"]:
        s3_val = getattr(s3_sums, f"sum_{c}")
        az_val = getattr(az_sums, f"sum_{c}")
        if abs(s3_val - az_val) > 0.01:
            match = False

    results.append({
        "dataset": ds["name"],
        "s3_rows": s3_count,
        "azure_rows": az_count,
        "row_match": s3_count == az_count,
        "checksum_match": match,
    })

    print(f"{ds['name']}: S3={s3_count:,} Azure={az_count:,} Match={match}")

# Create summary table
results_df = spark.createDataFrame(results)
results_df.display()
```

### Schema comparison

```sql
-- Compare schemas between S3 source and Delta target
DESCRIBE TABLE migration_bridge.raw.sales_s3;
DESCRIBE TABLE analytics_prod.bronze.sales;

-- Check for type mismatches (common: string vs int, timestamp precision)
SELECT
  s.col_name,
  s.data_type AS s3_type,
  a.data_type AS azure_type,
  CASE WHEN s.data_type = a.data_type THEN 'MATCH' ELSE 'MISMATCH' END AS status
FROM (
  SELECT col_name, data_type
  FROM (DESCRIBE TABLE migration_bridge.raw.sales_s3)
  WHERE col_name NOT LIKE '#%'
) s
FULL OUTER JOIN (
  SELECT col_name, data_type
  FROM (DESCRIBE TABLE analytics_prod.bronze.sales)
  WHERE col_name NOT LIKE '#%' AND col_name NOT LIKE '_%'
) a ON s.col_name = a.col_name;
```

---

## Step 8: Update downstream consumers

Once validation passes, redirect consumers from S3 to ADLS Gen2.

### Update Databricks notebooks/jobs

```python
# Before (reading from S3 via shortcut)
df = spark.read.table("migration_bridge.raw.sales_s3")

# After (reading from native Delta on ADLS Gen2)
df = spark.read.table("analytics_prod.bronze.sales")
```

### Update ADF pipelines

In Azure Data Factory linked services, change the dataset path from the OneLake shortcut location to the native ADLS Gen2 path:

```json
{
  "type": "AzureBlobFSLocation",
  "fileName": "",
  "folderPath": "sales/",
  "fileSystem": "bronze"
}
```

### Update Power BI semantic models

If Power BI reports connect via DirectQuery or Direct Lake:

1. Open the semantic model in Power BI Desktop.
2. Change the data source from the shortcut path to the ADLS Gen2 native path.
3. Publish and verify the report refreshes successfully.

### Decommission the OneLake shortcut

After all consumers are migrated and validated (recommended: 2-week parallel-run minimum):

```bash
# Remove the S3 shortcut from OneLake
curl -X DELETE \
  "https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE_ID}/items/${LAKEHOUSE_ID}/shortcuts/s3_raw_sales" \
  -H "Authorization: Bearer $(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)"
```

```sql
-- Drop the bridge table in Unity Catalog
DROP TABLE IF EXISTS migration_bridge.raw.sales_s3;
```

---

## Troubleshooting

### AzCopy fails with "AuthorizationFailure"

- Verify the SAS token has not expired.
- Ensure `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set in the environment.
- For GovCloud, verify the S3 endpoint URL uses `s3-us-gov-west-1.amazonaws.com`.

### AzCopy transfer is slow

- Check `--cap-mbps` is not set too low.
- For ExpressRoute, verify the circuit is not saturated (check metrics in Azure portal).
- Split large prefixes into parallel AzCopy jobs (see Step 4 parallel example).
- Consider Azure Data Box for datasets over 50 TiB.

### Delta conversion fails with OutOfMemoryError

- Increase the cluster driver and worker memory.
- Process datasets in smaller partitions: `.write.partitionBy("year", "month")`.
- Use Auto Loader for incremental ingestion instead of batch conversion.

### Row count mismatch after migration

- Check for S3 versioning: if enabled, `aws s3 ls --recursive` counts the latest version only, but there may be delete markers.
- Check for files that arrived in S3 after the AzCopy snapshot.
- Verify partition filters: Delta tables with `_metadata` columns may add rows.

### OneLake shortcut returns "Forbidden"

- Verify the S3 connection in Fabric has valid AWS credentials.
- Ensure the IAM role used by the connection has `s3:GetObject` and `s3:ListBucket`.
- Check that the S3 bucket policy does not deny cross-account access.

---

## Next steps

- **Convert more buckets:** Repeat this tutorial for each S3 bucket in your migration plan.
- **Set up incremental sync:** For buckets receiving ongoing writes, configure Auto Loader to continuously ingest new files from ADLS Gen2.
- **Migrate Redshift:** See [tutorial-redshift-to-fabric.md](tutorial-redshift-to-fabric.md) for warehouse migration.
- **Migrate Glue ETL:** See [tutorial-glue-to-adf-dbt.md](tutorial-glue-to-adf-dbt.md) for ETL pipeline conversion.
- **Review best practices:** See [best-practices.md](best-practices.md) for migration patterns and common pitfalls.

---

## Related resources

- [AWS-to-Azure migration playbook](../aws-to-azure.md) -- full capability mapping and phased plan
- [Benchmarks](benchmarks.md) -- performance and cost comparisons
- `csa_platform/unity_catalog_pattern/onelake_config.yaml` -- OneLake shortcut configuration
- `docs/adr/0003-delta-lake-over-iceberg-and-parquet.md` -- why Delta Lake is the primary format
- `docs/COST_MANAGEMENT.md` -- storage cost optimization

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
