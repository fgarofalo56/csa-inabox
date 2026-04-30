# Storage Migration: S3 to ADLS Gen2 and OneLake

**A deep-dive guide for data engineers migrating Amazon S3 storage to Azure Data Lake Storage Gen2 and Microsoft OneLake.**

---

## Executive summary

S3 is the substrate of the AWS analytics estate. Every other AWS analytics service --- Redshift Spectrum, EMR, Glue, Athena --- reads from and writes to S3. Migrating storage is therefore the most consequential decision in an AWS-to-Azure migration: get it right, and every other service migration becomes simpler.

The key insight is that storage migration does not have to be a big-bang cutover. OneLake S3 shortcuts provide zero-copy, read-only access to S3 buckets from Azure, allowing the compute layer to migrate first while data moves incrementally. This document covers architecture comparison, migration patterns, file format considerations, data transfer strategies, access control mapping, and worked examples.

---

## Architecture comparison

### S3 data model

```
AWS Account
  └── S3 Bucket (globally unique name)
        ├── Prefix (virtual directory)
        │     ├── Object (file)
        │     └── Object
        └── Prefix
              └── Object
```

- **Flat namespace.** S3 uses key-value pairs; directories are simulated via prefix delimiters.
- **Bucket policies + IAM.** Access control combines bucket policies, IAM policies, and S3 Access Points.
- **Storage classes.** Standard, Intelligent-Tiering, Standard-IA, One Zone-IA, Glacier Instant Retrieval, Glacier Flexible Retrieval, Glacier Deep Archive.
- **Event notifications.** S3 emits events to SQS, SNS, Lambda, or EventBridge.

### ADLS Gen2 data model

```
Azure Subscription
  └── Storage Account (globally unique name)
        └── Container (equivalent to bucket)
              ├── Directory (true hierarchical namespace)
              │     ├── File
              │     └── File
              └── Directory
                    └── File
```

- **Hierarchical namespace (HNS).** ADLS Gen2 provides true directory operations (rename, delete directory) with atomic guarantees. This is a fundamental improvement over S3's flat namespace for analytics workloads.
- **RBAC + ACLs.** Azure RBAC at the container/account level; POSIX-like ACLs at the directory/file level.
- **Access tiers.** Hot, Cool, Cold, Archive (per-blob or per-account default).
- **Event Grid.** ADLS Gen2 emits BlobCreated/BlobDeleted events to Event Grid.

### OneLake data model

```
Fabric Tenant
  └── Workspace
        └── Lakehouse
              ├── Tables (managed Delta tables)
              └── Files (unmanaged files)
                    └── Shortcut → S3 bucket (zero-copy)
```

- **OneLake shortcuts.** Provide a virtual mount point to external storage (S3, ADLS Gen2, GCS) without data movement.
- **Unified namespace.** All Fabric artifacts (lakehouses, warehouses, semantic models) share a single OneLake storage layer.

### Key architectural differences

| Dimension           | S3                                      | ADLS Gen2                                 | OneLake                       |
| ------------------- | --------------------------------------- | ----------------------------------------- | ----------------------------- |
| Namespace           | Flat (prefix-based)                     | Hierarchical (HNS)                        | Hierarchical (Fabric-managed) |
| Directory rename    | O(n) --- copies all objects             | O(1) --- atomic                           | O(1) --- managed              |
| Access control      | Bucket policies + IAM + ACLs            | RBAC + POSIX ACLs                         | Fabric workspace permissions  |
| Storage tiers       | 7 classes                               | 4 tiers (hot/cool/cold/archive)           | Hot (managed by Fabric)       |
| Encryption          | SSE-S3, SSE-KMS, SSE-C                  | Microsoft-managed or CMK via Key Vault    | Fabric-managed encryption     |
| Versioning          | Object-level versioning                 | Blob-level versioning + Delta time travel | Delta time travel             |
| Event system        | S3 Events to SQS/SNS/Lambda/EventBridge | Event Grid                                | Fabric Data Activator         |
| Maximum object size | 5 TB                                    | ~190 TB (block blob)                      | Fabric-managed                |
| API                 | S3 REST API                             | Azure Blob REST API + ADLS Gen2 DFS API   | OneLake REST API              |

---

## Migration patterns

### Pattern 1: OneLake S3 shortcuts (zero-copy bridge)

**When to use:** Immediate compute migration; S3 stays source-of-truth during transition.

```
S3 Bucket ──[shortcut]──> OneLake Lakehouse ──> Databricks SQL / Fabric
```

