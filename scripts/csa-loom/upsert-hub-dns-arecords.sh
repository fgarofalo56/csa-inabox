#!/usr/bin/env bash
# CSA Loom — upsert the DLZ private-endpoint A-records into the HUB-linked
# private-DNS zones so the Console (which runs in the HUB/admin VNet) can resolve
# the PE-only DLZ data planes. NO public network access is ever enabled — this
# is pure private-DNS plumbing.
#
# WHY (Refs #1549 — replicates a LIVE centralus hand-fix):
#   The Console runs in the hub VNet (vnet-csa-loom-hub-<region>, admin sub). The
#   DLZ data planes (ADLS, Synapse) live in the DLZ VNet (DLZ sub) and are
#   private-endpoint-only (publicNetworkAccess=Disabled). Each DLZ PE registers
#   its A-record into the DLZ-side private-DNS zone — NOT the hub-linked zone the
#   Console resolves against. The bicep DOES attach a privateDnsZoneGroup that
#   targets the HUB zones cross-sub (synapse.bicep / storage.bicep), but when the
#   hub zone-id map isn't threaded into the DLZ deployment (a partial/older
#   dlz-attach), that zone group is skipped and the hub zone has NO record →
#   lakehouse containers 504, lakehouse query ENOTFOUND, notebook/pipeline/
#   warehouse provisioning fails (ENOTFOUND / cannot resolve host).
#
#   This script is the durable BOOTSTRAP FALLBACK for that case: it enumerates
#   every DLZ PE's customDnsConfigs (fqdn + private IP — assigned by Azure when
#   the PE is created, independent of any DNS zone group) and upserts an A-record
#   into the matching HUB privatelink zone. It is a no-op when the bicep zone
#   group already populated the record (idempotent upsert to the same IP).
#
# COVERS all DLZ PEs the Console must reach:
#   storage  dfs  -> privatelink.dfs.<storageSuffix>
#   storage  blob -> privatelink.blob.<storageSuffix>
#   synapse  Sql / SqlOnDemand -> privatelink.sql.azuresynapse.<tld>
#   synapse  Dev               -> privatelink.dev.azuresynapse.<tld>
#   (best-effort) kusto/ADX, eventhub/servicebus, keyvault, cosmos — any PE in
#   the DLZ RG whose groupId maps to a hub zone that exists.
#
# MECHANISM: for each PE in the DLZ RG, read
#   properties.customDnsConfigs[].{fqdn, ipAddresses[0]}
# The fqdn looks like `saloomXXXX.dfs.core.windows.net` or
# `syn-loom-default-<region>-ondemand.sql.azuresynapse.net`; the relative record
# name in the privatelink zone is the LEFT-MOST label(s) before the public
# zone suffix (e.g. `saloomXXXX`, `syn-loom-default-<region>-ondemand`). We match
# the fqdn's public suffix to the corresponding `privatelink.<suffix>` hub zone,
# then `az network private-dns record-set a` create/update the relative name.
#
# REQUIRES: az logged in as a principal with `Private DNS Zone Contributor` (or
#   Network Contributor) on the HUB admin RG, and Reader on the DLZ RG. The
#   limitlessdata_deploy SP has Contributor on both in a stock deploy.
#
# USAGE:
#   ADMIN_SUB=<hub sub> ADMIN_RG=<hub admin rg> \
#   DLZ_SUB=<dlz sub>   DLZ_RG=<dlz rg> \
#   ./scripts/csa-loom/upsert-hub-dns-arecords.sh
set -uo pipefail

ADMIN_SUB="${ADMIN_SUB:?set ADMIN_SUB to the hub/admin subscription id}"
ADMIN_RG="${ADMIN_RG:?set ADMIN_RG to the hub/admin resource group (holds the privatelink zones)}"
DLZ_SUB="${DLZ_SUB:?set DLZ_SUB to the DLZ subscription id}"
DLZ_RG="${DLZ_RG:?set DLZ_RG to the DLZ resource group (holds the private endpoints)}"
# TTL for the upserted A-records (seconds). 3600 matches Azure PE defaults.
DNS_TTL="${DNS_TTL:-3600}"

echo "== Hub private-DNS A-record sweep =="
echo "   hub:  sub=$ADMIN_SUB rg=$ADMIN_RG (privatelink zones)"
echo "   dlz:  sub=$DLZ_SUB  rg=$DLZ_RG  (private endpoints)"

# Build a lookup of the hub privatelink zones that actually exist, keyed by the
# PUBLIC suffix they shadow (strip the leading "privatelink."). e.g. zone
# `privatelink.dfs.core.windows.net` shadows the public suffix `dfs.core.windows.net`.
declare -A HUB_ZONE_BY_SUFFIX
while IFS= read -r ZONE; do
  [ -z "$ZONE" ] && continue
  SUFFIX="${ZONE#privatelink.}"
  HUB_ZONE_BY_SUFFIX["$SUFFIX"]="$ZONE"
