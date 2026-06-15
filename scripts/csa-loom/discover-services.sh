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

# Deployment-aware AOAI scan (deploy-readiness): list AIServices/OpenAI accounts
# AND their model deployments, recommend reuse when a gpt-4o-class chat + an
# embeddings deployment already exist (avoids duplicate model cost), else
# recommend provision-new. Emits the EXISTING_AOAI* triple + the chat/embed
# deployment-name vars the bicepparam readEnvironmentVariable() block consumes.
scan_aoai() {
  echo "## Azure OpenAI / AI Foundry (AIServices) — model deployments"
  local found=0
  # Resource Graph (or per-sub fallback) for AIServices/OpenAI accounts.
  local rows
  if [[ "$HAVE_GRAPH" == "1" ]]; then
    rows="$(q graph query -q "Resources | where type =~ 'Microsoft.CognitiveServices/accounts' | where kind in~ ('AIServices','OpenAI') | project name, resourceGroup, subscriptionId" --first 50 --query "data[].[name,resourceGroup,subscriptionId]" -o tsv 2>/dev/null || true)"
  else
    rows=""
    for s in $SUBS; do
      while IFS=$'\t' read -r name rg kind; do
        [[ -z "$name" ]] && continue
        [[ "$kind" == "AIServices" || "$kind" == "OpenAI" ]] && rows+="${name}	${rg}	${s}"$'\n'
      done < <(q resource list --subscription "$s" --resource-type "Microsoft.CognitiveServices/accounts" --query "[].{n:name,r:resourceGroup,k:kind}" -o tsv 2>/dev/null || true)
    done
  fi
  while IFS=$'\t' read -r name rg sub; do
    [[ -z "$name" ]] && continue
    found=1
    local dargs=(cognitiveservices account deployment list -n "$name" -g "$rg")
    [[ -n "$sub" ]] && dargs+=(--subscription "$sub")
    local deploys chat embed
    deploys="$(q "${dargs[@]}" --query "[].{name:name,model:properties.model.name}" -o tsv 2>/dev/null || true)"
    chat="$(awk -F'\t' 'tolower($2) ~ /gpt-4o|gpt-4\.1|gpt-4|gpt-35|gpt-3.5/ {print $1; exit}' <<<"$deploys")"
    embed="$(awk -F'\t' 'tolower($2) ~ /embedding/ {print $1; exit}' <<<"$deploys")"
    echo "  • $name   (rg=$rg sub=$sub)   chat='${chat:-none}' embed='${embed:-none}'"
    if [[ -n "$chat" && -n "$embed" ]]; then
      echo "    # RECOMMEND: reuse (gpt-4o-class chat + embeddings already present)"
    else
      echo "    # RECOMMEND: provision-new (no complete gpt-4o-class chat+embed pair)"
    fi
    echo "    export EXISTING_AOAI=$name EXISTING_AOAI_RG=$rg EXISTING_AOAI_SUB=$sub"
    echo "    export EXISTING_AOAI_CHAT_DEPLOYMENT='${chat}' EXISTING_AOAI_EMBED_DEPLOYMENT='${embed}'"
  done <<<"$rows"
  if [[ "$found" == "0" ]]; then
    echo "  (none found — Loom provisions a NEW aifndry-loom-<region> account + gpt-4o + embeddings by default)"
  fi
  echo
}

