# Data Lake Architecture Video Script

![Status: Draft](https://img.shields.io/badge/Status-Draft-yellow)
![Duration: 18 minutes](https://img.shields.io/badge/Duration-18%20minutes-blue)

## Overview

Comprehensive video script covering Azure Data Lake Storage Gen2 architecture, medallion architecture pattern, and best practices for organizing analytics data.

## Script Content

### Opening (0:00 - 1:00)

**NARRATOR**:
"The data lake is the foundation of modern analytics. In this tutorial, you'll learn how to architect a scalable, secure, and performant data lake using Azure Data Lake Storage Gen2."

### Section 1: Medallion Architecture (1:00 - 7:00)

#### Bronze Layer (Raw)

```
bronze/
├── source_system_1/
│   ├── 2024/
│   │   ├── 01/
│   │   │   ├── 01/
│   │   │   │   └── data.parquet
```

**Characteristics**:
- Exact copy of source data
- No transformations
- Append-only
- Long retention (years)

#### Silver Layer (Cleansed)

```python
# Cleansing transformations
silver_df = bronze_df \
    .dropDuplicates() \
    .na.drop() \
    .withColumn("load_date", current_timestamp())
```

**Characteristics**:
- Cleaned and validated
- Deduplicated
- Standardized formats
- Business rules applied

#### Gold Layer (Curated)

```sql
-- Business-ready aggregations
CREATE OR REPLACE TABLE gold.sales_summary AS
SELECT
    date_key,
    customer_segment,
    SUM(revenue) as total_revenue,
    COUNT(order_id) as order_count
FROM silver.orders
GROUP BY date_key, customer_segment;
```

**Characteristics**:
- Business-level aggregations
- Optimized for consumption
- Denormalized where appropriate
- Power BI ready

### Section 2: File Organization (7:00 - 12:00)

#### Partitioning Strategy

```
/data/sales/
    year=2024/
        month=01/
            day=01/
                part-00000.parquet
                part-00001.parquet
```

**Benefits**:
- Partition pruning
- Improved query performance
- Easier data management
- Cost optimization

#### File Formats

| Format | Use Case | Compression |
|--------|----------|-------------|
| Parquet | Analytics | Snappy |
| Delta | ACID operations | Snappy |
| JSON | Semi-structured | GZip |
| CSV | Legacy/Exchange | None |

### Section 3: Security Architecture (12:00 - 16:00)

#### Access Control Layers

```bash
# Container-level RBAC
az role assignment create \
  --assignee user@company.com \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{storage}/blobServices/default/containers/bronze

# ACLs for fine-grained control
az storage fs access set \
  --account-name mystorage \
  --file-system bronze \
  --path "sensitive/" \
  --permissions "rwx" \
  --entity user@company.com
```

### Conclusion (16:00 - 18:00)

**Architecture Principles**:
1. Implement medallion architecture
2. Partition for performance
3. Use appropriate file formats
4. Secure with least privilege
5. Monitor access patterns

## Related Resources

- [Foundation Architecture](01-foundation.md)
- [Serverless SQL Architecture](03-serverless-sql.md)

---

*Last Updated: January 2025*
