# Tutorial: Data Governance with Microsoft Purview

This tutorial walks you through setting up complete data governance for the
CSA-in-a-Box platform using Microsoft Purview. By the end, you will have a
fully configured data catalog with automated scanning, business glossary,
custom classifications, lineage tracking, quality monitoring, and access
policies.

**Time required:** 2–3 hours
**Prerequisites:** DMLZ deployed, Azure CLI, Python 3.11+

---

## Table of Contents

1. [Verify Purview Deployment](#step-1-verify-purview-deployment)
2. [Configure Collection Hierarchy](#step-2-configure-collection-hierarchy)
3. [Register and Scan Data Sources](#step-3-register-and-scan-data-sources)
4. [Set Up Business Glossary](#step-4-set-up-business-glossary)
5. [Create Custom Classifications](#step-5-create-custom-classifications)
6. [Configure Data Lineage](#step-6-configure-data-lineage)
7. [Set Up Data Quality Rules](#step-7-set-up-data-quality-rules)
8. [Configure Access Policies](#step-8-configure-access-policies)
9. [Validate End-to-End](#step-9-validate-end-to-end)

---

## Step 1: Verify Purview Deployment

The Purview account is deployed as part of the Data Management Landing Zone
(DMLZ) Bicep templates at `deploy/bicep/dmlz/modules/Purview/purview.bicep`.

### Check the deployment

```bash
# Set variables for your environment
export PURVIEW_RG="rg-dmlz-dev"
export DLZ_RG="rg-dlz-dev"
export ENV="dev"

# Find the Purview account
export PURVIEW_ACCOUNT=$(az purview account list \
  --resource-group "$PURVIEW_RG" \
  --query "[0].name" -o tsv)

echo "Purview account: $PURVIEW_ACCOUNT"

# Verify it's running
az purview account show \
  --name "$PURVIEW_ACCOUNT" \
  --resource-group "$PURVIEW_RG" \
  --query "{name:name, state:provisioningState, endpoint:endpoints.catalog}" \
  -o table
```

**Expected output:**

```
Name               State      Endpoint
-----------------  ---------  ------------------------------------------
csadmlzdevpview    Succeeded  https://csadmlzdevpview.purview.azure.com
```

### Verify network access

```bash
export PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"
export TOKEN=$(az account get-access-token \
  --resource "https://purview.azure.net" \
  --query accessToken -o tsv)

# Test API connectivity
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "$PURVIEW_ENDPOINT/account/collections?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN")

echo "API status: $HTTP_STATUS"  # Should be 200
```

If you get `403`, you need Collection Admin role on the root collection.
If you get a connection error, check private endpoint DNS resolution.

> 📖 **Detailed reference:** [docs/governance/PURVIEW_SETUP.md](../../governance/PURVIEW_SETUP.md)

---

## Step 2: Configure Collection Hierarchy

Collections organize your data assets and control access inheritance.

### Option A: Use the bootstrap script (recommended)

```bash
./scripts/governance/bootstrap-purview.sh \
  --purview-account "$PURVIEW_ACCOUNT" \
  --purview-rg "$PURVIEW_RG" \
  --dlz-rg "$DLZ_RG" \
  --env "$ENV" \
  --dry-run  # Remove --dry-run when ready to apply
```

### Option B: Create manually

```bash
# Create environment collections
for ENV_NAME in production staging development; do
  curl -s -X PUT \
    "$PURVIEW_ENDPOINT/account/collections/$ENV_NAME?api-version=2019-11-01-preview" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "friendlyName": "'${ENV_NAME^}'",
      "parentCollection": {
        "referenceName": "'$PURVIEW_ACCOUNT'",
        "type": "CollectionReference"
      }
    }'
done

# Create domain collections under Production
for DOMAIN in Finance Healthcare Environmental Transportation; do
  DOMAIN_LOWER=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  curl -s -X PUT \
    "$PURVIEW_ENDPOINT/account/collections/prod-$DOMAIN_LOWER?api-version=2019-11-01-preview" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "friendlyName": "'$DOMAIN'",
      "parentCollection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }'
done
```

### Verify

```bash
curl -s "$PURVIEW_ENDPOINT/account/collections?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.value[] | .friendlyName' -r | sort
```

Expected output:

```
CSA-in-a-Box (root)
Development
Environmental
Finance
Healthcare
Production
Sandbox
Shared
Staging
Transportation
```

> 📖 **Detailed reference:** [docs/governance/PURVIEW_SETUP.md — Step 1](../../governance/PURVIEW_SETUP.md#step-1-design-the-collection-hierarchy)

---

## Step 3: Register and Scan Data Sources

### Register sources

The bootstrap script registers all five source types. To register individually:

```bash
STORAGE_ACCOUNT="csadlz${ENV}st"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Register ADLS Gen2
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/adls-$STORAGE_ACCOUNT?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureStorage",
    "properties": {
      "endpoint": "https://'$STORAGE_ACCOUNT'.dfs.core.windows.net/",
      "resourceGroup": "'$DLZ_RG'",
      "subscriptionId": "'$SUBSCRIPTION_ID'",
      "location": "eastus",
      "resourceName": "'$STORAGE_ACCOUNT'",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'
```

### Grant managed identity access

```bash
PURVIEW_MI=$(az purview account show \
  --name "$PURVIEW_ACCOUNT" \
  --resource-group "$PURVIEW_RG" \
  --query identity.principalId -o tsv)

az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$DLZ_RG/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT"
```

### Create and run a scan

```bash
SOURCE_NAME="adls-$STORAGE_ACCOUNT"

# Create scan definition
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/initial-scan?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureStorageMsi",
    "properties": {
      "scanRulesetName": "AzureStorage",
      "scanRulesetType": "System",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'

# Trigger scan
curl -s -X POST \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/initial-scan/runs?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "scanLevel": "Full" }'

echo "Scan triggered. Check status in Purview Studio or via API."
```

### Check scan status

```bash
curl -s "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/initial-scan/runs?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.value[0] | {status, startTime, endTime}'
```

Wait for `"status": "Succeeded"` before proceeding.

> 📖 **Detailed reference:** [docs/governance/PURVIEW_SETUP.md — Step 2-3](../../governance/PURVIEW_SETUP.md#step-2-register-data-sources), [docs/governance/METADATA_MANAGEMENT.md](../../governance/METADATA_MANAGEMENT.md)

---

## Step 4: Set Up Business Glossary

### Option A: Use the seed script (recommended)

```bash
python scripts/governance/seed-glossary.py \
  --purview-account "$PURVIEW_ACCOUNT" \
  --glossary-file scripts/governance/glossary-terms.yaml
```

This creates 30+ terms organized into categories (Data Engineering, Data
Governance, Finance, Healthcare, Environmental, Transportation, Quality Metrics)
with parent-child relationships.

### Option B: Use the automation module

```bash
python -m csa_platform.governance.purview.purview_automation \
  --account "$PURVIEW_ACCOUNT" \
  --action import-glossary \
  --glossary-file scripts/governance/glossary-terms.yaml
```

### Verify glossary

```bash
curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.[0] | {name, guid, termCount: (.terms | length)}'
```

### Link terms to assets

After scanning discovers assets, link glossary terms to them:

```bash
# Find the gold customer table
ENTITY_GUID=$(curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "gld_customer_lifetime_value", "limit": 1 }' \
  | jq -r '.value[0].id')

# Get the CLV term GUID
CLV_GUID=$(curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.[0].terms[] | select(.displayText == "Customer Lifetime Value") | .termGuid')

# Link them
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary/terms/$CLV_GUID/assignedEntities" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{ "guid": "'$ENTITY_GUID'" }]'

echo "Linked CLV term to gold customer table"
```

> 📖 **Detailed reference:** [docs/governance/DATA_CATALOGING.md](../../governance/DATA_CATALOGING.md)

---

## Step 5: Create Custom Classifications

### Option A: Use the bootstrap script

The bootstrap script creates SSN, EIN, Tribal Enrollment ID, MRN, and
Financial Account Number classifiers automatically.

### Option B: Apply from YAML

```bash
python -m csa_platform.governance.purview.purview_automation \
  --account "$PURVIEW_ACCOUNT" \
  --action apply-classifications \
  --rules-dir csa_platform/governance/purview/classifications/
```

This processes all YAML files in the classifications directory:
- `pii_classifications.yaml` — SSN, email, phone, address, name
- `phi_classifications.yaml` — Medical record numbers, diagnosis codes
- `financial_classifications.yaml` — Account numbers, credit cards
- `government_classifications.yaml` — EIN, tribal enrollment, federal IDs

### Option C: Create individually

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/classificationrules/CSA_PII_SSN?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "Custom",
    "properties": {
      "description": "US Social Security Number",
      "classificationName": "CSA_PII_SSN",
      "ruleStatus": "Enabled",
      "minimumPercentageMatch": 60.0,
      "dataPatterns": [
        { "pattern": "\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b" }
      ],
      "columnPatterns": [
        { "pattern": "(?i)(ssn|social_security|ss_number)" }
      ]
    }
  }'
```

### Verify classifications

```bash
curl -s "$PURVIEW_ENDPOINT/scan/classificationrules?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.value[] | select(.name | startswith("CSA_")) | .name'
```

### Re-scan with custom classifiers

After creating classifications, re-scan to detect them:

```bash
# Update the scan to use the custom ruleset
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/initial-scan?api-version=2022-07-01-preview" \
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

# Trigger re-scan
curl -s -X POST \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME/scans/initial-scan/runs?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "scanLevel": "Full" }'
```

> 📖 **Detailed reference:** [docs/governance/DATA_CATALOGING.md — Custom Classifications](../../governance/DATA_CATALOGING.md#custom-classifications)

---

## Step 6: Configure Data Lineage

### 6.1 ADF Pipeline Lineage (Automatic)

Connect ADF to Purview for automatic lineage capture:

```bash
ADF_NAME="csadlz${ENV}adf"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Grant Purview MI access to ADF
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Data Factory Contributor" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$DLZ_RG/providers/Microsoft.DataFactory/factories/$ADF_NAME"
```

Then in ADF Studio: **Manage → Microsoft Purview → Connect** and select
your Purview account.

### 6.2 Databricks Lineage (OpenLineage)

Add OpenLineage Spark listener to Databricks clusters. See the detailed guide
for init script and Spark configuration.

Quick test — register lineage from a notebook:

```python
# In a Databricks notebook
from azure.identity import DefaultAzureCredential
import requests

token = DefaultAzureCredential().get_token("https://purview.azure.net/.default").token
purview_url = "https://csadmlzdevpview.purview.azure.com"

resp = requests.post(
    f"{purview_url}/catalog/api/atlas/v2/entity/bulk",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    json={"entities": [{
        "typeName": "databricks_notebook_process",
        "attributes": {
            "qualifiedName": "databricks://csadlzdev/notebooks/silver/transform_customers",
            "name": "Transform: customers",
        },
        "relationshipAttributes": {
            "inputs": [{"typeName": "azure_datalake_gen2_resource_set",
                        "uniqueAttributes": {"qualifiedName": "https://csadlzdevst.dfs.core.windows.net/bronze/customers"}}],
            "outputs": [{"typeName": "azure_datalake_gen2_resource_set",
                         "uniqueAttributes": {"qualifiedName": "https://csadlzdevst.dfs.core.windows.net/silver/customers"}}],
        },
    }]},
    timeout=30,
)
print(f"Status: {resp.status_code}")
```

### 6.3 dbt Lineage

After running dbt, push lineage from the manifest:

```bash
python -m csa_platform.governance.purview.purview_automation \
  --account "$PURVIEW_ACCOUNT" \
  --action register-dbt-lineage \
  --manifest target/manifest.json
```

### Verify lineage

```bash
# Search for process entities
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "*", "filter": { "objectType": "Processes" }, "limit": 10 }' \
  | jq '.["@search.count"] as $count | "\($count) process entities found"'
```

> 📖 **Detailed reference:** [docs/governance/DATA_LINEAGE.md](../../governance/DATA_LINEAGE.md)

---

## Step 7: Set Up Data Quality Rules

### 7.1 Great Expectations

The quality framework is defined in
`csa_platform/governance/dataquality/quality-rules.yaml` with expectation
suites for each medallion layer.

Run quality checks:

```bash
# Run the daily quality checkpoint
python csa_platform/governance/dataquality/run_quality_checks.py \
  --config csa_platform/governance/dataquality/quality-rules.yaml \
  --suite bronze_customers_suite
```

### 7.2 Push Quality Scores to Purview

After running quality checks, update asset metadata:

```bash
# Create the quality metadata type (one-time setup)
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/types/typedefs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessMetadataDefs": [{
      "name": "CSA_DataQuality",
      "description": "Data quality scores",
      "attributeDefs": [
        { "name": "quality_score", "typeName": "float", "isOptional": true, "cardinality": "SINGLE",
          "options": { "applicableEntityTypes": "[\"DataSet\"]" } },
        { "name": "completeness_score", "typeName": "float", "isOptional": true, "cardinality": "SINGLE",
          "options": { "applicableEntityTypes": "[\"DataSet\"]" } },
        { "name": "last_checked", "typeName": "string", "isOptional": true, "cardinality": "SINGLE",
          "options": { "applicableEntityTypes": "[\"DataSet\"]" } }
      ]
    }]
  }'

# Update an asset with quality scores
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$ENTITY_GUID/businessmetadata?isOverwrite=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "CSA_DataQuality": {
      "quality_score": 0.96,
      "completeness_score": 0.99,
      "last_checked": "2025-01-12T06:00:00Z"
    }
  }'
```

### 7.3 Configure Alerting

Set up alerts for quality failures using Azure Monitor (see quality-rules.yaml
alerting section).

> 📖 **Detailed reference:** [docs/governance/DATA_QUALITY.md](../../governance/DATA_QUALITY.md)

---

## Step 8: Configure Access Policies

### Enable Data Use Management

```bash
# Enable access policies on the ADLS source
curl -s -X PATCH \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "properties": { "dataUseGovernance": "Enabled" } }'
```

### Create a read policy

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/policyStore/dataPolicies/read-gold-finance?api-version=2022-12-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "read-gold-finance",
    "properties": {
      "description": "Finance team read access to gold/finance/",
      "decisionRules": [{
        "effect": "Permit",
        "dnfCondition": [[
          { "attributeName": "resource.path", "attributeValueIncludes": "gold/finance" },
          { "attributeName": "principal.microsoft.groups", "attributeValueIncludedIn": ["sg-finance-analysts"] },
          { "attributeName": "action.id", "attributeValueIncludes": "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read" }
        ]]
      }],
      "collection": { "referenceName": "prod-finance", "type": "CollectionReference" }
    }
  }'
```

### Assign collection roles

Grant your team appropriate roles on collections via Purview Studio:
- **Collection Admin** → Platform team
- **Data Source Admin** → Data engineers
- **Data Curator** → Data stewards
- **Data Reader** → Analysts

> 📖 **Detailed reference:** [docs/governance/DATA_ACCESS.md](../../governance/DATA_ACCESS.md)

---

## Step 9: Validate End-to-End

Run through this checklist to confirm everything is working:

### Automated validation

```bash
echo "=== CSA-in-a-Box Governance Validation ==="
echo ""

# 1. Purview account
echo "1. Purview Account"
az purview account show --name "$PURVIEW_ACCOUNT" -g "$PURVIEW_RG" \
  --query "{name:name, state:provisioningState}" -o table
echo ""

# 2. Collections
echo "2. Collections"
COLLECTION_COUNT=$(curl -s "$PURVIEW_ENDPOINT/account/collections?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN" | jq '.value | length')
echo "   Collections: $COLLECTION_COUNT (expected: 9+)"
echo ""

# 3. Data Sources
echo "3. Data Sources"
SOURCE_COUNT=$(curl -s "$PURVIEW_ENDPOINT/scan/datasources?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" | jq '.value | length')
echo "   Sources: $SOURCE_COUNT (expected: 5)"
echo ""

# 4. Custom Classifications
echo "4. Custom Classifications"
CLASS_COUNT=$(curl -s "$PURVIEW_ENDPOINT/scan/classificationrules?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" | jq '[.value[] | select(.name | startswith("CSA_"))] | length')
echo "   Custom classifications: $CLASS_COUNT (expected: 5+)"
echo ""

# 5. Glossary Terms
echo "5. Glossary"
TERM_COUNT=$(curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary" \
  -H "Authorization: Bearer $TOKEN" | jq '.[0].terms | length')
echo "   Terms: $TERM_COUNT (expected: 30+)"
echo ""

# 6. Discovered Assets
echo "6. Discovered Assets"
ASSET_COUNT=$(curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "*", "limit": 0 }' | jq '.["@search.count"]')
echo "   Assets: $ASSET_COUNT"
echo ""

# 7. Lineage
echo "7. Lineage"
PROCESS_COUNT=$(curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "*", "filter": { "objectType": "Processes" }, "limit": 0 }' \
  | jq '.["@search.count"]')
echo "   Process entities: $PROCESS_COUNT"
echo ""

echo "=== Validation Complete ==="
```

### Manual checks in Purview Studio

Open [https://web.purview.azure.com](https://web.purview.azure.com) and verify:

| Check | Where | Expected |
|---|---|---|
| Collections visible | Data Map → Collections | 9+ collections in hierarchy |
| Sources registered | Data Map → Sources | 5 registered sources |
| Scan completed | Data Map → Sources → ADLS → Scans | Last run: Succeeded |
| Assets discovered | Data Catalog → Browse | Tables, files visible |
| Glossary populated | Data Catalog → Glossary | 30+ terms in categories |
| Classifications applied | Any scanned asset → Schema tab | CSA_PII_SSN etc. |
| Lineage visible | Any gold asset → Lineage tab | Upstream chain visible |
| Quality metadata | Any asset → Properties | CSA_DataQuality scores |

---

## What's Next

You now have a fully governed data platform. Here are suggested next steps:

1. **Automate with CI/CD** — Run `bootstrap-purview.sh` and classification
   updates in your deployment pipeline
2. **Set up approval workflows** — Use Logic Apps for sensitive data access
   requests (see [DATA_ACCESS.md](../../governance/DATA_ACCESS.md))
3. **Configure sensitivity labels** — Connect MIP for auto-labeling
   (see [DATA_CATALOGING.md](../../governance/DATA_CATALOGING.md))
4. **Monitor quality trends** — Build Power BI dashboards from quality scores
5. **Onboard domain teams** — Train data stewards on glossary management and
   asset certification

---

## Reference Documentation

| Document | Purpose |
|---|---|
| [PURVIEW_SETUP.md](../../governance/PURVIEW_SETUP.md) | Initial setup, network, permissions |
| [METADATA_MANAGEMENT.md](../../governance/METADATA_MANAGEMENT.md) | Scanning, custom metadata |
| [DATA_CATALOGING.md](../../governance/DATA_CATALOGING.md) | Glossary, classifications, labels |
| [DATA_LINEAGE.md](../../governance/DATA_LINEAGE.md) | ADF, Databricks, dbt lineage |
| [DATA_QUALITY.md](../../governance/DATA_QUALITY.md) | Great Expectations, scoring |
| [DATA_ACCESS.md](../../governance/DATA_ACCESS.md) | Policies, RBAC, audit |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `403` on API calls | Ensure you have Collection Admin on root. Run `az login` to refresh token. |
| Scan fails | Check managed identity has Storage Blob Data Reader. Check private endpoints. |
| Glossary import fails | Ensure no duplicate term names. Check glossary GUID is valid. |
| Classifications not detected | Re-scan after creating rules. Check `minimumPercentageMatch` threshold. |
| Lineage not showing | ADF lineage takes 15-30 minutes after pipeline run. Check connection in ADF Studio. |
| Access policy not enforced | Allow up to 2 hours for policy propagation. Check Data Use Management is enabled. |