**How it works:**

1. Create a OneLake shortcut pointing to the S3 bucket or prefix.
2. Databricks and Fabric read S3 data through the shortcut with no data copy.
3. New writes land on ADLS Gen2 from day one.
4. Over time, flip individual datasets from S3-backed to ADLS-native.

**Advantages:**

- Zero data movement on day one
- Compute migration can proceed immediately
- Fallback: remove shortcuts and return to pure AWS
- No cross-cloud egress for reads (shortcut reads are server-side)

**Limitations:**

- Read-only from the Azure side (cannot write back to S3 via shortcut)
- Latency depends on cross-cloud network path
- S3 access credentials must be managed in Fabric

**Configuration example:**

```json
{
    "shortcutType": "AmazonS3",
    "path": "Tables/raw_sales",
    "target": {
        "connectionId": "connection-guid",
        "location": "s3://acme-analytics-raw/sales/",
        "subpath": ""
    }
}
```

Cross-reference: `csa_platform/unity_catalog_pattern/onelake_config.yaml`

### Pattern 2: AzCopy bulk transfer

**When to use:** Full data migration for hot/warm data; datasets under 100 TB.

```bash
# Install AzCopy (pre-installed on Azure Cloud Shell)
# Authenticate to both S3 and ADLS Gen2

# Copy from S3 to ADLS Gen2
azcopy copy \
  "https://s3.amazonaws.com/acme-analytics-raw/" \
  "https://acmeanalyticsgov.dfs.core.usgovcloudapi.net/raw/" \
  --recursive \
  --s2s-preserve-access-tier=false \
  --include-pattern "*.parquet;*.json;*.csv" \
  --log-level INFO

# Verify with checksum
azcopy copy \
  "https://s3.amazonaws.com/acme-analytics-raw/" \
  "https://acmeanalyticsgov.dfs.core.usgovcloudapi.net/raw/" \
  --recursive \
  --s2s-preserve-access-tier=false \
  --check-md5 FailIfDifferent \
  --dry-run
```

**Performance tuning:**

- AzCopy automatically parallelizes across multiple connections.
- Set `AZCOPY_CONCURRENCY_VALUE` to increase parallelism (default: 300).
- Use `--block-size-mb` to optimize for large files (default: 8MB; use 100MB for Parquet).
- Expect 5-10 Gbps throughput over ExpressRoute; 1-2 Gbps over VPN.

### Pattern 3: ADF Copy Activity

**When to use:** Ongoing incremental sync; orchestrated migration with monitoring.

```json
{
    "name": "CopyS3ToADLS",
    "type": "Copy",
    "inputs": [
        {
            "referenceName": "S3RawDataset",
            "type": "DatasetReference"
        }
    ],
    "outputs": [
        {
            "referenceName": "ADLSRawDataset",
            "type": "DatasetReference"
        }
    ],
    "typeProperties": {
        "source": {
            "type": "ParquetSource",
            "storeSettings": {
                "type": "AmazonS3ReadSettings",
                "recursive": true,
                "wildcardFolderPath": "sales/*",
                "wildcardFileName": "*.parquet",
                "modifiedDatetimeStart": {
                    "value": "@pipeline().parameters.watermark",
                    "type": "Expression"
                }
            }
        },
        "sink": {
            "type": "ParquetSink",
            "storeSettings": {
                "type": "AzureBlobFSWriteSettings"
            }
        },
        "enableStaging": false,
        "parallelCopies": 32
    }
}
```

**ADF linked service for S3:**

```json
{
    "name": "AmazonS3LinkedService",
    "type": "AmazonS3",
    "typeProperties": {
        "accessKeyId": {
            "type": "AzureKeyVaultSecret",
            "store": {
                "referenceName": "KeyVaultLinkedService",
                "type": "LinkedServiceReference"
            },
            "secretName": "aws-access-key-id"
        },
        "secretAccessKey": {
            "type": "AzureKeyVaultSecret",
            "store": {
                "referenceName": "KeyVaultLinkedService",
                "type": "LinkedServiceReference"
            },
            "secretName": "aws-secret-access-key"
        },
        "serviceUrl": "https://s3.us-gov-west-1.amazonaws.com"
    }
}
```

### Pattern 4: Azure Data Box (offline transfer)

**When to use:** Large cold/archive datasets (50 TB+) where network transfer is impractical.

