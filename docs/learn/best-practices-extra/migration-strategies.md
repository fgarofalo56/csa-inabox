---
title: "Migration Strategies"
description: "> **[Home](../index.md)** | **[Best Practices](index.md)** | **Migration Strategies**"
tags:
  - best-practices
---
# Migration Strategies

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


> **[Home](../index.md)** | **[Best Practices](index.md)** | **Migration Strategies**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

Best practices for migrating to Cloud Scale Analytics.

---

## Migration Approaches

| Approach | Use Case | Risk | Duration |
|----------|----------|------|----------|
| Lift & Shift | Quick migration, minimal changes | Low | Short |
| Re-platform | Optimize for cloud services | Medium | Medium |
| Re-architect | Full modernization | High | Long |

---

## Migration Phases

```mermaid
flowchart LR
    A[Assess] --> B[Plan]
    B --> C[Migrate]
    C --> D[Optimize]
    D --> E[Operate]
```

### Phase 1: Assessment

```python
# Database assessment script
def assess_database(connection_string):
    """Assess database for migration readiness."""

    assessment = {
        "size_gb": get_database_size(connection_string),
        "table_count": get_table_count(connection_string),
        "complexity_score": analyze_stored_procedures(connection_string),
        "compatibility_issues": check_compatibility(connection_string)
    }

    # Recommend target
    if assessment["size_gb"] < 100 and assessment["complexity_score"] < 50:
        assessment["recommendation"] = "Serverless SQL"
    elif assessment["size_gb"] < 1000:
        assessment["recommendation"] = "Dedicated SQL Pool (DW1000c)"
    else:
        assessment["recommendation"] = "Dedicated SQL Pool (DW3000c+)"

    return assessment
```

### Phase 2: Planning

**Migration Checklist:**

- [ ] Inventory all data sources
- [ ] Map source to target schemas
- [ ] Identify dependencies
- [ ] Plan downtime windows
- [ ] Create rollback procedures
- [ ] Define success criteria

### Phase 3: Migration

```bash
# Data Factory migration pipeline
az datafactory pipeline create \
    --factory-name adf-migration \
    --resource-group rg-analytics \
    --name migrate-sales-data \
    --definition '{
        "activities": [
            {
                "name": "CopyFromOnPrem",
                "type": "Copy",
                "inputs": [{"referenceName": "OnPremSQL", "type": "DatasetReference"}],
                "outputs": [{"referenceName": "DataLake", "type": "DatasetReference"}],
                "typeProperties": {
                    "source": {"type": "SqlSource"},
                    "sink": {"type": "ParquetSink"},
                    "enableStaging": true
                }
            }
        ]
    }'
```

### Phase 4: Validation

```sql
-- Data validation query
WITH SourceCounts AS (
    SELECT
        'Source' AS System,
        COUNT(*) AS RowCount,
        SUM(Amount) AS TotalAmount
    FROM SourceDatabase.dbo.Sales
),
TargetCounts AS (
    SELECT
        'Target' AS System,
        COUNT(*) AS RowCount,
        SUM(Amount) AS TotalAmount
    FROM OPENROWSET(
        BULK 'https://datalake.dfs.core.windows.net/sales/*.parquet',
        FORMAT = 'PARQUET'
    ) AS sales
)
SELECT * FROM SourceCounts
UNION ALL
SELECT * FROM TargetCounts;
```

---

## Common Migration Patterns

### On-Premises SQL Server to Synapse

1. Export to Parquet using ADF
2. Load to Data Lake bronze layer
3. Transform to silver/gold layers
4. Create views in Serverless SQL
5. Migrate heavy queries to Dedicated SQL

### Hadoop to Databricks

1. Migrate HDFS data to ADLS Gen2
2. Convert Hive metastore to Unity Catalog
3. Refactor Spark jobs for Databricks
4. Implement Delta Lake format

---

## Related Documentation

- [Data Factory Tutorials](../tutorials/data-factory/README.md)
- [Synapse Setup](../tutorials/synapse/01-environment-setup.md)

---

*Last Updated: January 2025*
