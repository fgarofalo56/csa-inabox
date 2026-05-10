# Metadata Governance

> **[Home](../../../../README.md)** | **[Best Practices](../../README.md)** | **[Cross-Cutting](../README.md)** | **Metadata Governance**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Governance-purple?style=flat-square)

Best practices for metadata management and governance in Azure data platforms.

---

## Overview

Metadata governance ensures data assets are discoverable, understandable, and properly managed across your analytics platform.

---

## Metadata Categories

### Technical Metadata

| Category | Examples | Storage |
|----------|----------|---------|
| Schema | Column names, types, constraints | Unity Catalog / Purview |
| Lineage | Source-to-target mappings | Azure Purview |
| Statistics | Row counts, null percentages | Delta Lake |
| Partitions | Partition keys, file counts | Hive Metastore |

### Business Metadata

| Category | Examples | Storage |
|----------|----------|---------|
| Glossary | Business terms, definitions | Azure Purview |
| Classification | PII, Confidential, Public | Azure Purview |
| Ownership | Data steward, technical owner | Azure Purview |
| Quality | Data quality scores | Custom registry |

---

## Azure Purview Integration

### Data Source Registration

```python
from azure.purview.catalog import PurviewCatalogClient
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
client = PurviewCatalogClient(
    endpoint="https://purview-account.purview.azure.com",
    credential=credential
)

# Register ADLS Gen2 source
def register_data_lake():
    entity = {
        "typeName": "azure_datalake_gen2_resource_set",
        "attributes": {
            "name": "sales_bronze_data",
            "qualifiedName": "https://datalake.dfs.core.windows.net/bronze/sales",
            "description": "Raw sales data from operational systems",
            "owner": "data-engineering@company.com"
        },
        "classifications": [
            {"typeName": "MICROSOFT.PERSONAL.DATA"}
        ]
    }
    client.entity.create_or_update(entity={"entity": entity})
```

### Business Glossary

```python
# Create glossary term
def create_glossary_term(name: str, definition: str, domain: str):
    term = {
        "name": name,
        "longDescription": definition,
        "anchor": {"glossaryGuid": get_glossary_guid()},
        "resources": [{"displayName": domain, "url": f"#/{domain}"}],
        "status": "Approved"
    }
    return client.glossary.create_glossary_term(term)

# Example terms
create_glossary_term(
    name="Customer Lifetime Value",
    definition="Total revenue expected from a customer over entire relationship",
    domain="Sales"
)
```

---

## Unity Catalog Integration

### Catalog Structure

```sql
-- Create catalog and schema hierarchy
CREATE CATALOG IF NOT EXISTS enterprise_data;

CREATE SCHEMA IF NOT EXISTS enterprise_data.sales
COMMENT 'Sales domain data assets';

CREATE SCHEMA IF NOT EXISTS enterprise_data.finance
COMMENT 'Finance domain data assets';

-- Register table with metadata
CREATE TABLE enterprise_data.sales.customers (
    customer_id STRING NOT NULL COMMENT 'Unique customer identifier',
    email STRING COMMENT 'Customer email address - PII',
    created_date DATE COMMENT 'Account creation date'
)
COMMENT 'Master customer dimension table'
TBLPROPERTIES (
    'data_classification' = 'confidential',
    'data_owner' = 'sales-team@company.com',
    'retention_days' = '2555'
);

-- Add column tags
ALTER TABLE enterprise_data.sales.customers
ALTER COLUMN email SET TAGS ('pii', 'gdpr_relevant');
```

### Data Lineage

```python
# Track lineage in Unity Catalog
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

# Query lineage
lineage = w.data_lineage.get_lineage(
    table_name="enterprise_data.sales.customer_360"
)

for upstream in lineage.upstream_tables:
    print(f"Source: {upstream.name}")

for downstream in lineage.downstream_tables:
    print(f"Dependent: {downstream.name}")
```

---

## Metadata Registry

### Custom Registry Schema

