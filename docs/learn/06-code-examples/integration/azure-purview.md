# Microsoft Purview Integration with Azure Synapse Analytics

[Home](../../../README.md) > [Code Examples](../../README.md) > Integration > Purview Integration

This guide provides examples and best practices for integrating Azure Synapse Analytics with Microsoft Purview (formerly Azure Purview) for comprehensive data governance and cataloging.

## Prerequisites

- Azure Synapse Analytics workspace
- Microsoft Purview account
- Appropriate permissions on both services
- Azure Key Vault for secret management

## Setting Up Microsoft Purview Integration with Synapse

### 1. Register Synapse as a Data Source in Purview

```python
# Python code using Purview SDK to register Synapse as a data source
from azure.identity import DefaultAzureCredential
from purviewclient import PurviewClient

# Set up authentication and connect to Purview
credential = DefaultAzureCredential()
purview_account_name = "your-purview-account"
purview_client = PurviewClient(
    account_name=purview_account_name,
    credential=credential
)

# Register Synapse workspace as a data source
synapse_source = {
    "name": "synapse-workspace",
    "kind": "Azure Synapse Analytics",
    "properties": {
        "endpoint": "https://your-synapse-workspace.dev.azuresynapse.net",
        "subscriptionId": "your-subscription-id",
        "resourceGroup": "your-resource-group",
        "resourceName": "your-synapse-workspace",
        "collection": {
            "referenceName": "your-collection",
            "type": "CollectionReference"
        }
    }
}

purview_client.sources.create_or_update(synapse_source)
```

## Automated Metadata Scanning

Configure scheduled scans of your Synapse workspace:

```python
# Create scan configuration for Synapse workspace
scan_config = {
    "name": "synapse-scan",
    "kind": "AzureSynapseWorkspaceScan",
    "properties": {
        "scanRulesetName": "System_Default",
        "collection": {
            "referenceName": "your-collection",
            "type": "CollectionReference"
        },
        "scanningRule": {
            "customProperties": {
                "scanLevelType": "Full"
            }
        },
        "recurrence": {
            "recurrenceInterval": 1,  # days
            "startTime": "2025-08-05T06:00:00Z"
        }
    }
}

# Create the scan
purview_client.scans.create_or_update(
    data_source_name="synapse-workspace",
    scan_name="synapse-scan",
    scan=scan_config
)

# Trigger scan manually
purview_client.scans.run(
    data_source_name="synapse-workspace",
    scan_name="synapse-scan"
)
```

## Retrieving and Using Lineage Information

```python
# Get lineage information for a Synapse asset
from purviewclient.models import LineageRequest

# Define asset ID - can be obtained from the Purview catalog
asset_id = "your-asset-guid"

# Get lineage with depth of 3 hops
lineage_request = LineageRequest(
    direction="BOTH",
    depth=3,
    width=50
)

lineage = purview_client.lineage.get_lineage(asset_id, lineage_request)
print(f"Found {len(lineage.relations)} lineage relationships")

# Process lineage data
for relation in lineage.relations:
    print(f"From: {relation.fromEntityId}, To: {relation.toEntityId}, Type: {relation.relationshipType}")
```

## Setting Up Automated Classification and Sensitive Data Detection

```python
# Create a classification rule
classification_rule = {
    "name": "pii-classifier",
    "kind": "System",
    "properties": {
        "description": "Classify PII data in Synapse tables",
        "classificationRuleBlob": {
            "name": "PII Classifier",
            "version": 1,
            "type": "Text Pattern",
            "pattern": {
                "kind": "Regex",
                "pattern": "(\\b\\d{3}[-.]?\\d{2}[-.]?\\d{4}\\b)",  # US SSN pattern
                "modifiers": []
            },
            "minimumDistinctMatchCount": 1,
            "minimumMatchPercentage": 60,
            "returnEntityLevel": True,
            "thresholds": [],
            "dataMaskingConfig": {
                "maskingFormat": "Special Character",
                "maskingCharacter": "*"
            },
            "classifications": [
                {
                    "name": "US Social Security Number",
                    "category": "Personal",
                    "binding": "strict"
                }
            ]
        }
    }
}

purview_client.classification_rules.create_or_update(
    classification_rule_name="pii-classifier",
    classification_rule=classification_rule
)
```

## Integrating Purview Search in Synapse

To enable users to search and discover data assets from within Synapse Studio:

