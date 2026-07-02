#!/usr/bin/env bash
# Ensure the AOAI + AI Foundry (kind=AIServices) accounts have private endpoints
# so the Console (in the hub VNet) can RESOLVE + reach them.
#
# Why (root cause, 2026-06-23): these accounts' public FQDNs
# (*.cognitiveservices.azure.com / *.services.ai.azure.com / *.openai.azure.com)
# CNAME into the privatelink.* zones. Those zones are linked to the hub VNet but,
# with NO private endpoint, were EMPTY → in-VNet resolution returned NXDOMAIN →
# EVERY copilot/chat/agent/tool call failed with "fetch failed" (while Cosmos,
# which has a real PE, worked). Creating PEs registers the A records so the
# Console resolves them to private IPs. This is the private-by-default fix.
#
# Idempotent: creates the services.ai zone (if missing) + hub link, and a PE +
# 3-zone DNS-zone-group per account only when absent. Run in the post-deploy
# bootstrap after the admin plane + AI accounts exist.
#
# Usage:
#   ADMIN_SUB=<sub> REGION=centralus ADMIN_RG=rg-csa-loom-admin-<region> \
#   AOAI_NAME=aoai-csa-loom-<region> FOUNDRY_NAME=aifndry-loom-<region> \
#   ./ensure-ai-private-endpoints.sh
set -uo pipefail
: "${ADMIN_SUB:?set ADMIN_SUB}"; : "${REGION:?set REGION}"; : "${ADMIN_RG:?set ADMIN_RG}"
AOAI_NAME="${AOAI_NAME:-aoai-csa-loom-${REGION}}"
FOUNDRY_NAME="${FOUNDRY_NAME:-aifndry-loom-${REGION}}"
HUB="vnet-csa-loom-hub-${REGION}"
S="--subscription $ADMIN_SUB"
HUBID="/subscriptions/${ADMIN_SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.Network/virtualNetworks/${HUB}"
ZB="/subscriptions/${ADMIN_SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.Network/privateDnsZones"
ACCT="/subscriptions/${ADMIN_SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.CognitiveServices/accounts"

echo ">>> ensure privatelink.services.ai.azure.com zone + hub link"
az network private-dns zone show -g "$ADMIN_RG" -n privatelink.services.ai.azure.com $S >/dev/null 2>&1 || \
  az network private-dns zone create -g "$ADMIN_RG" -n privatelink.services.ai.azure.com $S -o none
az network private-dns link vnet show -g "$ADMIN_RG" -z privatelink.services.ai.azure.com -n link-hub $S >/dev/null 2>&1 || \
  az network private-dns link vnet create -g "$ADMIN_RG" -z privatelink.services.ai.azure.com -n link-hub -v "$HUBID" -e false $S -o none

ensure_pe() {
  local accName="$1" pe="$2" conn="$3"
  az cognitiveservices account show -n "$accName" -g "$ADMIN_RG" $S >/dev/null 2>&1 || { echo "  SKIP $accName (not deployed)"; return; }
  if az network private-endpoint show -n "$pe" -g "$ADMIN_RG" $S >/dev/null 2>&1; then echo "  $pe exists"; return; fi
  echo "  creating $pe for $accName"
  az network private-endpoint create -n "$pe" -g "$ADMIN_RG" $S \
    --vnet-name "$HUB" --subnet snet-private-endpoints \
    --private-connection-resource-id "${ACCT}/${accName}" --group-id account --connection-name "$conn" --location "$REGION" -o none
  az network private-endpoint dns-zone-group create -g "$ADMIN_RG" $S --endpoint-name "$pe" -n default \
    --zone-name cog --private-dns-zone "${ZB}/privatelink.cognitiveservices.azure.com" -o none
  az network private-endpoint dns-zone-group add -g "$ADMIN_RG" $S --endpoint-name "$pe" -n default \
    --zone-name openai --private-dns-zone "${ZB}/privatelink.openai.azure.com" -o none
  az network private-endpoint dns-zone-group add -g "$ADMIN_RG" $S --endpoint-name "$pe" -n default \
    --zone-name svcai --private-dns-zone "${ZB}/privatelink.services.ai.azure.com" -o none
}

ensure_pe "$AOAI_NAME"    pe-aoai-csa-loom  aoai
ensure_pe "$FOUNDRY_NAME" pe-aifndry-loom   aifndry
echo "✓ AOAI + Foundry private endpoints ensured — Console resolves AI accounts privately (copilot/agents/tools reachable)."