scan "Microsoft.Search/searchServices"            "AI Search"            "EXISTING_AI_SEARCH_SERVICE"  "EXISTING_AI_SEARCH_RG"      "EXISTING_AI_SEARCH_SUB"
scan "Microsoft.ApiManagement/service"            "API Management"       "EXISTING_APIM"               "EXISTING_APIM_RG"           "EXISTING_APIM_SUB"
scan "Microsoft.Maps/accounts"                    "Azure Maps"           "EXISTING_AZURE_MAPS_ACCOUNT" "EXISTING_AZURE_MAPS_RG"     "EXISTING_AZURE_MAPS_SUB"
scan "Microsoft.DocumentDB/databaseAccounts"      "Cosmos DB"            "EXISTING_COSMOS_ACCOUNT"     "EXISTING_COSMOS_ACCOUNT_RG" "EXISTING_COSMOS_ACCOUNT_SUB"
scan "Microsoft.EventHub/namespaces"              "Event Hubs"           "EXISTING_EVENTHUB_NAMESPACE" "EXISTING_EVENTHUB_RG"       "EXISTING_EVENTHUB_SUB"
scan "Microsoft.Databricks/workspaces"            "Databricks"           "EXISTING_DATABRICKS"         "EXISTING_DATABRICKS_RG"     "EXISTING_DATABRICKS_SUB"
scan "Microsoft.Kusto/clusters"                   "ADX / Kusto"          "EXISTING_KUSTO_CLUSTER"      "EXISTING_KUSTO_RG"          "EXISTING_KUSTO_SUB"
scan "Microsoft.StreamAnalytics/streamingjobs"    "Stream Analytics"     "EXISTING_ASA_JOB"           "EXISTING_ASA_RG"            "EXISTING_ASA_SUB"
scan "Microsoft.Devices/IotHubs"                  "IoT Hub"              "EXISTING_IOT_HUB"           "EXISTING_IOT_RG"            "EXISTING_IOT_SUB"
scan "Microsoft.Synapse/workspaces"               "Synapse"              "EXISTING_SYNAPSE"            "EXISTING_SYNAPSE_RG"        "EXISTING_SYNAPSE_SUB"
scan "Microsoft.DataFactory/factories"            "Data Factory"         "EXISTING_ADF"                "EXISTING_ADF_RG"            "EXISTING_ADF_SUB"
scan "Microsoft.CognitiveServices/accounts"       "Cognitive/AI Services" "EXISTING_AOAI"              "EXISTING_AOAI_RG"           "EXISTING_AOAI_SUB"
scan_aoai
scan "Microsoft.MachineLearningServices/workspaces" "AI Foundry / ML hub" "EXISTING_FOUNDRY"           "EXISTING_FOUNDRY_RG"        "EXISTING_FOUNDRY_SUB"
scan "Microsoft.Purview/accounts"                 "Purview"              "EXISTING_PURVIEW"            "EXISTING_PURVIEW_RG"        "EXISTING_PURVIEW_SUB"
scan "Microsoft.Sql/servers"                      "Azure SQL Server"     "EXISTING_AZURE_SQL"          "EXISTING_AZURE_SQL_RG"      "EXISTING_AZURE_SQL_SUB"
scan "Microsoft.Storage/storageAccounts"          "Storage (ADLS Gen2)"  "EXISTING_STORAGE"            "EXISTING_STORAGE_RG"        "EXISTING_STORAGE_SUB"
scan "Microsoft.KeyVault/vaults"                  "Key Vault"            "EXISTING_KEYVAULT"           "EXISTING_KEYVAULT_RG"       "EXISTING_KEYVAULT_SUB"

echo "# To REUSE an existing resource: export the matching block above, then run"
echo "#   bash scripts/csa-loom/patch-navigator-env.sh   (env)"
echo "#   bash scripts/csa-loom/grant-navigator-rbac.sh  (roles)"
echo "# Anything with no match is provisioned new (reuse-first) or stays honestly gated."
echo "#"
echo "# Notes for this domain (APIM / Azure Maps / Key Vault / Firewall):"
echo "#  • APIM         — ON by default (loomApimEnabled/apimEnabled=true). To reuse:"
echo "#                   set EXISTING_APIM{,_RG,_SUB} (cross-sub LOOM_APIM_* env)."
echo "#  • Azure Maps   — ON by default on Commercial/GCC (loomMapsEnabled=true). To reuse:"
echo "#                   bind the account NAME via 'param loomAzureMapsAccount' (only the"
echo "#                   account name + key are consumed; RG/SUB above are informational)."
echo "#  • Key Vault    — FOUNDATIONAL, always provisioned new (no reuse / no disable):"
echo "#                   stores MSAL secret, SESSION_SECRET, Maps key + Connections creds."
echo "#  • Hub Firewall — ON by default (loomFirewallEnabled=true); on/off only, not reusable."
