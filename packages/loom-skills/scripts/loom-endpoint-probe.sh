#!/usr/bin/env bash
# loom-endpoint-probe.sh — print the resolved per-cloud Azure endpoint table for
# the active CSA Loom sovereign boundary. Mirrors apps/fiab-console/lib/azure/
# cloud-endpoints.ts so an agent can sanity-check which hosts it should target
# BEFORE generating code. Read-only; makes no network calls.
#
# Usage: scripts/loom-endpoint-probe.sh
# Honors LOOM_CLOUD (Commercial|GCC|GCC-High|DoD) then AZURE_CLOUD.
set -euo pipefail

loom_cloud="$(printf '%s' "${LOOM_CLOUD:-}" | tr '[:upper:]' '[:lower:]')"
azure_cloud="${AZURE_CLOUD:-AzureCloud}"

boundary="Commercial"; is_gov="false"
case "$loom_cloud" in
  commercial) boundary="Commercial" ;;
  gcc) boundary="GCC" ;;
  gcc-high|gcchigh|il5) boundary="GCC-High"; is_gov="true" ;;
  dod) boundary="DoD"; is_gov="true" ;;
  *) case "$(printf '%s' "$azure_cloud" | tr '[:upper:]' '[:lower:]')" in
       azureusgovernment) boundary="GCC-High"; is_gov="true" ;;
       azuredod) boundary="DoD"; is_gov="true" ;;
     esac ;;
esac

if [ "$is_gov" = "true" ]; then
  arm="management.usgovcloudapi.net"; dfs="dfs.core.usgovcloudapi.net"
  kusto="kusto.usgovcloudapi.net"; sb="servicebus.usgovcloudapi.net"
  synsql="sql.azuresynapse.usgovcloudapi.net"; kv="vault.usgovcloudapi.net"
  search="search.azure.us"; cosmos="documents.azure.us"
  la="api.loganalytics.us"; aoai="openai.azure.us"
  graph="graph.microsoft.us"
  [ "$boundary" = "DoD" ] && { arm="management.azure.microsoft.scloud"; graph="dod-graph.microsoft.us"; }
else
  arm="management.azure.com"; dfs="dfs.core.windows.net"
  kusto="kusto.windows.net"; sb="servicebus.windows.net"
  synsql="sql.azuresynapse.net"; kv="vault.azure.net"
  search="search.windows.net"; cosmos="documents.azure.com"
  la="api.loganalytics.azure.com"; aoai="openai.azure.com"
  graph="graph.microsoft.com"
fi
[ -n "${LOOM_ARM_ENDPOINT:-}" ] && arm="$(printf '%s' "$LOOM_ARM_ENDPOINT" | sed -E 's#^https?://##; s#/+$##')"

printf 'CSA Loom boundary: %s (gov=%s)\n' "$boundary" "$is_gov"
printf '%-22s %s\n' "ARM control plane:"     "$arm"
printf '%-22s %s\n' "ADLS Gen2 (DFS):"       "$dfs"
printf '%-22s %s\n' "ADX (Kusto):"           "$kusto"
printf '%-22s %s\n' "Service Bus / EH:"      "$sb"
printf '%-22s %s\n' "Synapse SQL:"           "$synsql"
printf '%-22s %s\n' "Key Vault:"             "$kv"
printf '%-22s %s\n' "AI Search:"             "$search"
printf '%-22s %s\n' "Cosmos DB:"             "$cosmos"
printf '%-22s %s\n' "Log Analytics query:"  "$la"
printf '%-22s %s\n' "Azure OpenAI:"          "$aoai"
printf '%-22s %s\n' "Microsoft Graph:"       "$graph"
printf '%-22s %s\n' "AI Search AAD scope:"   "https://search.azure.com/.default (cloud-invariant)"
echo
echo "Source of truth: apps/fiab-console/lib/azure/cloud-endpoints.ts"
echo "Fabric/Power BI hosts are intentionally absent — they are opt-in only and"
echo "have no GCC-High/DoD endpoint (assertFabricFamilyAvailable throws there)."
