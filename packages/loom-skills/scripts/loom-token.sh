#!/usr/bin/env bash
# loom-token.sh — acquire an Azure-native access token for the active CSA Loom
# sovereign cloud, the same way the Loom clients do (UAMI-first, then az CLI).
#
# This is the Azure-native analogue of skills-for-fabric's
#   az account get-access-token --resource https://api.fabric.microsoft.com
# but it targets the ARM / data-plane resource for the ACTIVE Loom cloud
# (Commercial / GCC / GCC-High / DoD) and never a Fabric host.
#
# Usage:
#   scripts/loom-token.sh [resource]
#     resource: arm (default) | storage | kusto | search | graph | synapse-sql
#
# Honors LOOM_CLOUD (Commercial|GCC|GCC-High|DoD) then AZURE_CLOUD. Requires the
# Azure CLI (`az login` first). Read-only: prints the token resource it used and
# the access token; makes no changes.
set -euo pipefail

resource="${1:-arm}"
loom_cloud="$(printf '%s' "${LOOM_CLOUD:-}" | tr '[:upper:]' '[:lower:]')"
azure_cloud="${AZURE_CLOUD:-AzureCloud}"

is_gov="false"
case "$loom_cloud" in
  gcc-high|gcchigh|il5|dod) is_gov="true" ;;
  commercial|gcc) is_gov="false" ;;
  *) case "$(printf '%s' "$azure_cloud" | tr '[:upper:]' '[:lower:]')" in
       azureusgovernment|azuredod) is_gov="true" ;;
     esac ;;
esac

if [ "$is_gov" = "true" ]; then
  arm="https://management.usgovcloudapi.net"
  storage="https://storage.azure.com"          # data-plane storage audience (cloud-invariant)
  kusto="https://kusto.usgovcloudapi.net"
  search="https://search.azure.com"            # AAD scope is cloud-invariant
  graph="https://graph.microsoft.us"
  synapse_sql="https://database.usgovcloudapi.net"
else
  arm="https://management.azure.com"
  storage="https://storage.azure.com"
  kusto="https://kusto.windows.net"
  search="https://search.azure.com"
  graph="https://graph.microsoft.com"
  synapse_sql="https://database.windows.net"
fi
# LOOM_ARM_ENDPOINT overrides ARM for clouds not enumerated above.
[ -n "${LOOM_ARM_ENDPOINT:-}" ] && arm="${LOOM_ARM_ENDPOINT%/}"

case "$resource" in
  arm) res="$arm" ;;
  storage) res="$storage" ;;
  kusto) res="$kusto" ;;
  search) res="$search" ;;
  graph) res="$graph" ;;
  synapse-sql) res="$synapse_sql" ;;
  *) echo "unknown resource '$resource' (arm|storage|kusto|search|graph|synapse-sql)" >&2; exit 2 ;;
esac

echo "# Loom cloud: ${LOOM_CLOUD:-$azure_cloud} (gov=$is_gov)" >&2
echo "# token resource: $res" >&2
az account get-access-token --resource "$res" --query accessToken -o tsv
