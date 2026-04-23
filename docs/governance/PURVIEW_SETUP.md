# Purview Setup Guide — CSA-in-a-Box

This guide walks through the complete initial setup of Microsoft Purview within
the CSA-in-a-Box Cloud Scale Analytics platform. Purview is deployed as part of
the Data Management Landing Zone (DMLZ) Bicep templates and serves as the
central data governance hub.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Azure subscription | Owner or Contributor + User Access Administrator |
| DMLZ deployment complete | `deploy/bicep/dmlz/main.bicep` deployed successfully |
| Azure CLI ≥ 2.60 | `az --version` — includes `az purview` extension |
| Purview CLI extension | `az extension add --name purview` |
| Network connectivity | VPN or private endpoint access if public network disabled |
| Python 3.11+ (optional) | For automation scripts |

### Verify Purview Deployment

After DMLZ deployment, confirm the Purview account exists:

```bash
# Get the Purview account from the DMLZ resource group
PURVIEW_RG="rg-dmlz-dev"
PURVIEW_ACCOUNT=$(az purview account list \
  --resource-group "$PURVIEW_RG" \
  --query "[0].name" -o tsv)

echo "Purview account: $PURVIEW_ACCOUNT"

# Verify the managed identity
az purview account show \
  --name "$PURVIEW_ACCOUNT" \
  --resource-group "$PURVIEW_RG" \
  --query "{name:name, identity:identity.principalId, endpoint:endpoints.catalog}" \
  -o table
```

Expected output:

```
Name               Identity                              Endpoint
-----------------  ------------------------------------  ------------------------------------------
csadmlzdevpview    a1b2c3d4-e5f6-7890-abcd-ef1234567890  https://csadmlzdevpview.purview.azure.com
```

---

## Step 1: Design the Collection Hierarchy

Collections in Purview organize data assets and control access through RBAC.
CSA-in-a-Box uses a three-level hierarchy: **Organization → Environment → Domain**.

```
Root Collection (CSA-in-a-Box)
├── Production
│   ├── Finance
│   ├── Healthcare
│   ├── Environmental
│   └── Transportation
├── Staging
│   ├── Finance
│   ├── Healthcare
│   └── Shared
└── Development
    └── Sandbox
```

### Create Collections via REST API

```bash
PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"
TOKEN=$(az account get-access-token \
  --resource "https://purview.azure.net" \
  --query accessToken -o tsv)

# Create the Production collection under root
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/account/collections/production?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "friendlyName": "Production",
    "parentCollection": {
      "referenceName": "'$PURVIEW_ACCOUNT'",
      "type": "CollectionReference"
    },
    "description": "Production data assets"
  }'

# Create domain sub-collections under Production
for DOMAIN in Finance Healthcare Environmental Transportation; do
  curl -s -X PUT \
    "$PURVIEW_ENDPOINT/account/collections/prod-$(echo $DOMAIN | tr '[:upper:]' '[:lower:]')?api-version=2019-11-01-preview" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "friendlyName": "'$DOMAIN'",
      "parentCollection": {
        "referenceName": "production",
        "type": "CollectionReference"
      },
      "description": "Production '$DOMAIN' domain assets"
    }'
done

# Create Staging and Development collections
for ENV in staging development; do
  curl -s -X PUT \
    "$PURVIEW_ENDPOINT/account/collections/$ENV?api-version=2019-11-01-preview" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "friendlyName": "'${ENV^}'",
      "parentCollection": {
        "referenceName": "'$PURVIEW_ACCOUNT'",
        "type": "CollectionReference"
      }
    }'
done
```

### Verify Collections

```bash
curl -s "$PURVIEW_ENDPOINT/account/collections?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN" | jq '.value[].friendlyName'
```

---

## Step 2: Register Data Sources

The DMLZ deploys several data services. Each must be registered in Purview.

### 2.1 ADLS Gen2 (Data Lake)

```bash
STORAGE_ACCOUNT="csadlzdevst"
STORAGE_RG="rg-dlz-dev"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/adls-$STORAGE_ACCOUNT?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureStorage",
    "properties": {
      "endpoint": "https://'$STORAGE_ACCOUNT'.dfs.core.windows.net/",
      "resourceGroup": "'$STORAGE_RG'",
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

### 2.2 Azure Databricks

```bash
DATABRICKS_WORKSPACE="csadlzdevdbw"
DATABRICKS_URL="https://adb-1234567890123456.7.azuredatabricks.net"

curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/databricks-$DATABRICKS_WORKSPACE?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "Databricks",
    "properties": {
      "workspaceUrl": "'$DATABRICKS_URL'",
      "resourceGroup": "'$STORAGE_RG'",
      "subscriptionId": "'$SUBSCRIPTION_ID'",
      "location": "eastus",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'
```

### 2.3 Azure Synapse Analytics

```bash
SYNAPSE_NAME="csadlzdevsyn"

curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/synapse-$SYNAPSE_NAME?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureSynapseWorkspace",
    "properties": {
      "dedicatedSqlEndpoint": "'$SYNAPSE_NAME'.sql.azuresynapse.net",
      "serverlessSqlEndpoint": "'$SYNAPSE_NAME'-ondemand.sql.azuresynapse.net",
      "resourceGroup": "'$STORAGE_RG'",
      "subscriptionId": "'$SUBSCRIPTION_ID'",
      "location": "eastus",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'
```

### 2.4 Azure SQL Database

```bash
SQL_SERVER="csadlzdevsql"

curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/sql-$SQL_SERVER?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureSqlDatabase",
    "properties": {
      "serverEndpoint": "'$SQL_SERVER'.database.windows.net",
      "resourceGroup": "'$STORAGE_RG'",
      "subscriptionId": "'$SUBSCRIPTION_ID'",
      "location": "eastus",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'
```

### 2.5 Cosmos DB

```bash
COSMOS_NAME="csadlzdevcosmos"

curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/datasources/cosmos-$COSMOS_NAME?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "AzureCosmosDb",
    "properties": {
      "accountEndpoint": "https://'$COSMOS_NAME'.documents.azure.com:443/",
      "resourceGroup": "'$STORAGE_RG'",
      "subscriptionId": "'$SUBSCRIPTION_ID'",
      "location": "eastus",
      "collection": {
        "referenceName": "production",
        "type": "CollectionReference"
      }
    }
  }'
```

---

## Step 3: Configure Managed Identity Permissions

The Purview system-assigned managed identity needs read access to each data
source for scanning.

```bash
PURVIEW_MI=$(az purview account show \
  --name "$PURVIEW_ACCOUNT" \
  --resource-group "$PURVIEW_RG" \
  --query identity.principalId -o tsv)

# ADLS Gen2 — Storage Blob Data Reader
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$STORAGE_RG/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT"

# Azure SQL — Directory Reader (requires AAD admin)
# The Purview MI must be added as a database user:
# CREATE USER [csadmlzdevpview] FROM EXTERNAL PROVIDER;
# ALTER ROLE db_datareader ADD MEMBER [csadmlzdevpview];

# Synapse — Synapse Monitoring Operator (for lineage)
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$STORAGE_RG/providers/Microsoft.Synapse/workspaces/$SYNAPSE_NAME"

# Cosmos DB — Cosmos DB Account Reader
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Cosmos DB Account Reader Role" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$STORAGE_RG/providers/Microsoft.DocumentDB/databaseAccounts/$COSMOS_NAME"

# Databricks — Reader on workspace
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$STORAGE_RG/providers/Microsoft.Databricks/workspaces/$DATABRICKS_WORKSPACE"
```

---

## Step 4: Network Configuration

The DMLZ Bicep template deploys Purview with `publicNetworkAccess: Disabled` by
default. Five private endpoints are required:

| Endpoint Group | DNS Zone | Purpose |
|---|---|---|
| `account` | `privatelink.purview.azure.com` | Purview account API |
| `portal` | `privatelink.purviewstudio.azure.com` | Purview Studio UI |
| `blob` | `privatelink.blob.core.windows.net` | Managed storage (scan results) |
| `queue` | `privatelink.queue.core.windows.net` | Managed storage (scan queue) |
| `namespace` | `privatelink.servicebus.windows.net` | Managed Event Hub (Kafka) |

These are deployed via the `endpointConfigs` parameter in
`deploy/bicep/dmlz/modules/Purview/purview.bicep`. Verify connectivity:

```bash
# Test resolution of the Purview private endpoint
nslookup $PURVIEW_ACCOUNT.purview.azure.com

# Expected: resolves to a private IP (10.x.x.x) not a public IP
# If it resolves publicly, check Private DNS Zone link to VNet

# Test API connectivity
curl -s -o /dev/null -w "%{http_code}" \
  "$PURVIEW_ENDPOINT/account/collections?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 200
```

### Managed VNet for Scanning

For data sources behind private endpoints, configure the Purview managed VNet
integration runtime:

```bash
# Enable managed VNet on the Purview account
az purview account update \
  --name "$PURVIEW_ACCOUNT" \
  --resource-group "$PURVIEW_RG" \
  --managed-resources-public-network-access "Disabled"
```

### Ingestion Private Endpoints

Create ingestion private endpoints so scans can reach sources over private
networks:

```bash
# Create a managed private endpoint for the storage account
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/proxy/managedPrivateEndpoints/adls-ingestion-pe?api-version=2021-12-01" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "privateLinkResourceId": "/subscriptions/'$SUBSCRIPTION_ID'/resourceGroups/'$STORAGE_RG'/providers/Microsoft.Storage/storageAccounts/'$STORAGE_ACCOUNT'",
      "groupId": "blob",
      "requestMessage": "Purview ingestion access"
    }
  }'
