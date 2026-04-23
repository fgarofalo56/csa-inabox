# Metadata Management — CSA-in-a-Box

This guide covers automated scanning, custom scan rule sets, schema extraction,
and business metadata enrichment in Microsoft Purview.

---

## Automated Scanning

### Create a Scan

After registering a data source (see [PURVIEW_SETUP.md](PURVIEW_SETUP.md)),
create a scan definition:

```bash
PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"
TOKEN=$(az account get-access-token --resource "https://purview.azure.net" --query accessToken -o tsv)
SOURCE_NAME="adls-csadlzdevst"

# Create a scan for the ADLS source
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/weekly-full-scan?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureStorageMsi",
    "properties": {
      "scanRulesetName": "csa-adls-ruleset",
      "scanRulesetType": "Custom",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'
```

### Set a Recurring Schedule

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/weekly-full-scan/triggers/default?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "scanLevel": "Full",
      "recurrence": {
        "frequency": "Week",
        "interval": 1,
        "startTime": "2025-01-01T02:00:00Z",
        "timezone": "UTC",
        "schedule": {
          "hours": [2],
          "minutes": [0],
          "weekDays": ["Sunday"]
        }
      }
    }
  }'
```

### Trigger a Scan Manually

```bash
# Run a scan immediately
curl -s -X POST \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/weekly-full-scan/runs?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "scanLevel": "Full" }'

# Check scan run status
curl -s "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/weekly-full-scan/runs?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" | jq '.value[0] | {status, startTime, endTime, assetsDiscovered: .scanResultsCount}'
```

Expected output after a successful scan:

```json
{
  "status": "Succeeded",
  "startTime": "2025-01-12T02:00:15Z",
  "endTime": "2025-01-12T02:45:32Z",
  "assetsDiscovered": 1247
}
```

---

## Custom Scan Rule Sets

Default scan rules handle common formats (CSV, JSON, Parquet). CSA-in-a-Box
extends these with rules for Delta Lake, GeoParquet, and domain-specific patterns.

### Delta Lake Scan Rule Set

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/scanrulesets/csa-delta-ruleset?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureStorage",
    "properties": {
      "description": "Delta Lake format detection with CSA custom classifiers",
      "excludedSystemClassifications": [],
      "includedCustomClassificationRuleNames": [
        "CSA_PII_SSN", "CSA_PII_EMAIL", "CSA_PII_PHONE",
        "CSA_PHI_MRN", "CSA_FIN_ACCOUNT_NUMBER",
        "CSA_GOV_TRIBAL_ENROLLMENT_ID"
      ],
      "scanRulesetType": "Custom",
      "fileExtensions": [".parquet", ".json"],
      "resourceTypes": {
        "AzureStorage": {
          "scanRulesetType": "Custom",
          "customFileExtensions": [
            {
              "customFileType": {
                "builtInType": "PARQUET"
              },
              "description": "Delta Lake transaction log",
              "enabled": true,
              "fileExtension": ".json"
            }
          ]
        }
      }
    }
  }'
```

### GeoParquet Scan Rule Set

GeoParquet files contain geometry columns. Create a custom classification
to detect spatial data:

```bash
# Classification rule for WKT geometry strings
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/classificationrules/CSA_GEOSPATIAL_WKT?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "Custom",
    "properties": {
      "description": "Well-Known Text geometry representation",
      "classificationName": "CSA_GEOSPATIAL_WKT",
      "ruleStatus": "Enabled",
      "minimumPercentageMatch": 50.0,
      "dataPatterns": [
        { "pattern": "^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\\s*\\(" }
      ],
      "columnPatterns": [
        { "pattern": "(?i)(geom|geometry|shape|wkt|spatial|location_wkt)" }
      ]
    }
  }'

# Scan rule set that includes geo classifiers
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/scanrulesets/csa-geoparquet-ruleset?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureStorage",
    "properties": {
      "description": "GeoParquet files with spatial column detection",
      "includedCustomClassificationRuleNames": [
        "CSA_GEOSPATIAL_WKT", "CSA_PII_SSN", "CSA_PII_EMAIL"
      ],
      "scanRulesetType": "Custom"
    }
  }'
```

---

## Schema Extraction and Technical Metadata

Purview automatically extracts schema metadata during scanning. For each asset
you get:

- Column names, data types, and nullability
- File format, encoding, and compression
- Partition structure (for partitioned datasets)
- Row count estimates

### Query Schema via REST API

```bash
# Search for a specific asset
ASSET_QN="https://csadlzdevst.dfs.core.windows.net/silver/customers"

curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "customers",
    "filter": {
      "and": [
        { "objectType": "Tables" },
        { "collectionId": "production" }
      ]
    },
    "limit": 5
  }' | jq '.value[] | {name, qualifiedName, entityType}'

# Get full entity with schema
ENTITY_GUID="<guid-from-search>"
curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$ENTITY_GUID?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" | jq '.entity.relationshipAttributes.columns[] | {name: .displayText, type: .attributes.data_type}'
```

---

## Business Metadata Enrichment

### Apply Glossary Terms to Assets

```bash
# Link a glossary term to an asset
TERM_GUID="<glossary-term-guid>"
ENTITY_GUID="<entity-guid>"

curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary/terms/$TERM_GUID/assignedEntities" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "guid": "'$ENTITY_GUID'",
      "typeName": "azure_datalake_gen2_resource_set",
      "relationshipAttributes": {
        "meanings": [{ "guid": "'$TERM_GUID'" }]
      }
    }
  ]'
```