```sql
-- Metadata registry table
CREATE TABLE governance.metadata_registry (
    table_id STRING NOT NULL,
    catalog STRING NOT NULL,
    schema_name STRING NOT NULL,
    table_name STRING NOT NULL,

    -- Technical metadata
    row_count BIGINT,
    size_bytes BIGINT,
    partition_columns ARRAY<STRING>,
    last_modified TIMESTAMP,

    -- Business metadata
    domain STRING,
    data_owner STRING,
    data_steward STRING,
    classification STRING,
    retention_policy STRING,

    -- Quality metadata
    quality_score DECIMAL(5,2),
    completeness_score DECIMAL(5,2),
    freshness_hours INT,

    -- Audit
    registered_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- Auto-populate from information schema
INSERT INTO governance.metadata_registry
SELECT
    CONCAT(table_catalog, '.', table_schema, '.', table_name) AS table_id,
    table_catalog AS catalog,
    table_schema AS schema_name,
    table_name,
    NULL AS row_count,
    NULL AS size_bytes,
    NULL AS partition_columns,
    NULL AS last_modified,
    NULL AS domain,
    NULL AS data_owner,
    NULL AS data_steward,
    NULL AS classification,
    NULL AS retention_policy,
    NULL AS quality_score,
    NULL AS completeness_score,
    NULL AS freshness_hours,
    current_timestamp() AS registered_at,
    current_timestamp() AS updated_at
FROM system.information_schema.tables
WHERE table_catalog = 'enterprise_data';
```

---

## Automated Metadata Collection

### Statistics Collection

```python
def collect_table_metadata(table_path: str) -> dict:
    """Collect comprehensive table metadata."""
    df = spark.read.format("delta").load(table_path)
    delta_table = DeltaTable.forPath(spark, table_path)

    # Basic statistics
    stats = {
        "row_count": df.count(),
        "column_count": len(df.columns),
        "size_bytes": get_table_size(table_path)
    }

    # Schema info
    stats["columns"] = [
        {
            "name": field.name,
            "type": str(field.dataType),
            "nullable": field.nullable
        }
        for field in df.schema.fields
    ]

    # Delta-specific metadata
    history = delta_table.history(1).collect()[0]
    stats["last_operation"] = history.operation
    stats["last_modified"] = history.timestamp
    stats["version"] = history.version

    return stats
```

### Scheduled Metadata Refresh

```python
# Databricks job for metadata refresh
def refresh_metadata_registry():
    """Daily job to refresh metadata registry."""
    tables = spark.sql("""
        SELECT table_id, catalog, schema_name, table_name
        FROM governance.metadata_registry
    """).collect()

    for table in tables:
        table_path = f"{table.catalog}.{table.schema_name}.{table.table_name}"
        try:
            metadata = collect_table_metadata(table_path)
            update_registry(table.table_id, metadata)
        except Exception as e:
            log_error(f"Failed to refresh {table_path}: {e}")
```

---

## Data Discovery

### Search Interface

```python
def search_data_assets(query: str, filters: dict = None) -> list:
    """Search data assets by keyword and filters."""
    base_query = """
        SELECT
            table_id,
            table_name,
            domain,
            data_owner,
            classification,
            quality_score
        FROM governance.metadata_registry
        WHERE 1=1
    """

    if query:
        base_query += f"""
            AND (
                LOWER(table_name) LIKE '%{query.lower()}%'
                OR LOWER(domain) LIKE '%{query.lower()}%'
            )
        """

    if filters:
        if filters.get("domain"):
            base_query += f" AND domain = '{filters['domain']}'"
        if filters.get("classification"):
            base_query += f" AND classification = '{filters['classification']}'"

    return spark.sql(base_query).collect()
```

---

## Related Documentation

- [Data Governance Overview](../../../../best-practices/data-governance/README.md)
- [Azure Purview Integration](../../../../02-services/governance-services/azure-purview/README.md)
- [Unity Catalog](../../service-specific/databricks/README.md)

---

*Last Updated: January 2025*