```

After creating managed private endpoints, approve them on the target resource:

```bash
# List pending PE connections on the storage account
az network private-endpoint-connection list \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$STORAGE_RG" \
  --type Microsoft.Storage/storageAccounts \
  --query "[?properties.privateLinkServiceConnectionState.status=='Pending'].{id:id, status:properties.privateLinkServiceConnectionState.status}" \
  -o table

# Approve the connection
PE_ID=$(az network private-endpoint-connection list \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$STORAGE_RG" \
  --type Microsoft.Storage/storageAccounts \
  --query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id" -o tsv | head -1)

az network private-endpoint-connection approve \
  --id "$PE_ID" \
  --description "Approved for Purview scanning"
```

---

## Step 5: Verification Checklist

Run through these checks after setup:

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Account exists | `az purview account show --name $PURVIEW_ACCOUNT -g $PURVIEW_RG` | Status: Succeeded |
| 2 | Collections created | `curl $PURVIEW_ENDPOINT/account/collections?api-version=2019-11-01-preview` | 7+ collections |
| 3 | Sources registered | `curl $PURVIEW_ENDPOINT/scan/datasources?api-version=2022-07-01-preview` | 5 sources |
| 4 | MI has RBAC | `az role assignment list --assignee $PURVIEW_MI --all` | 4+ role assignments |
| 5 | DNS resolves privately | `nslookup $PURVIEW_ACCOUNT.purview.azure.com` | 10.x.x.x |
| 6 | API accessible | `curl -s -o /dev/null -w "%{http_code}" $PURVIEW_ENDPOINT/account/...` | 200 |
| 7 | Studio accessible | Open `https://web.purview.azure.com` in browser | Dashboard loads |

---

## Common Issues

| Issue | Cause | Resolution |
|---|---|---|
| `403 Forbidden` on API calls | Missing Purview role assignment | Add user/SP as Collection Admin on root collection in Purview Studio |
| DNS resolves to public IP | Private DNS zone not linked to VNet | `az network private-dns zone vnet-link create` to link the zone |
| Scan fails with timeout | Source behind firewall, no managed PE | Create ingestion private endpoint (Step 4) |
| `409 Conflict` creating collection | Collection name already exists | Use a unique `referenceName` (alphanumeric, no spaces) |
| Managed identity can't scan SQL | MI not added as DB user | Run `CREATE USER [purview-name] FROM EXTERNAL PROVIDER` in SQL |
| Kafka events not flowing | Event Hub namespace disabled or wrong role | Verify Event Hubs Data Owner on the namespace (see Bicep template) |
| Studio shows blank page | Browser caching or private endpoint issue | Clear cache, verify `portal` private endpoint resolves |
| Source shows "Disconnected" | Credential expired or access revoked | Re-check managed identity RBAC assignments |

---

## Next Steps

- [Metadata Management](METADATA_MANAGEMENT.md) — Configure scanning and metadata enrichment
- [Data Cataloging](DATA_CATALOGING.md) — Set up the business glossary and classifications
- [Data Lineage](DATA_LINEAGE.md) — Configure lineage capture across pipelines
- [Data Quality](DATA_QUALITY.md) — Integrate Great Expectations quality rules
- [Data Access](DATA_ACCESS.md) — Set up self-service access policies