### Custom Metadata Attributes

Define custom type definitions to capture domain-specific metadata.
CSA-in-a-Box uses three custom attributes across all data assets:

| Attribute | Type | Values | Purpose |
|---|---|---|---|
| `data_domain` | string | finance, healthcare, environmental, transport | Which business domain owns the data |
| `quality_tier` | enum | bronze, silver, gold | Medallion layer / quality level |
| `sla_hours` | int | 1–168 | Max hours before data is considered stale |

```bash
# Create a business metadata type definition
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/types/typedefs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessMetadataDefs": [
      {
        "name": "CSA_DataGovernance",
        "description": "CSA-in-a-Box governance metadata",
        "attributeDefs": [
          {
            "name": "data_domain",
            "typeName": "string",
            "description": "Business domain that owns this asset",
            "isOptional": true,
            "cardinality": "SINGLE",
            "options": {
              "applicableEntityTypes": "[\"DataSet\",\"azure_datalake_gen2_resource_set\",\"azure_sql_table\"]"
            }
          },
          {
            "name": "quality_tier",
            "typeName": "string",
            "description": "Medallion architecture tier: bronze, silver, or gold",
            "isOptional": true,
            "cardinality": "SINGLE",
            "options": {
              "applicableEntityTypes": "[\"DataSet\"]"
            }
          },
          {
            "name": "sla_hours",
            "typeName": "int",
            "description": "Maximum acceptable data staleness in hours",
            "isOptional": true,
            "cardinality": "SINGLE",
            "options": {
              "applicableEntityTypes": "[\"DataSet\"]"
            }
          }
        ]
      }
    ]
  }'
```

### Apply Custom Metadata to an Asset

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$ENTITY_GUID/businessmetadata?isOverwrite=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "CSA_DataGovernance": {
      "data_domain": "finance",
      "quality_tier": "gold",
      "sla_hours": 4
    }
  }'
```

---

## Bulk Metadata Operations

### Bulk Update via REST API

```bash
# Bulk update classifications on multiple assets
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/bulk/setClassifications" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "guidHeaderMap": {
      "'$ENTITY_GUID_1'": {
        "classifications": [
          { "typeName": "MICROSOFT.PERSONAL.EMAIL" },
          { "typeName": "CSA_PII_SSN" }
        ]
      },
      "'$ENTITY_GUID_2'": {
        "classifications": [
          { "typeName": "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER" }
        ]
      }
    }
  }'
```

### Bulk Search and Tag

```bash
# Find all assets in the bronze container and tag them
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "*",
    "filter": {
      "and": [
        { "objectType": "Files" },
        { "assetType": "Azure Data Lake Storage Gen2" }
      ]
    },
    "limit": 100
  }' | jq -r '.value[].id' | while read GUID; do
    curl -s -X PUT \
      "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$GUID/businessmetadata?isOverwrite=false" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{ "CSA_DataGovernance": { "quality_tier": "bronze" } }'
    echo "Tagged $GUID as bronze"
  done
```

---

## Python Automation

Use `purview_automation.py` for programmatic metadata management:

```python
from azure.identity import DefaultAzureCredential
from csa_platform.governance.purview.purview_automation import PurviewAutomation

purview = PurviewAutomation(
    account_name="csadmlzdevpview",
    credential=DefaultAzureCredential(),
)

# Apply custom classification rules
results = purview.apply_classification_rules(
    "csa_platform/governance/purview/classifications/pii_classifications.yaml"
)
for r in results:
    print(f"{r['name']}: {r['status']}")

# Import glossary terms
results = purview.import_glossary_terms(
    "scripts/governance/glossary-terms.yaml",
    glossary_name="CSA Business Glossary",
)
for r in results:
    print(f"{r['name']}: {r['status']}")

# Schedule a recurring scan
from csa_platform.governance.purview.purview_automation import ScanSchedule

schedule = ScanSchedule(
    source_name="adls-csadlzdevst",
    scan_name="weekly-full-scan",
    trigger_type="Recurring",
    recurrence_interval=7,
    scan_level="Full",
)
result = purview.schedule_scan(schedule)
print(f"Scan schedule: {result['status']}")
```

### Dry-Run Mode

All automation methods support `dry_run=True` to validate configuration
without making changes:

```python
# Validate classification rules without applying
results = purview.apply_classification_rules(
    "csa_platform/governance/purview/classifications/pii_classifications.yaml",
    dry_run=True,
)
# Prints validation results without touching Purview
```

---

## Scan Monitoring

### Check Scan History

```bash
curl -s "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/weekly-full-scan/runs?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.value[] | {status, startTime, endTime, scanResultsCount: .assetsDiscovered}'
```

### Monitor via Azure Monitor

The Purview Bicep template configures diagnostic settings to send logs to
Log Analytics. Query scan status:

```kusto
PurviewScanStatusLogs
| where TimeGenerated > ago(7d)
| project TimeGenerated, ScanName, DataSourceName, ScanStatus, AssetsDiscovered
| order by TimeGenerated desc
```

---

## Next Steps

- [Data Cataloging](DATA_CATALOGING.md) — Build the business glossary and classifications
- [Data Lineage](DATA_LINEAGE.md) — Track data flow across pipelines
