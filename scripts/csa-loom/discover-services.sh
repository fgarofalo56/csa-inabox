#!/usr/bin/env bash
# CSA Loom — cross-subscription service discovery (reuse-first).
#
# Scans every subscription the signed-in principal can see for the Azure
# services Loom can wire into, and prints (1) a human inventory and (2) a
# ready-to-source block of EXISTING_* exports you can feed to
# patch-navigator-env.sh / grant-navigator-rbac.sh or a deploy to REUSE an
# existing resource instead of provisioning a new one.
#
# This implements the "use any deployed service if it already exists in any
# sub" requirement: nothing is created or modified — read-only enumeration.
#
# Usage:
#   bash scripts/csa-loom/discover-services.sh                 # all visible subs
#   SUBS="<sub1> <sub2>" bash scripts/csa-loom/discover-services.sh
#   bash scripts/csa-loom/discover-services.sh > temp/loom-service-inventory.txt
set -uo pipefail

SUBS="${SUBS:-$(az account list --query "[].id" -o tsv 2>/dev/null)}"
[[ -z "$SUBS" ]] && { echo "No subscriptions visible. Run 'az login' first." >&2; exit 1; }

q() { az "$@" 2>/dev/null || true; }
first() { q "$@" --query "[0].{name:name,rg:resourceGroup,sub:id}" -o json; }

echo "# CSA Loom — service discovery ($(echo "$SUBS" | wc -w) subscription(s))"
echo

# Resource graph is the fastest cross-sub scanner when the extension exists.
HAVE_GRAPH=0
az graph query -q "Resources | limit 1" -o none 2>/dev/null && HAVE_GRAPH=1

# type -> friendly label -> EXISTING_* var prefix
# (rg/sub captured so cross-sub reuse is explicit)
scan() { # scan "<arm type>" "<label>" "<EXISTING var base>"
  local type="$1" label="$2" var="$3"
  echo "## $label"
  local found=0
  if [[ "$HAVE_GRAPH" == "1" ]]; then
    while IFS=$'\t' read -r name rg sub; do
      [[ -z "$name" ]] && continue
      found=1
      echo "  • $name   (rg=$rg sub=$sub)"
      echo "    export ${var}=$name ${var}_RG=$rg ${var}_SUB=$sub"
    done < <(q graph query -q "Resources | where type =~ '$type' | project name, resourceGroup, subscriptionId" --first 50 -o tsv)
  else
    for s in $SUBS; do
      while IFS=$'\t' read -r name rg; do
        [[ -z "$name" ]] && continue
        found=1
        echo "  • $name   (rg=$rg sub=$s)"
        echo "    export ${var}=$name ${var}_RG=$rg ${var}_SUB=$s"
      done < <(q resource list --subscription "$s" --resource-type "$type" --query "[].{n:name,r:resourceGroup}" -o tsv)
    done
  fi
  [[ "$found" == "0" ]] && echo "  (none found — Loom will provision new or stay gated)"
  echo
}

scan "Microsoft.Search/searchServices"            "AI Search"            "EXISTING_AI_SEARCH_SERVICE"
scan "Microsoft.ApiManagement/service"            "API Management"       "EXISTING_APIM"
scan "Microsoft.DocumentDB/databaseAccounts"      "Cosmos DB"            "EXISTING_COSMOS_ACCOUNT"
scan "Microsoft.EventHub/namespaces"              "Event Hubs"           "EXISTING_EVENTHUB_NAMESPACE"
scan "Microsoft.Databricks/workspaces"            "Databricks"           "EXISTING_DATABRICKS"
scan "Microsoft.Kusto/clusters"                   "ADX / Kusto"          "EXISTING_KUSTO_CLUSTER"
scan "Microsoft.Synapse/workspaces"               "Synapse"              "EXISTING_SYNAPSE"
scan "Microsoft.DataFactory/factories"            "Data Factory"         "EXISTING_ADF"
scan "Microsoft.CognitiveServices/accounts"       "Cognitive/AI Services" "EXISTING_AOAI"
scan "Microsoft.MachineLearningServices/workspaces" "AI Foundry / ML hub" "EXISTING_FOUNDRY"
scan "Microsoft.Purview/accounts"                 "Purview"              "EXISTING_PURVIEW"
scan "Microsoft.Sql/servers"                      "Azure SQL Server"     "EXISTING_AZURE_SQL"
scan "Microsoft.Storage/storageAccounts"          "Storage (ADLS Gen2)"  "EXISTING_STORAGE"
scan "Microsoft.KeyVault/vaults"                  "Key Vault"            "EXISTING_KEYVAULT"

echo "# To REUSE an existing resource: export the matching block above, then run"
echo "#   bash scripts/csa-loom/patch-navigator-env.sh   (env)"
echo "#   bash scripts/csa-loom/grant-navigator-rbac.sh  (roles)"
echo "# Anything with no match is provisioned new (reuse-first) or stays honestly gated."