done < <(az network private-dns zone list --subscription "$ADMIN_SUB" -g "$ADMIN_RG" \
           --query "[?starts_with(name,'privatelink.')].name" -o tsv 2>/dev/null || true)

if [ "${#HUB_ZONE_BY_SUFFIX[@]}" -eq 0 ]; then
  echo "::warning::No privatelink.* zones found in $ADMIN_RG — cannot upsert hub A-records. Check ADMIN_RG / ADMIN_SUB."
  exit 0
fi
echo "   found ${#HUB_ZONE_BY_SUFFIX[@]} hub privatelink zone(s)."

# Resolve the matching hub zone for a PE fqdn by walking the fqdn's suffixes from
# the most-specific to the least until one matches a hub zone. Returns "zone|relname".
resolve_zone_and_record() {
  local FQDN="$1"
  # Drop a trailing dot if present.
  FQDN="${FQDN%.}"
  local REST="$FQDN"
  local RELNAME=""
  # Peel labels off the front; at each step the remainder is a candidate suffix.
  while [[ "$REST" == *.* ]]; do
    local HEAD="${REST%%.*}"
    local TAIL="${REST#*.}"
    RELNAME="${RELNAME:+$RELNAME.}$HEAD"
    if [ -n "${HUB_ZONE_BY_SUFFIX[$TAIL]:-}" ]; then
      echo "${HUB_ZONE_BY_SUFFIX[$TAIL]}|$RELNAME"
      return 0
    fi
    REST="$TAIL"
  done
  return 1
}

UPSERTS=0
SKIPS=0

# Enumerate every PE in the DLZ RG and its customDnsConfigs (fqdn + private IP).
# `customDnsConfigs` is populated by Azure as soon as the PE is created — it does
# NOT depend on a privateDnsZoneGroup, which is exactly why this fallback works
# even when the cross-sub zone group was never linked.
PES=$(az network private-endpoint list --subscription "$DLZ_SUB" -g "$DLZ_RG" \
        --query "[].name" -o tsv 2>/dev/null || true)
if [ -z "${PES:-}" ]; then
  echo "::notice::No private endpoints in $DLZ_RG — nothing to upsert (DLZ may not be deployed yet)."
  exit 0
fi

for PE in $PES; do
  # Each PE may carry multiple fqdn/ip pairs (e.g. a PE with several groupIds).
  CONFIGS=$(az network private-endpoint show --subscription "$DLZ_SUB" -g "$DLZ_RG" -n "$PE" \
              --query "customDnsConfigs[].{fqdn:fqdn, ip:ipAddresses[0]}" -o json 2>/dev/null || echo '[]')
  # Parse fqdn|ip lines with python (jq may be absent on the runner).
  echo "$CONFIGS" | python3 -c "
import sys, json
try:
    for c in json.load(sys.stdin):
        f = (c.get('fqdn') or '').strip()
        ip = (c.get('ip') or '').strip()
        if f and ip:
            print(f + '|' + ip)
except Exception:
    pass
" 2>/dev/null | while IFS='|' read -r FQDN IP; do
    [ -z "$FQDN" ] && continue
    [ -z "$IP" ] && continue
    if MATCH=$(resolve_zone_and_record "$FQDN"); then
      ZONE="${MATCH%%|*}"
      RELNAME="${MATCH#*|}"
      echo "  $PE: $FQDN ($IP) -> zone=$ZONE record=$RELNAME"
      # Create the record set (idempotent — ignore "already exists"), then set the
      # A-record IP. `az network private-dns record-set a add-record` is additive,
      # so we first DELETE any stale record set for this name, then add the current
      # IP, guaranteeing the hub resolves to the live PE IP (re-runnable).
      az network private-dns record-set a delete --subscription "$ADMIN_SUB" -g "$ADMIN_RG" \
        -z "$ZONE" -n "$RELNAME" --yes -o none 2>/dev/null || true
      az network private-dns record-set a add-record --subscription "$ADMIN_SUB" -g "$ADMIN_RG" \
        -z "$ZONE" -n "$RELNAME" -a "$IP" --ttl "$DNS_TTL" -o none 2>/dev/null \
        && echo "    upserted A $RELNAME.$ZONE -> $IP" \
        || echo "::warning::    failed to upsert A $RELNAME.$ZONE -> $IP (Private DNS Zone Contributor on $ADMIN_RG?)"
    else
      echo "  $PE: $FQDN ($IP) -> no matching hub privatelink zone (skipped; add the zone to admin-plane network.bicep if the Console needs it)"
    fi
  done
done

echo "== Hub private-DNS A-record sweep complete =="
