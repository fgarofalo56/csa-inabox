# Azure Storage Reference

[Home](../../../README.md) > [Reference](../README.md) > Storage

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Documentation](https://img.shields.io/badge/Documentation-Complete-blue)

> Reference documentation for Azure Storage configuration, geo-replication, custom domains, and integration with cloud-scale analytics workloads.

---

## Available References

### Storage Features

- **[Custom Domains](custom-domains.md)** - Configure custom domains for Azure Storage with CDN integration, HTTPS support, and DNS configuration.
- **[Geo-Replication](geo-replication.md)** - Azure Storage geo-replication options, failover strategies, and disaster recovery best practices.

---

## Overview

Azure Storage provides highly available, scalable, and secure cloud storage for modern data analytics workloads.

### Storage Services for Analytics

| Service | Purpose | Use Case |
|---------|---------|----------|
| **Blob Storage** | Object storage | Data lakes, backups, media files |
| **Azure Data Lake Gen2** | Hierarchical namespace | Big data analytics, Synapse workloads |
| **File Storage** | SMB file shares | Shared configuration, lift-and-shift |
| **Table Storage** | NoSQL key-value | Metadata, lookup tables |
| **Queue Storage** | Message queuing | Workflow orchestration |

---

## Azure Data Lake Storage Gen2

### Key Features

Azure Data Lake Storage Gen2 is the recommended storage for analytics workloads, combining the scalability of Blob Storage with a hierarchical file system.

#### Advantages

| Feature | Description |
|---------|-------------|
| **Hierarchical Namespace** | File and directory organization |
| **POSIX ACLs** | Fine-grained access control |
| **Performance** | Optimized for big data analytics |
| **Cost** | Same pricing as Blob Storage |
| **Integration** | Native support in Synapse, Databricks, HDInsight |

#### Configuration

```bash
# Create storage account with Data Lake Gen2
az storage account create \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --location eastus \
  --sku Standard_GRS \
  --kind StorageV2 \
  --hierarchical-namespace true \
  --enable-large-file-share

# Create filesystem (container)
az storage fs create \
  --name data \
  --account-name stadatalake001

# Set ACLs on directory
az storage fs access set \
  --acl "user::rwx,group::r-x,other::---" \
  --path /analytics \
  --account-name stadatalake001 \
  --file-system data
```

---

## Storage Tiers

### Access Tier Comparison

| Tier | Use Case | Storage Cost | Access Cost | Minimum Duration |
|------|----------|--------------|-------------|------------------|
| **Hot** | Frequently accessed data | Highest | Lowest | None |
| **Cool** | Infrequently accessed (30+ days) | Lower | Higher | 30 days |
| **Cold** | Rarely accessed (90+ days) | Lower | Higher | 90 days |
| **Archive** | Long-term archival | Lowest | Highest | 180 days |

### Lifecycle Management

```json
{
  "rules": [
    {
      "name": "MoveToCool",
      "enabled": true,
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["analytics/raw/"]
        },
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": 30
            },
            "tierToArchive": {
              "daysAfterModificationGreaterThan": 90
            },
            "delete": {
              "daysAfterModificationGreaterThan": 365
            }
          }
        }
      }
    }
  ]
}
```

---

## Performance Optimization

### Partition Strategy

```text
Recommended Structure:
/data
  ├── /year=2024
  │   ├── /month=12
  │   │   ├── /day=01
  │   │   │   └── part-00000.parquet
  │   │   ├── /day=02
  │   │   └── /day=03
  │   └── /month=11
  └── /year=2023
```

### Best Practices

- **Partition by date** - Organize data by year/month/day for time-based queries
- **Use appropriate file formats** - Parquet, ORC for analytics workloads
- **Right-size files** - 128MB - 1GB per file for optimal performance
- **Enable versioning** - For data protection and recovery
- **Implement lifecycle policies** - Automatic tier management
- **Use private endpoints** - Secure network access

---

## Security Configuration

### Network Security

```bash
# Configure storage firewall
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --default-action Deny

# Add network rule for VNet
az storage account network-rule add \
  --account-name stadatalake001 \
  --resource-group rg-analytics-prod \
  --vnet-name vnet-analytics \
  --subnet snet-synapse

# Create private endpoint
az network private-endpoint create \
  --name pe-storage-dfs \
  --resource-group rg-analytics-prod \
  --vnet-name vnet-analytics \
  --subnet snet-storage \
  --private-connection-resource-id "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.Storage/storageAccounts/stadatalake001" \
  --connection-name storage-connection \
  --group-id dfs
```

### Encryption

```bash
# Enable customer-managed keys
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --encryption-key-source Microsoft.Keyvault \
  --encryption-key-vault https://kv-analytics-prod.vault.azure.net/ \
  --encryption-key-name storage-key

# Enable infrastructure encryption
az storage account create \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --require-infrastructure-encryption true
```

---

## Integration with Analytics Services

### Azure Synapse Analytics

```sql
-- Create external data source
CREATE EXTERNAL DATA SOURCE DataLakeSource
WITH (
    TYPE = HADOOP,
    LOCATION = 'abfss://data@stadatalake001.dfs.core.windows.net/',
    CREDENTIAL = SynapseIdentity
);

-- Query data
SELECT *
FROM OPENROWSET(
    BULK 'analytics/sales/*.parquet',
    DATA_SOURCE = 'DataLakeSource',
    FORMAT = 'PARQUET'
) AS [sales_data];
```

### Azure Data Factory

```json
{
  "name": "AzureDataLakeGen2",
  "type": "AzureBlobFS",
  "typeProperties": {
    "url": "https://stadatalake001.dfs.core.windows.net",
    "accountKey": {
      "type": "AzureKeyVaultSecret",
      "store": {
        "referenceName": "KeyVaultLinkedService",
        "type": "LinkedServiceReference"
      },
      "secretName": "StorageAccountKey"
    }
  }
}
```

---

## Monitoring and Diagnostics

### Key Metrics

```bash
# Monitor storage metrics
az monitor metrics list \
  --resource "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.Storage/storageAccounts/stadatalake001" \
  --metric "Availability" "Transactions" "TotalRequests" \
  --aggregation Average Total \
  --interval PT1H
```

### Storage Analytics Logging

```bash
# Enable diagnostic settings
az monitor diagnostic-settings create \
  --name storage-diagnostics \
  --resource "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.Storage/storageAccounts/stadatalake001/blobServices/default" \
  --logs '[
    {"category":"StorageRead","enabled":true},
    {"category":"StorageWrite","enabled":true},
    {"category":"StorageDelete","enabled":true}
  ]' \
  --metrics '[{"category":"Transaction","enabled":true}]' \
  --workspace "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.OperationalInsights/workspaces/law-analytics-prod"
```

---

## Quick Links

- [Azure Storage Documentation](https://docs.microsoft.com/azure/storage/)
- [Azure Data Lake Gen2](https://docs.microsoft.com/azure/storage/blobs/data-lake-storage-introduction)
- [Storage Security Guide](https://docs.microsoft.com/azure/storage/common/storage-security-guide)
- [Custom Domains](custom-domains.md)
- [Geo-Replication](geo-replication.md)

---

## Related Resources

- [Best Practices - Performance Optimization](../../best-practices/performance-optimization.md)
- [Network Security](../../best-practices/network-security.md)
- [Security Checklist](../security-checklist/README.md)

---

> **Note**: This reference section focuses on Azure Storage features relevant to cloud-scale analytics workloads. For complete Azure Storage documentation, refer to the official Microsoft documentation.
