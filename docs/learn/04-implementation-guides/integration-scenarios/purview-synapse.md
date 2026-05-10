# Purview and Synapse Integration

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __Purview + Synapse__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Implement unified data governance with Azure Purview and Synapse Analytics.

---

## Overview

Purview + Synapse integration enables:

- Automated data discovery and cataloging
- End-to-end data lineage tracking
- Unified access policies
- Sensitive data classification

---

## Implementation

### Step 1: Connect Synapse to Purview

```bash
# Register Synapse workspace in Purview
az purview account add-root-collection-admin \
    --account-name purview-account \
    --object-id <synapse-managed-identity-id>

# Enable Purview integration in Synapse
az synapse workspace update \
    --name synapse-workspace \
    --resource-group rg-analytics \
    --purview-configuration purviewAccountName=purview-account
```

### Step 2: Configure Synapse Lineage

```sql
-- Synapse Pipelines automatically capture lineage
-- No additional configuration needed for:
-- - Copy activities
-- - Data flows
-- - Spark notebooks (with lineage enabled)

-- Enable lineage for Spark pools
ALTER DATABASE synapse_db SET ENABLE_LINEAGE_CAPTURE = ON;
```

### Step 3: Scan Synapse Assets

```python
from azure.purview.scanning import PurviewScanningClient
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
client = PurviewScanningClient(
    endpoint="https://purview-account.purview.azure.com",
    credential=credential
)

# Create data source for Synapse
data_source = {
    "kind": "AzureSynapseWorkspace",
    "properties": {
        "endpoint": "https://synapse-workspace.dev.azuresynapse.net",
        "resourceGroup": "rg-analytics",
        "subscriptionId": subscription_id,
        "location": "eastus"
    }
}

client.data_sources.create_or_update("synapse-source", data_source)

# Create scan
scan = {
    "kind": "AzureSynapseWorkspaceMsi",
    "properties": {
        "scanRulesetName": "AzureSynapseSQL",
        "scanRulesetType": "System"
    }
}

client.scans.create_or_update("synapse-source", "weekly-scan", scan)

# Run scan
client.scan_result.run_scan("synapse-source", "weekly-scan", str(uuid.uuid4()))
```

### Step 4: Apply Classifications

```python
from azure.purview.catalog import PurviewCatalogClient

catalog_client = PurviewCatalogClient(
    endpoint="https://purview-account.purview.azure.com",
    credential=credential
)

# Search for assets containing PII
search_request = {
    "keywords": "*",
    "filter": {
        "and": [
            {"classification": "MICROSOFT.PERSONAL.EMAIL"},
            {"assetType": "azure_synapse_sql_table"}
        ]
    }
}

results = catalog_client.discovery.query(search_request)

# Apply custom classification
for asset in results["value"]:
    update_request = {
        "classifications": [
            {"typeName": "CUSTOM.SENSITIVE_CUSTOMER_DATA"}
        ]
    }
    catalog_client.entity.add_classifications(asset["id"], update_request)
```

### Step 5: Implement Access Policies

```python
# Define access policy for sensitive data
policy = {
    "name": "restrict-pii-access",
    "description": "Restrict access to PII data",
    "decisionRules": [
        {
            "effect": "Deny",
            "dnfCondition": [
                [
                    {
                        "attributeName": "resource.classification",
                        "attributeValueIncludedIn": ["MICROSOFT.PERSONAL.*"]
                    },
                    {
                        "attributeName": "principal.group",
                        "attributeValueExcludeFrom": ["pii-authorized-users"]
                    }
                ]
            ]
        }
    ]
}

# Apply to Synapse
client.metadata_policy.update(
    collection_name="synapse-source",
    policy=policy
)
```

### Step 6: Query Lineage

```python
# Get lineage for a specific table
lineage = catalog_client.lineage.get_lineage_by_unique_attribute(
    "azure_synapse_dedicated_sql_table",
    qualifiedName="mssql://synapse-workspace.sql.azuresynapse.net/dbo/fact_sales",
    direction="BOTH",
    depth=3
)

# Extract upstream and downstream assets
def extract_lineage_graph(lineage_response):
    nodes = []
    edges = []

    for guid, entity in lineage_response["guidEntityMap"].items():
        nodes.append({
            "id": guid,
            "name": entity["attributes"]["name"],
            "type": entity["typeName"]
        })

    for relation in lineage_response.get("relations", []):
        edges.append({
            "from": relation["fromEntityId"],
            "to": relation["toEntityId"],
            "type": relation["relationshipType"]
        })

    return {"nodes": nodes, "edges": edges}

graph = extract_lineage_graph(lineage)
```

### Step 7: Synapse Studio Integration

```sql
-- View Purview assets from Synapse Studio
-- (Requires Purview integration enabled)

-- Search catalog from Synapse
EXEC sp_search_catalog @search_term = 'customer', @limit = 10;

-- View classifications
SELECT
    table_name,
    column_name,
    classification
FROM PURVIEW.dbo.vw_column_classifications
WHERE classification LIKE '%PERSONAL%';

-- Check data lineage
SELECT * FROM PURVIEW.dbo.vw_table_lineage
WHERE qualified_name = 'mssql://synapse.sql.azuresynapse.net/dbo/fact_sales';
```

---

## Governance Dashboard

```sql
-- Create governance metrics view
CREATE VIEW governance.data_catalog_metrics AS
SELECT
    asset_type,
    COUNT(*) AS asset_count,
    SUM(CASE WHEN is_classified THEN 1 ELSE 0 END) AS classified_count,
    SUM(CASE WHEN has_owner THEN 1 ELSE 0 END) AS owned_count,
    SUM(CASE WHEN has_description THEN 1 ELSE 0 END) AS documented_count
FROM purview_assets_summary
GROUP BY asset_type;
```

---

## Related Documentation

- [Synapse + Databricks](synapse-databricks.md)
- [Data Governance Best Practices](../../05-best-practices/cross-cutting-concerns/governance/data-governance.md)
- [Azure Purview Lineage](../../02-services/data-governance/azure-purview/lineage.md)

---

*Last Updated: January 2025*