1. Order Azure Data Box (80 TB usable) or Data Box Heavy (770 TB usable) from Azure portal.
2. Copy S3 data to local staging via `aws s3 sync`.
3. Load data onto Data Box via NFS/SMB mount or AzCopy.
4. Ship Data Box to Azure datacenter.
5. Data appears in target ADLS Gen2 storage account.
6. Verify with checksums.

**Timeline:** 7-10 business days from order to data availability.
**Cost:** ~$0.01/GB (Data Box) or ~$0.003/GB (Data Box Heavy at scale).

---

## File format considerations

### Current state on AWS

| Format       | Typical usage                           | Azure handling                                                |
| ------------ | --------------------------------------- | ------------------------------------------------------------- |
| **Parquet**  | Most S3 data lakes; Athena/Glue default | Read natively; convert to Delta for ACID                      |
| **ORC**      | EMR Hive workloads                      | Read natively in Databricks; convert to Delta                 |
| **CSV/JSON** | Raw ingestion layers                    | Ingest via Auto Loader with schema inference                  |
| **Avro**     | Streaming / schema evolution            | Read natively; convert to Delta                               |
| **Hudi**     | CDC / upsert workloads on EMR           | Read in Databricks; migrate to Delta for writes               |
| **Iceberg**  | Modern Glue / Athena v3                 | Read natively in Databricks (ADR-0003); Delta is write target |

### Delta Lake conversion

For tables that will be actively queried and written to on Azure, convert to Delta Lake format:

```sql
-- In Databricks SQL: convert Parquet directory to Delta
CONVERT TO DELTA parquet.`abfss://raw@acmeanalyticsgov.dfs.core.usgovcloudapi.net/sales/`
  PARTITIONED BY (date STRING);

-- Verify
DESCRIBE HISTORY sales_prod.bronze.raw_sales;
```

```python
# In Databricks notebook: read Parquet from S3, write Delta to ADLS
df = spark.read.parquet("s3a://acme-analytics-raw/sales/")

df.write \
  .format("delta") \
  .mode("overwrite") \
  .partitionBy("date") \
  .option("overwriteSchema", "true") \
  .save("abfss://raw@acmeanalyticsgov.dfs.core.usgovcloudapi.net/sales/")
```

**Z-Order optimization after conversion:**

```sql
OPTIMIZE sales_prod.bronze.raw_sales
  ZORDER BY (region, product_id);
```

---

## S3 bucket policy to ADLS ACL mapping

### S3 bucket policy example

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowAnalyticsTeamRead",
            "Effect": "Allow",
            "Principal": {
                "AWS": "arn:aws:iam::123456789012:role/analytics-team-role"
            },
            "Action": ["s3:GetObject", "s3:ListBucket"],
            "Resource": [
                "arn:aws:s3:::acme-analytics-curated",
                "arn:aws:s3:::acme-analytics-curated/*"
            ]
        }
    ]
}
```

### Equivalent ADLS Gen2 RBAC + ACL

```bash
# RBAC: assign Storage Blob Data Reader at container level
az role assignment create \
  --role "Storage Blob Data Reader" \
  --assignee-object-id <entra-group-object-id> \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/acmeanalyticsgov/blobServices/default/containers/curated"

# ACL: grant read + execute at directory level (if finer granularity needed)
az storage fs access set \
  --acl "group:<entra-group-object-id>:r-x" \
  --path "sales/" \
  --file-system curated \
  --account-name acmeanalyticsgov \
  --auth-mode login
```

### Common IAM-to-RBAC translations

| S3/IAM action        | Azure RBAC role                          | Scope                  |
| -------------------- | ---------------------------------------- | ---------------------- |
| `s3:GetObject`       | Storage Blob Data Reader                 | Container or directory |
| `s3:PutObject`       | Storage Blob Data Contributor            | Container or directory |
| `s3:DeleteObject`    | Storage Blob Data Contributor            | Container or directory |
| `s3:ListBucket`      | Storage Blob Data Reader                 | Container              |
| `s3:GetBucketPolicy` | Reader (ARM)                             | Storage account        |
| `s3:PutBucketPolicy` | Storage Account Contributor              | Storage account        |
| KMS `kms:Decrypt`    | Key Vault Crypto Service Encryption User | Key Vault              |

---

## Versioning and lifecycle equivalents

### S3 versioning to ADLS versioning

