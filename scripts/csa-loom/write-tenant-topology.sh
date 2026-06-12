#!/usr/bin/env bash
# write-tenant-topology.sh (audit-t157)
#
# Post-deploy bootstrap step for a topology=='tenant' (first-run) install.
# Reads the hub coordinates the main.bicep deployment emitted as outputs and
# upserts them into the Cosmos `loom` DB `tenant-topology` doc (one per tenant,
# id='tenant-topology', PK /tenantId). The Setup Wizard "Add landing zone" flow
# and the orchestrator dlz-attach path read this doc so hub coordinates are
# never free-typed (loom-no-freeform-config). All values are Azure-native
# resource ids — no Fabric handles (no-fabric-dependency).
#
# Usage:
#   write-tenant-topology.sh \
#     --deployment-name <az deployment sub name> \
#     --subscription <hub sub id> \
#     [--cosmos-endpoint https://<acct>.documents.azure.com:443/] \
#     [--database loom] \
#     [--tenant-id <entra tenant id>]
#
# Env fallbacks: LOOM_COSMOS_ENDPOINT, LOOM_COSMOS_DATABASE (default 'loom'),
#                AZURE_TENANT_ID / LOOM_TENANT_ID.
#
# Auth: DefaultAzureCredential (the deploy identity must hold Cosmos DB Built-in
# Data Contributor on the account). Fails honestly if a required input or a
# Python dependency is missing — it never writes a partial / fake doc.
set -euo pipefail

DEPLOYMENT_NAME=""
SUBSCRIPTION=""
COSMOS_ENDPOINT="${LOOM_COSMOS_ENDPOINT:-}"
DATABASE="${LOOM_COSMOS_DATABASE:-loom}"
TENANT_ID="${LOOM_TENANT_ID:-${AZURE_TENANT_ID:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-name) DEPLOYMENT_NAME="$2"; shift 2;;
    --subscription) SUBSCRIPTION="$2"; shift 2;;
    --cosmos-endpoint) COSMOS_ENDPOINT="$2"; shift 2;;
    --database) DATABASE="$2"; shift 2;;
    --tenant-id) TENANT_ID="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -n "$DEPLOYMENT_NAME" ]] || { echo "ERROR: --deployment-name is required" >&2; exit 2; }
[[ -n "$COSMOS_ENDPOINT" ]] || { echo "ERROR: --cosmos-endpoint or LOOM_COSMOS_ENDPOINT is required" >&2; exit 2; }
[[ -n "$TENANT_ID" ]] || { echo "ERROR: --tenant-id or AZURE_TENANT_ID is required" >&2; exit 2; }

SUB_ARGS=()
[[ -n "$SUBSCRIPTION" ]] && SUB_ARGS=(--subscription "$SUBSCRIPTION")

echo "Reading hub coordinates from deployment '$DEPLOYMENT_NAME' outputs…"
OUTPUTS_JSON="$(az deployment sub show --name "$DEPLOYMENT_NAME" "${SUB_ARGS[@]}" \
  --query properties.outputs -o json)"

# Build the doc from the bicep outputs (output name → value.value).
export OUTPUTS_JSON DATABASE COSMOS_ENDPOINT TENANT_ID
python3 - <<'PY'
import json, os, sys
outputs = json.loads(os.environ["OUTPUTS_JSON"])

def out(name, default=""):
    v = outputs.get(name)
    return (v or {}).get("value", default) if isinstance(v, dict) else default

doc = {
    "id": "tenant-topology",
    "tenantId": os.environ["TENANT_ID"],
    "hubSubscriptionId": out("hubSubscriptionId"),
    "location": out("adminPlaneRgName").split("-")[-1] or out("location"),
    "boundary": out("boundary"),
    "hubVnetId": out("adminPlaneHubVnetId") or out("hubVnetId"),
    "hubLawId": out("hubLawId"),
    "hubAppInsightsConnectionString": out("hubAppInsightsConnectionString"),
    "hubPrivateDnsZoneIds": out("hubPrivateDnsZoneIds", {}),
    "hubAdxClusterRgName": out("hubAdxClusterRgName"),
    "hubAdxClusterPrincipalId": out("hubAdxClusterPrincipalId"),
    "hubCatalogEndpoint": out("hubCatalogEndpoint"),
    "hubAiServicesAccountName": out("hubAiServicesAccountName"),
    "hubConsolePrincipalId": out("hubConsolePrincipalId"),
    "hubConsoleUamiName": out("hubConsoleUamiName"),
    "hubConsoleUamiAppId": out("hubConsoleUamiAppId"),
    "hubConsoleUamiId": out("hubConsoleUamiId"),
    "hubActivatorPrincipalId": out("hubActivatorPrincipalId"),
}

try:
    from azure.cosmos import CosmosClient, PartitionKey
    from azure.identity import DefaultAzureCredential
except ImportError:
    sys.stderr.write(
        "ERROR: azure-cosmos + azure-identity are required to write the tenant-topology doc.\n"
        "       pip install azure-cosmos azure-identity\n"
    )
    sys.exit(3)

import datetime
doc["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

client = CosmosClient(os.environ["COSMOS_ENDPOINT"], credential=DefaultAzureCredential())
db = client.get_database_client(os.environ["DATABASE"])
# createIfNotExists is the hotfix fallback (mirrors cosmos-client.ts ensure()).
container = db.create_container_if_not_exists(
    id="tenant-topology", partition_key=PartitionKey(path="/tenantId")
)
container.upsert_item(doc)
print(f"Upserted tenant-topology doc for tenant {doc['tenantId']} (hub sub {doc['hubSubscriptionId']}).")
PY

echo "Done. The Setup Wizard 'Add landing zone' flow + dlz-attach can now read the hub coordinates."
