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

# type -> friendly label -> EXISTING_* var names
# (rg/sub captured so cross-sub reuse is explicit). The name/rg/sub var names are
# the CANONICAL EXISTING_* vars shared with byo-wizard.sh, the bicepparam
# readEnvironmentVariable() block, and patch-navigator-env.sh — so the discover
# output sources cleanly into a deploy or the post-deploy scripts (fixes the
# historical RG/SUB var-name drift).
scan() { # scan "<arm type>" "<label>" "<name var>" "<rg var>" "<sub var>"
  local type="$1" label="$2" var="$3" rgvar="$4" subvar="$5"
  echo "## $label"
  local found=0
  if [[ "$HAVE_GRAPH" == "1" ]]; then
    while IFS=$'\t' read -r name rg sub; do
      [[ -z "$name" ]] && continue
      found=1
      echo "  • $name   (rg=$rg sub=$sub)"
      echo "    export ${var}=$name ${rgvar}=$rg ${subvar}=$sub"
    done < <(q graph query -q "Resources | where type =~ '$type' | project name, resourceGroup, subscriptionId" --first 50 --query "data[].[name,resourceGroup,subscriptionId]" -o tsv)
  else
    for s in $SUBS; do
      while IFS=$'\t' read -r name rg; do
        [[ -z "$name" ]] && continue
        found=1
        echo "  • $name   (rg=$rg sub=$s)"
        echo "    export ${var}=$name ${rgvar}=$rg ${subvar}=$s"
      done < <(q resource list --subscription "$s" --resource-type "$type" --query "[].{n:name,r:resourceGroup}" -o tsv)
    done
  fi
  [[ "$found" == "0" ]] && echo "  (none found — Loom will provision new or stay gated)"
  echo
}

scan "Microsoft.Search/searchServices"            "AI Search"            "EXISTING_AI_SEARCH_SERVICE"  "EXISTING_AI_SEARCH_RG"      "EXISTING_AI_SEARCH_SUB"
scan "Microsoft.ApiManagement/service"            "API Management"       "EXISTING_APIM"               "EXISTING_APIM_RG"           "EXISTING_APIM_SUB"
scan "Microsoft.DocumentDB/databaseAccounts"      "Cosmos DB"            "EXISTING_COSMOS_ACCOUNT"     "EXISTING_COSMOS_ACCOUNT_RG" "EXISTING_COSMOS_ACCOUNT_SUB"
scan "Microsoft.EventHub/namespaces"              "Event Hubs"           "EXISTING_EVENTHUB_NAMESPACE" "EXISTING_EVENTHUB_RG"       "EXISTING_EVENTHUB_SUB"
scan "Microsoft.Databricks/workspaces"            "Databricks"           "EXISTING_DATABRICKS"         "EXISTING_DATABRICKS_RG"     "EXISTING_DATABRICKS_SUB"
scan "Microsoft.Kusto/clusters"                   "ADX / Kusto"          "EXISTING_KUSTO_CLUSTER"      "EXISTING_KUSTO_RG"          "EXISTING_KUSTO_SUB"
scan "Microsoft.Synapse/workspaces"               "Synapse"              "EXISTING_SYNAPSE"            "EXISTING_SYNAPSE_RG"        "EXISTING_SYNAPSE_SUB"
scan "Microsoft.DataFactory/factories"            "Data Factory"         "EXISTING_ADF"                "EXISTING_ADF_RG"            "EXISTING_ADF_SUB"
scan "Microsoft.CognitiveServices/accounts"       "Cognitive/AI Services" "EXISTING_AOAI"              "EXISTING_AOAI_RG"           "EXISTING_AOAI_SUB"
scan "Microsoft.MachineLearningServices/workspaces" "AI Foundry / ML hub" "EXISTING_FOUNDRY"           "EXISTING_FOUNDRY_RG"        "EXISTING_FOUNDRY_SUB"
scan "Microsoft.Purview/accounts"                 "Purview"              "EXISTING_PURVIEW"            "EXISTING_PURVIEW_RG"        "EXISTING_PURVIEW_SUB"
scan "Microsoft.Sql/servers"                      "Azure SQL Server"     "EXISTING_AZURE_SQL"          "EXISTING_AZURE_SQL_RG"      "EXISTING_AZURE_SQL_SUB"
scan "Microsoft.Storage/storageAccounts"          "Storage (ADLS Gen2)"  "EXISTING_STORAGE"            "EXISTING_STORAGE_RG"        "EXISTING_STORAGE_SUB"
scan "Microsoft.KeyVault/vaults"                  "Key Vault"            "EXISTING_KEYVAULT"           "EXISTING_KEYVAULT_RG"       "EXISTING_KEYVAULT_SUB"

echo "# To REUSE an existing resource: export the matching block above, then run"
echo "#   bash scripts/csa-loom/patch-navigator-env.sh   (env)"
echo "#   bash scripts/csa-loom/grant-navigator-rbac.sh  (roles)"
echo "# Anything with no match is provisioned new (reuse-first) or stays honestly gated."
