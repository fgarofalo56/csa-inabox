# Data Lineage — CSA-in-a-Box

This guide covers lineage capture and visualization across ADF pipelines,
Databricks notebooks, Synapse pipelines, dbt models, and streaming workloads.

---

## Overview

CSA-in-a-Box captures lineage at four levels:

| Level         | Example                               | Capture Method                          |
| ------------- | ------------------------------------- | --------------------------------------- |
| Pipeline      | ADF copy activity                     | Automatic (Purview–ADF integration)     |
| Notebook      | Databricks PySpark                    | OpenLineage Spark integration           |
| SQL Transform | Synapse stored procedures             | Automatic (Purview–Synapse integration) |
| dbt Model     | dbt manifest.json → Purview Atlas API | Custom `purview_automation.py`          |

---

## ADF Pipeline Lineage

### Automatic Capture

When Azure Data Factory is connected to Purview, lineage is captured
automatically for Copy, Data Flow, and Execute SSIS Package activities.

#### Connect ADF to Purview

```bash
TOKEN=$(az account get-access-token --resource "https://purview.azure.net" --query accessToken -o tsv)
PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"
ADF_NAME="csadlzdevadf"
ADF_RG="rg-dlz-dev"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Grant Purview MI the "Data Factory Contributor" role on ADF
PURVIEW_MI=$(az purview account show --name $PURVIEW_ACCOUNT --resource-group rg-dmlz-dev --query identity.principalId -o tsv)
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Data Factory Contributor" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$ADF_RG/providers/Microsoft.DataFactory/factories/$ADF_NAME"

# In ADF Studio → Manage → Microsoft Purview → Connect
# Or via ADF ARM: set purviewConfiguration.purviewResourceId
```

#### Verify ADF Lineage

After running an ADF pipeline, check lineage in Purview:

```bash
# Search for the pipeline process entity
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "copy-bronze-customers",
    "filter": { "objectType": "Processes" },
    "limit": 5
  }' | jq '.value[] | {name, qualifiedName, entityType}'

# Get lineage for the process
PROCESS_GUID="<guid-from-search>"
curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/lineage/$PROCESS_GUID?direction=BOTH&depth=3&api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '{guidEntityMap: (.guidEntityMap | to_entries[] | {name: .value.attributes.name, type: .value.typeName}), relations: (.relations | length)}'
```

### Manual ADF Lineage Registration

For pipelines not automatically captured, use the automation library:

```python
from azure.identity import DefaultAzureCredential
from csa_platform.governance.purview.purview_automation import PurviewAutomation

purview = PurviewAutomation("csadmlzdevpview", DefaultAzureCredential())

result = purview.register_adf_lineage(
    pipeline_name="ingest-noaa-weather",
    factory_name="csadlzdevadf",
    source_datasets=[
        "https://csadlzdevst.dfs.core.windows.net/raw/noaa/observations/"
    ],
    sink_datasets=[
        "https://csadlzdevst.dfs.core.windows.net/bronze/noaa/observations/"
    ],
)
print(f"Lineage status: {result['status']}")
```

---

## Databricks Notebook Lineage via OpenLineage

