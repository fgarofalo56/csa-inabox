# Storage Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **Storage**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Azure%20Storage-blue?style=flat-square)

Best practices for Azure Data Lake Storage Gen2.

---

## Overview

This guide covers:

- Storage account configuration
- Data organization
- Access patterns
- Performance optimization
- Security

---

## Storage Configuration

### Recommended Settings

```bash
# Create optimized ADLS Gen2 account
az storage account create \
    --name stdatalake \
    --resource-group rg-data \
    --location eastus \
    --sku Standard_LRS \
    --kind StorageV2 \
    --enable-hierarchical-namespace true \
    --enable-large-file-share \
    --min-tls-version TLS1_2 \
    --allow-blob-public-access false
```

### Access Tiers

| Tier | Use Case | Access Cost |
|------|----------|-------------|
| Hot | Frequently accessed | Low |
| Cool | Infrequent (30+ days) | Medium |
| Archive | Rare (180+ days) | High |

---

## Data Organization

### Directory Structure

```
container/
├── bronze/          # Raw data
│   ├── source1/
│   │   └── year=2024/month=01/day=15/
│   └── source2/
├── silver/          # Cleansed data
│   └── domain/
│       └── entity/
└── gold/            # Aggregated data
    └── analytics/
```

### Naming Conventions

- Use lowercase for container and directory names
- Use hyphens for readability (`sales-data` not `salesdata`)
- Include date partitions in path
- Avoid special characters

---

## Performance Optimization

### File Sizes

| Scenario | Optimal Size | Notes |
|----------|--------------|-------|
| Parquet reads | 128MB - 1GB | Match HDFS block size |
| Delta Lake | 128MB - 1GB | Use auto-optimize |
| Small files | Compact to 100MB+ | Avoid many small files |

### Partitioning

```python
# Good: Date-based partitions
df.write \
    .partitionBy("year", "month") \
    .parquet("/bronze/events/")

# Avoid: High-cardinality partitions
# df.partitionBy("user_id")  # Too many partitions
```

---

## Security

### Access Control

```bash
# Use RBAC (recommended)
az role assignment create \
    --assignee user@company.com \
    --role "Storage Blob Data Contributor" \
    --scope "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}"

# ACLs for fine-grained control
az storage fs access set \
    --acl "user::rwx,group::r-x,other::---" \
    --path bronze/sensitive \
    --file-system data \
    --account-name stdatalake
```

### Encryption

- Enable encryption at rest (default)
- Use customer-managed keys for sensitive data
- Enable infrastructure encryption for double encryption

---

## Lifecycle Management

### Policy Configuration

```json
{
    "rules": [
        {
            "name": "move-to-cool",
            "type": "Lifecycle",
            "definition": {
                "filters": {
                    "blobTypes": ["blockBlob"],
                    "prefixMatch": ["bronze/"]
                },
                "actions": {
                    "baseBlob": {
                        "tierToCool": {"daysAfterModificationGreaterThan": 30},
                        "tierToArchive": {"daysAfterModificationGreaterThan": 180},
                        "delete": {"daysAfterModificationGreaterThan": 365}
                    }
                }
            }
        }
    ]
}
```

---

## Monitoring

### Key Metrics

| Metric | Target | Alert |
|--------|--------|-------|
| Availability | > 99.9% | < 99% |
| E2E Latency | < 100ms | > 500ms |
| Transactions | Monitor baseline | Spikes |
| Throttling | 0 | > 0 |

---

## Related Documentation

- [Storage Monitoring](../../../09-monitoring/service-monitoring/storage/README.md)
- [Data Governance](../../data-governance/README.md)
- [Security Best Practices](../../security/README.md)

---

*Last Updated: January 2025*