```javascript
// This would typically be embedded in a custom web application or dashboard
// connected to your Synapse workspace

// Example function to search Purview catalog from custom Synapse dashboard
async function searchPurviewFromSynapse(searchTerm) {
    const endpoint = "https://your-purview-account.purview.azure.com";
    const token = await getAuthToken();  // Obtain authentication token
    
    const response = await fetch(`${endpoint}/catalog/api/search/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            "keywords": searchTerm,
            "limit": 25,
            "filter": {
                "includeSubTypes": true,
                "entityType": "Table"
            }
        })
    });
    
    const results = await response.json();
    return results.value;
}
```

## Synapse Pipeline Integration with Purview

Example of a Synapse pipeline that updates metadata in Purview:

```python
# Python code to create a Synapse pipeline that updates Purview metadata
from azure.synapse.artifacts import ArtifactsClient
from azure.identity import DefaultAzureCredential
import json

# Set up Synapse client
credential = DefaultAzureCredential()
synapse_endpoint = "https://your-synapse-workspace.dev.azuresynapse.net"
client = ArtifactsClient(endpoint=synapse_endpoint, credential=credential)

# Define pipeline with Purview integration
pipeline_name = "update-purview-metadata"
pipeline = {
    "name": pipeline_name,
    "properties": {
        "activities": [
            {
                "name": "Update Purview Metadata",
                "type": "WebActivity",
                "typeProperties": {
                    "url": "https://your-purview-account.purview.azure.com/catalog/api/atlas/v2/entity/",
                    "method": "PUT",
                    "headers": {
                        "Content-Type": "application/json"
                    },
                    "authentication": {
                        "type": "MSI",
                        "resource": "https://purview.azure.net"
                    },
                    "body": {
                        "value": "@json(variables('metadataPayload'))"
                    }
                }
            }
        ],
        "variables": {
            "metadataPayload": {
                "type": "String",
                "defaultValue": json.dumps({
                    "entity": {
                        "typeName": "azure_synapse_table",
                        "attributes": {
                            "qualifiedName": "your-synapse-workspace/database/table",
                            "name": "table",
                            "description": "Updated by Synapse pipeline",
                            "owner": "Data Engineering Team",
                            "updateTime": "@utcnow()"
                        }
                    }
                })
            }
        }
    }
}

# Create the pipeline
client.pipelines.create_or_update(pipeline_name, pipeline)
```

## Best Practices for Synapse and Microsoft Purview Integration

1. __Automated Data Classification__: Configure automated scanning and classification rules to identify and tag sensitive data.

2. __Data Lineage Tracking__: Use Purview's lineage capabilities to track data transformations across your Synapse pipelines.

3. __Glossary Alignment__: Align business glossary terms in Purview with Synapse data assets to improve data understanding.

4. __Access Control Integration__: Implement consistent access control policies across Synapse and Purview.

5. __Automated Metadata Updates__: Update metadata in Purview automatically when data changes in Synapse.

6. __Governance Dashboard__: Create a custom governance dashboard that combines Synapse and Purview insights.

7. __Security Best Practices__:
   - Use managed identities for authentication
   - Implement private endpoints for secure connectivity
   - Apply least privilege access principles
   - Audit all data access through Purview

8. __Search Integration__: Embed Purview's search capabilities within Synapse Studio for seamless data discovery.

## Common Integration Scenarios

### Scenario 1: Data Quality Monitoring with Lineage Tracking

Track data quality metrics from Synapse pipelines in Purview:

```python
# Update data quality metrics in Purview after data processing
quality_metrics = {
    "entity": {
        "typeName": "azure_synapse_table",
        "attributes": {
            "qualifiedName": "your-synapse-workspace/database/table",
            "data_quality": {
                "completeness": 99.5,
                "accuracy": 98.2,
                "validity": 99.8,
                "last_checked": "2025-08-04T12:00:00Z"
            }
        }
    }
}

# Code to update Purview with these metrics using the Atlas API
```

### Scenario 2: Automated Impact Analysis

Before making changes to Synapse assets, perform impact analysis using lineage information from Purview:

```python
# Query Purview for downstream dependencies before modifying a table
downstream_assets = purview_client.lineage.get_lineage(
    asset_id, 
    LineageRequest(direction="OUTPUT", depth=5)
)

# Check if any critical assets would be impacted
critical_assets = [asset for asset in downstream_assets.entities 
                   if "critical" in asset.classifications]
if critical_assets:
    print(f"Warning: Changes will impact {len(critical_assets)} critical assets!")
    # Send notification or create approval workflow
```