Databricks does not emit lineage to Purview natively. CSA-in-a-Box uses the
[OpenLineage](https://openlineage.io/) Spark integration to capture notebook
lineage and push it to Purview.

### Step 1: Install OpenLineage Spark Integration

Add the OpenLineage Spark listener to your Databricks cluster init script or
cluster libraries:

```bash
# Option A: Cluster library (recommended for shared clusters)
# In Databricks workspace → Compute → Cluster → Libraries → Install New
# Maven coordinates: io.openlineage:openlineage-spark_2.12:1.25.0

# Option B: Init script
cat > /dbfs/init-scripts/openlineage-init.sh << 'INIT_SCRIPT'
#!/bin/bash
# Download OpenLineage Spark listener
wget -q -O /databricks/jars/openlineage-spark.jar \
  "https://repo1.maven.org/maven2/io/openlineage/openlineage-spark_2.12/1.25.0/openlineage-spark_2.12-1.25.0.jar"
INIT_SCRIPT
```

### Step 2: Configure Databricks Cluster for Lineage Emission

Add these Spark configuration properties to the cluster:

```
spark.extraListeners                        io.openlineage.spark.agent.OpenLineageSparkListener
spark.openlineage.transport.type            http
spark.openlineage.transport.url             https://<your-openlineage-proxy>/api/v1/lineage
spark.openlineage.namespace                 databricks-csadlzdev
spark.openlineage.parentJobNamespace        databricks-csadlzdev
spark.openlineage.parentJobName             ${spark.databricks.clusterUsageTags.clusterName}
```

If you use an intermediate OpenLineage-to-Purview proxy (e.g., Marquez or a
custom Azure Function), configure the URL to point there. Alternatively, use
the direct Atlas API approach below.

### Step 3: Direct Purview Push (No Proxy)

If you prefer to push lineage directly from a notebook post-execution:

```python
# In a Databricks notebook cell
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

# After your transformations, capture the query plan
input_tables = ["bronze.brz_customers", "bronze.brz_addresses"]
output_table = "silver.slv_customer_360"

# Push lineage to Purview via REST
import requests
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
token = credential.get_token("https://purview.azure.net/.default").token
purview_url = "https://csadmlzdevpview.purview.azure.com"

lineage_entities = []
for src in input_tables:
    lineage_entities.append({
        "typeName": "databricks_notebook_process",
        "attributes": {
            "qualifiedName": f"databricks://csadlzdev/notebooks/silver/{output_table}",
            "name": f"Transform: {output_table}",
        },
        "relationshipAttributes": {
            "inputs": [
                {
                    "typeName": "azure_datalake_gen2_resource_set",
                    "uniqueAttributes": {
                        "qualifiedName": f"https://csadlzdevst.dfs.core.windows.net/{src.replace('.', '/')}"
                    },
                }
            ],
            "outputs": [
                {
                    "typeName": "azure_datalake_gen2_resource_set",
                    "uniqueAttributes": {
                        "qualifiedName": f"https://csadlzdevst.dfs.core.windows.net/{output_table.replace('.', '/')}"
                    },
                }
            ],
        },
    })

resp = requests.post(
    f"{purview_url}/catalog/api/atlas/v2/entity/bulk",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    json={"entities": lineage_entities},
    timeout=30,
)
print(f"Lineage registered: {resp.status_code}")
```

### Step 4: Verify Lineage in Purview

```bash
# Search for the Databricks process entity
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "slv_customer_360", "filter": { "objectType": "Processes" }, "limit": 5 }' \
  | jq '.value[] | {name, qualifiedName}'
```

---

## Synapse Pipeline Lineage

Synapse Analytics lineage is captured automatically when connected to Purview.

### Connect Synapse to Purview

```bash
SYNAPSE_NAME="csadlzdevsyn"
SYNAPSE_RG="rg-dlz-dev"

# Grant Purview MI Reader on Synapse workspace
az role assignment create \
  --assignee-object-id "$PURVIEW_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$SYNAPSE_RG/providers/Microsoft.Synapse/workspaces/$SYNAPSE_NAME"

# In Synapse Studio → Manage → Microsoft Purview → Connect
# Set the Purview account and enable lineage reporting
```

### Supported Activities

| Activity Type    | Lineage Support                         |
| ---------------- | --------------------------------------- |
| Copy activity    | ✅ Source → Sink                        |
| Data Flow        | ✅ Full column-level lineage            |
| Stored Procedure | ✅ If parseable SQL                     |
| Notebook (Spark) | ⚠️ Via OpenLineage (same as Databricks) |
| SQL Script       | ❌ Manual registration needed           |

---

## dbt Lineage → Purview

CSA-in-a-Box provides a custom integration to push dbt model lineage to Purview
using the `purview_automation.py` module.

### How It Works

1. dbt generates `target/manifest.json` with model dependency graph
2. `purview_automation.register_dbt_lineage()` parses the manifest
3. For each model, it extracts upstream dependencies (`depends_on.nodes`)
4. It creates Atlas lineage entities in Purview connecting sources → models → outputs

### Run the Integration

```bash
# After a dbt run
python -m csa_platform.governance.purview.purview_automation \
  --account csadmlzdevpview \
  --action register-dbt-lineage \
  --manifest target/manifest.json \
  --run-results target/run_results.json
```

Or in Python:

```python
from azure.identity import DefaultAzureCredential
from csa_platform.governance.purview.purview_automation import PurviewAutomation

purview = PurviewAutomation("csadmlzdevpview", DefaultAzureCredential())

result = purview.register_dbt_lineage(
    manifest_path="target/manifest.json",
    run_results_path="target/run_results.json",
)
print(f"Registered {result['relationships']} lineage relationships")
```

### Column-Level Lineage from dbt

For column-level lineage, parse the `columns` section of each model in
the manifest:

```python
import json

with open("target/manifest.json") as f:
    manifest = json.load(f)

for node_id, node in manifest["nodes"].items():
    if node.get("resource_type") != "model":
        continue
    model_name = node["name"]
    columns = node.get("columns", {})
    for col_name, col_info in columns.items():
        # col_info may contain 'meta.lineage' if you add it in dbt schema.yml
        upstream = col_info.get("meta", {}).get("upstream_column")
        if upstream:
            print(f"{model_name}.{col_name} ← {upstream}")
            # Register column-level lineage via Atlas API
            # POST /catalog/api/atlas/v2/entity with columnMapping
```

### Custom dbt Manifest Parser

For advanced dbt lineage including test results and freshness:

```bash
python scripts/purview/register_lineage.py \
  --purview-account csadmlzdevpview \
  --manifest target/manifest.json \
  --run-results target/run_results.json
```

---

## Cross-Domain Lineage Visualization

When data flows across domain boundaries (e.g., raw Environmental data →
Finance analytics), Purview shows the complete cross-collection lineage.

### View Cross-Domain Lineage

1. Open Purview Studio → Data Catalog → Browse by collection
2. Select any gold-layer asset
3. Click the **Lineage** tab
4. Toggle "Show column-level lineage" for detailed mapping
5. Expand upstream to see the full path: raw → bronze → silver → gold

### Programmatic Lineage Query

```bash
# Get full lineage graph for an asset (3 levels deep)
curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/lineage/$ENTITY_GUID?direction=BOTH&depth=5&api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '{
    entities: [.guidEntityMap | to_entries[] | {guid: .key, name: .value.attributes.name, type: .value.typeName}],
    relationships: .relations | length
  }'
```

---

## Streaming Pipeline Lineage

For streaming workloads (Event Hubs → Azure Functions → Cosmos DB), lineage
is not automatically captured. Register it manually:

```bash
# Register a streaming process entity
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/bulk" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "entities": [
      {
        "typeName": "azure_function_process",
        "attributes": {
          "qualifiedName": "azfunc://csadlzdev/process-iot-telemetry",
          "name": "Process IoT Telemetry",
          "description": "Azure Function that processes IoT telemetry from Event Hubs and writes to Cosmos DB"
        },
        "relationshipAttributes": {
          "inputs": [
            {
              "typeName": "azure_event_hub",
              "uniqueAttributes": {
                "qualifiedName": "eventhubs://csadlzdeveh.servicebus.windows.net/iot-telemetry"
              }
            }
          ],
          "outputs": [
            {
              "typeName": "azure_cosmosdb_collection",
              "uniqueAttributes": {
                "qualifiedName": "cosmosdb://csadlzdevcosmos.documents.azure.com/iot-db/telemetry-raw"
              }
            }
          ]
        }
      }
    ]
  }'
```

### Streaming Lineage Patterns

```
Event Hub (iot-telemetry)
  └─→ Azure Function (process-iot-telemetry)
       ├─→ Cosmos DB (telemetry-raw)           [hot path]
       └─→ ADLS Gen2 (bronze/iot/telemetry/)   [cold path]
            └─→ Databricks (aggregate-iot)
                 └─→ ADLS Gen2 (gold/iot/daily-summary/)
```

Register each hop as a separate process entity with inputs/outputs.

---

## Lineage Validation

Run these checks to confirm lineage is being captured:

```bash
# Count process entities by type
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "*", "filter": { "objectType": "Processes" }, "limit": 0 }' \
  | jq '.["@search.count"]'

# Verify specific pipeline has lineage
curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/lineage/$PROCESS_GUID?direction=BOTH&depth=1" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.relations | length'
# Expected: > 0 (at least one input and one output)
```

---

## Next Steps

- [Data Quality](DATA_QUALITY.md) — Define quality rules per lineage layer
- [Data Access](DATA_ACCESS.md) — Govern access based on lineage sensitivity
