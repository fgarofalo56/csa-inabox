#!/usr/bin/env bash
# Ensure P2S VPN clients resolve the whole private estate by FQDN automatically
# — via an Azure DNS Private Resolver in the hub VNet, pushed to clients as the
# VPN DNS server. This is the permanent replacement for per-client hosts-file
# entries (see docs/fiab/vpn-access.md).
#
# How it works (per Microsoft Learn):
#   - The hub VNet's custom DNS = the resolver's inbound-endpoint IP.
#   - The VPN gateway auto-pushes the VNet DNS server(s) to P2S clients.
#   - The resolver answers from every privatelink.* zone LINKED to the hub VNet
#     (all admin-plane zones + the DLZ Databricks zone are hub-linked), and
#     forwards everything else to Azure DNS (168.63.129.16) — so public URLs
#     (incl. the gateway's own control-plane endpoints) keep resolving.
#
# Idempotent: re-running creates only what's missing, then (re)sets the VNet DNS.
# Run in the post-deploy bootstrap AFTER the hub VNet + VPN gateway exist. The
# resolver infra itself is also declared in bicep (dns-private-resolver.bicep);
# this script additionally sets the VNet DNS, which bicep deliberately does NOT
# (setting it at VNet-create time, before the resolver is up, breaks DNS for
# everything else provisioning in the VNet).
#
# Usage:
#   ADMIN_SUB=<admin/hub sub> REGION=centralus \
#   ADMIN_RG=rg-csa-loom-admin-<region> ./ensure-vpn-dns-resolver.sh
set -euo pipefail

: "${ADMIN_SUB:?set ADMIN_SUB}"; : "${REGION:?set REGION (e.g. centralus)}"
: "${ADMIN_RG:?set ADMIN_RG}"
VNET="vnet-csa-loom-hub-${REGION}"
RESOLVER="dnspr-loom-${REGION}"
SUBNET="snet-dns-inbound"
# Inbound IP is static (5th usable .4 of the /28) so the VNet DNS value is known.
INBOUND_IP="10.0.9.4"
SUBNET_CIDR="10.0.9.0/28"
S="--subscription $ADMIN_SUB"
az extension add -n dns-resolver -y >/dev/null 2>&1 || true

echo ">>> ensure delegated inbound subnet ${SUBNET} (${SUBNET_CIDR})"
az network vnet subnet show -g "$ADMIN_RG" --vnet-name "$VNET" -n "$SUBNET" $S >/dev/null 2>&1 || \
  az network vnet subnet create -g "$ADMIN_RG" --vnet-name "$VNET" -n "$SUBNET" $S \
    --address-prefixes "$SUBNET_CIDR" --delegations Microsoft.Network/dnsResolvers -o none

echo ">>> ensure DNS Private Resolver ${RESOLVER}"
VNETID=$(az network vnet show -g "$ADMIN_RG" -n "$VNET" $S --query id -o tsv)
az dns-resolver show -g "$ADMIN_RG" -n "$RESOLVER" $S >/dev/null 2>&1 || \
  az dns-resolver create -g "$ADMIN_RG" -n "$RESOLVER" -l "$REGION" --id "$VNETID" $S -o none

echo ">>> ensure inbound endpoint (static ${INBOUND_IP})"
SUBID="${VNETID}/subnets/${SUBNET}"
az dns-resolver inbound-endpoint show -g "$ADMIN_RG" --dns-resolver-name "$RESOLVER" -n inbound $S >/dev/null 2>&1 || \
  az dns-resolver inbound-endpoint create -g "$ADMIN_RG" --dns-resolver-name "$RESOLVER" -n inbound -l "$REGION" $S \
    --ip-configurations "[{private-ip-address:'${INBOUND_IP}',private-ip-allocation-method:Static,id:${SUBID}}]" -o none

# DO NOT point the hub VNet DNS at the resolver.
# Reverted 2026-06-23: setting the VNet's custom DNS to this resolver made the
# CONSOLE use it too, and the resolver proved INTERMITTENT for recursive
# public->private lookups (an AI Services FQDN like *.cognitiveservices.azure.com
# CNAMEs into a linked privatelink zone) -> sporadic ENOTFOUND -> "fetch failed"
# on ALL copilot/chat/agent/tool calls. The hub VNet stays on Azure-default DNS
# (168.63.129.16), which reliably honors linked private zones for in-VNet
# resources. The resolver resource is left in place but UNUSED as VNet DNS.
#
# VPN clients resolve the private estate via the hosts-file block on the
# Admin -> Network & DNS page (see docs/fiab/vpn-access.md). Re-enabling
# resolver-pushed DNS would require root-causing the resolver flakiness first.
echo "✓ Resolver resource ensured at ${INBOUND_IP} (NOT set as VNet DNS — see comment)."
echo "  Hub VNet stays on Azure-default DNS. VPN clients use the hosts-file block."