| S3 feature                          | ADLS Gen2 equivalent                           | Notes                             |
| ----------------------------------- | ---------------------------------------------- | --------------------------------- |
| Object versioning                   | Blob versioning                                | Enable at storage account level   |
| Version-specific GET                | Version ID-based access                        | Same pattern, different API       |
| Lifecycle rule: delete old versions | Lifecycle management: delete previous versions | 1:1 rule translation              |
| MFA Delete                          | Soft delete + legal hold                       | Different mechanism, same outcome |

**Recommended approach:** Use Delta Lake time travel instead of blob-level versioning for analytics tables. Time travel provides table-level version history with SQL syntax:

```sql
-- Query data as of a specific version
SELECT * FROM sales_prod.gold.fact_sales VERSION AS OF 42;

-- Query data as of a timestamp
SELECT * FROM sales_prod.gold.fact_sales TIMESTAMP AS OF '2026-04-15';

-- Restore a previous version
RESTORE TABLE sales_prod.gold.fact_sales TO VERSION AS OF 42;
```

### S3 lifecycle to ADLS lifecycle

```json
{
    "rules": [
        {
            "enabled": true,
            "name": "tier-to-cool-90d",
            "type": "Lifecycle",
            "definition": {
                "actions": {
                    "baseBlob": {
                        "tierToCool": {
                            "daysAfterModificationGreaterThan": 90
                        },
                        "tierToArchive": {
                            "daysAfterModificationGreaterThan": 365
                        },
                        "delete": { "daysAfterModificationGreaterThan": 2555 }
                    }
                },
                "filters": {
                    "blobTypes": ["blockBlob"],
                    "prefixMatch": ["raw/", "bronze/"]
                }
            }
        }
    ]
}
```

---

## Data transfer strategies

### Decision matrix

| Data volume  | Latency tolerance | Pattern                            | Estimated time |
| ------------ | ----------------- | ---------------------------------- | -------------- |
| < 1 TB       | Hours             | AzCopy over internet               | 1-4 hours      |
| 1-10 TB      | Hours             | AzCopy over VPN/ExpressRoute       | 4-24 hours     |
| 10-50 TB     | Days              | ADF Copy Activity (parallel)       | 1-5 days       |
| 50-100 TB    | Days              | AzCopy over ExpressRoute (10 Gbps) | 2-5 days       |
| 100+ TB      | Weeks             | Azure Data Box + parallel AzCopy   | 2-4 weeks      |
| Ongoing sync | Real-time         | OneLake shortcuts (zero-copy)      | Immediate      |

### Network considerations for federal

- **ExpressRoute (recommended):** Dedicated private connectivity between AWS Direct Connect peering and Azure ExpressRoute. Provides consistent bandwidth (1-10 Gbps) and does not traverse the public internet.
- **Site-to-site VPN:** Encrypted tunnel over the internet. Lower bandwidth (1.25 Gbps per tunnel) but simpler to set up.
- **Internet transfer:** Viable for small datasets; use HTTPS with AzCopy's built-in encryption.
- **Data Box:** Physical transfer; avoids network entirely. Required for air-gapped environments.

### Cross-cloud egress cost management

S3 data transfer out to the internet costs $0.09/GB for the first 10 TB. For a 100 TB migration, the egress cost alone is approximately $8,500. Strategies to minimize:

1. **Use OneLake shortcuts** during the bridge phase to avoid copying data until necessary.
2. **Compress before transfer.** Parquet is already compressed, but raw CSV/JSON should be gzipped.
3. **Transfer during off-peak.** AWS provides no off-peak pricing, but your network links may have less contention.
4. **Budget egress separately.** Include $50K-$200K for cross-cloud transfer in the migration budget (see [TCO Analysis](tco-analysis.md)).

---

## Medallion architecture mapping

| AWS layer           | S3 prefix convention             | Azure layer  | ADLS container                     | OneLake equivalent          |
| ------------------- | -------------------------------- | ------------ | ---------------------------------- | --------------------------- |
| Raw / Landing       | `s3://bucket/raw/`               | Bronze       | `raw` / `bronze` container         | Lakehouse `Files/raw/`      |
| Cleaned / Staging   | `s3://bucket/stage/`             | Silver       | `silver` container                 | Lakehouse `Tables/silver_*` |
| Curated / Analytics | `s3://bucket/curated/`           | Gold         | `gold` container                   | Lakehouse `Tables/gold_*`   |
| Archive             | `s3://bucket/archive/` (Glacier) | Archive tier | `archive` container (archive tier) | N/A --- use ADLS lifecycle  |

Cross-reference: `examples/commerce/`, `examples/noaa/` for worked medallion implementations.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Compute Migration](compute-migration.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../aws-to-azure.md)
